// Arquivo: src/strategyParams.test.ts
//
// Estes testes protegem uma propriedade que não é sobre matemática, e sim
// sobre não operar às cegas: o motor ao vivo tem que usar EXATAMENTE os
// parâmetros que o backtest mediu.
//
// A falha real que motivou o arquivo: backtest e motor ao vivo liam as mesmas
// variáveis `BT_*` cada um por conta própria, e os padrões divergiram sem que
// nada quebrasse. O motor entrava com RSI < 45 enquanto a medição usava
// RSI < 30 — regra de entrada mais frouxa que a validada, valendo dinheiro
// real — e cobrava 0,1% de taxa onde a medição usava 0,075%. Nada lança nesse
// caso: o motor roda e o log parece saudável.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { PRESETS, resolverPreset, resolveStrategyParams, type ResolvedStrategyParams } from './strategyParams';

const BT_VARS = [
    'BT_RSI_PERIOD',
    'BT_RSI_THRESHOLD',
    'BT_BREAKOUT_LOOKBACK',
    'BT_ATR_PERIOD',
    'BT_ATR_STOP_MULT',
    'BT_TREND_PERIOD',
    'BT_RISK_FRACTION',
    'BT_TRAIL_FRACTION',
    'BT_TRAIL_ATR_MULT',
    'BT_FEE_RATE',
    'BT_MIN_NOTIONAL',
    'BT_MIN_VOLUME_RATIO',
    // Não é BT_*, mas muda os padrões que o resolvedor aplica — sem limpá-la
    // aqui, um teste herdaria o preset de outro e passaria por acidente.
    'DIRECTIONAL_PRESET',
];

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const saved = new Map(BT_VARS.map((k) => [k, process.env[k]]));
    try {
        for (const k of BT_VARS) delete process.env[k];
        for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
        return fn();
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('toda variável BT_* documentada é realmente lida', () => {
    // `BT_RSI_THRESHOLD` já esteve documentada e ignorada: o operador ajustava
    // o valor, o log não reclamava, e a estratégia rodava com outro número.
    // Valores propositalmente distintos dos padrões para que "ignorada"
    // apareça como igualdade ao padrão, não como coincidência.
    const params = withEnv(
        {
            BT_RSI_PERIOD: '9',
            BT_RSI_THRESHOLD: '25',
            BT_BREAKOUT_LOOKBACK: '33',
            BT_ATR_PERIOD: '7',
            BT_ATR_STOP_MULT: '1.5',
            BT_TREND_PERIOD: '80',
            BT_RISK_FRACTION: '0.05',
            BT_TRAIL_FRACTION: '0.12',
            BT_TRAIL_ATR_MULT: '4',
            BT_FEE_RATE: '0.0004',
            BT_MIN_NOTIONAL: '11',
        },
        () => resolveStrategyParams('reversion'),
    );

    assert.equal(params.rsiPeriod, 9);
    assert.equal(params.rsiThreshold.toString(), '25');
    assert.equal(params.breakoutLookback, 33);
    assert.equal(params.atrPeriod, 7);
    assert.equal(params.atrStopMultiplier.toString(), '1.5');
    assert.equal(params.trendPeriod, 80);
    assert.equal(params.riskFraction.toString(), '0.05');
    assert.equal(params.trailFraction.toString(), '0.12');
    assert.equal(params.trailAtrMultiplier.toString(), '4');
    assert.equal(params.feeRate.toString(), '0.0004');
    assert.equal(params.minNotional.toString(), '11');
});

test('os padrões são os que o backtest mediu — mudá-los invalida a medição', () => {
    // Não é teste de tautologia: estes números são o contrato entre o que foi
    // medido e o que opera. Alterar um padrão sem remedir é trocar a
    // estratégia validada por outra parecida, silenciosamente.
    const params = withEnv({}, () => resolveStrategyParams('reversion'));
    assert.equal(params.rsiThreshold.toString(), '30', 'RSI de entrada');
    assert.equal(params.feeRate.toString(), '0.00075', 'taker com desconto de BNB');
    assert.equal(params.riskFraction.toString(), '0.02', 'risco por operação');
    assert.equal(params.atrStopMultiplier.toString(), '2', 'stop em ATR');
    assert.equal(params.trailAtrMultiplier.toString(), '3', 'stop móvel em ATR');
    assert.equal(params.trendPeriod, 50, 'filtro de tendência');
});

test('a família de entrada é escolhida por quem chama, o resto é idêntico', () => {
    // Backtest e motor ao vivo diferem SÓ na família que estão avaliando.
    // Qualquer outra diferença significa que um dos dois não é o outro.
    const reversao = withEnv({}, () => resolveStrategyParams('reversion'));
    const rompimento = withEnv({}, () => resolveStrategyParams('breakout'));

    assert.equal(reversao.entryStrategy, 'reversion');
    assert.equal(rompimento.entryStrategy, 'breakout');

    const semFamilia = (p: ResolvedStrategyParams) => {
        const { entryStrategy: _ignorado, ...resto } = p;
        return JSON.stringify(resto, (_k, v) => (v instanceof Decimal ? v.toString() : v));
    };
    assert.equal(semFamilia(reversao), semFamilia(rompimento));
});

test('campos opcionais vêm sempre preenchidos, para o chamador não repetir padrões', () => {
    // Foi repetir padrão em dois lugares que produziu a divergência original.
    const params = withEnv({}, () => resolveStrategyParams('reversion'));
    for (const campo of ['entryStrategy', 'rsiPeriod', 'rsiThreshold', 'trailAtrMultiplier', 'minNotional'] as const) {
        assert.notEqual(params[campo], undefined, `${campo} não pode vir indefinido`);
    }
});

// ---------------------------------------------------------------------------
// Presets
//
// O preset troca os PADRÕES, nunca o que foi dito explicitamente. Se ele
// sobrescrevesse um `BT_*` informado, o operador ajustaria um valor, veria o
// log sem reclamação e rodaria com outro número — exatamente a falha que este
// arquivo existe para impedir, só que por outro caminho.
// ---------------------------------------------------------------------------

test('o preset agressivo dispara MUITO mais que o padrão, nos parâmetros que decidem frequência', () => {
    const padrao = withEnv({ DIRECTIONAL_PRESET: 'padrao' }, () => resolveStrategyParams('reversion'));
    const agressivo = withEnv({ DIRECTIONAL_PRESET: 'agressivo' }, () => resolveStrategyParams('reversion'));

    // RSI mais alto = compra correção comum em vez de esperar pânico.
    assert.ok(
        agressivo.rsiThreshold.greaterThan(padrao.rsiThreshold),
        `agressivo (${agressivo.rsiThreshold}) deveria exigir menos queda que padrão (${padrao.rsiThreshold})`,
    );
    // Máxima mais curta é rompida com mais frequência.
    assert.ok(agressivo.breakoutLookback! < padrao.breakoutLookback!);
    // Volume menor deixa passar movimento sem grande participação.
    assert.ok(agressivo.minVolumeRatio!.lessThan(padrao.minVolumeRatio!));
    // Risco maior só morde em ativo volátil, mas é onde ele morde.
    assert.ok(agressivo.riskFraction!.greaterThan(padrao.riskFraction!));
});

test('o preset agressivo DESLIGA o filtro de tendência — o destravador e o risco novo', () => {
    const agressivo = withEnv({ DIRECTIONAL_PRESET: 'agressivo' }, () => resolveStrategyParams('reversion'));
    // Zero é o que `backtest.ts` e `directionalLive.ts` interpretam como
    // "sem filtro". Qualquer outro valor manteria o filtro ligado em silêncio,
    // e o preset entregaria menos frequência do que promete.
    assert.equal(agressivo.trendPeriod, 0);

    const padrao = withEnv({ DIRECTIONAL_PRESET: 'padrao' }, () => resolveStrategyParams('reversion'));
    assert.ok(padrao.trendPeriod! > 0, 'o padrão mantém o filtro que segura o motor fora de mercado em queda');
});

test('um BT_* explícito GANHA do preset', () => {
    const params = withEnv(
        { DIRECTIONAL_PRESET: 'agressivo', BT_RSI_THRESHOLD: '25', BT_TREND_PERIOD: '200' },
        () => resolveStrategyParams('reversion'),
    );
    assert.equal(params.rsiThreshold.toString(), '25', 'o valor informado manda, não o do preset');
    assert.equal(params.trendPeriod, 200, 'dá para ligar o filtro de volta mesmo no preset agressivo');
    // O que NÃO foi informado continua vindo do preset.
    assert.equal(params.breakoutLookback, Number(PRESETS.agressivo.breakoutLookback));
});

test('sem DIRECTIONAL_PRESET o comportamento é o MEDIDO, não o agressivo', () => {
    // Padrão silencioso agressivo transformaria um deploy sem essa variável
    // numa mudança de estratégia que ninguém pediu.
    const semPreset = withEnv({}, () => resolveStrategyParams('reversion'));
    const padrao = withEnv({ DIRECTIONAL_PRESET: 'padrao' }, () => resolveStrategyParams('reversion'));
    assert.equal(semPreset.rsiThreshold.toString(), padrao.rsiThreshold.toString());
    assert.equal(semPreset.trendPeriod, padrao.trendPeriod);
});

test('preset inválido falha no boot em vez de cair no padrão em silêncio', () => {
    // Cair no padrão faria "agressivo" digitado errado rodar conservador, e o
    // operador concluiria que o preset não funciona.
    withEnv({ DIRECTIONAL_PRESET: 'agresssivo' }, () => {
        assert.throws(() => resolverPreset(), /DIRECTIONAL_PRESET inválido/);
    });
    // Espaço sobrando e maiúsculas num painel web são invisíveis: devem passar.
    const comRuido = withEnv({ DIRECTIONAL_PRESET: '  AGRESSIVO ' }, () => resolverPreset());
    assert.equal(comRuido.nome, 'agressivo');
});

test('o preset maximo é mais frouxo que o agressivo em tudo que decide frequência', () => {
    const agressivo = withEnv({ DIRECTIONAL_PRESET: 'agressivo' }, () => resolveStrategyParams('reversion'));
    const maximo = withEnv({ DIRECTIONAL_PRESET: 'maximo' }, () => resolveStrategyParams('reversion'));

    assert.ok(maximo.rsiThreshold.greaterThan(agressivo.rsiThreshold));
    assert.ok(maximo.breakoutLookback! < agressivo.breakoutLookback!);
    assert.ok(maximo.minVolumeRatio!.lessThan(agressivo.minVolumeRatio!));
    // Stop MAIS LARGO: dá espaço em vez de ser tirado por oscilação normal.
    // É a única mudança que reduz a frequência de saída em vez de aumentar a
    // de entrada — e aumenta a perda por operação errada.
    assert.ok(maximo.atrStopMultiplier!.greaterThan(agressivo.atrStopMultiplier!));
});

test('só o preset maximo mexe no stop; padrão e agressivo usam o mesmo', () => {
    // Apertar ou alargar o stop tem custo simétrico, então o `agressivo` não
    // toca nisso de propósito. Se um dia tocar, este teste avisa.
    const padrao = withEnv({ DIRECTIONAL_PRESET: 'padrao' }, () => resolveStrategyParams('reversion'));
    const agressivo = withEnv({ DIRECTIONAL_PRESET: 'agressivo' }, () => resolveStrategyParams('reversion'));
    assert.equal(agressivo.atrStopMultiplier!.toString(), padrao.atrStopMultiplier!.toString());
});
