// Arquivo: src/poolDiscovery.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlausiblePoolCount, parseScanMode, selectPoolIndices } from './poolDiscovery';

test('parseScanMode: padrão é newest (onde há mais chance de ninguém estar olhando)', () => {
    assert.equal(parseScanMode(undefined), 'newest');
});

test('parseScanMode aceita os três modos e rejeita o resto', () => {
    assert.equal(parseScanMode('newest'), 'newest');
    assert.equal(parseScanMode('oldest'), 'oldest');
    assert.equal(parseScanMode('random'), 'random');
    assert.throws(() => parseScanMode('aleatorio'), /inválido/);
});

test('newest pega os ÚLTIMOS índices (pools recém-criados)', () => {
    assert.deepEqual(selectPoolIndices(1000, 3, 'newest'), [997, 998, 999]);
});

test('oldest pega os PRIMEIROS índices', () => {
    assert.deepEqual(selectPoolIndices(1000, 3, 'oldest'), [0, 1, 2]);
});

test('limite maior que o total devolve todos, sem índice fora da faixa', () => {
    assert.deepEqual(selectPoolIndices(3, 10, 'newest'), [0, 1, 2]);
    assert.deepEqual(selectPoolIndices(3, 10, 'oldest'), [0, 1, 2]);
    assert.equal(selectPoolIndices(3, 10, 'random').length, 3);
});

test('factory vazia devolve lista vazia sem estourar', () => {
    assert.deepEqual(selectPoolIndices(0, 10, 'newest'), []);
});

test('random nunca repete índice nem sai da faixa', () => {
    // Índice repetido desperdiça chamada; índice fora da faixa faz
    // allPairs(i) reverter e derruba o lote JSON-RPC inteiro.
    const indices = selectPoolIndices(500, 100, 'random');
    assert.equal(indices.length, 100);
    assert.equal(new Set(indices).size, 100);
    for (const i of indices) {
        assert.ok(i >= 0 && i < 500, `índice ${i} fora da faixa`);
    }
});

test('random é reprodutível com a mesma semente — e muda com outra', () => {
    // Sem reprodutibilidade não dá para saber se um resultado diferente entre
    // duas rodadas veio do mercado ou do sorteio.
    assert.deepEqual(selectPoolIndices(1000, 20, 'random', 42), selectPoolIndices(1000, 20, 'random', 42));
    assert.notDeepEqual(selectPoolIndices(1000, 20, 'random', 42), selectPoolIndices(1000, 20, 'random', 7));
});

test('os índices saem sempre em ordem crescente', () => {
    for (const mode of ['newest', 'oldest', 'random'] as const) {
        const indices = selectPoolIndices(300, 50, mode);
        const ordenado = [...indices].sort((a, b) => a - b);
        assert.deepEqual(indices, ordenado, `modo ${mode} devolveu fora de ordem`);
    }
});

test('parâmetros inválidos estouram em vez de produzir varredura silenciosamente errada', () => {
    assert.throws(() => selectPoolIndices(-1, 10, 'newest'), /Total de pools inválido/);
    assert.throws(() => selectPoolIndices(100, 0, 'newest'), /Limite de varredura inválido/);
    assert.throws(() => selectPoolIndices(100, -5, 'newest'), /Limite de varredura inválido/);
});

// --- Verificação da factory -------------------------------------------------

test('allPairsLength() = 0 estoura: factory em uso nunca tem zero pools', () => {
    // Endereço que não é factory devolve `0x`, que decodifica como zero. Sem
    // esta checagem o relatório diria "0 pools" e o operador procuraria o
    // problema no mercado em vez de no endereço.
    assert.throws(() => assertPlausiblePoolCount(0, '0xabc'), /nunca tem zero pools/);
});

test('contagem absurda estoura — não é resposta de allPairsLength()', () => {
    assert.throws(() => assertPlausiblePoolCount(999_000_000, '0xabc'), /acima de qualquer factory real/);
});

test('contagem plausível passa', () => {
    assert.doesNotThrow(() => assertPlausiblePoolCount(1, '0xabc'));
    assert.doesNotThrow(() => assertPlausiblePoolCount(150_000, '0xabc'));
});

test('valor não numérico ou negativo estoura', () => {
    assert.throws(() => assertPlausiblePoolCount(NaN, '0xabc'), /valor inválido/);
    assert.throws(() => assertPlausiblePoolCount(-1, '0xabc'), /valor inválido/);
});
