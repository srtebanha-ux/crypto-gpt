/**
 * A taxonomia causal. A regra que decide tudo: só evidência ISOLADA sobre a
 * peça exclui a peça. Tudo mais exclui a rota e nada mais.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    julgarFalha, retidoPorMil, comoLerOVeredicto,
    type SondaDeToken, type SondaDePool, type Evidencia,
} from './causaDaFalha';

const limpo = (t: string): SondaDeToken => ({
    token: t, rodou: true, enviado: 1000n, recebido: 1000n, reverteu: false,
    porque: 'transferência direta entregou tudo',
});
const taxado = (t: string, retem: bigint): SondaDeToken => ({
    token: t, rodou: true, enviado: 1000n, recebido: 1000n - retem, reverteu: false,
    porque: 'medido',
});
const poolOk = (p: string): SondaDePool => ({ pool: p, rodou: true, passou: true, porque: 'swap de uma perna passou' });
const ev = (e: Partial<Evidencia>): Evidencia => ({
    tokens: [], pools: [], mensagemDaRota: 'reverted', ...e,
});

test('TOKEN_HOSTIL exige evidência sobre O TOKEN, e condena só ele', () => {
    // O defeito que isto conserta: duas rotas revertidas condenaram CINCO
    // tokens e excluíram 1.254 de 1.256 candidatos. Uma rota de 4 pernas tem
    // três tokens incomuns — o culpado é UM.
    const v = julgarFalha(ev({
        tokens: [limpo('0xA'), taxado('0xB', 480n), limpo('0xC')],
        pools: [poolOk('0xp1'), poolOk('0xp2')],
    }));
    assert.equal(v.causa, 'TOKEN_HOSTIL');
    assert.deepEqual(v.culpados, ['0xB'], 'condenou token que passou na sonda');
    assert.equal(v.excluiPermanentemente, true);
    assert.match(v.porque, /retém 480\/1000/);
    assert.match(v.porque, /NÃO são condenados/);
});

test('transferência RECUSADA também é TOKEN_HOSTIL, e é medida', () => {
    const v = julgarFalha(ev({
        tokens: [limpo('0xA'), { ...limpo('0xB'), reverteu: true, porque: 'reverteu' }],
        pools: [poolOk('0xp1')],
    }));
    assert.equal(v.causa, 'TOKEN_HOSTIL');
    assert.deepEqual(v.culpados, ['0xB']);
    assert.match(v.porque, /RECUSA transferência/);
});

test('POOL_INCOMPATÍVEL só quando TODOS os tokens passaram', () => {
    const v = julgarFalha(ev({
        tokens: [limpo('0xA'), limpo('0xB')],
        pools: [poolOk('0xp1'), { pool: '0xp2', rodou: true, passou: false, porque: 'swap reverteu' }],
    }));
    assert.equal(v.causa, 'POOL_INCOMPATIVEL');
    assert.deepEqual(v.culpados, ['0xp2']);
    assert.equal(v.excluiPermanentemente, true);
    // E nenhum TOKEN entra na lista: eles passaram.
    assert.ok(!v.culpados.some((c) => c === '0xA' || c === '0xB'));
});

test('token hostil tem PRECEDÊNCIA sobre pool: a evidência mais forte decide', () => {
    const v = julgarFalha(ev({
        tokens: [taxado('0xB', 100n)],
        pools: [{ pool: '0xp2', rodou: true, passou: false, porque: 'swap reverteu' }],
    }));
    // Com um token taxado, o pool recusar é CONSEQUÊNCIA — condenar o pool
    // seria culpar quem reagiu certo.
    assert.equal(v.causa, 'TOKEN_HOSTIL');
    assert.deepEqual(v.culpados, ['0xB']);
});

test('sonda que NÃO RODOU vira CAUSA_DESCONHECIDA e condena NADA', () => {
    // O único veredicto honesto quando não deu para isolar. Excluir sem prova
    // é exatamente o que produziu os 1.254 descartes.
    const v = julgarFalha(ev({
        tokens: [limpo('0xA'), { token: '0xB', rodou: false, enviado: null, recebido: null, reverteu: false, porque: 'sem detentor' }],
        pools: [poolOk('0xp1')],
    }));
    assert.equal(v.causa, 'CAUSA_DESCONHECIDA');
    assert.deepEqual(v.culpados, []);
    assert.equal(v.excluiPermanentemente, false);
    assert.match(v.porque, /eu NÃO SEI de quem é a falha/);
    // Pool que não rodou também.
    const v2 = julgarFalha(ev({
        tokens: [limpo('0xA')],
        pools: [{ pool: '0xp1', rodou: false, passou: false, porque: 'não deu' }],
    }));
    assert.equal(v2.causa, 'CAUSA_DESCONHECIDA');
    assert.deepEqual(v2.culpados, []);
});

test('ERRO_DO_EXECUTOR quando as peças passam e a mensagem é de CONTA nossa', () => {
    // Condenar o token aqui esconderia o nosso bug — e foi assim que o
    // `Insufficient Account Balance` virou "token hostil" na primeira versão.
    for (const m of ['Insufficient Account Balance', 'SafeMath: subtraction overflow',
        'reverted with custom error HopSemSaida()']) {
        const v = julgarFalha(ev({
            tokens: [limpo('0xA'), limpo('0xB')], pools: [poolOk('0xp1')], mensagemDaRota: m,
        }));
        assert.equal(v.causa, 'ERRO_DO_EXECUTOR', `"${m}" não foi lido como erro nosso`);
        assert.deepEqual(v.culpados, []);
        assert.equal(v.excluiPermanentemente, false);
        assert.match(v.porque, /esconderia o nosso defeito/);
    }
});

test('ROTA_REVERTIDA quando tudo passa e a COMBINAÇÃO não fecha', () => {
    const v = julgarFalha(ev({
        tokens: [limpo('0xA'), limpo('0xB')],
        pools: [poolOk('0xp1'), poolOk('0xp2')],
        mensagemDaRota: "reverted with reason string 'UniswapV2: K'",
    }));
    assert.equal(v.causa, 'ROTA_REVERTIDA');
    assert.deepEqual(v.culpados, [], 'condenou peça numa falha de combinação');
    assert.equal(v.excluiPermanentemente, false);
    assert.match(v.porque, /as peças seguem elegíveis em outras rotas/);
});

// MEDIDO em 2026-10-14, no bloco 52612934: uma rota com as tres pecas limpas
// reverteu com "Transaction reverted without a reason string", e `julgarFalha`
// publicava ROTA_REVERTIDA dizendo "a COMBINAÇÃO não fecha". E afirmar a causa
// a partir de uma reversao OPACA — a assinatura de defeito deste projeto.
test('reversão OPACA com peças limpas é CAUSA_DESCONHECIDA, não ROTA_REVERTIDA', () => {
    const v = julgarFalha(ev({
        tokens: [limpo('0xA'), limpo('0xB')],
        pools: [poolOk('0xp1'), poolOk('0xp2')],
        mensagemDaRota: 'Transaction reverted without a reason string',
    }));
    assert.equal(v.causa, 'CAUSA_DESCONHECIDA');
    assert.deepEqual(v.culpados, [], 'condenou peça a partir de reversão opaca');
    assert.equal(v.excluiPermanentemente, false);
    assert.match(v.porque, /não identifica causa/);
});

// E a ponta oposta: a recusa IDENTIFICADA continua sendo ROTA_REVERTIDA. Sem
// isto, o conserto acima transformaria toda falha de combinacao em "não sei",
// que e a mesma perda de informacao na direcao contraria.
test('as recusas que IDENTIFICAM a combinação seguem ROTA_REVERTIDA', () => {
    for (const m of [
        "reverted with reason string 'UniswapV2: K'",
        'reverted with reason string \'UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT\'',
        'reverted with custom error \'LucroInsuficiente(1,2)\'',
    ]) {
        const v = julgarFalha(ev({
            tokens: [limpo('0xA')],
            pools: [poolOk('0xp1')],
            mensagemDaRota: m,
        }));
        assert.equal(v.causa, 'ROTA_REVERTIDA', `"${m}" deixou de identificar a combinação`);
        assert.deepEqual(v.culpados, []);
    }
});

test('o retido é MEDIDO, e `null` quando a sonda não rodou', () => {
    assert.equal(retidoPorMil(limpo('0xA')), 0);
    assert.equal(retidoPorMil(taxado('0xB', 480n)), 480);
    assert.equal(retidoPorMil({ ...limpo('0xA'), rodou: false }), null);
    assert.equal(retidoPorMil({ ...limpo('0xA'), enviado: null }), null);
    // Recebeu MAIS do que mandou (token com rebase positivo): zero retido, e
    // não um número negativo que leria como bônus.
    assert.equal(retidoPorMil({ ...limpo('0xA'), recebido: 1100n }), 0);
});

test('a frase diz se a exclusão é da PEÇA ou só da ROTA', () => {
    const peca = comoLerOVeredicto(julgarFalha(ev({
        tokens: [taxado('0xB', 480n)], pools: [poolOk('0xp1')],
    })));
    assert.match(peca, /EXCLUI a peça de todas as rotas/);
    const rota = comoLerOVeredicto(julgarFalha(ev({
        tokens: [limpo('0xA')], pools: [poolOk('0xp1')],
        mensagemDaRota: "reason string 'UniswapV2: K'",
    })));
    assert.match(rota, /exclui SÓ esta rota/);
});

// MEDIDO em 2026-10-14, bloco 52612934, `forkTests/aRotaOpaca.js`: a unica rota
// opaca reverteu na profundidade 4 e o `CALL` que entrou nela aponta para o
// WETH. Um token que entrega exatamente o que manda so recusa por saldo
// insuficiente — e a mesma rota com piso ZERO reverteu igual, entao nao foi o
// piso. Isso e identificacao POSITIVA de erro nosso, e sai de CAUSA_DESCONHECIDA.
test('o trace apontando um token LIMPO é ERRO_DO_EXECUTOR, não desconhecido', () => {
    const v = julgarFalha(ev({
        tokens: [limpo('0x4200000000000000000000000000000000000006'), limpo('0xB')],
        pools: [poolOk('0xp1'), poolOk('0xp2')],
        mensagemDaRota: 'Transaction reverted without a reason string',
        origemDoTrace: {
            endereco: '0x4200000000000000000000000000000000000006',
            eTokenLimpo: true,
            ePool: false,
        },
    }));
    assert.equal(v.causa, 'ERRO_DO_EXECUTOR');
    assert.deepEqual(v.culpados, [], 'condenou peça por um erro nosso');
    assert.equal(v.excluiPermanentemente, false);
    assert.match(v.porque, /o defeito é a nossa conta/);
});

// E a ponta oposta: trace apontando um POOL nao vira erro nosso. Sem isto o
// ramo acima engoliria a evidencia que aponta para outro lado.
test('o trace apontando um POOL não é lido como erro do executor', () => {
    const v = julgarFalha(ev({
        tokens: [limpo('0xA')],
        pools: [poolOk('0xp1')],
        mensagemDaRota: 'Transaction reverted without a reason string',
        origemDoTrace: { endereco: '0xp1', eTokenLimpo: false, ePool: true },
    }));
    assert.equal(v.causa, 'CAUSA_DESCONHECIDA');
    assert.deepEqual(v.culpados, []);
});

// AUSENCIA DE TRACE nao vira veredicto: sem `origemDoTrace` o caso opaco segue
// desconhecido. E o default que este arquivo persegue — campo ausente lido como
// se fosse resposta ja custou sete tiros neste projeto.
test('sem trace, o caso opaco continua CAUSA_DESCONHECIDA', () => {
    for (const origem of [undefined, null]) {
        const v = julgarFalha(ev({
            tokens: [limpo('0xA')],
            pools: [poolOk('0xp1')],
            mensagemDaRota: 'Transaction reverted without a reason string',
            origemDoTrace: origem,
        }));
        assert.equal(v.causa, 'CAUSA_DESCONHECIDA', `origem ${String(origem)} virou veredicto`);
    }
});
