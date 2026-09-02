// Arquivo: src/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { Decimal } from 'decimal.js';
import { TriangularArbitrageEngine } from './engine';
import { RiskManager } from './riskManager';
import { ExecutionResult, IExchangeProvider, OrderSide, OrderType } from './types';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

type OrderCall = { symbol: string; side: OrderSide; type: OrderType; qty: Decimal; price?: Decimal };

/** Provider falso, 100% síncrono/determinístico, para exercitar o engine sem rede. */
class FakeExchangeProvider extends EventEmitter implements IExchangeProvider {
    public calls: OrderCall[] = [];
    private feeRate = new Decimal('0.001');
    /** handler[callIndex] decide o resultado da N-ésima chamada de executeOrder (0-indexed). */
    constructor(private handlers: Array<(call: OrderCall) => ExecutionResult>) {
        super();
    }

    public async executeOrder(symbol: string, side: OrderSide, type: OrderType, qty: Decimal, price?: Decimal): Promise<ExecutionResult> {
        const call = { symbol, side, type, qty, price };
        const index = this.calls.length;
        this.calls.push(call);
        const handler = this.handlers[index];
        if (!handler) throw new Error(`FakeExchangeProvider: nenhum handler configurado para a chamada #${index}`);
        return handler(call);
    }

    public getFeeRate(): Decimal {
        return this.feeRate;
    }

    public pushTicker(symbol: string, bid: string, ask: string, ageMs = 0) {
        this.emit('ticker', { symbol, bid: new Decimal(bid), ask: new Decimal(ask), timestamp: Date.now() - ageMs });
    }
}

function fill(netProceeds: string, executedQty: string, price: string): ExecutionResult {
    return {
        orderId: 'test-order',
        status: 'FILLED',
        executedPrice: new Decimal(price),
        executedQty: new Decimal(executedQty),
        netProceeds: new Decimal(netProceeds),
        feePaid: new Decimal('0'),
        feePaidAsset: 'TEST',
        timestamp: Date.now(),
    };
}

function waitFor(emitter: EventEmitter, event: string): Promise<any> {
    return new Promise((resolve) => emitter.once(event, resolve));
}

test('dispara e completa um ciclo lucrativo quando o triângulo diverge', async () => {
    const exchange = new FakeExchangeProvider([
        () => fill('0.000832', '0.000833', '60010'), // leg1 BUY BTC/USDT
        () => fill('0.016597', '0.016614', '0.0501'), // leg2 BUY ETH/BTC
        () => fill('50.5', '0.016597', '3050'), // leg3 SELL ETH/USDT
    ]);
    const riskManager = new RiskManager('50', '0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, '50');

    const successPromise = waitFor(engine, 'cycle-success');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');

    const { profit, capital } = await successPromise;
    assert.ok(profit.greaterThan(0));
    assert.equal(capital.toString(), '50.5');
    assert.equal(exchange.calls.length, 3);
    assert.equal(exchange.calls[0].symbol, 'BTC/USDT');
    assert.equal(exchange.calls[0].side, 'BUY');
    assert.equal(exchange.calls[1].symbol, 'ETH/BTC');
    assert.equal(exchange.calls[2].symbol, 'ETH/USDT');
    assert.equal(exchange.calls[2].side, 'SELL');
    // Perna 2 deve pedir exatamente netProceeds(leg1) / p2Ask — sem nenhum haircut de taxa
    // adicional aplicado pelo engine (a taxa já foi contabilizada pelo provider em netProceeds).
    assert.equal(exchange.calls[1].qty.toString(), new Decimal('0.000832').dividedBy('0.0501').toString());
    // Perna 3 deve pedir exatamente netProceeds(leg2), sem nenhum ajuste adicional.
    assert.equal(exchange.calls[2].qty.toString(), '0.016597');
});

test('não dispara ciclo quando o book não tem ineficiência suficiente', async () => {
    const exchange = new FakeExchangeProvider([]);
    const riskManager = new RiskManager('50', '0.0005');
    new TriangularArbitrageEngine(exchange, riskManager, '50');

    // p3 = p1 * p2 (sem distorção) — não deve nem tentar executar nenhuma ordem.
    exchange.pushTicker('BTC/USDT', '60000', '60000');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0500');
    exchange.pushTicker('ETH/USDT', '3000', '3000');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(exchange.calls.length, 0);
});

test('ignora ticks obsoletos (kill switch de timestamp)', async () => {
    const exchange = new FakeExchangeProvider([]);
    const riskManager = new RiskManager('50', '0.0005');
    new TriangularArbitrageEngine(exchange, riskManager, '50');

    // Mesma ineficiência do teste de sucesso, mas com um tick "velho" (>100ms).
    exchange.pushTicker('BTC/USDT', '60000', '60010', 500);
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501', 500);
    exchange.pushTicker('ETH/USDT', '3050', '3060', 500);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(exchange.calls.length, 0);
});

test('unwind de emergência vende o ETH residual quando a perna 3 falha', async () => {
    const exchange = new FakeExchangeProvider([
        () => fill('0.000832', '0.000833', '60010'), // leg1 OK
        () => fill('0.016597', '0.016614', '0.0501'), // leg2 OK
        () => {
            throw new Error('rede caiu antes da perna 3 confirmar');
        },
        () => fill('49.9', '0.016597', '3049'), // unwind: vende o ETH residual
    ]);
    const riskManager = new RiskManager('50', '0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, '50');

    const failurePromise = waitFor(engine, 'cycle-failure');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');

    const { unwound } = await failurePromise;
    assert.equal(unwound, true);
    assert.equal(exchange.calls.length, 4);
    assert.equal(exchange.calls[3].symbol, 'ETH/USDT');
    assert.equal(exchange.calls[3].side, 'SELL');
    assert.equal(engine.getCurrentCapital().toString(), '49.9');
});

test('emite critical-exposure quando o próprio unwind falha', async () => {
    const exchange = new FakeExchangeProvider([
        () => fill('0.000832', '0.000833', '60010'), // leg1 OK
        () => {
            throw new Error('rede caiu antes da perna 2 confirmar');
        },
        () => {
            throw new Error('unwind também falhou — corretora fora do ar');
        },
    ]);
    const riskManager = new RiskManager('50', '0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, '50');

    const criticalPromise = waitFor(engine, 'critical-exposure');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');

    const { leg1, leg2 } = await criticalPromise;
    assert.ok(leg1);
    assert.equal(leg2, undefined);
    // Capital não deve ter sido atualizado, já que o unwind falhou.
    assert.equal(engine.getCurrentCapital().toString(), '50');
});
