// Arquivo: src/fundingRate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    annualizeFundingRate,
    notionalPerLegForCapital,
    projectCarry,
    roundTripCost,
    summarizeFundingHistory,
} from './fundingRate';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const FEES = {
    spotTakerFee: new Decimal('0.00075'), // com desconto de BNB
    futuresTakerFee: new Decimal('0.0005'),
};

test('anualiza a taxa de funding sem compor (funding vira caixa, não reinveste)', () => {
    // 0,01% a cada 8h => 3x/dia => 0,03%/dia => 10,95%/ano
    assert.equal(annualizeFundingRate(new Decimal('0.0001')).toString(), '0.1095');
});

test('anualização preserva o sinal: funding negativo projeta perda anual', () => {
    assert.equal(annualizeFundingRate(new Decimal('-0.0001')).toString(), '-0.1095');
});

test('capital exigido é o dobro do notional de uma perna (spot + margem do perp)', () => {
    // O erro clássico é assumir que $50 de capital carregam $50 de notional;
    // carregam $25, porque os dois lados precisam existir ao mesmo tempo.
    assert.equal(notionalPerLegForCapital(new Decimal('50')).toString(), '25');
});

test('custo de ida e volta cobre as QUATRO execuções (abrir e fechar os dois lados)', () => {
    // notional 100, (0.00075 + 0.0005) por abertura/fechamento, x2
    const cost = roundTripCost(new Decimal('100'), FEES);
    assert.equal(cost.toString(), '0.25');
});

test('projeção com $50 e funding típico de 0,01%/8h', () => {
    const p = projectCarry(new Decimal('50'), annualizeFundingRate(new Decimal('0.0001')), FEES);
    assert.equal(p.notionalPerLeg.toString(), '25');
    // 25 * 0.1095 = 2.7375/ano bruto
    assert.equal(p.grossAnnualFunding.toString(), '2.7375');
    // 25 * 0.00125 * 2 = 0.0625 de ida e volta
    assert.equal(p.roundTripCost.toString(), '0.0625');
    assert.equal(p.netAnnualProfit.toString(), '2.675');
});

test('retorno líquido é fração do capital TOTAL, não do notional', () => {
    const p = projectCarry(new Decimal('50'), annualizeFundingRate(new Decimal('0.0001')), FEES);
    assert.equal(p.netAnnualReturnFraction.toString(), p.netAnnualProfit.dividedBy(50).toString());
});

test('funding negativo => projeção negativa e sem ponto de equilíbrio', () => {
    // Não mascarar com zero: carry sob funding negativo é perda real, e é
    // exatamente o risco que decide se a estratégia se sustenta.
    const p = projectCarry(new Decimal('50'), annualizeFundingRate(new Decimal('-0.0001')), FEES);
    assert.ok(p.netAnnualProfit.lessThan(0));
    assert.equal(p.breakEvenDays, null, 'sem funding positivo o custo nunca se paga');
});

test('breakEvenDays: dias de funding só para cobrir a montagem da posição', () => {
    const p = projectCarry(new Decimal('50'), annualizeFundingRate(new Decimal('0.0001')), FEES);
    // 0.0625 de custo / (2.7375/365 por dia) ≈ 8.3 dias
    assert.ok(p.breakEvenDays!.greaterThan(8) && p.breakEvenDays!.lessThan(9));
});

test('o retorno percentual NÃO melhora com escala — só o valor absoluto', () => {
    // Distinção que decide a estratégia: escalar capital não cria vantagem,
    // só torna a mesma vantagem grande o bastante para importar.
    const rate = annualizeFundingRate(new Decimal('0.0001'));
    const pequeno = projectCarry(new Decimal('50'), rate, FEES);
    const grande = projectCarry(new Decimal('5000'), rate, FEES);

    assert.equal(
        pequeno.netAnnualReturnFraction.toFixed(10),
        grande.netAnnualReturnFraction.toFixed(10),
        'a fração de retorno é invariante ao capital',
    );
    assert.ok(grande.netAnnualProfit.greaterThan(pequeno.netAnnualProfit.mul(99)));
});

test('capital zero não quebra a projeção', () => {
    const p = projectCarry(new Decimal('0'), annualizeFundingRate(new Decimal('0.0001')), FEES);
    assert.equal(p.netAnnualReturnFraction.toString(), '0');
});

// --- Histórico -------------------------------------------------------------

test('histórico vazio devolve null (sem amostra não há estatística)', () => {
    assert.equal(summarizeFundingHistory([]), null);
});

test('resume média, mínimo, máximo e com que frequência ficou negativo', () => {
    const stats = summarizeFundingHistory([
        new Decimal('0.0001'),
        new Decimal('0.0003'),
        new Decimal('-0.0001'),
        new Decimal('0.0001'),
    ])!;
    assert.equal(stats.samples, 4);
    assert.equal(stats.meanRate.toString(), '0.0001');
    assert.equal(stats.minRate.toString(), '-0.0001');
    assert.equal(stats.maxRate.toString(), '0.0003');
    assert.equal(stats.negativeFraction.toString(), '0.25');
});

test('negativeFraction é o sinal de risco: funding sempre negativo => 1', () => {
    const stats = summarizeFundingHistory([new Decimal('-0.0001'), new Decimal('-0.0002')])!;
    assert.equal(stats.negativeFraction.toString(), '1');
    assert.ok(stats.meanRate.lessThan(0));
});
