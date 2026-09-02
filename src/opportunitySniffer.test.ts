// Arquivo: src/opportunitySniffer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { buildTriangles, evaluateTriangle, SymbolInfo } from './opportunitySniffer';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

function sym(symbol: string, baseAsset: string, quoteAsset: string): SymbolInfo {
    return { symbol, baseAsset, quoteAsset };
}

test('buildTriangles só inclui triângulos cujos TRÊS lados existem como par real listado', () => {
    const symbols: SymbolInfo[] = [
        sym('BTCUSDT', 'BTC', 'USDT'),
        sym('ETHUSDT', 'ETH', 'USDT'),
        sym('ETHBTC', 'ETH', 'BTC'), // ETH/BTC listado -> triângulo USDT-BTC-ETH é válido
        sym('WIFUSDT', 'WIF', 'USDT'),
        // WIF/BTC NÃO está listado -> não deve gerar um triângulo USDT-BTC-WIF
    ];

    const triangles = buildTriangles(symbols, ['BTC']);

    assert.equal(triangles.length, 1);
    assert.deepEqual(triangles[0], { id: 'USDT-BTC-ETH', leg1: 'BTCUSDT', leg2: 'ETHBTC', leg3: 'ETHUSDT' });
});

test('buildTriangles ignora bases intermediárias que não têm par XXXUSDT listado', () => {
    const symbols: SymbolInfo[] = [sym('ETHBNB', 'ETH', 'BNB'), sym('ETHUSDT', 'ETH', 'USDT')];
    // Sem BNBUSDT listado, não há como fechar USDT -> BNB.
    const triangles = buildTriangles(symbols, ['BNB']);
    assert.equal(triangles.length, 0);
});

test('buildTriangles nunca usa USDT como ativo intermediário da 2ª perna', () => {
    const symbols: SymbolInfo[] = [sym('BTCUSDT', 'BTC', 'USDT'), sym('USDTBTC', 'USDT', 'BTC')]; // hipotético/degenerado
    const triangles = buildTriangles(symbols, ['BTC']);
    assert.equal(triangles.length, 0, 'um par com baseAsset=USDT não deveria virar a "perna 2" de um triângulo');
});

const triangle = { id: 'USDT-BTC-ETH', leg1: 'BTCUSDT', leg2: 'ETHBTC', leg3: 'ETHUSDT' };
const retentionCubed = new Decimal(1).minus('0.001').pow(3);
const requiredGrossSpread = new Decimal(1).plus('0.0002').dividedBy(retentionCubed);

function tick(bid: string, ask: string): { bid: Decimal; ask: Decimal; timestamp: number } {
    return { bid: new Decimal(bid), ask: new Decimal(ask), timestamp: Date.now() };
}

test('evaluateTriangle detecta a mesma ineficiência clássica usada nos testes do RiskManager', () => {
    const result = evaluateTriangle(
        triangle,
        tick('60000', '60010'), // BTC/USDT
        tick('0.0500', '0.0501'), // ETH/BTC
        tick('3050', '3060'), // ETH/USDT (distorcido)
        retentionCubed,
        requiredGrossSpread
    );
    assert.ok(result);
    assert.equal(result!.isOpportunity, true);
    assert.ok(result!.netProfitPct.greaterThan(0));
});

test('evaluateTriangle não marca oportunidade quando o triângulo está em equilíbrio', () => {
    const p1 = new Decimal('60000');
    const p2 = new Decimal('0.05');
    const p3 = p1.mul(p2); // sem distorção
    const result = evaluateTriangle(triangle, tick('59990', p1.toString()), tick('0.0499', p2.toString()), tick(p3.toString(), '3001'), retentionCubed, requiredGrossSpread);
    assert.ok(result);
    assert.equal(result!.isOpportunity, false);
});

test('evaluateTriangle retorna null para preço não positivo (kill switch de sanidade)', () => {
    const result = evaluateTriangle(triangle, tick('0', '0'), tick('0.0500', '0.0501'), tick('3050', '3060'), retentionCubed, requiredGrossSpread);
    assert.equal(result, null);
});

test('requiredGrossSpread usa a fórmula exata (1+alvo)/retenção³, não a aproximação aditiva alvo+atrito', () => {
    // Fórmula exata: (1 + 0.0002) / (1 - 0.001)^3 - 1 ≈ 0.320661% (verificado também
    // de forma independente em Python: (1.0002/0.997002999 - 1) * 100).
    // A aproximação aditiva ingênua (0.02% + 0.2997% de atrito ≈ 0.3197%) SUBESTIMA
    // o valor real por ignorar o termo de segunda ordem da composição — a diferença é
    // pequena aqui, mas é exatamente o tipo de arredondamento que se acumula em produção.
    assert.equal(requiredGrossSpread.minus(1).mul(100).toFixed(4), '0.3206');
});
