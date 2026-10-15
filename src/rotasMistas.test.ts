/**
 * AS REGRAS da descoberta mista — e nao os numeros de um bloco.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    candidatasMistas, pernasDaCandidata, funilVazio, limitacaoDominante,
    comoLerOFunilMisto, razaoMaximaV3, razaoMaximaAerodrome, produtoPassaDeUm,
    semSpreadEmTamanhoNenhum, triarCandidatas, type PoolMisto, type LeiturasDoEstado,
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
    // ESTADO AVALIADO vem antes de tudo: sem um estado cotado nao existe
    // conclusao economica, e varrer bloco para DESCOBRIR pool nao e avaliar
    // estado. Defeito que ela apontou por nome: *"250 blocos observados não são
    // 250 estados avaliados."*
    assert.match(limitacaoDominante(f), /^NADA AVALIADO/);
    f.estadosAvaliados = 1;
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


// ===== O FILTRO DE SPREAD, e a INVARIANTE que ela impôs:
// *"um filtro de rejeição nunca pode rejeitar uma rota que o executor
// comprovou lucrativa naquele mesmo estado."*

const Q96 = 1n << 96n;

test('a razão do V3 sai do preço spot, e o lado inverte com o token de entrada', () => {
    // sqrtP = 2^96 => preco 1:1.
    assert.deepEqual(razaoMaximaV3(Q96, true), { num: Q96 * Q96, den: Q96 * Q96 });
    // sqrtP = 2*2^96 => token1 por token0 = 4.
    const r = razaoMaximaV3(2n * Q96, true)!;
    assert.equal(r.num / r.den, 4n);
    const inv = razaoMaximaV3(2n * Q96, false)!;
    assert.equal(inv.den / inv.num, 4n, 'entrar pelo token1 tem de dar o inverso');
    assert.equal(razaoMaximaV3(0n, true), null);
});

test('a razão do Aerodrome é a conta DELE, e epsilon zero não vira razão', () => {
    assert.deepEqual(razaoMaximaAerodrome(300n, 100n), { num: 300n, den: 100n });
    assert.equal(razaoMaximaAerodrome(null, 100n), null);
    assert.equal(razaoMaximaAerodrome(300n, 0n), null);
    assert.equal(razaoMaximaAerodrome(0n, 100n), null);
});

test('o produto é comparado com 1 sem dividir inteiros', () => {
    // 3/2 x 1/2 = 3/4: nao passa de 1.
    assert.equal(produtoPassaDeUm({ num: 3n, den: 2n }, { num: 1n, den: 2n }), false);
    // 3/2 x 3/4 = 9/8: passa.
    assert.equal(produtoPassaDeUm({ num: 3n, den: 2n }, { num: 3n, den: 4n }), true);
    // Exatamente 1 NAO passa: um ciclo que devolve o que entrou nao paga gas.
    assert.equal(produtoPassaDeUm({ num: 2n, den: 1n }, { num: 1n, den: 2n }), false);
});

test('AS UNIDADES BATEM nas duas direções — o defeito que ela achou', () => {
    // Um par com preco 1:1 nos dois pools: produto = 1, nao passa, e isso vale
    // para as duas direcoes. Se as unidades estivessem trocadas, uma das
    // direcoes daria produto 1e36 ou 1e-36 e o veredicto seria aleatorio.
    for (const direcao of ['A', 'B'] as const) {
        for (const tokenEhZero of [true, false]) {
            const v = semSpreadEmTamanhoNenhum({
                direcao,
                sqrtPriceX96: Q96,
                tokenDoMeioEhToken0NoV3: tokenEhZero,
                // 1:1 tambem no Aerodrome.
                saidaAerodromeNoEpsilon: 10n ** 12n,
                epsilon: 10n ** 12n,
            });
            assert.equal(v.vale, false,
                `direção ${direcao}, token0=${tokenEhZero}: 1:1 em ambos não fecha`);
        }
    }
});

test('spread REAL de 20% passa o filtro nas duas direções', () => {
    // O V3 paga 20% mais que o Aerodrome cobra. Nas duas direcoes o produto
    // tem de passar de 1 — e e a direcao B que a execucao provou lucrativa.
    //
    // Direcao A: compra token no Aerodrome a 1 token/WETH e vende no V3 a
    // 1,2 WETH/token.  Direcao B: compra no V3 e vende no Aerodrome, e aí quem
    // paga mais e o Aerodrome.
    const eps = 10n ** 12n;
    const aPassa = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        // V3: token do meio e token0, e 1 token0 -> 1,2 token1(WETH).
        sqrtPriceX96: (Q96 * 1095445n) / 1000000n, // sqrt(1,2) ~ 1,0954
        tokenDoMeioEhToken0NoV3: true,
        saidaAerodromeNoEpsilon: eps, // 1 token por WETH
        epsilon: eps,
    });
    assert.equal(aPassa.vale, true, 'direção A com 20% de spread foi rejeitada');

    const bPassa = semSpreadEmTamanhoNenhum({
        direcao: 'B',
        // V3: entra WETH (token1) e sai o token do meio (token0), 1:1.
        sqrtPriceX96: Q96,
        tokenDoMeioEhToken0NoV3: true,
        // Aerodrome paga 1,2 WETH por token.
        saidaAerodromeNoEpsilon: (eps * 12n) / 10n,
        epsilon: eps,
    });
    assert.equal(bPassa.vale, true, 'direção B com 20% de spread foi rejeitada');
});

test('DECIMAIS diferentes não quebram o filtro', () => {
    // Token de 6 casas contra WETH de 18: a razao fica em 1e-12, e o produto
    // com o inverso volta a ~1. Se o codigo tivesse qualquer suposicao de
    // decimais, isto quebraria.
    const eps = 10n ** 18n;
    // Aerodrome: 1 WETH (1e18) -> 1 token de 6 casas (1e6). Razao 1e-12.
    const saida = 10n ** 6n;
    // V3 paga de volta 1 WETH por token: razao 1e12. Produto = 1, nao passa.
    // sqrtP tal que token1/token0 = 1e12, com o token do meio como token0.
    const sqrt = Q96 * 10n ** 6n; // (1e6)^2 = 1e12
    const v = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        sqrtPriceX96: sqrt,
        tokenDoMeioEhToken0NoV3: true,
        saidaAerodromeNoEpsilon: saida,
        epsilon: eps,
    });
    assert.equal(v.vale, false, 'com decimais diferentes e produto exatamente 1, não fecha');

    // E com 1% a mais do lado do V3, passa.
    const melhor = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        sqrtPriceX96: (sqrt * 1005n) / 1000n,
        tokenDoMeioEhToken0NoV3: true,
        saidaAerodromeNoEpsilon: saida,
        epsilon: eps,
    });
    assert.equal(melhor.vale, true, '1% de spread com decimais diferentes foi rejeitado');
});

test('AUSÊNCIA de dado manda COTAR — nunca descarta', () => {
    for (const falta of [
        { sqrtPriceX96: null, saidaAerodromeNoEpsilon: 10n ** 12n },
        { sqrtPriceX96: Q96, saidaAerodromeNoEpsilon: null },
    ]) {
        for (const direcao of ['A', 'B'] as const) {
            const v = semSpreadEmTamanhoNenhum({
                direcao, tokenDoMeioEhToken0NoV3: true, epsilon: 10n ** 12n, ...falta,
            });
            assert.equal(v.vale, true, `direção ${direcao}: ausência de dado descartou rota`);
            assert.match(v.porque, /ausência não descarta/);
        }
    }
});

test('a recusa é sobre TODOS os tamanhos, e a frase diz por quê', () => {
    const v = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        sqrtPriceX96: Q96,
        tokenDoMeioEhToken0NoV3: true,
        saidaAerodromeNoEpsilon: 10n ** 12n / 2n,
        epsilon: 10n ** 12n,
    });
    assert.equal(v.vale, false);
    // A justificativa tem de ser a concavidade, nao "testei um tamanho".
    assert.match(v.porque, /máxima no tamanho infinitesimal/);
    assert.match(v.porque, /nenhum tamanho fecha/);
});

// --- A TRIAGEM DE UM ESTADO -------------------------------------------------
//
// Ela e o ponto de uniao: o cacador ao vivo e o avaliador em fork entregam o
// estado que leram e recebem a MESMA classificacao. Duas triagens seriam a
// REGRA 3, e a copia provaria a copia.

/** `sqrtPriceX96` de um preco `p` (token1 por token0), inteiro. */
const sqrtDe = (p: number): bigint => BigInt(Math.floor(Math.sqrt(p) * 2 ** 96));

