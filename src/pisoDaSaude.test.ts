import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { pisoDaSaudePorPreco, limiaresConferem, type ParteDaPosicao } from './pisoDaSaude';

const parte = (ativo: string, garantiaUsd: number, dividaUsd: number, limiar: number): ParteDaPosicao => ({
    ativo, garantiaUsd: new Decimal(garantiaUsd), dividaUsd: new Decimal(dividaUsd), limiar: new Decimal(limiar),
});

// O caso real, medido na Base em 2026-09-28 às 15:5x UTC, bloco ~51910500.
// `0xc4d36f950cdb76dbc83717087775ff3303c6eeb7`, o alvo que a ferramenta chamava
// de "o MELHOR que ele atira hoje, precisa cair 1.428%".
const C4D36F95 = [
    parte('WETH', 3277.19, 3036.29, 0.93),
    parte('cbBTC', 41.64, 0, 0.7775),
];

test('o caso real: o preço NÃO derruba 0xc4d36f95, em nenhuma direção', () => {
    const r = pisoDaSaudePorPreco(C4D36F95);
    // 3277,19 x 0,93 / 3036,29
    assert.equal(r.piso!.toFixed(6), '1.003786');
    assert.equal(r.imuneAPreco, true);
    assert.match(r.leitura, /preço NÃO derruba/);
    assert.match(r.leitura, /só o juro chega lá/);
});

test('o piso é MENOR que a saúde de hoje, e ainda assim acima de 1', () => {
    // A Aave devolveu saúde 1,014468 nessa leitura. O piso é 1,003786: o preço
    // pode sim empurrar a posição para baixo — mas o empurrão acaba antes de 1.
    // Dizer "imune" sem essa distinção seria afirmar que ela não se mexe.
    const r = pisoDaSaudePorPreco(C4D36F95);
    assert.equal(r.piso!.lessThan(new Decimal('1.014468')), true, 'o preço mexe');
    assert.equal(r.piso!.greaterThan(1), true, 'mas não chega em 1');
});

test('garantia numa moeda e dívida em OUTRA: o preço derruba, e o piso é zero', () => {
    // O caso normal, que é o que `quedaAteLiquidar` sempre supôs: garantia em
    // WETH, dívida em USDC. Sem garantia no ativo da dívida, o vértice daquele
    // ativo vale zero — a garantia inteira pode virar pó.
    const r = pisoDaSaudePorPreco([parte('WETH', 5000, 0, 0.83), parte('USDC', 0, 3000, 0.87)]);
    assert.equal(r.piso!.toFixed(6), '0.000000');
    assert.equal(r.imuneAPreco, false);
    assert.match(r.leitura, /preço pode derrubar/);
});

test('duas dívidas: manda o MENOR dos vértices, que é quem cai primeiro', () => {
    // Um ativo protegido e outro exposto não se compensam: basta o preço andar
    // na direção do exposto. Pegar o maior seria publicar o melhor caso como se
    // fosse garantia.
    const r = pisoDaSaudePorPreco([
        parte('WETH', 3000, 2000, 0.93),   // vértice 1,395
        parte('USDC', 100, 1000, 0.87),    // vértice 0,087
    ]);
    assert.equal(r.piso!.toFixed(3), '0.087');
    assert.equal(r.imuneAPreco, false);
    assert.match(r.leitura, /USDC/);
});

test('sem dívida não é piso ZERO — é não haver piso', () => {
    // Zero diria "cai a qualquer momento", que é o oposto da verdade. Esta é a
    // ausência com cara de resposta que este projeto mais encontra.
    const r = pisoDaSaudePorPreco([parte('WETH', 1000, 0, 0.93)]);
    assert.equal(r.piso, null);
    assert.equal(r.imuneAPreco, true);
    assert.match(r.leitura, /sem dívida/);
});

test('o limiar misturado confere com o que a Aave devolveu', () => {
    // A Aave disse 92,81% para 0xc4d36f95. É esta conferência que autoriza
    // publicar o piso: sem ela, os 93% e os 77,75% seriam chute meu.
    const r = limiaresConferem(C4D36F95, new Decimal('0.9281'));
    assert.equal(r.confere, true);
    assert.equal(r.meu!.mul(100).toFixed(2), '92.81');
});

test('limiar que NÃO confere não publica piso nenhum', () => {
    // Se eu errei o E-Mode, o piso sai errado e com cara de medição. Melhor
    // dizer que não deu.
    const r = limiaresConferem(C4D36F95, new Decimal('0.8300'));
    assert.equal(r.confere, false);
    assert.match(r.leitura, /ERRO de .* pontos: não publico o piso/);
});

test('sem garantia contada não dá para conferir limiar nenhum', () => {
    const r = limiaresConferem([parte('WETH', 0, 500, 0.93)], new Decimal('0.9281'));
    assert.equal(r.confere, false);
    assert.equal(r.meu, null);
});
