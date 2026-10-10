// Arquivo: src/monteCarloSimulation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRandom } from './prng';
import { requiredLambdaTimesP, runScenario } from './monteCarloSimulation';

test('sem ruído e sem dislocamento, nunca há oportunidade (preços sempre no valor justo)', () => {
    const result = runScenario(
        { name: 'zero-ruído', ticks: 1000, baseNoiseBps: 0, jumpProbability: 0, jumpMeanBps: 0, ticksPerSecond: 5 },
        createSeededRandom(1)
    );
    assert.equal(result.opportunities, 0);
    assert.equal(result.lambdaTimesP, 0);
});

test('dislocamento garantido (probabilidade 1) e grande o suficiente sempre passa no kill switch', () => {
    // Prob=1 força um dislocamento em toda iteração; magnitude bem acima do
    // limiar necessário (~32bp) faz praticamente todo tick virar oportunidade.
    const result = runScenario(
        { name: 'dislocamento-garantido', ticks: 2000, baseNoiseBps: 0, jumpProbability: 1, jumpMeanBps: 200, ticksPerSecond: 5 },
        createSeededRandom(2)
    );
    // Metade dos dislocamentos empurra o preço na direção "errada" (reduz a
    // ineficiência em vez de criar); ainda assim a maioria deve passar.
    assert.ok(result.opportunities > result.ticks * 0.3, `esperava bastante oportunidade, obtive ${result.opportunities}/${result.ticks}`);
});

test('resultado é determinístico para o mesmo seed e mesmos parâmetros', () => {
    const params = { name: 'repetível', ticks: 5000, baseNoiseBps: 5, jumpProbability: 0.0005, jumpMeanBps: 40, ticksPerSecond: 5 };
    const a = runScenario(params, createSeededRandom(777));
    const b = runScenario(params, createSeededRandom(777));
    assert.deepEqual(a, b);
});

test('mais ruído/dislocamento nunca produz MENOS oportunidades (monotonicidade, mesmo seed)', () => {
    const seed = 55;
    const low = runScenario({ name: 'baixo', ticks: 20000, baseNoiseBps: 2, jumpProbability: 0.0001, jumpMeanBps: 20, ticksPerSecond: 5 }, createSeededRandom(seed));
    const high = runScenario({ name: 'alto', ticks: 20000, baseNoiseBps: 6, jumpProbability: 0.001, jumpMeanBps: 60, ticksPerSecond: 5 }, createSeededRandom(seed));
    assert.ok(high.opportunities >= low.opportunities, `esperava >= oportunidades com mais ruído: ${high.opportunities} vs ${low.opportunities}`);
});

test('requiredLambdaTimesP reproduz a meta usada na discussão (R$5k -> R$20k/mês)', () => {
    // 20000/5000/720 = 0.00555...
    assert.ok(Math.abs(requiredLambdaTimesP(5000, 20000) - 0.0055555555) < 1e-8);
});

test('requiredLambdaTimesP escala linearmente com o alvo e inversamente com o capital', () => {
    const base = requiredLambdaTimesP(5000, 20000);
    assert.ok(Math.abs(requiredLambdaTimesP(5000, 40000) - base * 2) < 1e-9);
    assert.ok(Math.abs(requiredLambdaTimesP(10000, 20000) - base / 2) < 1e-9);
});
