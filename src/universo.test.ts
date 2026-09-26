// Arquivo: src/universo.test.ts
//
// O que estes testes protegem é a diferença entre "o bot não achou nada" e "o
// bot não estava olhando". A segunda não gera log, não gera erro e não tem
// parâmetro que resolva — e foi o que aconteceu na prática: vinte moedas
// paradas na lista enquanto outra andava 40% no dia, fora dela.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { parElegivel, selecionarUniverso } from './universo';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const VOLUME_OK = new Decimal(50_000_000);

const candidato = (symbol: string, variacao: string, volume: Decimal = VOLUME_OK) => ({
    symbol,
    variacao24h: new Decimal(variacao),
    volumeQuote: volume,
});

test('escolhe quem MAIS se moveu, em qualquer direção', () => {
    // Direção fora da conta de propósito: reversion compra queda forte e
    // momentum compra alta forte. Ordenar com sinal daria a uma delas uma
    // lista que a outra descarta inteira.
    const universo = selecionarUniverso({
        candidatos: [
            candidato('AAAUSDT', '40'),
            candidato('BBBUSDT', '-38'),
            candidato('CCCUSDT', '2'),
            candidato('DDDUSDT', '-1'),
        ],
        quantidade: 2,
        volumeMinimo: new Decimal(0),
    });
    assert.deepEqual(universo, ['AAAUSDT', 'BBBUSDT']);
});

test('moeda COM POSIÇÃO fica no universo mesmo tendo parado de se mover', () => {
    // A regra que não pode ser quebrada. Posição fora do universo é posição
    // que o motor deixa de avaliar: sem stop, sem saída, sem ninguém olhando —
    // a receita exata da órfã, que já custou caro neste projeto.
    const universo = selecionarUniverso({
        candidatos: [candidato('AAAUSDT', '40'), candidato('PARADAUSDT', '0.1')],
        quantidade: 1,
        volumeMinimo: new Decimal(0),
        comPosicao: ['PARADAUSDT'],
    });
    assert.ok(universo.includes('PARADAUSDT'), 'a posição aberta NUNCA pode sair do universo');
    assert.ok(universo.includes('AAAUSDT'));
});

test('a moeda com posição não ocupa vaga da cota', () => {
    const universo = selecionarUniverso({
        candidatos: [candidato('AAAUSDT', '40'), candidato('BBBUSDT', '30'), candidato('PARADAUSDT', '0.1')],
        quantidade: 2,
        volumeMinimo: new Decimal(0),
        comPosicao: ['PARADAUSDT'],
    });
    assert.equal(universo.length, 3, 'duas escolhidas mais a que já tem posição');
    assert.equal(universo[0], 'PARADAUSDT', 'a que precisa de gestão vem primeiro');
});

test('volume baixo é recusado por mais que a moeda tenha andado', () => {
    // Variação alta com volume baixo é preço de uma ordem solitária, não
    // mercado. Entrar significa atravessar um spread enorme nas duas pontas, e
    // essa conta come qualquer movimento capturado.
    const universo = selecionarUniverso({
        candidatos: [
            candidato('MORTAUSDT', '90', new Decimal(1000)),
            candidato('VIVAUSDT', '10', VOLUME_OK),
        ],
        quantidade: 5,
        volumeMinimo: VOLUME_OK,
    });
    assert.deepEqual(universo, ['VIVAUSDT']);
});

test('tokens alavancados NUNCA entram, mesmo liderando a lista', () => {
    // Eles lideram qualquer ranking de variação por construção — são
    // alavancados. Mas têm decaimento embutido que o motor não modela em lugar
    // nenhum: entrariam todo dia no topo e sangrariam em silêncio.
    const universo = selecionarUniverso({
        candidatos: [
            candidato('BTCUPUSDT', '80'),
            candidato('ETHDOWNUSDT', '75'),
            candidato('XRPBULLUSDT', '70'),
            candidato('ADABEARUSDT', '65'),
            candidato('REALUSDT', '5'),
        ],
        quantidade: 5,
        volumeMinimo: new Decimal(0),
    });
    assert.deepEqual(universo, ['REALUSDT']);
});

test('stablecoins ficam de fora — variação alta nelas é ruído de dado', () => {
    const universo = selecionarUniverso({
        candidatos: [candidato('USDCUSDT', '30'), candidato('FDUSDUSDT', '25'), candidato('REALUSDT', '5')],
        quantidade: 5,
        volumeMinimo: new Decimal(0),
    });
    assert.deepEqual(universo, ['REALUSDT']);
});

test('pares fora de USDT não entram', () => {
    assert.equal(parElegivel('BTCBUSD'), false);
    assert.equal(parElegivel('ETHBTC'), false);
    assert.equal(parElegivel('SOLUSDT'), true);
});

test('empate é resolvido pelo NOME, não pela ordem que a API devolveu', () => {
    // Sem isto, dois ciclos idênticos poderiam produzir universos diferentes e
    // o motor abriria e largaria posição por ruído de ordenação.
    const entrada = [candidato('BBBUSDT', '10'), candidato('AAAUSDT', '10'), candidato('CCCUSDT', '10')];
    const um = selecionarUniverso({ candidatos: entrada, quantidade: 2, volumeMinimo: new Decimal(0) });
    const dois = selecionarUniverso({ candidatos: [...entrada].reverse(), quantidade: 2, volumeMinimo: new Decimal(0) });
    assert.deepEqual(um, dois);
    assert.deepEqual(um, ['AAAUSDT', 'BBBUSDT']);
});

test('quantidade zero devolve só o que tem posição', () => {
    const universo = selecionarUniverso({
        candidatos: [candidato('AAAUSDT', '40')],
        quantidade: 0,
        volumeMinimo: new Decimal(0),
        comPosicao: ['ABERTAUSDT'],
    });
    assert.deepEqual(universo, ['ABERTAUSDT']);
});
