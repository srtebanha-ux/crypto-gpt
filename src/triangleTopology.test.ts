// Arquivo: src/triangleTopology.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnginePairTriangles, buildTriangles, SymbolInfo } from './triangleTopology';

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

test('buildTriangles descobre múltiplos triângulos reais quando várias bases intermediárias estão disponíveis', () => {
    const symbols: SymbolInfo[] = [
        sym('BTCUSDT', 'BTC', 'USDT'),
        sym('ETHUSDT', 'ETH', 'USDT'),
        sym('ETHBTC', 'ETH', 'BTC'),
        sym('BNBUSDT', 'BNB', 'USDT'),
        sym('SOLUSDT', 'SOL', 'USDT'),
        sym('SOLBNB', 'SOL', 'BNB'),
    ];

    const triangles = buildTriangles(symbols, ['BTC', 'BNB']);

    assert.equal(triangles.length, 2);
    const ids = triangles.map((t) => t.id).sort();
    assert.deepEqual(ids, ['USDT-BNB-SOL', 'USDT-BTC-ETH']);
});

test('buildEnginePairTriangles gera os MESMOS triângulos (mesmos ids) que buildTriangles, só que em formato de par', () => {
    const symbols: SymbolInfo[] = [
        sym('BTCUSDT', 'BTC', 'USDT'),
        sym('ETHUSDT', 'ETH', 'USDT'),
        sym('ETHBTC', 'ETH', 'BTC'),
        sym('BNBUSDT', 'BNB', 'USDT'),
        sym('SOLUSDT', 'SOL', 'USDT'),
        sym('SOLBNB', 'SOL', 'BNB'),
    ];

    const raw = buildTriangles(symbols, ['BTC', 'BNB']);
    const pairs = buildEnginePairTriangles(symbols, ['BTC', 'BNB']);

    assert.deepEqual(
        pairs.map((t) => t.id).sort(),
        raw.map((t) => t.id).sort()
    );

    const usdtBtcEth = pairs.find((t) => t.id === 'USDT-BTC-ETH');
    assert.deepEqual(usdtBtcEth, { id: 'USDT-BTC-ETH', leg1: 'BTC/USDT', leg2: 'ETH/BTC', leg3: 'ETH/USDT' });
});

test('buildEnginePairTriangles monta o par a partir de baseAsset/quoteAsset reais, não por concatenação de string', () => {
    // WBETH/WBTC (ambos com nomes de ativo mais longos que o símbolo de 3 letras
    // usual) — se a conversão adivinhasse o split base/quote a partir do texto
    // cru do símbolo, arriscaria cortar no lugar errado. Usando baseAsset/quoteAsset
    // reais isso nunca é ambíguo.
    const symbols: SymbolInfo[] = [
        sym('WBETHUSDT', 'WBETH', 'USDT'),
        sym('WBTCUSDT', 'WBTC', 'USDT'),
        sym('WBETHWBTC', 'WBETH', 'WBTC'),
    ];

    const pairs = buildEnginePairTriangles(symbols, ['WBTC']);
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0], { id: 'USDT-WBTC-WBETH', leg1: 'WBTC/USDT', leg2: 'WBETH/WBTC', leg3: 'WBETH/USDT' });
});
