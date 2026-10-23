/**
 * A EXCLUSAO NO MENOR ESCOPO, e a taxa entrando na CONTA em vez do descarte.
 *
 * Os dois pedidos dela desta rodada, e os dois nasceram de medicao:
 *
 *   *"Faça a exclusão no menor escopo comprovado... Não transforme uma taxa
 *   dependente do remetente em blacklist global."*  — porque `0x7787…734f`
 *   retem 479/1000 saindo de um pool e 0/1000 saindo de outro, medido no bloco
 *   52612934.
 *
 *   *"Não descarte automaticamente uma rota apenas porque existe taxa."*
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    Exclusoes, escopoDoVeredicto, recebidoEfetivo, type SondaDeToken,
} from './causaDaFalha';
import { descontar, brutoParaEntregar, sobraDaRota, type Rota, type PoolParaRota } from './rotas';

const sonda = (token: string, enviado: bigint, recebido: bigint): SondaDeToken => ({
    token, rodou: true, enviado, recebido, reverteu: false, porque: 'medido',
});
const recusa = (token: string): SondaDeToken => ({
    token, rodou: true, enviado: 100n, recebido: null, reverteu: true, porque: 'reverteu',
});

test('taxa MEDIDA exclui o PAR, e não o token em qualquer rota', () => {
    const e = escopoDoVeredicto(sonda('0xTOK', 1000n, 521n), '0xPOOLA');
    assert.equal(e.token, '0xtok');
    assert.equal(e.remetente, '0xpoola', 'perdeu o remetente: isso é blacklist global');
    assert.equal(e.retidoPorMil, 479);
    assert.equal(e.reverteu, false);

    const ex = new Exclusoes();
    ex.registrar(e);
    // O par MEDIDO esta coberto...
    assert.notEqual(ex.cobre('0xTOK', '0xPOOLA'), null);
    // ...e o outro par NAO. Era o defeito: o mesmo token entrega 100% saindo de
    // outro pool, e excluir ali apagaria rota que funciona.
    assert.equal(ex.cobre('0xTOK', '0xPOOLB'), null);
    // E sem saber quem manda nao se afirma nada.
    assert.equal(ex.cobre('0xTOK'), null);
});

test('transferência RECUSADA exclui o token em qualquer rota', () => {
    // Evidencia mais forte: um token que nao transfere entre contas arbitrarias
    // nao serve a flash swap nenhum, entao o escopo nao precisa do remetente.
    const e = escopoDoVeredicto(recusa('0xRUIM'), '0xPOOLA');
    assert.equal(e.remetente, null, 'restringiu ao par uma recusa que vale sempre');
    assert.equal(e.reverteu, true);
    assert.equal(e.retidoPorMil, null, 'inventou retenção para uma transferência que reverteu');

    const ex = new Exclusoes();
    ex.registrar(e);
    assert.notEqual(ex.cobre('0xRUIM', '0xQUALQUER'), null);
    assert.notEqual(ex.cobre('0xRUIM'), null);
});

test('o escopo GLOBAL engole os de par, e não o contrário', () => {
    const ex = new Exclusoes();
    ex.registrar(escopoDoVeredicto(sonda('0xT', 1000n, 900n), '0xP1'));
    ex.registrar(escopoDoVeredicto(recusa('0xT'), '0xP2'));
    assert.equal(ex.quantos, 1, 'guardou duas leituras do mesmo fato');
    assert.notEqual(ex.cobre('0xT', '0xOUTRO'), null);

    // E na ordem inversa o global NAO e rebaixado a par.
    const ex2 = new Exclusoes();
    ex2.registrar(escopoDoVeredicto(recusa('0xT'), '0xP2'));
    ex2.registrar(escopoDoVeredicto(sonda('0xT', 1000n, 900n), '0xP1'));
    assert.equal(ex2.quantos, 1);
    assert.equal(ex2.cobre('0xT', '0xQUALQUER')!.reverteu, true);
});

test('o mesmo par registrado duas vezes não duplica', () => {
    const ex = new Exclusoes();
    ex.registrar(escopoDoVeredicto(sonda('0xT', 1000n, 900n), '0xP1'));
    ex.registrar(escopoDoVeredicto(sonda('0xT', 2000n, 1800n), '0xP1'));
    assert.equal(ex.quantos, 1);
});

test('a frase separa exclusão de token de exclusão de PAR', () => {
    const ex = new Exclusoes();
    assert.match(ex.comoLer(), /nenhuma sonda comprovou uma ainda/);
    ex.registrar(escopoDoVeredicto(sonda('0xT', 1000n, 521n), '0xP1'));
    ex.registrar(escopoDoVeredicto(recusa('0xR'), '0xP2'));
    const f = ex.comoLer();
    assert.match(f, /1 do token em qualquer rota/);
    assert.match(f, /1 restrita\(s\) ao PAR medido/);
});

test('a retenção MEDIDA desconta, e `null` não é zero', () => {
    assert.equal(recebidoEfetivo(1000n, 479), 521n);
    assert.equal(descontar(1000n, 479), 521n);
    // `null` quer dizer "não medi": a conta NAO e alterada, e nao vira desconto
    // zero afirmado. As duas dao o mesmo numero aqui, e o motivo e diferente —
    // o que importa e que `null` nunca inventa retencao.
    assert.equal(descontar(1000n, null), 1000n);
    assert.equal(descontar(1000n, 0), 1000n);
    // Retencao total: nada chega. Nao e "nao medi".
    assert.equal(descontar(1000n, 1000), 0n);
});

test('o BRUTO a entregar arredonda PARA CIMA, senão o pool recusa', () => {
    // Com 10% retido, entregar 100 liquidos exige 112 (111,1 para cima): 111
    // entrega 99 e o pool reverte por um wei.
    assert.equal(brutoParaEntregar(100n, 100), 112n);
    assert.ok(descontar(brutoParaEntregar(100n, 100)!, 100) >= 100n);
    assert.ok(descontar(111n, 100) < 100n, 'o arredondamento para baixo entregaria curto');
    assert.equal(brutoParaEntregar(100n, null), 100n);
    // Retencao total: nao existe bruto que entregue. `null`, nao infinito.
    assert.equal(brutoParaEntregar(100n, 1000), null);
});

// O pool: 1000 de cada lado, taxa 30 por dez mil.
const pool = (endereco: string, t0: string, t1: string): PoolParaRota => ({
    endereco, token0: t0, token1: t1, reserva0: 10n ** 21n, reserva1: 10n ** 21n,
    tipo: 'v2', taxaPorDezMil: 30, fabrica: `f${endereco}`,
});

test('a taxa entra na SOBRA da rota: avaliada, não descartada', () => {
    const A = '0xaaa'; const B = '0xbbb';
    const r: Rota = {
        token: A,
        hops: [
            { pool: pool('0xp1', A, B), de: A, para: B },
            { pool: pool('0xp2', A, B), de: B, para: A },
        ],
        poolsDistintos: 2,
    };
    const semTaxa = sobraDaRota(r, 10n ** 18n);
    assert.notEqual(semTaxa, null);
    // Com 10% retido no token B, o que chega na venda e menor: a sobra CAI.
    const comTaxa = sobraDaRota(r, 10n ** 18n, undefined, (t) => (t === B ? 100 : null), '0xEU');
    assert.notEqual(comTaxa, null);
    assert.ok(comTaxa!.sobra < semTaxa!.sobra,
        'a taxa medida não mudou a sobra: a conta está ignorando o valor efetivo');
    // E a rota NAO foi descartada: ela tem um numero, que e o que permite
    // reprova-la pela conta em vez de pela existencia de taxa.
    assert.equal(typeof comTaxa!.sobra, 'bigint');
});

test('retenção `null` devolve exatamente a conta sem retenção', () => {
    // O portao que impede o conserto de mudar o caminho de quem nao mede taxa.
    const A = '0xaaa'; const B = '0xbbb';
    const r: Rota = {
        token: A,
        hops: [
            { pool: pool('0xp1', A, B), de: A, para: B },
            { pool: pool('0xp2', A, B), de: B, para: A },
        ],
        poolsDistintos: 2,
    };
    const sem = sobraDaRota(r, 10n ** 18n);
    const nula = sobraDaRota(r, 10n ** 18n, undefined, () => null, '0xEU');
    assert.deepEqual(nula, sem);
});
