import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    lucroEstimado, emDolar, ondeEuEstava, montarPlacar, oQueIssoQuerDizer,
    type Perdida, type Cobertura,
} from './perdidas';

const D = (n: number | string) => new Decimal(n);
const perdida = (p: Partial<Perdida> & { lucroUsd: Decimal | null; cobertura: Cobertura }): Perdida => ({
    devedor: '0xaa', bloco: 1, liquidante: '0xbb', dividaUsd: null, ...p,
});

test('liquidação de US$4.000 NÃO rende US$4.000', () => {
    // O erro que já apareceu duas vezes nesta conversa, sempre otimista:
    // confundir o tamanho da dívida com o lucro. Cobre-se metade, ganha-se o
    // ágio sobre essa metade, e ainda se paga para vender a garantia.
    const lucro = lucroEstimado(D(4000));
    assert.ok(lucro.greaterThan(80), `deu ${lucro.toFixed(2)}`);
    assert.ok(lucro.lessThan(95), `deu ${lucro.toFixed(2)}`);
});

test('o lucro cresce junto com a dívida, mas em outra escala', () => {
    // 5% sobre metade = 2,5% da dívida, menos custos. Nunca perto de 100%.
    for (const divida of [1000, 10_000, 100_000]) {
        const l = lucroEstimado(D(divida));
        assert.ok(l.lessThan(divida * 0.025), `${divida} rendeu ${l.toFixed(2)}`);
    }
});

test('dívida pequena demais dá lucro NEGATIVO por causa do gás', () => {
    assert.ok(lucroEstimado(D(10)).lessThan(0));
});

test('sem preço ou sem casas decimais, o valor é null — nunca um palpite', () => {
    // Assumir 18 casas para um token de 6 erraria por um trilhão. Já
    // aconteceu neste projeto.
    assert.equal(emDolar(1000000n, undefined, D(1e8)), null);
    assert.equal(emDolar(1000000n, 6, undefined), null);
});

test('converte unidades cruas para dólar usando as casas do token', () => {
    // 4.000 USDC: 6 casas, oráculo a US$1,00 (1e8).
    const usd = emDolar(4_000_000_000n, 6, D(1e8));
    assert.equal(usd!.toFixed(2), '4000.00');
    // 1 WETH: 18 casas, oráculo a US$2.646,93.
    const eth = emDolar(10n ** 18n, 18, D(264693000000));
    assert.equal(eth!.toFixed(2), '2646.93');
});

test('ondeEuEstava separa os quatro casos', () => {
    const brasa = new Set(['0xa']);
    const quentes = new Set(['0xb']);
    const todos = new Set(['0xa', '0xb', '0xc']);
    assert.equal(ondeEuEstava('0xA', brasa, quentes, todos), 'brasa');
    assert.equal(ondeEuEstava('0xB', brasa, quentes, todos), 'quente');
    assert.equal(ondeEuEstava('0xC', brasa, quentes, todos), 'na lista');
    assert.equal(ondeEuEstava('0xZ', brasa, quentes, todos), 'nem sabia');
});

test('a comparação ignora maiúsculas do checksum', () => {
    const brasa = new Set(['0xabcdef']);
    assert.equal(ondeEuEstava('0xABCDEF', brasa, new Set(), new Set()), 'brasa');
});

test('o placar ignora as que não pagam nem o gás', () => {
    const p = montarPlacar([
        perdida({ lucroUsd: D(2), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(88), cobertura: 'brasa' }),
    ]);
    assert.equal(p.total, 2);
    assert.equal(p.comCotacao, 2);
    assert.equal(p.valiam.length, 1);
    assert.equal(p.somaDoLucroPerdido.toNumber(), 88);
});

test('liquidação sem cotação não conta como zero nem some do total', () => {
    // "Sem preço" tem que continuar visível: contá-la como US$0 diria que
    // nada valia, e escondê-la do total diria que nada aconteceu.
    const p = montarPlacar([perdida({ lucroUsd: null, cobertura: 'brasa' })]);
    assert.equal(p.total, 1);
    assert.equal(p.comCotacao, 0);
    assert.equal(p.valiam.length, 0);
});

test('as que valiam saem ordenadas por LUCRO, não pela ordem que chegaram', () => {
    const p = montarPlacar([
        perdida({ lucroUsd: D(50), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(900), cobertura: 'quente' }),
        perdida({ lucroUsd: D(120), cobertura: 'brasa' }),
    ]);
    assert.deepEqual(p.valiam.map((x) => x.lucroUsd!.toNumber()), [900, 120, 50]);
});

test('o diagnóstico aponta o balde maior, e cada balde pede conserto diferente', () => {
    const naBrasa = montarPlacar([
        perdida({ lucroUsd: D(88), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(88), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(88), cobertura: 'nem sabia' }),
    ]);
    assert.ok(oQueIssoQuerDizer(naBrasa).includes('velocidade'));

    const foraDaLista = montarPlacar([
        perdida({ lucroUsd: D(88), cobertura: 'nem sabia' }),
        perdida({ lucroUsd: D(88), cobertura: 'nem sabia' }),
    ]);
    assert.ok(oQueIssoQuerDizer(foraDaLista).includes('cobertura'));
});

test('zero liquidações na faixa NÃO vira acusação de lentidão', () => {
    // A diferença entre "não teve" e "teve e você perdeu" é a coisa toda que
    // este placar existe para separar.
    const vazio = montarPlacar([perdida({ lucroUsd: D(1), cobertura: 'brasa' })]);
    assert.ok(oQueIssoQuerDizer(vazio).includes('não teve'));
});
