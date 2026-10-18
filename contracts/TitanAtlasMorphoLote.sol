// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./CacadorMorpho.sol";

/**
 * TITAN-SVR / Atlas v1.x:
 * Batch Morpho liquidations for WETH debt markets on Base.
 *
 * SEPARATE new contract: does not alter any deployed executor or wallet.
 *
 * The Atlas auction operator sends atlasSolverCall, not a naked liquidation.
 * Profits of this transaction pay the native ETH bid using WETH.withdraw;
 * pre-existing WETH is never counted as profitable execution.
 *
 * Scope deliberately narrow: loanToken MUST be WETH. Other debt currencies
 * require dedicated conversion, not a guessed route or pre-funded ETH.
 */
interface IAtlasTitan {
    function shortfall() external view returns (uint256 gasLiability, uint256 borrowLiability);
    function reconcile(uint256 maxApprovedGasSpend) external payable returns (uint256 owed);
}
interface IWethTitan {
    function balanceOf(address account) external view returns (uint256);
    function withdraw(uint256 wad) external;
    function transfer(address to, uint256 value) external returns (bool);
}
contract TitanAtlasMorphoLote {
    address public immutable dono;
    address public immutable cofre;
    address public immutable weth;
    address public immutable atlas;
    IMorpho public immutable morpho;
    IAerodromeRouter public immutable router;
    address public immutable factory;
    bool private executandoAtlas;
    bool private executandoLote;

    struct Alvo {
        MarketParams market;
        address devedor;
        uint256 seizedAssets;   // exactly one of seizedAssets, repaidShares
        uint256 repaidShares;
        bool poolEstavel;
        uint256 lucroMinimoWeth;
    }
    struct EmCurso {
        address devedor;
        address garantia;
        uint256 garantiaAnterior;
        uint256 minimoLucro;
        bool poolEstavel;
        bool ativa;
        bool retornou;
    }
    EmCurso private emCurso;

    error EntradaInvalida();
    error AssinanteInvalido();
    error ContextoInvalido();
    error TamanhoDeLoteInvalido();
    error MercadoNaoWETH();
    error TokenRejeitou(address token);
    error SemGarantiaNova();
    error LucroInsuficiente(uint256 obtido, uint256 minimo);
    error SaldoAntigoUtilizado();
    error LanceInsuficiente(uint256 disponivel, uint256 lance);
    error PagamentoLanceFalhou();
    error ReconciliacaoComCreditoExterno();
    error CallbackInvalido();

    event LiquidacaoDoLote(address indexed devedor, uint256 pagoWeth, uint256 lucroWeth);
    event LoteAtlasExecutado(uint256 posicoes, uint256 lanceWeth, uint256 lucroLiquidoWeth);

    constructor(
        address _atlas, address _morpho, address _router, address _factory,
        address _weth, address _cofre
    ) {
        if (_atlas == address(0) || _morpho == address(0) || _router == address(0)
            || _factory == address(0) || _weth == address(0) || _cofre == address(0))
            revert EntradaInvalida();
        dono = msg.sender;
        atlas = _atlas;
        morpho = IMorpho(_morpho);
        router = IAerodromeRouter(_router);
        factory = _factory;
        weth = _weth;
        cofre = _cofre;
    }

    receive() external payable {
        // ETH can only arrive as proceeds of WETH.withdraw, never arbitrary
        // donations used to fake native bid liquidity.
        if (msg.sender != weth) revert EntradaInvalida();
    }

    function _tokenOk(address token, bytes memory data) internal {
        (bool ok, bytes memory returned) = token.call(data);
        if (!ok || (returned.length != 0
           && (returned.length < 32 || !abi.decode(returned, (bool)))))
            revert TokenRejeitou(token);
    }

    function _aprovar(address token, address spender, uint256 amount) internal {
        if (IERC20(token).allowance(address(this), spender) != 0) {
            _tokenOk(token, abi.encodeCall(IERC20.approve, (spender, 0)));
        }
        _tokenOk(token, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    /**
     * Atlas SolverBase-compatible entry; limited to native ETH bids.
     * No arbitrary calldata from untrusted solverOpData gets delegated:
     * the only callable selector is executarLote.
     */
    function atlasSolverCall(
        address solverOpFrom, address executionEnvironment, address bidToken,
        uint256 bidAmount, bytes calldata solverOpData, bytes calldata
    ) external payable {
        if (msg.sender != atlas || executandoAtlas) revert EntradaInvalida();
        if (solverOpFrom != dono) revert AssinanteInvalido();
        if (executionEnvironment == address(0) || bidToken != address(0)
            || bidAmount == 0 || msg.value != 0 || address(this).balance != 0)
            revert ContextoInvalido();
        if (solverOpData.length < 4 || bytes4(solverOpData[:4]) != this.executarLote.selector)
            revert ContextoInvalido();

        executandoAtlas = true;
        uint256 inicial = IWethTitan(weth).balanceOf(address(this));
        (bool passou, bytes memory response) = address(this).call(solverOpData);
        if (!passou) {
            assembly { revert(add(response, 32), mload(response)) }
        }
        (uint256 quantidade, uint256 minimoWeth) = abi.decode(response, (uint256,uint256));
        uint256 atual = IWethTitan(weth).balanceOf(address(this));
        if (atual < inicial) revert SaldoAntigoUtilizado();
        uint256 gerado = atual - inicial;
        if (gerado < bidAmount) revert LanceInsuficiente(gerado, bidAmount);
        if (gerado - bidAmount < minimoWeth) revert LucroInsuficiente(gerado-bidAmount,minimoWeth);

        // Bid paid strictly from WETH earned in the SAME Atlas transaction.
        IWethTitan(weth).withdraw(bidAmount);
        (bool paid,) = executionEnvironment.call{value: bidAmount}("");
        if (!paid) revert PagamentoLanceFalhou();

        (uint256 gasLiability, uint256 borrowLiability) = IAtlasTitan(atlas).shortfall();
        // Forbid receiving borrowed native ETH outside the proved profit.
        if (borrowLiability != 0) revert ReconciliacaoComCreditoExterno();
        IAtlasTitan(atlas).reconcile(gasLiability);

        uint256 depois = IWethTitan(weth).balanceOf(address(this));
        if (depois < inicial) revert SaldoAntigoUtilizado();
        uint256 lucro = depois - inicial;
        if (lucro < minimoWeth) revert LucroInsuficiente(lucro,minimoWeth);
        if (lucro != 0) _tokenOk(weth,abi.encodeCall(IWethTitan.transfer,(cofre,lucro)));
        emit LoteAtlasExecutado(quantidade,bidAmount,lucro);
        executandoAtlas=false;
    }

    /**
     * Called only via self-call from Atlas entry, before bid settlement.
     * Batch of up to 16 positions. A revert rolls back all operations.
     */
    function executarLote(Alvo[] calldata alvos, uint256 minimoLiquidoWeth)
        external returns (uint256 quantidade, uint256 minimoWeth)
    {
        if (msg.sender != address(this) || !executandoAtlas || executandoLote)
            revert EntradaInvalida();
        if (alvos.length == 0 || alvos.length > 16 || minimoLiquidoWeth == 0)
            revert TamanhoDeLoteInvalido();
        executandoLote = true;

        for (uint256 i = 0; i < alvos.length; ++i) {
            Alvo calldata a = alvos[i];
            if (a.market.loanToken != weth) revert MercadoNaoWETH();
            if (a.devedor == address(0) || a.market.collateralToken == address(0)
                || (a.seizedAssets == 0) == (a.repaidShares == 0)
                || a.lucroMinimoWeth == 0) revert EntradaInvalida();

            uint256 antes = IWethTitan(weth).balanceOf(address(this));
            emCurso = EmCurso({
                devedor:a.devedor,
                garantia:a.market.collateralToken,
                garantiaAnterior:IERC20(a.market.collateralToken).balanceOf(address(this)),
                minimoLucro:a.lucroMinimoWeth,
                poolEstavel:a.poolEstavel,ativa:true,retornou:false
            });
            morpho.liquidate(a.market,a.devedor,a.seizedAssets,a.repaidShares,abi.encode(a.devedor));
            if (!emCurso.retornou) revert CallbackInvalido();
            delete emCurso;

            uint256 depois = IWethTitan(weth).balanceOf(address(this));
            if (depois < antes) revert SaldoAntigoUtilizado();
            uint256 novo = depois - antes;
            if (novo < a.lucroMinimoWeth) revert LucroInsuficiente(novo,a.lucroMinimoWeth);
            emit LiquidacaoDoLote(a.devedor,a.seizedAssets != 0?a.seizedAssets:a.repaidShares,novo);
        }
        executandoLote = false;
        return (alvos.length,minimoLiquidoWeth);
    }

    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(morpho) || !executandoAtlas || !executandoLote
            || !emCurso.ativa || emCurso.retornou) revert CallbackInvalido();
        if (abi.decode(data,(address)) != emCurso.devedor || repaidAssets == 0)
            revert CallbackInvalido();
        emCurso.retornou = true;

        uint256 saldo = IERC20(emCurso.garantia).balanceOf(address(this));
        if (saldo <= emCurso.garantiaAnterior) revert SemGarantiaNova();
        uint256 garantiaNova = saldo - emCurso.garantiaAnterior;

        if (emCurso.garantia != weth) {
            _aprovar(emCurso.garantia,address(router),garantiaNova);
            IAerodromeRouter.Route[] memory rota = new IAerodromeRouter.Route[](1);
            rota[0] = IAerodromeRouter.Route({
                from:emCurso.garantia,to:weth,
                stable:emCurso.poolEstavel,factory:factory
            });
            router.swapExactTokensForTokens(
                garantiaNova,repaidAssets+emCurso.minimoLucro,
                rota,address(this),block.timestamp
            );
        }
        _aprovar(weth,address(morpho),repaidAssets);
    }
}
