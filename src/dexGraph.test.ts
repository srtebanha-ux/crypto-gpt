// Arquivo: src/dexGraph.test.ts
//
// O risco central deste módulo não é deixar de achar um ciclo — é orientar a
// reserva ao contrário. Isso não lança exceção: inverte o preço, atravessa a
// otimização e sai como "arbitragem enorme" no relatório. Por isso a maior
// parte destes testes é sobre orientação, não sobre enumeração.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { counterToken, findTriangularCycles, findTwoPoolCycles, hopFor, hopsForCycle, type PoolInfo } from './dexGraph';
import { getAmountOut } from './ammMath';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const A = '0xaaaa000000000000000000000000000000000000';
const B = '0xbbbb000000000000000000000000000000000000';
const C = '0xcccc000000000000000000000000000000000000';
const D = '0xdddd000000000000000000000000000000000000';

function pool(address: string, token0: string, token1: string, r0: string, r1: string, fee = '0.003'): PoolInfo {
    return {
        address,
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        reserve0: new Decimal(r0),
        reserve1: new Decimal(r1),
        feeFraction: new Decimal(fee),
    };
}

// --- Orientação (o ponto crítico) -------------------------------------------

test('hopFor: entrando pelo token0, reserveIn é reserve0', () => {
    const p = pool('0x1', A, B, '1000', '2000');
    const hop = hopFor(p, A);
    assert.equal(hop.reserveIn.toString(), '1000');
    assert.equal(hop.reserveOut.toString(), '2000');
});

test('hopFor: entrando pelo token1, as reservas INVERTEM', () => {
    const p = pool('0x1', A, B, '1000', '2000');
    const hop = hopFor(p, B);
    assert.equal(hop.reserveIn.toString(), '2000');
    assert.equal(hop.reserveOut.toString(), '1000');
});

test('hopFor: ida e volta no mesmo pool tem que dar prejuízo (as taxas)', () => {
    // Se a orientação estivesse invertida em um dos lados, este ciclo daria
    // "lucro" — é o teste que pega a inversão silenciosa.
    const p = pool('0x1', A, B, '1000000', '2000000');
    const saidaB = getAmountOut(new Decimal('1000'), hopFor(p, A));
    const voltaA = getAmountOut(saidaB, hopFor(p, B));
    assert.ok(voltaA.lessThan(1000), 'ida e volta no mesmo pool nunca pode render');
});

test('hopFor lança quando o token não pertence ao pool, em vez de escolher uma orientação', () => {
    const p = pool('0x1', A, B, '1000', '2000');
    assert.throws(() => hopFor(p, C), /não pertence ao pool/);
});

test('hopFor é insensível a maiúsculas no endereço do token', () => {
    const p = pool('0x1', A, B, '1000', '2000');
    assert.equal(hopFor(p, A.toUpperCase()).reserveIn.toString(), '1000');
});

test('counterToken devolve o outro lado, e null para token de fora', () => {
    const p = pool('0x1', A, B, '1', '1');
    assert.equal(counterToken(p, A), B.toLowerCase());
    assert.equal(counterToken(p, B), A.toLowerCase());
    assert.equal(counterToken(p, C), null);
});

// --- hopsForCycle -----------------------------------------------------------

test('hopsForCycle orienta cada hop segundo o token que chega nele', () => {
    // A->B (pool1, entrando por token0), B->C (pool2, entrando por token1),
    // C->A (pool3, entrando por token0). O 2º hop é o que testa a inversão.
    const p1 = pool('0x1', A, B, '1000', '1000');
    const p2 = pool('0x2', C, B, '3000', '4000'); // token0=C, token1=B
    const p3 = pool('0x3', C, A, '5000', '6000');
    const hops = hopsForCycle({ startToken: A, pools: [p1, p2, p3], path: [A, B, C, A] });

    assert.equal(hops.length, 3);
    assert.equal(hops[0].reserveIn.toString(), '1000');
    // Entrando por B, que é token1 em p2 => reserveIn tem que ser 4000.
    assert.equal(hops[1].reserveIn.toString(), '4000');
    assert.equal(hops[1].reserveOut.toString(), '3000');
    // Entrando por C, que é token0 em p3.
    assert.equal(hops[2].reserveIn.toString(), '5000');
});

