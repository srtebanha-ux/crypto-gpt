// Arquivo: src/ricochete.test.ts
//
// O teste que carrega este arquivo é o do TETO. Entrar num repique tarde
// demais não é uma entrada pior — é uma entrada que perdeu a única coisa que
// justificava a operação: a liquidação ficar abaixo de um fundo que o mercado
// acabou de rejeitar. Acima de 2,91% de repique (a 30x), a liquidação sobe
// para cima do fundo e um simples reteste zera a posição.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { janelaDeEntrada, liquidacaoVsFundo, parametrosPadrao, passoDoRicochete } from './ricochete';
import { Vela1m } from './volumeSpike';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const CFG = parametrosPadrao({ alavancagem: new Decimal(30) });

function vela(abertura: string, maxima: string, minima: string, fechamento: string): Vela1m {
    return {
        aberturaMs: 0,
        abertura: new Decimal(abertura),
        maxima: new Decimal(maxima),
        minima: new Decimal(minima),
        fechamento: new Decimal(fechamento),
        volume: new Decimal(1),
    };
}

test('a 30x a janela de entrada é de 2,91% — o número que define a estratégia', () => {
    const j = janelaDeEntrada({ alavancagem: new Decimal(30), manutencao: new Decimal('0.005') });
    assert.equal(j.mul(100).toFixed(2), '2.91');
});

test('a janela ABRE quando a alavancagem cai — não é uma constante', () => {
    const j20 = janelaDeEntrada({ alavancagem: new Decimal(20), manutencao: new Decimal('0.005') });
    const j10 = janelaDeEntrada({ alavancagem: new Decimal(10), manutencao: new Decimal('0.005') });
    assert.equal(j20.mul(100).toFixed(2), '4.71');
    assert.equal(j10.mul(100).toFixed(2), '10.49');
    // Fixar 2,91% no código quebraria em silêncio ao mudar a alavancagem.
});

test('entrando a +2% do fundo, a liquidação fica 0,89% ABAIXO dele', () => {
    const v = liquidacaoVsFundo({
        entrada: new Decimal(102),
        fundo: new Decimal(100),
        alavancagem: new Decimal(30),
        manutencao: new Decimal('0.005'),
    });
    assert.equal(v.mul(100).toFixed(2), '-0.89');
});

test('entrando a +3,5%, a liquidação vira PARA CIMA do fundo — a proteção some', () => {
    const v = liquidacaoVsFundo({
        entrada: new Decimal('103.5'),
        fundo: new Decimal(100),
        alavancagem: new Decimal(30),
        manutencao: new Decimal('0.005'),
    });
    assert.equal(v.isPositive(), true);
    // Um reteste do fundo — o movimento mais comum depois de uma agulhada —
    // liquidaria a posição.
});

test('queda abaixo do gatilho não abre evento', () => {
    const r = passoDoRicochete({ estado: null, vela: vela('100', '100', '95', '96'), agoraMs: 0, cfg: CFG });
    assert.equal(r.estado, null);
    assert.equal(r.sinal, null);
});

test('queda de 8% abre o evento e marca o fundo pela MÍNIMA', () => {
    const r = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 1000, cfg: CFG });
    assert.equal(r.estado?.fase, 'caindo');
    assert.equal(r.estado?.fundo.toString(), '92');
    assert.equal(r.sinal, null); // não compra a queda
});

test('repique de 2% dentro da janela DISPARA', () => {
    const aberto = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG });
    const r = passoDoRicochete({
        estado: aberto.estado,
        vela: vela('93', '94', '93', '93.85'), // 93,85 / 92 = +2,01%
        agoraMs: 60_000,
        cfg: CFG,
    });
    assert.equal(r.sinal !== null, true);
    assert.equal(r.sinal?.repique.mul(100).toFixed(2), '2.01');
    assert.equal(r.sinal?.liquidacaoVsFundo.isNegative(), true);
});

