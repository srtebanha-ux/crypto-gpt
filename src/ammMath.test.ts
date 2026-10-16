// Arquivo: src/ammMath.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    cycleSpotRatio,
    evaluateCycle,
    findOptimalCycleInput,
    getAmountOut,
    grossCycleProfit,
    simulateCycle,
    spotPrice,
    type Hop,
} from './ammMath';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const FEE = new Decimal('0.003'); // 0,3%, padrão Uniswap V2

function hop(reserveIn: string, reserveOut: string, fee = FEE): Hop {
    return { reserveIn: new Decimal(reserveIn), reserveOut: new Decimal(reserveOut), feeFraction: fee };
}

// --- getAmountOut -----------------------------------------------------------

test('getAmountOut: confere com a fórmula de referência do Uniswap V2', () => {
    // Referência V2 em inteiros: out = (in*997*rOut) / (rIn*1000 + in*997)
    const amountIn = new Decimal('1000');
    const rIn = new Decimal('1000000');
    const rOut = new Decimal('2000000');
    const esperado = amountIn.mul(997).mul(rOut).dividedBy(rIn.mul(1000).plus(amountIn.mul(997)));

    const obtido = getAmountOut(amountIn, { reserveIn: rIn, reserveOut: rOut, feeFraction: FEE });
    assert.equal(obtido.toFixed(10), esperado.toFixed(10));
});

test('getAmountOut: entrada zero ou negativa devolve zero', () => {
    assert.equal(getAmountOut(new Decimal('0'), hop('1000', '1000')).toString(), '0');
    assert.equal(getAmountOut(new Decimal('-5'), hop('1000', '1000')).toString(), '0');
});

test('getAmountOut: pool sem reserva devolve zero em vez de dividir por zero', () => {
    assert.equal(getAmountOut(new Decimal('100'), hop('0', '1000')).toString(), '0');
    assert.equal(getAmountOut(new Decimal('100'), hop('1000', '0')).toString(), '0');
});

test('getAmountOut: saída sempre menor que a proporção sem slippage (slippage existe)', () => {
    const semSlippage = new Decimal('1000'); // 1:1 nas reservas
    const comSlippage = getAmountOut(new Decimal('1000'), hop('10000', '10000'));
    assert.ok(comSlippage.lessThan(semSlippage));
});

test('getAmountOut: quanto maior a entrada, pior o preço médio (curva côncava)', () => {
    const pequeno = getAmountOut(new Decimal('100'), hop('100000', '100000'));
    const grande = getAmountOut(new Decimal('10000'), hop('100000', '100000'));
    const precoMedioPequeno = pequeno.dividedBy(100);
    const precoMedioGrande = grande.dividedBy(10000);
    assert.ok(precoMedioGrande.lessThan(precoMedioPequeno));
});

// --- Ciclo ------------------------------------------------------------------

test('ciclo em pools equilibrados dá prejuízo (as taxas comem tudo)', () => {
    // Dois pools na mesma proporção: não há ineficiência, só taxa.
    const hops = [hop('1000000', '1000000'), hop('1000000', '1000000')];
    assert.ok(grossCycleProfit(new Decimal('1000'), hops).lessThan(0));
});

test('ciclo com desalinhamento real entre pools dá lucro bruto', () => {
    // Pool 1: 1 A vale 1 B. Pool 2: 1 B vale 1.05 A => ineficiência de 5%.
    const hops = [hop('1000000', '1000000'), hop('1000000', '1050000')];
    assert.ok(grossCycleProfit(new Decimal('1000'), hops).greaterThan(0));
});

test('simulateCycle encadeia: saída de um hop é entrada do próximo', () => {
    const h1 = hop('1000000', '2000000');
    const h2 = hop('2000000', '1000000');
    const passo1 = getAmountOut(new Decimal('1000'), h1);
    const passo2 = getAmountOut(passo1, h2);
    assert.equal(simulateCycle(new Decimal('1000'), [h1, h2]).toString(), passo2.toString());
});

// --- Otimização -------------------------------------------------------------

test('findOptimalCycleInput bate com a varredura por força bruta', () => {
    // A garantia que importa: a busca ternária realmente acha o máximo.
    // Um ótimo errado não lança exceção — devolve um número plausível e
    // errado, que é o pior modo de falha possível aqui.
    const hops = [hop('1000000', '1000000'), hop('1000000', '1050000')];
    const teto = new Decimal('100000');

    let melhorForca = new Decimal(0);
    for (let i = 1; i <= 2000; i++) {
        const tentativa = teto.mul(i).dividedBy(2000);
        const lucro = grossCycleProfit(tentativa, hops);
        if (lucro.greaterThan(melhorForca)) melhorForca = lucro;
    }

    const otimo = findOptimalCycleInput(hops, teto);
    // A força bruta é grosseira; o ótimo real nunca pode ser PIOR que ela.
    assert.ok(otimo.grossProfit.greaterThanOrEqualTo(melhorForca.mul('0.999')));
});

