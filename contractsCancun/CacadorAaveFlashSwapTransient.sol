// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * TITAN — liquidacao Aave V3 com swap V3 de SAIDA EXATA.
 *
 * O swap fornece o token da divida ANTES de cobrar o colateral.
 * Dentro do callback pagamos a divida na Aave, recebemos garantia
 * e quitamos a pool com a parcela de garantia exigida.
 *
 * Isto NAO e credito gratuito: a taxa e o impacto da pool V3 estao
 * incluidos no input de colateral pedido pelo swap. O gas L1/L2 e
 * comparado offchain, e o piso economico e aplicado onchain.
 *
 * Isolado do CacadorDeLiquidacoes em producao. Nao implantado.
 * VARIANTE CANCUN EIP-1153: callback flags sao transitorias.
 * So aceita factory V3 canonica por getPool e pool token0/token1 exatos.
 */
interface ITitanAaveDirect {
    function getUserAccountData(address user) external view returns (
        uint256, uint256, uint256, uint256, uint256, uint256
    );
    function liquidationCall(
        address collateralAsset,address debtAsset,address user,
        uint256 debtToCover,bool receiveAToken
    ) external;
}
interface ITitanERC20Direct {
    function balanceOf(address user) external view returns(uint256);
    function approve(address who,uint256 amount) external returns(bool);
    function transfer(address to,uint256 amount) external returns(bool);
}
interface ITitanV3Direct {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function swap(
        address recipient,bool zeroForOne,int256 amountSpecified,
        uint160 sqrtPriceLimitX96,bytes calldata data
    ) external returns (int256,int256);
}
interface ITitanV3FactoryDirect {
    function getPool(address tokenA,address tokenB,uint24 fee) external view returns(address);
}
contract CacadorAaveFlashSwapTransient {
    address public immutable dono;
    address public immutable cofre;
    address public immutable aave;
    address public immutable fabricaV3;

    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT =
        1461446703485210103287273052203988822378723970342 - 1;

    struct Caca {
        address pool;
        address garantia;
        address divida;
        address usuario;
        uint256 dividaParaCobrir;
        uint256 garantiaMaximaAPagar;
        uint256 lucroMinimo;
        uint256 garantiaAntes;
        uint256 dividaAntes;
        uint256 garantiaPaga;
        // Flags Cancun movidas para TSTORE/TLOAD.
    }
    Caca private caca;
    function _viva() internal view returns(bool v) {
        assembly { v := tload(0xcafe001) }
    }
    function _setViva(bool v) internal {
        assembly { tstore(0xcafe001,v) }
    }
    function _callbackFeito() internal view returns(bool v) {
        assembly { v := tload(0xcafe002) }
    }
    function _setCallback(bool v) internal {
        assembly { tstore(0xcafe002,v) }
    }

    error NaoDono();
    error CacaEmAndamento();
    error EntradaInvalida();
    error PoolNaoCanonica();
    error SaudeNaoLiquidavel(uint256 healthFactor);
    error CallbackInesperado();
    error DividaNaoRecebida(uint256 recebida,uint256 esperada);
    error DeltasInvalidos();
    error GarantiaExcessiva(uint256 pedida,uint256 maxima);
    error GarantiaInsuficiente(uint256 recebida,uint256 devida);
    error LucroInsuficiente(uint256 recebido,uint256 esperado);
    error TransferenciaFalhou(address token);

    event LiquidacaoDireta(
        address indexed usuario,address indexed pool,
        address garantia,address divida,uint256 dividaCoberta,
        uint256 garantiaPaga,uint256 lucroGarantia,uint256 restoDivida
    );

    constructor(address cofre_,address aave_,address fabricaV3_) {
        if(cofre_==address(0)||aave_==address(0)||fabricaV3_==address(0))
            revert EntradaInvalida();
        dono=msg.sender;cofre=cofre_;aave=aave_;fabricaV3=fabricaV3_;
    }
    modifier soDono() {
        if(msg.sender!=dono) revert NaoDono();
        _;
    }
    function _saldo(address token) internal view returns(uint256) {
        return ITitanERC20Direct(token).balanceOf(address(this));
    }
    function _transferir(address token,address to,uint256 amount) internal {
        if(amount>0 && !ITitanERC20Direct(token).transfer(to,amount))
            revert TransferenciaFalhou(token);
    }
    function _aprovar(address token,address to,uint256 amount) internal {
        if(!ITitanERC20Direct(token).approve(to,0)
            || !ITitanERC20Direct(token).approve(to,amount))
            revert TransferenciaFalhou(token);
    }
    /**
     * O porteiro de Health Factor e anterior ao swap. Economiza uma
     * tentativa cara se a Aave ja considera a conta saudavel.
     * NAO substitui o ensaio eth_call, nem garante custo fixo de revert.
     */
    function liquidar(
        address pool,uint24 fee,address garantia,address divida,
        address usuario,uint256 cobrir,uint256 maxGarantia,
        uint256 lucroMinimoGarantia
    ) external soDono returns(uint256 lucro) {
        if(_viva()) revert CacaEmAndamento();
        if(pool==address(0)||garantia==address(0)||divida==address(0)
            ||usuario==address(0)||garantia==divida
            ||cobrir==0||cobrir>uint256(type(int256).max)
            ||maxGarantia==0||lucroMinimoGarantia==0) revert EntradaInvalida();

        address token0=ITitanV3Direct(pool).token0();
        address token1=ITitanV3Direct(pool).token1();
        if(!((token0==garantia&&token1==divida)
            ||(token1==garantia&&token0==divida))
            ||ITitanV3FactoryDirect(fabricaV3).getPool(garantia,divida,fee)!=pool)
            revert PoolNaoCanonica();

        (,,,,,uint256 hf)=ITitanAaveDirect(aave).getUserAccountData(usuario);
        if(hf>=1e18) revert SaudeNaoLiquidavel(hf);

        uint256 anteriorGarantia=_saldo(garantia);
        uint256 anteriorDivida=_saldo(divida);
        caca=Caca({
            pool:pool,garantia:garantia,divida:divida,usuario:usuario,
            dividaParaCobrir:cobrir,garantiaMaximaAPagar:maxGarantia,
            lucroMinimo:lucroMinimoGarantia,
            garantiaAntes:anteriorGarantia,dividaAntes:anteriorDivida,
            garantiaPaga:0
        });

        _setViva(true);
        _setCallback(false);
        // Direcao eh sempre GARANTIA -> DIVIDA. Queremos divida como
        // SAIDA EXATA, portanto amountSpecified e negativo.
        bool zeroForOne=token0==garantia;
        ITitanV3Direct(pool).swap(
            address(this),zeroForOne,-int256(cobrir),
            zeroForOne?MIN_SQRT:MAX_SQRT,""
        );
        if(!_callbackFeito()) revert CallbackInesperado();

        return _fechar();
    }
    function _fechar() internal returns(uint256 lucro) {
        Caca memory c=caca;
        // A Aave pode liquidar menos por close factor; o saldo de divida
        // nao utilizado e devolvido ao cofre, nunca contado como WETH ganho.
        uint256 finalGarantia=_saldo(c.garantia);
        if(finalGarantia < c.garantiaAntes+c.lucroMinimo)
            revert LucroInsuficiente(
                finalGarantia>c.garantiaAntes?finalGarantia-c.garantiaAntes:0,
                c.lucroMinimo
            );
        lucro=finalGarantia-c.garantiaAntes;
        uint256 finalDivida=_saldo(c.divida);
        if(finalDivida<c.dividaAntes) revert EntradaInvalida();
        uint256 restoDivida=finalDivida-c.dividaAntes;

        delete caca;
        _setViva(false);
        _setCallback(false);
        _transferir(c.garantia,cofre,lucro);
        _transferir(c.divida,cofre,restoDivida);
        emit LiquidacaoDireta(
            c.usuario,c.pool,c.garantia,c.divida,c.dividaParaCobrir,
            c.garantiaPaga,lucro,restoDivida
        );
    }
    function uniswapV3SwapCallback(int256 d0,int256 d1,bytes calldata) external {
        Caca storage c=caca;
        if(!_viva()||_callbackFeito()||msg.sender!=c.pool)
            revert CallbackInesperado();
        _setCallback(true);
        bool garantia0=ITitanV3Direct(msg.sender).token0()==c.garantia;
        // Exatamente um positivo: pagamento em garantia; outro negativo:
        // a pool enviou a divida. Dados externos nao decidem o token.
        int256 aPagar=garantia0?d0:d1;
        int256 saida=garantia0?d1:d0;
        if(aPagar<=0||saida>=0) revert DeltasInvalidos();
        uint256 devido=uint256(aPagar);
        uint256 recebido=uint256(-saida);
        if(recebido!=c.dividaParaCobrir) revert DividaNaoRecebida(recebido,c.dividaParaCobrir);
        if(devido>c.garantiaMaximaAPagar)
            revert GarantiaExcessiva(devido,c.garantiaMaximaAPagar);
        if(_saldo(c.divida)<c.dividaAntes+c.dividaParaCobrir)
            revert DividaNaoRecebida(_saldo(c.divida)-c.dividaAntes,c.dividaParaCobrir);

        _aprovar(c.divida,aave,c.dividaParaCobrir);
        ITitanAaveDirect(aave).liquidationCall(
            c.garantia,c.divida,c.usuario,c.dividaParaCobrir,false
        );
        uint256 col=_saldo(c.garantia);
        if(col<c.garantiaAntes+devido+c.lucroMinimo)
            revert GarantiaInsuficiente(
                col>c.garantiaAntes?col-c.garantiaAntes:0,
                devido+c.lucroMinimo
            );
        c.garantiaPaga=devido;
        _transferir(c.garantia,msg.sender,devido);
    }
    // Fundos legados nunca sao contados como lucro de outra pessoa.
    // Resgate apenas ao cofre imutavel; nao mexe na caca em andamento.
    function resgatar(address token) external soDono {
        if(_viva()) revert CacaEmAndamento();
        _transferir(token,cofre,_saldo(token));
    }
}
