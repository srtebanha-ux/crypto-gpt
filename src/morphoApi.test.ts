import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
    enumerarMercados, enumerarDevedores, lerPaginaDeMercados, lerUmMercado, lerLltv,
    soOsQuePagam, lerIdToMarketParams, lerPosition, lerMarket, sharesParaAtivos,
    apiConfereComACorrente, codificarIdToMarketParams, codificarPosition, codificarMarket,
    consultaDeDevedores, lerDevedores, paraCache, doCache, idadeDoIndice, comoLerADescoberta,
    CHAIN_ID_DA_BASE, POR_PAGINA, TETO_DE_PAGINAS, type MercadoDaApi, type TransporteHttp,
} from './morphoApi';
import { OrcamentoHttp } from './canais';
import { lerMemoria } from './memoriaDaDescoberta';
import { SELETORES_DO_MORPHO } from './mercadosDoMorpho';

const semSono = async () => {};
/** Um transporte falso: devolve o que a lista manda, e CONTA as chamadas. */
function fingir(respostas: Array<{ status: number; corpo: string }>) {
    const urls: string[] = [];
    const corpos: string[] = [];
    let i = 0;
    const buscar: TransporteHttp = async (url, o) => {
        urls.push(url);
        if (o?.body !== undefined) corpos.push(o.body);
        const r = respostas[Math.min(i, respostas.length - 1)]!;
        i += 1;
        return { status: r.status, text: async () => r.corpo };
    };
    return { buscar, urls, corpos, chamadas: () => i };
}

/**
 * Uma pagina da API.
 *
 * `cursor` entra porque a paginacao passou a ser por CURSOR OPACO, e nao por
 * `offset` — a dona do bot corrigiu isto apontando o contrato documentado do
 * `GET /v1/blue/markets`. Sem cursor a paginacao ENCERRA, e e por isso que os
 * testes de varias paginas abaixo precisam dele.
 */
const pagina = (ids: number[], extra: Record<string, unknown> = {}, cursor?: string) => JSON.stringify({
    ...extra,
    ...(cursor === undefined ? {} : { next_cursor: cursor }),
    items: ids.map((n) => ({
        id: `0x${n.toString(16).padStart(64, '0')}`,
        loanAsset: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
        collateralAsset: { address: '0x4200000000000000000000000000000000000006' },
        oracle: { address: '0x1111111111111111111111111111111111111111' },
        irm: '0x2222222222222222222222222222222222222222',
        lltv: n % 2 === 0 ? '625000000000000000' : '945000000000000000',
    })),
});

test('enumera por CURSOR e encerra quando a API não oferece o próximo', async () => {
    // ERA POR `offset`, e ela corrigiu: o contrato REST documentado pagina por
    // cursor opaco. O teste mudou de forma porque a REGRA mudou — a antiga
    // afirmava `offset=0` e `offset=100` na URL, que agora seriam pedir o que o
    // serviço não oferece.
    const f = fingir([
        { status: 200, corpo: pagina([...Array(POR_PAGINA).keys()].map((n) => n + 1), {}, 'cur-1') },
        { status: 200, corpo: pagina([1000, 1001]) },
    ]);
    const r = await enumerarMercados(f.buscar, { dormir: semSono });
    assert.equal(r.completa, true);
    assert.equal(r.paginas, 2);
    assert.equal(r.requisicoes, 2);
    assert.equal(r.mercados.length, POR_PAGINA + 2);
    assert.equal(r.paginouPorCursor, true);
    // A rede vai em TODA página; o cursor só a partir da segunda.
    assert.match(f.urls[0]!, new RegExp(`chain_id=${CHAIN_ID_DA_BASE}`));
    assert.ok(!f.urls[0]!.includes('cursor='), 'mandou cursor que a API não tinha dado');
    assert.match(f.urls[1]!, /cursor=cur-1/);
    // E `offset` NÃO aparece: não faz parte do contrato.
    for (const u of f.urls) assert.ok(!u.includes('offset='), `offset na URL: ${u}`);
});

