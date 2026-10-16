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
    endereco: e,
    token0: t0,
    token1: t1,
    venue,
    taxa: venue === 'v3' ? 3000 : null,
    // `stable() == false` LIDO: so com isso existe teto demonstrado.
    estavel: venue === 'aerodrome' ? false : null,
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

test('dois AERODROME não formam rota; dois CONCENTRADOS formam, nas duas ordens', () => {
    // DOIS AERODROME continuam fora: o ciclo entre dois pools Velodrome V2 do
    // mesmo par é o que a ENTREGA 1 já cobre, e duplicá-lo aqui inflaria a
    // contagem com rota que outro caminho já avalia.
    assert.deepEqual(candidatasMistas([
        pool(AERO, WETH, TOK, 'aerodrome'),
        pool('0xdd', WETH, TOK, 'aerodrome'),
    ], WETH), []);

    // DOIS CONCENTRADOS passam a formar rota, e isto é medido, não preferência:
    // 2 das 7 operações lucrativas reconciliadas são exatamente esta forma
    // (`CC`, 2 swaps: 0x0aa98647 com 0,0270 WETH e 0x12226f04 com 0,00024), e
    // 131 dos 156 pares no mesmo token cruzam fábrica.
    const duas = candidatasMistas([
        pool(V3, WETH, TOK, 'v3'),
        pool(`0x${'ee'.repeat(20)}`, WETH, TOK, 'v3'),
    ], WETH);
    assert.equal(duas.length, 2, 'as duas ORDENS são as duas direções, e contam separado');
    assert.equal(duas[0]!.pernas.length, 2);
    // A direção está na ORDEM: a perna 0 empresta. E os campos de rota MISTA
    // ficam AUSENTES aqui em vez de mentir sobre qual pool é qual — foi isso
    // que ela proibiu por nome.
    for (const c of duas) {
        assert.equal(c.direcao, undefined);
        assert.equal(c.poolAerodrome, undefined);
        assert.equal(c.poolV3, undefined,
            'reutilizar `poolV3` para um dos dois pools V3 faria o campo descrever a rota '
            + 'errada em metade dos casos');
        assert.equal(c.pernas[0]!.protocolo, 'v3');
        assert.equal(c.pernas[1]!.protocolo, 'v3');
        assert.notEqual(c.pernas[0]!.pool, c.pernas[1]!.pool);
    }
    // Trocar a ordem é a outra rota, e a chave distingue as duas.
    assert.notEqual(duas[0]!.chave, duas[1]!.chave);
    assert.equal(duas[0]!.pernas[0]!.pool, duas[1]!.pernas[1]!.pool);

    // E o mesmo pool duas vezes NÃO é rota.
    assert.deepEqual(candidatasMistas([pool(V3, WETH, TOK, 'v3')], WETH), []);
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
    // A DIRECAO esta na ORDEM das pernas: a 0 empresta. Ordeno pela perna 0
    // para o teste nao depender de um rotulo que a forma nova nao tem.
    ], WETH).sort((x, y) => x.pernas[0].protocolo.localeCompare(y.pernas[0].protocolo));

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
    f.estadosDistintos = 1;
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

test('a razão do Aerodrome sai das RESERVAS, e só para volatile comprovado', () => {
    // `rSai / rEntra`, cru, sem descontar taxa: descontar aperta o teto e um
    // teto apertado RECUSA rota boa, que e o defeito que ela achou.
    assert.deepEqual(razaoMaximaAerodrome(100n, 300n, true), { num: 300n, den: 100n });
    // STABLE nao tem teto demonstrado: `x³y + y³x = k` nao e `x·y = k`.
    assert.equal(razaoMaximaAerodrome(100n, 300n, false), null,
        'pool stable não pode ser descartado por um teto que só vale para o invariante xy=k');
    assert.equal(razaoMaximaAerodrome(100n, 300n, null), null,
        '`stable()` sem resposta é ausência, e ausência não descarta');
    assert.equal(razaoMaximaAerodrome(null, 300n, true), null);
    assert.equal(razaoMaximaAerodrome(0n, 300n, true), null);
    assert.equal(razaoMaximaAerodrome(100n, 0n, true), null);
});