// As DUAS leituras do Aerodrome sao diferentes de proposito: entrar com WETH e
// entrar com o token sao perguntas distintas ao mesmo pool, e usar uma resposta
// para as duas foi o que deixou este teste aprovar as duas direcoes de uma vez.
const estado = (e: {
    sqrt: bigint | null;
    aeroComWeth: bigint | null;
    aeroComTok: bigint | null;
    epsilon?: bigint;
}): LeiturasDoEstado => ({
    sqrtPorPoolV3: new Map([[V3.toLowerCase(), e.sqrt]]),
    token0PorPool: new Map(),
    saidaAerodrome: new Map([
        [`${AERO.toLowerCase()}|${WETH.toLowerCase()}`, e.aeroComWeth],
        [`${AERO.toLowerCase()}|${TOK.toLowerCase()}`, e.aeroComTok],
    ]),
    epsilon: e.epsilon ?? 1_000_000n,
    bloco: 1,
});

const asCandidatas = () => candidatasMistas(
    [pool(AERO, WETH, TOK, 'aerodrome'), pool(V3, WETH, TOK, 'v3')], WETH,
);

test('a triagem usa o token0 que a DESCOBERTA já leu, sem leitura nova', () => {
    const cs = asCandidatas();
    for (const c of cs) {
        assert.equal(c.token0DoV3, WETH.toLowerCase(),
            'o lado do token no V3 vem da descoberta: ler de novo seria gastar RPC por dado que '
            + 'o avaliador já tem, e esquecer de ler inverteria a razão do filtro');
    }
});

