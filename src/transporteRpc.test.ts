/**
 * O TRANSPORTE, exercitado com respostas HTTP SIMULADAS.
 *
 * NENHUM destes testes toca RPC externo: o `fetchar` e um simulador, e e por
 * isso que da para provar 429 com HTML, 503 e timeout — coisas que nao se
 * provocam de proposito num no publico.
 *
 * O DEFEITO QUE ELES GUARDAM esta medido em 2026-10-16: na observacao ao vivo,
 * 443 de 1.332 requisicoes voltaram HTTP 429, o transporte nao lia `r.status`,
 * e um lote recusado devolvia `dados: null` para todos os pedidos — que o
 * classificador publicava como "REVERSÃO OPACA". Falha de rede com cara de
 * falha de contrato, em 4.516 cotacoes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
    montarTransporteRpc, desfechoDoStatus, esperaDoRetryAfter, cotarAfetadas,
    type Fetchador,
} from './cacarArbitragem';
import { candidatasMistas } from './rotasMistas';
import { SELETOR_PAGAMENTO_CURTO, SELETOR_LUCRO_INSUFICIENTE } from './cotarMista';

const RPC = 'https://exemplo.invalido/rpc';
/** Uma resposta HTTP simulada. */
const resposta = (
    status: number, corpo: string, cabecalhos: Record<string, string> = {},
): { status: number; text: () => Promise<string>; headers: { get: (n: string) => string | null } } => ({
    status,
    text: async () => corpo,
    headers: { get: (n: string) => cabecalhos[n.toLowerCase()] ?? null },
});

/** O simulador: uma resposta (ou erro) por chamada, na ordem. */
const simulador = (
    respostas: Array<ReturnType<typeof resposta> | Error>,
): { fetchar: Fetchador; chamadas: () => number; corpos: () => string[] } => {
    let i = 0;
    const corpos: string[] = [];
    const fetchar = (async (_url: string, init: unknown) => {
        corpos.push(String((init as { body?: string }).body ?? ''));
        const r = respostas[Math.min(i, respostas.length - 1)]!;
        i += 1;
        if (r instanceof Error) throw r;
        return r;
    }) as unknown as Fetchador;
    return { fetchar, chamadas: () => i, corpos: () => corpos };
};

const semEspera = async (): Promise<void> => {};
const montar = (
    respostas: Array<ReturnType<typeof resposta> | Error>,
    over: Partial<Parameters<typeof montarTransporteRpc>[0]> = {},
) => {
    const s = simulador(respostas);
    const t = montarTransporteRpc({
        rpc: RPC, fetchar: s.fetchar, esperar: semEspera, timeoutMs: 0, ...over,
    });
    return { ...t, ...s };
};

const UM_PEDIDO = [{ metodo: 'eth_call', params: [{ to: '0x1' }] }];
const corpoRpc = (id: number, campo: 'result' | 'error', valor: unknown): string => JSON.stringify(
    [{ jsonrpc: '2.0', id, [campo]: valor }],
);

// --- OS STATUS, classificados ---------------------------------------------

test('o status diz se o nó EXECUTOU: 200 é corpo, 429 é saturação, 5xx é provedor', () => {
    assert.equal(desfechoDoStatus(200), 'corpo');
    assert.equal(desfechoDoStatus(429), 'saturado');
    for (const s of [500, 502, 503, 504, 599]) assert.equal(desfechoDoStatus(s), 'provedor');
    for (const s of [400, 401, 403, 404, 418]) assert.equal(desfechoDoStatus(s), 'outro',
        `HTTP ${s} não pode virar corpo econômico: o nó não executou a chamada`);
});

test('`Retry-After` legível é respeitado; torto NÃO vira espera inventada', () => {
    assert.equal(esperaDoRetryAfter('2'), 2000);
    assert.equal(esperaDoRetryAfter('0'), 0);
    assert.equal(esperaDoRetryAfter('999999'), 10_000, 'o teto impede espera indefinida');
    for (const lixo of [null, '', 'logo', '-3', 'NaN', 'Tue, 16 Oct 2026 12:00:00 GMT']) {
        assert.equal(esperaDoRetryAfter(lixo), null, `${String(lixo)} virou espera`);
    }
});

// --- 429 NUNCA E REVERSAO -------------------------------------------------