test('O FALSO NEGATIVO que ela comprovou: a cotação finita NÃO é teto', () => {
    // A formula EXATA do Aerodrome volatile, com taxa de 30bp.
    const saida = (x: bigint, rEntra: bigint, rSai: bigint, taxaBp: bigint): bigint => {
        const xf = (x * (10_000n - taxaBp)) / 10_000n;
        return (rSai * xf) / (rEntra + xf);
    };
    const rEntra = 1000n * 10n ** 18n;
    const rSai = 1000n * 10n ** 18n;
    // MEDIDO: a razao CAI com o tamanho e fica sempre abaixo da marginal.
    const r1 = saida(10n ** 12n, rEntra, rSai, 30n);
    const r2 = saida(100n * 10n ** 18n, rEntra, rSai, 30n);
    assert.ok(r1 * (100n * 10n ** 18n) > r2 * 10n ** 12n,
        'a razão saída/entrada tem de CAIR com o tamanho — é isso que torna a cotação num '
        + 'tamanho um teto só para os tamanhos MAIORES que ele, nunca para os menores');
    assert.ok(r2 * rEntra < rSai * (100n * 10n ** 18n),
        'a cotação finita fica SEMPRE abaixo da marginal rSai/rEntra: usá-la como teto é usar '
        + 'um número menor que o máximo, e um teto menor que o máximo produz falso negativo');

    // O ESTADO DO FALSO NEGATIVO. O V3 paga 5% a mais que 1:1, modelado pelas
    // reservas VIRTUAIS que a liquidez concentrada implica — ali a conta do V3
    // dentro de um tick e exatamente `x·y = k`.
    const vEntra = 1000n * 10n ** 18n;
    const vSai = (1050n * 10n ** 18n);
    const sqrtV3 = sqrtDe(1.05);

    // 1) O FILTRO ANTIGO, reproduzido: razao do Aerodrome pela cotacao de um
    //    tamanho finito (100 WETH, que era um dos tamanhos avaliados).
    const epsilonAntigo = 100n * 10n ** 18n;
    const razaoAntiga = { num: saida(epsilonAntigo, rEntra, rSai, 30n), den: epsilonAntigo };
    const razaoV3 = razaoMaximaV3(sqrtV3, true)!;
    assert.equal(produtoPassaDeUm(razaoAntiga, razaoV3), false,
        'o filtro ANTIGO tem de REJEITAR este estado — é o falso negativo que ela comprovou');

    // 2) A EXECUCAO MENOR e lucrativa de verdade, pelas formulas exatas das
    //    duas pernas (1 WETH contra reservas de 1000).
    const entrada = 10n ** 18n;
    const noMeio = saida(entrada, rEntra, rSai, 30n);
    const devolta = saida(noMeio, vEntra, vSai, 5n); // V3 em 5bp
    assert.ok(devolta > entrada,
        `a execução de 1 WETH devolve ${devolta} contra ${entrada} que entraram: é LUCRATIVA, `
        + 'e o filtro antigo a descartava');

    // 3) O FILTRO NOVO PRESERVA ela.
    const novo = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        sqrtPriceX96: sqrtV3,
        tokenDoMeioEhToken0NoV3: true,
        reservaEntraNoAero: rEntra,
        reservaSaiNoAero: rSai,
        aeroEhVolatile: true,
    });
    assert.equal(novo.vale, true,
        'INVARIANTE: o filtro novo não pode rejeitar a rota que a execução prova lucrativa');
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
                // 1:1 tambem no Aerodrome, pelas reservas.
                reservaEntraNoAero: 10n ** 21n,
                reservaSaiNoAero: 10n ** 21n,
                aeroEhVolatile: true,
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
    const aPassa = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        // V3: token do meio e token0, e 1 token0 -> 1,2 token1(WETH).
        sqrtPriceX96: (Q96 * 1095445n) / 1000000n, // sqrt(1,2) ~ 1,0954
        tokenDoMeioEhToken0NoV3: true,
        reservaEntraNoAero: 10n ** 21n, // 1 token por WETH
        reservaSaiNoAero: 10n ** 21n,
        aeroEhVolatile: true,
    });
    assert.equal(aPassa.vale, true, 'direção A com 20% de spread foi rejeitada');

    const bPassa = semSpreadEmTamanhoNenhum({
        direcao: 'B',
        // V3: entra WETH (token1) e sai o token do meio (token0), 1:1.
        sqrtPriceX96: Q96,
        tokenDoMeioEhToken0NoV3: true,
        // Aerodrome paga 1,2 WETH por token.
        reservaEntraNoAero: 10n ** 21n,
        reservaSaiNoAero: (10n ** 21n * 12n) / 10n,
        aeroEhVolatile: true,
    });
    assert.equal(bPassa.vale, true, 'direção B com 20% de spread foi rejeitada');
});

