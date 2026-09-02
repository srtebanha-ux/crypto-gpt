// Arquivo: src/engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { Decimal } from 'decimal.js';
import { TriangularArbitrageEngine } from './engine';
import { RiskManager } from './riskManager';
import { ExecutionResult, IExchangeProvider, OrderBookSnapshot, OrderSide, OrderType } from './types';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const TEST_TRIANGLE = { id: 'USDT-BTC-ETH', leg1: 'BTC/USDT', leg2: 'ETH/BTC', leg3: 'ETH/USDT' };

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
    const riskManager = new RiskManager('0.0005');
    // statMinSamples: 0 — este teste cobre a execução do ciclo, não o kill
    // switch estatístico (coberto em teste dedicado abaixo).
    const engine = new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50', { statMinSamples: 0 });

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
    // As 3 pernas de ENTRADA usam LIMIT (a Binance real envia timeInForce=FOK
    // pra elas — ver binanceExchangeProvider.ts) em vez de MARKET, pra nunca
    // preencher a um preço pior que o já confirmado pelos kill switches.
    assert.ok(
        exchange.calls.every((c) => c.type === 'LIMIT'),
        'as 3 pernas de entrada devem usar LIMIT (FOK na Binance real), não MARKET'
    );
    // Perna 2 deve pedir exatamente netProceeds(leg1) / p2Ask — sem nenhum haircut de taxa
    // adicional aplicado pelo engine (a taxa já foi contabilizada pelo provider em netProceeds).
    assert.equal(exchange.calls[1].qty.toString(), new Decimal('0.000832').dividedBy('0.0501').toString());
    // Perna 3 deve pedir exatamente netProceeds(leg2), sem nenhum ajuste adicional.
    assert.equal(exchange.calls[2].qty.toString(), '0.016597');
});

test('não dispara ciclo quando o book não tem ineficiência suficiente', async () => {
    const exchange = new FakeExchangeProvider([]);
    const riskManager = new RiskManager('0.0005');
    new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50');

    // p3 = p1 * p2 (sem distorção) — não deve nem tentar executar nenhuma ordem.
    exchange.pushTicker('BTC/USDT', '60000', '60000');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0500');
    exchange.pushTicker('ETH/USDT', '3000', '3000');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(exchange.calls.length, 0);
});

test('ignora ticks obsoletos (kill switch de timestamp)', async () => {
    const exchange = new FakeExchangeProvider([]);
    const riskManager = new RiskManager('0.0005');
    new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50');

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
    const riskManager = new RiskManager('0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50', { statMinSamples: 0 });

    const failurePromise = waitFor(engine, 'cycle-failure');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');

    const { unwound } = await failurePromise;
    assert.equal(unwound, true);
    assert.equal(exchange.calls.length, 4);
    assert.equal(exchange.calls[3].symbol, 'ETH/USDT');
    assert.equal(exchange.calls[3].side, 'SELL');
    // Pernas de entrada usam LIMIT, mas o unwind é deliberadamente MARKET —
    // prioriza certeza de saída sobre proteção de preço (ver comentário em
    // emergencyUnwind).
    assert.equal(exchange.calls[0].type, 'LIMIT');
    assert.equal(exchange.calls[1].type, 'LIMIT');
    assert.equal(exchange.calls[3].type, 'MARKET', 'o unwind deve usar MARKET, não LIMIT/FOK, para garantir a saída');
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
    const riskManager = new RiskManager('0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50', { statMinSamples: 0 });

    const criticalPromise = waitFor(engine, 'critical-exposure');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');

    const { leg1, leg2 } = await criticalPromise;
    assert.ok(leg1);
    assert.equal(leg2, undefined);
    // Capital não deve ter sido atualizado, já que o unwind falhou.
    assert.equal(engine.getCurrentCapital().toString(), '50');

    // A partir daqui o engine deve estar halted permanentemente: mesmo uma
    // nova ineficiência claramente lucrativa não deve disparar mais nada —
    // se disparasse, executeOrder chamaria um 4º handler inexistente e
    // lançaria "nenhum handler configurado".
    assert.equal(engine.isHalted(), true);
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(exchange.calls.length, 3, 'nenhuma nova ordem deveria ser enviada após a parada permanente');
});

test('kill switch estatístico bloqueia o disparo durante o warm-up (amostras insuficientes)', async () => {
    const exchange = new FakeExchangeProvider([]);
    const riskManager = new RiskManager('0.0005');
    // statMinSamples muito alto: mesmo com a MESMA ineficiência claramente
    // lucrativa do teste de sucesso, o gate estatístico nunca terá amostras
    // suficientes de linha de base para liberar o disparo nesta janela de teste.
    new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50', { statMinSamples: 1000 });

    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(exchange.calls.length, 0, 'sem linha de base suficiente, o gate estatístico deve bloquear mesmo uma ineficiência real');
});

