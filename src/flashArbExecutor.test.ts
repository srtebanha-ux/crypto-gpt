// Arquivo: src/flashArbExecutor.test.ts
//
// Testes puros: nenhuma transação é enviada e nenhum RPC é chamado. O que se
// exercita aqui é a tradução entre o que o scanner mede (valores humanos, em
// Decimal) e o que a cadeia exige (unidades cruas, em BigInt) — e a leitura
// dos erros que voltam de um ensaio revertido.
//
// Essa tradução é o ponto onde um erro custa dinheiro em silêncio: uma
// quantidade na unidade errada não dá erro de compilação nem de execução,
// dá uma transação que empresta ordens de grandeza a mais ou a menos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { id as keccakId } from 'ethers';
import {
    FLASH_ARB_SELECTORS,
    extrairDadoDeReversao,
    interpretarReversao,
    montarCalldata,
    paraUnidadesCruas,
    planejarExecucao,
} from './flashArbExecutor';
import type { Cycle, PoolInfo } from './dexGraph';
import type { CycleEvaluation, Hop } from './ammMath';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const WETH = '0x4200000000000000000000000000000000000006';
const ALT = '0xff0c00000000000000000000000000000000abcd';

function pool(address: string, token0: string, token1: string, r0: string, r1: string): PoolInfo {
    return {
        address,
        token0,
        token1,
        reserve0: new Decimal(r0),
        reserve1: new Decimal(r1),
        feeFraction: new Decimal('0.003'),
    };
}

function cicloDeDoisPools(): Cycle {
    return {
        startToken: WETH,
        pools: [
            pool('0x29b3a70000000000000000000000000000000001', WETH, ALT, '10', '20000'),
            pool('0xde66c30000000000000000000000000000000002', WETH, ALT, '10', '19000'),
        ],
        path: [WETH, ALT, WETH],
    };
}

/** hop[0]: WETH entra, ALT sai. hop[1]: ALT entra, WETH sai. */
function hopsDoCiclo(): Hop[] {
    return [
        { reserveIn: new Decimal('10'), reserveOut: new Decimal('20000'), feeFraction: new Decimal('0.003') },
        { reserveIn: new Decimal('19000'), reserveOut: new Decimal('10'), feeFraction: new Decimal('0.003') },
    ];
}

function avaliacao(lucro: string, entrada: string): CycleEvaluation {
    return {
        amountIn: new Decimal(entrada),
        grossProfit: new Decimal(lucro),
        flashLoanFee: new Decimal('0'),
        gasCost: new Decimal('0'),
        netProfit: new Decimal(lucro),
        profitable: new Decimal(lucro).greaterThan(0),
    };
}

const DECIMAIS = new Map<string, number>([
    [WETH, 18],
    [ALT, 18],
]);

// ---------------------------------------------------------------------------
// Seletores
// ---------------------------------------------------------------------------

test('os seletores são de fato keccak256(assinatura)[0:4] — um dígito trocado chamaria outra função', () => {
    // Hardcoded no módulo por velocidade; reconferido aqui porque um seletor
    // errado NÃO dá erro: dá uma chamada que cai no fallback do contrato ou
    // executa outra coisa.
    assert.equal(
        FLASH_ARB_SELECTORS.executarArbitragem,
        keccakId('executarArbitragem(address,address,address,uint256,uint256)').slice(0, 10),
    );
    assert.equal(FLASH_ARB_SELECTORS.sacar, keccakId('sacar(address)').slice(0, 10));
    assert.equal(FLASH_ARB_SELECTORS.balanceOf, keccakId('balanceOf(address)').slice(0, 10));
});

// ---------------------------------------------------------------------------
// Conversão para unidades cruas
// ---------------------------------------------------------------------------

test('paraUnidadesCruas não perde precisão em valores que estouram o teto do Decimal', () => {
    // O projeto roda com precision: 20. 100 WETH em wei tem 21 dígitos —
    // multiplicar por 10^18 DENTRO do Decimal arredondaria em silêncio.
    assert.equal(paraUnidadesCruas(new Decimal('100'), 18), 100000000000000000000n);
    assert.equal(paraUnidadesCruas(new Decimal('1234.5678'), 18), 1234567800000000000000n);
    assert.equal(paraUnidadesCruas(new Decimal('0.00744936'), 18), 7449360000000000n);
});