test('a triagem recusa as DUAS direções quando os dois pools estão 1:1', () => {
    // WETH e token0 no V3, preco 1: a razao e 1 nos dois lados. O Aerodrome
    // devolve epsilon exato: razao 1. Produto 1, que NAO passa de 1.
    const cs = asCandidatas();
    const t = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), aeroComWeth: 1_000_000n, aeroComTok: 1_000_000n }));
    assert.equal(t.valem.length, 0, 'sem spread nenhuma direção pode passar');
    assert.equal(t.recusadasPorSpread.length, cs.length);
    assert.equal(t.semDados, 0, 'havia dado: a recusa é sobre spread, não sobre ausência');
    for (const c of cs) {
        assert.match(t.veredictos.get(c.chave)!.porque, /tamanho infinitesimal/,
            'a justificativa tem de ser a concavidade, que é o que torna a recusa válida em '
            + 'TODO tamanho — um teto por tamanho não prova nada sobre os outros');
    }
});

test('a triagem passa a direção em que existe spread, e só ela', () => {
    // O Aerodrome devolve 1,2 token por WETH (razao 1,2) e o V3 esta em 1:1.
    // Direcao A (Aerodrome empresta, V3 vende): 1,2 x 1 = 1,2 -> PASSA.
    // Direcao B (V3 empresta, Aerodrome vende): 1 x (1/1,2) = 0,83 -> recusa.
    const cs = asCandidatas();
    const t = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), aeroComWeth: 1_200_000n, aeroComTok: 833_333n }));
    assert.equal(t.valem.length, 1, 'uma direção fecha e a outra não: as duas são perguntas '
        + 'diferentes, e avaliar só uma era metade da busca');
    assert.equal(t.valem[0]!.direcao, 'A');
    assert.equal(t.recusadasPorSpread[0]!.direcao, 'B');
});