test('API que devolve SEMPRE a mesma página não vira laço infinito', async () => {
    // A mesma página cheia com o MESMO cursor. Com `offset` o laço vinha de a
    // API ignorar o parâmetro; com cursor ele vem de a API repetir o cursor — e
    // nos dois casos o custo é gastar o teto de requisições sobre dado
    // repetido. Os dois critérios ficam: cursor repetido E nada novo.
    const f = fingir([{
        status: 200,
        corpo: pagina([...Array(POR_PAGINA).keys()].map((n) => n + 1), {}, 'o-mesmo'),
    }]);
    const r = await enumerarMercados(f.buscar, { dormir: semSono });
    assert.equal(r.completa, false, 'girar sobre dado repetido não é cobertura completa');
    assert.ok(r.requisicoes <= 3, `pediu ${r.requisicoes} vezes`);
    assert.equal(r.mercados.length, POR_PAGINA, 'sem duplicados');
    assert.ok(r.requisicoes < TETO_DE_PAGINAS);
    assert.match(r.falha ?? '', /cursor|nenhum mercado novo/);
});

test('HTTP 429 não insiste, e a cobertura sai INCOMPLETA', async () => {
    const f = fingir([
        { status: 200, corpo: pagina([...Array(POR_PAGINA).keys()].map((n) => n + 1), {}, 'cur-1') },
        { status: 429, corpo: 'slow down' },
    ]);
    const r = await enumerarMercados(f.buscar, { dormir: semSono });
    assert.equal(r.completa, false);
    assert.match(r.falha!, /HTTP 429/);
    assert.match(r.falha!, /não insisto/);
    assert.equal(r.mercados.length, POR_PAGINA, 'o que veio antes é preservado');
    assert.equal(r.requisicoes, 2);
});

test('corpo HTML da API não vira lista vazia calada', async () => {
    const f = fingir([{ status: 200, corpo: '<!DOCTYPE html><html>erro</html>' }]);
    const r = await enumerarMercados(f.buscar, { dormir: semSono });
    assert.equal(r.completa, false);
    assert.match(r.falha!, /NÃO-JSON/);
    assert.match(r.falha!, /<!DOCTYPE html>/);
    assert.deepEqual(r.mercados, []);
});

test('transporte que estoura é falha declarada, não ausência de mercados', async () => {
    const buscar: TransporteHttp = async () => { throw new Error('getaddrinfo ENOTFOUND api.morpho.org'); };
    const r = await enumerarMercados(buscar, { dormir: semSono });
    assert.equal(r.completa, false);
    assert.match(r.falha!, /o transporte falhou/);
    assert.match(r.falha!, /ENOTFOUND/);
});

test('os três envelopes plausíveis são lidos, e o id inválido é descartado', () => {
    const item = JSON.parse(pagina([2])).items[0];
    for (const corpo of [{ items: [item] }, { data: [item] }, [item], { data: { markets: [item] } }]) {
        assert.equal(lerPaginaDeMercados(corpo).itens.length, 1, JSON.stringify(corpo).slice(0, 30));
    }
    assert.equal(lerUmMercado({ ...item, id: '0xabc' }), null, 'id curto não é id');
    assert.equal(lerUmMercado({ ...item, oracle: undefined }), null, 'sem oracle não há mercado');
    assert.equal(lerUmMercado({ ...item, lltv: undefined }), null, 'sem lltv não há incentivo');
});

test('LLTV em WAD e em fração dão o MESMO número; o resto é `null`', () => {
    assert.ok(lerLltv('625000000000000000')!.equals(new Decimal('0.625')));
    assert.ok(lerLltv(0.625)!.equals(new Decimal('0.625')));
    assert.ok(lerLltv('0.86')!.equals(new Decimal('0.86')));
    assert.ok(lerLltv(860000000000000000n)!.equals(new Decimal('0.86')));
    // Nem fração nem WAD: 1.000.000 não é nenhum dos dois.
    for (const ruim of ['0', '1', '1.5', '1000000', 'muito', null, undefined, {}, -1]) {
        assert.equal(lerLltv(ruim), null, String(ruim));
    }
});

test('o filtro econômico é LLTV ≤ 77%, e ele separa a metade que paga', () => {
    const ms = lerPaginaDeMercados(JSON.parse(pagina([1, 2, 3, 4]))).itens;
    assert.equal(ms.length, 4);
    const pagam = soOsQuePagam(ms);
    assert.equal(pagam.length, 2, 'os pares: LLTV 62,5%');
    for (const m of pagam) assert.ok(m.lltv.lessThanOrEqualTo(new Decimal('0.77')));
    // E o bônus vem da fórmula já verificada contra o censo, não de palpite.
    assert.ok(pagam[0]!.bonusPct!.greaterThan(10), 'LLTV 62,5% paga acima de 10%');
});

