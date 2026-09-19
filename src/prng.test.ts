// Arquivo: src/prng.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRandom, gaussianSample } from './prng';

test('mesmo seed produz exatamente a mesma sequência', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    assert.deepEqual(seqA, seqB);
});

test('seeds diferentes produzem sequências diferentes', () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    assert.notDeepEqual(seqA, seqB);
});

test('valores gerados sempre ficam em [0, 1)', () => {
    const rand = createSeededRandom(7);
    for (let i = 0; i < 10000; i++) {
        const x = rand();
        assert.ok(x >= 0 && x < 1, `valor fora do intervalo: ${x}`);
    }
});

test('gaussianSample converge para a média/desvio-padrão configurados', () => {
    const rand = createSeededRandom(123);
    const n = 50000;
    const mean = 10;
    const stdDev = 3;
    let sum = 0;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
        const x = gaussianSample(rand, mean, stdDev);
        samples.push(x);
        sum += x;
    }
    const sampleMean = sum / n;
    const sampleVar = samples.reduce((acc, x) => acc + (x - sampleMean) ** 2, 0) / n;
    const sampleStdDev = Math.sqrt(sampleVar);

    assert.ok(Math.abs(sampleMean - mean) < 0.1, `média amostral ${sampleMean} longe demais de ${mean}`);
    assert.ok(Math.abs(sampleStdDev - stdDev) < 0.1, `desvio-padrão amostral ${sampleStdDev} longe demais de ${stdDev}`);
});

test('gaussianSample é determinístico para o mesmo seed', () => {
    const a = gaussianSample(createSeededRandom(999), 0, 1);
    const b = gaussianSample(createSeededRandom(999), 0, 1);
    assert.equal(a, b);
});
