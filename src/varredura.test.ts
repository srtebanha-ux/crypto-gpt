// Arquivo: src/varredura.test.ts
//
// O teste que carrega este arquivo é o da cascata em DEGRAUS. Uma liquidação
// em cadeia come o livro em ondas — 2% aqui, 2% ali — e nenhuma comparação
// entre fitas consecutivas enxerga isso. Só medir contra a ponta da janela
// enxerga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { eventosNecessariosPorDia, VarreduraDeMercado } from './varredura';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

function fita(emMs: number, pares: Record<string, string>) {
    return { emMs, precos: new Map(Object.entries(pares).map(([k, v]) => [k, new Decimal(v)])) };
}

function nova() {
    return new VarreduraDeMercado({ janelaMs: 60_000, quedaMinima: new Decimal('0.08') });
}

test('queda de 8% de uma vez é detectada', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '100' }));
    const q = v.quedas(fita(10_000, { AUSDT: '92' }));
    assert.equal(q.length, 1);
    assert.equal(q[0].queda.mul(100).toFixed(0), '8');
});

test('cascata em DEGRAUS de 2% é detectada — nenhuma comparação consecutiva veria', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '100' }));
    v.registrar(fita(10_000, { AUSDT: '98' }));
    v.registrar(fita(20_000, { AUSDT: '96' }));
    v.registrar(fita(30_000, { AUSDT: '94' }));
    const q = v.quedas(fita(40_000, { AUSDT: '91.5' }));
    assert.equal(q.length, 1);
    assert.equal(q[0].queda.mul(100).toFixed(1), '8.5');
    // Entre fitas vizinhas, nenhuma variação passa de 2,6%.
});

test('mede contra o TOPO da janela, não contra o começo', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '100' }));
    v.registrar(fita(10_000, { AUSDT: '103' })); // subiu antes de despencar
    const q = v.quedas(fita(20_000, { AUSDT: '94' }));
    assert.equal(q.length, 1);
    // 103 -> 94 = 8,7%. Contra o começo (100) seriam só 6% e o evento sumiria.
    assert.equal(q[0].queda.mul(100).toFixed(1), '8.7');
    assert.equal(q[0].de.toString(), '103');
});

test('queda abaixo do mínimo não vira evento', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '100' }));
    assert.equal(v.quedas(fita(10_000, { AUSDT: '95' })).length, 0);
});

test('símbolo ausente da fita antiga é PULADO — estreia não é cascata', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '100' }));
    const q = v.quedas(fita(10_000, { AUSDT: '99', NOVOUSDT: '5' }));
    assert.equal(q.length, 0);
});

test('a janela expira: preço velho não sustenta evento para sempre', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '100' }));
    v.registrar(fita(70_000, { AUSDT: '99' })); // expulsa a fita de 0ms
    const q = v.quedas(fita(80_000, { AUSDT: '92' }));
    assert.equal(q.length, 0); // 99 -> 92 = 7,1%, abaixo de 8%
    assert.equal(v.profundidade, 1); // a fita de 0ms saiu da janela
});

test('sem histórico não inventa evento', () => {
    assert.equal(nova().quedas(fita(0, { AUSDT: '100' })).length, 0);
});

test('preço zero ou negativo é ignorado sem quebrar', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '0' }));
    assert.equal(v.quedas(fita(10_000, { AUSDT: '92' })).length, 0);
});

test('maior queda vem primeiro — com uma posição por vez, a ordem É a decisão', () => {
    const v = nova();
    v.registrar(fita(0, { AUSDT: '100', BUSDT: '100' }));
    const q = v.quedas(fita(10_000, { AUSDT: '91', BUSDT: '85' }));
    assert.equal(q[0].symbol, 'BUSDT');
    assert.equal(q[1].symbol, 'AUSDT');
});

test('a meta vira número de eventos por dia, não intenção', () => {
    const n = eventosNecessariosPorDia({
        metaDiariaUsdt: new Decimal('11.70'),
        nocional: new Decimal(328),
        acerto: new Decimal('0.5'),
        ganhoPorNocional: new Decimal('0.03937'),
        perdaPorNocional: new Decimal('0.01590'),
    });
    assert.equal(n?.toFixed(1), '3.0');
});

test('sem vantagem, NENHUM número de eventos fecha a meta', () => {
    const n = eventosNecessariosPorDia({
        metaDiariaUsdt: new Decimal('11.70'),
        nocional: new Decimal(328),
        acerto: new Decimal('0.25'), // abaixo do equilíbrio de 28,8%
        ganhoPorNocional: new Decimal('0.03937'),
        perdaPorNocional: new Decimal('0.01590'),
    });
    assert.equal(n, null);
    // Devolver um número aqui seria mentir: mais operações só perderiam mais.
});