// --- A CORRENTE VALIDA, e é ela que autoriza ---

test('o calldata usa os seletores do contrato, não strings minhas', () => {
    const id = `0x${'ab'.repeat(32)}`;
    assert.ok(codificarIdToMarketParams(id).startsWith(SELETORES_DO_MORPHO['idToMarketParams(bytes32)']!));
    assert.equal(codificarIdToMarketParams(id).length, 10 + 64);
    const quem = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
    const cd = codificarPosition(id, quem);
    assert.ok(cd.startsWith(SELETORES_DO_MORPHO['position(bytes32,address)']!));
    assert.equal(cd.length, 10 + 128);
    assert.ok(cd.includes('3d310384d674532f5d41cf2d43b03001f3515ae8'), 'o endereço entra minúsculo');
    assert.ok(codificarMarket(id).startsWith(SELETORES_DO_MORPHO['market(bytes32)']!));
});

test('divergência entre API e corrente RECUSA o mercado inteiro', () => {
    const daApi = lerUmMercado(JSON.parse(pagina([2])).items[0])!;
    const igual = {
        loanToken: daApi.loanToken, collateralToken: daApi.collateralToken,
        oracle: daApi.oracle, irm: daApi.irm, lltv: daApi.lltv,
    };
    assert.equal(apiConfereComACorrente(daApi, igual).confere, true);
    for (const campo of ['loanToken', 'collateralToken', 'oracle', 'irm'] as const) {
        const torto = { ...igual, [campo]: '0x9999999999999999999999999999999999999999' };
        const r = apiConfereComACorrente(daApi, torto);
        assert.equal(r.confere, false, campo);
        assert.match(r.porque, new RegExp(campo));
    }
    const lltvTorto = { ...igual, lltv: new Decimal('0.86') };
    assert.match(apiConfereComACorrente(daApi, lltvTorto).porque, /lltv/);
    // Corrente que não responde NÃO confirma: ausência não é confirmação.
    assert.equal(apiConfereComACorrente(daApi, null).confere, false);
    assert.match(apiConfereComACorrente(daApi, null).porque, /não devolveu parâmetros/);
});

test('decodificadores: resposta torta devolve `null`, nunca zero', () => {
    assert.equal(lerIdToMarketParams('0x'), null);
    assert.equal(lerPosition('0x'), null);
    assert.equal(lerMarket('0x'), null);
    // LLTV fora de (0,1) na corrente também é `null`: seria escala errada.
    const zero = `0x${'0'.repeat(64 * 5)}`;
    assert.equal(lerIdToMarketParams(zero), null, 'lltv zero não é mercado');
});

test('shares→ativos arredonda PARA CIMA, e total zero é `null`', () => {
    // 1 share de 3, com 10 ativos: 3,33… -> 4. Para baixo diria 3 e a posição
    // pareceria mais saudável do que é.
    assert.equal(sharesParaAtivos(1n, 10n, 3n), 4n);
    assert.equal(sharesParaAtivos(3n, 10n, 3n), 10n);
    assert.equal(sharesParaAtivos(0n, 10n, 3n), 0n, 'zero shares é zero dívida, e isso é fato');
    assert.equal(sharesParaAtivos(5n, 10n, 0n), null, 'sem shares totais não há conversão');
});

// --- DEVEDORES por GraphQL ---

test('a consulta leva o id, o first e o skip', () => {
    const q = JSON.parse(consultaDeDevedores('0xabc', 50, 100));
    assert.match(q.query, /marketPositions/);
    assert.match(q.query, /borrowShares/);
    assert.deepEqual(q.variables, { id: '0xabc', first: 50, skip: 100 });
});