test('sem ineficiência, o ótimo é ZERO e não um valor minúsculo com lucro negativo', () => {
    const hops = [hop('1000000', '1000000'), hop('1000000', '1000000')];
    const otimo = findOptimalCycleInput(hops, new Decimal('100000'));
    assert.equal(otimo.amountIn.toString(), '0');
    assert.equal(otimo.grossProfit.toString(), '0');
});

test('o ótimo respeita o teto de entrada (liquidez disponível do flash loan)', () => {
    const hops = [hop('100000000', '100000000'), hop('100000000', '200000000')];
    const teto = new Decimal('500');
    const otimo = findOptimalCycleInput(hops, teto);
    assert.ok(otimo.amountIn.lessThanOrEqualTo(teto));
});

test('entrada além do ótimo destrói o lucro (confirma que existe máximo)', () => {
    const hops = [hop('1000000', '1000000'), hop('1000000', '1050000')];
    const otimo = findOptimalCycleInput(hops, new Decimal('1000000'));
    const exagerado = grossCycleProfit(otimo.amountIn.mul(10), hops);
    assert.ok(exagerado.lessThan(otimo.grossProfit));
});

// --- Custos reais -----------------------------------------------------------

test('gas transforma oportunidade real em inexecutável (o piso de tamanho)', () => {
    // Desalinhamento de 1% — acima dos 0,6% de taxa dos dois hops, então a
    // oportunidade é genuína. O gas é ancorado no lucro medido em vez de um
    // valor chutado: o que o teste precisa fixar é que um custo FIXO maior
    // que o lucro inverte a decisão, não uma magnitude específica.
    const hops = [hop('1000000', '1000000'), hop('1000000', '1010000')];
    const semCusto = { flashLoanFeeFraction: new Decimal('0'), gasCostInToken: new Decimal('0') };
    const semGas = evaluateCycle(hops, new Decimal('100000'), semCusto);
    assert.ok(semGas.profitable, 'a ineficiência supera as taxas dos pools');

    const gasMaiorQueLucro = semGas.grossProfit.mul(2);
    const comGas = evaluateCycle(hops, new Decimal('100000'), {
        flashLoanFeeFraction: new Decimal('0'),
        gasCostInToken: gasMaiorQueLucro,
    });

    assert.ok(!comGas.profitable, 'mas não paga o gas — e é o líquido que decide');
    assert.equal(
        comGas.netProfit.toString(),
        semGas.netProfit.minus(gasMaiorQueLucro).toString(),
        'o gas entra como custo fixo, sem alterar o tamanho ótimo',
    );
});

test('taxa do flash loan entra sobre o valor emprestado, não sobre o lucro', () => {
    const hops = [hop('1000000', '1000000'), hop('1000000', '1050000')];
    const aave = evaluateCycle(hops, new Decimal('100000'), {
        flashLoanFeeFraction: new Decimal('0.0005'),
        gasCostInToken: new Decimal('0'),
    });
    assert.equal(aave.flashLoanFee.toString(), aave.amountIn.mul('0.0005').toString());
    assert.equal(aave.netProfit.toString(), aave.grossProfit.minus(aave.flashLoanFee).toString());
});

test('Balancer (taxa zero) rende mais que Aave no mesmo ciclo', () => {
    const hops = [hop('1000000', '1000000'), hop('1000000', '1050000')];
    const custoGas = { gasCostInToken: new Decimal('1') };
    const balancer = evaluateCycle(hops, new Decimal('100000'), {
        flashLoanFeeFraction: new Decimal('0'),
        ...custoGas,
    });
    const aave = evaluateCycle(hops, new Decimal('100000'), {
        flashLoanFeeFraction: new Decimal('0.0005'),
        ...custoGas,
    });
    assert.ok(balancer.netProfit.greaterThan(aave.netProfit));
});

// --- Filtro rápido ----------------------------------------------------------

test('spotPrice é reserveOut/reserveIn e não quebra com reserva zero', () => {
    assert.equal(spotPrice(hop('1000', '2000')).toString(), '2');
    assert.equal(spotPrice(hop('0', '2000')).toString(), '0');
});

test('cycleSpotRatio <= 1 em pools equilibrados (as taxas garantem isso)', () => {
    const hops = [hop('1000000', '1000000'), hop('1000000', '1000000')];
    assert.ok(cycleSpotRatio(hops).lessThan(1));
});

test('cycleSpotRatio > 1 exatamente quando existe ciclo lucrativo', () => {
    // O filtro barato precisa concordar com a otimização cara, senão descarta
    // oportunidade real antes de ela ser avaliada.
    const lucrativo = [hop('1000000', '1000000'), hop('1000000', '1050000')];
    const perdedor = [hop('1000000', '1000000'), hop('1000000', '1000100')];

    assert.ok(cycleSpotRatio(lucrativo).greaterThan(1));
    assert.ok(findOptimalCycleInput(lucrativo, new Decimal('100000')).grossProfit.greaterThan(0));

    assert.ok(cycleSpotRatio(perdedor).lessThan(1));
    assert.equal(findOptimalCycleInput(perdedor, new Decimal('100000')).grossProfit.toString(), '0');
});
