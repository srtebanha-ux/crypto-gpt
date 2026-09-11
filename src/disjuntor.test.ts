// Arquivo: src/disjuntor.test.ts
//
// O teste que define este arquivo é o do disjuntor apertado demais. Com 45%
// de acerto — uma vantagem excelente — duas perdas seguidas acontecem a cada
// três operações. Um disjuntor que corta em duas desligaria o sistema BOM
// para sempre, e pareceria prudente fazendo isso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { estadoInicial, LIMITES_PADRAO, podeOperar, registrarResultado, virarODia, ajustarPorTransferencia } from './disjuntor';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const AGORA = 1_700_000_000_000;
const BANCA = new Decimal(55);

function comPerdas(n: number) {
    let e = estadoInicial(BANCA, AGORA);
    for (let i = 0; i < n; i += 1) {
        e = registrarResultado({ estado: e, limites: LIMITES_PADRAO, resultadoUsdt: new Decimal('-2'), agoraMs: AGORA });
    }
    return e;
}

test('conta nova opera', () => {
    const v = podeOperar({ estado: estadoInicial(BANCA, AGORA), limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: BANCA });
    assert.equal(v.podeOperar, true);
});

test('TRÊS perdas seguidas ainda operam — cortar antes desligaria o sistema bom', () => {
    const v = podeOperar({ estado: comPerdas(3), limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: BANCA });
    assert.equal(v.podeOperar, true);
    // Com 45% de acerto, três seguidas acontecem a cada seis operações.
});

test('quatro perdas seguidas desarmam por uma hora', () => {
    const v = podeOperar({ estado: comPerdas(4), limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: BANCA });
    assert.equal(v.podeOperar, false);
    if (!v.podeOperar) {
        assert.equal(v.permanente, false);
        assert.equal(v.religaEmMs, 3_600_000);
    }
});

test('um ganho zera a sequência — a contagem é de SEGUIDAS, não de total', () => {
    let e = comPerdas(3);
    e = registrarResultado({ estado: e, limites: LIMITES_PADRAO, resultadoUsdt: new Decimal('5'), agoraMs: AGORA });
    assert.equal(e.perdasSeguidas, 0);
    assert.equal(podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: BANCA }).podeOperar, true);
});

test('a pausa expira sozinha e o motor volta', () => {
    const e = comPerdas(4);
    const depois = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: AGORA + 3_600_001, bancaNoInicioDoDia: BANCA });
    assert.equal(depois.podeOperar, true);
});

test('perda de 15% no dia para até amanhã', () => {
    const e = { ...estadoInicial(BANCA, AGORA), resultadoDoDia: new Decimal('-8.25') }; // 15% de 55
    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: BANCA });
    assert.equal(v.podeOperar, false);
    if (!v.podeOperar) assert.equal(v.permanente, false);
});

test('virar o dia zera a perda diária mas NÃO o pico nem a sequência', () => {
    let e = { ...comPerdas(2), resultadoDoDia: new Decimal('-8') };
    e = virarODia(e, AGORA + 86_400_000);
    assert.equal(e.resultadoDoDia.toString(), '0');
    assert.equal(e.perdasSeguidas, 2);
    assert.equal(e.pico.toString(), '55');
    // O pico atravessa os dias: uma queda de 30% construída ao longo de uma
    // semana é tão fatal quanto uma feita numa tarde.
});

test('queda de 30% do pico é PERMANENTE — não religa sozinha', () => {
    const e = { ...estadoInicial(BANCA, AGORA), banca: new Decimal('38.5') }; // -30%
    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: BANCA });
    assert.equal(v.podeOperar, false);
    if (!v.podeOperar) {
        assert.equal(v.permanente, true);
        assert.match(v.motivo, /decisão de quem pôs o dinheiro/);
    }
});

test('a queda do pico tem prioridade sobre a pausa — nada pode mascará-la', () => {
    const e = { ...comPerdas(4), banca: new Decimal('38.5') };
    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: BANCA });
    assert.equal(v.podeOperar, false);
    if (!v.podeOperar) assert.equal(v.permanente, true); // permanente, não a pausa de 1h
});

