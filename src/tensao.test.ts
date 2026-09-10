// Arquivo: src/tensao.test.ts
//
// O teste central deste arquivo é o que separa dois gráficos IDÊNTICOS: a
// mesma queda de 8%, uma com Open Interest despencando junto e outra com OI
// subindo. Nenhum indicador de preço distingue as duas. São fenômenos opostos
// — posição sendo destruída à força versus posição sendo criada por convicção
// — e só uma delas tem motivo mecânico para reverter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { classificarRegime, medirTensao, quedaOperavel } from './tensao';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

function amostra(preco: string, oi: string) {
    return { emMs: 0, preco: new Decimal(preco), openInterest: new Decimal(oi), funding: new Decimal(0) };
}

test('preço cai e OI cai junto = CASCATA — a assinatura da liquidação forçada', () => {
    const c = classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '900') });
    assert.equal(c.regime, 'cascata');
    assert.equal(c.variacaoDePreco.mul(100).toFixed(0), '-8');
    assert.equal(c.variacaoDeOi.mul(100).toFixed(0), '-10');
});

test('a MESMA queda com OI subindo = DISTRIBUIÇÃO, não cascata', () => {
    const c = classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '1100') });
    assert.equal(c.regime, 'distribuicao');
    // Gráfico idêntico ao teste anterior. Vendedores NOVOS entrando não
    // deixam vácuo — deixam ordens.
});

test('preço sobe e OI cai = realização; sobe e OI sobe = acumulação', () => {
    assert.equal(classificarRegime({ antes: amostra('100', '1000'), agora: amostra('108', '900') }).regime, 'realizacao');
    assert.equal(classificarRegime({ antes: amostra('100', '1000'), agora: amostra('108', '1100') }).regime, 'acumulacao');
});

test('movimento pequeno demais NÃO é classificado — regime inventado entra na conta como se fosse dado', () => {
    const c = classificarRegime({ antes: amostra('100', '1000'), agora: amostra('100.2', '900') });
    assert.equal(c.regime, 'indefinido');
    assert.equal(c.intensidade.toString(), '0');
});

test('a intensidade mede quanta posição sumiu POR unidade de preço', () => {
    const forte = classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '840') }); // -8% preço, -16% OI
    const fraca = classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '980') }); // -8% preço, -2% OI
    assert.equal(forte.intensidade.toFixed(1), '2.0');
    assert.equal(fraca.intensidade.toFixed(2), '0.25');
});

test('preço ou OI zerados devolvem indefinido em vez de dividir por zero', () => {
    assert.equal(classificarRegime({ antes: amostra('0', '1000'), agora: amostra('92', '900') }).regime, 'indefinido');
    assert.equal(classificarRegime({ antes: amostra('100', '0'), agora: amostra('92', '900') }).regime, 'indefinido');
});

test('funding de 0,05% por período é 54,7% ao ano — mercado torto', () => {
    const t = medirTensao({ funding: new Decimal('0.0005') });
    assert.equal(t.tenso, true);
    assert.equal(t.ladoLotado, 'comprados');
    assert.equal(t.fundingAnualizado.mul(100).toFixed(1), '54.7');
});

test('funding NEGATIVO é a mesma tensão do outro lado', () => {
    const t = medirTensao({ funding: new Decimal('-0.0005') });
    assert.equal(t.tenso, true);
    assert.equal(t.ladoLotado, 'vendidos');
});

test('funding normal não é tensão', () => {
    const t = medirTensao({ funding: new Decimal('0.0001') }); // 10,95% ao ano
    assert.equal(t.tenso, false);
    assert.equal(t.ladoLotado, 'nenhum');
});

test('distribuição é RECUSADA mesmo com a queda sendo grande', () => {
    const r = quedaOperavel({
        classificacao: classificarRegime({ antes: amostra('100', '1000'), agora: amostra('88', '1200') }),
        tensao: medirTensao({ funding: new Decimal('0.0005') }),
    });
    assert.equal(r.operavel, false);
    assert.match(r.motivo, /repique mecânico/);
});

test('cascata fraca é recusada: pouca posição destruída, pouco vácuo', () => {
    const r = quedaOperavel({
        classificacao: classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '985') }),
        tensao: medirTensao({ funding: new Decimal('0.0005') }),
    });
    assert.equal(r.operavel, false);
    assert.match(r.motivo, /Cascata fraca/);
});

test('cascata forte em mercado EQUILIBRADO é recusada — falta combustível', () => {
    const r = quedaOperavel({
        classificacao: classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '840') }),
        tensao: medirTensao({ funding: new Decimal('0.00005') }),
    });
    assert.equal(r.operavel, false);
    assert.match(r.motivo, /não estava torto/);
});

test('cascata de QUEDA com os vendidos lotados é recusada — o combustível está do outro lado', () => {
    const r = quedaOperavel({
        classificacao: classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '840') }),
        tensao: medirTensao({ funding: new Decimal('-0.0005') }),
    });
    assert.equal(r.operavel, false);
    assert.match(r.motivo, /minoria/);
});

test('as quatro condições juntas liberam — e só elas', () => {
    const r = quedaOperavel({
        classificacao: classificarRegime({ antes: amostra('100', '1000'), agora: amostra('92', '840') }),
        tensao: medirTensao({ funding: new Decimal('0.0005') }),
    });
    assert.equal(r.operavel, true);
    assert.match(r.motivo, /2.00x/);
});
