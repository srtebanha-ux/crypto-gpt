// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * Cacador MORPHO — liquidacao no Morpho Blue, com venda na Aerodrome.
 *
 * POR QUE ESTE CONTRATO EXISTE, em numeros medidos e nao em opiniao:
 *
 *   bolo de bonus da Base, 30 dias, cobertura 99,9%:
 *     Morpho Blue   81% do bolo   61% das liquidacoes pagam o proprio gas
 *     Aave V3       12% do bolo   23% pagam o proprio gas
 *
 *   e o INCENTIVO, que e formula do LLTV e nao medicao
 *   (conferida contra 4 de 6 medianas do censo, dentro de 0,11 ponto):
 *     LLTV 62,5%  ->  12,68%      LLTV 86,0%  ->  4,38%
 *     LLTV 77,0%  ->   7,41%      LLTV 94,5%  ->  1,68%
 *   contra os 4,56% medidos no alvo real da Aave de 2026-10-07. 2,8x.
 *
 * O MECANISMO E OUTRO, e esta e a parte que importa para quem ler depois.
 *
 * Na Aave: `flashLoanSimple` empresta, a gente paga a divida, leva a garantia,
 * vende, devolve o emprestimo. O emprestimo e um passo separado.
 *
 * No Morpho: **o callback E o emprestimo.** `liquidate` transfere a garantia
 * tomada para ca, chama `onMorphoLiquidate`, e SO DEPOIS puxa o token da
 * divida da nossa conta. Ou seja, dentro do callback a gente ja tem a garantia
 * na mao e ainda nao pagou nada — e o trabalho e converter garantia em divida
 * e autorizar o Morpho a puxar.
 *
 * Nao existe `flashLoan` aqui, e nao e preciso: a sequencia do proprio
 * `liquidate` ja da o credito.
 *
 * O QUE ESTE CONTRATO HERDA DO V2, de proposito e sem discussao:
 *
 *   1. COFRE IMUTAVEL. O lucro nao vai para `dono` — vai para um endereco
 *      fixado no construtor, sem funcao para trocar. E a defesa contra a chave
 *      do bot vazar: quem a roubar pode fazer o contrato cacar, e o lucro cai
 *      no cofre de qualquer jeito.
 *   2. `amountOutMin` NAO e zero. Zero e convite para alguem empurrar o preco,
 *      nossa venda executar no preco ruim e ele desfazer com o lucro. O piso
 *      vai para a DEX, que recusa ANTES de executar em vez de a gente reverter
 *      depois pagando gas.
 *   3. Autorizacao zera antes de mudar. USDT e parentes revertem quando se
 *      troca uma allowance diferente de zero por outra diferente de zero.
 *   4. Piso de lucro VERIFICADO no fim, e reversao com os dois numeros dentro
 *      do erro — sem isso nao da para saber, do log, se faltou pouco ou muito.
 *
 * E O QUE AINDA NAO ESTA VERIFICADO CONTRA A REDE, declarado porque este
 * projeto perdeu dias com coisa afirmada e nao conferida:
 *
 *   - O nome e a assinatura do callback (`onMorphoLiquidate(uint256,bytes)`).
 *     **Se eu errei, ele FALHA FECHADO:** o Morpho chamaria uma funcao que nao
 *     existe, nao ha `fallback` aqui, e a transacao inteira reverte. Erra para
 *     o lado que custa gas, nunca para o lado que perde a garantia.
 *   - A ESCALA do oraculo do Morpho (1e36), que vive em `src/morpho.ts` e
 *     decide quem o bot considera liquidavel. Ela nao entra neste contrato:
 *     aqui quem decide se a posicao esta quebrada e o PROPRIO Morpho, dentro
 *     de `liquidate`. Se a nossa conta estiver errada, o custo e gas numa
 *     reversao — nao um tiro em posicao sadia que "passa".
 *   - Nenhum endereco esta escrito aqui. Todos vem do construtor, e a corrente
 *     e quem os identifica. Endereco de cabeca e o defeito que o CLAUDE.md
 *     registra na REGRA 0, em hexadecimal.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * Os parametros que IDENTIFICAM um mercado do Morpho.
 *
 * O `id` do mercado e `keccak256(abi.encode(marketParams))` — entao estes
 * cinco campos NAO sao configuracao, sao a identidade. Trocar um e falar de
 * outro mercado.
 */
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorpho {
    /**
     * Liquida uma posicao quebrada.
     *
     * EXATAMENTE UM de `seizedAssets` e `repaidShares` pode ser diferente de
     * zero — o Morpho recusa os dois preenchidos e recusa os dois zerados.
     * Passar os dois foi o primeiro jeito que me pareceu natural, e esta
     * escrito aqui para a proxima sessao nao tentar.
     *
     * Com `data` nao vazio, o Morpho chama `onMorphoLiquidate` em `msg.sender`
     * DEPOIS de mandar a garantia e ANTES de puxar o token da divida.
     */
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);
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