test('o pico SOBE com o lucro — a referência acompanha a conta', () => {
    let e = estadoInicial(BANCA, AGORA);
    e = registrarResultado({ estado: e, limites: LIMITES_PADRAO, resultadoUsdt: new Decimal('45'), agoraMs: AGORA });
    assert.equal(e.pico.toString(), '100');
    // Agora a ruína é medida de 100, não dos 55 do depósito. Uma conta que
    // dobrou e devolveu tudo perdeu 50% — mesmo estando acima do inicial.
    e = registrarResultado({ estado: e, limites: LIMITES_PADRAO, resultadoUsdt: new Decimal('-31'), agoraMs: AGORA });
    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: new Decimal(100) });
    assert.equal(v.podeOperar, false);
    if (!v.podeOperar) assert.equal(v.permanente, true);
});

test('o pico NUNCA desce', () => {
    let e = estadoInicial(BANCA, AGORA);
    e = registrarResultado({ estado: e, limites: LIMITES_PADRAO, resultadoUsdt: new Decimal('-5'), agoraMs: AGORA });
    assert.equal(e.pico.toString(), '55');
});

test('banca zerada não divide por zero', () => {
    const e = { ...estadoInicial(new Decimal(0), AGORA), banca: new Decimal(0) };
    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: AGORA, bancaNoInicioDoDia: new Decimal(0) });
    assert.equal(v.podeOperar, true); // sem pico não há queda a medir
});

// ----------------------------------------------------------------------
// Saque e depósito — o bug que barrava o saque planejado
// ----------------------------------------------------------------------

test('sacar NÃO dispara o freio: o pico acompanha a banca', () => {
    // Banca no topo, saca R$1.000 de R$2.800. Sem o ajuste, a queda apareceria
    // como 35,7% e pararia tudo permanentemente.
    let e = estadoInicial(new Decimal('2800'), 0);
    e = ajustarPorTransferencia({ estado: e, bancaReal: new Decimal('1800') });

    assert.equal(e.banca.toString(), '1800');
    assert.equal(e.pico.toString(), '1800', 'o pico desce junto');

    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: 1, bancaNoInicioDoDia: new Decimal('1800') });
    assert.equal(v.podeOperar, true, 'sacar o próprio lucro não pode parar o robô');
});

test('a queda em PORCENTAGEM é preservada ao sacar durante uma baixa', () => {
    // Pico 1000, banca 900 (10% abaixo). Saca 300 -> banca 600.
    // Escalando: pico = 1000 * (600/900) = 666,66 -> 600 continua 10% abaixo.
    let e = estadoInicial(new Decimal('1000'), 0);
    e = registrarResultado({ estado: e, limites: LIMITES_PADRAO, resultadoUsdt: new Decimal('-100'), agoraMs: 1 });
    assert.equal(e.banca.toString(), '900');

    e = ajustarPorTransferencia({ estado: e, bancaReal: new Decimal('600') });
    const queda = e.pico.minus(e.banca).dividedBy(e.pico);
    // Compara contra uma tolerância em vez de casas decimais: o Decimal está
    // em ROUND_DOWN, então a divisão exata 1/10 vira 0,0999…9 e um toFixed(1)
    // mostraria "9.9". O que o teste precisa afirmar é a propriedade — a queda
    // continua sendo 10% e não 40% — não o arredondamento da exibição.
    assert.ok(queda.minus('0.10').abs().lessThan('0.0001'), `esperava ~10%, veio ${queda.mul(100).toFixed(4)}%`);
});

test('depósito acima do pico antigo não nasce "abaixo do pico"', () => {
    let e = estadoInicial(new Decimal('600'), 0);
    e = ajustarPorTransferencia({ estado: e, bancaReal: new Decimal('874') }); // aporte
    assert.equal(e.pico.toString(), '874');
    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: 1, bancaNoInicioDoDia: new Decimal('874') });
    assert.equal(v.podeOperar, true);
});

test('o ajuste NÃO apaga uma parada permanente já merecida', () => {
    // Caiu 40% de verdade e só depois sacou: continua parado, porque a queda
    // em porcentagem é preservada pelo reescalonamento.
    let e = estadoInicial(new Decimal('1000'), 0);
    e = registrarResultado({ estado: e, limites: LIMITES_PADRAO, resultadoUsdt: new Decimal('-400'), agoraMs: 1 });
    e = ajustarPorTransferencia({ estado: e, bancaReal: new Decimal('300') });

    const v = podeOperar({ estado: e, limites: LIMITES_PADRAO, agoraMs: 2, bancaNoInicioDoDia: new Decimal('300') });
    assert.equal(v.podeOperar, false);
    assert.equal(v.podeOperar === false && v.permanente, true, 'a queda real de 40% sobrevive ao saque');
});
