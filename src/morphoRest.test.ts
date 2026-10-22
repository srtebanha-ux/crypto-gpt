/**
 * O CONTRATO REST, e a correcao do HTTP 200 que produziu zero mercados.
 *
 * EVIDENCIA, do Railway em `598df41`: a API respondeu **HTTP 200**, uma
 * requisicao foi contabilizada, e a descoberta publicou **zero mercados
 * enumerados** com a memoria registrando SEM SUCESSO.
 *
 * A dona do bot aponta o contrato documentado do `GET /v1/blue/markets`:
 * envelope `data`, paginacao por `cursor`, campos `market_id`, `lltv_wad`,
 * `oracle_address`, `irm_address`, `loan_token`, `collateral_token` — enquanto
 * o parser exigia `id`/`uniqueKey` e `lltv`, que sao os nomes do GraphQL.
 *
 * **O QUE EU NAO PUDE CONFERIR, declarado:** `api.morpho.org` e
 * `docs.morpho.org` respondem `403 CONNECT` neste sandbox. Os nomes REST abaixo
 * entram por CITACAO dela, e nao da minha memoria — nome de campo escrito de
 * cabeca e o defeito do `0x80d1e0f4…` que a REGRA 0 registra, em outra forma.
 *
 * E e por isso que o teste que mais importa aqui nao e nenhum dos que afirmam
 * nomes: e `HTTP 200 com formato DESCONHECIDO vira ERRO DE SCHEMA`. Esse e
 * verdadeiro independentemente de eu ter acertado os nomes, e e ele que faz o
 * proximo log do Railway dizer a verdade se eu errei.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
    lerPaginaDeMercados, lerUmMercado, lerLltv, lerCursor, lerChain, soDaBase,
    soOsQuePagam, enumerarMercados, comoLerADescoberta, porQueNaoDecodificou,
    CHAIN_ID_DA_BASE,
} from './morphoApi';
import { comoLerODesfecho } from './canais';

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ORACLE = '0x1111111111111111111111111111111111111111';
const IRM = '0x2222222222222222222222222222222222222222';

/** Um item no contrato REST citado: snake_case, `market_id`, `lltv_wad`. */
const itemRest = (n: number, lltvWad = '625000000000000000', chain = CHAIN_ID_DA_BASE) => ({
    market_id: H(n),
    chain_id: chain,
    loan_token: USDC,
    collateral_token: WETH,
    oracle_address: ORACLE,
    irm_address: IRM,
    lltv_wad: lltvWad,
});

/** O envelope REST: `data` com a lista, e `next_cursor` opaco. */
const corpoRest = (itens: unknown[], cursor: string | null = null) => JSON.stringify({
    data: itens,
    ...(cursor === null ? {} : { next_cursor: cursor }),
});

test('HTTP 200 com `data` preenchido e campos snake_case DECODIFICA', () => {
    // O caso que o parser antigo recusava item por item, e que produzia o zero.
    const p = lerPaginaDeMercados(JSON.parse(corpoRest([itemRest(1), itemRest(2)])));
    assert.equal(p.elementos, 2);
    assert.equal(p.itens.length, 2, 'o contrato REST não decodificou');
    assert.equal(p.erroDeSchema, null);
    assert.equal(p.itens[0]!.id, H(1));
    assert.equal(p.itens[0]!.loanToken.toLowerCase(), USDC);
    assert.equal(p.itens[0]!.collateralToken.toLowerCase(), WETH);
    assert.equal(p.itens[0]!.oracle.toLowerCase(), ORACLE);
    assert.equal(p.itens[0]!.irm.toLowerCase(), IRM);
    assert.ok(p.itens[0]!.lltv.equals(new Decimal('0.625')));
    assert.equal(p.itens[0]!.chainId, CHAIN_ID_DA_BASE);
    // E NUNCA sai confirmado por vir da API: só a corrente confirma.
    assert.equal(p.itens[0]!.confirmadoNaCorrente, false);
});

test('o formato GraphQL CONTINUA decodificando: aceitar mais nomes não quebra', () => {
    const p = lerPaginaDeMercados({
        items: [{
            uniqueKey: H(9), loanAsset: { address: USDC }, collateralAsset: { address: WETH },
            oracle: { address: ORACLE }, irm: IRM, lltv: '770000000000000000',
        }],
    });
    assert.equal(p.itens.length, 1);
    assert.ok(p.itens[0]!.lltv.equals(new Decimal('0.77')));
});

