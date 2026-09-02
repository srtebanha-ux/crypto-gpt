// Arquivo: src/binanceExchangeProvider.test.ts
//
// Testes de unidade puros: nenhuma chamada de rede real acontece aqui.
// `fetch` é substituído por um stub local por teste, e `connect()` (que
// abriria WebSocket real) nunca é chamado — os filtros de símbolo são
// injetados diretamente para exercitar `executeOrder` isoladamente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { BinanceExchangeProvider, parseDepthLevels } from './binanceExchangeProvider';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

function jsonResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'test-status',
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function newProvider(): BinanceExchangeProvider {
    return new BinanceExchangeProvider({ apiKey: 'test-key', apiSecret: 'test-secret', live: false });
}

function seedFilters(
    provider: BinanceExchangeProvider,
    symbol: string,
    filters: { stepSize: string; minQty: string; minNotional: string }
): void {
    (provider as unknown as { symbolFilters: Map<string, unknown> }).symbolFilters.set(symbol, {
        stepSize: new Decimal(filters.stepSize),
        minQty: new Decimal(filters.minQty),
        minNotional: new Decimal(filters.minNotional),
    });
}

async function withFetchStub<T>(impl: (url: string, init?: unknown) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl as typeof fetch;
    try {
        return await fn();
    } finally {
        globalThis.fetch = original;
    }
}

test('BUY: netProceeds desconta a comissão cobrada no ativo-base recebido', async () => {
    const provider = newProvider();
    seedFilters(provider, 'BTCUSDT', { stepSize: '0.000001', minQty: '0.00001', minNotional: '10' });

    const result = await withFetchStub(
        async () =>
            jsonResponse(200, {
                orderId: 1,
                status: 'FILLED',
                executedQty: '0.001000',
                cummulativeQuoteQty: '60.01',
                transactTime: 1700000000000,
                fills: [{ commission: '0.000001', commissionAsset: 'BTC' }],
            }),
        () => provider.executeOrder('BTC/USDT', 'BUY', 'MARKET', new Decimal('0.001'), new Decimal('60010'))
    );

    assert.equal(result.status, 'FILLED');
    assert.equal(result.executedQty.toString(), '0.001');
    assert.equal(result.netProceeds.toString(), '0.000999'); // 0.001 - 0.000001
    assert.equal(result.feePaidAsset, 'BTC');
    assert.equal(result.feePaid.toString(), '0.000001');
});

test('SELL: netProceeds desconta a comissão cobrada no ativo-cotação recebido', async () => {
    const provider = newProvider();
    seedFilters(provider, 'ETHUSDT', { stepSize: '0.0001', minQty: '0.001', minNotional: '10' });

    const result = await withFetchStub(
        async () =>
            jsonResponse(200, {
                orderId: 2,
                status: 'FILLED',
                executedQty: '0.0166',
                cummulativeQuoteQty: '50.63',
                fills: [{ commission: '0.05063', commissionAsset: 'USDT' }],
            }),
        () => provider.executeOrder('ETH/USDT', 'SELL', 'MARKET', new Decimal('0.0166'), new Decimal('3050'))
    );

    assert.equal(result.netProceeds.toString(), '50.57937'); // 50.63 - 0.05063
    assert.equal(result.feePaidAsset, 'USDT');
});

test('comissão paga em outro ativo (ex.: desconto BNB) não reduz netProceeds', async () => {
    const provider = newProvider();
    seedFilters(provider, 'BTCUSDT', { stepSize: '0.000001', minQty: '0.00001', minNotional: '10' });

    const result = await withFetchStub(
        async () =>
            jsonResponse(200, {
                orderId: 5,
                status: 'FILLED',
                executedQty: '0.001',
                cummulativeQuoteQty: '60.01',
                fills: [{ commission: '0.002', commissionAsset: 'BNB' }],
            }),
        () => provider.executeOrder('BTC/USDT', 'BUY', 'MARKET', new Decimal('0.001'), new Decimal('60010'))
    );

    assert.equal(result.netProceeds.toString(), '0.001');
    assert.equal(result.feePaidAsset, 'BNB');
    assert.equal(result.feePaid.toString(), '0.002');
});

test('rejeita a ordem antes de chamar a rede quando a quantidade fica abaixo do minQty', async () => {
    const provider = newProvider();
    seedFilters(provider, 'BTCUSDT', { stepSize: '0.000001', minQty: '0.01', minNotional: '10' });

    let fetchCalls = 0;
    await assert.rejects(
        () =>
            withFetchStub(
                async () => {
                    fetchCalls += 1;
                    return jsonResponse(200, {});
                },
                () => provider.executeOrder('BTC/USDT', 'BUY', 'MARKET', new Decimal('0.0001'), new Decimal('60010'))
            ),
        /abaixo do minQty/
    );
    assert.equal(fetchCalls, 0);
});

