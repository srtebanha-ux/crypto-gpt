// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * Cacador V2 — liquidacao com venda na Aerodrome.
 *
 * Mesma mecanica de sempre: pega emprestado sem garantia, paga a divida de
 * quem quebrou, leva o colateral com agio, vende, devolve o emprestimo, e o
 * que sobra vai embora. Se qualquer passo falhar, a rede desfaz tudo.
 *
 * O QUE MUDOU EM RELACAO A VERSAO QUE ELA ESCREVEU
 *
 * 1. O lucro voltou para um COFRE IMUTAVEL. A versao anterior mandava para
 *    `owner`, que e a conta cuja chave privada mora no Railway. Isso desfazia
 *    a unica protecao que este projeto construiu de proposito: com o cofre
 *    separado, uma chave roubada pode mandar cacar, mas NAO escolhe para onde
 *    o dinheiro vai. Mandando para o dono, a chave vazada leva tudo que ja foi
 *    ganho — e `withdrawToken` entregava o resto.
 *
 * 2. `amountOutMin` deixou de ser zero. Zero significa "aceito qualquer
 *    preco", que e um convite para um bot empurrar o preco, nossa venda
 *    executar no preco ruim e ele desfazer com o lucro. O piso agora vai para
 *    a propria DEX, que recusa ANTES de executar em vez de a gente reverter
 *    depois pagando gas.
 *
 * 3. Autorizacao zera antes de mudar. USDT e parentes revertem quando se
 *    troca uma allowance diferente de zero por outra diferente de zero, e o
 *    caminho anterior dava dois `approve` seguidos para a mesma pool.
 *
 * 4. Voltou o evento. Sem ele nao da para auditar na rede o que aconteceu em
 *    cada cacada.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract CacadorV2 {
    address public immutable dono;
    IPool public immutable aavePool;
    IAerodromeRouter public immutable aerodromeRouter;
    address public immutable aerodromeFactory;

    /**
     * Para onde o lucro vai. IMUTAVEL e sem funcao para trocar.
     *
     * E a defesa contra a chave do bot vazar: quem a roubar pode fazer o
     * contrato cacar, mas o lucro cai aqui de qualquer jeito. Nem ele nem o
     * dono tem como redirecionar.
     */
    address public immutable cofre;

    /** Trava de reentrada: so vale dentro de uma cacada iniciada aqui. */
    bool private emCacada;

    error NaoEDono();
    error EnderecoInvalido();
    error ChamadaInesperada();
    error SemGarantia();
    error LucroInsuficiente(uint256 obtido, uint256 exigido);

    event Cacada(address indexed devedor, address garantia, uint256 lucro);

    modifier apenasDono() {
        if (msg.sender != dono) revert NaoEDono();
        _;
    }

    constructor(address _aavePool, address _router, address _factory, address _cofre) {
        if (_aavePool == address(0) || _router == address(0) || _factory == address(0) || _cofre == address(0)) {
            revert EnderecoInvalido();
        }
        dono = msg.sender;
        aavePool = IPool(_aavePool);
        aerodromeRouter = IAerodromeRouter(_router);
        aerodromeFactory = _factory;
        cofre = _cofre;
    }

    /** Autoriza zerando antes: USDT e parentes revertem sem isso. */
    function _autorizar(address token, address gastador, uint256 quantia) internal {
        if (IERC20(token).allowance(address(this), gastador) != 0) {
            IERC20(token).approve(gastador, 0);
        }
        IERC20(token).approve(gastador, quantia);
    }

    function cacar(
        address collateralAsset,
        address debtAsset,
        address userToLiquidate,
        uint256 debtToCover,
        bool isStablePool,
        uint256 minProfit
    ) external apenasDono {
        emCacada = true;
        aavePool.flashLoanSimple(
            address(this),
            debtAsset,
            debtToCover,
            abi.encode(collateralAsset, userToLiquidate, minProfit, isStablePool),
            0
        );
        emCacada = false;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        // Tres guardas com trabalhos diferentes: a primeira impede que
        // qualquer endereco invoque isto; a segunda impede que a Aave
        // legitima, chamada por OUTRA pessoa, arraste este contrato para uma
        // execucao que ele nao comecou; a terceira fecha a janela fora de uma
        // cacada nossa.
        if (msg.sender != address(aavePool)) revert ChamadaInesperada();
        if (initiator != address(this)) revert ChamadaInesperada();
        if (!emCacada) revert ChamadaInesperada();

        (address collateralAsset, address userToLiquidate, uint256 minProfit, bool isStablePool) =
            abi.decode(params, (address, address, uint256, bool));

        uint256 aDevolver = amount + premium;

        _autorizar(asset, address(aavePool), amount);
        aavePool.liquidationCall(collateralAsset, asset, userToLiquidate, amount, false);

        uint256 lucro = _venderGarantia(asset, collateralAsset, isStablePool, aDevolver, minProfit);

        _autorizar(asset, address(aavePool), aDevolver);
        if (lucro > 0) IERC20(asset).transfer(cofre, lucro);

        emit Cacada(userToLiquidate, collateralAsset, lucro);
        return true;
    }

    function _venderGarantia(
        address asset,
        address collateralAsset,
        bool isStablePool,
        uint256 aDevolver,
        uint256 minProfit
    ) internal returns (uint256 lucro) {
        uint256 recebido;

        if (collateralAsset == asset) {
            // Mesma moeda: nao ha o que trocar, e pedir a uma DEX que troque
            // A por A reverte. O saldo ja esta em maos.
            recebido = IERC20(asset).balanceOf(address(this));
        } else {
            uint256 colateral = IERC20(collateralAsset).balanceOf(address(this));
            if (colateral == 0) revert SemGarantia();

            _autorizar(collateralAsset, address(aerodromeRouter), colateral);

            IAerodromeRouter.Route[] memory rotas = new IAerodromeRouter.Route[](1);
            rotas[0] = IAerodromeRouter.Route({
                from: collateralAsset,
                to: asset,
                stable: isStablePool,
                factory: aerodromeFactory
            });

            // O piso vai para a DEX. Ela recusa ANTES de executar, em vez de a
            // gente reverter depois pagando o gas da troca inteira — e fecha a
            // porta para quem empurra o preco esperando que a gente aceite
            // qualquer coisa.
            aerodromeRouter.swapExactTokensForTokens(
                colateral,
                aDevolver + minProfit,
                rotas,
                address(this),
                block.timestamp
            );

            // Nao deixar autorizacao sobrando depois que a transacao acabou.
            _autorizar(collateralAsset, address(aerodromeRouter), 0);
            recebido = IERC20(asset).balanceOf(address(this));
        }

        // `balanceOf` e nao o valor calculado fora: a Aave pode ter cortado o
        // quanto cobrir, e a DEX pode ter devolvido mais que o pedido.
        lucro = recebido > aDevolver ? recebido - aDevolver : 0;

        // A trava intocada. Mesmo com o piso ja exigido da DEX, conferir aqui
        // cobre o caso de a moeda cobrar taxa na transferencia.
        if (lucro < minProfit) revert LucroInsuficiente(lucro, minProfit);
    }

    /** Resgata token preso. Sempre para o cofre, nunca para quem chamou. */
    function resgatar(address token) external apenasDono {
        IERC20(token).transfer(cofre, IERC20(token).balanceOf(address(this)));
    }
}