test('paraUnidadesCruas respeita as casas REAIS do token, não 18 para todos', () => {
    // USDC tem 6 casas. Tratá-lo como 18 erraria por 10^12 — e o erro sairia
    // como uma quantidade emprestada um trilhão de vezes maior.
    assert.equal(paraUnidadesCruas(new Decimal('1.5'), 6), 1500000n);
    assert.equal(paraUnidadesCruas(new Decimal('1.5'), 18), 1500000000000000000n);
});

test('paraUnidadesCruas TRUNCA em vez de arredondar para cima', () => {
    // Emprestar mais do que o calculado é emprestar o que pode não existir na
    // reserva — a transação reverteria e o gás iria embora.
    assert.equal(paraUnidadesCruas(new Decimal('1.9999999'), 6), 1999999n);
    assert.equal(paraUnidadesCruas(new Decimal('0'), 18), 0n);
});

test('paraUnidadesCruas recusa entrada inválida em vez de produzir número silencioso', () => {
    assert.throws(() => paraUnidadesCruas(new Decimal('-1'), 18), /inválido/);
    assert.throws(() => paraUnidadesCruas(new Decimal('1'), -1), /decimais inválidas/i);
});

// ---------------------------------------------------------------------------
// Planejamento
// ---------------------------------------------------------------------------

test('planejarExecucao empresta a quantidade do ALT (saída do primeiro salto), não a entrada em WETH', () => {
    // O erro que este teste existe para pegar: passar `amountIn` (WETH) como
    // `quantidade` (ALT). Não quebra nada visivelmente — só dimensiona a
    // operação na unidade errada, e em tokens de preço distante isso é uma
    // diferença de ordens de grandeza.
    const plano = planejarExecucao({
        cycle: cicloDeDoisPools(),
        hops: hopsDoCiclo(),
        evaluation: avaliacao('0.01', '0.1'),
        decimaisPorToken: DECIMAIS,
        margemDeSeguranca: new Decimal('0.5'),
        saldoAtualDoLucro: 0n,
    });
    assert.ok(!('motivo' in plano), 'ciclo lucrativo de 2 pools deve ser planejável');
    assert.equal(plano.tokenEmprestado, ALT);

    // 0,1 WETH entrando numa reserva de 10/20000 sai perto de 197 ALT — três
    // ordens de grandeza acima de 0,1. Se a quantidade viesse de amountIn,
    // ficaria em 0,1e18.
    assert.ok(plano.quantidade > 190n * 10n ** 18n, `quantidade ${plano.quantidade} deveria estar na casa das centenas de ALT`);
    assert.ok(plano.quantidade < 200n * 10n ** 18n);
});

test('planejarExecucao soma o saldo já parado no contrato ao piso de lucro', () => {
    // O contrato confere balanceOf(this), não o lucro da operação. Sem somar o
    // saldo anterior, uma operação que PERDEU passaria na garantia on-chain.
    const base = {
        cycle: cicloDeDoisPools(),
        hops: hopsDoCiclo(),
        evaluation: avaliacao('0.01', '0.1'),
        decimaisPorToken: DECIMAIS,
        margemDeSeguranca: new Decimal('0.5'),
    };
    const semSaldo = planejarExecucao({ ...base, saldoAtualDoLucro: 0n });
    const comSaldo = planejarExecucao({ ...base, saldoAtualDoLucro: 3n * 10n ** 18n });
    assert.ok(!('motivo' in semSaldo) && !('motivo' in comSaldo));

    assert.equal(semSaldo.lucroMinimo, 5000000000000000n, 'metade de 0,01 WETH');
    assert.equal(comSaldo.lucroMinimo, 3n * 10n ** 18n + 5000000000000000n, 'o piso sobe exatamente o saldo preexistente');
});

test('planejarExecucao RECUSA ciclo triangular em vez de mandá-lo para um contrato que não o executa', () => {
    const triangular = cicloDeDoisPools();
    triangular.pools = [...triangular.pools, triangular.pools[0]];
    triangular.path = [WETH, ALT, ALT, WETH];

    const plano = planejarExecucao({
        cycle: triangular,
        hops: [...hopsDoCiclo(), hopsDoCiclo()[0]],
        evaluation: avaliacao('0.01', '0.1'),
        decimaisPorToken: DECIMAIS,
        margemDeSeguranca: new Decimal('0.5'),
        saldoAtualDoLucro: 0n,
    });
    assert.ok('motivo' in plano);
    assert.match(plano.motivo, /2 pools/);
});

