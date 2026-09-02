// Arquivo: src/live.test.ts
//
// Testes de unidade puros para a lógica de configuração de src/live.ts —
// nenhum deles chama connect()/bootstrap() nem toca rede. Antes desta
// suíte, live.ts não tinha nenhum teste: bootstrap() rodava incondicionalmente
// ao importar o módulo, então qualquer `import` (mesmo de teste) tentava
// conectar de verdade. Guardado agora com `if (require.main === module)`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequiredNumberEnv, resolveEngineConfig, resolveIntermediateBases, resolveLiveMode } from './live';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const original: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) original[key] = process.env[key];
    try {
        for (const [key, value] of Object.entries(vars)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        return fn();
    } finally {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('parseRequiredNumberEnv aceita número válido', () => {
    assert.equal(parseRequiredNumberEnv('X', '20'), 20);
    assert.equal(parseRequiredNumberEnv('X', '0.05'), 0.05);
});

test('parseRequiredNumberEnv lança erro claro para entrada malformada em vez de retornar NaN silenciosamente', () => {
    // Regressão: Number("20,000") é NaN, e comparações contra NaN são
    // sempre false — usado ingenuamente em STAT_MIN_SAMPLES, isso travaria
    // o kill switch estatístico para sempre, sem nenhum erro no log.
    assert.throws(() => parseRequiredNumberEnv('STAT_MIN_SAMPLES', '20,000'), /STAT_MIN_SAMPLES inválido/);
    assert.throws(() => parseRequiredNumberEnv('X', 'abc'), /não é um número/);
    assert.throws(() => parseRequiredNumberEnv('X', '1.2.3'), /não é um número/);
});

test('resolveEngineConfig propaga STAT_MIN_SAMPLES válido e lança erro para malformado', () => {
    withEnv({ STAT_MIN_SAMPLES: '30' }, () => {
        assert.equal(resolveEngineConfig().statMinSamples, 30);
    });
    withEnv({ STAT_MIN_SAMPLES: '20,000' }, () => {
        assert.throws(() => resolveEngineConfig(), /STAT_MIN_SAMPLES inválido/);
    });
});

test('resolveEngineConfig omite campos cujas env vars não foram definidas (engine usa seus próprios padrões)', () => {
    withEnv({ STAT_MIN_SAMPLES: undefined, STAT_Z_THRESHOLD: undefined, RATIO_EWMA_ALPHA: undefined, MAX_DRAWDOWN_FRACTION: undefined }, () => {
        assert.deepEqual(resolveEngineConfig(), {});
    });
});

test('resolveEngineConfig lança erro claro (Decimal) para STAT_Z_THRESHOLD/RATIO_EWMA_ALPHA/MAX_DRAWDOWN_FRACTION malformados', () => {
    withEnv({ STAT_Z_THRESHOLD: 'not-a-number' }, () => {
        assert.throws(() => resolveEngineConfig());
    });
});

test('resolveIntermediateBases faz parse, normaliza maiúsculas e remove espaços', () => {
    assert.deepEqual(
        withEnv({ TRIANGLE_BASES: ' btc, eth ,BNB' }, () => resolveIntermediateBases()),
        ['BTC', 'ETH', 'BNB']
    );
});

test('resolveIntermediateBases retorna undefined quando a env var não está definida (BinanceExchangeProvider usa seu próprio padrão)', () => {
    withEnv({ TRIANGLE_BASES: undefined }, () => {
        assert.equal(resolveIntermediateBases(), undefined);
    });
});

test('resolveLiveMode retorna false por padrão (testnet) sem BINANCE_LIVE', () => {
    withEnv({ BINANCE_LIVE: undefined, BINANCE_LIVE_CONFIRM: undefined }, () => {
        assert.equal(resolveLiveMode(), false);
    });
});

test('resolveLiveMode exige BINANCE_LIVE_CONFIRM exato quando BINANCE_LIVE=true — gate de segurança contra dinheiro real por acidente', () => {
    withEnv({ BINANCE_LIVE: 'true', BINANCE_LIVE_CONFIRM: undefined }, () => {
        assert.throws(() => resolveLiveMode(), /BINANCE_LIVE_CONFIRM/);
    });
    withEnv({ BINANCE_LIVE: 'true', BINANCE_LIVE_CONFIRM: 'sim eu confirmo' }, () => {
        assert.throws(() => resolveLiveMode(), /BINANCE_LIVE_CONFIRM/);
    });
    withEnv({ BINANCE_LIVE: 'true', BINANCE_LIVE_CONFIRM: 'I_UNDERSTAND_THE_RISK' }, () => {
        assert.equal(resolveLiveMode(), true);
    });
});