test('hopsForCycle lança se o ciclo não fecha no token de partida', () => {
    const p1 = pool('0x1', A, B, '1', '1');
    const p2 = pool('0x2', B, C, '1', '1');
    assert.throws(
        () => hopsForCycle({ startToken: A, pools: [p1, p2], path: [A, B, C] }),
        /Ciclo não fecha/,
    );
});

// --- Enumeração de triângulos ----------------------------------------------

test('encontra o triângulo A->B->C->A', () => {
    const pools = [pool('0x1', A, B, '1', '1'), pool('0x2', B, C, '1', '1'), pool('0x3', C, A, '1', '1')];
    const cycles = findTriangularCycles(pools, A);
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0].path, [A, B, C, A].map((t) => t.toLowerCase()));
});

test('o mesmo triângulo não é reportado duas vezes (ida e volta são o mesmo)', () => {
    // Sem a chave canônica, A->B->C->A e A->C->B->A viriam como dois achados,
    // dobrando o relatório sem acrescentar informação.
    const pools = [pool('0x1', A, B, '1', '1'), pool('0x2', B, C, '1', '1'), pool('0x3', C, A, '1', '1')];
    assert.equal(findTriangularCycles(pools, A).length, 1);
});

test('não confunde dois pools do mesmo par com um triângulo', () => {
    const pools = [pool('0x1', A, B, '1', '1'), pool('0x2', A, B, '1', '1')];
    assert.equal(findTriangularCycles(pools, A).length, 0);
});

test('ignora tokens sem caminho de volta ao token de partida', () => {
    const pools = [pool('0x1', A, B, '1', '1'), pool('0x2', B, C, '1', '1'), pool('0x3', C, D, '1', '1')];
    assert.equal(findTriangularCycles(pools, A).length, 0);
});

test('nenhum pool reaparece dentro do mesmo triângulo', () => {
    const pools = [pool('0x1', A, B, '1', '1'), pool('0x2', B, C, '1', '1'), pool('0x3', C, A, '1', '1')];
    for (const cycle of findTriangularCycles(pools, A)) {
        const enderecos = cycle.pools.map((p) => p.address);
        assert.equal(new Set(enderecos).size, enderecos.length);
    }
});

test('todo triângulo encontrado produz hops válidos e fechados', () => {
    // Enumeração e orientação precisam concordar: um ciclo que a busca aceita
    // mas a orientação rejeita significaria um bug em um dos dois lados.
    const pools = [
        pool('0x1', A, B, '1000', '2000'),
        pool('0x2', B, C, '3000', '1500'),
        pool('0x3', C, A, '900', '1800'),
        pool('0x4', A, D, '100', '200'),
    ];
    const cycles = findTriangularCycles(pools, A);
    assert.ok(cycles.length > 0);
    for (const cycle of cycles) {
        assert.doesNotThrow(() => hopsForCycle(cycle));
        assert.equal(hopsForCycle(cycle).length, 3);
    }
});

// --- Ciclos de 2 pools ------------------------------------------------------

test('encontra dois pools do mesmo par (a arbitragem on-chain mais comum)', () => {
    const pools = [pool('0x1', A, B, '1000', '1000'), pool('0x2', A, B, '1000', '1100')];
    const cycles = findTwoPoolCycles(pools, A);
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].pools.length, 2);
    assert.doesNotThrow(() => hopsForCycle(cycles[0]));
});

test('ciclo de 2 pools paga só duas taxas — piso menor que o do triângulo', () => {
    const doisPools = [pool('0x1', A, B, '1000000', '1000000'), pool('0x2', A, B, '1000000', '1006000')];
    const cycles = findTwoPoolCycles(doisPools, A);
    const hops = hopsForCycle(cycles[0]);
    assert.equal(hops.length, 2);
    // 0,6% de desalinhamento contra 0,6% de taxa: quase no limite, mas o
    // ciclo de 3 hops (0,9% de taxa) já estaria claramente no prejuízo.
    const taxaTotal = hops.reduce((acc, h) => acc.plus(h.feeFraction), new Decimal(0));
    assert.equal(taxaTotal.toString(), '0.006');
});

test('pools de pares diferentes não formam ciclo de 2', () => {
    const pools = [pool('0x1', A, B, '1', '1'), pool('0x2', A, C, '1', '1')];
    assert.equal(findTwoPoolCycles(pools, A).length, 0);
});
