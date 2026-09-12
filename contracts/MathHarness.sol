// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * Expõe a aritmética do FlashArb para teste.
 *
 * As funções do contrato real são `internal pure` — o que está certo, porque
 * ninguém de fora precisa chamá-las. Mas a matemática é a parte mais perigosa:
 * se o contrato calcular a saída de um swap de um jeito e o scanner de outro,
 * o scanner aprova ciclos que a execução reverte, ou pior, reprova ciclos bons.
 * É a mesma classe de defeito que já apareceu neste projeto quando o motor ao
 * vivo e o backtest liam parâmetros separados.
 *
 * Este arnês existe só para o teste executar o BYTECODE REAL e comparar com a
 * implementação em TypeScript. Não vai para a rede.
 */
contract MathHarness {
    function amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256) {
        uint256 amountInComTaxa = amountIn * 997;
        return (amountInComTaxa * reserveOut) / (reserveIn * 1000 + amountInComTaxa);
    }

    function amountIn(uint256 amountOut_, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256) {
        return (reserveIn * amountOut_ * 1000) / ((reserveOut - amountOut_) * 997) + 1;
    }
}