test('HTTP 200 com formato DESCONHECIDO vira ERRO DE SCHEMA, nunca zero mercados', () => {
    // O TESTE QUE DECIDE, e ele é verdadeiro mesmo que eu tenha errado os nomes
    // REST: um 200 que não decodifica não pode produzir a mesma linha que "não
    // há mercados". As duas pedem consertos opostos — parser contra estratégia.
    const p = lerPaginaDeMercados({ resultado: { mercados_aqui: [{ foo: 1 }] } });
    assert.equal(p.itens.length, 0);
    assert.notEqual(p.erroDeSchema, null, 'formato desconhecido saiu como lista vazia');
    assert.match(p.erroDeSchema!, /NENHUMA lista de mercados/);
    // A frase NOMEIA as chaves que chegaram: é isso que torna o zero acionável
    // sem eu adivinhar o contrato.
    assert.match(p.erroDeSchema!, /Chaves do objeto: \[resultado\]/);
    assert.match(p.erroDeSchema!, /NÃO é "a Base não tem mercados"/);
});

test('elementos que vieram e NÃO decodificaram nomeiam os campos que faltaram', () => {
    // O caso provável do log de 2026-10-14: a lista veio e cada item foi
    // recusado por nome de campo.
    const p = lerPaginaDeMercados({
        data: [{ market_id: H(3), loan_token: USDC, collateral_token: WETH }],
    });
    assert.equal(p.elementos, 1, 'o elemento recebido não foi contado');
    assert.equal(p.itens.length, 0);
    assert.notEqual(p.erroDeSchema, null);
    assert.match(p.erroDeSchema!, /1 elemento\(s\) em "data" e NENHUM decodificou/);
    // Os campos que faltaram, por NOME.
    assert.match(p.erroDeSchema!, /oracle_address/);
    assert.match(p.erroDeSchema!, /irm_address/);
    assert.match(p.erroDeSchema!, /lltv/);
    // E as chaves que o item TEM, para a próxima volta não depender de palpite.
    assert.match(p.erroDeSchema!, /market_id/);
    // NENHUM VALOR no diagnóstico: ela pediu que o log não publique dados
    // sensíveis. Só nomes de chave e contagens.
    assert.ok(!p.erroDeSchema!.includes(USDC), 'o diagnóstico publicou um valor');
    assert.ok(!p.erroDeSchema!.includes(H(3)), 'o diagnóstico publicou um id');
});

test('HTTP 200 com `data: []` é API VAZIA — e só depois do formato reconhecido', () => {
    const p = lerPaginaDeMercados(JSON.parse(corpoRest([])));
    assert.equal(p.elementos, 0);
    assert.equal(p.itens.length, 0);
    assert.equal(p.erroDeSchema, null, 'lista vazia no formato certo não é erro de schema');
});

test('HTTP 200 SEM `data` não é lista vazia: é erro de schema', () => {
    for (const corpo of [{}, { ok: true }, { data: 'texto' }, { data: 42 }]) {
        const p = lerPaginaDeMercados(corpo);
        assert.notEqual(p.erroDeSchema, null, `${JSON.stringify(corpo)} passou como vazio`);
        assert.equal(p.itens.length, 0);
    }
    // E `data` como OBJETO com a lista dentro é reconhecido, não erro.
    const dentro = lerPaginaDeMercados({ data: { markets: [itemRest(4)] } });
    assert.equal(dentro.itens.length, 1);
    assert.equal(dentro.erroDeSchema, null);
});

test('a paginação usa o CURSOR opaco, não offset', async () => {
    const urls: string[] = [];
    const r = await enumerarMercados(async (url) => {
        urls.push(url);
        const n = urls.length;
        return {
            status: 200,
            text: async () => (n === 1
                ? corpoRest([itemRest(1)], 'opaco-AAA')
                : corpoRest([itemRest(2)], null)),
        };
    }, { dormir: async () => {} });

    assert.equal(r.mercados.length, 2);
    assert.equal(r.completa, true);
    assert.equal(r.paginouPorCursor, true);
    // A PRIMEIRA sem cursor, a SEGUNDA com o cursor que a API devolveu.
    assert.ok(!urls[0]!.includes('cursor='), 'a primeira página mandou cursor que não existia');
    assert.ok(urls[1]!.includes('cursor=opaco-AAA'), 'a segunda página não usou o cursor');
    // E `offset` NÃO entra: ela corrigiu isso, não faz parte do contrato.
    for (const u of urls) assert.ok(!u.includes('offset='), `offset na URL: ${u}`);
    // O chain_id vai na URL em toda página.
    for (const u of urls) assert.ok(u.includes(`chain_id=${CHAIN_ID_DA_BASE}`));
});