/** Extensão do fake para testar o kill switch de profundidade (getOrderBookSnapshot é opcional na interface). */
class FakeDepthExchangeProvider extends FakeExchangeProvider {
    private snapshots = new Map<string, OrderBookSnapshot>();

    public setSnapshot(symbol: string, snapshot: OrderBookSnapshot) {
        this.snapshots.set(symbol, snapshot);
    }

    public getOrderBookSnapshot(symbol: string): OrderBookSnapshot | undefined {
        return this.snapshots.get(symbol);
    }
}

function snapshot(levels: Array<[string, string]>): OrderBookSnapshot {
    const book = levels.map(([price, qty]) => ({ price: new Decimal(price), qty: new Decimal(qty) }));
    return { bids: book, asks: book, timestamp: Date.now() };
}

test('kill switch de profundidade bloqueia quando o book real não sustenta o ciclo', async () => {
    const exchange = new FakeDepthExchangeProvider([]);
    // Profundidade irrisória em todos os 3 pares — muito abaixo do que os $50 exigiriam.
    exchange.setSnapshot('BTC/USDT', snapshot([['60010', '0.00000001']]));
    exchange.setSnapshot('ETH/BTC', snapshot([['0.0501', '0.00000001']]));
    exchange.setSnapshot('ETH/USDT', snapshot([['3050', '0.00000001']]));

    const riskManager = new RiskManager('0.0005');
    new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50', { statMinSamples: 0 });

    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(exchange.calls.length, 0, 'topo do book favorável não deveria disparar quando a profundidade real não sustenta o ciclo');
});

test('kill switch de profundidade libera o disparo quando o book real sustenta o ciclo', async () => {
    const exchange = new FakeDepthExchangeProvider([
        () => fill('0.000832', '0.000833', '60010'),
        () => fill('0.016597', '0.016614', '0.0501'),
        () => fill('50.5', '0.016597', '3050'),
    ]);
    exchange.setSnapshot('BTC/USDT', snapshot([['60010', '10']]));
    exchange.setSnapshot('ETH/BTC', snapshot([['0.0501', '100']]));
    exchange.setSnapshot('ETH/USDT', snapshot([['3050', '10']]));

    const riskManager = new RiskManager('0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50', { statMinSamples: 0 });

    const successPromise = waitFor(engine, 'cycle-success');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');

    await successPromise;
    assert.equal(exchange.calls.length, 3);
});

