// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * FLASH SWAP DE N PERNAS — 2, 3 ou 4 swaps.
 *
 * POR QUE EXISTE, e nao e refatoracao: `FlashArb.executarArbitragem` faz
 * exatamente DUAS pernas (pool de emprestimo + pool de venda). Rota triangular
 * e de 4 swaps nao cabem nele, e a dona do bot pediu as duas. O FlashArb
 * continua intocado — ele esta provado em fork e nenhum defeito dele foi
 * demonstrado.
 *
 * E HA UMA SEGUNDA RAZAO, medida: `FlashArb._venderNoOutroPool` calcula a saida
 * com a formula V2 (997/1000). Um pool da Aerodrome nao obedece a ela — o
 * stable usa x³y+y³x=k, e a taxa vem da fabrica (medido: 30 para volatil, 5
 * para stable). Usar a Aerodrome com aquela conta produziria numero errado.
 *
 * ENTAO AQUI A CONTA DE CADA PERNA SAI DO TIPO DELA:
 *
 *   tipo 0  V2 e compativeis — formula local, taxa em `taxaPorDezMil`
 *   tipo 1  Aerodrome — PERGUNTA ao pool `getAmountOut(uint256,address)`
 *
 * Perguntar nao e preguica: o pool da Aerodrome expoe a propria matematica, e
 * reimplementa-la aqui seria uma copia que o pool desmente. Medido no par
 * WETH/USDC com 0,01 WETH: o pool volatil devolveu 24.215.310 e o stable
 * 24.222.112 — numeros diferentes, da mesma chamada, pelo mesmo endereco.
 *
 * O EMPRESTIMO continua sendo flash swap V2: o primeiro pool da rota tem de
 * chamar `uniswapV2Call`. Quatro fabricas da Base foram CONFERIDAS no bytecode
 * (Uniswap V2, SushiSwap, SwapBased, Alien Base). A Aerodrome NAO pode ser a
 * perna de emprestimo: os pools dela sao proxies de 45 bytes, o callback tem
 * outro nome, e supor que atende seria reversao paga. Ela entra como perna de
 * VENDA, que e so um `swap`.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPar {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IPoolAerodrome {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

contract FlashArbN {
    /**
     * O COFRE e IMUTAVEL, e isto e herdado do V2 sem discussao: a chave mora
     * num painel, e quem a roubar pode mandar arbitrar — nao pode escolher
     * para onde o dinheiro vai.
     */
    address public immutable cofre;
    address public immutable dono;

    /** O pool que esta emprestando AGORA. Fora da caca, zero. */
    address private poolPendente;

    /**
     * A LINHA DE BASE por token, tirada no inicio da operacao.
     *
     * Sem ela o contrato nao distingue o que a rota trouxe do que ja estava
     * aqui — e apuraria como lucro um saldo preexistente. Limpa no fim da
     * operacao: deixar valor gravado faria a proxima rota medir contra uma
     * base velha, que e o mesmo defeito com outro rosto.
     */
    mapping(address => uint256) private baseDoCiclo;

    error NaoEDono();
    error ChamadaInesperada();
    error LucroInsuficiente(uint256 obtido, uint256 exigido);
    error RotaInvalida();
    error PoolSemLiquidez();
    error HopSemSaida();

    /**
     * Uma perna da rota.
     *
     * `tipo` decide a MATEMATICA, e nao o nome da DEX: duas fabricas diferentes
     * com a mesma formula sao o mesmo tipo, e o mesmo endereco com formula
     * diferente nao e.
     */
    struct Perna {
        address pool;
        /** O token que ENTRA nesta perna. */
        address tokenEntra;
        /** 0 = V2 e compativeis (formula local). 1 = Aerodrome (pergunta). */
        uint8 tipo;
        /** Taxa em por dez mil. 30 = 0,30%. Ignorada quando `tipo` = 1. */
        uint16 taxaPorDezMil;
    }

    constructor(address cofre_) {
        if (cofre_ == address(0)) revert RotaInvalida();
        cofre = cofre_;
        dono = msg.sender;
    }

    modifier apenasDono() {
        if (msg.sender != dono) revert NaoEDono();
        _;
    }

    /**
     * Saida de um swap de produto constante, com a taxa em por dez mil.
     *
     * Generaliza `FlashArb._amountOut`: com `taxa = 30` o resultado e
     * identico ao 997/1000 dele, e um teste em fork exige essa igualdade.
     */
    function saidaV2(uint256 entrada, uint256 reservaEntra, uint256 reservaSai, uint16 taxa)
        public pure returns (uint256)
    {
        if (reservaEntra == 0 || reservaSai == 0) revert PoolSemLiquidez();
        uint256 g = 10000 - uint256(taxa);
        uint256 comTaxa = entrada * g;
        return (comTaxa * reservaSai) / (reservaEntra * 10000 + comTaxa);
    }

    /**
     * Entrada necessaria para obter `saida`, arredondada PARA CIMA.
     *
     * O `+ 1` nao e enfeite: e o que faz o pagamento BASTAR. Para baixo, o pool
     * recusa pelo invariante e a transacao inteira reverte depois de ter gasto
     * o gas das pernas todas.
     */
    function entradaV2(uint256 saida, uint256 reservaEntra, uint256 reservaSai, uint16 taxa)
        public pure returns (uint256)
    {
        if (reservaEntra == 0 || reservaSai == 0) revert PoolSemLiquidez();
        if (saida >= reservaSai) revert HopSemSaida();
        uint256 g = 10000 - uint256(taxa);
        return (reservaEntra * saida * 10000) / ((reservaSai - saida) * g) + 1;
    }

    /** A saida de UMA perna, pelo tipo dela. */
    function saidaDaPerna(Perna memory p, uint256 entrada) public view returns (uint256) {
        if (p.tipo == 1) {
            // A CONTA E DO POOL. Ver a docstring do contrato.
            return IPoolAerodrome(p.pool).getAmountOut(entrada, p.tokenEntra);
        }
        (uint112 r0, uint112 r1,) = IPar(p.pool).getReserves();
        address t0 = IPar(p.pool).token0();
        return p.tokenEntra == t0
            ? saidaV2(entrada, uint256(r0), uint256(r1), p.taxaPorDezMil)
            : saidaV2(entrada, uint256(r1), uint256(r0), p.taxaPorDezMil);
    }

    /**
     * Executa a rota inteira num flash swap.
     *
     * `pernas[0]` e o EMPRESTIMO: dele sai `quantidade` do token que ele
     * libera, e para ele volta o pagamento no outro token. As pernas 1..n-1 sao
     * as vendas, em sequencia.
     *
     * O lucro sobra no token que o pool de emprestimo RECEBE — nao no que ele
     * solta. Essa troca custou uma reversao real em fork na ENTREGA 1
     * (`LucroInsuficiente(232994792294, 109421743953172010)`, piso 470 mil
     * vezes maior que a sobra), e aqui ela esta no desenho.
     */
    function executarRota(Perna[] calldata pernas, uint256 quantidade, uint256 lucroMinimo)
        external apenasDono
    {
        if (pernas.length < 2 || pernas.length > 4) revert RotaInvalida();
        if (quantidade == 0) revert RotaInvalida();
        // O EMPRESTIMO tem de ser V2: so ele chama `uniswapV2Call`.
        if (pernas[0].tipo != 0) revert RotaInvalida();

        IPar emprestimo = IPar(pernas[0].pool);
        address t0 = emprestimo.token0();
        // `tokenEntra` da perna 0 e o token que PAGA. O que sai e o outro.
        address tokenSolto = pernas[0].tokenEntra == t0 ? emprestimo.token1() : t0;
        (uint256 out0, uint256 out1) = tokenSolto == t0
            ? (quantidade, uint256(0))
            : (uint256(0), quantidade);

        // A LINHA DE BASE de TODOS os tokens da rota, ANTES de qualquer
        // movimento. E isto que isola a operacao do saldo preexistente.
        for (uint256 i = 0; i < pernas.length; i++) {
            address t = pernas[i].tokenEntra;
            baseDoCiclo[t] = IERC20(t).balanceOf(address(this));
        }
        baseDoCiclo[tokenSolto] = IERC20(tokenSolto).balanceOf(address(this));

        poolPendente = pernas[0].pool;
        // `data` nao vazio e o que transforma o swap em flash swap.
        emprestimo.swap(out0, out1, address(this), abi.encode(pernas, quantidade, lucroMinimo));
        poolPendente = address(0);

        // LIMPA a base: deixar gravado faria a proxima rota medir contra uma
        // base velha. Um mapping que sobrevive a operacao e estado que mente.
        for (uint256 i = 0; i < pernas.length; i++) {
            baseDoCiclo[pernas[i].tokenEntra] = 0;
        }
        baseDoCiclo[tokenSolto] = 0;
    }

    /**
     * Chamado pelo pool de emprestimo, com o token na mao e antes do pagamento.
     *
     * Duas guardas, e as duas sao necessarias: a primeira impede que qualquer
     * endereco invoque; a segunda impede que um pool legitimo, chamado por
     * outra pessoa, arraste este contrato para uma execucao que ele nao
     * iniciou.
     */
    function uniswapV2Call(address remetente, uint256, uint256, bytes calldata dados) external {
        if (msg.sender != poolPendente) revert ChamadaInesperada();
        if (remetente != address(this)) revert ChamadaInesperada();

        (Perna[] memory pernas, uint256 quantidade, uint256 lucroMinimo) =
            abi.decode(dados, (Perna[], uint256, uint256));

        // AS VENDAS, da perna 1 ao fim.
        uint256 valor = quantidade;
        for (uint256 i = 1; i < pernas.length; i++) {
            valor = _vender(pernas[i], valor);
        }

        // O PAGAMENTO, no token que o pool de emprestimo recebe.
        address tokenPaga = pernas[0].tokenEntra;
        uint256 devido = _quantoPagar(pernas[0], quantidade);
        IERC20(tokenPaga).transfer(msg.sender, devido);

        // A GARANTIA, conferida NA CADEIA e SOBRE O QUE ESTA ROTA GEROU.
        //
        // `balanceOf` cru incluiria saldo preexistente, e aí o piso passaria
        // por dinheiro que nao e desta operacao — aprovando no fim o que a rota
        // nao produziu. A sobra e a diferenca contra a linha de base.
        uint256 sobra = _desteCiclo(tokenPaga);
        if (sobra < lucroMinimo) revert LucroInsuficiente(sobra, lucroMinimo);
    }

    /**
     * Vende `entrada` do token que entra nesta perna, e devolve o que saiu.
     *
     * Separado do callback por necessidade, nao por estilo: com tudo numa
     * funcao so o compilador nao aloca as variaveis na pilha da EVM.
     */
    function _vender(Perna memory p, uint256 entrada) internal returns (uint256) {
        // VENDE O QUE ESTA EM MAOS, nao a quantia teorica.
        //
        // DEFEITO MEDIDO, 2026-10-14: a primeira versao transferia `entrada` —
        // o numero que a avaliacao previu. Numa rota de quatro pernas, um token
        // com taxa de transferencia entrega MENOS do que mandou, e a perna
        // seguinte tentava sacar a descoberto: seis simulacoes em fork, duas
        // delas revertendo com `Insufficient Account Balance` e uma com
        // `SafeMath: subtraction overflow`.
        //
        // Ler o saldo custa uma chamada e remove a classe inteira: o que entra
        // na perna e o que o contrato TEM, e a saida e recalculada sobre esse
        // numero. Assim a conta da perna n nao herda a mentira da perna n-1.
        // ISOLAMENTO: a operacao so toca o que ELA trouxe.
        //
        // DEFEITO MEU, e a dona do bot apontou: a versao anterior lia
        // `balanceOf` cru. Isso resolveu o saque a descoberto (token taxado
        // entrega menos) mas criou outro — o saldo PREEXISTENTE do contrato
        // entrava na conta. Um token parado aqui de uma operacao anterior, ou
        // enviado por engano, seria vendido junto, e o lucro apurado no fim
        // incluiria dinheiro que nao e desta rota.
        //
        // A correcao e medir CONTRA A LINHA DE BASE tirada na entrada: o que
        // conta e a DIFERENCA, nao o saldo. `vai` fica limitado ao que esta
        // disponivel desta operacao, e nunca excede `entrada`.
        uint256 disponivel = _desteCiclo(p.tokenEntra);
        uint256 vai = entrada < disponivel ? entrada : disponivel;
        if (vai == 0) revert HopSemSaida();
        uint256 saida = saidaDaPerna(p, vai);
        if (saida == 0) revert HopSemSaida();
        IPar par = IPar(p.pool);
        address t0 = par.token0();
        address tokenSai = p.tokenEntra == t0 ? par.token1() : t0;
        uint256 antesDaSaida = IERC20(tokenSai).balanceOf(address(this));
        // O token entra no pool por transferencia; o `swap` so retira a saida.
        IERC20(p.tokenEntra).transfer(p.pool, vai);
        (uint256 a0, uint256 a1) = p.tokenEntra == t0
            ? (uint256(0), saida)
            : (saida, uint256(0));
        par.swap(a0, a1, address(this), new bytes(0));
        // O QUE DE FATO CHEGOU NESTA PERNA, e nao o que o `swap` prometeu nem o
        // saldo total: um token taxado tira a sua parte tambem na saida, e o
        // saldo total carregaria o preexistente.
        return IERC20(tokenSai).balanceOf(address(this)) - antesDaSaida;
    }

    /**
     * Quanto deste token pertence AO CICLO DE AGORA.
     *
     * Saldo total menos a linha de base registrada na entrada. Nunca negativo:
     * se o saldo caiu abaixo da base — o que so acontece com token que mexe no
     * saldo de terceiros — a resposta e zero, e a perna reverte por
     * `HopSemSaida` em vez de calcular sobre um numero impossivel.
     */
    function _desteCiclo(address token) internal view returns (uint256) {
        uint256 agora = IERC20(token).balanceOf(address(this));
        uint256 base = baseDoCiclo[token];
        return agora > base ? agora - base : 0;
    }

    /** Quanto o pool de emprestimo exige de volta. Arredonda PARA CIMA. */
    function _quantoPagar(Perna memory p, uint256 quantidade) internal view returns (uint256) {
        if (p.tipo == 1) revert RotaInvalida();
        IPar par = IPar(p.pool);
        (uint112 r0, uint112 r1,) = par.getReserves();
        address t0 = par.token0();
        // `tokenEntra` paga; o outro foi solto. A entrada necessaria e calculada
        // sobre as reservas na direcao do PAGAMENTO.
        return p.tokenEntra == t0
            ? entradaV2(quantidade, uint256(r0), uint256(r1), p.taxaPorDezMil)
            : entradaV2(quantidade, uint256(r1), uint256(r0), p.taxaPorDezMil);
    }

    /** Saida de fundos, SEMPRE para o cofre imutavel. */
    function sacar(address token) external apenasDono {
        IERC20 t = IERC20(token);
        t.transfer(cofre, t.balanceOf(address(this)));
    }
}
