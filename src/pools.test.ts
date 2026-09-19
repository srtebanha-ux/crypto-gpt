import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { id } from 'ethers';
import {
    ASSINATURA_SYNC_V2,
    ASSINATURA_SYNC_SOLIDLY,
    TOPICO_SYNC_V2,
    TOPICO_SYNC_SOLIDLY,
    TOPICO_DA_FAMILIA,
    contarAtividade,
    ordenarPorAtividade,
    reservaDoOutroLado,
    emUnidades,
    escolherPoolDeVenda,
    ladoEmDolar,
    profundidadeEmDolar,
    type Pool,
} from './pools';

const GARANTIA = '0x4200000000000000000000000000000000000006';
const DIVIDA = '0x0000000000000000000000000000000000000dc5';

function pool(p: Partial<Pool> = {}): Pool {
    return {
        endereco: '0x' + 'a'.repeat(40),
        familia: 'v2',
        trocas: 10,
        token0: GARANTIA,
        token1: DIVIDA,
        reserva0: new Decimal(1_000),
        reserva1: new Decimal(1_000_000),
        ...p,
    };
}

test('os tópicos saem do nome do evento, não de cópia', () => {
    assert.equal(TOPICO_SYNC_V2, id(ASSINATURA_SYNC_V2));
    assert.equal(TOPICO_SYNC_SOLIDLY, id(ASSINATURA_SYNC_SOLIDLY));
    assert.equal(TOPICO_DA_FAMILIA.v2, TOPICO_SYNC_V2);
});

test('as duas famílias têm tópicos diferentes — é isso que as separa', () => {
    // Se fossem iguais, a varredura misturaria Uniswap V2 com Aerodrome e o
    // contrato leria getReserves() no formato errado.
    assert.notEqual(TOPICO_SYNC_V2, TOPICO_SYNC_SOLIDLY);
});

test('conta quantas trocas cada pool fez, sem ligar para maiúsculas', () => {
    const c = contarAtividade([
        { address: '0xAAA', topics: [] },
        { address: '0xaaa', topics: [] },
        { address: '0xBBB', topics: [] },
    ]);
    assert.equal(c.get('0xaaa'), 2);
    assert.equal(c.get('0xbbb'), 1);
});

test('ordena pelo mais movimentado e corta no limite', () => {
    const c = new Map([['0xa', 1], ['0xb', 50], ['0xc', 7]]);
    const o = ordenarPorAtividade(c, 2);
    assert.deepEqual(o.map((x) => x.pool), ['0xb', '0xc']);
});

test('a reserva que importa é a do lado que se RECEBE', () => {
    // Vendendo a garantia (token0), o empurrão depende da reserva de token1.
    const p = pool();
    assert.equal(reservaDoOutroLado(p, GARANTIA)!.toNumber(), 1_000_000);
    assert.equal(reservaDoOutroLado(p, DIVIDA)!.toNumber(), 1_000);
    assert.equal(reservaDoOutroLado(p, '0x' + '9'.repeat(40)), null);
});

test('sem saber as casas da moeda, não converte — devolve null', () => {
    // Supor 18 casas é o defeito clássico: USDC tem 6, e um fator de 10^12 de
    // erro transforma um pool de mil dólares em um de um bilhão.
    assert.equal(emUnidades(new Decimal('1000000'), undefined), null);
    assert.equal(emUnidades(new Decimal('1000000'), 6)!.toNumber(), 1);
});

test('escolhe o pool V2 mais fundo do lado que se recebe', () => {
    const raso = pool({ endereco: '0xraso', reserva1: new Decimal(5_000) });
    const fundo = pool({ endereco: '0xfundo', reserva1: new Decimal(900_000) });
    const e = escolherPoolDeVenda([raso, fundo], GARANTIA, DIVIDA);
    assert.equal(e.pool!.endereco, '0xfundo');
    assert.equal(e.recebe!.toNumber(), 900_000);
});

test('recusa pool Solidly mesmo sendo o único do par', () => {
    // O contrato lê getReserves() como (uint112,uint112,uint32). Contra um
    // Solidly isso pode decodificar POR ACIDENTE — reserva pequena cabe em 112
    // bits, timestamp cabe em 32 — e acerto por acidente passa no teste e
    // falha no dia. Melhor não ter pool que ter o pool errado.
    const e = escolherPoolDeVenda([pool({ familia: 'solidly' })], GARANTIA, DIVIDA);
    assert.equal(e.pool, null);
    assert.match(e.motivo, /uint112/);
});

test('quando não acha, diz quantos olhou — não só "não achei"', () => {
    const e = escolherPoolDeVenda([pool({ token0: '0x1', token1: '0x2' })], GARANTIA, DIVIDA);
    assert.equal(e.pool, null);
    assert.match(e.motivo, /nenhum dos 1 pools/);
});

test('acha o par na ordem invertida também', () => {
    const invertido = pool({ token0: DIVIDA, token1: GARANTIA, reserva0: new Decimal(777) });
    const e = escolherPoolDeVenda([invertido], GARANTIA, DIVIDA);
    assert.equal(e.pool!.endereco, invertido.endereco);
    assert.equal(e.recebe!.toNumber(), 777);
});

test('acha o lado em dólar pelo símbolo, e admite quando não tem', () => {
    const comUsdc = pool({ simbolo0: 'WETH', simbolo1: 'USDC', decimais1: 6 });
    assert.equal(ladoEmDolar(comUsdc), 1);
    assert.equal(ladoEmDolar(pool({ simbolo0: 'USDbC', simbolo1: 'cbBTC', decimais0: 6 })), 0);
    assert.equal(ladoEmDolar(pool({ simbolo0: 'WETH', simbolo1: 'cbBTC' })), null);
});

test('profundidade em dólar sai do lado certo, com as casas certas', () => {
    // 648.537 USDC guardados como 648537000000 (6 casas). Ler isso como 18
    // casas daria 0,00000065 e o pool sumiria do ranking.
    const p = pool({
        simbolo0: 'WETH', simbolo1: 'USDC',
        decimais0: 18, decimais1: 6,
        reserva0: new Decimal('248000000000000000000'),
        reserva1: new Decimal('648537000000'),
    });
    assert.equal(profundidadeEmDolar(p)!.toFixed(0), '648537');
});

test('pool sem lado em dólar não recebe profundidade inventada', () => {
    assert.equal(profundidadeEmDolar(pool({ simbolo0: 'WETH', simbolo1: 'cbBTC' })), null);
});
