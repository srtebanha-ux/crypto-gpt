// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * ARBITRAGEM EM POOLS V3 — flash swap ENCADEADO, sem capital proprio.
 *
 * POR QUE EXISTE. Medido em 2026-10-15, varrendo 900 blocos da Base com
 * cobertura 100%: das 306 arbitragens reais de ciclo fechado, 99% do lucro
 * passa por liquidez concentrada e o universo V2 inteiro rendeu 0,0022 WETH
 * entre TODOS os operadores. O `FlashArbN` esta provado e intocado — ele so nao
 * alcanca os pools onde o dinheiro esta.
 *
 * E A PREMISSA QUE EU TINHA ERRADO, e ela me corrigiu: *"Você afirmou que
 * precisa necessariamente de flash de liquidez concentrada. Isso não é verdade
 * como requisito universal. Separe FONTE DE CAPITAL de EXECUÇÃO."*
 *
 * Certo, e a consequencia e que este contrato nao precisa de fonte nenhuma:
 *
 *   O `swap` do pool V3 JA E um flash swap. O pool manda a saida para o
 *   `recipient` ANTES de cobrar, e so depois chama `uniswapV3SwapCallback`
 *   pedindo a entrada. Entao o credito nasce do proprio swap.
 *
 * Sem Aave, sem `flash()`, sem capital parado. A MENOR solucao funcional.
 *
 * O ENCADEAMENTO, que e o mecanismo inteiro:
 *
 *   1. `poolA.swap`: entra tokenBase, sai tokenX. O pool manda tokenX para ca
 *      e chama o callback cobrando tokenBase — que ainda NAO temos.
 *   2. DENTRO do callback: `poolB.swap` vendendo o tokenX que esta na mao.
 *      O pool B manda tokenBase para ca e chama o callback cobrando tokenX —
 *      que temos.
 *   3. Paga o pool B com o tokenX. Volta.
 *   4. De volta no callback do A, paga o A com o tokenBase que o B entregou.
 *   5. O que sobra de tokenBase e o lucro, e ele e conferido no fim.
 *
 * A COTACAO NAO ESTA AQUI, de proposito. A conta de tick cruzado e do pool, e
 * reimplementa-la seria inventar o numero que decide o tiro — a ordem dela foi
 * explicita: *"Não escreva seu próprio mecanismo de ticks se uma implementação
 * comprovada do protocolo resolver o problema."* Quem quer saber o resultado
 * chama `cotar`, que EXECUTA a rota e reverte devolvendo o numero: a conta e a
 * do pool, exata, com ticks cruzados e impacto de preco.
 *
 * O QUE FOI HERDADO do V2 sem discussao, porque esta provado:
 *
 *   cofre IMUTAVEL         a chave mora no Railway: quem a roubar pode mandar
 *                          cacar, nao pode escolher para onde o dinheiro vai
 *   saldo do CICLO         `baseDoCiclo` tira a foto antes de qualquer
 *                          movimento. Saldo preexistente nao entra na apuracao
 *                          nem e vendido — defeito que ela apontou no FlashArbN
 *                          e que um teste de fork guarda
 *   piso conferido no fim  com os DOIS numeros no erro, senao o log nao diz se
 *                          faltou pouco ou muito
 *   reversao IDENTIFICAVEL cada recusa tem erro proprio. Reversao opaca custou
 *                          a este projeto o capitulo do `naoCruzouAinda`
 *
 * NENHUM ENDERECO ESCRITO AQUI. Todos vem do construtor ou da chamada.
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 v) external returns (bool);
}

