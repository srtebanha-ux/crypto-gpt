// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * TITAN Morpho Blue -> Uniswap V3 SwapRouter02, FOR LOCAL TEST/FORK FIRST.
 * Not deployed. No automatic broadcast. This contract is not an authorization
 * to spend gas; real liquidation still needs fresh eth_call, gas L1/L2, token
 * behavior, nonce isolation and a funded bounded operation.
 *
 * Morpho transfers seized collateral, calls onMorphoLiquidate on THIS contract
 * and afterwards pulls repaidAssets loan tokens. No separate flash loan.
 */
struct TitanMorphoParamsV3 {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}
interface ITitanMorphoBlueV3 {
    function liquidate(
        TitanMorphoParamsV3 calldata params,
        address borrower,uint256 seizedAssets,uint256 repaidShares,bytes calldata data
    ) external returns (uint256 assetsSeized,uint256 assetsRepaid);
}
interface ITitanTokenV3 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address,address) external view returns (uint256);
}
interface ITitanUniswapV3Factory {
    function getPool(address,address,uint24) external view returns (address);
}
interface ITitanSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    function exactInput(ExactInputParams calldata params) external payable returns(uint256 amountOut);
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns(uint256 amountOut);
}
contract TitanCacadorMorphoV3 {
    address public immutable dono;
    address public immutable cofre;
    ITitanMorphoBlueV3 public immutable morpho;
    ITitanSwapRouter02 public immutable routerV3;
    ITitanUniswapV3Factory public immutable fabricaV3;

    struct Contexto {
        address devedor;
        address garantia;
        address divida;
        uint24 taxa;
        uint256 saldoInicialDivida;
        uint256 saldoInicialGarantia;
        uint256 lucroMinimoDivida;
        bool ativa;
        bool callbackExecutado;
    }
    Contexto private contexto;
    bytes private caminho;
    mapping(address=>bool) public intermediarioPermitido;
    function versaoRotas() external pure returns(uint256){return 2;}
    function autorizarIntermediario(address token,bool habilitado) external soDono {
        if(contexto.ativa||token==address(0))revert ParametrosInvalidos();
        intermediarioPermitido[token]=habilitado;
    }
    function _token(bytes memory rota,uint256 offset) private pure returns(address a){
        assembly {a:=shr(96,mload(add(add(rota,32),offset)))}
    }
    function _taxa(bytes memory rota,uint256 offset) private pure returns(uint24 f){
        assembly {f:=shr(232,mload(add(add(rota,32),offset)))}
    }
    function _validarRota(bytes memory rota,address entrada,address saida) private view {
        if(entrada==saida){if(rota.length!=0)revert ParametrosInvalidos();return;}
        if(rota.length!=43&&rota.length!=66)revert ParametrosInvalidos();
        if(_token(rota,0)!=entrada||_token(rota,rota.length-20)!=saida)revert ParametrosInvalidos();
        if(rota.length==66){
            address meio=_token(rota,23);
            if(!intermediarioPermitido[meio]||meio==entrada||meio==saida)revert ParametrosInvalidos();
        }
        for(uint256 i=0;i+20<rota.length;i+=23){
            uint24 taxa=_taxa(rota,i+20);
            if(taxa!=100&&taxa!=500&&taxa!=3000&&taxa!=10000)revert ParametrosInvalidos();
            address pool=fabricaV3.getPool(_token(rota,i),_token(rota,i+23),taxa);
            if(pool==address(0)||pool.code.length==0)revert PoolNaoVerificada();
        }
    }

    error ApenasDono();
    error EnderecoInvalido();
    error OperacaoEmAndamento();
    error ParametrosInvalidos();
    error PoolNaoVerificada();
    error CallbackNaoAutorizado();
    error SemGarantiaNova();
    error SemLucroNovo();
    error TransferenciaFalhou();
    error LucroInsuficiente(uint256 real,uint256 piso);

    event MorphoLiquidadoV3(
        bytes32 indexed marketId,address indexed usuario,address indexed garantia,
        uint256 quantiaRepaid,uint256 lucroNaDivida
    );

    constructor(address _morpho,address _routerV3,address _fabricaV3,address _cofre) {
        if (_morpho==address(0)||_routerV3==address(0)
            ||_fabricaV3==address(0)||_cofre==address(0))
            revert EnderecoInvalido();
        dono=msg.sender;
        morpho=ITitanMorphoBlueV3(_morpho);
        routerV3=ITitanSwapRouter02(_routerV3);
        fabricaV3=ITitanUniswapV3Factory(_fabricaV3);
        cofre=_cofre;
        intermediarioPermitido[0x4200000000000000000000000000000000000006]=true;
        intermediarioPermitido[0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913]=true;
    }
    modifier soDono(){
        if (msg.sender!=dono)revert ApenasDono();
        _;
    }
    function _safe(address token,bytes memory data) internal {
        (bool ok,bytes memory ret)=token.call(data);
        if(!ok||(ret.length>0&&(ret.length!=32||!abi.decode(ret,(bool)))))
            revert TransferenciaFalhou();
    }
    function _approve(address token,address spender,uint256 amount) internal {
        uint256 atual=ITitanTokenV3(token).allowance(address(this),spender);
        if(atual!=0)_safe(token,abi.encodeWithSignature("approve(address,uint256)",spender,0));
        _safe(token,abi.encodeWithSignature("approve(address,uint256)",spender,amount));
    }
    /**
     * `pisoLucroDivida` MUST include L1, L2, bidding and safety margin
     * expressed in raw loanToken units. Router minOut includes repay+this floor.
     */
    function liquidar(
        TitanMorphoParamsV3 calldata mercado,address devedor,
        uint256 seizedAssets,uint256 repaidShares,
        uint24 taxa,uint256 pisoLucroDivida,uint256 prazo
    ) external soDono returns(uint256) {
        return _liquidar(mercado,devedor,seizedAssets,repaidShares,
            mercado.loanToken==mercado.collateralToken?bytes(""):abi.encodePacked(mercado.collateralToken,taxa,mercado.loanToken),
            pisoLucroDivida,prazo);
    }
    function liquidarRota(
        TitanMorphoParamsV3 calldata mercado,address devedor,
        uint256 seizedAssets,uint256 repaidShares,
        bytes calldata rota,uint256 pisoLucroDivida,uint256 prazo
    ) external soDono returns(uint256){
        return _liquidar(mercado,devedor,seizedAssets,repaidShares,rota,pisoLucroDivida,prazo);
    }
    function _liquidar(
        TitanMorphoParamsV3 calldata mercado,address devedor,
        uint256 seizedAssets,uint256 repaidShares,
        bytes memory rota,uint256 pisoLucroDivida,uint256 prazo
    ) private returns(uint256 lucro) {
        if(contexto.ativa)revert OperacaoEmAndamento();
        if((seizedAssets==0)==(repaidShares==0)
            ||devedor==address(0)||pisoLucroDivida==0
            ||prazo<block.timestamp
            ||mercado.loanToken==address(0)||mercado.collateralToken==address(0)
            ||mercado.oracle==address(0)||mercado.lltv==0||mercado.lltv>=1e18)
            revert ParametrosInvalidos();
        _validarRota(rota,mercado.collateralToken,mercado.loanToken);
        caminho=rota;
        contexto=Contexto({
            devedor:devedor,garantia:mercado.collateralToken,
            divida:mercado.loanToken,taxa:rota.length>=43?_taxa(rota,20):0,
            saldoInicialDivida:ITitanTokenV3(mercado.loanToken).balanceOf(address(this)),
            saldoInicialGarantia:ITitanTokenV3(mercado.collateralToken).balanceOf(address(this)),
            lucroMinimoDivida:pisoLucroDivida,ativa:true,callbackExecutado:false
        });
        bytes32 marketId=keccak256(abi.encode(mercado));
        (,uint256 paid)=morpho.liquidate(mercado,devedor,seizedAssets,repaidShares,abi.encode(devedor));
        if(!contexto.callbackExecutado)revert CallbackNaoAutorizado();
        uint256 afterBalance=ITitanTokenV3(mercado.loanToken).balanceOf(address(this));
        if(afterBalance<contexto.saldoInicialDivida)revert SemLucroNovo();
        lucro=afterBalance-contexto.saldoInicialDivida;
        if(lucro<pisoLucroDivida)revert LucroInsuficiente(lucro,pisoLucroDivida);
        delete contexto;
        delete caminho;
        // Transfer only new profits to immutable vault. Old balances untouched.
        _safe(mercado.loanToken,abi.encodeWithSignature("transfer(address,uint256)",cofre,lucro));
        emit MorphoLiquidadoV3(marketId,devedor,mercado.collateralToken,paid,lucro);
    }
    function onMorphoLiquidate(uint256 repaidAssets,bytes calldata data) external {
        if(msg.sender!=address(morpho)||!contexto.ativa||contexto.callbackExecutado)
            revert CallbackNaoAutorizado();
        if(abi.decode(data,(address))!=contexto.devedor)revert CallbackNaoAutorizado();
        contexto.callbackExecutado=true; // once, before router external call
        if(repaidAssets==0)revert ParametrosInvalidos();
        uint256 novo=ITitanTokenV3(contexto.garantia).balanceOf(address(this));
        if(novo<=contexto.saldoInicialGarantia)revert SemGarantiaNova();
        uint256 seized=novo-contexto.saldoInicialGarantia;
        if(contexto.garantia!=contexto.divida){
            _approve(contexto.garantia,address(routerV3),seized);
            uint256 out;
            if(caminho.length==66){
                out=routerV3.exactInput(ITitanSwapRouter02.ExactInputParams({
                    path:caminho,recipient:address(this),amountIn:seized,
                    amountOutMinimum:repaidAssets+contexto.lucroMinimoDivida
                }));
            }else{
                out=routerV3.exactInputSingle(ITitanSwapRouter02.ExactInputSingleParams({
                    tokenIn:contexto.garantia,tokenOut:contexto.divida,
                    fee:contexto.taxa,recipient:address(this),amountIn:seized,
                    amountOutMinimum:repaidAssets+contexto.lucroMinimoDivida,sqrtPriceLimitX96:0
                }));
            }
            if(out<repaidAssets+contexto.lucroMinimoDivida)revert SemLucroNovo();
        }
        uint256 saldo=ITitanTokenV3(contexto.divida).balanceOf(address(this));
        if(saldo<contexto.saldoInicialDivida
            ||saldo-contexto.saldoInicialDivida<repaidAssets+contexto.lucroMinimoDivida)
            revert SemLucroNovo();
        _approve(contexto.divida,address(morpho),repaidAssets);
    }
}
