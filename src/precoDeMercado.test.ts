import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { AbiCoder } from 'ethers';
import { simboloDaBinance, lerSymbol, lerCotacoes, quedaDoMercado } from './precoDeMercado';

const D = (n: number | string) => new Decimal(n);

test('os tokens que seguem ETH caem juntos', () => {
    for (const s of ['WETH', 'weth', 'cbETH', 'wstETH', 'weETH']) {
        assert.equal(simboloDaBinance(s), 'ETHUSDT', s);
    }
});

test('os tokens que seguem BTC caem juntos', () => {
    for (const s of ['cbBTC', 'WBTC', 'tBTC']) {
        assert.equal(simboloDaBinance(s), 'BTCUSDT', s);
    }
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
