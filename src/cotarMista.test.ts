/**
 * AS REGRAS da cotacao de baixa latencia — e nao os numeros de um bloco.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    QUOTER_V2, quoterServeOPool, codificarQuoteV3, codificarGetAmountOut, primeiraPalavra,
    escadaDeTamanhos, percentis, LivroDeSinais, EstadoDosPools, type SinalDeArbitragem,
    codificarCotarCiclo, lerRespostaDaCotacao, lerCodigoDoCotador,
    SELETOR_LUCRO_INSUFICIENTE, SELETOR_PAGAMENTO_CURTO, COTADOR_LOCAL,
    impressaoDoEstado, estadoInconsistente,
} from './cotarMista';

const WETH = '0x4200000000000000000000000000000000000006';
const TOK = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';
const FABRICA = '0x33128a8fc17869897dce68ed026d694621f6fdfd';

test('compatibilidade do quoter é CONFERIDA, e ausência nunca autoriza cotar', () => {
    assert.equal(quoterServeOPool(FABRICA, FABRICA), true);
    assert.equal(quoterServeOPool(FABRICA, FABRICA.toUpperCase()), true,
        'maiúscula de endereço não é fábrica diferente');
    assert.equal(quoterServeOPool(FABRICA, '0x' + '11'.repeat(20)), false,
        'pool de outra fábrica não pode ser cotado por este quoter: o número seria de outro pool');
    // AUSENCIA: aqui ela NAO manda cotar, e isto é o oposto do filtro de
    // spread de propósito. Lá a ausência não pode DESCARTAR; aqui ela não pode
    // AUTORIZAR. As duas regras protegem a mesma coisa: não afirmar sem prova.
    assert.equal(quoterServeOPool(null, FABRICA), false);
    assert.equal(quoterServeOPool(FABRICA, null), false);
});

test('o quote V3 leva o fee do PRÓPRIO pool, e a tupla é estática', () => {
    const d = codificarQuoteV3({ tokenEntra: WETH, tokenSai: TOK, quantia: 10n ** 16n, taxa: 500 });
    // seletor + 5 palavras de 32 bytes, sem nenhum offset dinâmico.
    assert.equal(d.length, 10 + 5 * 64, 'a tupla tem 5 palavras e nenhum offset');
    assert.ok(d.includes(WETH.slice(2).toLowerCase()));
    assert.ok(d.includes(TOK.slice(2).toLowerCase()));
    // 500 = 0x1f4 na quarta palavra.
    assert.equal(BigInt(`0x${d.slice(10 + 3 * 64, 10 + 4 * 64)}`), 500n);
    // sqrtPriceLimitX96 = 0: sem limite de preço.
    assert.equal(BigInt(`0x${d.slice(10 + 4 * 64)}`), 0n);
    assert.equal(QUOTER_V2, QUOTER_V2.toLowerCase(), 'o endereço fica em minúsculo para comparar');
});

test('o getAmountOut do Aerodrome manda a quantia e o token que ENTRA', () => {
    const d = codificarGetAmountOut(777n, TOK);
    assert.equal(d.length, 10 + 2 * 64);
    assert.equal(BigInt(`0x${d.slice(10, 10 + 64)}`), 777n);
    assert.ok(d.endsWith(TOK.slice(2).toLowerCase()));
});

test('resposta curta é `null` e ZERO é resposta — nunca a mesma coisa', () => {
    assert.equal(primeiraPalavra(null), null);
    assert.equal(primeiraPalavra('0x'), null);
    assert.equal(primeiraPalavra(`0x${'0'.repeat(62)}`), null, 'palavra incompleta é ausência');
    assert.equal(primeiraPalavra(`0x${'0'.repeat(64)}`), 0n,
        'zero é uma cotação válida de "não sai nada", e confundi-la com ausência é o defeito '
        + 'que este projeto persegue');
    assert.equal(primeiraPalavra(`0x${'0'.repeat(63)}5`), 5n);
});

test('a escada começa no MENOR tamanho, porque é ele que tem a melhor razão', () => {
    const e = escadaDeTamanhos(10n ** 21n);
    assert.ok(e.length > 1);
    for (let i = 1; i < e.length; i += 1) {
        assert.ok(e[i]! > e[i - 1]!,
            'a escada sobe: o menor é cotado primeiro porque a razão saída/entrada é máxima no '
            + 'tamanho infinitesimal, então se o menor não tem sobra nenhum maior tem');
    }
    assert.deepEqual(escadaDeTamanhos(0n), [], 'sem liquidez não há tamanho — e não é zero');
    assert.deepEqual(escadaDeTamanhos(5n), [], 'liquidez que não dá nem um passo da escada');
});

test('percentis saem do elemento, não de interpolação inventada', () => {
    assert.deepEqual(percentis([]), { p50: null, p95: null, p99: null },
        'amostra vazia não vira zero: "sem amostra" e "zero ms" são conclusões opostas');
    const p = percentis([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.equal(p.p50, 60);
    assert.ok(p.p95! >= p.p50!);
    assert.ok(p.p99! >= p.p95!);
    assert.equal(percentis([7]).p99, 7, 'uma amostra: os três percentis são ela');
});

const sinal = (over: Partial<SinalDeArbitragem> = {}): SinalDeArbitragem => ({
    rota: 'A|a|v|t',
    protocolo: 'V3+Aerodrome',
    bloco: 1,
    etiqueta: 'pending',
    observadoEm: 0,
    msAteADecisao: 100,
    idadeDoEstadoMs: 100,
    melhorTamanho: 10n,
    lucroBrutoEstimado: null,
    custoTotalEstimado: null,
    lucroLiquidoEstimado: null,
    simulacao: null,
    motivo: 'SEM SPREAD neste estado',
    ...over,
});

test('bruto positivo, líquido positivo e expirado são contagens SEPARADAS', () => {
    const l = new LivroDeSinais();
    // Sobra bruta que o custo come: positiva no bruto, NEGATIVA no líquido.
    l.registrar(sinal({ lucroBrutoEstimado: 100n, custoTotalEstimado: 400n, lucroLiquidoEstimado: -300n }));
    l.registrar(sinal({ lucroBrutoEstimado: 900n, custoTotalEstimado: 400n, lucroLiquidoEstimado: 500n }));
    l.registrar(sinal({ motivo: 'EXPIRADO: o estado mudou antes da decisão' }));
    const c = l.contar();
    assert.equal(c.brutosPositivos, 2);
    assert.equal(c.liquidosPositivos, 1,
        'somar bruto e líquido publicaria como oportunidade uma sobra que o gás come inteira');
    assert.equal(c.expirados, 1);
    const frase = l.comoLer();
    assert.match(frase, /2 com lucro BRUTO positivo/);
    assert.match(frase, /1 com lucro LÍQUIDO positivo/);
    assert.match(frase, /1 EXPIRADO/);
    assert.match(frase, /nenhum prova INCLUSÃO/,
        'cotar antes de dois segundos não é capturar, e a frase tem de dizer isso onde o número '
        + 'é lido');
});

test('livro vazio NÃO é "não há spread"', () => {
    assert.match(new LivroDeSinais().comoLer(), /ausência de sinal avaliado/);
});

test('a latência de OBSERVAÇÃO e a da COTAÇÃO são medidas separadas', () => {
    const l = new LivroDeSinais();
    l.registrar(sinal({ msAteADecisao: 300, idadeDoEstadoMs: 300 }));
    l.registrarCotacao(80);
    assert.equal(l.latenciaDeObservacao.p50, 300);
    assert.equal(l.latenciaDaCotacao.p50, 80);
    assert.equal(l.quantasCotacoes, 1);
    assert.notEqual(l.latenciaDeObservacao.p50, l.latenciaDaCotacao.p50,
        'a latência do laboratório não pode entrar na de observação: foi misturar as duas que '
        + 'produziu a conclusão retirada de "36/36 expiraram no mercado"');
});

test('só pool que MUDOU volta, e leitura que não veio não é mudança', () => {
    const e = new EstadoDosPools();
    // A primeira leitura conta: é a primeira vez que existe estado.
    assert.deepEqual(e.mudaram(new Map([['p1', 'a'], ['p2', 'b']])), ['p1', 'p2']);
    // Estado idêntico não volta: recotar repetiria a resposta e gastaria RPC.
    assert.deepEqual(e.mudaram(new Map([['p1', 'a'], ['p2', 'b']])), []);
    assert.deepEqual(e.mudaram(new Map([['p1', 'a'], ['p2', 'c']])), ['p2']);
    // Leitura ausente NAO apaga o que se sabia e NAO conta como mudança.
    assert.deepEqual(e.mudaram(new Map([['p1', null]])), []);
    assert.deepEqual(e.mudaram(new Map([['p1', 'a']])), [],
        'null não pode ter sobrescrito o estado conhecido: isso faria toda falha de RPC parecer '
        + 'uma mudança de mercado');
    assert.equal(e.quantosConhecidos, 2);
});

test('a comparação de estado é da resposta INTEIRA, não de um prefixo', () => {
    const e = new EstadoDosPools();
    const a = `v3:${'0'.repeat(60)}1`;
    const b = `v3:${'0'.repeat(60)}2`;
    e.mudaram(new Map([['p', a]]));
    assert.deepEqual(e.mudaram(new Map([['p', b]])), ['p'],
        'comparar prefixo foi defeito medido neste projeto: 48 caracteres de `slot0` são quase '
        + 'todos zero, e "o pool não mudou" era propriedade do instrumento');
});

// --- O COTADOR LOCAL por override de estado ---------------------------------

test('os seletores das reversões são CALCULADOS, e batem com o contrato', () => {
    // Conferidos contra a interface compilada do `CacadorV3` em 2026-10-15. Eu
    // havia escrito `0x8f4eb604` e `0xd0d0b1a6` de cabeça: os DOIS estavam
    // errados, e com eles a cotação devolveria `null` para sempre — o log
    // diria "sem dado" sobre um número que estava na resposta.
    assert.equal(SELETOR_LUCRO_INSUFICIENTE, '0x9612b7e0');
    assert.equal(SELETOR_PAGAMENTO_CURTO, '0xba64f239');
});

test('PagamentoCurto e LucroInsuficiente dizem coisas OPOSTAS', () => {
    const p = (a: bigint, b: bigint): string => a.toString(16).padStart(64, '0')
        + b.toString(16).padStart(64, '0');
    // O caso REAL medido na rede: 0,01 WETH num ciclo V3 500 -> 3000.
    const curto = lerRespostaDaCotacao(SELETOR_PAGAMENTO_CURTO + p(9939992138238505n, 10n ** 16n));
    assert.equal(curto!.produziu, 9939992138238505n);
    assert.equal(curto!.sobra, -60007861761495n,
        'o ciclo NÃO fechou: a sobra é negativa, e publicá-la como lucro seria publicar prejuízo '
        + 'como ganho');
    // LucroInsuficiente quer dizer que o ciclo FECHOU e sobrou.
    const lucro = lerRespostaDaCotacao(SELETOR_LUCRO_INSUFICIENTE + p(500n, 1_000n));
    assert.equal(lucro!.sobra, 500n);
    assert.equal(lucro!.devido, 0n, 'aqui o pagamento já aconteceu: não há devido');
    // Reversão opaca NÃO é cotação.
    assert.equal(lerRespostaDaCotacao('0xdeadbeef' + p(1n, 2n)), null);
    assert.equal(lerRespostaDaCotacao(null), null);
    assert.equal(lerRespostaDaCotacao(SELETOR_PAGAMENTO_CURTO), null,
        'seletor sem as duas palavras é resposta cortada, não cotação');
});

test('o encode do ciclo tem o offset do array dinâmico no lugar certo', () => {
    const pernas = [
        { pool: `0x${'11'.repeat(20)}`, tokenEntra: WETH, tipo: 0, pagamento: 0n },
        { pool: `0x${'22'.repeat(20)}`, tokenEntra: TOK, tipo: 1, pagamento: 7n },
    ];
    const d = codificarCotarCiclo(pernas, 10n ** 16n);
    // seletor + offset + quantia + tamanho + 2 pernas x 4 palavras
    assert.equal(d.length, 10 + (3 + 8) * 64);
    assert.equal(BigInt(`0x${d.slice(10, 74)}`), 64n, 'o offset do array é 64: dois argumentos '
        + 'de cabeça × 32 bytes. Offset mal lido foi o defeito que publicou dez medições erradas');
    assert.equal(BigInt(`0x${d.slice(74, 138)}`), 10n ** 16n);
    assert.equal(BigInt(`0x${d.slice(138, 202)}`), 2n, 'o tamanho do array vem depois do offset');
    // A segunda perna ocupa as palavras 7..10: pool, token, tipo, pagamento.
    // (Eu havia conferido a palavra 7, que é o POOL — o encode estava certo e o
    // índice do teste errado. O encode em si é conferido byte a byte contra o
    // `ethers` fora daqui.)
    assert.equal(BigInt(`0x${d.slice(10 + 9 * 64, 10 + 10 * 64)}`), 1n, 'tipo da perna 2');
    assert.equal(BigInt(`0x${d.slice(10 + 10 * 64, 10 + 11 * 64)}`), 7n);
});

test('sem artefato NÃO há cotação, e isso não vira zero', () => {
    assert.equal(lerCodigoDoCotador('/nao/existe/artefato.json'), null,
        'falta de instrumento e falta de spread pedem ações opostas: a primeira é compilar, a '
        + 'segunda é o mercado');
    assert.equal(COTADOR_LOCAL, COTADOR_LOCAL.toLowerCase(),
        'o endereço do override entra na chave do mapa de override e é comparado em minúsculo');
});

// --- MUDANCA INTRABLOCO e CONSISTENCIA DE ESTADO ---------------------------

test('DUAS mudanças de pending no MESMO bloco confirmado são estados distintos', () => {
    // O gatilho antigo era `blocoAgora !== blocoDaTriagem`: com o bloco
    // confirmado igual, nada era reavaliado e toda mudança intrabloco ficava
    // invisível. A impressão do estado é o que a torna visível.
    const bloco = 52_660_000;
    const a = impressaoDoEstado(new Map([['p1', 'v3:100'], ['p2', 'ae:5/7']]));
    const b = impressaoDoEstado(new Map([['p1', 'v3:101'], ['p2', 'ae:5/7']]));
    const c = impressaoDoEstado(new Map([['p1', 'v3:101'], ['p2', 'ae:6/7']]));
    assert.notEqual(a, b, 'primeira mudança intrabloco');
    assert.notEqual(b, c, 'segunda mudança intrabloco');
    const distintos = new Set([a, b, c]);
    assert.equal(distintos.size, 3,
        `três estados distintos no bloco confirmado ${bloco}: um gatilho por número de bloco `
        + 'veria UM');
    // Estado idêntico NÃO é estado novo: recotar repetiria a resposta.
    assert.equal(impressaoDoEstado(new Map([['p2', 'ae:5/7'], ['p1', 'v3:100']])), a,
        'a impressão não pode depender da ordem de iteração do mapa');
});

test('ausência entra na impressão como ausência, não como zero', () => {
    const comNulo = impressaoDoEstado(new Map([['p1', null]]));
    const comZero = impressaoDoEstado(new Map([['p1', 'v3:0']]));
    assert.notEqual(comNulo, comZero,
        '"não li" e "li zero" são estados diferentes, e tratá-los como iguais faria uma falha de '
        + 'RPC parecer um pool esvaziado');
});

test('ESTADO_INCONSISTENTE olha só os pools DA ROTA', () => {
    const antes = new Map<string, string | null>([
        ['pv3', 'v3:100'], ['paero', 'ae:5/7'], ['alheio', 'v3:1'],
    ]);
    const depois = new Map<string, string | null>([
        ['pv3', 'v3:100'], ['paero', 'ae:5/7'], ['alheio', 'v3:999'],
    ]);
    assert.equal(estadoInconsistente(antes, depois, ['pv3', 'paero']), false,
        'pool alheio ter mudado não torna esta cotação inconsistente — tratar como se tornasse '
        + 'jogaria fora cotação boa');
    depois.set('pv3', 'v3:101');
    assert.equal(estadoInconsistente(antes, depois, ['pv3', 'paero']), true,
        'o pool da rota mudou entre a leitura e a cotação: a conta somou dois instantes');
    // Pool que não foi relido NÃO afirma mudança.
    assert.equal(estadoInconsistente(antes, new Map(), ['pv3', 'paero']), false,
        'não reli não é "mudou": inventar mudança descartaria oportunidade real');
});