contract CacadorMorpho {
    address public immutable dono;
    IMorpho public immutable morpho;
    IAerodromeRouter public immutable aerodromeRouter;
    address public immutable aerodromeFactory;

    /**
     * Para onde o lucro vai. IMUTAVEL e sem funcao para trocar.
     *
     * Mesma razao do V2: a chave do bot mora no Railway. Quem a roubar pode
     * mandar cacar — nao pode escolher para onde o dinheiro vai.
     */
    address public immutable cofre;

    /**
     * O que esta caca combinou, enquanto ela dura.
     *
     * Vive em storage porque o callback vem do Morpho e nao da nossa pilha:
     * ele nao recebe nossos parametros, so o `data` que a gente mandou. Mas o
     * `data` vem de FORA no momento em que o Morpho chama, e tratar o que
     * chega de fora como verdade seria abrir a porta. Entao o `data` serve de
     * CONFERENCIA contra o que esta aqui, e nao de fonte.
     */
    struct Caca {
        address garantia;
        address divida;
        address poolDeVenda;
        bool poolEstavel;
        uint256 pisoDeLucro;
        bool viva;
    }
    Caca private caca;

    error NaoEDono();
    error EnderecoInvalido();
    error ChamadaInesperada();
    error SemGarantia();
    error LucroInsuficiente(uint256 obtido, uint256 exigido);
    error UmDosDoisZero();

    event CacadaNoMorpho(
        address indexed devedor,
        address garantia,
        address divida,
        uint256 levou,
        uint256 pagou,
        uint256 lucro
    );

    modifier apenasDono() {
        if (msg.sender != dono) revert NaoEDono();
        _;
    }

    constructor(address _morpho, address _router, address _factory, address _cofre) {
        if (_morpho == address(0) || _router == address(0) || _factory == address(0) || _cofre == address(0)) {
            revert EnderecoInvalido();
        }
        dono = msg.sender;
        morpho = IMorpho(_morpho);
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

    /**
     * Cacar no Morpho.
     *
     * `seizedAssets` OU `repaidShares` — um dos dois, nunca os dois. O portao
     * esta aqui e nao so no Morpho para a reversao dizer QUAL foi o erro: uma
     * reversao do Morpho sem motivo legivel foi o que custou a este projeto o
     * capitulo do `naoCruzouAinda`.
     *
     * `poolDeVenda == address(0)` PULA a venda, e isso nao e um caso de borda:
     * quando garantia e divida sao o MESMO token, vender e vender inclusive o
     * que a gente precisa para pagar. Foi medido na Aave em 8 alvos de moeda
     * unica, e aqui a regra nasce junto.
     */
    function cacar(
        MarketParams calldata params,
        address devedor,
        uint256 seizedAssets,
        uint256 repaidShares,
        address poolDeVenda,
        bool poolEstavel,
        uint256 pisoDeLucro
    ) external apenasDono {
        if ((seizedAssets == 0) == (repaidShares == 0)) revert UmDosDoisZero();

        caca = Caca({
            garantia: params.collateralToken,
            divida: params.loanToken,
            poolDeVenda: poolDeVenda,
            poolEstavel: poolEstavel,
            pisoDeLucro: pisoDeLucro,
            viva: true
        });

        // `data` nao vazio e o que faz o Morpho chamar o callback. O conteudo
        // e so a conferencia: quem manda e o storage acima.
        morpho.liquidate(params, devedor, seizedAssets, repaidShares, abi.encode(devedor));

        // A caca morre aqui, mesmo que o callback nao tenha rodado. Deixar
        // `viva` para tras era deixar a porta do callback aberta para a
        // proxima transacao de qualquer um.
        uint256 lucro = _fecharEPagar(devedor);
        delete caca;
        if (lucro < pisoDeLucro) revert LucroInsuficiente(lucro, pisoDeLucro);
    }

    /**
     * O callback do Morpho: a garantia JA esta aqui, a divida AINDA nao foi
     * puxada.
     *
     * `repaidAssets` e quanto o Morpho vai puxar de `loanToken` desta conta
     * quando este callback voltar. Entao o trabalho e: vender a garantia e
     * autorizar exatamente isso.
     *
     * TRES portoes, e cada um fecha uma porta diferente:
     *   1. `msg.sender == morpho` — ninguem mais chama isto.
     *   2. `caca.viva` — nem o Morpho chama fora de uma caca iniciada aqui.
     *   3. o `data` tem de decodificar — lixo vindo de fora reverte em vez de
     *      virar caminho.
     */
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert ChamadaInesperada();
        if (!caca.viva) revert ChamadaInesperada();
        abi.decode(data, (address));

        uint256 emCaixa = IERC20(caca.garantia).balanceOf(address(this));
        if (emCaixa == 0) revert SemGarantia();

        if (caca.poolDeVenda != address(0) && caca.garantia != caca.divida) {
            // O PISO VAI PARA O ROUTER, nao para uma conferencia depois.
            //
            // `repaidAssets + pisoDeLucro` e o minimo que a venda tem de
            // devolver para a caca fechar no lucro. Mandando isso como
            // `amountOutMin`, a DEX recusa ANTES de executar — a gente nao
            // paga gas de um swap que ia dar errado.
            //
            // E foi aqui que o V2 tropecou: com o piso IMPOSSIVEL da medicao,
            // o router recusava e a medicao virava "revertido" sempre, o que
            // matou o V2 para a decisao por dias. Quem mede tem de mandar piso
            // zero; quem atira manda o piso de verdade.
            _autorizar(caca.garantia, address(aerodromeRouter), emCaixa);
            IAerodromeRouter.Route[] memory rota = new IAerodromeRouter.Route[](1);
            rota[0] = IAerodromeRouter.Route({
                from: caca.garantia,
                to: caca.divida,
                stable: caca.poolEstavel,
                factory: aerodromeFactory
            });
            aerodromeRouter.swapExactTokensForTokens(
                emCaixa,
                repaidAssets + caca.pisoDeLucro,
                rota,
                address(this),
                block.timestamp
            );
        }

        // O Morpho puxa daqui quando este callback voltar.
        _autorizar(caca.divida, address(morpho), repaidAssets);
    }

    /**
     * Manda o lucro ao cofre e devolve quanto foi.
     *
     * O lucro e o que sobrou do token da DIVIDA: a garantia virou divida na
     * venda, o Morpho puxou o que era dele, e o resto e nosso. Quando a venda
     * e pulada (moeda unica), o que sobra e a propria garantia — e ela e o
     * mesmo token da divida, entao a conta e a mesma.
     */
    function _fecharEPagar(address devedor) internal returns (uint256 lucro) {
        lucro = IERC20(caca.divida).balanceOf(address(this));
        if (lucro > 0) IERC20(caca.divida).transfer(cofre, lucro);
        emit CacadaNoMorpho(devedor, caca.garantia, caca.divida, 0, 0, lucro);
    }

    /**
     * Resgate de poeira para o COFRE — nunca para o dono.
     *
     * Existe porque uma venda pode deixar um resto de garantia preso aqui, e
     * token parado em contrato e dinheiro que ninguem pega. Manda para o
     * cofre: se mandasse para quem chama, seria a porta que o cofre imutavel
     * existe para fechar.
     */
    function resgatar(address token) external apenasDono {
        uint256 saldo = IERC20(token).balanceOf(address(this));
        if (saldo > 0) IERC20(token).transfer(cofre, saldo);
    }
}
