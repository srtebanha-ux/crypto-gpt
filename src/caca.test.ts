import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { Decimal } from 'decimal.js';
import {
    ASSINATURA_CACAR,
    SELETOR_CACAR,
    PISO_IMPOSSIVEL,
    SELETOR_LUCRO_INSUFICIENTE,
    codificarCaca,
    lerRespostaDaCaca,
    lucroEmDolar,
    compararComPrevisto,
} from './caca';

const coder = AbiCoder.defaultAbiCoder();
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const D = '0x4444444444444444444444444444444444444444';

function erroDe(nome: string, args: [string[], unknown[]] | null = null): string {
    const sel = id(nome).slice(0, 10);
    return args ? sel + coder.encode(args[0], args[1]).slice(2) : sel;
}

test('o seletor sai do nome da função, não de cópia', () => {
    assert.equal(SELETOR_CACAR, id(ASSINATURA_CACAR).slice(0, 10));
});

test('a chamada codificada leva os seis campos, com dadosSwap em bytes', () => {
    const dados = codificarCaca({
        garantia: A, divida: B, devedor: C, quantoCobrir: 123n, dadosSwap: '0xabcd', lucroMinimo: 7n,
    });
    assert.equal(dados.slice(0, 10), SELETOR_CACAR);
    const [g, dv, de, q, pv, lm] = coder.decode(
        ['address', 'address', 'address', 'uint256', 'bytes', 'uint256'],
        '0x' + dados.slice(10),
    );
    assert.equal(g, A);
    assert.equal(de, C);
    assert.equal(BigInt(q.toString()), 123n);
    assert.equal(pv, '0xabcd');
    assert.equal(BigInt(lm.toString()), 7n);
    assert.equal(dv, B);
});

test('o piso impossível cabe em uint256 e nenhum lucro o alcança', () => {
    assert.ok(PISO_IMPOSSIVEL < 1n << 256n);
    assert.ok(PISO_IMPOSSIVEL > 10n ** 30n);
});

test('sem reverter, a leitura é que a caçada inteira passaria', () => {
    const r = lerRespostaDaCaca({ ok: true, dados: '0x' });
    assert.equal(r.desfecho, 'passaria');
    assert.equal(r.lucroCru, null);
});

test('a reversão do piso MEDE o lucro — é para isso que ela existe', () => {
    // É o coração deste arquivo: mandar piso impossível faz a caçada executar
    // inteira e devolver, no erro, quanto teria rendido. Sem gás, sem risco.
    const dados = erroDe('LucroInsuficiente(uint256,uint256)', [
        ['uint256', 'uint256'],
        [1_044_000_000n, PISO_IMPOSSIVEL],
    ]);
    const r = lerRespostaDaCaca({ ok: false, mensagem: 'execution reverted', dados });
    assert.equal(r.desfecho, 'mediu');
    assert.equal(r.lucroCru, 1_044_000_000n);
    assert.equal(r.erro, null);
});

test('lucro medido ZERO é medição, não falha — e o texto diz isso', () => {
    // Zero aqui significa que a caçada rodou e os custos comeram o ágio. É
    // informação, e confundir com "deu erro" faria desistir de investigar.
    const dados = erroDe('LucroInsuficiente(uint256,uint256)', [['uint256', 'uint256'], [0n, PISO_IMPOSSIVEL]]);
    const r = lerRespostaDaCaca({ ok: false, mensagem: 'execution reverted', dados });
    assert.equal(r.desfecho, 'mediu');
    assert.equal(r.lucroCru, 0n);
    assert.match(r.leitura, /comeram o ágio/);
});

test('pool sem liquidez é desfecho próprio — aponta o endereço, não a Aave', () => {
    const r = lerRespostaDaCaca({ ok: false, mensagem: 'reverted', dados: erroDe('PoolSemLiquidez()') });
    assert.equal(r.desfecho, 'pool');
    assert.match(r.leitura, /endereço errado ou pool vazio/);
});

test('guarda do contrato é separada da recusa da Aave', () => {
    for (const nome of ['NaoAutorizado()', 'ChamadaInesperada()']) {
        const r = lerRespostaDaCaca({ ok: false, mensagem: 'reverted', dados: erroDe(nome) });
        assert.equal(r.desfecho, 'permissao', nome);
        assert.equal(r.erro, nome);
    }
});

test('reversão sem nosso erro é da Aave — posição já não serve', () => {
    const r = lerRespostaDaCaca({ ok: false, mensagem: 'execution reverted: 0x930bb771' });
    assert.equal(r.desfecho, 'aave');
});

test('limite do provedor NÃO é veredicto sobre a caçada', () => {
    // A distinção que o ensaio já tinha ensinado: "over rate limit" contado
    // como reprovação transformou uma medição boa em PARCIAL 4 de 5.
    const r = lerRespostaDaCaca({ ok: false, mensagem: 'over rate limit' });
    assert.equal(r.desfecho, 'rede');
    assert.match(r.leitura, /NÃO é veredicto/);
});

test('resposta que não dá para classificar admite isso', () => {
    const r = lerRespostaDaCaca({ ok: false, mensagem: 'algo totalmente inesperado' });
    assert.equal(r.desfecho, 'desconhecido');
    assert.match(r.leitura, /não sei classificar/);
});

test('lucro cru vira dólar com as casas e o preço da moeda', () => {
    // 1.044 USDC: 1044000000 unidades, 6 casas, a US$1.
    assert.equal(lucroEmDolar(1_044_000_000n, 6, new Decimal(1)).toFixed(2), '1044.00');
    // O mesmo número lido como 18 casas daria zero — por isso as casas vêm da moeda.
    assert.ok(lucroEmDolar(1_044_000_000n, 18, new Decimal(1)).lessThan('0.000001'));
});

test('medido perto do previsto sustenta as suposições', () => {
    const c = compararComPrevisto(new Decimal(1_044), new Decimal(1_000));
    assert.equal(c.bate, true);
    assert.match(c.leitura, /se sustentam/);
});

test('medido longe do previsto acusa a suposição, não o medido', () => {
    // Se o real vier muito abaixo, o errado é o ágio de 5% ou a perda de 0,3%
    // que eu suponho — e o relatório tem de dizer isso em vez de mostrar só o
    // número bonito, como vinha fazendo a noite toda.
    const c = compararComPrevisto(new Decimal(300), new Decimal(1_000));
    assert.equal(c.bate, false);
    assert.match(c.leitura, /está errado/);
    assert.equal(c.diferencaPct.toFixed(0), '-70');
});

test('sem previsão positiva, não finge comparação', () => {
    const c = compararComPrevisto(new Decimal(50), new Decimal(0));
    assert.equal(c.bate, false);
    assert.match(c.leitura, /não havia previsão/);
});
