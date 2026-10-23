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
    ajusteDeWeth, deltasReconciliados, precisaDeSaldoNativo,
    TOPICO_WETH_DEPOSIT, TOPICO_WETH_WITHDRAWAL, POOL_MANAGER_V4,
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

// MEDIDO em 2026-10-15 na transacao `0x87724fb1…`: o WETH9 nao emite `Transfer`
// ao embrulhar nem ao desembrulhar, e por isso o benchmark leu +0,00205 WETH
// onde o liquido real era ZERO de WETH. Erro de ~800x no numero que escolhe a
// amostra.
test('wrap/unwrap de WETH entra na conta — `Transfer` sozinho erra', () => {
    const POOL = '0x1111111111111111111111111111111111111111';
    const BENEF = '0x2222222222222222222222222222222222222222';
    const wad = 2050547563717009n;
    const logs: Log[] = [
        // O pool manda WETH ao beneficiario...
        {
            address: WETH, topics: [TOPICO_TRANSFER, p32(POOL), p32(BENEF)],
            data: `0x${wad.toString(16)}`, transactionHash: '0xt',
            blockNumber: '0x1', logIndex: '0x0',
        },
        // ...e ele desembrulha TUDO. Sem `Transfer` nenhum.
        {
            address: WETH, topics: [TOPICO_WETH_WITHDRAWAL, p32(BENEF)],
            data: `0x${wad.toString(16)}`, transactionHash: '0xt',
            blockNumber: '0x1', logIndex: '0x1',
        },
    ];
    // Só por `Transfer`: pareceria lucro.
    const soTransfer = deltasDosTransfers(logs).get(WETH)!.get(BENEF);
    assert.equal(soTransfer, wad);
    // Reconciliado: ZERO.
    const { deltas, precisaNativo } = deltasReconciliados(logs, WETH);
    assert.equal(deltas.get(WETH)!.get(BENEF), 0n,
        'o desembrulho não foi descontado: é o erro de 800x do benchmark');
    assert.equal(precisaNativo, true,
        'houve unwrap e a transação não foi marcada como precisando de saldo nativo');
});

test('o embrulho conta ao contrário, e o nativo tem sinal oposto', () => {
    const BENEF = '0x2222222222222222222222222222222222222222';
    const logs: Log[] = [{
        address: WETH, topics: [TOPICO_WETH_DEPOSIT, p32(BENEF)],
        data: '0x64', transactionHash: '0xt', blockNumber: '0x1', logIndex: '0x0',
    }];
    const aj = ajusteDeWeth(logs, WETH);
    assert.equal(aj.weth.get(BENEF), 100n);
    assert.equal(aj.nativo.get(BENEF), -100n);
    assert.equal(aj.houveWrap, true);
});

test('a presença do PoolManager V4 exige saldo nativo, mesmo sem wrap', () => {
    // O V4 liquida em moeda nativa por chamada interna: nao ha log. Uma
    // transacao que o toca nao e reconciliavel so por log, e chamar aquilo de
    // "lucrativa" foi o erro medido.
    const logs: Log[] = [{
        address: POOL_MANAGER_V4, topics: ['0xdeadbeef'], data: '0x',
        transactionHash: '0xt', blockNumber: '0x1', logIndex: '0x0',
    }];
    assert.equal(precisaDeSaldoNativo(logs, WETH), true);
    // E sem V4 e sem wrap, nao exige.
    assert.equal(precisaDeSaldoNativo([], WETH), false);
});