test('enumera devedores com paginação, sem duplicar', async () => {
    const corpo = (ends: string[]) => JSON.stringify({
        data: { marketPositions: { items: ends.map((a) => ({
            user: { address: a }, state: { borrowShares: '1000', collateral: '5' },
        })) } },
    });
    const a = '0x1111111111111111111111111111111111111111';
    const b = '0x2222222222222222222222222222222222222222';
    const f = fingir([{ status: 200, corpo: corpo([a, b]) }, { status: 200, corpo: corpo([b]) }]);
    const r = await enumerarDevedores(f.buscar, '0xabc', { porPagina: 2, dormir: semSono });
    assert.equal(r.completa, true);
    assert.deepEqual(r.devedores.map((d) => d.endereco), [a, b]);
    assert.equal(r.devedores[0]!.borrowSharesDaApi, 1000n);
    assert.match(f.corpos[0]!, /"skip":0/);
    assert.match(f.corpos[1]!, /"skip":2/);
});

test('GraphQL fora do ar é falha declarada; item sem endereço não vira devedor', async () => {
    const f = fingir([{ status: 503, corpo: 'upstream' }]);
    const r = await enumerarDevedores(f.buscar, '0xabc', { dormir: semSono });
    assert.equal(r.completa, false);
    assert.match(r.falha!, /HTTP 503/);
    assert.deepEqual(lerDevedores({ data: { marketPositions: { items: [{ state: {} }] } } }), []);
    assert.deepEqual(lerDevedores({ erro: 'x' }), []);
    // Shares ilegível fica `null`, não zero: zero diria "não deve nada".
    const semShares = lerDevedores({ data: { marketPositions: { items: [
        { user: { address: '0x1111111111111111111111111111111111111111' }, state: { borrowShares: 'x' } },
    ] } } });
    assert.equal(semShares[0]!.borrowSharesDaApi, null);
});

// --- CACHE: é ele que mantém o monitoramento quando a API cai ---

test('o cache atravessa o reinício, e o LLTV vai como TEXTO', () => {
    const ms = lerPaginaDeMercados(JSON.parse(pagina([2, 4]))).itens;
    ms[0]!.confirmadoNaCorrente = true;
    const c = paraCache(ms, 52_600_000, true, 1_000_000);
    // `JSON.stringify` de um Decimal grava os internos da biblioteca; este
    // projeto já perdeu o placar por isso.
    assert.equal(typeof c.mercados[0]!.lltv, 'string');
    const volta = doCache(JSON.parse(JSON.stringify(c)))!;
    assert.equal(volta.length, 2);
    assert.ok(volta[0]!.lltv.equals(ms[0]!.lltv));
    assert.equal(volta[0]!.confirmadoNaCorrente, true);
    assert.equal(volta[1]!.confirmadoNaCorrente, false, 'confirmação não contagia');
    assert.equal(volta[0]!.blocoIndexado, 52_600_000);
});

test('cache torto devolve `null`, nunca lista vazia com cara de cache', () => {
    assert.equal(doCache(null), null);
    assert.equal(doCache({ versao: 99, mercados: [] }), null);
    assert.equal(doCache({ versao: 1, mercados: [] }), null, 'vazio não é cache usável');
    assert.equal(doCache({ versao: 1, mercados: [{ id: 'torto' }] }), null);
});

// --- IDADE DO ÍNDICE: o que ela permite concluir ---

test('a idade do índice separa "orientar leitura" de "decidir tiro"', () => {
    assert.match(idadeDoIndice(null, 100), /DESCONHECIDA, e desconhecida não é zero/);
    assert.match(idadeDoIndice(100, null), /não sei o bloco de agora/);
    assert.match(idadeDoIndice(1000, 1010), /10 bloco\(s\) atrás/);
    assert.match(idadeDoIndice(1000, 1010), /quem decide é o eth_call/);
    assert.match(idadeDoIndice(1000, 2000), /ATRASADO para decidir/);
    // Índice à frente é contradição, e não se usa.
    assert.match(idadeDoIndice(2000, 1000), /À FRENTE do meu/);
});

