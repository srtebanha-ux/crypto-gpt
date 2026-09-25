import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { lerRecibo, placarVazio, contarTiro, comoEstaIndo } from './tiros';

const D = (n: number) => new Decimal(n);

test('só status 1 é acerto', () => {
    assert.equal(lerRecibo({ status: 1 }), 'acertou');
    assert.equal(lerRecibo({ status: 0 }), 'reverteu');
});

test('recibo ausente NÃO é acerto, e tem nome próprio', () => {
    // Transação que não foi minerada no tempo esperado. Tratar isso como
    // acerto faria o bot contar lucro que não existe; tratar como silêncio
    // esconderia que ela ficou parada.
    assert.equal(lerRecibo(null), 'sumiu');
    assert.equal(lerRecibo(undefined), 'sumiu');
    assert.equal(lerRecibo({}), 'reverteu');
});

test('o lucro só entra quando o tiro acertou', () => {
    let p = placarVazio();
    p = contarTiro(p, 'reverteu', D(91));
    p = contarTiro(p, 'sumiu', D(91));
    assert.equal(p.lucroUsd.toNumber(), 0, 'tiro que não acertou não pode somar lucro');
    p = contarTiro(p, 'acertou', D(91));
    assert.equal(p.lucroUsd.toNumber(), 91);
});

test('acerto sem cotação conta como acerto, mas não inventa valor', () => {
    const p = contarTiro(placarVazio(), 'acertou', null);
    assert.equal(p.acertou, 1);
    assert.equal(p.lucroUsd.toNumber(), 0);
});

test('só reversões dizem "corrida perdida", não "falta de alvo"', () => {
    // A diferença decide o conserto: perder por pouco pede velocidade,
    // não achar alvo pede cobertura.
    let p = placarVazio();
    for (let i = 0; i < 3; i++) p = contarTiro(p, 'reverteu', D(91));
    const frase = comoEstaIndo(p);
    assert.ok(frase.includes('outro chegou antes'), frase);
    assert.ok(frase.includes('3 de 3'), frase);
});

test('sem tiro nenhum não acusa nada', () => {
    assert.equal(comoEstaIndo(placarVazio()), 'Nenhum tiro ainda.');
});

test('com acerto, o placar mostra taxa e dinheiro', () => {
    let p = placarVazio();
    p = contarTiro(p, 'acertou', D(91.4));
    p = contarTiro(p, 'reverteu', D(50));
    const frase = comoEstaIndo(p);
    assert.ok(frase.includes('1 de 2'));
    assert.ok(frase.includes('50%'));
    assert.ok(frase.includes('91.40'));
});

test('o total é sempre a soma dos desfechos', () => {
    // O bug que este teste guarda: `disparados` não era incrementado, então o
    // placar dizia "nenhum tiro ainda" depois de atirar três vezes.
    let p = placarVazio();
    p = contarTiro(p, 'acertou', D(10));
    p = contarTiro(p, 'reverteu', null);
    p = contarTiro(p, 'sumiu', null);
    assert.equal(p.disparados, 3);
    assert.equal(p.acertou + p.reverteu + p.sumiu, p.disparados);
});
