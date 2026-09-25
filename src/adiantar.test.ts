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

// ---------------------------------------------------------------------------
// A regra corrigida: o feed precisa ESCREVER, e a escrita precisa DERRUBAR.
// ---------------------------------------------------------------------------
import { posturaPorMargem } from './adiantar';

test('queda pequena NÃO vira dedo no gatilho, mesmo derrubando alguém no papel', () => {
    // O erro que esta função existe para corrigir. Alguém a 0,04% de cair, o
    // mercado cai 0,1% — mas 0,1% não faz o feed escrever, então o preço
    // on-chain não se move e ninguém fica liquidável. Correr a 200ms aqui
    // gastaria CU para nada.
    assert.equal(posturaPorMargem(D(0.1), D(0.04)), 'dormindo');
});

test('queda que faz o feed escrever E derruba alguém = dedo no gatilho', () => {
    assert.equal(posturaPorMargem(D(0.6), D(0.04)), 'dedo no gatilho');
});

test('queda que faz o feed escrever mas não derruba ninguém = atento', () => {
    // O feed vai escrever, mas o mais frágil está a 3% e a queda é de 0,6%.
    assert.equal(posturaPorMargem(D(0.6), D(3)), 'atento');
});

test('chegando perto do limiar já aperta o passo', () => {
    assert.equal(posturaPorMargem(D(0.35), D(0.04)), 'atento');
    assert.equal(posturaPorMargem(D(0.2), D(0.04)), 'dormindo');
});

test('sem ninguém na brasa nunca vira dedo no gatilho', () => {
    // Correr sem alvo é só gastar.
    assert.equal(posturaPorMargem(D(5), null), 'atento');
});

test('o estado caro se limita sozinho', () => {
    // Enquanto o desvio não chega ao limiar, não se corre. Quando chega, o
    // feed escreve em segundos e a corrida acaba. É isso que impede o ritmo
    // de 200ms de virar o ritmo do dia inteiro.
    assert.equal(posturaPorMargem(D(0.49), D(0.01)), 'atento');
    assert.equal(posturaPorMargem(D(0.50), D(0.01)), 'dedo no gatilho');
});

// ---------------------------------------------------------------------------
// Dormir de olho aberto: olhar o mercado custa zero, ler a blockchain não.
// ---------------------------------------------------------------------------
import { dormirDeOlho } from './adiantar';

test('dorme em fatias e olha entre elas', async () => {
    const dormiu: number[] = [];
    let olhadas = 0;
    const acordouCedo = await dormirDeOlho(
        8000, 1000,
        async () => { olhadas += 1; return false; },
        async (ms) => { dormiu.push(ms); },
    );
    assert.equal(acordouCedo, false);
    assert.equal(dormiu.reduce((a, b) => a + b, 0), 8000, 'o sono total tem que ser o pedido');
    assert.equal(dormiu.length, 8);
    // Olha entre as fatias, não depois da última — olhar e já sair é desperdício.
    assert.equal(olhadas, 7);
});

test('acorda na hora quando o mercado muda no meio do sono', async () => {
    // O ponto inteiro: sem isto, uma queda no segundo 1 só seria vista no
    // segundo 8, e a liquidação já teria ido embora.
    const dormiu: number[] = [];
    let olhadas = 0;
    const acordouCedo = await dormirDeOlho(
        8000, 1000,
        async () => { olhadas += 1; return olhadas >= 2; },
        async (ms) => { dormiu.push(ms); },
    );
    assert.equal(acordouCedo, true);
    assert.equal(dormiu.reduce((a, b) => a + b, 0), 2000, 'acordou no segundo 2, não no 8');
});

test('sono curto não vira olhadas desnecessárias', async () => {
    // Com o dedo no gatilho o sono é de 200ms: fatiar isso só gastaria
    // chamadas à Binance sem ganhar reação nenhuma.
    let olhadas = 0;
    const dormiu: number[] = [];
    await dormirDeOlho(200, 1000, async () => { olhadas += 1; return false; }, async (ms) => { dormiu.push(ms); });
    assert.equal(olhadas, 0);
    assert.deepEqual(dormiu, [200]);
});

test('sono zero ou negativo não dorme nem olha', async () => {
    let chamou = 0;
    await dormirDeOlho(0, 1000, async () => { chamou += 1; return false; }, async () => { chamou += 1; });
    assert.equal(chamou, 0);
});
