// Arquivo: src/marketMicrostructure.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { estimateVwapFill } from './marketMicrostructure';
import { OrderBookLevel } from './types';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

function level(price: string, qty: string): OrderBookLevel {
    return { price: new Decimal(price), qty: new Decimal(qty) };
}

test('preenchimento integral em um único nível => avgPrice == preço do nível', () => {
    const levels = [level('100', '5')];
    const result = estimateVwapFill(levels, new Decimal('2'));
    assert.equal(result.avgPrice.toString(), '100');
    assert.equal(result.filledQty.toString(), '2');
    assert.equal(result.fullyFilled, true);
});

test('caminha múltiplos níveis e calcula o VWAP ponderado corretamente', () => {
    // 3 no nível 100, 3 no nível 101, 10 no nível 105 — pedindo 5.
    const levels = [level('100', '3'), level('101', '3'), level('105', '10')];
    const result = estimateVwapFill(levels, new Decimal('5'));
    // 3*100 + 2*101 = 300 + 202 = 502; 502/5 = 100.4
    assert.equal(result.avgPrice.toString(), '100.4');
    assert.equal(result.filledQty.toString(), '5');
    assert.equal(result.fullyFilled, true);
});

test('profundidade insuficiente => fullyFilled=false e filledQty menor que o alvo', () => {
    const levels = [level('100', '1'), level('101', '1')];
    const result = estimateVwapFill(levels, new Decimal('10'));
    assert.equal(result.filledQty.toString(), '2');
    assert.equal(result.fullyFilled, false);
    // 1*100 + 1*101 = 201; 201/2 = 100.5
    assert.equal(result.avgPrice.toString(), '100.5');
});

test('book vazio => nada preenchido, fullyFilled=false', () => {
    const result = estimateVwapFill([], new Decimal('1'));
    assert.equal(result.filledQty.toString(), '0');
    assert.equal(result.fullyFilled, false);
    assert.equal(result.avgPrice.toString(), '0');
});

test('targetQty zero ou negativo => trivialmente preenchido, sem consumir níveis', () => {
    const levels = [level('100', '5')];
    for (const qty of ['0', '-1']) {
        const result = estimateVwapFill(levels, new Decimal(qty));
        assert.equal(result.filledQty.toString(), '0');
        assert.equal(result.fullyFilled, true);
    }
});

test('ignora níveis com preço ou quantidade não positivos', () => {
    const levels = [level('100', '0'), level('0', '5'), level('101', '3')];
    const result = estimateVwapFill(levels, new Decimal('2'));
    assert.equal(result.avgPrice.toString(), '101');
    assert.equal(result.filledQty.toString(), '2');
});
