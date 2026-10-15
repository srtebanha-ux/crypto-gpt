/**
 * O DETECTOR DE ARBITRAGEM REAL — e o falso positivo que ele barra.
 *
 * Em 2026-10-15 a primeira versao deste detector classificou a transacao
 * `0x71bd1ca0…` como arbitragem lucrativa de 84164529669566 wei de WETH. NAO
 * era: um usuario vendeu um token com taxa e o contrato do token desviou a taxa
 * em WETH. Volume de outra pessoa entrando como lucro nosso.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deltasDosTransfers, quemLevouLucro, custoDoRecibo, liquidoEmWeth,
    candidatasDosLogs, TOPICO_DE_SWAP, TOPICO_TRANSFER, type Log,
} from './quemGanha';

const WETH = '0x4200000000000000000000000000000000000006';
const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ARB = '0xcccccccccccccccccccccccccccccccccccccccc';
const USUARIO = '0xdddddddddddddddddddddddddddddddddddddddd';
const TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const p32 = (a: string): string => `0x${a.replace('0x', '').padStart(64, '0')}`;
const transfer = (token: string, de: string, para: string, v: bigint, tx = '0xt'): Log => ({
    address: token,
    topics: [TOPICO_TRANSFER, p32(de), p32(para)],
    data: `0x${v.toString(16)}`,
    transactionHash: tx,
    blockNumber: '0x1',
    logIndex: '0x0',
});
const swap = (pool: string, tx = '0xt'): Log => ({
    address: pool,
    topics: [TOPICO_DE_SWAP.v2],
    data: '0x',
    transactionHash: tx,
    blockNumber: '0x1',
    logIndex: '0x0',
});

test('uma troca só NÃO é candidata; duas são', () => {
    assert.equal(candidatasDosLogs([swap(POOL_A)]).length, 0);
    const c = candidatasDosLogs([swap(POOL_A), swap(POOL_B)]);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.trocas.length, 2);
});

test('ciclo FECHADO: só pools perdem, e o operador leva lucro', () => {
    // O operador manda token ao pool B, recebe WETH; manda WETH ao pool A,
    // recebe token. Fecha com mais WETH do que comecou.
    const logs = [
        transfer(WETH, POOL_A, ARB, 100n),
        transfer(TOKEN, ARB, POOL_B, 50n),
        transfer(TOKEN, POOL_A, ARB, 50n),
        transfer(WETH, POOL_B, ARB, 110n),
        transfer(WETH, ARB, POOL_A, 100n),
    ];
    const g = quemLevouLucro(deltasDosTransfers(logs), new Set([POOL_A, POOL_B]));
    assert.equal(g.length, 1, 'não achou o operador do ciclo fechado');
    assert.equal(g[0]!.endereco, ARB);
    const weth = g[0]!.ganhos.find((x) => x.token === WETH);
    assert.equal(weth?.quanto, 110n, 'o lucro não é o delta de WETH do operador');
});

test('TAXA DE TOKEN não é arbitragem: alguém de FORA perdeu', () => {
    // O caso real `0x71bd1ca0…`, reduzido: o usuario vende, e um endereco
    // recebe taxa em WETH. Duas trocas, ninguem mais negativo além do usuário —
    // e e exatamente isso que desqualifica.
    const logs = [
        transfer(TOKEN, USUARIO, POOL_A, 1000n),
        transfer(WETH, POOL_A, ARB, 84n),
        transfer(WETH, POOL_A, USUARIO, 900n),
    ];
    const g = quemLevouLucro(deltasDosTransfers(logs), new Set([POOL_A]));
    assert.deepEqual(g, [],
        'contou taxa de token como lucro de arbitragem: volume de terceiro virando '
        + 'oportunidade nossa');
});

test('o usuário só RECEBER não desqualifica (ninguém de fora perdeu)', () => {
    // O portao e sobre PERDA de fora, nao sobre ganho de fora: um cofre que
    // recebe o lucro e um endereco de fora com delta positivo, e isso e legitimo.
    const logs = [
        transfer(WETH, POOL_A, ARB, 100n),
        transfer(WETH, ARB, USUARIO, 100n),
    ];
    const g = quemLevouLucro(deltasDosTransfers(logs), new Set([POOL_A]));
    assert.equal(g.length, 1);
    assert.equal(g[0]!.endereco, USUARIO);
});

test('o custo vem do RECIBO, e `l1Fee` ausente não vira zero silencioso', () => {
    const c = custoDoRecibo({ gasUsed: '0x10', effectiveGasPrice: '0x2', l1Fee: '0x5' });
    assert.equal(c!.l2Wei, 32n);
    assert.equal(c!.l1Wei, 5n);
    assert.equal(c!.totalWei, 37n);
    // Sem `effectiveGasPrice` nao ha custo calculavel: `null`, nao zero.
    assert.equal(custoDoRecibo({ gasUsed: '0x10' }), null);
});

test('o líquido só existe quando o ganho é em WETH', () => {
    const g = { endereco: ARB, ganhos: [{ token: WETH, quanto: 100n }] };
    assert.equal(liquidoEmWeth(g, 40n, WETH), 60n);
    // Ganho em outro token: `null`, porque converter sem preco seria inventar.
    const outro = { endereco: ARB, ganhos: [{ token: TOKEN, quanto: 100n }] };
    assert.equal(liquidoEmWeth(outro, 40n, WETH), null);
});
