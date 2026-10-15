/**
 * AS REGRAS da descoberta mista — e nao os numeros de um bloco.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    candidatasMistas, pernasDaCandidata, funilVazio, limitacaoDominante,
    comoLerOFunilMisto, tetoDaSaidaV3, valeSimular, type PoolMisto,
} from './rotasMistas';

const WETH = '0x4200000000000000000000000000000000000006';
const TOK = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';
const OUTRO = '0xcccccccccccccccccccccccccccccccccccccccc';
const AERO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const V3 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const pool = (e: string, t0: string, t1: string, venue: 'v3' | 'aerodrome'): PoolMisto => ({
    endereco: e, token0: t0, token1: t1, venue, taxa: venue === 'v3' ? 3000 : null,
});

test('um par {Aerodrome, V3} rende as DUAS direções', () => {
    const c = candidatasMistas([
        pool(AERO, WETH, TOK, 'aerodrome'),
        pool(V3, WETH, TOK, 'v3'),
    ], WETH);
    assert.equal(c.length, 2, 'avaliar uma direção só é metade da busca');
    assert.deepEqual(new Set(c.map((x) => x.direcao)), new Set(['A', 'B']));
    for (const x of c) assert.equal(x.token, TOK);
});

test('pool sem a base NÃO entra: o ciclo tem de começar e terminar nela', () => {
    const c = candidatasMistas([
        pool(AERO, TOK, OUTRO, 'aerodrome'),
        pool(V3, TOK, OUTRO, 'v3'),
    ], WETH);
    assert.deepEqual(c, []);
});

test('dois pools do MESMO venue não formam rota mista', () => {
    // Dois Aerodrome, ou dois V3, nao sao candidata mista — e contar isso
    // inflaria "oportunidades" com pools, que foi o que ela proibiu.
    assert.deepEqual(candidatasMistas([
        pool(AERO, WETH, TOK, 'aerodrome'),
        pool('0xdd', WETH, TOK, 'aerodrome'),
    ], WETH), []);
    assert.deepEqual(candidatasMistas([
        pool(V3, WETH, TOK, 'v3'),
        pool('0xee', WETH, TOK, 'v3'),
    ], WETH), []);
});

test('rotas DISTINTAS não contam a mesma duas vezes', () => {
    const dobrado = [
        pool(AERO, WETH, TOK, 'aerodrome'),
        pool(AERO, WETH, TOK, 'aerodrome'),
        pool(V3, WETH, TOK, 'v3'),
    ];
    const c = candidatasMistas(dobrado, WETH);
    assert.equal(new Set(c.map((x) => x.chave)).size, c.length);
    assert.equal(c.length, 2, 'o mesmo par apareceu mais de uma vez por direção');
});

test('a direção decide QUEM empresta, e o pagamento só existe na perna 0', () => {
    const [a, b] = candidatasMistas([
        pool(AERO, WETH, TOK, 'aerodrome'),
        pool(V3, WETH, TOK, 'v3'),
    ], WETH).sort((x, y) => x.direcao.localeCompare(y.direcao));

    const pa = pernasDaCandidata(a, WETH, 777n);
    assert.equal(pa[0]!.pool, AERO, 'na direção A o Aerodrome empresta');
    assert.equal(pa[0]!.tipo, 1);
    assert.equal(pa[0]!.pagamento, 777n, 'a perna 0 do Aerodrome exige pagamento declarado');
    assert.equal(pa[1]!.tipo, 0);
    assert.equal(pa[1]!.pagamento, 0n);

    const pb = pernasDaCandidata(b, WETH, 777n);
    assert.equal(pb[0]!.pool, V3, 'na direção B o V3 empresta');
    assert.equal(pb[0]!.tipo, 0);
    // Na direcao B o Aerodrome e perna INTERNA: `0n` = gasta o que recebeu.
    assert.equal(pb[1]!.pagamento, 0n,
        'perna interna do Aerodrome com pagamento fixo ignoraria o que a perna anterior deu');

    // As duas rotas comecam e terminam na base.
    for (const r of [pa, pb]) assert.equal(r[0]!.tokenEntra, WETH.toLowerCase());
});

test('a limitação dominante segue a ORDEM da evidência', () => {
    const f = funilVazio();
    assert.match(limitacaoDominante(f), /^COBERTURA/);
    f.rotasDistintas = 10;
    assert.match(limitacaoDominante(f), /^CUSTO/);
    assert.match(limitacaoDominante(f), /não cobre as taxas somadas/);
    f.cotacoesComSobra = 3;
    assert.match(limitacaoDominante(f), /^CUSTO/);
    assert.match(limitacaoDominante(f), /menor que o custo/);
    f.validadaEmFork = 1;
    assert.match(limitacaoDominante(f), /^LATÊNCIA/);
});

test('as cinco ORIGENS saem separadas, e nenhuma soma com a outra', () => {
    const f = funilVazio();
    f.deslocamentoArtificial = 1;
    f.validadaEmFork = 1;
    const frase = comoLerOFunilMisto(f);
    assert.match(frase, /1 deslocamento artificial/);
    assert.match(frase, /1 VALIDADA em fork/);
    assert.match(frase, /0 realizada na REDE/,
        'lucro na rede tem de aparecer como zero explícito, nunca omitido');
    // E pools NAO sao oportunidades.
    f.poolsVistos = { v3: 117, aerodrome: 8 };
    assert.match(comoLerOFunilMisto(f), /0 ROTA\(S\) DISTINTA\(S\)/,
        '125 pools com zero rotas tem de ler como zero rotas');
});

test('o teto do V3 sai do preço spot, nos dois sentidos', () => {
    // sqrtP = 2^96 => preco 1:1. O teto e a propria entrada.
    const Q96 = 1n << 96n;
    assert.equal(tetoDaSaidaV3(Q96, true, 1000n), 1000n);
    assert.equal(tetoDaSaidaV3(Q96, false, 1000n), 1000n);
    // sqrtP = 2*2^96 => preco 4:1 (token1 por token0).
    assert.equal(tetoDaSaidaV3(2n * Q96, true, 1000n), 4000n);
    assert.equal(tetoDaSaidaV3(2n * Q96, false, 1000n), 250n);
    // Entrada zero ou preco zero nao tem teto: `null`, nao zero.
    assert.equal(tetoDaSaidaV3(Q96, true, 0n), null);
    assert.equal(tetoDaSaidaV3(0n, true, 1000n), null);
});

test('o pré-filtro só RECUSA, e ausência nunca descarta', () => {
    const Q96 = 1n << 96n;
    // Teto abaixo do custo: recusa, e a frase diz por que e seguro.
    const ruim = valeSimular({
        entradaBase: 1000n, tokenDoEmprestimo: 100n, sqrtPriceX96: Q96, v3ZeroParaUm: true,
    });
    assert.equal(ruim.vale, false);
    assert.match(ruim.porque, /não fecha em tamanho nenhum/);

    // Teto acima do custo: NAO aprova, so manda simular.
    const talvez = valeSimular({
        entradaBase: 100n, tokenDoEmprestimo: 1000n, sqrtPriceX96: Q96, v3ZeroParaUm: true,
    });
    assert.equal(talvez.vale, true);
    assert.match(talvez.porque, /só a execução decide/);

    // AUSENCIA de dado manda simular — nunca descarta.
    for (const falta of [
        { tokenDoEmprestimo: null, sqrtPriceX96: Q96 },
        { tokenDoEmprestimo: 100n, sqrtPriceX96: null },
    ]) {
        const r = valeSimular({ entradaBase: 1000n, v3ZeroParaUm: true, ...falta });
        assert.equal(r.vale, true, 'ausência de dado descartou rota');
        assert.equal(r.teto, null);
    }
});

test('o teto é um TETO: a saída real nunca pode passar dele', () => {
    // A regra que torna o pre-filtro valido. Com taxa e impacto de preco, a
    // saida real e menor; aqui o portao e a desigualdade em si.
    const Q96 = 1n << 96n;
    const entrada = 10n ** 18n;
    const teto = tetoDaSaidaV3(3n * Q96, true, entrada);
    assert.ok(teto !== null && teto === entrada * 9n,
        'o teto com preço 9:1 tem de ser 9x a entrada, sem desconto nenhum');
});
