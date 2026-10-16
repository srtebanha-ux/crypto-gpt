import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    FAIXAS_DE_RISCO,
    QUEDAS_DA_CASCATA,
    calcularCascata,
    SAUDE_UM,
    classificarRisco,
    decodificarContaDoUsuario,
    devedoresDosEventos,
    quedaAteLiquidar,
    resumirPosicoes,
    type Posicao,
} from './posicoes';

/** Monta a resposta de getUserAccountData: 6 palavras de 32 bytes. */
function conta(p: { garantia: bigint; divida: bigint; limiar: bigint; saude: bigint }): string {
    const w = (v: bigint) => v.toString(16).padStart(64, '0');
    return `0x${w(p.garantia)}${w(p.divida)}${w(0n)}${w(p.limiar)}${w(0n)}${w(p.saude)}`;
}

const SAUDE_INFINITA = 2n ** 256n - 1n;

test('a conta do usuário é lida nas posições certas', () => {
    const c = decodificarContaDoUsuario(
        conta({ garantia: 150_000_000_00n, divida: 100_000_000_00n, limiar: 8500n, saude: 10n ** 18n }),
    );
    assert.equal(c.garantiaBase.toString(), '15000000000');
    assert.equal(c.dividaBase.toString(), '10000000000');
    assert.equal(c.limiarLiquidacao.toString(), '8500');
    assert.equal(c.saude.toString(), '1000000000000000000');
});

test('resposta curta é erro, não silêncio', () => {
    assert.throws(() => decodificarContaDoUsuario('0xabcd'), /menos de 6 palavras/);
});

test('a queda que falta sai só da saúde — sem precisar de preço nenhum', () => {
    // Esta é a conta que faz o vigia existir: saúde 1,05 quer dizer que a
    // garantia pode cair 4,76% e acabou.
    const de = (x: string) => quedaAteLiquidar(SAUDE_UM.mul(x))!.toFixed(2);
    assert.equal(de('1.5'), '33.33');
    assert.equal(de('1.1'), '9.09');
    assert.equal(de('1.05'), '4.76');
    assert.equal(de('1.02'), '1.96');
});

test('quem já está liquidável devolve zero, não número negativo', () => {
    assert.equal(quedaAteLiquidar(SAUDE_UM.mul('0.98'))!.toString(), '0');
    assert.equal(quedaAteLiquidar(SAUDE_UM)!.toString(), '0');
});

test('saúde infinita é "não deve nada", não "posição seguríssima"', () => {
    // A Aave manda o maior uint256 que existe para quem não tem dívida.
    // Tratar isso como saúde alta encheria a lista de gente sem dívida, e o
    // relatório diria que há milhares de posições vigiadas onde não há
    // nenhuma.
    assert.equal(quedaAteLiquidar(new Decimal(SAUDE_INFINITA.toString())), null);
    assert.equal(quedaAteLiquidar(new Decimal(0)), null);
});

test('as faixas de risco vão da mais urgente para a mais folgada', () => {
    const ordenado = [...FAIXAS_DE_RISCO].sort((a, b) => a.ate - b.ate);
    assert.deepEqual(FAIXAS_DE_RISCO, ordenado);
    assert.equal(classificarRisco(new Decimal(0)), 'JÁ LIQUIDÁVEL');
    assert.equal(classificarRisco(new Decimal(0.5)), 'a menos de 1%');
    assert.equal(classificarRisco(new Decimal(4)), 'a menos de 5%');
    assert.equal(classificarRisco(new Decimal(90)), 'folgada');
    assert.equal(classificarRisco(null), null);
});

/** Uma posição com a saúde dada e US$1.000 de dívida. */
function pos(devedor: string, saudeVezes: string): Posicao {
    const saude = SAUDE_UM.mul(saudeVezes);
    return {
        devedor,
        conta: {
            garantiaBase: new Decimal(2000e8),
            dividaBase: new Decimal(1000e8),
            limiarLiquidacao: new Decimal(8500),
            saude,
        },
        quedaPct: quedaAteLiquidar(saude),
    };
}

test('o resumo separa quem está na borda de quem está folgado', () => {
    const r = resumirPosicoes([pos('0xa', '1.01'), pos('0xb', '1.04'), pos('0xc', '2.0')]);
    assert.equal(r.vigiados, 3);
    assert.equal(r.naBorda.length, 2, 'só as duas a menos de 5%');
    assert.equal(r.dividaSobAmeaca.toString(), '2000');
    assert.match(r.leitura, /2 de 3/);
});

test('a borda vem ordenada pela urgência', () => {
    const r = resumirPosicoes([pos('0xfolgado', '1.04'), pos('0xurgente', '1.001')]);
    assert.equal(r.naBorda[0].devedor, '0xurgente');
});