test('429 com corpo JSON vira FALHA DE TRANSPORTE, nunca reversão', async () => {
    const t = montar([resposta(429, JSON.stringify({ error: { code: -32005, message: 'limit' } }))]);
    const [r] = await t.chamarEmLote(UM_PEDIDO);
    assert.ok(r!.falhaDeTransporte !== undefined, 'sem o terceiro estado, isto seria lido como '
        + 'reversão de contrato — foi exatamente o defeito medido');
    assert.match(r!.falhaDeTransporte!, /HTTP 429/);
    assert.equal(r!.dados, null);
    assert.equal(r!.ok, false);
    const c = t.contabilidade();
    assert.equal(c.http429, 3, 'as três tentativas contam como 429');
    assert.equal(c.revertesComDados, 0, 'nenhum revert pode ser contado aqui');
    assert.equal(c.errosJsonRpc, 0, 'o corpo de um 429 não é erro JSON-RPC: não foi executado');
    assert.equal(c.desistencias, 1);
});

test('429 com HTML não vira reversão nem explode o laço', async () => {
    const t = montar([resposta(429, '<html><body>429 Too Many Requests</body></html>')]);
    const [r] = await t.chamarEmLote(UM_PEDIDO);
    assert.ok(r!.falhaDeTransporte !== undefined);
    assert.equal(t.contabilidade().corpoNaoJson, 0,
        'o corpo nem é lido quando o status já diz que não executou');
});

test('503 e timeout são falha de transporte, com tentativas LIMITADAS', async () => {
    const t503 = montar([resposta(503, 'service unavailable')], { tentativas: 2 });
    const [a] = await t503.chamarEmLote(UM_PEDIDO);
    assert.match(a!.falhaDeTransporte!, /HTTP 503/);
    assert.equal(t503.chamadas(), 2, 'duas tentativas, e PARA: retry sem limite seria pior que '
        + 'a falha');
    assert.equal(t503.contabilidade().http5xx, 2);

    const tTimeout = montar([new Error('AbortError: timeout')], { tentativas: 2 });
    const [b] = await tTimeout.chamarEmLote(UM_PEDIDO);
    assert.match(b!.falhaDeTransporte!, /falha de rede ou timeout/);
    assert.equal(tTimeout.contabilidade().falhasDeRede, 2);
});

test('HTTP 200 com JSON inválido é transporte, não cotação', async () => {
    const t = montar([resposta(200, 'isto não é json {{{')]);
    const [r] = await t.chamarEmLote(UM_PEDIDO);
    assert.ok(r!.falhaDeTransporte !== undefined);
    assert.match(r!.falhaDeTransporte!, /não é JSON/);
    assert.equal(t.contabilidade().corpoNaoJson, 1);
    assert.equal(t.contabilidade().http200, 1, 'o status foi 200 e isso fica registrado como 200');
});

test('corpo JSON que não é array de lote NÃO vira N reversões', async () => {
    const t = montar([resposta(200, JSON.stringify({ error: { message: 'nope' } }))]);
    const rs = await t.chamarEmLote([...UM_PEDIDO, ...UM_PEDIDO, ...UM_PEDIDO]);
    assert.equal(rs.length, 3, 'uma resposta por pedido, sempre');
    for (const r of rs) {
        assert.ok(r.falhaDeTransporte !== undefined,
            'um lote torto marcava TODOS como reversão: 1 falha publicada como 3 opacas');
    }
    assert.equal(t.contabilidade().jsonrpcMalformado, 1);
});

// --- LOTE PARCIAL E IDS FORA DE ORDEM -------------------------------------

test('lote PARCIAL: o id que não voltou é transporte, e os que voltaram seguem legíveis', async () => {
    const dados = SELETOR_PAGAMENTO_CURTO + '1'.padStart(64, '0') + '2'.padStart(64, '0');
    const t = montar([resposta(200, JSON.stringify([
        { jsonrpc: '2.0', id: 1, error: { message: 'execution reverted', data: dados } },
        // o id 2 simplesmente não voltou
        { jsonrpc: '2.0', id: 3, result: '0x01' },
    ]))]);
    const rs = await t.chamarEmLote([...UM_PEDIDO, ...UM_PEDIDO, ...UM_PEDIDO]);
    assert.equal(rs.length, 3);
    assert.equal(rs[0]!.dados, dados, 'a reversão com dados sobrevive ao lote parcial');
    assert.equal(rs[0]!.falhaDeTransporte, undefined);
    assert.ok(rs[1]!.falhaDeTransporte !== undefined, 'id sem resposta é ausência de medição');
    assert.match(rs[1]!.falhaDeTransporte!, /não respondeu este id/);
    assert.equal(rs[2]!.ok, true);
    const c = t.contabilidade();
    assert.equal(c.semResposta, 1);
    assert.equal(c.revertesComDados, 1);
});