test('CURSOR REPETIDO encerra declarando, e não vira laço', async () => {
    let pedidas = 0;
    const r = await enumerarMercados(async () => {
        pedidas += 1;
        // Sempre o MESMO cursor, com itens novos: sem detecção isso gira para
        // sempre pagando requisição.
        return { status: 200, text: async () => corpoRest([itemRest(pedidas)], 'sempre-o-mesmo') };
    }, { dormir: async () => {} });

    assert.ok(pedidas <= 3, `pediu ${pedidas} vezes com cursor repetido`);
    assert.equal(r.completa, false, 'cursor repetido não é cobertura completa');
    assert.match(r.falha ?? '', /repetiu o cursor/);
});

test('sem cursor a paginação ENCERRA: não se inventa a página seguinte', async () => {
    let pedidas = 0;
    const r = await enumerarMercados(async () => {
        pedidas += 1;
        return { status: 200, text: async () => corpoRest([itemRest(pedidas)], null) };
    }, { dormir: async () => {} });
    assert.equal(pedidas, 1);
    assert.equal(r.completa, true);
    assert.equal(r.paginouPorCursor, false);
});

test('LLTV em WAD e em fração dão o mesmo número, e torto dá null', () => {
    // *"Confirme a interpretação de `lltv_wad` em escala 10^18"* e *"Não
    // descarte mercados por erro de conversão numérica."*
    assert.ok(lerLltv('625000000000000000')!.equals(new Decimal('0.625')));
    assert.ok(lerLltv('770000000000000000')!.equals(new Decimal('0.77')));
    assert.ok(lerLltv('945000000000000000')!.equals(new Decimal('0.945')));
    assert.ok(lerLltv(625000000000000000n)!.equals(new Decimal('0.625')));
    assert.ok(lerLltv('0.625')!.equals(new Decimal('0.625')));
    // Nem fração nem WAD: `null`, nunca um palpite.
    for (const v of [0, -1, '', 'abc', null, undefined, {}, '1', '2.5', 1e30]) {
        assert.equal(lerLltv(v), null, `${JSON.stringify(v)} virou LLTV`);
    }
    // E o teto do protocolo: 100% em WAD não é LLTV válido.
    assert.equal(lerLltv('1000000000000000000'), null);
});

test('o filtro de LLTV ≤ 77% seleciona a faixa que paga, e nada além', () => {
    const p = lerPaginaDeMercados(JSON.parse(corpoRest([
        itemRest(1, '625000000000000000'),   // 62,5% — paga 12,68%
        itemRest(2, '770000000000000000'),   // 77%   — paga 7,41%, no limite
        itemRest(3, '860000000000000000'),   // 86%   — fora
        itemRest(4, '945000000000000000'),   // 94,5% — fora
    ])));
    assert.equal(p.itens.length, 4, 'a decodificação perdeu mercado antes do filtro');
    const pagam = soOsQuePagam(p.itens);
    assert.equal(pagam.length, 2);
    for (const m of pagam) assert.ok(m.lltv.lessThanOrEqualTo(new Decimal('0.77')));
    // O LIMITE ENTRA: 77% exatamente é da faixa.
    assert.ok(pagam.some((m) => m.lltv.equals(new Decimal('0.77'))));
});