test('quem não deve nada não entra na conta de vigiados', () => {
    const semDivida: Posicao = {
        devedor: '0xz',
        conta: {
            garantiaBase: new Decimal(5000e8),
            dividaBase: new Decimal(0),
            limiarLiquidacao: new Decimal(8500),
            saude: new Decimal(SAUDE_INFINITA.toString()),
        },
        quedaPct: null,
    };
    const r = resumirPosicoes([pos('0xa', '1.02'), semDivida]);
    assert.equal(r.vigiados, 1);
    assert.equal(r.semDivida, 1);
});

test('dia calmo é dito como dia calmo, não como falta de dado', () => {
    const r = resumirPosicoes([pos('0xa', '2.0'), pos('0xb', '3.0')]);
    assert.equal(r.naBorda.length, 0);
    assert.match(r.leitura, /Dia calmo/);
    assert.equal(r.dividaSobAmeaca.toString(), '0');
});

test('lista vazia não vira conclusão', () => {
    assert.match(resumirPosicoes([]).leitura, /sem dado suficiente/);
});

test('o devedor sai do terceiro tópico, não do segundo', () => {
    // Borrow(reserve indexed, user, onBehalfOf indexed, ...). Quem DEVE é o
    // onBehalfOf. Pegar `user` daria quem apertou o botão em nome de outro.
    const dono = '0xdead000000000000000000000000000000000001';
    const logs = [
        { topics: ['0xt0', `0x${'1'.repeat(64)}`, `0x${dono.slice(2).padStart(64, '0')}`] },
        { topics: ['0xt0', `0x${'2'.repeat(64)}`, `0x${dono.slice(2).padStart(64, '0')}`] },
    ];
    assert.deepEqual(devedoresDosEventos(logs), [dono]);
});

test('log malformado é pulado em vez de virar endereço torto', () => {
    assert.deepEqual(devedoresDosEventos([{ topics: ['0xt0'] }, { topics: ['0xt0', '0xa', '0xb'] }]), []);
});

// ---------------------------------------------------------------------------
// A cascata: o monte ANTES de ele acontecer.
// ---------------------------------------------------------------------------

/** Uma posição com a queda dada e a dívida dada, em dólares. */
function comQueda(saudeVezes: string, dividaUsd: number): Posicao {
    const saude = SAUDE_UM.mul(saudeVezes);
    return {
        devedor: `0x${saudeVezes.replace('.', '')}`,
        conta: {
            garantiaBase: new Decimal(dividaUsd * 2 * 1e8),
            dividaBase: new Decimal(dividaUsd * 1e8),
            limiarLiquidacao: new Decimal(8500),
            saude,
        },
        quedaPct: quedaAteLiquidar(saude),
    };
}

test('a cascata é acumulada: quem abre a 1% também abre a 5%', () => {
    // saúde 1,0101 ≈ 1% de queda; 1,0309 ≈ 3%.
    const c = calcularCascata([comQueda('1.0101', 1000), comQueda('1.0309', 5000)]);
    assert.equal(c.quantasPorQueda[1], 1);
    assert.equal(c.quantasPorQueda[3], 2);
    assert.equal(c.porQueda[3].toString(), '6000');
    assert.equal(c.porQueda[20].toString(), '6000', 'ninguém some nas faixas de cima');
});

test('quem não deve nada não entra na cascata', () => {
    const semDivida: Posicao = {
        devedor: '0xz',
        conta: {
            garantiaBase: new Decimal(9999e8),
            dividaBase: new Decimal(0),
            limiarLiquidacao: new Decimal(8500),
            saude: new Decimal((2n ** 256n - 1n).toString()),
        },
        quedaPct: null,
    };
    const c = calcularCascata([comQueda('1.0101', 1000), semDivida]);
    assert.equal(c.porQueda[20].toString(), '1000');
});

test('o degrau aponta onde a goteira vira cachoeira', () => {
    // Pouca coisa até 3%, e uma avalanche entre 3% e 5%.
    const c = calcularCascata([
        comQueda('1.0101', 100),
        comQueda('1.0417', 900_000),
        comQueda('1.0421', 900_000),
    ]);
    assert.match(c.leitura, /degrau está em 5%/);
    assert.match(c.leitura, /1800000/);
});

test('sem dívida nenhuma não há leitura de cascata', () => {
    assert.match(calcularCascata([]).leitura, /sem dado suficiente/);
});

test('as faixas da cascata vão da menor para a maior', () => {
    // O cálculo do degrau compara cada faixa com a anterior — a ordem é o
    // algoritmo, não enfeite.
    const ordenado = [...QUEDAS_DA_CASCATA].sort((a, b) => a - b);
    assert.deepEqual(QUEDAS_DA_CASCATA, ordenado);
});