test('a frase de evidência traz os números que ela pediu, e declara o que falta', () => {
    // A fixture diz: a API mandou 120 elementos, 118 decodificaram, e os 118
    // estao na lista de trabalho. `devolvidos` e o DECODIFICADO e `mercados` e a
    // lista — eu troquei os dois na primeira versao desta asserção, e o teste me
    // corrigiu rodando a função de verdade.
    const f = comoLerADescoberta({
        devolvidos: 118, mercados: 118, quePagam: 9, confirmados: 7,
        devedores: 340, validados: 12, requisicoes: 14,
        completa: false, blocoIndexado: 52_600_000, blocoAgora: 52_600_050, falha: 'HTTP 429',
        tentou: true, statusHttp: [200, 429], desfecho: 'apiFalhou',
        elementosRecebidos: 120,
    });
    // A FRASE MUDOU de propósito em 2026-10-14: era "120 mercado(s) a API
    // devolveu, 118 legíveis", e os dois números viviam no mesmo campo. Com o
    // HTTP 200 que produziu zero mercados, "recebidos" e "decodificados"
    // passaram a ser contagens SEPARADAS — é o que distingue erro de contrato
    // de lista vazia, e era a confusão delas que custou o diagnóstico.
    for (const p of ['120 elemento(s) RECEBIDOS da API, 118 DECODIFICADOS', '9 com LLTV ≤ 77%',
        '7 CONFIRMADOS na corrente', '340 devedor(es) apontado(s), 12 validado(s)',
        '14 requisição(ões)', 'COBERTURA PARCIAL', 'HTTP 429',
        '2 mercado(s) que pagam NÃO foram confirmados']) {
        assert.ok(f.includes(p), `falta "${p}"`);
    }
});

test('a cobertura tem TRÊS estados, e eles não se confundem', () => {
    // Ela pediu *"Cobertura completa, parcial ou indeterminada"* — e sao tres
    // coisas, nao duas. Este teste substituiu a asserção da frase
    // "COBERTURA INCOMPLETA", que colapsava parcial e indeterminada num rotulo
    // so: uma medicao com teto declarado nao e a mesma coisa que nao saber se
    // ha mais. O teste afirma a REGRA, para sobreviver a proxima remedicao.
    const base = {
        devolvidos: 0, mercados: 0, quePagam: 0, confirmados: 0, devedores: 0, validados: 0,
        requisicoes: 0, blocoIndexado: null, blocoAgora: null, falha: null,
    };
    const indeterminada = comoLerADescoberta({ ...base, completa: false, tentou: false, statusHttp: [] });
    const parcial = comoLerADescoberta({ ...base, completa: false, tentou: true, statusHttp: [429] });
    const completa = comoLerADescoberta({ ...base, completa: true, tentou: true, statusHttp: [200] });
    assert.match(indeterminada, /COBERTURA INDETERMINADA/);
    assert.match(parcial, /COBERTURA PARCIAL/);
    assert.match(completa, /COBERTURA COMPLETA/);
    assert.equal(new Set([indeterminada, parcial, completa]).size, 3);
    // O que NAO pode: "nenhuma requisição saiu" lido como zero mercados.
    assert.match(indeterminada, /isto NÃO é zero/);
});

test('cobertura completa não publica ressalva que não existe', () => {
    const f = comoLerADescoberta({
        devolvidos: 10, mercados: 10, quePagam: 3, confirmados: 3,
        devedores: 5, validados: 5, requisicoes: 2,
        completa: true, blocoIndexado: 100, blocoAgora: 110, falha: null,
        tentou: true, statusHttp: [200], desfecho: 'confirmou',
    });
    assert.ok(!/PARCIAL|INDETERMINADA/.test(f));
    assert.ok(!/NÃO foram confirmados/.test(f));
    assert.ok(!/falha/.test(f));
});

// ---------------------------------------------------------------------------
// O INCIDENTE DE 2026-10-14: a descoberta nao executou, e a causa era
// agendamento. O que segue trava os comportamentos que ela pediu por nome.
// ---------------------------------------------------------------------------

test('a API cair NÃO derruba o monitoramento: ela devolve falha declarada e segue', async () => {
    // Ela pediu: *"Inclua outro demonstrando que o monitoramento principal
    // continua funcionando se a API cair."* O que este modulo pode provar e a
    // metade dele: a enumeracao FALHA DECLARANDO em vez de lancar, porque uma
    // excecao que sobe mata o laco que a chamou.
    for (const queda of [
        async () => { throw new Error('getaddrinfo ENOTFOUND api.morpho.org'); },
        async () => ({ status: 403, text: async () => 'Forbidden' }),
        async () => ({ status: 500, text: async () => '<!DOCTYPE html><html>' }),
        async () => ({ status: 200, text: async () => '<!DOCTYPE html>' }),
    ]) {
        const r = await enumerarMercados(queda as never, { dormir: async () => {} });
        // NAO LANCOU: e isto que mantem o monitoramento de pe.
        assert.equal(r.mercados.length, 0);
        assert.notEqual(r.falha, null, 'a queda tem de virar falha DECLARADA');
        assert.equal(r.completa, false, 'queda não produz cobertura completa');
        // E a requisicao SAIU: e o que distingue "a API falhou" de "a tarefa
        // nao executou", que pedem consertos opostos.
        assert.equal(r.tentou, true);
    }
});

