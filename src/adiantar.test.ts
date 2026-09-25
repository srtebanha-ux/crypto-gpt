import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    precoDeQueda, quemCaiPrimeiro, jaCairamNoMercado, desvioDoOraculo,
    qualPostura, ritmoDaPostura, custoDaVigiliaEmCUs, DESVIO_TIPICO_PCT,
} from './adiantar';

const D = (n: number | string) => new Decimal(n);
const ETH = D(2646.93); // o preço que o oráculo mostrava hoje

test('queda de 1% vira um preço 1% abaixo', () => {
    assert.equal(precoDeQueda(D(1000), D(1)).toFixed(2), '990.00');
});

test('quem já está caído não tem preço de queda no futuro', () => {
    assert.equal(precoDeQueda(D(1000), D(0)).toNumber(), 1000);
});

test('a fila sai ordenada por PREÇO ALVO, quem cai primeiro na frente', () => {
    // Menor queda necessária = preço alvo mais alto = cai primeiro.
    const fila = quemCaiPrimeiro([
        { devedor: '0xlonge', quedaPct: D(14.6) },
        { devedor: '0xperto', quedaPct: D(0.04) },
        { devedor: '0xmeio', quedaPct: D(3) },
    ], ETH);
    assert.deepEqual(fila.map((g) => g.devedor), ['0xperto', '0xmeio', '0xlonge']);
    assert.ok(fila[0].precoAlvo.greaterThan(fila[1].precoAlvo));
});

test('o mercado derruba antes do oráculo saber', () => {
    // A posição mais frágil de hoje: 0,04% de margem.
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(0.04) }], ETH);
    const alvo = fila[0].precoAlvo; // ~2645,87
    // Oráculo ainda diz 2646,93. Mercado já está abaixo do alvo.
    assert.equal(jaCairamNoMercado(fila, alvo.minus(1)).length, 1);
    assert.equal(jaCairamNoMercado(fila, alvo.plus(1)).length, 0);
});

test('o desvio mede o quanto a blockchain está desatualizada', () => {
    // Mercado 0,5% abaixo do que está escrito on-chain.
    const mercado = ETH.mul(0.995);
    assert.equal(desvioDoOraculo(mercado, ETH).toFixed(2), '0.50');
    // Mercado SUBINDO dá desvio negativo, e não aciona nada.
    assert.ok(desvioDoOraculo(ETH.mul(1.01), ETH).lessThan(0));
});

test('preço parado = dormindo, e dormindo é o ritmo barato', () => {
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(14.6) }], ETH);
    assert.equal(qualPostura(ETH, ETH, fila), 'dormindo');
    assert.equal(ritmoDaPostura('dormindo', 8000), 8000);
});

test('mercado andou meio por cento mas ninguém cai = atento', () => {
    // Ninguém está perto: a fila mais frágil precisa de 14,6%.
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(14.6) }], ETH);
    const mercado = ETH.mul(0.994); // 0,6% abaixo
    assert.equal(qualPostura(mercado, ETH, fila), 'atento');
    assert.equal(ritmoDaPostura('atento', 8000), 1000);
});

test('mercado já derrubou alguém = DEDO NO GATILHO, mesmo com desvio pequeno', () => {
    // Este é o caso que a estratégia inteira existe para pegar: uma queda
    // minúscula, longe de acionar o feed por desvio, que mesmo assim já
    // derruba quem estava a 0,04% de cair.
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(0.04) }], ETH);
    const mercado = ETH.mul(0.999); // só 0,1% abaixo
    assert.ok(desvioDoOraculo(mercado, ETH).lessThan(DESVIO_TIPICO_PCT));
    assert.equal(qualPostura(mercado, ETH, fila), 'dedo no gatilho');
    assert.equal(ritmoDaPostura('dedo no gatilho', 8000), 200);
});

test('gatilho tem precedência sobre atento', () => {
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(0.04) }], ETH);
    // Mercado despencou 2%: aciona os dois critérios, e o urgente ganha.
    assert.equal(qualPostura(ETH.mul(0.98), ETH, fila), 'dedo no gatilho');
});

test('fila vazia nunca vira dedo no gatilho', () => {
    // Sem ninguém para cair, correr não adianta e só gastaria CU.
    assert.equal(qualPostura(ETH.mul(0.5), ETH, []), 'atento');
});

test('viver assim cabe no orçamento, porque os segundos caros são raros', () => {
    // Teto da conta: 38,1M CU/mês. O ciclo normal já usa ~9M.
    const vigilia = custoDaVigiliaEmCUs({
        cuPorLeitura: 26,
        minutosAtentoPorDia: 60,
        minutosNoGatilhoPorDia: 10,
    });
    assert.ok(vigilia < 10_000_000, `vigília custaria ${vigilia.toLocaleString('pt-BR')} CU/mês`);
});

test('ficar com o dedo no gatilho o DIA INTEIRO não caberia', () => {
    // Guarda a razão de existir das três posturas: o ritmo rápido só é
    // pagável enquanto for raro.
    const sempre = custoDaVigiliaEmCUs({
        cuPorLeitura: 26,
        minutosAtentoPorDia: 0,
        minutosNoGatilhoPorDia: 1440,
    });
    assert.ok(sempre > 38_095_238, `daria ${sempre} CU/mês`);
});
