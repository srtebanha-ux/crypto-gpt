/**
 * O registro de tokens hostis. Cada regra vem de um defeito medido em fork.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Hostis, causaDaReversao, comoLerACausa, registroVazio, VERSAO_DO_REGISTRO,
} from './tokensHostis';

const T = '0x7787548c57031023c031304f274beda304da734f';
const OUTRO = '0xe2c6d87c468a62c5b554a7266ae62522228b26f6';
const base = { bloco: 52_612_196, rota: ['0xp1', '0xp2'], hashDoCodigo: '9018:0x60806040', retidoPorMil: null };

test('só condena a partir de simulação, e guarda token, rota, bloco e causa', () => {
    const h = new Hostis(() => 1_000);
    assert.equal(h.ehHostil(T), false, 'condenou sem simulação');
    h.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false });
    const v = h.veredicto(T);
    assert.ok(v !== null);
    assert.equal(v.token, T.toLowerCase());
    assert.equal(v.bloco, 52_612_196);
    assert.deepEqual(v.rota, ['0xp1', '0xp2']);
    assert.equal(v.em, 1_000);
    assert.match(comoLerACausa('taxaDeTransferencia'), /medido por transferência real/);
});

test('o veredicto INVALIDA quando o código do token muda', () => {
    // Taxa de transferência é propriedade do CÓDIGO, não do estado do pool:
    // expirar por bloco jogaria fora uma medição boa. O que muda o
    // comportamento é o código mudar — proxy que troca implementação, `pause`
    // levantado. Então a âncora é o código.
    const h = new Hostis();
    h.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false });
    assert.equal(h.ehHostil(T, '9018:0x60806040'), true, 'mesmo código: o veredicto vale');
    assert.equal(h.ehHostil(T, '12000:0x60806040'), false, 'código mudou: tinha de invalidar');
    // E invalidado de verdade: sai do registro.
    assert.equal(h.quantos, 0);
    // Hash desconhecido NÃO invalida: não saber não é prova de mudança.
    const h2 = new Hostis();
    h2.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false });
    assert.equal(h2.ehHostil(T, null), true);
    assert.equal(h2.ehHostil(T), true);
});

test('MEDIÇÃO não cede a ASSOCIAÇÃO', () => {
    // Uma rota de 4 pernas tem 3 tokens incomuns: se ela reverte, condenar os
    // três pune inocente. A distinção existe para o log não chamar suspeita de
    // prova — e um número medido não pode ser sobrescrito por um palpite.
    const h = new Hostis();
    h.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false, retidoPorMil: 480 });
    h.marcar({ ...base, token: T, causa: 'reversaoOpaca', porAssociacao: true });
    const v = h.veredicto(T)!;
    assert.equal(v.causa, 'taxaDeTransferencia');
    assert.equal(v.porAssociacao, false);
    assert.equal(v.retidoPorMil, 480);
    // O inverso vale: associação CEDE a medição.
    const h2 = new Hostis();
    h2.marcar({ ...base, token: T, causa: 'reversaoOpaca', porAssociacao: true });
    h2.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false, retidoPorMil: 480 });
    assert.equal(h2.veredicto(T)!.porAssociacao, false);
});

test('a frase diz quantos foram MEDIDOS e quantos por associação', () => {
    const h = new Hostis();
    assert.match(h.comoLer(), /nenhum token condenado/);
    assert.match(h.comoLer(), /NÃO é "não há token hostil"/);
    h.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false });
    h.marcar({ ...base, token: OUTRO, causa: 'invarianteDoPool', porAssociacao: true });
    const f = h.comoLer();
    assert.match(f, /1 MEDIDO\(S\) sobre o próprio token, 1 por ASSOCIAÇÃO/);
    assert.match(f, /pode.*excluir token inocente/);
});

test('a causa sai da mensagem da reversão, e ausência vira precaução declarada', () => {
    assert.equal(causaDaReversao("reverted with reason string 'UniswapV2: K'"), 'invarianteDoPool');
    assert.equal(causaDaReversao('Insufficient Account Balance'), 'saldoInsuficiente');
    assert.equal(causaDaReversao('SafeMath: subtraction overflow'), 'saldoInsuficiente');
    // Ausência NÃO é nada: vira veredicto de precaução, e a frase diz isso.
    assert.equal(causaDaReversao(undefined), 'reversaoOpaca');
    assert.equal(causaDaReversao(''), 'reversaoOpaca');
    assert.match(comoLerACausa('reversaoOpaca'), /PRECAUÇÃO e não por prova/);
});

test('rota com token condenado é detectada, e o veredicto vem junto', () => {
    const h = new Hostis();
    h.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false });
    const r = h.rotaTemHostil(['0x4200000000000000000000000000000000000006', T]);
    assert.equal(r.tem, true);
    assert.equal(r.qual!.token, T.toLowerCase());
    assert.equal(h.rotaTemHostil(['0x4200000000000000000000000000000000000006']).tem, false);
});

test('round-trip pelo disco, e arquivo torto não lança', () => {
    const h = new Hostis();
    h.marcar({ ...base, token: T, causa: 'taxaDeTransferencia', porAssociacao: false, retidoPorMil: 480 });
    const d = JSON.parse(JSON.stringify(h.paraDisco()));
    const h2 = new Hostis();
    h2.doDisco(d);
    assert.deepEqual(h2.veredicto(T), h.veredicto(T));
    assert.equal(d.versao, VERSAO_DO_REGISTRO);
    for (const lixo of [null, undefined, 42, 'x', [], { porToken: 'nao' }, { porToken: { a: 1 } }]) {
        const h3 = new Hostis();
        h3.doDisco(lixo);
        assert.equal(h3.quantos, 0, `${JSON.stringify(lixo)} produziu veredicto falso`);
    }
    // Registro VELHO sem `porAssociacao` lê como ASSOCIAÇÃO: duvidar é mais
    // honesto que afirmar medição que não se tem.
    const h4 = new Hostis();
    h4.doDisco({ porToken: { [T]: { token: T, causa: 'invarianteDoPool', bloco: 1, em: 1 } } });
    assert.equal(h4.veredicto(T)!.porAssociacao, true);
    assert.equal(registroVazio().versao, VERSAO_DO_REGISTRO);
});
