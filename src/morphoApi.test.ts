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

const pagina = (ids: number[], extra: Record<string, unknown> = {}) => JSON.stringify({
    ...extra,
    items: ids.map((n) => ({
        id: `0x${n.toString(16).padStart(64, '0')}`,
        loanAsset: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
        collateralAsset: { address: '0x4200000000000000000000000000000000000006' },
        oracle: { address: '0x1111111111111111111111111111111111111111' },
        irm: '0x2222222222222222222222222222222222222222',
        lltv: n % 2 === 0 ? '625000000000000000' : '945000000000000000',
    })),
});

test('enumera com paginação e para quando a página vem curta', async () => {
    const f = fingir([
        { status: 200, corpo: pagina([...Array(POR_PAGINA).keys()].map((n) => n + 1)) },
        { status: 200, corpo: pagina([1000, 1001]) },
    ]);
    const r = await enumerarMercados(f.buscar, { dormir: semSono });
    assert.equal(r.completa, true);
    assert.equal(r.paginas, 2);
    assert.equal(r.requisicoes, 2);
    assert.equal(r.mercados.length, POR_PAGINA + 2);
    // A URL leva a rede e o offset: sem offset a paginação seria enfeite.
    assert.match(f.urls[0]!, new RegExp(`chain_id=${CHAIN_ID_DA_BASE}`));
    assert.match(f.urls[0]!, /offset=0/);
    assert.match(f.urls[1]!, new RegExp(`offset=${POR_PAGINA}`));
});

test('API que IGNORA o offset não vira laço infinito', async () => {
    // Sempre a MESMA página cheia. Sem o critério `novos === 0` isto paginaria
    // até o teto, gastando 20 requisições para 100 mercados repetidos.
    const f = fingir([{ status: 200, corpo: pagina([...Array(POR_PAGINA).keys()].map((n) => n + 1)) }]);
    const r = await enumerarMercados(f.buscar, { dormir: semSono });
    assert.equal(r.completa, true);
    assert.equal(r.requisicoes, 2, 'duas: a primeira e a que revelou a repetição');
    assert.equal(r.mercados.length, POR_PAGINA, 'sem duplicados');
    assert.ok(r.requisicoes < TETO_DE_PAGINAS);
});

test('HTTP 429 não insiste, e a cobertura sai INCOMPLETA', async () => {
    const f = fingir([
        { status: 200, corpo: pagina([...Array(POR_PAGINA).keys()].map((n) => n + 1)) },
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
    const f = comoLerADescoberta({
        devolvidos: 120, mercados: 118, quePagam: 9, confirmados: 7,
        devedores: 340, validados: 12, requisicoes: 14,
        completa: false, blocoIndexado: 52_600_000, blocoAgora: 52_600_050, falha: 'HTTP 429',
    });
    for (const p of ['120 mercado(s) a API devolveu, 118 legíveis', '9 com LLTV ≤ 77%',
        '7 CONFIRMADOS na corrente', '340 devedor(es) apontado(s), 12 validado(s)',
        '14 requisição(ões)', 'COBERTURA INCOMPLETA', 'HTTP 429',
        '2 mercado(s) que pagam NÃO foram confirmados']) {
        assert.ok(f.includes(p), `falta "${p}"`);
    }
});

test('cobertura completa não publica ressalva que não existe', () => {
    const f = comoLerADescoberta({
        devolvidos: 10, mercados: 10, quePagam: 3, confirmados: 3,
        devedores: 5, validados: 5, requisicoes: 2,
        completa: true, blocoIndexado: 100, blocoAgora: 110, falha: null,
    });
    assert.ok(!/INCOMPLETA/.test(f));
    assert.ok(!/NÃO foram confirmados/.test(f));
    assert.ok(!/falha/.test(f));
});
