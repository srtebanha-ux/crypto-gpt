// Arquivo: src/opportunityStats.test.ts
//
// O censo de oportunidades existe para desambiguar "o robô ficou parado":
// mercado que não ofereceu nada vs. oportunidade real barrada por um gate.
// Estes testes fixam essa distinção — em especial que a medição é um CENSO
// (conta toda avaliação, inclusive as barradas pelo gate estatístico), porque
// medir só o que passou pelo gate seria cego exatamente para o caso que mais
// importa diagnosticar.
//
// Todos os cenários rodam com o gate estatístico fechado de propósito: assim
// nenhum ciclo chega a executar, e o que se observa é puramente a medição.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { Decimal } from 'decimal.js';
import { TriangularArbitrageEngine } from './engine';
import { RiskManager } from './riskManager';
import { ExecutionResult, IExchangeProvider, OrderSide, OrderType } from './types';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const TRIANGLE = { id: 'USDT-BTC-ETH', leg1: 'BTC/USDT', leg2: 'ETH/BTC', leg3: 'ETH/USDT' };

/** Stub mínimo: só alimenta ticker, nunca executa ordem (o gate fica fechado). */
class TickerOnlyProvider extends EventEmitter implements IExchangeProvider {
    private feeRate = new Decimal('0.001');

    public async executeOrder(
        _symbol: string,
        _side: OrderSide,
        _type: OrderType,
        _qty: Decimal,
        _price?: Decimal,
    ): Promise<ExecutionResult> {
        throw new Error('nenhum ciclo deveria executar nestes testes — o gate estatístico está fechado');
    }

    public getFeeRate(): Decimal {
        return this.feeRate;
    }

    public pushTicker(symbol: string, bid: string, ask: string) {
        this.emit('ticker', { symbol, bid: new Decimal(bid), ask: new Decimal(ask), timestamp: Date.now() });
    }
}

/** statMinSamples altíssimo => gate estatístico sempre fechado, nada executa. */
function buildEngine(capital = '1000') {
    const exchange = new TickerOnlyProvider();
    const engine = new TriangularArbitrageEngine(exchange, new RiskManager('0.0005'), [TRIANGLE], capital, {
        statMinSamples: 1_000_000,
        statZThreshold: new Decimal('3'),
        maxTickAgeMs: new Decimal('100'),
    });
    return { engine, exchange };
}

/**
 * Alimenta as três pernas. Na primeira chamada só a última perna completa o
 * book, então rende 1 avaliação; depois disso cada perna empurrada rende mais uma.
 */
function seed(exchange: TickerOnlyProvider, p1: string, p2: string, p3: string) {
    exchange.pushTicker('BTC/USDT', p1, p1);
    exchange.pushTicker('ETH/BTC', p2, p2);
    exchange.pushTicker('ETH/USDT', p3, p3);
}

test('janela sem avaliação nenhuma: censo zerado e sem melhor margem', () => {
    const { engine } = buildEngine();
    const stats = engine.takeOpportunityStats();
    assert.equal(stats.evaluations, 0);
    assert.equal(stats.bestNetProfit, null);
    assert.equal(stats.bestNetMarginFraction, null);
    assert.equal(stats.bestTriangleId, null);
});

test('book incompleto não entra no censo (não houve avaliação de verdade)', () => {
    const { engine, exchange } = buildEngine();
    exchange.pushTicker('BTC/USDT', '60000', '60000');
    exchange.pushTicker('ETH/BTC', '0.05', '0.05');

    assert.equal(engine.takeOpportunityStats().evaluations, 0, 'faltando a 3a perna, não há o que medir');
});

test('conta a avaliação MESMO com o gate estatístico barrando (censo, não amostra filtrada)', () => {
    const { engine, exchange } = buildEngine();
    seed(exchange, '60000', '0.05', '3000');

    const stats = engine.takeOpportunityStats();
    assert.equal(stats.evaluations, 1, 'a avaliação precisa entrar no censo');
    assert.equal(stats.statGatePassed, 0, 'e ficar registrada como barrada pelo gate estatístico');
    assert.notEqual(stats.bestNetProfit, null, 'a margem tem que ser medida mesmo com o gate fechado');
});

test('mercado alinhado: melhor margem é negativa (nem cobre as três taxas)', () => {
    const { engine, exchange } = buildEngine();
    // 60000 * 0.05 = 3000 => retorno bruto exatamente igual ao capital;
    // as três taxas de 0,1% levam o líquido para baixo de zero.
    seed(exchange, '60000', '0.05', '3000');

    const stats = engine.takeOpportunityStats();
    assert.ok(stats.bestNetProfit!.lessThan(0), 'sem desalinhamento o líquido tem que ser negativo');
    assert.ok(stats.bestNetMarginFraction!.lessThan(0));
});

test('desalinhamento a favor produz margem líquida positiva medida', () => {
    const { engine, exchange } = buildEngine();
    seed(exchange, '60000', '0.05', '3060'); // saída 2% acima do alinhamento

    const stats = engine.takeOpportunityStats();
    assert.ok(stats.bestNetProfit!.greaterThan(0));
    assert.equal(stats.bestTriangleId, 'USDT-BTC-ETH');
});

test('guarda o MELHOR da janela, não o último', () => {
    const { engine, exchange } = buildEngine();
    seed(exchange, '60000', '0.05', '3000'); // 1a avaliação: alinhado
    exchange.pushTicker('ETH/USDT', '3060', '3060'); // 2a: bom
    exchange.pushTicker('ETH/USDT', '2900', '2900'); // 3a: pior

    const stats = engine.takeOpportunityStats();
    assert.equal(stats.evaluations, 3);
    assert.ok(
        stats.bestNetProfit!.greaterThan(0),
        'o pico da janela precisa sobreviver aos ticks piores que vêm depois dele',
    );
});

test('takeOpportunityStats zera a janela (a próxima mede só o período seguinte)', () => {
    const { engine, exchange } = buildEngine();
    seed(exchange, '60000', '0.05', '3000');
    assert.equal(engine.takeOpportunityStats().evaluations, 1);

    const segunda = engine.takeOpportunityStats();
    assert.equal(segunda.evaluations, 0, 'sem zerar, um pico antigo contaminaria todas as janelas seguintes');
    assert.equal(segunda.bestNetProfit, null);
});

test('margem é fração do capital — comparável direto com MAX_SLIPPAGE', () => {
    const { engine, exchange } = buildEngine('1000');
    seed(exchange, '60000', '0.05', '3060');

    const stats = engine.takeOpportunityStats();
    assert.equal(stats.bestNetMarginFraction!.toString(), stats.bestNetProfit!.dividedBy(1000).toString());
});