test('rejeita a ordem antes de chamar a rede quando o notional estimado fica abaixo do minNotional', async () => {
    const provider = newProvider();
    seedFilters(provider, 'BTCUSDT', { stepSize: '0.000001', minQty: '0.00001', minNotional: '100' });

    let fetchCalls = 0;
    await assert.rejects(
        () =>
            withFetchStub(
                async () => {
                    fetchCalls += 1;
                    return jsonResponse(200, {});
                },
                () => provider.executeOrder('BTC/USDT', 'BUY', 'MARKET', new Decimal('0.001'), new Decimal('60010'))
            ),
        /abaixo do minNotional/
    );
    assert.equal(fetchCalls, 0);
});

test('arredonda a quantidade para baixo conforme o stepSize antes de enviar', async () => {
    const provider = newProvider();
    seedFilters(provider, 'BTCUSDT', { stepSize: '0.001', minQty: '0.001', minNotional: '1' });

    let sentQuantity: string | null = null;
    await withFetchStub(
        async (url) => {
            sentQuantity = new URL(url).searchParams.get('quantity');
            return jsonResponse(200, { orderId: 3, status: 'FILLED', executedQty: sentQuantity, cummulativeQuoteQty: '0', fills: [] });
        },
        () => provider.executeOrder('BTC/USDT', 'BUY', 'MARKET', new Decimal('0.0019'), new Decimal('60010'))
    );

    assert.equal(sentQuantity, '0.001'); // 0.0019 truncado para o múltiplo de stepSize (0.001)
});

test('lança erro quando a ordem não é preenchida (ex.: IOC expirada)', async () => {
    const provider = newProvider();
    seedFilters(provider, 'BTCUSDT', { stepSize: '0.000001', minQty: '0.00001', minNotional: '1' });

    await assert.rejects(
        () =>
            withFetchStub(
                async () => jsonResponse(200, { orderId: 4, status: 'EXPIRED', executedQty: '0', cummulativeQuoteQty: '0', fills: [] }),
                () => provider.executeOrder('BTC/USDT', 'BUY', 'LIMIT', new Decimal('0.001'), new Decimal('60010'))
            ),
        /não preenchida/
    );
});

test('lança erro claro quando a corretora rejeita a ordem (HTTP não-ok)', async () => {
    const provider = newProvider();
    seedFilters(provider, 'BTCUSDT', { stepSize: '0.000001', minQty: '0.00001', minNotional: '1' });

    await assert.rejects(
        () =>
            withFetchStub(
                async () => jsonResponse(400, { msg: 'Insufficient balance.', code: -2010 }),
                () => provider.executeOrder('BTC/USDT', 'BUY', 'MARKET', new Decimal('0.001'), new Decimal('60010'))
            ),
        /Insufficient balance/
    );
});

test('parseDepthLevels converte pares [preço, qty] crus e descarta entradas inválidas', () => {
    const levels = parseDepthLevels([
        ['60010.5', '0.5'],
        ['60011.0', '1.2'],
        ['60012.0', '0'], // qty zero — descartado (remoção de nível em streams de diff)
        ['bad', '1'], // preço não numérico — descartado, não deve derrubar o parsing dos demais níveis
    ]);
    assert.equal(levels.length, 2);
    assert.equal(levels[0].price.toString(), '60010.5');
    assert.equal(levels[0].qty.toString(), '0.5');
});

test('parseDepthLevels retorna [] para entradas malformadas ou payload não-array', () => {
    assert.deepEqual(parseDepthLevels(undefined), []);
    assert.deepEqual(parseDepthLevels(null), []);
    assert.deepEqual(parseDepthLevels('not-an-array'), []);
    assert.deepEqual(parseDepthLevels([['100']]), []); // par incompleto
});

test('getOrderBookSnapshot retorna undefined antes de qualquer mensagem de profundidade, e o snapshot depois', () => {
    const provider = newProvider();
    assert.equal(provider.getOrderBookSnapshot('BTC/USDT'), undefined);

    // Simula a chegada de uma mensagem de profundidade sem abrir um WS real.
    (provider as unknown as { handleDepthUpdate: (stream: string, data: unknown) => void }).handleDepthUpdate('btcusdt@depth5@100ms', {
        bids: [['60000', '1.5']],
        asks: [['60010', '2.0']],
    });

    const snapshot = provider.getOrderBookSnapshot('BTC/USDT');
    assert.ok(snapshot);
    assert.equal(snapshot!.bids[0].price.toString(), '60000');
    assert.equal(snapshot!.asks[0].price.toString(), '60010');
    assert.equal(provider.getOrderBookSnapshot('ETH/BTC'), undefined);
});