interface IPoolAerodrome {
    /**
     * Velodrome V2 / Aerodrome: pede-se a SAIDA, e o pool chama
     * `hook(sender, amount0Out, amount1Out, data)` quando `data` nao e vazio.
     * O pagamento e conferido pelo invariante do proprio pool.
     *
     * CONFERIDO POR CHAMADA na Base, 2026-10-15, no pool `0x566bee7e…`: ele e
     * um PROXY DE 45 BYTES, entao procurar seletor no bytecode nao prova nada
     * — este CLAUDE.md ja registra essa armadilha. `stable()` devolveu false,
     * `token0/token1` devolveram WETH e `0xfb31f85a…`, `factory()` devolveu
     * `0x420dd381…` e `getAmountOut` respondeu. E a chamada que identifica.
     */
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IPoolV3 {
    /**
     * `amountSpecified` POSITIVO e entrada exata; negativo e saida exata.
     * O pool manda a saida ao `recipient` e DEPOIS chama o callback cobrando.
     */
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract CacadorV3 {
    /** Para onde o lucro vai. IMUTAVEL: nem o dono troca. */
    address public immutable cofre;
    address public immutable dono;

    /**
     * Os limites de preco do protocolo.
     *
     * NAO VERIFICADOS por leitura de codigo — e isso esta dito em voz alta. Eles
     * sao os extremos de `sqrtPriceX96` dos ticks -887272 e +887272. A
     * verificacao possivel e a que vale: se estiverem errados, o pool RECUSA o
     * swap (`SPL`) e a transacao reverte sem mover dinheiro. Erra para o lado
     * que custa gas, nunca para o lado que perde fundo. O teste de fork
     * exercita os dois sentidos e e o que os confere.
     */
    uint160 internal constant MIN_SQRT = 4295128739;
    uint160 internal constant MAX_SQRT =
        1461446703485210103287273052203988822378723970342;

    struct Perna {
        address pool;
        /** O token que ENTRA nesta perna. O outro lado do pool e o que sai. */
        address tokenEntra;
        /** 0 = pool V3 (liquidez concentrada). 1 = Aerodrome volatil. */
        uint8 tipo;
        /**
         * Para perna AERODROME: quanto do `tokenEntra` pagar.
         *
         * Vem de FORA de proposito. O Aerodrome confere o pagamento pelo
         * invariante dele e nao expõe `getAmountIn`; calcular aqui seria
         * reimplementar a conta do pool, que e justamente o que a ordem dela
         * proibe. Quem acha o minimo e `cotar`, por bisseccao com `eth_call`,
         * e a cada tentativa e o POOL que aceita ou recusa.
         *
         * Ignorado em perna V3, onde o proprio callback diz o devido.
         */
        uint256 pagamento;
    }

    uint8 internal constant TIPO_V3 = 0;
    uint8 internal constant TIPO_AERODROME = 1;

    struct Caca {
        bool viva;
        /** O pool que pode chamar o callback AGORA. */
        address poolEsperado;
        address tokenBase;
        /** Qual perna esta esperando callback. */
        uint8 indice;
        uint8 total;
    }

    Caca private caca;
    /**
     * As pernas da operacao em curso, 2 a 4.
     *
     * Em storage porque o callback do protocolo nao carrega estado nosso: o
     * `data` que chega de fora e CONFERENCIA, nao fonte. Mesmo desenho do
     * `FlashArbN`, que esta provado.
     */
    Perna[] private pernas;
    mapping(address => uint256) private baseDoCiclo;

    error NaoEDono();
    error CacaViva();
    error ChamadaInesperada(address quemChamou, address esperado);
    error SemCaca();
    error EstagioErrado(uint8 estagio);
    error PernasInvalidas(uint256 quantas);
    error PernaNaoEncaixa(uint8 indice, address esperado, address veio);
    error TipoDePernaDesconhecido(uint8 tipo);
    error PagamentoNaoDeclarado(uint8 indice);
    error PoolSemEsteToken(address pool, address token);
    error NadaEntrou();
    error LucroInsuficiente(uint256 obtido, uint256 piso);
    error TransferenciaFalhou(address token);
    /**
     * O ciclo voltou com MENOS do que o pool A cobra.
     *
     * Existe porque a alternativa e uma reversao MUDA: o WETH da Base reverte
     * `transfer` por saldo insuficiente SEM motivo legivel, e foi isso que fez
     * 72 cotacoes de 72 sairem como "without a reason string" — indistinguivel
     * de contrato quebrado. Com os dois numeros no erro, a recusa passa a dizer
     * QUANTO faltou, e a cotacao devolve informacao em vez de silencio.
     */
    error PagamentoCurto(uint256 tem, uint256 devido);

    event Cacou(address indexed poolA, address indexed poolB, uint256 lucro);

    constructor(address cofre_) {
        require(cofre_ != address(0), "cofre zero");
        cofre = cofre_;
        dono = msg.sender;
    }

    modifier soDono() {
        if (msg.sender != dono) revert NaoEDono();
        _;
    }

    /** O saldo que ESTA OPERACAO trouxe. Preexistente nao entra. */
    function _desteCiclo(address token) internal view returns (uint256) {
        uint256 agora = IERC20(token).balanceOf(address(this));
        uint256 base = baseDoCiclo[token];
        return agora > base ? agora - base : 0;
    }

    function _enviar(address token, address para, uint256 v) internal {
        if (v == 0) return;
        if (!IERC20(token).transfer(para, v)) revert TransferenciaFalhou(token);
    }

    /** `zeroForOne` para entrar com `tokenEntra` neste pool. */
    function _direcao(address pool, address tokenEntra) internal view returns (bool) {
        address t0 = IPoolV3(pool).token0();
        if (t0 == tokenEntra) return true;
        address t1 = IPoolV3(pool).token1();
        if (t1 == tokenEntra) return false;
        revert PoolSemEsteToken(pool, tokenEntra);
    }

    /** O outro lado do pool: o token que SAI. */
    function _outroLado(address pool, address tokenEntra) internal view returns (address) {
        address t0 = IPoolV3(pool).token0();
        if (t0 == tokenEntra) return IPoolV3(pool).token1();
        address t1 = IPoolV3(pool).token1();
        if (t1 == tokenEntra) return t0;
        revert PoolSemEsteToken(pool, tokenEntra);
    }

    /**
     * EXECUTA a rota de dois pools V3 e manda o lucro ao cofre.
     *
     * `lucroMinimo` e conferido NO CONTRATO, sobre o saldo que a operacao
     * trouxe — nao sobre `balanceOf`, que incluiria o preexistente.
     */
    function executarRota(
        Perna[] calldata rota,
        uint256 quantia,
        uint256 lucroMinimo
    ) external soDono returns (uint256 lucro) {
        return _executar(rota, quantia, lucroMinimo);
    }

    /**
     * O corpo, chamado por DENTRO.
     *
     * DEFEITO MEDIDO em 2026-10-15: `cotar` fazia `this.executarRota(...)`, que
     * e chamada EXTERNA — `msg.sender` passa a ser o proprio contrato e
     * `soDono` recusa. Resultado: 180 cotacoes de 180 "recusadas", e eu quase
     * li isso como "nenhuma rota V3 rende". Era o meu portao batendo em mim.
     */
    function _executar(
        Perna[] calldata rota,
        uint256 quantia,
        uint256 lucroMinimo
    ) internal returns (uint256 lucro) {
        if (caca.viva) revert CacaViva();
        if (quantia == 0) revert NadaEntrou();
        if (rota.length < 2 || rota.length > 4) revert PernasInvalidas(rota.length);

        address tokenBase = rota[0].tokenEntra;

        // A ROTA TEM DE ENCAIXAR, e isso e conferido ANTES de mover dinheiro:
        // o que sai de uma perna e o que entra na seguinte, e a ultima volta ao
        // tokenBase. Descobrir isso por reversao custaria gas.
        for (uint8 i = 0; i < rota.length; i++) {
            address sai = _outroLado(rota[i].pool, rota[i].tokenEntra);
            address proximo = i + 1 < rota.length ? rota[i + 1].tokenEntra : tokenBase;
            if (sai != proximo) revert PernaNaoEncaixa(i, proximo, sai);
        }

        // A FOTO antes de qualquer movimento, de TODO token da rota.
        for (uint8 i = 0; i < rota.length; i++) {
            baseDoCiclo[rota[i].tokenEntra] = IERC20(rota[i].tokenEntra).balanceOf(address(this));
        }

        delete pernas;
        for (uint8 i = 0; i < rota.length; i++) pernas.push(rota[i]);
        caca = Caca({
            viva: true,
            poolEsperado: rota[0].pool,
            tokenBase: tokenBase,
            indice: 0,
            total: uint8(rota.length)
        });

        // A PERNA 0 e a fonte de credito: ela manda a saida antes de cobrar, e
        // o pagamento dela e adiado ate o ciclo fechar.
        _dispararPerna(0, rota[0], quantia);

        lucro = _desteCiclo(tokenBase);
        if (lucro < lucroMinimo) revert LucroInsuficiente(lucro, lucroMinimo);

        for (uint8 i = 0; i < rota.length; i++) delete baseDoCiclo[rota[i].tokenEntra];
        delete pernas;
        delete caca;

        _enviar(tokenBase, cofre, lucro);
        emit Cacou(rota[0].pool, rota[rota.length - 1].pool, lucro);
    }

    /**
     * DISPARA a perna `i`, do tipo que ela declara.
     *
     * `entra` e quanto do `tokenEntra` esta disponivel para ela. Em V3 vira
     * entrada exata; em Aerodrome vira o pagamento declarado e a saida sai do
     * `getAmountOut` do PROPRIO pool.
     */
    function _dispararPerna(uint8 i, Perna memory pr, uint256 entra) internal {
        caca.indice = i;
        caca.poolEsperado = pr.pool;
        if (pr.tipo == TIPO_V3) {
            bool zeroForOne = _direcao(pr.pool, pr.tokenEntra);
            IPoolV3(pr.pool).swap(
                address(this),
                zeroForOne,
                int256(entra),
                zeroForOne ? MIN_SQRT + 1 : MAX_SQRT - 1,
                abi.encode(i)
            );
            return;
        }
        if (pr.tipo == TIPO_AERODROME) {
            // O pagamento e declarado; a SAIDA e a conta do pool.
            uint256 paga = pr.pagamento;
            if (paga == 0) revert PagamentoNaoDeclarado(i);
            if (paga > entra && i > 0) revert PagamentoCurto(entra, paga);
            uint256 sai = IPoolAerodrome(pr.pool).getAmountOut(paga, pr.tokenEntra);
            if (sai == 0) revert NadaEntrou();
            bool entraEhToken0 = IPoolV3(pr.pool).token0() == pr.tokenEntra;
            IPoolAerodrome(pr.pool).swap(
                entraEhToken0 ? 0 : sai,
                entraEhToken0 ? sai : 0,
                address(this),
                abi.encode(i)
            );
            return;
        }
        revert TipoDePernaDesconhecido(pr.tipo);
    }

    /**
     * O `hook` do Aerodrome — o mesmo papel do callback do V3.
     *
     * O pool chama isto quando `data` nao e vazio, DEPOIS de ter mandado a
     * saida. Entao a logica e identica: perna 0 adia o pagamento ate o ciclo
     * fechar; perna interna paga na hora, porque ja tem em maos o token que
     * deve.
     */
    function hook(address, uint256, uint256, bytes calldata data) external {
        _cumprirPerna(abi.decode(data, (uint8)), 0);
    }

    /**
     * O CALLBACK, e ele serve TODAS as pernas.
     *
     * O protocolo chama sempre `uniswapV3SwapCallback`, entao o INDICE da perna
     * e quem distingue — e `poolEsperado` e quem autentica. O `data` que chega
     * de fora e CONFERENCIA, nao fonte: o que manda e o storage da caca.
     *
     * A ORDEM DO PAGAMENTO, e ela e o mecanismo:
     *
     *   perna i > 0  paga NA HORA. O token que ela deve e justamente o que a
     *                perna anterior acabou de entregar, e esta na mao
     *   perna 0      paga NO FIM. Ela deve o tokenBase, que so volta quando a
     *                ultima perna fecha o ciclo
     */
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // O positivo dos deltas e o que o pool quer receber; o negativo e o que
        // ele ja mandou.
        uint256 devido = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        _cumprirPerna(abi.decode(data, (uint8)), devido);
    }

    /**
     * O corpo comum aos dois callbacks.
     *
     * `devidoV3` e zero em perna Aerodrome: ali o que se deve e o `pagamento`
     * declarado, e o pool confere pelo invariante dele.
     */
    function _cumprirPerna(uint8 declarado, uint256 devidoV3) internal {
        Caca memory c = caca;
        if (!c.viva) revert SemCaca();
        if (msg.sender != c.poolEsperado) revert ChamadaInesperada(msg.sender, c.poolEsperado);
        if (declarado != c.indice) revert EstagioErrado(declarado);

        uint8 i = c.indice;
        Perna memory minha = pernas[i];
        uint256 devido = minha.tipo == TIPO_V3 ? devidoV3 : minha.pagamento;

        if (i > 0) {
            uint256 tem = _desteCiclo(minha.tokenEntra);
            if (tem < devido) revert PagamentoCurto(tem, devido);
            _enviar(minha.tokenEntra, msg.sender, devido);
        }

        if (i + 1 < c.total) {
            Perna memory proxima = pernas[i + 1];
            uint256 entra = _desteCiclo(proxima.tokenEntra);
            if (entra == 0) revert NadaEntrou();
            _dispararPerna(i + 1, proxima, entra);
            // Volta ao meu indice para o fim da minha chamada.
            caca.indice = i;
            caca.poolEsperado = msg.sender;
        }

        if (i == 0) {
            // IDENTIFICACAO POSITIVA antes de pagar: o que o ciclo trouxe
            // contra o que o pool cobra. Sem isto o `transfer` do WETH reverte
            // calado — medido: 72 cotacoes de 72 como "without a reason
            // string", indistinguivel de contrato quebrado.
            uint256 temBase = _desteCiclo(c.tokenBase);
            if (temBase < devido) revert PagamentoCurto(temBase, devido);
            _enviar(c.tokenBase, msg.sender, devido);
        }
    }

    /**
     * COTA a rota EXECUTANDO-A e revertendo com o numero.
     *
     * E o padrao do Quoter do proprio protocolo, e existe por uma razao que
     * este projeto pagou para aprender: a conta de tick cruzado e do pool. Uma
     * cotacao calculada por mim sairia certa em pool de um tick e errada
     * exatamente onde ha oportunidade.
     *
     * Reverte SEMPRE — com `LucroInsuficiente(lucro, type(uint256).max)` — para
     * nao mover dinheiro. Quem chama le o numero no `data` da reversao via
     * `eth_call`.
     */
    function cotar(
        Perna[] calldata rota,
        uint256 quantia
    ) external soDono {
        _executar(rota, quantia, type(uint256).max);
    }

    /** O saque vai ao COFRE, sempre. Nao ha destino escolhivel. */
    function sacar(address token) external soDono {
        _enviar(token, cofre, IERC20(token).balanceOf(address(this)));
    }
}