test('AUSÊNCIA de dado manda cotar e é contada SEPARADA de falta de spread', () => {
    const cs = asCandidatas();
    const semSqrt = triarCandidatas(cs, WETH, estado({ sqrt: null, aeroComWeth: 1_000_000n, aeroComTok: 1_000_000n }));
    assert.equal(semSqrt.valem.length, cs.length, 'sem `slot0` não há produto, e "não sei" '
        + 'nunca autoriza descartar rota');
    assert.equal(semSqrt.semDados, cs.length);
    assert.equal(semSqrt.recusadasPorSpread.length, 0);

    const semAero = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), aeroComWeth: null, aeroComTok: null }));
    assert.equal(semAero.valem.length, cs.length);
    assert.equal(semAero.semDados, cs.length,
        'falta de dado e falta de spread pedem consertos OPOSTOS: uma é o avaliador, a outra é '
        + 'o mercado. Somá-las apagaria a única informação que o funil tem');
});

test('a INVARIANTE dela: o filtro não pode recusar rota com spread de verdade', () => {
    // 20% de spread real, nas duas direcoes, e em decimais diferentes (o
    // Aerodrome respondendo em 6 casas contra 18 do WETH).
    const cs = asCandidatas();
    const paraA = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), aeroComWeth: 1_200_000n, aeroComTok: 833_333n }));
    assert.ok(paraA.valem.some((c) => c.direcao === 'A'),
        'INVARIANTE: um filtro de rejeição nunca pode rejeitar uma rota que o executor '
        + 'comprovaria lucrativa naquele mesmo estado');
    // Agora o spread esta do outro lado: o V3 paga 1,2 token por WETH.
    const paraB = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1.2), aeroComWeth: 1_000_000n, aeroComTok: 1_000_000n }));
    assert.ok(paraB.valem.some((c) => c.direcao === 'B'),
        'a direção B foi a que FECHOU na prova de execução atômica (0,0598 WETH líquido): um '
        + 'filtro que a recusa apaga a única rota provada deste projeto');
});

test('EXPIRADO não é falta de spread, e a limitação dominante diz isso', () => {
    const f = funilVazio();
    f.estadosAvaliados = 3;
    f.rotasDistintas = 10;
    f.cotacoesTentadas = 8;
    f.expirado = 8;
    const frase = limitacaoDominante(f);
    assert.match(frase, /^LATÊNCIA/);
    assert.match(frase, /não é prejuízo/,
        'sinal que expirou antes da decisão é atraso do avaliador. Chamar isso de prejuízo seria '
        + 'cobrar do mercado um custo que não existiu, e chamar de falta de spread seria publicar '
        + 'a minha latência como propriedade do mercado');
    assert.match(comoLerOFunilMisto(f), /8 EXPIRADO/);
});

test('o funil separa DESCOBERTA de ESTADO AVALIADO na própria frase', () => {
    const f = funilVazio();
    f.blocosVarridosParaDescoberta = 250;
    f.estadosAvaliados = 5;
    const frase = comoLerOFunilMisto(f);
    assert.match(frase, /250 bloco\(s\) varridos para DESCOBERTA/);
    assert.match(frase, /5 ESTADO\(S\) distinto\(s\) avaliado\(s\)/,
        '250 blocos observados não são 250 estados avaliados: o `hardhat_reset` acontecia uma '
        + 'vez e tudo era cotado no mesmo estado');
});
