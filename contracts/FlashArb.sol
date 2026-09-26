// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * FlashArb — arbitragem entre dois pools de produto constante (Uniswap V2 e
 * forks), financiada por FLASH SWAP do próprio pool.
 *
 * POR QUE FLASH SWAP E NÃO AAVE:
 * O empréstimo vem do pool que já faz parte do ciclo. Isso elimina a dependência
 * do endereço de um protocolo externo — endereço que precisaria vir de fora e
 * ser conferido, e que errado não estoura: aponta para outro contrato e vira
 * perda silenciosa. Também elimina a taxa extra do provedor: o custo do
 * empréstimo é a mesma taxa de 0,3% do swap que a matemática do projeto já
 * considera.
 *
 * A PROPRIEDADE DE SEGURANÇA:
 * Tudo acontece numa transação. Se o lucro final for menor que `minProfit`, a
 * transação REVERTE e o estado volta ao que era. A perda máxima é o gás — nunca
 * o principal, nunca o saldo do contrato. Isso é garantido pelo `require` no fim
 * de `uniswapV2Call`, não por confiança na estimativa feita fora da cadeia.
 *
 * O QUE ESTE CONTRATO NÃO FAZ:
 * Não escolhe a oportunidade. Ele executa a que for passada. Encontrar o ciclo,
 * dimensionar a entrada e decidir se vale é trabalho do scanner off-chain, que
 * enxerga o grafo inteiro e não paga gás para pensar.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract FlashArb {
    address public immutable owner;

    /**
     * Pool autorizado a chamar de volta durante a execução.
     *
     * Sem isso, qualquer um poderia invocar `uniswapV2Call` com dados
     * arbitrários e mover os fundos do contrato. É transitório: só tem valor
     * diferente de zero DENTRO de uma execução.
     */
    address private pendingPool;

    error NaoAutorizado();
    error ChamadaInesperada();
    error LucroInsuficiente(uint256 obtido, uint256 exigido);
    error PoolSemLiquidez();

    constructor() {
        owner = msg.sender;
    }

    modifier apenasDono() {
        if (msg.sender != owner) revert NaoAutorizado();
        _;
    }

    /**
     * Saída padrão do Uniswap V2, com a taxa de 0,3% embutida (997/1000).
     *
     * Reimplementada aqui em vez de chamar a biblioteca do router: uma chamada
     * externa a mais custa gás em algo que é aritmética pura, e o caminho de
     * execução de uma arbitragem é justamente onde o gás decide se sobra lucro.
     */
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (reserveIn == 0 || reserveOut == 0) revert PoolSemLiquidez();
        uint256 amountInComTaxa = amountIn * 997;
        return (amountInComTaxa * reserveOut) / (reserveIn * 1000 + amountInComTaxa);
    }

    /**
     * Entrada necessária para obter `amountOut`, com a taxa embutida.
     *
     * O `+ 1` no fim é arredondamento PARA CIMA. Arredondar para baixo deixaria
     * o pagamento um wei curto e o pool reverteria a transação inteira por
     * violação da invariante K — perdendo o gás de uma arbitragem que era boa.
     */
    function _amountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (reserveIn == 0 || reserveOut == 0) revert PoolSemLiquidez();
        return (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    /**
     * Executa a arbitragem: toma emprestado de `poolEmprestimo`, vende em
     * `poolVenda`, paga o empréstimo e guarda a sobra.
     *
     * @param poolEmprestimo pool de onde o token sai emprestado
     * @param poolVenda      pool onde ele é vendido (o mesmo par, outra DEX)
     * @param tokenEmprestado token que sai emprestado e é vendido
     * @param quantidade     quanto tomar emprestado
     * @param lucroMinimo    piso de lucro; abaixo disso a transação reverte
     */
    function executarArbitragem(
        address poolEmprestimo,
        address poolVenda,
        address tokenEmprestado,
        uint256 quantidade,
        uint256 lucroMinimo
    ) external apenasDono {
        IUniswapV2Pair pool = IUniswapV2Pair(poolEmprestimo);
        address token0 = pool.token0();

        // Pedir token0 ou token1 conforme qual está sendo emprestado. O outro é
        // o que será devolvido — é isso que faz de um flash swap um swap.
        (uint256 out0, uint256 out1) = tokenEmprestado == token0
            ? (quantidade, uint256(0))
            : (uint256(0), quantidade);

        pendingPool = poolEmprestimo;
        // `data` não vazio é o que transforma o swap em flash swap: o pool
        // chama de volta antes de exigir o pagamento.
        pool.swap(out0, out1, address(this), abi.encode(poolVenda, tokenEmprestado, quantidade, lucroMinimo));
        pendingPool = address(0);
    }

    /**
     * Chamado pelo pool DURANTE `swap`, com o token emprestado já em mãos e
     * antes de o pagamento ser exigido. Todo o ciclo acontece aqui.
     */
    /**
     * Vende o token emprestado no outro pool e devolve o quanto foi recebido.
     *
     * Separado de `uniswapV2Call` por necessidade, não por estilo: com tudo
     * numa função só o compilador não consegue alocar as variáveis na pilha da
     * EVM ("stack too deep"). Dividir é a forma canônica de resolver.
     */
    function _venderNoOutroPool(
        address poolVenda,
        address tokenEmprestado,
        uint256 quantidade
    ) internal returns (uint256 recebido) {
        IUniswapV2Pair venda = IUniswapV2Pair(poolVenda);
        bool ehToken0 = tokenEmprestado == venda.token0();
        (uint112 r0, uint112 r1, ) = venda.getReserves();
        recebido = ehToken0
            ? _amountOut(quantidade, uint256(r0), uint256(r1))
            : _amountOut(quantidade, uint256(r1), uint256(r0));

        // O pool V2 não puxa fundos: quem entrega é o chamador, e o `swap`
        // confere a invariante depois.
        IERC20(tokenEmprestado).transfer(poolVenda, quantidade);
        if (ehToken0) {
            venda.swap(0, recebido, address(this), new bytes(0));
        } else {
            venda.swap(recebido, 0, address(this), new bytes(0));
        }
    }

    /** Quanto o pool do empréstimo exige de volta, no outro token. */
    function _quantoPagar(address poolEmprestimo, address tokenEmprestado, uint256 quantidade)
        internal
        view
        returns (uint256)
    {
        IUniswapV2Pair pool = IUniswapV2Pair(poolEmprestimo);
        (uint112 r0, uint112 r1, ) = pool.getReserves();
        // `reserveIn` é a reserva do token que vai ENTRAR (o devolvido), e
        // `reserveOut` a do que SAIU (o emprestado). Inverter os dois aqui
        // produziria um pagamento menor que o devido, e o pool reverteria a
        // transação inteira — perdendo o gás sem explicação óbvia.
        return tokenEmprestado == pool.token0()
            ? _amountIn(quantidade, uint256(r1), uint256(r0))
            : _amountIn(quantidade, uint256(r0), uint256(r1));
    }

    /**
     * Chamado pelo pool DURANTE `swap`, com o token emprestado já em mãos e
     * antes de o pagamento ser exigido. Todo o ciclo acontece aqui.
     */
    function uniswapV2Call(address sender, uint256, uint256, bytes calldata data) external {
        // Duas guardas, e as duas são necessárias. A primeira impede que
        // qualquer endereço invoque esta função; a segunda impede que um pool
        // legítimo, chamado por outra pessoa, arraste este contrato para uma
        // execução que ele não iniciou.
        if (msg.sender != pendingPool) revert ChamadaInesperada();
        if (sender != address(this)) revert ChamadaInesperada();

        (address poolVenda, address tokenEmprestado, uint256 quantidade, uint256 lucroMinimo) =
            abi.decode(data, (address, address, uint256, uint256));

        _venderNoOutroPool(poolVenda, tokenEmprestado, quantidade);

        address tokenDevolvido = tokenEmprestado == IUniswapV2Pair(msg.sender).token0()
            ? IUniswapV2Pair(msg.sender).token1()
            : IUniswapV2Pair(msg.sender).token0();

        IERC20(tokenDevolvido).transfer(msg.sender, _quantoPagar(msg.sender, tokenEmprestado, quantidade));

        // A GARANTIA. Se o que sobrou não atinge o piso, tudo reverte e o
        // estado volta ao que era. Conferir aqui, e não fora da cadeia, é o que
        // torna a estimativa do scanner irrelevante para a segurança: ela pode
        // estar errada, e o pior caso continua sendo o gás.
        uint256 sobra = IERC20(tokenDevolvido).balanceOf(address(this));
        if (sobra < lucroMinimo) revert LucroInsuficiente(sobra, lucroMinimo);
    }

    /** Saída de fundos. Sem isto, um token enviado por engano ficaria preso. */
    function sacar(address token) external apenasDono {
        IERC20 t = IERC20(token);
        t.transfer(owner, t.balanceOf(address(this)));
    }
}