test('mercados de OUTRA chain são descartados, e desconhecido NÃO é', () => {
    // *"API retornando mercados de outras chains."* E o outro lado: `null` de
    // chain não vai para fora, senão uma resposta que não repete o campo em
    // cada item jogaria todos os mercados no lixo.
    const p = lerPaginaDeMercados(JSON.parse(corpoRest([
        itemRest(1, '625000000000000000', CHAIN_ID_DA_BASE),
        itemRest(2, '625000000000000000', 1),       // Ethereum
        itemRest(3, '625000000000000000', 42161),   // Arbitrum
    ])));
    const f = soDaBase(p.itens);
    assert.equal(f.daBase.length, 1);
    assert.equal(f.deOutraChain, 2);
    assert.equal(f.semChain, 0);

    // Sem `chain_id` no item: entra como candidato e é CONTADO como desconhecido.
    const semChain = lerPaginaDeMercados({
        data: [{ ...itemRest(5), chain_id: undefined }],
    });
    assert.equal(semChain.itens[0]!.chainId, null);
    const g = soDaBase(semChain.itens);
    assert.equal(g.daBase.length, 1, 'chain desconhecida foi descartada');
    assert.equal(g.semChain, 1);
});

test('lerChain aceita número, texto e objeto, e nunca inventa', () => {
    assert.equal(lerChain({ chain_id: 8453 }, {}), 8453);
    assert.equal(lerChain({ chainId: '8453' }, {}), 8453);
    assert.equal(lerChain({ chain: { id: 8453 } }, {}), 8453);
    assert.equal(lerChain({}, { chain_id: 8453 }), 8453);
    assert.equal(lerChain({}, {}), null);
    assert.equal(lerChain({ chain_id: 'base' }, {}), null);
    assert.equal(lerChain({ chain_id: 0 }, {}), null);
});

test('lerCursor acha o cursor nos lugares plausíveis e não inventa', () => {
    assert.equal(lerCursor({ next_cursor: 'A' }, null), 'A');
    assert.equal(lerCursor({ nextCursor: 'B' }, null), 'B');
    assert.equal(lerCursor({ cursor: 'C' }, null), 'C');
    assert.equal(lerCursor({ pagination: { next_cursor: 'D' } }, null), 'D');
    assert.equal(lerCursor({}, { next_cursor: 'E' }), 'E');
    assert.equal(lerCursor({}, null), null);
    // Cursor vazio não é cursor: pedir `cursor=` seria pedir a mesma página.
    assert.equal(lerCursor({ next_cursor: '   ' }, null), null);
    assert.equal(lerCursor({ next_cursor: 42 }, null), null);
});

test('um 200 que não decodifica NÃO é cobertura completa', async () => {
    const r = await enumerarMercados(
        async () => ({ status: 200, text: async () => JSON.stringify({ data: [{ foo: 1 }] }) }),
        { dormir: async () => {} },
    );
    assert.equal(r.mercados.length, 0);
    assert.equal(r.elementosRecebidos, 1, 'o elemento recebido não subiu para o resultado');
    assert.notEqual(r.erroDeSchema, null);
    assert.equal(
        r.completa, false,
        'erro de contrato saiu como paginação terminada — era o defeito de 598df41',
    );
});

test('o relatório separa RECEBIDOS de DECODIFICADOS e nomeia o contrato', () => {
    // Era isto que faltava no log: "zero mercados" sem dizer se a API mandou
    // algo. As oito contagens que ela pediu, distinguíveis.
    const f = comoLerADescoberta({
        devolvidos: 0, mercados: 0, quePagam: 0, confirmados: 0, devedores: 0, validados: 0,
        requisicoes: 1, completa: false, blocoIndexado: null, blocoAgora: null,
        falha: null, tentou: true, statusHttp: [200], desfecho: 'erroDeSchema',
        elementosRecebidos: 12, deOutraChain: 0, paginouPorCursor: true,
        erroDeSchema: 'HTTP 200 trouxe 12 elemento(s) em "data" e NENHUM decodificou',
        estadoDoRpc: 'livre — 0 chamada(s) nesta volta',
    });
    assert.match(f, /ERRO DE SCHEMA/);
    assert.match(f, /12 elemento\(s\) RECEBIDOS da API, 0 DECODIFICADOS/);
    assert.match(f, /ERRO DE CONTRATO:/);
    assert.match(f, /COBERTURA INDETERMINADA/);
    assert.match(f, /continua DESCONHECIDO/);
    assert.match(f, /paginado por CURSOR/);
    assert.match(f, /RPC: livre/);
    // E NÃO pode dizer "cobertura completa" nem "não há mercados".
    assert.ok(!/COBERTURA COMPLETA/.test(f));
});