test('circuit breaker de drawdown halta o engine após perdas acumuladas além do limite', async () => {
    const exchange = new FakeExchangeProvider([
        // Ciclo 1: capital 50 -> 47 (perda de 3, dentro do limite de 10% = piso 45)
        () => fill('0.0008', '0.0008', '60010'),
        () => fill('0.016', '0.016', '0.0501'),
        () => fill('47', '0.016', '3050'),
        // Ciclo 2: capital 47 -> 44 (< piso de 45 -> deve acionar o circuit breaker)
        () => fill('0.0008', '0.0008', '60010'),
        () => fill('0.016', '0.016', '0.0501'),
        () => fill('44', '0.016', '3050'),
    ]);
    const riskManager = new RiskManager('0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, [TEST_TRIANGLE], '50', { statMinSamples: 0, maxDrawdownFraction: new Decimal('0.10') });

    const firstSuccess = waitFor(engine, 'cycle-success');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');
    await firstSuccess;

    assert.equal(engine.getCurrentCapital().toString(), '47');
    assert.equal(engine.isHalted(), false, 'perda de 6% ainda está dentro do limite de 10% de drawdown');

    const circuitBreakerPromise = waitFor(engine, 'circuit-breaker-triggered');
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');

    const { initialCapital, currentCapital, drawdownFraction } = await circuitBreakerPromise;
    assert.equal(initialCapital.toString(), '50');
    assert.equal(currentCapital.toString(), '44');
    assert.ok(drawdownFraction.greaterThan('0.10'));
    assert.equal(engine.isHalted(), true);

    // Halted permanentemente: uma nova ineficiência não deve disparar mais nada.
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(exchange.calls.length, 6, 'nenhuma nova ordem deveria ser enviada após o circuit breaker');
});

// ============================================================================
// MULTI-TRIÂNGULO: mutex global entre triângulos diferentes + isolamento do
// EwmaTracker por triângulo. Ver o cabeçalho da classe em engine.ts — capital,
// circuit breaker e o mutex de execução são deliberadamente GLOBAIS (nunca
// duplicados/divididos entre triângulos), pois é isso que preserva "zero
// alavancagem" ao monitorar vários triângulos ao mesmo tempo.
// ============================================================================
const TRIANGLE_A = { id: 'A', leg1: 'BTC/USDT', leg2: 'ETH/BTC', leg3: 'ETH/USDT' };
const TRIANGLE_B = { id: 'B', leg1: 'BNB/USDT', leg2: 'SOL/BNB', leg3: 'SOL/USDT' };

function pushTriangleA(exchange: FakeExchangeProvider) {
    exchange.pushTicker('BTC/USDT', '60000', '60010');
    exchange.pushTicker('ETH/BTC', '0.0500', '0.0501');
    exchange.pushTicker('ETH/USDT', '3050', '3060');
}

function pushTriangleB(exchange: FakeExchangeProvider) {
    exchange.pushTicker('BNB/USDT', '299.85', '300');
    exchange.pushTicker('SOL/BNB', '0.0995', '0.1');
    exchange.pushTicker('SOL/USDT', '30.45', '30.55');
}

test('mutex global impede execução simultânea entre triângulos diferentes (sem alavancagem: nunca duas execuções em voo ao mesmo tempo)', async () => {
    const exchange = new FakeExchangeProvider([
        () => fill('0.000832', '0.000833', '60010'), // A leg1
        () => fill('0.016597', '0.016614', '0.0501'), // A leg2
        () => fill('50.5', '0.016597', '3050'), // A leg3
        () => fill('0.5', '0.5', '300'), // B leg1
        () => fill('5', '5', '0.1'), // B leg2
        () => fill('51', '5', '30.45'), // B leg3
    ]);
    const riskManager = new RiskManager('0.0005');
    const engine = new TriangularArbitrageEngine(exchange, riskManager, [TRIANGLE_A, TRIANGLE_B], '50', { statMinSamples: 0 });

    const successA = waitFor(engine, 'cycle-success');

    // Dispara A; na MESMA sequência síncrona, B também teria uma ineficiência
    // real (mesma magnitude de divergência de A), mas o mutex global
    // (isExecutingCycle) deve bloqueá-lo enquanto A ainda está em voo.
    pushTriangleA(exchange);
    pushTriangleB(exchange);

    await successA;
    assert.equal(exchange.calls.length, 3, 'B não deveria ter disparado nenhuma ordem enquanto A ainda estava em execução');
    assert.equal(exchange.calls[0].symbol, 'BTC/USDT');

    const successB = waitFor(engine, 'cycle-success');
    // Reenvia os ticks de B com timestamp fresco (os anteriores podem já
    // estar obsoletos pelo kill switch de idade após a espera de A).
    pushTriangleB(exchange);
    await successB;

    assert.equal(exchange.calls.length, 6, 'depois que A libera o mutex global, B deve conseguir disparar seu próprio ciclo');
    assert.equal(exchange.calls[3].symbol, 'BNB/USDT');
});

test('EwmaTracker por triângulo é isolado: o warm-up de um nunca conta para o kill switch estatístico de outro', async () => {
    const exchange = new FakeExchangeProvider([
        () => fill('0.000832', '0.000833', '60010'), // A leg1
        () => fill('0.016597', '0.016614', '0.0501'), // A leg2
        () => fill('50.5', '0.016597', '3050'), // A leg3
    ]);
    const riskManager = new RiskManager('0.0005');
    // statMinSamples=2: cada triângulo precisa de 2 amostras JÁ incorporadas
    // ao SEU PRÓPRIO EwmaTracker antes do kill switch estatístico liberar
    // qualquer disparo. Se os trackers fossem compartilhados entre
    // triângulos (a regressão que este teste previne), o warm-up de B
    // contaria para o gate de A e vice-versa, e A dispararia cedo demais.
    // statZThreshold=0: cada tick reenvia a MESMA razão (mesmo preço), então
    // a partir da 2ª amostra x==mean sempre (diff=0) e zScore fica travado em
    // 0 — 0 >= 0 sempre passa, isolando o teste para depender só da contagem
    // de amostras (comportamento do zScore em si já é coberto em
    // statistics.test.ts e no teste de warm-up estatístico acima).
    const engine = new TriangularArbitrageEngine(exchange, riskManager, [TRIANGLE_A, TRIANGLE_B], '50', {
        statMinSamples: 2,
        statZThreshold: new Decimal(0),
    });

    pushTriangleA(exchange); // toque #1 do tracker de A (contagem própria: 0 -> 1)
    pushTriangleB(exchange); // toque #1 do tracker de B (contagem própria: 0 -> 1)
    exchange.pushTicker('ETH/USDT', '3050', '3060'); // toque #2 de A (contagem própria: 1 -> 2)
    exchange.pushTicker('SOL/USDT', '30.45', '30.55'); // toque #2 de B (contagem própria: 1 -> 2)
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
        exchange.calls.length,
        0,
        'nenhum dos dois deveria disparar ainda — nenhum triângulo tem 2 amostras PRÓPRIAS incorporadas (se os trackers fossem compartilhados, o total de 4 toques já teria liberado o disparo aqui)'
    );

    const successA = waitFor(engine, 'cycle-success');
    exchange.pushTicker('ETH/USDT', '3050', '3060'); // toque #3 de A: sampleCountBeforeUpdate=2 >= statMinSamples -> libera
    await successA;

    assert.equal(exchange.calls.length, 3, 'apenas o ciclo de A deveria ter disparado');
    assert.equal(exchange.calls[0].symbol, 'BTC/USDT');
});