test('repique ACIMA do teto é descartado — não é entrada pior, é entrada sem proteção', () => {
    const aberto = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG });
    const r = passoDoRicochete({
        estado: aberto.estado,
        vela: vela('93', '96', '93', '95.5'), // 95,5 / 92 = +3,8%, acima do teto
        agoraMs: 60_000,
        cfg: CFG,
    });
    assert.equal(r.sinal, null);
    assert.equal(r.estado, null); // evento morre, não fica esperando
});

test('repique abaixo do piso MANTÉM o evento vivo — ainda pode chegar lá', () => {
    const aberto = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG });
    const r = passoDoRicochete({
        estado: aberto.estado,
        vela: vela('93', '93.2', '92.5', '93'), // +1,08%
        agoraMs: 60_000,
        cfg: CFG,
    });
    assert.equal(r.sinal, null);
    assert.equal(r.estado?.fase, 'caindo');
});

test('fundo NOVO reinicia o relógio — o erro que a confirmação existia para evitar', () => {
    const aberto = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG });
    const maisFundo = passoDoRicochete({
        estado: aberto.estado,
        vela: vela('93', '93', '88', '89'),
        agoraMs: 60_000,
        cfg: CFG,
    });
    assert.equal(maisFundo.estado?.fundo.toString(), '88');
    assert.equal(maisFundo.estado?.fundoEmMs, 60_000);
    assert.equal(maisFundo.sinal, null);
    // Sem isso, o motor compraria o primeiro repique de 2% no MEIO de uma
    // cascata em curso — exatamente a faca caindo que a confirmação evita.
});

test('o repique passa a ser medido a partir do fundo NOVO, não do antigo', () => {
    let e = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG }).estado;
    e = passoDoRicochete({ estado: e, vela: vela('93', '93', '88', '89'), agoraMs: 60_000, cfg: CFG }).estado;
    // 89,8 é +2,05% sobre 88, mas ainda −2,4% abaixo do fundo antigo de 92.
    const r = passoDoRicochete({ estado: e, vela: vela('89', '90', '89', '89.8'), agoraMs: 120_000, cfg: CFG });
    assert.equal(r.sinal !== null, true);
    assert.equal(r.sinal?.repique.mul(100).toFixed(2), '2.04');
});

test('sem repique dentro da janela, o evento é descartado: foi degrau, não mola', () => {
    const aberto = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG });
    const r = passoDoRicochete({
        estado: aberto.estado,
        vela: vela('93', '93.1', '92.5', '92.8'),
        agoraMs: 6 * 60_000, // janela padrão é 5 min
        cfg: CFG,
    });
    assert.equal(r.estado, null);
    assert.equal(r.sinal, null);
});

test('depois de disparado, não dispara de novo no mesmo evento', () => {
    const aberto = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG });
    const disparou = passoDoRicochete({ estado: aberto.estado, vela: vela('93', '94', '93', '93.85'), agoraMs: 60_000, cfg: CFG });
    const denovo = passoDoRicochete({ estado: disparou.estado, vela: vela('94', '95', '94', '94.5'), agoraMs: 90_000, cfg: CFG });
    assert.equal(denovo.sinal, null);
});

test('a queda relatada é medida da referência até o fundo, não da vela do disparo', () => {
    const aberto = passoDoRicochete({ estado: null, vela: vela('100', '100', '92', '93'), agoraMs: 0, cfg: CFG });
    const r = passoDoRicochete({ estado: aberto.estado, vela: vela('93', '94', '93', '93.85'), agoraMs: 60_000, cfg: CFG });
    assert.equal(r.sinal?.queda.mul(100).toFixed(0), '8');
});

test('abertura zero não quebra a divisão', () => {
    const r = passoDoRicochete({ estado: null, vela: vela('0', '0', '0', '0'), agoraMs: 0, cfg: CFG });
    assert.equal(r.estado, null);
});

test('o teto padrão é 90% do teórico — folga para o preço andar até o preenchimento', () => {
    assert.equal(CFG.repiqueMaximo.mul(100).toFixed(2), '2.62');
    assert.equal(CFG.repiqueMinimo.mul(100).toFixed(2), '2.00');
    // A janela útil real é de 62 pontos-base, não 91.
});