test('os desfechos de 200 são TRÊS, e não se confundem', () => {
    const base = {
        mercados: 0, confirmados: 0, devedores: 0, validados: 0, requisicoes: 1,
        blocoIndexado: null, blocoAgora: null, falha: null, tentou: true, statusHttp: [200],
    };
    // 200 que não entendi.
    const schema = comoLerADescoberta({
        ...base, devolvidos: 0, quePagam: 0, completa: false, desfecho: 'erroDeSchema',
        elementosRecebidos: 5, erroDeSchema: 'não achei o array',
    });
    // 200, formato certo, lista vazia.
    const vazia = comoLerADescoberta({
        ...base, devolvidos: 0, quePagam: 0, completa: true, desfecho: 'apiVaziaDeVerdade',
        elementosRecebidos: 0, erroDeSchema: null,
    });
    // 200, mercados existem, nenhum na faixa.
    const faixa = comoLerADescoberta({
        ...base, devolvidos: 30, mercados: 30, quePagam: 0, completa: true,
        desfecho: 'foraDaFaixa', elementosRecebidos: 30, erroDeSchema: null,
    });
    assert.equal(new Set([schema, vazia, faixa]).size, 3);
    assert.match(schema, /contrato de dados/);
    assert.match(vazia, /é uma RESPOSTA, não uma falha/);
    assert.match(faixa, /o filtro é que não selecionou/);
    // A de FAIXA não pode insinuar ausência: os mercados estão lá.
    assert.match(faixa, /30 elemento\(s\) RECEBIDOS da API, 30 DECODIFICADOS/);
});

test('porQueNaoDecodificou não publica valores, só nomes de chave', () => {
    const d = porQueNaoDecodificou({
        market_id: H(7), loan_token: USDC, segredo: 'nao-pode-sair',
    });
    assert.ok(!d.includes('nao-pode-sair'), 'o diagnóstico publicou um valor');
    assert.ok(!d.includes(USDC));
    assert.ok(!d.includes(H(7)));
    assert.match(d, /segredo/, 'o NOME da chave tem de aparecer: é o diagnóstico');
    // Elemento que não é objeto também é diagnosticado, não ignorado.
    assert.match(porQueNaoDecodificou(42), /não é objeto: é number/);
    assert.match(porQueNaoDecodificou(null), /não é objeto/);
});

test('mercado NÃO CONFIRMADO nunca sai como confirmado da decodificação', () => {
    // *"Nunca permita que mercados não confirmados sejam enviados ao
    // executor."* A primeira trava é a decodificação: nada que venha da API
    // pode nascer confirmado, nem que o corpo traga um campo dizendo que é.
    const m = lerUmMercado({ ...itemRest(1), confirmadoNaCorrente: true, confirmed: true });
    assert.notEqual(m, null);
    assert.equal(m!.confirmadoNaCorrente, false, 'a API conseguiu se declarar confirmada');
});

