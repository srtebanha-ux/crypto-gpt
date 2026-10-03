// Arquivo: src/statistics.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { EwmaTracker } from './statistics';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

test('rejeita alpha fora de (0, 1]', () => {
    assert.throws(() => new EwmaTracker(new Decimal(0)));
    assert.throws(() => new EwmaTracker(new Decimal(1.1)));
    assert.doesNotThrow(() => new EwmaTracker(new Decimal(1)));
});

test('com uma única amostra, mean == x e stdDev == 0', () => {
    const tracker = new EwmaTracker(new Decimal('0.1'));
    tracker.update(new Decimal('5'));
    assert.equal(tracker.mean().toString(), '5');
    assert.equal(tracker.stdDev().toString(), '0');
    assert.equal(tracker.sampleCount(), 1);
});

test('série constante converge para stdDev == 0 e zScore == 0 (nunca "explode")', () => {
    const tracker = new EwmaTracker(new Decimal('0.2'));
    for (let i = 0; i < 50; i++) tracker.update(new Decimal('42'));
    assert.equal(tracker.mean().toString(), '42');
    assert.equal(tracker.stdDev().toString(), '0');
    assert.equal(tracker.zScore(new Decimal('42')).toString(), '0');
});

test('detecta um outlier real com z-score alto após aprender uma linha de base ruidosa', () => {
    const tracker = new EwmaTracker(new Decimal('0.1'));
    // Linha de base oscilando em torno de 1.0 (ruído de mercado "normal").
    const baseline = [0.999, 1.001, 1.0, 0.998, 1.002, 1.0, 0.999, 1.001, 1.0, 0.9995];
    for (let i = 0; i < 5; i++) {
        for (const v of baseline) tracker.update(new Decimal(v));
    }
    const zNormal = tracker.zScore(new Decimal('1.001'));
    const zOutlier = tracker.zScore(new Decimal('1.05')); // 5% de distorção — bem fora da linha de base
    assert.ok(zNormal.abs().lessThan(3), `esperava z-score baixo para tick dentro da linha de base, obtive ${zNormal}`);
    assert.ok(zOutlier.greaterThan(3), `esperava z-score alto para outlier, obtive ${zOutlier}`);
});

test('calcular o zScore ANTES de update() evita que o próprio outlier dilua seu significado', () => {
    const tracker = new EwmaTracker(new Decimal('0.3'));
    const baseline = [0.98, 1.02, 1.0, 0.99, 1.01, 1.0, 0.985, 1.015, 1.0, 0.995];
    for (let round = 0; round < 4; round++) {
        for (const v of baseline) tracker.update(new Decimal(v));
    }

    const outlier = new Decimal('1.08');
    const zScorePreUpdate = tracker.zScore(outlier); // contra a linha de base ainda "limpa"
    tracker.update(outlier);
    const zScorePostUpdate = tracker.zScore(outlier); // o mesmo valor, já parcialmente incorporado à média

    assert.ok(zScorePreUpdate.greaterThan(3), `esperava outlier significativo antes do update, obtive ${zScorePreUpdate}`);
    assert.ok(
        zScorePostUpdate.lessThan(zScorePreUpdate),
        'depois de absorver o outlier, o mesmo valor deve parecer menos extremo (a média se moveu em direção a ele) — por isso o engine deve pontuar o tick ANTES de atualizar o tracker com ele, nunca depois'
    );
});