test('"a tarefa não executou" e "a API falhou" são DISTINGUÍVEIS pela evidência', async () => {
    // As duas produzem zero mercados. Se a frase fosse a mesma, o incidente de
    // 2026-10-14 seria invisivel outra vez — e foi exatamente por isso que ele
    // passou: lista vazia por agendamento lida como lista vazia por rede.
    const naoExecutou = comoLerADescoberta({
        devolvidos: 0, mercados: 0, quePagam: 0, confirmados: 0, devedores: 0, validados: 0,
        requisicoes: 0, completa: false, blocoIndexado: null, blocoAgora: null, falha: null,
        tentou: false, statusHttp: [], desfecho: 'naoExecutou',
    });
    const apiFalhou = comoLerADescoberta({
        devolvidos: 0, mercados: 0, quePagam: 0, confirmados: 0, devedores: 0, validados: 0,
        requisicoes: 1, completa: false, blocoIndexado: null, blocoAgora: null,
        falha: 'a API respondeu HTTP 429 na página 0', tentou: true, statusHttp: [429],
        desfecho: 'apiFalhou',
    });
    assert.notEqual(naoExecutou, apiFalhou);
    assert.match(naoExecutou, /NENHUMA requisição HTTP saiu/);
    assert.match(naoExecutou, /COBERTURA INDETERMINADA/);
    assert.match(apiFalhou, /requisição HTTP INICIADA, status 429/);
    assert.match(apiFalhou, /COBERTURA PARCIAL/);
    // E "vazia de verdade" e uma RESPOSTA, nao uma falha.
    const vazia = comoLerADescoberta({
        devolvidos: 12, mercados: 12, quePagam: 0, confirmados: 0, devedores: 0, validados: 0,
        requisicoes: 1, completa: true, blocoIndexado: null, blocoAgora: null, falha: null,
        tentou: true, statusHttp: [200], desfecho: 'apiVaziaDeVerdade',
    });
    assert.match(vazia, /é uma RESPOSTA, não uma falha/);
    assert.match(vazia, /COBERTURA COMPLETA/);
});

test('o orçamento CORTA a paginação e declara o corte, sem laço', async () => {
    let pedidas = 0;
    // A fixture usa o MESMO ajudante `pagina` dos testes acima. A primeira
    // versao deste teste inventou os nomes dos campos (`uniqueKey`,
    // `oracleAddress`) e os itens foram todos RECUSADOS pelo leitor: a
    // paginacao parou na primeira pagina por pagina "vazia", e eu quase li
    // isso como defeito do orcamento. Era defeito da MINHA fixture, e provar
    // com uma copia prova a copia.
    const orcamento = new OrcamentoHttp(3, 60_000);
    const r = await enumerarMercados(async () => {
        const n = pedidas;
        pedidas += 1;
        // Ids distintos por pagina, senao `novos === 0` encerra antes do teto.
        return {
            status: 200,
            // Ids distintos E cursor novo por pagina, senao a enumeracao
            // encerra antes de o orcamento ser o motivo — e o teste mediria
            // outra coisa.
            text: async () => pagina(
                [...Array(POR_PAGINA).keys()].map((i) => n * POR_PAGINA + i + 1),
                {}, `cur-${n}`,
            ),
        };
    }, { dormir: async () => {}, orcamento });
    assert.equal(pedidas, 3, 'o orçamento tem de cortar na terceira requisição');
    assert.equal(r.completa, false, 'corte por orçamento NÃO é cobertura completa');
    assert.match(r.falha ?? '', /orçamento encerrou/);
    assert.equal(r.statusHttp.length, 3, 'os status reais são registrados, um por requisição');
    assert.equal(orcamento.sinal.aborted, true, 'o corte CANCELA o que estiver em voo');
});

