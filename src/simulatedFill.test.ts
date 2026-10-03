// Arquivo: src/simulatedFill.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { simulateNetFill } from './simulatedFill';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

test('BUY: netProceeds líquido no ativo-base, feePaid no ativo-base', () => {
    const result = simulateNetFill('BTC/USDT', 'BUY', new Decimal('0.001'), new Decimal('60010'), new Decimal('0.001'));
    assert.equal(result.netProceeds.toString(), '0.000999'); // 0.001 * (1 - 0.001)
    assert.equal(result.feePaid.toString(), '0.000001');
    assert.equal(result.feePaidAsset, 'BTC');
});

test('SELL: netProceeds líquido no ativo-cotação, feePaid no ativo-cotação', () => {
    const result = simulateNetFill('ETH/USDT', 'SELL', new Decimal('0.0166'), new Decimal('3050'), new Decimal('0.001'));
    const grossQuote = new Decimal('0.0166').mul('3050'); // 50.63
    assert.equal(result.netProceeds.toString(), grossQuote.mul('0.999').toString());
    assert.equal(result.feePaidAsset, 'USDT');
});

test('taxa zero => netProceeds igual ao valor bruto, feePaid zero', () => {
    const buy = simulateNetFill('BTC/USDT', 'BUY', new Decimal('1'), new Decimal('100'), new Decimal('0'));
    assert.equal(buy.netProceeds.toString(), '1');
    assert.equal(buy.feePaid.toString(), '0');

    const sell = simulateNetFill('BTC/USDT', 'SELL', new Decimal('1'), new Decimal('100'), new Decimal('0'));
    assert.equal(sell.netProceeds.toString(), '100');
    assert.equal(sell.feePaid.toString(), '0');
});