test('DECIMAIS diferentes não quebram o filtro', () => {
    // Token de 6 casas contra WETH de 18: a razao fica em 1e-12, e o produto
    // com o inverso volta a ~1. Se o codigo tivesse qualquer suposicao de
    // decimais, isto quebraria.
    // Aerodrome: reservas de 1000 WETH (1e21) contra 1000 tokens de 6 casas
    // (1e9). Razao 1e-12, em unidade CRUA nas duas pontas.
    // V3 paga de volta 1 WETH por token: razao 1e12. Produto = 1, nao passa.
    // sqrtP tal que token1/token0 = 1e12, com o token do meio como token0.
    const sqrt = Q96 * 10n ** 6n; // (1e6)^2 = 1e12
    const v = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        sqrtPriceX96: sqrt,
        tokenDoMeioEhToken0NoV3: true,
        reservaEntraNoAero: 10n ** 21n,
        reservaSaiNoAero: 10n ** 9n,
        aeroEhVolatile: true,
    });
    assert.equal(v.vale, false, 'com decimais diferentes e produto exatamente 1, não fecha');

    // E com 1% a mais do lado do V3, passa.
    const melhor = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        sqrtPriceX96: (sqrt * 1005n) / 1000n,
        tokenDoMeioEhToken0NoV3: true,
        reservaEntraNoAero: 10n ** 21n,
        reservaSaiNoAero: 10n ** 9n,
        aeroEhVolatile: true,
    });
    assert.equal(melhor.vale, true, '1% de spread com decimais diferentes foi rejeitado');
});

test('AUSÊNCIA de dado manda COTAR — nunca descarta', () => {
    const cheio = {
        sqrtPriceX96: Q96 as bigint | null,
        reservaEntraNoAero: 10n ** 21n as bigint | null,
        reservaSaiNoAero: 10n ** 21n as bigint | null,
        aeroEhVolatile: true as boolean | null,
    };
    for (const falta of [
        { ...cheio, sqrtPriceX96: null },
        { ...cheio, reservaEntraNoAero: null },
        { ...cheio, reservaSaiNoAero: null },
    ]) {
        for (const direcao of ['A', 'B'] as const) {
            const v = semSpreadEmTamanhoNenhum({
                direcao, tokenDoMeioEhToken0NoV3: true, ...falta,
            });
            assert.equal(v.vale, true, `direção ${direcao}: ausência de dado descartou rota`);
            assert.match(v.porque, /ausência não descarta/);
        }
    }
    // POOL STABLE: nao e ausencia de dado, e a frase tem de dizer OUTRA coisa —
    // o teto nao esta demonstrado para o invariante dele.
    for (const estavel of [true, null]) {
        const v = semSpreadEmTamanhoNenhum({
            direcao: 'A', tokenDoMeioEhToken0NoV3: true, ...cheio, aeroEhVolatile: estavel === true ? false : null,
        });
        if (estavel === true) continue;
        assert.equal(v.vale, true);
        assert.match(v.porque, /não é COMPROVADAMENTE volatile/);
    }
});

test('a recusa é sobre TODOS os tamanhos, e a frase diz por quê', () => {
    const v = semSpreadEmTamanhoNenhum({
        direcao: 'A',
        sqrtPriceX96: Q96,
        tokenDoMeioEhToken0NoV3: true,
        reservaEntraNoAero: 10n ** 21n,
        reservaSaiNoAero: 10n ** 21n / 2n,
        aeroEhVolatile: true,
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
// As reservas do Aerodrome na ordem `token0, token1` — e `token0` do pool de
// teste e o WETH, entao `r0` e a reserva de WETH.
const estado = (e: {
    sqrt: bigint | null;
    rWeth: bigint | null;
    rTok: bigint | null;
}): LeiturasDoEstado => ({
    sqrtPorPoolV3: new Map([[V3.toLowerCase(), e.sqrt]]),
    token0PorPool: new Map(),
    reservasAerodrome: new Map([[
        AERO.toLowerCase(),
        e.rWeth === null || e.rTok === null ? null : { r0: e.rWeth, r1: e.rTok },
    ]]),
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
    const t = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), rWeth: 10n ** 21n, rTok: 10n ** 21n }));
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
    const t = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), rWeth: 10n ** 21n, rTok: (10n ** 21n * 12n) / 10n }));
    assert.equal(t.valem.length, 1, 'uma direção fecha e a outra não: as duas são perguntas '
        + 'diferentes, e avaliar só uma era metade da busca');
    assert.equal(t.valem[0]!.direcao, 'A');
    assert.equal(t.recusadasPorSpread[0]!.direcao, 'B');
});

test('AUSÊNCIA de dado manda cotar e é contada SEPARADA de falta de spread', () => {
    const cs = asCandidatas();
    const semSqrt = triarCandidatas(cs, WETH, estado({ sqrt: null, rWeth: 10n ** 21n, rTok: 10n ** 21n }));
    assert.equal(semSqrt.valem.length, cs.length, 'sem `slot0` não há produto, e "não sei" '
        + 'nunca autoriza descartar rota');
    assert.equal(semSqrt.semDados, cs.length);
    assert.equal(semSqrt.recusadasPorSpread.length, 0);

    const semAero = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), rWeth: null, rTok: null }));
    assert.equal(semAero.valem.length, cs.length);
    assert.equal(semAero.semDados, cs.length,
        'falta de dado e falta de spread pedem consertos OPOSTOS: uma é o avaliador, a outra é '
        + 'o mercado. Somá-las apagaria a única informação que o funil tem');
});