test('falha de RPC DEPOIS de enumeração boa preserva os mercados como NÃO CONFIRMADOS', async () => {
    // *"Uma falha RPC não deve transformar mercados enumerados pela API em zero
    // mercados encontrados. Preserve mercados enumerados como NÃO CONFIRMADOS
    // até que a blockchain valide seus parâmetros."*
    const { descobrirMorphoPorApi } = await import('./mercadosDoMorpho');
    const { lerMemoria } = await import('./memoriaDaDescoberta');
    const { mkdtemp, readFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'morpho-rest-'));
    const memoria = join(dir, 'memoria.json');
    const cache = join(dir, 'mercados.json');

    // A API entrega 3 mercados na faixa. O RPC aponta para um host que não
    // existe, então o eth_getCode falha e NADA pode ser confirmado.
    //
    // A primeira versão deste teste não apontava o RPC para lugar nenhum e
    // acabou falando com o `mainnet.base.org` de verdade: os ids sintéticos não
    // existem na corrente, e o bloqueio saiu como divergência de campos. Era
    // defeito do MEU teste — e ele expôs um de verdade no bloqueio, que
    // colapsava "a corrente não devolveu parâmetros" com "os campos
    // divergiram". São causas opostas: RPC contra dado.
    const rpcAntes = process.env.CACA_RPC_URL;
    const rpcsAntes = process.env.CACA_RPC_URLS;
    process.env.CACA_RPC_URL = 'https://rpc-que-nao-existe.invalid';
    delete process.env.CACA_RPC_URLS;
    try {
    await descobrirMorphoPorApi({
        infra: { provedoresEsgotados: [], noFallback: false },
        buscar: async () => ({
            status: 200,
            text: async () => corpoRest([itemRest(1), itemRest(2), itemRest(3)]),
        }),
        caminhoDoCache: cache,
        caminhoDaMemoria: memoria,
        tetoDeValidacoes: 3,
        tetoDeMercadosComDevedores: 0,
    });
    } finally {
        if (rpcAntes === undefined) delete process.env.CACA_RPC_URL;
        else process.env.CACA_RPC_URL = rpcAntes;
        if (rpcsAntes !== undefined) process.env.CACA_RPC_URLS = rpcsAntes;
    }

    const m = lerMemoria(JSON.parse(await readFile(memoria, 'utf8')));
    const t = m.ultimaTentativa!;
    // A ENUMERAÇÃO NÃO SE PERDEU.
    assert.equal(t.mercadosEnumerados, 3, 'a falha de RPC zerou os mercados enumerados');
    assert.equal(t.mercadosRecebidos, 3);
    assert.equal(t.mercadosQuePagam, 3);
    // E NADA foi confirmado: a corrente não falou.
    assert.equal(t.mercadosConfirmados, 0);
    // O bloqueio nomeia o RPC, e NÃO o contrato de dados — que estava certo.
    assert.match(t.oQueBloqueia ?? '', /RPC|eth_getCode/);
    assert.ok(
        !/CONTRATO/.test(t.oQueBloqueia ?? ''),
        'culpou o parser por uma falha de RPC: mandaria consertar a coisa errada',
    );

    // E o CACHE guardou os três, todos como NÃO CONFIRMADOS.
    const guardado = JSON.parse(await readFile(cache, 'utf8')) as {
        mercados?: Array<{ confirmadoNaCorrente?: boolean }>;
    };
    assert.equal(guardado.mercados?.length, 3, 'o cache perdeu a enumeração');
    for (const g of guardado.mercados ?? []) {
        assert.notEqual(
            g.confirmadoNaCorrente, true,
            'um mercado foi gravado como CONFIRMADO sem a corrente ter validado',
        );
    }
});

test('mercados LLTV 94,5% e 96,5% entram na sondagem mas NAO sao validados so pela API', async () => {
    // Mercados 94,5/96,5% pagam incentivo positivo observado no censo real.
    // Eles entram na sondagem, mas sem a identidade confirmada na corrente
    // continuam FORA de qualquer decisao de envio.
    const { descobrirMorphoPorApi } = await import('./mercadosDoMorpho');
    const { lerMemoria } = await import('./memoriaDaDescoberta');
    const { mkdtemp, readFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'morpho-faixa-'));
    const memoria = join(dir, 'memoria.json');

    await descobrirMorphoPorApi({
        infra: { provedoresEsgotados: [], noFallback: false },
        buscar: async () => ({
            status: 200,
            // Ambos de LLTV > 77%: identificados mas nao confirmados por API.
            text: async () => corpoRest([
                itemRest(1, '945000000000000000'),
                itemRest(2, '965000000000000000'),
            ]),
        }),
        caminhoDoCache: join(dir, 'mercados.json'),
        caminhoDaMemoria: memoria,
        tetoDeValidacoes: 2, tetoDeMercadosComDevedores: 0,
    });

    const t = lerMemoria(JSON.parse(await readFile(memoria, 'utf8'))).ultimaTentativa!;
    assert.equal(t.mercadosEnumerados, 2, 'os mercados fora da faixa desapareceram da contagem');
    assert.equal(t.mercadosQuePagam, 0,'a faixa historica de bonus alto permanece separada');
    // A API de terceiro nao prova parametros: a tentativa deve reprovar
    // por RPC inacessivel ou porque eth_call nao confirmou a identidade.
    assert.ok(['validacaoRecusou','rpcIndisponivel'].includes(t.desfecho),
       'mercados que nao passaram na prova nao sao automaticamente elegiveis');
    assert.equal(t.mercadosConfirmados,0,'ranking e indice nao comprovam mercado');
});