test('planejarExecucao recusa ciclo sem lucro e token sem decimals() conhecido', () => {
    const comum = {
        cycle: cicloDeDoisPools(),
        hops: hopsDoCiclo(),
        margemDeSeguranca: new Decimal('0.5'),
        saldoAtualDoLucro: 0n,
    };
    const semLucro = planejarExecucao({ ...comum, evaluation: avaliacao('0', '0.1'), decimaisPorToken: DECIMAIS });
    assert.ok('motivo' in semLucro);
    assert.match(semLucro.motivo, /lucro/i);

    const semDecimais = planejarExecucao({
        ...comum,
        evaluation: avaliacao('0.01', '0.1'),
        decimaisPorToken: new Map([[WETH, 18]]),
    });
    assert.ok('motivo' in semDecimais, 'sem decimals() do ALT não dá para dimensionar nada');
});

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

test('montarCalldata produz seletor + exatamente 5 palavras de 32 bytes', () => {
    const calldata = montarCalldata({
        poolEmprestimo: '0x29b3a70000000000000000000000000000000001',
        poolVenda: '0xde66c30000000000000000000000000000000002',
        tokenEmprestado: ALT,
        quantidade: 197n * 10n ** 18n,
        lucroMinimo: 5000000000000000n,
    });
    assert.ok(calldata.startsWith(FLASH_ARB_SELECTORS.executarArbitragem));
    assert.equal(calldata.length, 2 + 8 + 5 * 64, 'seletor + 5 argumentos, sem sobra nem falta');
    // Endereço vem alinhado à direita em 32 bytes, com zeros à esquerda.
    assert.ok(calldata.includes('00000000000000000000000029b3a70000000000000000000000000000000001'));
});

// ---------------------------------------------------------------------------
// Leitura do erro do ensaio — o diagnóstico que dispensa gastar gás
// ---------------------------------------------------------------------------

test('interpretarReversao lê LucroInsuficiente e identifica sobra ZERO como token que não se vende', () => {
    const dados =
        '0x9612b7e0' +
        (0n).toString(16).padStart(64, '0') +
        (5000000000000000n).toString(16).padStart(64, '0');
    const texto = interpretarReversao(dados);
    assert.match(texto, /sobra=0/);
    assert.match(texto, /não se deixa vender/i);
});

test('interpretarReversao distingue sobra menor que o piso de sobra zero', () => {
    const dados =
        '0x9612b7e0' +
        (4000000000000000n).toString(16).padStart(64, '0') +
        (5000000000000000n).toString(16).padStart(64, '0');
    const texto = interpretarReversao(dados);
    assert.match(texto, /abaixo do piso/i);
    assert.doesNotMatch(texto, /não se deixa vender/i, 'o ciclo existe; só rendeu menos');
});

test('interpretarReversao decodifica Error(string) vindo do pool ou do token', () => {
    const msg = 'UniswapV2: K';
    const bytes = Buffer.from(msg, 'utf8').toString('hex').padEnd(64, '0');
    const dados =
        '0x08c379a0' +
        (32n).toString(16).padStart(64, '0') +
        BigInt(msg.length).toString(16).padStart(64, '0') +
        bytes;
    assert.match(interpretarReversao(dados), /UniswapV2: K/);
});

test('interpretarReversao não finge diagnóstico quando não há dado de erro', () => {
    assert.match(interpretarReversao(undefined), /sem dado de erro/i);
    assert.match(interpretarReversao('0x'), /sem dado de erro/i);
    assert.match(interpretarReversao('0xdeadbeef'), /desconhecido/i);
});

test('extrairDadoDeReversao acha o dado nos três formatos que os provedores usam', () => {
    // Procurar num lugar só faria o motivo real virar "erro desconhecido"
    // justamente quando ele é a informação que se foi buscar.
    assert.equal(extrairDadoDeReversao({ message: 'x', data: '0x9612b7e0' }), '0x9612b7e0');
    assert.equal(extrairDadoDeReversao({ message: 'x', data: { data: '0x9612b7e0' } }), '0x9612b7e0');
    assert.equal(extrairDadoDeReversao({ message: 'reverted: 0x9612b7e0aa' }), '0x9612b7e0aa');
    assert.equal(extrairDadoDeReversao(undefined), undefined);
});