test('a INVARIANTE dela: o filtro não pode recusar rota com spread de verdade', () => {
    // 20% de spread real, nas duas direcoes, e em decimais diferentes (o
    // Aerodrome respondendo em 6 casas contra 18 do WETH).
    const cs = asCandidatas();
    const paraA = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1), rWeth: 10n ** 21n, rTok: (10n ** 21n * 12n) / 10n }));
    assert.ok(paraA.valem.some((c) => c.direcao === 'A'),
        'INVARIANTE: um filtro de rejeição nunca pode rejeitar uma rota que o executor '
        + 'comprovaria lucrativa naquele mesmo estado');
    // Agora o spread esta do outro lado: o V3 paga 1,2 token por WETH.
    const paraB = triarCandidatas(cs, WETH, estado({ sqrt: sqrtDe(1.2), rWeth: 10n ** 21n, rTok: 10n ** 21n }));
    assert.ok(paraB.valem.some((c) => c.direcao === 'B'),
        'a direção B foi a que FECHOU na prova de execução atômica (0,0598 WETH líquido): um '
        + 'filtro que a recusa apaga a única rota provada deste projeto');
});

test('EXPIRADO não é falta de spread, e a limitação dominante diz isso', () => {
    const f = funilVazio();
    f.estadosDistintos = 3;
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
    f.amostrasLidas = 12;
    f.estadosDistintos = 5;
    f.estadosComRotaAfetada = 2;
    f.sinaisCotados = 1;
    const frase = comoLerOFunilMisto(f);
    assert.match(frase, /250 bloco\(s\) varridos para DESCOBERTA/);
    // AS QUATRO PERGUNTAS, separadas: ela apontou que `estadosAvaliados` era
    // incrementado antes do descarte por impressao repetida, entao contava
    // amostra como estado distinto.
    assert.match(frase, /12 amostra\(s\) lida\(s\)/);
    assert.match(frase, /5 ESTADO\(S\) DISTINTO\(S\)/);
    assert.match(frase, /2 com pool de rota alterado/);
    assert.match(frase, /1 sinal\(is\) COTADO\(S\)/,
        '250 blocos observados não são 250 estados avaliados: o `hardhat_reset` acontecia uma '
        + 'vez e tudo era cotado no mesmo estado');
});

test('pool STABLE não é descartado, e não é contado como falta de dado', () => {
    const pools = [
        { ...pool(AERO, WETH, TOK, 'aerodrome' as const), estavel: true },
        pool(V3, WETH, TOK, 'v3' as const),
    ];
    const cs = candidatasMistas(pools, WETH);
    // O estado esta COMPLETO: `slot0` e reservas lidos, e as razoes dariam
    // produto 1. Mesmo assim nada pode ser descartado — o teto das reservas sai
    // do invariante `x·y = k`, e o pool stable usa outro.
    const t = triarCandidatas(cs, WETH, estado({
        sqrt: sqrtDe(1), rWeth: 10n ** 21n, rTok: 10n ** 21n,
    }));
    assert.equal(t.recusadasPorSpread.length, 0,
        'pool stable descartado por um teto que não vale para o invariante dele é exatamente o '
        + 'falso negativo que ela proibiu');
    assert.equal(t.valem.length, cs.length);
    assert.equal(t.semProvaDoInvariante, cs.length);
    assert.equal(t.semDados, 0,
        'a leitura VEIO: chamar isto de falta de dado mandaria consertar o RPC quando o que '
        + 'falta é a demonstração matemática');
});

test('o funil separa ESTADO_INCONSISTENTE de expiração e de falta de spread', () => {
    const f = funilVazio();
    f.estadosDistintos = 1;
    f.rotasDistintas = 4;
    f.cotacoesTentadas = 2;
    f.estadosInconsistentes = 2;
    const frase = comoLerOFunilMisto(f);
    // A frase passou a separar as TRÊS respostas do comparador: consistente,
    // inconsistente e não validado. Antes eram duas, e ausência de leitura
    // caía em "consistente" — afirmar estado validado sem ter lido.
    assert.match(frase, /ESTADO: 0 consistente, 2 inconsistente, 0 não validado/);
    assert.match(frase, /0 EXPIRADO/,
        'expiração e inconsistência são causas diferentes: uma é chegar tarde, a outra é somar '
        + 'dois instantes. Pedem consertos opostos');
});
