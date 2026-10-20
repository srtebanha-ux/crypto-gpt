// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * TITAN Morpho Blue -> Aerodrome stable/volatile canonical pool.
 * Not deployed. No automatic broadcast. This contract is not an authorization
 * to spend gas; real liquidation still needs fresh eth_call, gas L1/L2, token
 * behavior, nonce isolation and a funded bounded operation.
 *
 * Morpho transfers seized collateral, calls onMorphoLiquidate on THIS contract
 * and afterwards pulls repaidAssets loan tokens. No separate flash loan.
 */
struct TitanMorphoParamsAero {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}
interface ITitanMorphoBlueAero {
    function liquidate(
        TitanMorphoParamsAero calldata params,
        address borrower,uint256 seizedAssets,uint256 repaidShares,bytes calldata data
    ) external returns (uint256 assetsSeized,uint256 assetsRepaid);
}
interface ITitanTokenAero {
    function balanceOf(address) external view returns (uint256);
    function allowance(address,address) external view returns (uint256);
}
interface ITitanAeroFactory {
    function getPool(address,address,bool) external view returns (address);
}
interface ITitanAeroRouter {
    struct Route { address from; address to; bool stable; address factory; }
    function swapExactTokensForTokens(
        uint256 amountIn,uint256 amountOutMin,Route[] calldata routes,
        address recipient,uint256 deadline
    ) external returns (uint256[] memory amounts);
}
contract TitanCacadorMorphoAero {
    address public immutable dono;
    address public immutable cofre;
    ITitanMorphoBlueAero public immutable morpho;
    ITitanAeroRouter public immutable aerodromeRouter;
    ITitanAeroFactory public immutable aerodromeFactory;

    struct Contexto {
        address devedor;
        address garantia;
        address divida;
        bool poolEstavel;
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

    constructor(address _morpho,address _aerodromeRouter,address _aerodromeFactory,address _cofre) {
        if (_morpho==address(0)||_aerodromeRouter==address(0)
            ||_aerodromeFactory==address(0)||_cofre==address(0))
            revert EnderecoInvalido();
        dono=msg.sender;
        morpho=ITitanMorphoBlueAero(_morpho);
        aerodromeRouter=ITitanAeroRouter(_aerodromeRouter);
        aerodromeFactory=ITitanAeroFactory(_aerodromeFactory);
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
        uint256 atual=ITitanTokenAero(token).allowance(address(this),spender);
        if(atual!=0)_safe(token,abi.encodeWithSignature("approve(address,uint256)",spender,0));
        _safe(token,abi.encodeWithSignature("approve(address,uint256)",spender,amount));
    }
    /**
     * `pisoLucroDivida` MUST include L1, L2, bidding and safety margin
     * expressed in raw loanToken units. Router minOut includes repay+this floor.
     */
    function liquidar(
        TitanMorphoParamsAero calldata mercado,address devedor,
        uint256 seizedAssets,uint256 repaidShares,
        bool poolEstavel,uint256 pisoLucroDivida,uint256 prazo
    ) external soDono returns(uint256 lucro) {
        if(contexto.ativa)revert OperacaoEmAndamento();
        if((seizedAssets==0)==(repaidShares==0)
            ||devedor==address(0)||pisoLucroDivida==0
            ||prazo<block.timestamp
            ||mercado.loanToken==address(0)||mercado.collateralToken==address(0)
            ||mercado.oracle==address(0)||mercado.lltv==0||mercado.lltv>=1e18)
            revert ParametrosInvalidos();
        if(mercado.loanToken!=mercado.collateralToken){
            address pool=aerodromeFactory.getPool(mercado.collateralToken,mercado.loanToken,poolEstavel);
            if(pool==address(0)||pool.code.length==0)revert PoolNaoVerificada();
        }else if(poolEstavel)revert ParametrosInvalidos();
        contexto=Contexto({
            devedor:devedor,garantia:mercado.collateralToken,
            divida:mercado.loanToken,poolEstavel:poolEstavel,
            saldoInicialDivida:ITitanTokenAero(mercado.loanToken).balanceOf(address(this)),
            saldoInicialGarantia:ITitanTokenAero(mercado.collateralToken).balanceOf(address(this)),
            lucroMinimoDivida:pisoLucroDivida,ativa:true,callbackExecutado:false
        });
        bytes32 marketId=keccak256(abi.encode(mercado));
        (,uint256 paid)=morpho.liquidate(mercado,devedor,seizedAssets,repaidShares,abi.encode(devedor));
        if(!contexto.callbackExecutado)revert CallbackNaoAutorizado();
        uint256 afterBalance=ITitanTokenAero(mercado.loanToken).balanceOf(address(this));
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
        uint256 novo=ITitanTokenAero(contexto.garantia).balanceOf(address(this));
        if(novo<=contexto.saldoInicialGarantia)revert SemGarantiaNova();
        uint256 seized=novo-contexto.saldoInicialGarantia;
        if(contexto.garantia!=contexto.divida){
            _approve(contexto.garantia,address(aerodromeRouter),seized);
            ITitanAeroRouter.Route[] memory rota=new ITitanAeroRouter.Route[](1);
            rota[0]=ITitanAeroRouter.Route({
                from:contexto.garantia,to:contexto.divida,
                stable:contexto.poolEstavel,factory:address(aerodromeFactory)
            });
            uint256[] memory outputs=aerodromeRouter.swapExactTokensForTokens(
                seized,repaidAssets+contexto.lucroMinimoDivida,
                rota,address(this),block.timestamp
            );
            uint256 out=outputs.length==2?outputs[1]:0;
            if(out<repaidAssets+contexto.lucroMinimoDivida)revert SemLucroNovo();
        }
        uint256 saldo=ITitanTokenAero(contexto.divida).balanceOf(address(this));
        if(saldo<contexto.saldoInicialDivida
            ||saldo-contexto.saldoInicialDivida<repaidAssets+contexto.lucroMinimoDivida)
            revert SemLucroNovo();
        _approve(contexto.divida,address(morpho),repaidAssets);
    }
}
