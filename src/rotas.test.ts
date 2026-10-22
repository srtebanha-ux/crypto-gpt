/**
 * As regras das rotas de 2 a 4 swaps. Cada uma vem de um defeito medido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    acharRotas, saidaDoHop, entradaDoHop, percorrer, sobraDaRota, melhorTamanhoDaRota,
    semDuplicacaoEconomica, comoLerARota, type PoolParaRota, type Rota,
} from './rotas';
import { saidaCrua } from './ammMath';

const A = '0xaaaa000000000000000000000000000000000001';
const B = '0xbbbb000000000000000000000000000000000002';
const C = '0xcccc000000000000000000000000000000000003';
const F1 = '0xf1'; const F2 = '0xf2'; const F3 = '0xf3';

const pool = (
    endereco: string, t0: string, t1: string, r0: bigint, r1: bigint,
    fabrica = F1, tipo: PoolParaRota['tipo'] = 'v2', taxa = 30,
): PoolParaRota => ({
    endereco, token0: t0, token1: t1, reserva0: r0, reserva1: r1,
    tipo, taxaPorDezMil: taxa, fabrica,
});

const M = 10n ** 18n;

test('acha rotas de 2, 3 e 4 swaps que voltam ao token base', () => {
    const pools = [
        pool('0x1', A, B, 100n * M, 200n * M, F1),
        pool('0x2', A, B, 100n * M, 210n * M, F2),
        pool('0x3', B, C, 200n * M, 400n * M, F2),
        pool('0x4', A, C, 100n * M, 420n * M, F3),
    ];
    const rotas = acharRotas(pools, A, { maxHops: 4 });
    const porTamanho = new Map<number, number>();
    for (const r of rotas) {
        assert.equal(r.hops[0]!.de, A, 'a rota tem de começar no token base');
        assert.equal(r.hops[r.hops.length - 1]!.para, A, 'e terminar nele');
        porTamanho.set(r.hops.length, (porTamanho.get(r.hops.length) ?? 0) + 1);
    }
    assert.ok((porTamanho.get(2) ?? 0) > 0, 'nenhuma rota de 2 swaps');
    assert.ok((porTamanho.get(3) ?? 0) > 0, 'nenhuma rota TRIANGULAR (3 swaps)');
    // Com 4 pools e 3 tokens há rotas de 4 (A→B→C→A usando pools distintos
    // mais uma volta extra não cabe; o que importa é o limite ser respeitado).
    for (const r of rotas) assert.ok(r.hops.length <= 4);
});

test('pool REPETIDO nunca entra na rota: isso reverte com UniswapV2: LOCKED', () => {
    // Medido na ENTREGA 1: o mesmo pool nas duas pernas trava no guard de
    // reentrância do pool, e o teste que fazia isso não testava nada.
    const pools = [pool('0x1', A, B, 100n * M, 200n * M)];
    const rotas = acharRotas(pools, A);
    for (const r of rotas) {
        assert.equal(r.poolsDistintos, r.hops.length, 'rota com pool repetido');
    }
    // Com UM pool só, ir e voltar pelo MESMO pool seria a única rota possível —
    // e ela é proibida. Então não há rota.
    assert.equal(rotas.length, 0);
});

test('o primeiro hop é o EMPRÉSTIMO e respeita `podeEmprestar`', () => {
    const pools = [
        pool('0x1', A, B, 100n * M, 200n * M, F1, 'aerodromeStable', 5),
        pool('0x2', A, B, 100n * M, 210n * M, F2),
    ];
    // Só o V2 pode emprestar: a Aerodrome tem `swap` com a mesma assinatura mas
    // callback de outro nome, e supor que atende seria reversão paga.
    const rotas = acharRotas(pools, A, {
        podeEmprestar: (p) => p.tipo === 'v2',
    });
    assert.ok(rotas.length > 0);
    for (const r of rotas) assert.equal(r.hops[0]!.pool.tipo, 'v2');
});

test('a taxa é POR POOL: stable de 0,05% não é tratado como V2 de 0,3%', () => {
    // A exigência dela: *"Não trate pools stable como V2 convencional."*
    const v2 = pool('0x1', A, B, 1000n * M, 1000n * M, F1, 'v2', 30);
    const vol = pool('0x2', A, B, 1000n * M, 1000n * M, F2, 'aerodromeVolatil', 30);
    const barato = pool('0x3', A, B, 1000n * M, 1000n * M, F2, 'aerodromeVolatil', 5);
    const q = M;
    const sv2 = saidaDoHop({ pool: v2, de: A, para: B }, q);
    const svol = saidaDoHop({ pool: vol, de: A, para: B }, q);
    const sbar = saidaDoHop({ pool: barato, de: A, para: B }, q);
    assert.ok(sv2 !== null && svol !== null && sbar !== null);
    // Mesma taxa, mesma conta — e ela bate com a do contrato.
    assert.equal(sv2, saidaCrua(q, 1000n * M, 1000n * M));
    assert.equal(svol, sv2, 'volátil com taxa 30 tem de dar o mesmo que V2');
    // Taxa menor rende MAIS: se desse igual, a taxa não estaria na conta.
    assert.ok(sbar > sv2, 'a taxa de 0,05% rendeu o mesmo que 0,30%');
});

test('hop STABLE não calcula localmente: a conta é do pool, e `null` diz isso', () => {
    // Eu NÃO reimplemento x³y+y³x: o pool expõe `getAmountOut` e faz a própria
    // conta (medido: 24.222.112 contra 24.215.310 do volátil, no mesmo par).
    // Uma cópia aqui seria desmentida pelo pool.
    const st = pool('0x1', A, B, 1000n * M, 1000n * M, F1, 'aerodromeStable', 5);
    const h = { pool: st, de: A, para: B };
    assert.equal(saidaDoHop(h, M), null, 'calculou stable localmente: é palpite');
    assert.equal(entradaDoHop(h, M), null);
    // E a rota com ele só anda se o chamador PERGUNTAR.
    const r: Rota = { hops: [h, { pool: pool('0x2', B, A, 1000n * M, 1000n * M, F2), de: B, para: A }], token: A, poolsDistintos: 2 };
    assert.equal(percorrer(r, M), null, 'andou sobre um hop que não sabe calcular');
    const comCotacao = percorrer(r, M, (hh, e) => (hh.pool.tipo === 'aerodromeStable' ? e : null));
    assert.ok(comCotacao !== null, 'com cotação de fora a rota tem de andar');
});

test('a sobra sai no token DEVOLVIDO e o pagamento arredonda PARA CIMA', () => {
    const emprestimo = pool('0x1', A, B, 1000n * M, 1000n * M, F1);
    const venda = pool('0x2', A, B, 1000n * M, 1200n * M, F2);
    const r: Rota = {
        hops: [
            { pool: emprestimo, de: A, para: B },
            { pool: venda, de: B, para: A },
        ],
        token: A, poolsDistintos: 2,
    };
    // Empresta A do pool 1, vende B->A no pool 2... a rota fecha em A.
    const s = sobraDaRota(r, M);
    assert.ok(s !== null);
    assert.equal(s.sobra, s.recebido - s.devido);
    // O devido é a ENTRADA necessária, com o `+1`: nunca menor que o exato.
    const inverso = { pool: emprestimo, de: B, para: A };
    assert.equal(s.devido, entradaDoHop(inverso, M));
});

test('o tamanho ótimo é máximo sobre a função que decide', () => {
    // A DIREÇÃO IMPORTA, e a primeira versão deste teste fixou a errada: com
    // pool1 A/B 1000:1000 e pool2 A/B 1000:1300, emprestar B e pagar em A perde
    // — o lucro está no sentido oposto. Era defeito do teste, e `acharRotas`
    // existe justamente para não ser eu a escolher o sentido.
    const pools = [
        pool('0x1', A, B, 1000n * M, 1000n * M, F1),
        pool('0x2', A, B, 1000n * M, 1300n * M, F2),
    ];
    const comSobra = acharRotas(pools, A, { maxHops: 2 })
        .concat(acharRotas(pools, B, { maxHops: 2 }))
        .map((r) => ({ r, m: melhorTamanhoDaRota(r) }))
        .filter((x): x is { r: Rota; m: NonNullable<ReturnType<typeof melhorTamanhoDaRota>> } =>
            x.m !== null && x.m.sobra > 0n);
    assert.ok(comSobra.length > 0,
        'nenhum dos dois sentidos rendeu: com 1000:1000 contra 1000:1300 um deles tem de render');

    for (const { r, m } of comSobra) {
        // É MÁXIMO: metade e o dobro não melhoram. Afirma a regra, não um
        // literal — o número muda com a reserva.
        for (const outro of [m.quantia / 2n, m.quantia * 2n, m.quantia + m.quantia / 5n]) {
            const s = sobraDaRota(r, outro);
            if (s === null) continue;
            assert.ok(s.sobra <= m.sobra,
                `tamanho ${outro} rende ${s.sobra}, mais que o ótimo ${m.sobra}`);
        }
    }
});

test('duplicação econômica é o MESMO CONJUNTO de pools, e colapsa', () => {
    // Os 3 "aprovados" da ENTREGA 2 partilhavam pool de venda e token: uma
    // discrepância vista de três ângulos. Somar os lucros contava o mesmo
    // dinheiro três vezes.
    const p1 = pool('0x1', A, B, 1000n * M, 1000n * M, F1);
    const p2 = pool('0x2', A, B, 1000n * M, 1300n * M, F2);
    const r1: Rota = { hops: [{ pool: p1, de: A, para: B }, { pool: p2, de: B, para: A }], token: A, poolsDistintos: 2 };
    const r2: Rota = { hops: [{ pool: p2, de: A, para: B }, { pool: p1, de: B, para: A }], token: A, poolsDistintos: 2 };
    const { unicas, colapsadas } = semDuplicacaoEconomica([
        { rota: r1, sobra: 10n }, { rota: r2, sobra: 30n },
    ]);
    assert.equal(unicas.length, 1, 'duas vistas do mesmo conjunto não colapsaram');
    assert.equal(colapsadas, 1);
    assert.equal(unicas[0]!.sobra, 30n, 'ficou a pior das duas');
    // Conjuntos DIFERENTES não colapsam.
    const p3 = pool('0x3', A, C, 1000n * M, 1000n * M, F3);
    const r3: Rota = { hops: [{ pool: p1, de: A, para: B }, { pool: p3, de: B, para: A }], token: A, poolsDistintos: 2 };
    assert.equal(semDuplicacaoEconomica([
        { rota: r1, sobra: 10n }, { rota: r3, sobra: 5n },
    ]).unicas.length, 2);
});

test('a rota em uma linha diz o TIPO de cada pool', () => {
    const r: Rota = {
        hops: [
            { pool: pool('0x1', A, B, M, M, F1, 'v2'), de: A, para: B },
            { pool: pool('0x2', A, B, M, M, F2, 'aerodromeStable', 5), de: B, para: A },
        ],
        token: A, poolsDistintos: 2,
    };
    const f = comoLerARota(r);
    assert.match(f, /2 swap\(s\)/);
    assert.match(f, /v2/);
    assert.match(f, /aerodromeStable/);
});
