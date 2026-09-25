import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { AbiCoder } from 'ethers';
import { simboloDaBinance, lerSymbol, lerCotacoes, quedaDoMercado } from './precoDeMercado';

const D = (n: number | string) => new Decimal(n);

test('só os que valem o MESMO que ETH seguem ETHUSDT', () => {
    for (const s of ['WETH', 'weth', 'ETH']) {
        assert.equal(simboloDaBinance(s), 'ETHUSDT', s);
    }
});

test('token que rende juros NÃO segue o par, mesmo acompanhando o ETH', () => {
    // wstETH, cbETH e weETH valem MAIS que um ETH, e a diferença cresce com o
    // tempo. Comparar o preço deles com ETHUSDT daria uma "queda" permanente
    // de uns 17%, e o bot ficaria preso em 'dedo no gatilho' para sempre,
    // lendo a blockchain a 200ms sem motivo nenhum.
    for (const s of ['cbETH', 'wstETH', 'weETH']) {
        assert.equal(simboloDaBinance(s), null, s);
    }
});

test('só os que valem o MESMO que BTC seguem BTCUSDT', () => {
    for (const s of ['cbBTC', 'WBTC', 'BTC']) {
        assert.equal(simboloDaBinance(s), 'BTCUSDT', s);
    }
    // tBTC sai pelo mesmo motivo: não é um-para-um o tempo todo.
    assert.equal(simboloDaBinance('tBTC'), null);
});

test('stablecoin NÃO é acompanhada, e isso é resposta e não falha', () => {
    // Ela não derruba ninguém por variação de preço. Inventar um par para ela
    // adicionaria ruído ao gatilho sem adicionar informação.
    for (const s of ['USDC', 'USDT', 'DAI', 'EURC']) {
        assert.equal(simboloDaBinance(s), null, s);
    }
});

test('token desconhecido não vira palpite', () => {
    assert.equal(simboloDaBinance('AERO'), null);
    assert.equal(simboloDaBinance(''), null);
});

test('lê o símbolo do jeito que a blockchain responde', () => {
    const hex = AbiCoder.defaultAbiCoder().encode(['string'], ['cbBTC']);
    assert.equal(lerSymbol(hex), 'cbBTC');
    assert.equal(simboloDaBinance(lerSymbol(hex)!), 'BTCUSDT');
});

test('resposta curta ou vazia devolve null, nunca lixo', () => {
    assert.equal(lerSymbol('0x'), null);
    assert.equal(lerSymbol('0x00'), null);
});

test('cotação ilegível vira ausência, não zero', () => {
    // Zero seria "o ETH vale nada", e o bot leria isso como todo mundo caído.
    const m = lerCotacoes([
        { symbol: 'ETHUSDT', price: '2646.93' },
        { symbol: 'BTCUSDT', price: 'abc' },
        { symbol: 'XXX', price: '0' },
    ]);
    assert.equal(m.get('ETHUSDT')!.toFixed(2), '2646.93');
    assert.equal(m.has('BTCUSDT'), false);
    assert.equal(m.has('XXX'), false);
});

test('resposta que não é lista não derruba nada', () => {
    // Binance fora do ar, HTML de erro, rate limit: tudo vira mapa vazio, e o
    // bot volta ao ritmo normal em vez de morrer. Preço de mercado é
    // acelerador, não motor.
    assert.equal(lerCotacoes({ code: -1121, msg: 'Invalid symbol' }).size, 0);
    assert.equal(lerCotacoes(null).size, 0);
});

test('a queda mede o quanto a blockchain está atrasada', () => {
    const oraculo = new Map([['ETHUSDT', D(2646.93)]]);
    const mercado = new Map([['ETHUSDT', D(2646.93).mul(0.995)]]);
    assert.equal(quedaDoMercado(mercado, oraculo).toFixed(3), '0.500');
});

test('mercado SUBINDO não vira queda', () => {
    const oraculo = new Map([['ETHUSDT', D(2000)]]);
    assert.equal(quedaDoMercado(new Map([['ETHUSDT', D(2100)]]), oraculo).toNumber(), 0);
});

test('a maior queda entre os pares é que manda', () => {
    // Se o BTC despencou e o ETH não, quem tem garantia em BTC cai. O gatilho
    // tem que acompanhar o pior caso, não a média.
    const oraculo = new Map([['ETHUSDT', D(2000)], ['BTCUSDT', D(60000)]]);
    const mercado = new Map([['ETHUSDT', D(1998)], ['BTCUSDT', D(58800)]]);
    assert.equal(quedaDoMercado(mercado, oraculo).toFixed(1), '2.0');
});

test('par sem preço no oráculo é ignorado, não assumido', () => {
    assert.equal(quedaDoMercado(new Map([['ETHUSDT', D(1)]]), new Map()).toNumber(), 0);
});