test('o sinal do orçamento CHEGA ao transporte', async () => {
    // Aceitar o sinal e nao passa-lo e a REGRA 3: a regra em dois lugares,
    // implementada em um. Este projeto ja pagou por isso em `cotacoesDaBinance`.
    let recebeu: AbortSignal | undefined;
    const orcamento = new OrcamentoHttp(1, 60_000);
    await enumerarMercados(async (_u, o) => {
        recebeu = o?.signal;
        return { status: 200, text: async () => JSON.stringify({ items: [] }) };
    }, { dormir: async () => {}, orcamento });
    assert.ok(recebeu !== undefined, 'o transporte não recebeu o sinal do orçamento');
    assert.equal(recebeu, orcamento.sinal, 'recebeu um sinal que não é o do orçamento');
});

test('RPC indisponível guarda os mercados como NÃO CONFIRMADOS, e diz isso', () => {
    // Ela mandou: *"Se a API responder e o RPC estiver indisponível, preserve
    // os mercados encontrados como NÃO CONFIRMADOS e processe as validações
    // posteriormente."* A primeira versao dava `return` e jogava a enumeracao
    // fora por um soluco de RPC.
    const f = comoLerADescoberta({
        devolvidos: 40, mercados: 40, quePagam: 9, confirmados: 0, devedores: 0, validados: 0,
        requisicoes: 1, completa: true, blocoIndexado: null, blocoAgora: null, falha: null,
        tentou: true, statusHttp: [200], desfecho: 'rpcIndisponivel',
        naoConfirmadosGuardados: 9,
        porqueNaoValidou: 'o eth_getCode não respondeu (RPC indisponível)',
    });
    assert.match(f, /NÃO CONFIRMADOS/);
    assert.match(f, /9 guardado\(s\) como NÃO CONFIRMADOS/);
    assert.match(f, /não se perde quando o RPC cai/);
    assert.match(f, /eth_getCode não respondeu/);
    // E nao se confunde com "a corrente recusou", que e DADO e nao falha.
    const recusou = comoLerADescoberta({
        devolvidos: 40, mercados: 40, quePagam: 9, confirmados: 0, devedores: 0, validados: 0,
        requisicoes: 1, completa: true, blocoIndexado: null, blocoAgora: null, falha: null,
        tentou: true, statusHttp: [200], desfecho: 'validacaoRecusou',
    });
    assert.notEqual(f, recusou);
    assert.match(recusou, /os campos divergiram/);
});

test('5. a API da Morpho funciona INDEPENDENTEMENTE do estado do RPC', async () => {
    // O incidente de 2026-10-14 por inteiro, contra a função de produção.
    // Alchemy esgotada, no fallback, eventos recusados — e a enumeração ocorre.
    const { descobrirMorphoPorApi } = await import('./mercadosDoMorpho');
    const { mkdtemp, readFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join: j } = await import('path');
    const dir = await mkdtemp(j(tmpdir(), 'morpho-'));

    let requisicoes = 0;
    const http: string[] = [];
    const rpc: string[] = [];
    await descobrirMorphoPorApi({
        infra: {
            provedoresEsgotados: ['base-mainnet.g.alchemy.com'],
            noFallback: true,
            eventosRecusados: true,
        },
        buscar: async () => {
            requisicoes += 1;
            return { status: 200, text: async () => pagina([1, 2, 3]) };
        },
        caminhoDoCache: j(dir, 'mercados.json'),
        caminhoDaMemoria: j(dir, 'memoria.json'),
        contarHttp: (h) => http.push(h),
        contarRpc: (m) => rpc.push(m),
        tetoDeValidacoes: 1,
        tetoDeMercadosComDevedores: 0,
    });

    assert.ok(requisicoes > 0, 'a API não foi chamada com o RPC esgotado: é o incidente');
    // A MEMÓRIA existe e responde, mesmo que o RPC não tenha confirmado nada.
    const m = lerMemoria(JSON.parse(await readFile(j(dir, 'memoria.json'), 'utf8')));
    assert.notEqual(m.ultimaTentativa, null);
    assert.equal(m.ultimaTentativa?.tentou, true);
    assert.deepEqual(m.ultimaTentativa?.statusHttp, [200]);
    assert.ok(m.ultimaTentativa!.mercadosEnumerados >= 1);
    // HTTP contado como HTTP, e as chamadas de RPC como RPC. Nunca misturadas.
    assert.ok(http.length > 0, 'a requisição HTTP não entrou no inventário');
    assert.ok(http.every((h) => !h.startsWith('eth_')), 'host HTTP virou método RPC');
    assert.ok(rpc.every((x) => x.startsWith('eth_')), 'método RPC não parece método RPC');
    // E cada requisição HTTP é contada UMA vez: a camada que conta é só uma.
    assert.equal(http.length, requisicoes, 'contagem dupla de HTTP entre camadas');
});