test('IDS FORA DE ORDEM casam pelo id, não pela posição', async () => {
    const d1 = SELETOR_LUCRO_INSUFICIENTE + '0'.repeat(63) + '5' + '0'.repeat(64);
    const d2 = SELETOR_PAGAMENTO_CURTO + '0'.repeat(63) + '7' + '0'.repeat(63) + '9';
    const t = montar([resposta(200, JSON.stringify([
        { jsonrpc: '2.0', id: 2, error: { message: 'reverted', data: d2 } },
        { jsonrpc: '2.0', id: 1, error: { message: 'reverted', data: d1 } },
    ]))]);
    const rs = await t.chamarEmLote([...UM_PEDIDO, ...UM_PEDIDO]);
    assert.equal(rs[0]!.dados, d1, 'ler por posição desalinharia TODAS as cotações do lote');
    assert.equal(rs[1]!.dados, d2);
});

test('o teto de lote PARTE a requisição e devolve uma resposta por pedido', async () => {
    const t = montar([resposta(200, JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x01' }]))],
        { loteMaximo: 1 });
    const rs = await t.chamarEmLote([...UM_PEDIDO, ...UM_PEDIDO, ...UM_PEDIDO]);
    assert.equal(rs.length, 3);
    assert.equal(t.chamadas(), 3, 'três pedidos com teto 1 são três requisições');
    assert.equal(t.contabilidade().maiorLote, 1);
});

test('o teto de REQUISIÇÕES recusa em vez de seguir gastando', async () => {
    const t = montar([resposta(200, JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x01' }]))],
        { tetoDeRequisicoes: 2, tentativas: 1 });
    await t.chamarEmLote(UM_PEDIDO);
    await t.chamarEmLote(UM_PEDIDO);
    const [r] = await t.chamarEmLote(UM_PEDIDO);
    assert.ok(r!.falhaDeTransporte !== undefined);
    assert.match(r!.falhaDeTransporte!, /teto de 2 requisição/);
    assert.equal(t.contabilidade().recusadasPeloTeto, 1);
    assert.equal(t.chamadas(), 2, 'a terceira nem foi à rede');
});

// --- A REVERSAO EVM DE VERDADE CONTINUA LEGIVEL ---------------------------

test('reversão EVM com seletor VÁLIDO continua legível — e com o decodificador antigo', async () => {
    const dados = SELETOR_LUCRO_INSUFICIENTE
        + (500n).toString(16).padStart(64, '0')
        + (1000n).toString(16).padStart(64, '0');
    const t = montar([resposta(200, corpoRpc(1, 'error', { message: 'execution reverted', data: dados }))]);
    const [r] = await t.chamarEmLote(UM_PEDIDO);
    assert.equal(r!.falhaDeTransporte, undefined,
        'a nova classificação não pode engolir reversão de verdade');
    assert.equal(r!.ok, false);
    assert.equal(r!.dados, dados);
    const { lerRespostaDaCotacao } = await import('./cotarMista');
    const lido = lerRespostaDaCotacao(r!.dados);
    assert.ok(lido !== null, 'o decodificador validado tem de continuar lendo o número');
    assert.equal(lido.sobra, 500n);
    assert.equal(lido.desfecho, 'fechou');
});

test('reversão EVM genuinamente OPACA fica opaca: o nó executou e não houve seletor', async () => {
    const t = montar([resposta(200, corpoRpc(1, 'error', { message: 'execution reverted', data: '0xdeadbeef' }))]);
    const [r] = await t.chamarEmLote(UM_PEDIDO);
    assert.equal(r!.falhaDeTransporte, undefined,
        'sem falha de transporte: esta é a única classe que pode ser chamada de opaca');
    assert.equal(r!.dados, '0xdeadbeef');
    // E o erro SEM dados também é execução: revert sem motivo legível.
    const t2 = montar([resposta(200, corpoRpc(1, 'error', { message: 'execution reverted' }))]);
    const [r2] = await t2.chamarEmLote(UM_PEDIDO);
    assert.equal(r2!.falhaDeTransporte, undefined);
    assert.equal(r2!.dados, null);
    assert.equal(t2.contabilidade().errosJsonRpc, 1);
});

// --- O CLASSIFICADOR ECONOMICO, DE PONTA A PONTA -------------------------

const bancada = async (respostas: Array<ReturnType<typeof resposta> | Error>) => {
    const WETH = '0x4200000000000000000000000000000000000006';
    const TOK = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';
    const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rotas = candidatasMistas([
        { endereco: A, token0: WETH, token1: TOK, venue: 'v3', taxa: 500 },
        { endereco: B, token0: WETH, token1: TOK, venue: 'v3', taxa: 3000 },
    ], WETH).slice(0, 1);
    const LIQ = 10n ** 22n;
    const estado = {
        sqrtPorPoolV3: new Map([[A, 2n ** 96n], [B, 2n ** 96n]]),
        liquidezDoV3: new Map([[A, 1n], [B, 1n]]),
        token0PorPool: new Map<string, string>([[A, WETH], [B, WETH]]),
        reservasAerodrome: new Map(),
        saldoDaBaseNoV3: new Map([[A, LIQ], [B, LIQ]]),
        bloco: 1,
    };
    const t = montar(respostas);
    // O oráculo de L1 responde pelo transporte simulado também; `chamar` lança
    // em falha, e `cotarAfetadas` trata isso como custo desconhecido.
    const sinais = await cotarAfetadas(
        t.chamarEmLote, (async () => { throw new Error('sem L1 nesta bancada'); }) as never,
        rotas, estado as never, 'latest', 1, Date.now(), 1_000_000n, `0x${'60'.repeat(60)}`,
    );
    return { sinais, conta: t.contabilidade() };
};

test('HTTP 429 NUNCA é publicado como reversão opaca pelo classificador', async () => {
    const { sinais } = await bancada([resposta(429, '{"error":{"message":"limit"}}')]);
    const sn = sinais[0]!;
    assert.match(sn.motivo, /NÃO COTADO POR INFRAESTRUTURA/,
        `a saturação do nó tem de aparecer como infraestrutura; saiu: ${sn.motivo.slice(0, 140)}`);
    assert.doesNotMatch(sn.motivo, /REVERSÃO OPACA/,
        'era este o defeito: 443 recusas HTTP publicadas como 4.516 reversões de contrato');
    assert.doesNotMatch(sn.motivo, /SEM SPREAD/,
        'falha de rede não pode virar falta de spread');
    assert.equal(sn.lucroBrutoEstimado, null, 'sem medição não há bruto');
    assert.equal(sn.lucroLiquidoEstimado, null);
});

test('reversão de verdade continua virando sinal com NÚMERO, depois do conserto', async () => {
    const dados = SELETOR_PAGAMENTO_CURTO
        + (900n).toString(16).padStart(64, '0')
        + (1000n).toString(16).padStart(64, '0');
    const { sinais } = await bancada([
        resposta(200, JSON.stringify([{ jsonrpc: '2.0', id: 1, error: { data: dados } }])),
    ]);
    const sn = sinais[0]!;
    assert.equal(sn.lucroBrutoEstimado, -100n, 'a cotação legível não pode desaparecer');
    assert.match(sn.motivo, /NÃO FECHOU/);
    assert.doesNotMatch(sn.motivo, /INFRAESTRUTURA/);
});

test('reversão opaca de verdade continua OPACA, e não vira infraestrutura', async () => {
    const { sinais } = await bancada([
        resposta(200, JSON.stringify([{ jsonrpc: '2.0', id: 1, error: { data: '0xdeadbeef' } }])),
    ]);
    const sn = sinais[0]!;
    assert.match(sn.motivo, /REVERSÃO OPACA/,
        'o nó executou e não houve seletor: esta classe tem de sobreviver ao conserto');
    assert.doesNotMatch(sn.motivo, /INFRAESTRUTURA/);
});

test('o transporte do caçador NÃO pode voltar a ignorar o status — lido no código', () => {
    // Teste de CÓDIGO: o defeito era ESTRUTURAL (um `fetch` sem olhar
    // `r.status`), e nenhum teste de valor pega o retorno de uma função que
    // nem existe mais. É a mesma razão do teste que lê os gravadores do cache.
    const fonte = fs.readFileSync(path.join(__dirname, 'cacarArbitragem.ts'), 'utf8');
    const principal = fonte.slice(fonte.indexOf('async function principal'));
    assert.match(principal, /montarTransporteRpc\(\{/,
        'o laço tem de usar a fábrica, senão volta a existir um transporte sem status');
    assert.ok(!/const j = await r\.json\(\)/.test(principal),
        'ler `r.json()` sem olhar `r.status` foi o defeito medido em 2026-10-16');
    assert.match(fonte, /falhaDeTransporte/, 'o terceiro estado tem de existir no tipo');
});
