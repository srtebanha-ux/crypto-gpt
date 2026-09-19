import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder } from 'ethers';
import {
    COBRIR_O_MAXIMO,
    ERROS_DA_AAVE,
    SELETOR_LIQUIDATION_CALL,
    codificarLiquidacao,
    codificarUserReserveData,
    decodificarUserReserveData,
    escolherPar,
    lerRespostaDaAave,
    type ReservaDoUsuario,
} from './liquidar';

const coder = AbiCoder.defaultAbiCoder();
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEVEDOR = '0x67d0938f00000000000000000000000000000001';

test('o seletor bate com keccak da assinatura', () => {
    assert.equal(SELETOR_LIQUIDATION_CALL, '0x00a718a9');
});

test('os cinco argumentos vão na ordem e voltam iguais', () => {
    // Trocar garantia com dívida é o erro mais fácil de cometer aqui, e o mais
    // caro: a Aave aceitaria a chamada e liquidaria o par errado.
    const c = codificarLiquidacao({
        garantia: WETH,
        divida: USDC,
        devedor: DEVEDOR,
        quantoCobrir: 123456n,
        receberAToken: false,
    });
    assert.ok(c.startsWith(SELETOR_LIQUIDATION_CALL));

    const [g, d, u, q, a] = coder.decode(
        ['address', 'address', 'address', 'uint256', 'bool'],
        `0x${c.slice(10)}`,
    ) as unknown as [string, string, string, bigint, boolean];
    assert.equal(g.toLowerCase(), WETH, 'a GARANTIA é o primeiro argumento');
    assert.equal(d.toLowerCase(), USDC, 'a DÍVIDA é o segundo');
    assert.equal(u.toLowerCase(), DEVEDOR);
    assert.equal(q, 123456n);
    assert.equal(a, false);
});

test('COBRIR_O_MAXIMO é o maior uint256, e cabe na codificação', () => {
    assert.equal(COBRIR_O_MAXIMO, 2n ** 256n - 1n);
    const c = codificarLiquidacao({
        garantia: WETH,
        divida: USDC,
        devedor: DEVEDOR,
        quantoCobrir: COBRIR_O_MAXIMO,
        receberAToken: false,
    });
    const [, , , q] = coder.decode(
        ['address', 'address', 'address', 'uint256', 'bool'],
        `0x${c.slice(10)}`,
    ) as unknown as [string, string, string, bigint, boolean];
    assert.equal(q, COBRIR_O_MAXIMO);
});

// ---------------------------------------------------------------------------
// A resposta da Aave: entender é diferente de conseguir.
// ---------------------------------------------------------------------------

test('o código 45 é SUCESSO do ensaio, não fracasso', () => {
    // A Aave dizendo "essa posição está saudável" prova que ela LEU o pedido.
    // É a melhor resposta possível para um ensaio contra posição que não caiu.
    const r = lerRespostaDaAave('execution reverted: 45');
    assert.equal(r.entendeu, true);
    assert.equal(r.codigo, '45');
    assert.match(r.texto, /SAUDÁVEL/);
});

test('os vários embrulhos de provedor são todos reconhecidos', () => {
    for (const forma of ['execution reverted: 45', "reverted: '45'", '45', 'reverted 45']) {
        const r = lerRespostaDaAave(forma);
        assert.equal(r.entendeu, true, forma);
        assert.equal(r.codigo, '45', forma);
    }
});

test('código desconhecido é dito como desconhecido, não inventado', () => {
    const r = lerRespostaDaAave('execution reverted: 77');
    assert.equal(r.entendeu, true);
    assert.equal(r.codigo, '77');
    assert.match(r.texto, /ainda não traduzi/);
});

test('erro que NÃO é da Aave aponta o dedo para mim, não para a posição', () => {
    // Esta é a distinção que o ensaio inteiro existe para fazer.
    const r = lerRespostaDaAave('invalid opcode');
    assert.equal(r.entendeu, false);
    assert.equal(r.codigo, null);
    assert.match(r.texto, /formato meu/);
});

test('o dicionário cobre os erros de liquidação que importam', () => {
    for (const c of ['45', '46', '47']) assert.ok(ERROS_DA_AAVE[c]);
});

// ---------------------------------------------------------------------------
// Escolher o par: garantia e dívida.
// ---------------------------------------------------------------------------

function reserva(p: Partial<ReservaDoUsuario>): ReservaDoUsuario {
    return { garantiaCrua: 0n, dividaCrua: 0n, usadaComoGarantia: false, ...p };
}

test('escolhe a maior garantia e a maior dívida', () => {
    const par = escolherPar([
        { ativo: WETH, dados: reserva({ garantiaCrua: 100n, usadaComoGarantia: true }) },
        { ativo: USDC, dados: reserva({ garantiaCrua: 999n, usadaComoGarantia: true, dividaCrua: 5n }) },
        { ativo: DEVEDOR, dados: reserva({ dividaCrua: 900n }) },
    ]);
    assert.deepEqual(par, { garantia: USDC, divida: DEVEDOR });
});

test('garantia NÃO marcada como garantia não serve de prêmio', () => {
    // Está depositada, mas o dono desmarcou. A Aave recusaria com o código 46.
    const par = escolherPar([
        { ativo: WETH, dados: reserva({ garantiaCrua: 10_000n, usadaComoGarantia: false }) },
        { ativo: USDC, dados: reserva({ garantiaCrua: 5n, usadaComoGarantia: true, dividaCrua: 900n }) },
    ]);
    assert.equal(par?.garantia, USDC);
});

test('sem dívida ou sem garantia não há par, e isso é null e não um chute', () => {
    assert.equal(escolherPar([]), null);
    assert.equal(
        escolherPar([{ ativo: WETH, dados: reserva({ garantiaCrua: 10n, usadaComoGarantia: true }) }]),
        null,
        'tem garantia mas não deve nada',
    );
    assert.equal(
        escolherPar([{ ativo: WETH, dados: reserva({ dividaCrua: 10n }) }]),
        null,
        'deve mas não tem garantia',
    );
});

test('os dados da reserva saem das palavras certas', () => {
    const w = (v: bigint) => v.toString(16).padStart(64, '0');
    const bruto = `0x${w(111n)}${w(0n)}${w(222n)}${w(0n)}${w(0n)}${w(0n)}${w(0n)}${w(0n)}${w(1n)}`;
    const d = decodificarUserReserveData(bruto);
    assert.equal(d.garantiaCrua, 111n);
    assert.equal(d.dividaCrua, 222n);
    assert.equal(d.usadaComoGarantia, true);
});

test('resposta curta é erro, não zeros silenciosos', () => {
    assert.throws(() => decodificarUserReserveData('0xabcd'), /menos de 9 palavras/);
});

test('a consulta de reserva leva ativo e usuário, nessa ordem', () => {
    const c = codificarUserReserveData(WETH, DEVEDOR);
    const [a, u] = coder.decode(['address', 'address'], `0x${c.slice(10)}`) as unknown as [string, string];
    assert.equal(a.toLowerCase(), WETH);
    assert.equal(u.toLowerCase(), DEVEDOR);
});