test('6. API fora do ar com cache anterior válido: segue com o cache e DIZ', async () => {
    const { descobrirMorphoPorApi } = await import('./mercadosDoMorpho');
    const { mkdtemp, writeFile, readFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join: j } = await import('path');
    const dir = await mkdtemp(j(tmpdir(), 'morpho-'));
    const cache = j(dir, 'mercados.json');
    const memoria = j(dir, 'memoria.json');

    // Primeiro: uma volta que DEU CERTO, para haver cache e memória.
    await descobrirMorphoPorApi({
        infra: { provedoresEsgotados: [], noFallback: false },
        buscar: async () => ({ status: 200, text: async () => pagina([1, 2, 3]) }),
        caminhoDoCache: cache, caminhoDaMemoria: memoria,
        tetoDeValidacoes: 1, tetoDeMercadosComDevedores: 0,
    });
    const bom = lerMemoria(JSON.parse(await readFile(memoria, 'utf8')));
    assert.notEqual(bom.ultimoSucesso, null, 'a primeira volta não registrou sucesso');
    const enumeradosAntes = bom.ultimoSucesso!.mercadosEnumerados;

    // Agora a API cai. O cache tem de sustentar, e o último sucesso sobreviver.
    await descobrirMorphoPorApi({
        infra: { provedoresEsgotados: [], noFallback: false },
        buscar: async () => { throw new Error('getaddrinfo ENOTFOUND api.morpho.org'); },
        caminhoDoCache: cache, caminhoDaMemoria: memoria,
        tetoDeValidacoes: 1, tetoDeMercadosComDevedores: 0,
    });
    const depois = lerMemoria(JSON.parse(await readFile(memoria, 'utf8')));
    assert.equal(
        depois.ultimoSucesso?.em, bom.ultimoSucesso?.em,
        'a queda da API apagou o último resultado válido',
    );
    assert.equal(depois.ultimoSucesso?.mercadosEnumerados, enumeradosAntes);
    assert.notEqual(depois.ultimaTentativa?.em, bom.ultimoSucesso?.em);
    assert.notEqual(depois.ultimaTentativa?.falha, null);

    // E o cache de mercados NÃO foi esvaziado pela queda.
    const guardado = JSON.parse(await readFile(cache, 'utf8')) as { mercados?: unknown[] };
    assert.ok((guardado.mercados ?? []).length > 0, 'a queda da API esvaziou o cache');
});

test('8. memória corrompida no disco não impede a descoberta nem lança', async () => {
    const { descobrirMorphoPorApi } = await import('./mercadosDoMorpho');
    const { mkdtemp, writeFile, readFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join: j } = await import('path');
    const dir = await mkdtemp(j(tmpdir(), 'morpho-'));
    const memoria = j(dir, 'memoria.json');
    await writeFile(memoria, '{"ultimoSucesso": {"merc');  // JSON cortado

    await descobrirMorphoPorApi({
        infra: { provedoresEsgotados: [], noFallback: false },
        buscar: async () => ({ status: 200, text: async () => pagina([7, 8]) }),
        caminhoDoCache: j(dir, 'mercados.json'), caminhoDaMemoria: memoria,
        tetoDeValidacoes: 1, tetoDeMercadosComDevedores: 0,
    });
    // Não lançou (chegamos aqui) e a memória foi REESCRITA com algo legível.
    const m = lerMemoria(JSON.parse(await readFile(memoria, 'utf8')));
    assert.notEqual(m.ultimaTentativa, null, 'a memória torta impediu a gravação nova');
});
