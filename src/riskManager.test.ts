// Arquivo: src/riskManager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { RiskManager } from './riskManager';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

test('is viable quando a ineficiência supera custo + tolerância de slippage', () => {
    const rm = new RiskManager('50', '0.0005');
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
    const rm = new RiskManager('50', '0.0005');
    // p3 = p1 * p2 exatamente => sem lucro bruto, e a taxa ainda corrói o capital.
    const p1 = new Decimal('60000');
    const p2 = new Decimal('0.05');
    const p3 = p1.mul(p2); // 3000
    const result = rm.isTriangularArbitrageViable(new Decimal('50'), p1, p2, p3, new Decimal('0.001'));
    assert.equal(result.viable, false);
    assert.ok(result.expectedNetProfit.lessThan(0));
});

test('rejeita capital acima do limite alocado', () => {
    const rm = new RiskManager('50', '0.0005');
    const result = rm.isTriangularArbitrageViable(
        new Decimal('51'), // acima do maxCapitalAllocated
        new Decimal('60010'),
        new Decimal('0.0501'),
        new Decimal('3050'),
        new Decimal('0.001')
    );
    assert.equal(result.viable, false);
    assert.equal(result.expectedNetProfit.toString(), '0');
});

test('kill switch de sanidade: preço zero ou negativo nunca é viável', () => {
    const rm = new RiskManager('50', '0.0005');
    for (const badPrice of [new Decimal('0'), new Decimal('-1')]) {
        const result = rm.isTriangularArbitrageViable(new Decimal('50'), badPrice, new Decimal('0.0501'), new Decimal('3050'), new Decimal('0.001'));
        assert.equal(result.viable, false);
    }
});

test('taxa mais alta reduz (ou elimina) a viabilidade da mesma ineficiência', () => {
    const rm = new RiskManager('50', '0.0005');
    const args = [new Decimal('50'), new Decimal('60010'), new Decimal('0.0501'), new Decimal('3050')] as const;
    const lowFee = rm.isTriangularArbitrageViable(...args, new Decimal('0.001'));
    const highFee = rm.isTriangularArbitrageViable(...args, new Decimal('0.02')); // 2% por perna — inviável
    assert.equal(lowFee.viable, true);
    assert.equal(highFee.viable, false);
    assert.ok(highFee.expectedNetProfit.lessThan(lowFee.expectedNetProfit));
});
