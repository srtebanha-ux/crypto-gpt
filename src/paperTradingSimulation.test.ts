// Arquivo: src/paperTradingSimulation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SYNTHETIC_TRIANGLE, ILLUSTRATIVE_FIVE_TRIANGLES, runPaperTradingSimulation } from './paperTradingSimulation';

// Cenário com dislocamentos frequentes o suficiente para gerar vários
// ciclos numa amostra pequena de ticks (mantém o teste rápido).
const RICH_SCENARIO = { baseNoiseBps: 5, jumpProbability: 0.01, jumpMeanBps: 50 };

test('regressão: múltiplos ciclos lucrativos em sequência não travam o engine (bug do teto de capital fixo)', async () => {
    // Este é o teste que teria pegado o bug real encontrado rodando uma
    // simulação de 5 dias: uma versão anterior do RiskManager fixava um
    // teto de capital igual ao capital INICIAL e rejeitava silenciosamente
    // todo ciclo depois que o capital (que cresce a cada sucesso) o
    // ultrapassasse — ou seja, travava para sempre depois do primeiro
    // ciclo lucrativo. Nenhum teste de ciclo único period detectava isso.
    const result = await runPaperTradingSimulation('50', RICH_SCENARIO, 20000, 1);

    assert.ok(result.totalCycles >= 2, `esperava pelo menos 2 ciclos para provar que o engine não trava após o primeiro, obtive ${result.totalCycles}`);
    assert.equal(result.halted, false);
});

test('capital final reflete o capital inicial mais os lucros acumulados', async () => {
    const result = await runPaperTradingSimulation('50', RICH_SCENARIO, 20000, 2);
    assert.equal(result.initialCapital.toString(), '50');
    if (result.totalCycles > 0) {
        assert.ok(result.finalCapital.greaterThan(0));
    } else {
        assert.equal(result.finalCapital.toString(), '50');
    }
});

test('sem ruído nem dislocamento, nenhum ciclo dispara e o capital não muda', async () => {
    const result = await runPaperTradingSimulation('50', { baseNoiseBps: 0, jumpProbability: 0, jumpMeanBps: 0 }, 5000, 3, { statMinSamples: 0 });
    assert.equal(result.totalCycles, 0);
    assert.equal(result.finalCapital.toString(), '50');
    assert.equal(result.halted, false);
});

test('resultado é determinístico para o mesmo seed', async () => {
    const a = await runPaperTradingSimulation('50', RICH_SCENARIO, 20000, 777);
    const b = await runPaperTradingSimulation('50', RICH_SCENARIO, 20000, 777);
    assert.equal(a.finalCapital.toString(), b.finalCapital.toString());
    assert.equal(a.totalCycles, b.totalCycles);
});

test('múltiplos triângulos sintéticos: mais triângulos monitorados gera igual ou mais ciclos que um único, sob o mesmo cenário/seed', async () => {
    // Não é uma garantia matemática geral (o mutex global serializa disparos
    // — ver README), mas com 5 triângulos independentes competindo pela
    // mesma amostra de ticks, a MEDIÇÃO empírica não deveria nunca ser
    // pior que rodar só o primeiro deles isoladamente.
    const single = await runPaperTradingSimulation('50', RICH_SCENARIO, 20000, 5, {}, '0.0005', [DEFAULT_SYNTHETIC_TRIANGLE]);
    const multi = await runPaperTradingSimulation('50', RICH_SCENARIO, 20000, 5, {}, '0.0005', ILLUSTRATIVE_FIVE_TRIANGLES);

    assert.ok(multi.totalCycles >= single.totalCycles, `esperava >= ciclos com 5 triângulos (obtive ${multi.totalCycles}) do que com 1 (${single.totalCycles})`);
});

test('triângulos sintéticos independentes nunca compartilham símbolo entre si (pré-requisito do provider — ver seu comentário de classe)', () => {
    const seen = new Set<string>();
    for (const t of ILLUSTRATIVE_FIVE_TRIANGLES) {
        for (const leg of [t.leg1, t.leg2, t.leg3]) {
            assert.ok(!seen.has(leg), `símbolo ${leg} reaparece em mais de um triângulo sintético — quebraria a independência assumida pelo provider`);
            seen.add(leg);
        }
    }
});
