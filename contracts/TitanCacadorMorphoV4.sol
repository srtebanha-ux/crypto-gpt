// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * TITAN Morpho Blue -> Uniswap V3 SwapRouter02, TWO-HOP extension; deploy only after local and Base fork checks.
 * Independent V4 deployment. No automatic broadcast. This contract is not an authorization
 * to spend gas; real liquidation still needs fresh eth_call, gas L1/L2, token
 * behavior, nonce isolation and a funded bounded operation.
 *
 * Morpho transfers seized collateral, calls onMorphoLiquidate on THIS contract
 * and afterwards pulls repaidAssets loan tokens. No separate flash loan.
 */
struct TitanMorphoParamsV4 {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}
interface ITitanMorphoBlueV4 {
    function liquidate(
        TitanMorphoParamsV4 calldata params,
        address borrower,uint256 seizedAssets,uint256 repaidShares,bytes calldata data
    ) external returns (uint256 assetsSeized,uint256 assetsRepaid);
}
interface ITitanTokenV4 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address,address) external view returns (uint256);
}
interface ITitanUniswapV4Factory {
    function getPool(address,address,uint24) external view returns (address);
}
interface ITitanSwapRouterV4 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns(uint256 amountOut);
    struct ExactInputParams {
        bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params)
        external payable returns(uint256 amountOut);
}
contract TitanCacadorMorphoV4 {
    address public immutable dono;
    address public immutable cofre;
    ITitanMorphoBlueV4 public immutable morpho;
    ITitanSwapRouterV4 public immutable routerV3;
    ITitanUniswapV4Factory public immutable fabricaV3;

    struct Contexto {
        address devedor;
        address garantia;
        address divida;
        uint24 taxa;
        address intermediario;
        uint24 taxaSegundo;
        uint256 saldoInicialDivida;
        uint256 saldoInicialGarantia;
        uint256 lucroMinimoDivida;
        bool ativa;
        bool callbackExecutado;
    }
    Contexto private contexto;

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
        morpho=ITitanMorphoBlueV4(_morpho);
        routerV3=ITitanSwapRouterV4(_routerV3);
        fabricaV3=ITitanUniswapV4Factory(_fabricaV3);
        cofre=_cofre;
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
        uint256 atual=ITitanTokenV4(token).allowance(address(this),spender);
        if(atual!=0)_safe(token,abi.encodeWithSignature("approve(address,uint256)",spender,0));
        _safe(token,abi.encodeWithSignature("approve(address,uint256)",spender,amount));
    }
    /**
     * `pisoLucroDivida` MUST include L1, L2, bidding and safety margin
     * expressed in raw loanToken units. Router minOut includes repay+this floor.
     */
    function liquidar(
        TitanMorphoParamsV4 calldata mercado,address devedor,
        uint256 seizedAssets,uint256 repaidShares,
        uint24 taxa,address intermediario,uint24 taxaSegundo,uint256 pisoLucroDivida,uint256 prazo
    ) external soDono returns(uint256 lucro) {
        if(contexto.ativa)revert OperacaoEmAndamento();
        if((seizedAssets==0)==(repaidShares==0)
            ||devedor==address(0)||pisoLucroDivida==0
            ||prazo<block.timestamp
            ||mercado.loanToken==address(0)||mercado.collateralToken==address(0)
            ||mercado.oracle==address(0)||mercado.lltv==0||mercado.lltv>=1e18)
            revert ParametrosInvalidos();
        if(mercado.loanToken==mercado.collateralToken) {
            if(intermediario!=address(0)||taxaSegundo!=0)revert ParametrosInvalidos();
        }else{
            if(taxa!=100&&taxa!=500&&taxa!=3000&&taxa!=10000)
                revert ParametrosInvalidos();
            address proximo=intermediario==address(0)?mercado.loanToken:intermediario;
            if(proximo==mercado.collateralToken||intermediario==mercado.loanToken)
                revert ParametrosInvalidos();
            address pool=fabricaV3.getPool(mercado.collateralToken,proximo,taxa);
            if(pool==address(0)||pool.code.length==0)revert PoolNaoVerificada();
            if(intermediario!=address(0)){
                if(taxaSegundo!=100&&taxaSegundo!=500&&taxaSegundo!=3000&&taxaSegundo!=10000)
                    revert ParametrosInvalidos();
                address segunda=fabricaV3.getPool(intermediario,mercado.loanToken,taxaSegundo);
                if(segunda==address(0)||segunda.code.length==0)revert PoolNaoVerificada();
            }else if(taxaSegundo!=0)revert ParametrosInvalidos();
        }
        contexto=Contexto({
            devedor:devedor,garantia:mercado.collateralToken,
            divida:mercado.loanToken,taxa:taxa,intermediario:intermediario,taxaSegundo:taxaSegundo,
            saldoInicialDivida:ITitanTokenV4(mercado.loanToken).balanceOf(address(this)),
            saldoInicialGarantia:ITitanTokenV4(mercado.collateralToken).balanceOf(address(this)),
            lucroMinimoDivida:pisoLucroDivida,ativa:true,callbackExecutado:false
        });
        bytes32 marketId=keccak256(abi.encode(mercado));
        (,uint256 paid)=morpho.liquidate(mercado,devedor,seizedAssets,repaidShares,abi.encode(devedor));
        if(!contexto.callbackExecutado)revert CallbackNaoAutorizado();
        uint256 afterBalance=ITitanTokenV4(mercado.loanToken).balanceOf(address(this));
        if(afterBalance<contexto.saldoInicialDivida)revert SemLucroNovo();
        lucro=afterBalance-contexto.saldoInicialDivida;
        if(lucro<pisoLucroDivida)revert LucroInsuficiente(lucro,pisoLucroDivida);
        delete contexto;
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
        uint256 novo=ITitanTokenV4(contexto.garantia).balanceOf(address(this));
        if(novo<=contexto.saldoInicialGarantia)revert SemGarantiaNova();
        uint256 seized=novo-contexto.saldoInicialGarantia;
        if(contexto.garantia!=contexto.divida){
            _approve(contexto.garantia,address(routerV3),seized);
            uint256 out;
            if(contexto.intermediario==address(0)){
                out=routerV3.exactInputSingle(
                    ITitanSwapRouterV4.ExactInputSingleParams({
                        tokenIn:contexto.garantia,tokenOut:contexto.divida,
                        fee:contexto.taxa,recipient:address(this),amountIn:seized,
                        amountOutMinimum:repaidAssets+contexto.lucroMinimoDivida,
                        sqrtPriceLimitX96:0
                    })
                );
            }else{
                out=routerV3.exactInput(
                    ITitanSwapRouterV4.ExactInputParams({
                        path:abi.encodePacked(contexto.garantia,contexto.taxa,
                            contexto.intermediario,contexto.taxaSegundo,contexto.divida),
                        recipient:address(this),amountIn:seized,
                        amountOutMinimum:repaidAssets+contexto.lucroMinimoDivida
                    })
                );
            }
            if(out<repaidAssets+contexto.lucroMinimoDivida)revert SemLucroNovo();
        }
        uint256 saldo=ITitanTokenV4(contexto.divida).balanceOf(address(this));
        if(saldo<contexto.saldoInicialDivida
            ||saldo-contexto.saldoInicialDivida<repaidAssets+contexto.lucroMinimoDivida)
            revert SemLucroNovo();
        _approve(contexto.divida,address(morpho),repaidAssets);
    }
}
