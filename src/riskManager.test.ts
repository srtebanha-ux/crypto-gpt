// Arquivo: src/riskManager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { RiskManager } from './riskManager';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

test('is viable quando a ineficiência supera custo + tolerância de slippage', () => {
    const rm = new RiskManager('0.0005');
    const result = rm.isTriangularArbitrageViable(
        new Decimal('50'),
        new Decimal('60010'), // p1Ask
        new Decimal('0.0501'), // p2Ask
        new Decimal('3050'), // p3Bid (distorcido para cima)
        new Decimal('0.001')
    );
    assert.equal(result.viable, true);
    assert.ok(result.expectedNetProfit.greaterThan(0));
});

test('não é viável quando o triângulo está em equilíbrio (sem ineficiência)', () => {
    const rm = new RiskManager('0.0005');
    // p3 = p1 * p2 exatamente => sem lucro bruto, e a taxa ainda corrói o capital.
    const p1 = new Decimal('60000');
    const p2 = new Decimal('0.05');
    const p3 = p1.mul(p2); // 3000
    const result = rm.isTriangularArbitrageViable(new Decimal('50'), p1, p2, p3, new Decimal('0.001'));
    assert.equal(result.viable, false);
    assert.ok(result.expectedNetProfit.lessThan(0));
});

test('capital maior que o inicial ainda é viável (regressão: RiskManager não tem mais teto fixo de capital)', () => {
    // Uma versão anterior guardava um "maxCapitalAllocated" fixado no
    // capital passado ao construtor, e rejeitava qualquer avaliação cujo
    // capital atual o superasse. Como o engine sempre chama isso com o
    // capital ATUAL (que cresce após qualquer ciclo lucrativo), isso
    // travava o robô permanentemente depois do primeiro sucesso — achado
    // rodando uma simulação de vários dias, não por um teste unitário de
    // ciclo único. Este teste garante que capital crescido não é
    // penalizado: mesmas condições de mercado, capitais diferentes, ambos
    // devem ser viáveis (o resultado só muda em escala, não em veredito).
    const rm = new RiskManager('0.0005');
    const args = [new Decimal('60010'), new Decimal('0.0501'), new Decimal('3050'), new Decimal('0.001')] as const;
    const original = rm.isTriangularArbitrageViable(new Decimal('50'), ...args);
    const grown = rm.isTriangularArbitrageViable(new Decimal('75'), ...args); // 50% maior que o "capital inicial"
    assert.equal(original.viable, true);
    assert.equal(grown.viable, true);
    assert.ok(grown.expectedNetProfit.greaterThan(original.expectedNetProfit), 'mais capital deployado na mesma ineficiência deve gerar mais lucro absoluto');
});

test('kill switch de sanidade: preço zero ou negativo nunca é viável', () => {
    const rm = new RiskManager('0.0005');
    for (const badPrice of [new Decimal('0'), new Decimal('-1')]) {
        const result = rm.isTriangularArbitrageViable(new Decimal('50'), badPrice, new Decimal('0.0501'), new Decimal('3050'), new Decimal('0.001'));
        assert.equal(result.viable, false);
    }
});

test('taxa mais alta reduz (ou elimina) a viabilidade da mesma ineficiência', () => {
    const rm = new RiskManager('0.0005');
    const args = [new Decimal('50'), new Decimal('60010'), new Decimal('0.0501'), new Decimal('3050')] as const;
    const lowFee = rm.isTriangularArbitrageViable(...args, new Decimal('0.001'));
    const highFee = rm.isTriangularArbitrageViable(...args, new Decimal('0.02')); // 2% por perna — inviável
    assert.equal(lowFee.viable, true);
    assert.equal(highFee.viable, false);
    assert.ok(highFee.expectedNetProfit.lessThan(lowFee.expectedNetProfit));
});

function bookLevel(price: string, qty: string) {
    return { price: new Decimal(price), qty: new Decimal(qty) };
}

test('isTriangularArbitrageViableWithDepth concorda com a versão top-of-book quando há liquidez de sobra', () => {
    const rm = new RiskManager('0.0005');
    const flat = rm.isTriangularArbitrageViable(new Decimal('50'), new Decimal('60010'), new Decimal('0.0501'), new Decimal('3050'), new Decimal('0.001'));
    const depth = rm.isTriangularArbitrageViableWithDepth(
        new Decimal('50'),
        [bookLevel('60010', '10')], // 10 BTC de profundidade — muito acima do que $50 compraria
        [bookLevel('0.0501', '100')],
        [bookLevel('3050', '10')],
        new Decimal('0.001')
    );
    assert.equal(depth.viable, true);
    assert.equal(depth.fullyFilled, true);
    // Mesma liquidez == mesmo preço em todos os níveis => lucro projetado deve bater (dentro de arredondamento).
    assert.ok(depth.expectedNetProfit.minus(flat.expectedNetProfit).abs().lessThan('0.000001'));
});

test('isTriangularArbitrageViableWithDepth bloqueia quando a profundidade real não sustenta o ciclo', () => {
    const rm = new RiskManager('0.0005');
    const result = rm.isTriangularArbitrageViableWithDepth(
        new Decimal('50'),
        [bookLevel('60010', '0.00000001')], // profundidade irrisória no nível 1
        [bookLevel('0.0501', '100')],
        [bookLevel('3050', '10')],
        new Decimal('0.001')
    );
    assert.equal(result.fullyFilled, false);
    assert.equal(result.viable, false);
});

test('isTriangularArbitrageViableWithDepth bloqueia quando caminhar níveis piores estoura o orçamento', () => {
    const rm = new RiskManager('0.0005');
    // Só 0.0003 BTC no topo (~$18) — para preencher a quantidade-alvo
    // aproximada por $50/60010, o restante precisa caminhar para um nível
    // pior (60050), o que gasta mais do que os $50 orçados na perna 1.
    const thin = rm.isTriangularArbitrageViableWithDepth(
        new Decimal('50'),
        [bookLevel('60010', '0.0003'), bookLevel('60050', '10')],
        [bookLevel('0.0501', '100')],
        [bookLevel('3050', '10')],
        new Decimal('0.001')
    );
    assert.equal(thin.fullyFilled, false, 'gastar mais que o capital orçado para preencher a quantidade-alvo deve marcar fullyFilled=false');
    assert.equal(thin.viable, false);

    // Com profundidade de sobra em 60010, a mesma quantidade-alvo cabe
    // inteira no orçamento de $50 e o ciclo volta a ser viável.
    const deep = rm.isTriangularArbitrageViableWithDepth(
        new Decimal('50'),
        [bookLevel('60010', '10')],
        [bookLevel('0.0501', '100')],
        [bookLevel('3050', '10')],
        new Decimal('0.001')
    );
    assert.equal(deep.fullyFilled, true);
    assert.equal(deep.viable, true);
});
