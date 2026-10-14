// Arquivo: src/morphoApi.ts
//
// DESCOBERTA DE MERCADOS E DEVEDORES DO MORPHO SEM `eth_getLogs`.
//
// POR QUE ESTE ARQUIVO EXISTE. Em 2026-10-14 o `eth_getLogs` estava recusado em
// TODOS os provedores configurados (Alchemy com cota mensal esgotada; base.org e
// publicnode com HTTP 429). Sem ele, `lerCreateMarket` nao tem evento para ler e
// a descoberta para. Ela corrigiu a minha premissa: a Morpho publica os mercados
// por API, e a corrente valida.
//
// A ARQUITETURA E HIBRIDA, e a divisao de responsabilidade e a coisa mais
// importante aqui:
//
//   API      ENUMERA. Ela diz quais mercados existem e quem tem posicao neles.
//            E um indice de terceiro, pode estar atrasado, e NUNCA decide tiro.
//   CORRENTE VALIDA. `idToMarketParams`, `market` e `position` por `eth_call`
//            dizem o que e verdade AGORA, e e isso que autoriza qualquer coisa.
//
// Mercado que a API lista e a corrente nao confirma NAO entra. Devedor que a API
// aponta e a corrente nao confirma NAO vira alvo. A API encurta a busca; ela nao
// substitui a leitura.
//
// LIMITE DESTE AMBIENTE, DECLARADO: `api.morpho.org` responde 403 no proxy deste
// sandbox (so `mainnet.base.org` esta na allowlist). Entao tudo aqui e exercitado
// com transporte INJETADO, e a chamada viva roda na Railway, onde a rede e
// aberta — e por isso `buscar` e parametro, nunca `fetch` global.

import Decimal from 'decimal.js';
import { AbiCoder } from 'ethers';
import { bonusPct } from './morpho';
import { LLTV_MAXIMO_QUE_PAGA, SELETORES_DO_MORPHO, type MercadoDoMorpho } from './mercadosDoMorpho';
import { sanitizar } from './capacidade';

const coder = AbiCoder.defaultAbiCoder();

/** A rede. 8453 e a Base, e ela nao e escrita de cabeca em mais lugar nenhum. */
export const CHAIN_ID_DA_BASE = 8453;

/** O teto de itens por pagina que a API aceita. Acima disto ela corta. */
export const POR_PAGINA = 100;

/**
 * O teto de paginas por varredura.
 *
 * Existe para a paginacao nao virar laco infinito quando a API devolver sempre
 * a mesma pagina — defeito que eu nao posso descartar sem ter testado contra o
 * servico real. Vinte paginas sao 2.000 mercados: muito acima do que a Base tem.
 */
export const TETO_DE_PAGINAS = 20;

/** Espera entre paginas, para respeitar o limite de requisicoes da API. */
export const ENTRE_PAGINAS_MS = 250;

/** O transporte, injetado. Nunca `fetch` global: ver o cabecalho. */
export interface TransporteHttp {
    (url: string, opcoes?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    }): Promise<{ status: number; text(): Promise<string> }>;
}

export interface MercadoDaApi extends MercadoDoMorpho {
    /** O bloco que a API diz ter indexado. `null` quando ela nao informa. */
    blocoIndexado: number | null;
    /** `true` so depois de a CORRENTE confirmar os parametros. */
    confirmadoNaCorrente: boolean;
}

export interface ResultadoDaEnumeracao {
    mercados: MercadoDaApi[];
    /** Quantos a API devolveu, antes de qualquer filtro meu. */
    devolvidos: number;
    paginas: number;
    requisicoes: number;
    /** `null` quando a API nao informa o bloco indexado. */
    blocoIndexado: number | null;
    /** A falha, SANITIZADA, quando a enumeracao nao completou. */
    falha: string | null;
    /** `true` quando TODAS as paginas vieram. Paginacao cortada nao e cobertura. */
    completa: boolean;
}

/**
 * Enumera os mercados da Base pela API REST, com paginacao.
 *
 * Nao filtra por LLTV aqui de proposito: o filtro e decisao economica e mora em
 * `soOsQuePagam`. Guardar todos permite responder "quantos existem" ao lado de
 * "quantos pagam", que e o que ela pediu como evidencia.
 */
export async function enumerarMercados(
    buscar: TransporteHttp,
    opcoes: { base?: string; porPagina?: number; dormir?: (ms: number) => Promise<void> } = {},
): Promise<ResultadoDaEnumeracao> {
    const base = opcoes.base ?? 'https://api.morpho.org/v1/blue/markets';
    const porPagina = Math.min(opcoes.porPagina ?? POR_PAGINA, POR_PAGINA);
    const dormir = opcoes.dormir ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
    const mercados: MercadoDaApi[] = [];
    const vistos = new Set<string>();
    let requisicoes = 0;
    let paginas = 0;
    let devolvidos = 0;
    let blocoIndexado: number | null = null;

    for (let pagina = 0; pagina < TETO_DE_PAGINAS; pagina += 1) {
        const url = `${base}?chain_id=${CHAIN_ID_DA_BASE}&limit=${porPagina}`
            + `&offset=${pagina * porPagina}`;
        requisicoes += 1;
        let cru: string;
        let status: number;
        try {
            const r = await buscar(url, { headers: { Accept: 'application/json' } });
            status = r.status;
            cru = await r.text();
        } catch (e) {
            return {
                mercados, devolvidos, paginas, requisicoes, blocoIndexado,
                falha: `o transporte falhou na página ${pagina}: `
                    + sanitizar(e instanceof Error ? e.message : String(e)),
                completa: false,
            };
        }
        if (status !== 200) {
            return {
                mercados, devolvidos, paginas, requisicoes, blocoIndexado,
                falha: `a API respondeu HTTP ${status} na página ${pagina}`
                    + (status === 429 ? ' (limite de requisições: não insisto)' : ''),
                completa: false,
            };
        }
        let corpo: unknown;
        try {
            corpo = JSON.parse(cru);
        } catch {
            return {
                mercados, devolvidos, paginas, requisicoes, blocoIndexado,
                falha: `a API respondeu NÃO-JSON na página ${pagina}: começa com `
                    + `"${sanitizar(cru.slice(0, 50))}"`,
                completa: false,
            };
        }
        const lido = lerPaginaDeMercados(corpo);
        if (lido.blocoIndexado !== null) blocoIndexado = lido.blocoIndexado;
        devolvidos += lido.itens.length;
        paginas += 1;
        let novos = 0;
        for (const m of lido.itens) {
            if (vistos.has(m.id)) continue;
            vistos.add(m.id);
            mercados.push(m);
            novos += 1;
        }
        // PAGINA VAZIA ou SEM NADA NOVO encerra. "Sem nada novo" cobre a API que
        // ignora o offset e devolve sempre a primeira pagina — e sem isso a
        // paginacao viraria laco. Nao e suposicao sobre o servico: e o unico
        // criterio de parada que funciona nos dois casos.
        if (lido.itens.length === 0 || novos === 0) {
            return { mercados, devolvidos, paginas, requisicoes, blocoIndexado, falha: null, completa: true };
        }
        if (lido.itens.length < porPagina) {
            return { mercados, devolvidos, paginas, requisicoes, blocoIndexado, falha: null, completa: true };
        }
        await dormir(ENTRE_PAGINAS_MS);
    }
    return {
        mercados, devolvidos, paginas, requisicoes, blocoIndexado,
        falha: `a paginação passou de ${TETO_DE_PAGINAS} páginas e eu parei`,
        completa: false,
    };
}

/**
 * Le uma pagina de mercados, aceitando as formas plausiveis do corpo.
 *
 * NAO e tolerancia por preguica: eu nao pude testar contra o servico real (403
 * neste sandbox), entao reconhecer `{items:[...]}`, `{data:[...]}` e `[...]` e o
 * que impede a primeira execucao na Railway de voltar vazia por causa do
 * envelope. O que NAO e tolerado e campo essencial ausente: item sem `id` ou
 * sem `lltv` e descartado, nunca completado com padrao.
 */
export function lerPaginaDeMercados(corpo: unknown): {
    itens: MercadoDaApi[]; blocoIndexado: number | null;
} {
    const itens: MercadoDaApi[] = [];
    if (typeof corpo !== 'object' || corpo === null) return { itens, blocoIndexado: null };
    const o = corpo as Record<string, unknown>;
    const lista = Array.isArray(corpo) ? corpo
        : Array.isArray(o.items) ? o.items
            : Array.isArray(o.data) ? o.data
                : Array.isArray((o.data as Record<string, unknown>)?.markets)
                    ? ((o.data as Record<string, unknown>).markets as unknown[]) : [];
    const bloco = lerBloco(o);
    for (const cru of lista) {
        const m = lerUmMercado(cru);
        if (m !== null) itens.push(m);
    }
    return { itens, blocoIndexado: bloco };
}

function lerBloco(o: Record<string, unknown>): number | null {
    for (const chave of ['indexed_block', 'indexedBlock', 'block', 'blockNumber']) {
        const v = o[chave];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
        if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
    }
    return null;
}

/** Um mercado da API, ou `null` quando falta campo essencial. */
export function lerUmMercado(cru: unknown): MercadoDaApi | null {
    if (typeof cru !== 'object' || cru === null) return null;
    const o = cru as Record<string, unknown>;
    const id = texto(o.id ?? o.uniqueKey ?? o.unique_key);
    if (id === null || !/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
    const params = (typeof o.params === 'object' && o.params !== null
        ? o.params as Record<string, unknown> : o);
    const loan = endereco(params.loanAsset ?? params.loan_token ?? params.loanToken);
    const col = endereco(params.collateralAsset ?? params.collateral_token ?? params.collateralToken);
    const oracle = endereco(params.oracle);
    const irm = endereco(params.irm);
    const lltv = lerLltv(params.lltv);
    // SEM LLTV NAO HA MERCADO UTIL: o incentivo e funcao dele, e supor um valor
    // seria inventar o premio. Igual para os enderecos.
    if (loan === null || col === null || oracle === null || irm === null || lltv === null) return null;
    return {
        id: id.toLowerCase(),
        loanToken: loan, collateralToken: col, oracle, irm,
        lltv, bonusPct: bonusPct(lltv),
        blocoDaCriacao: 0,
        blocoIndexado: lerBloco(o),
        confirmadoNaCorrente: false,
    };
}

function texto(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function endereco(v: unknown): string | null {
    const bruto = typeof v === 'object' && v !== null
        ? texto((v as Record<string, unknown>).address)
        : texto(v);
    if (bruto === null || !/^0x[0-9a-fA-F]{40}$/.test(bruto)) return null;
    return bruto.toLowerCase();
}

/**
 * O LLTV, aceitando WAD inteiro (`860000000000000000`) e fracao (`0.86`).
 *
 * As duas formas aparecem em APIs de DeFi, e confundi-las erra por 10^18 — o
 * mesmo tipo de erro que a `ESCALA_DO_ORACULO` deste projeto quase cometeu. O
 * discriminador e o tamanho: LLTV e sempre entre 0 e 1 como fracao, e sempre
 * acima de 10^15 como WAD. Nao ha faixa ambigua.
 */
export function lerLltv(v: unknown): Decimal | null {
    let d: Decimal;
    try {
        if (typeof v === 'number' && Number.isFinite(v)) d = new Decimal(v);
        else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) d = new Decimal(v.trim());
        else if (typeof v === 'bigint') d = new Decimal(v.toString());
        else return null;
    } catch { return null; }
    if (d.lessThanOrEqualTo(0)) return null;
    if (d.lessThan(1)) return d;                       // fracao
    if (d.greaterThanOrEqualTo(1e15)) {                // WAD
        const f = d.dividedBy(1e18);
        return f.greaterThan(0) && f.lessThan(1) ? f : null;
    }
    return null;                                        // nem fracao nem WAD
}

/** Os mercados que o incentivo paga: LLTV <= 77%, medido no censo de 10 dias. */
export function soOsQuePagam(ms: MercadoDaApi[]): MercadoDaApi[] {
    return ms.filter((m) => m.lltv.lessThanOrEqualTo(LLTV_MAXIMO_QUE_PAGA));
}

// ---------------------------------------------------------------------------
// A VALIDACAO NA CORRENTE. E ela que autoriza, nao a API.
// ---------------------------------------------------------------------------

/** `idToMarketParams(bytes32)` — o calldata. O seletor vem de `mercadosDoMorpho`. */
export function codificarIdToMarketParams(id: string): string {
    return SELETORES_DO_MORPHO['idToMarketParams(bytes32)']! + id.replace(/^0x/, '').padStart(64, '0');
}

/** `position(bytes32,address)` — o calldata. */
export function codificarPosition(id: string, quem: string): string {
    return SELETORES_DO_MORPHO['position(bytes32,address)']!
        + id.replace(/^0x/, '').padStart(64, '0')
        + quem.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** `market(bytes32)` — o calldata. */
export function codificarMarket(id: string): string {
    return SELETORES_DO_MORPHO['market(bytes32)']! + id.replace(/^0x/, '').padStart(64, '0');
}

export interface ParametrosNaCorrente {
    loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: Decimal;
}

/** Decodifica `idToMarketParams`. `null` quando a resposta nao serve. */
export function lerIdToMarketParams(dados: string): ParametrosNaCorrente | null {
    try {
        const [loan, col, oracle, irm, lltv] = coder.decode(
            ['address', 'address', 'address', 'address', 'uint256'], dados,
        ) as unknown as [string, string, string, string, bigint];
        const f = new Decimal(lltv.toString()).dividedBy(1e18);
        if (f.lessThanOrEqualTo(0) || f.greaterThanOrEqualTo(1)) return null;
        return {
            loanToken: loan.toLowerCase(), collateralToken: col.toLowerCase(),
            oracle: oracle.toLowerCase(), irm: irm.toLowerCase(), lltv: f,
        };
    } catch { return null; }
}

/** Decodifica `position`: garantia e as SHARES de emprestimo, nao o valor. */
export function lerPosition(dados: string): {
    supplyShares: bigint; borrowShares: bigint; collateral: bigint;
} | null {
    try {
        const [s, b, c] = coder.decode(
            ['uint256', 'uint128', 'uint128'], dados,
        ) as unknown as [bigint, bigint, bigint];
        return { supplyShares: s, borrowShares: b, collateral: c };
    } catch { return null; }
}

/** Decodifica `market`: os totais, que convertem shares em ativos. */
export function lerMarket(dados: string): {
    totalSupplyAssets: bigint; totalSupplyShares: bigint;
    totalBorrowAssets: bigint; totalBorrowShares: bigint;
} | null {
    try {
        const v = coder.decode(
            ['uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128'], dados,
        ) as unknown as bigint[];
        return {
            totalSupplyAssets: v[0]!, totalSupplyShares: v[1]!,
            totalBorrowAssets: v[2]!, totalBorrowShares: v[3]!,
        };
    } catch { return null; }
}

/**
 * Shares -> ativos, ARREDONDANDO PARA CIMA, como o Morpho faz na divida.
 *
 * O sentido do arredondamento nao e detalhe: para baixo subestimaria a divida e
 * o bot acharia a posicao mais saudavel do que ela e. Errar para cima e o lado
 * seguro — ele recusa alvo, nao inventa alvo.
 *
 * `totalShares === 0` devolve `null`, nao zero: mercado sem shares nao permite
 * converter nada, e zero diria "nao deve nada".
 */
export function sharesParaAtivos(
    shares: bigint, totalAtivos: bigint, totalShares: bigint,
): bigint | null {
    if (totalShares <= 0n) return null;
    if (shares <= 0n) return 0n;
    return (shares * totalAtivos + totalShares - 1n) / totalShares;
}

/**
 * A API concorda com a corrente?
 *
 * Qualquer campo divergente REPROVA o mercado inteiro. Nao e rigor decorativo: a
 * API e indice de terceiro, e um `oracle` trocado faz a saude sair por um fator
 * de 10^n — e o portao que existe para isso neste projeto (`limiaresConferem`,
 * `saudeConfere`) ja recusou 10 medicoes erradas em vez de imprimi-las.
 */
export function apiConfereComACorrente(
    daApi: MercadoDaApi, naCorrente: ParametrosNaCorrente | null,
): { confere: boolean; porque: string } {
    if (naCorrente === null) {
        return { confere: false, porque: 'a corrente não devolveu parâmetros legíveis para este id' };
    }
    const divergem: string[] = [];
    if (daApi.loanToken !== naCorrente.loanToken) divergem.push('loanToken');
    if (daApi.collateralToken !== naCorrente.collateralToken) divergem.push('collateralToken');
    if (daApi.oracle !== naCorrente.oracle) divergem.push('oracle');
    if (daApi.irm !== naCorrente.irm) divergem.push('irm');
    if (!daApi.lltv.equals(naCorrente.lltv)) divergem.push('lltv');
    return divergem.length === 0
        ? { confere: true, porque: 'a corrente confirmou os cinco parâmetros' }
        : {
            confere: false,
            porque: `a API divergiu da corrente em ${divergem.join(', ')} — mercado RECUSADO, `
                + 'porque índice de terceiro não decide tiro',
        };
}

// ---------------------------------------------------------------------------
// OS DEVEDORES, por GraphQL.
// ---------------------------------------------------------------------------

/** A consulta. `first`/`skip` porque e o que a API documenta para paginar. */
export function consultaDeDevedores(idDoMercado: string, primeiros: number, pular: number): string {
    return JSON.stringify({
        query: `query($id: String!, $first: Int!, $skip: Int!) {
  marketPositions(where: { marketUniqueKey_in: [$id] }, first: $first, skip: $skip) {
    items { user { address } state { borrowShares collateral } }
  }
}`,
        variables: { id: idDoMercado, first: primeiros, skip: pular },
    });
}

export interface DevedorDaApi {
    endereco: string;
    /** As shares que a API diz. CONFERENCIA, nunca fonte para decidir. */
    borrowSharesDaApi: bigint | null;
}

/** Le a resposta do GraphQL. Item sem endereco nao vira devedor. */
export function lerDevedores(corpo: unknown): DevedorDaApi[] {
    const fora: DevedorDaApi[] = [];
    if (typeof corpo !== 'object' || corpo === null) return fora;
    const d = (corpo as Record<string, unknown>).data as Record<string, unknown> | undefined;
    const mp = d?.marketPositions as Record<string, unknown> | undefined;
    const itens = Array.isArray(mp?.items) ? mp!.items as unknown[] : [];
    for (const cru of itens) {
        if (typeof cru !== 'object' || cru === null) continue;
        const o = cru as Record<string, unknown>;
        const user = o.user as Record<string, unknown> | undefined;
        const end = endereco(user?.address ?? o.user);
        if (end === null) continue;
        const estado = o.state as Record<string, unknown> | undefined;
        let shares: bigint | null = null;
        const s = estado?.borrowShares;
        try {
            if (typeof s === 'string' && /^\d+$/.test(s)) shares = BigInt(s);
            else if (typeof s === 'number' && Number.isInteger(s)) shares = BigInt(s);
        } catch { shares = null; }
        fora.push({ endereco: end, borrowSharesDaApi: shares });
    }
    return fora;
}

/**
 * Enumera os devedores de um mercado, com paginacao e teto.
 *
 * O teto existe pela mesma razao do de mercados: sem ele, uma API que ignora
 * `skip` pagina para sempre. E `novos === 0` encerra.
 */
export async function enumerarDevedores(
    buscar: TransporteHttp,
    idDoMercado: string,
    opcoes: { url?: string; porPagina?: number; tetoDePaginas?: number;
        dormir?: (ms: number) => Promise<void> } = {},
): Promise<{ devedores: DevedorDaApi[]; requisicoes: number; falha: string | null; completa: boolean }> {
    const url = opcoes.url ?? 'https://api.morpho.org/graphql';
    const porPagina = Math.min(opcoes.porPagina ?? POR_PAGINA, POR_PAGINA);
    const teto = opcoes.tetoDePaginas ?? TETO_DE_PAGINAS;
    const dormir = opcoes.dormir ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
    const devedores: DevedorDaApi[] = [];
    const vistos = new Set<string>();
    let requisicoes = 0;
    for (let p = 0; p < teto; p += 1) {
        requisicoes += 1;
        let cru: string; let status: number;
        try {
            const r = await buscar(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: consultaDeDevedores(idDoMercado, porPagina, p * porPagina),
            });
            status = r.status; cru = await r.text();
        } catch (e) {
            return { devedores, requisicoes, completa: false,
                falha: `o transporte falhou: ${sanitizar(e instanceof Error ? e.message : String(e))}` };
        }
        if (status !== 200) {
            return { devedores, requisicoes, completa: false,
                falha: `o GraphQL respondeu HTTP ${status}` };
        }
        let corpo: unknown;
        try { corpo = JSON.parse(cru); } catch {
            return { devedores, requisicoes, completa: false,
                falha: `o GraphQL respondeu NÃO-JSON: "${sanitizar(cru.slice(0, 50))}"` };
        }
        const lidos = lerDevedores(corpo);
        let novos = 0;
        for (const d of lidos) {
            if (vistos.has(d.endereco)) continue;
            vistos.add(d.endereco); devedores.push(d); novos += 1;
        }
        if (lidos.length === 0 || novos === 0 || lidos.length < porPagina) {
            return { devedores, requisicoes, falha: null, completa: true };
        }
        await dormir(ENTRE_PAGINAS_MS);
    }
    return { devedores, requisicoes, completa: false,
        falha: `a paginação passou de ${teto} páginas e eu parei` };
}

// ---------------------------------------------------------------------------
// O CACHE. Ele e o que mantem o monitoramento quando a API cai.
// ---------------------------------------------------------------------------

export const VERSAO_DO_CACHE_MORPHO = 1;

export interface CacheDeMercados {
    versao: number;
    gravadoEm: number;
    /** O bloco que a API dizia ter indexado quando isto foi gravado. */
    blocoIndexado: number | null;
    /** `true` so quando a paginacao completou. Cache parcial se declara. */
    completo: boolean;
    mercados: Array<{
        id: string; loanToken: string; collateralToken: string; oracle: string; irm: string;
        /** Texto, nunca `Decimal`: `JSON.stringify` de um `Decimal` grava os
         * internos da biblioteca e `new Decimal` nao le isso de volta. Este
         * projeto perdeu o placar uma vez por causa disso. */
        lltv: string;
        confirmadoNaCorrente: boolean;
    }>;
}

export function paraCache(
    ms: MercadoDaApi[], blocoIndexado: number | null, completo: boolean, agora: number,
): CacheDeMercados {
    return {
        versao: VERSAO_DO_CACHE_MORPHO, gravadoEm: agora, blocoIndexado, completo,
        mercados: ms.map((m) => ({
            id: m.id, loanToken: m.loanToken, collateralToken: m.collateralToken,
            oracle: m.oracle, irm: m.irm, lltv: m.lltv.toString(),
            confirmadoNaCorrente: m.confirmadoNaCorrente,
        })),
    };
}

/** `null` quando o arquivo nao serve. Nunca cache vazio com cara de cache. */
export function doCache(x: unknown): MercadoDaApi[] | null {
    if (typeof x !== 'object' || x === null) return null;
    const o = x as Record<string, unknown>;
    if (o.versao !== VERSAO_DO_CACHE_MORPHO || !Array.isArray(o.mercados)) return null;
    const fora: MercadoDaApi[] = [];
    for (const cru of o.mercados) {
        const m = lerUmMercado({ ...(cru as object), lltv: (cru as { lltv?: string }).lltv });
        if (m === null) continue;
        m.confirmadoNaCorrente = (cru as { confirmadoNaCorrente?: boolean }).confirmadoNaCorrente === true;
        m.blocoIndexado = typeof o.blocoIndexado === 'number' ? o.blocoIndexado : null;
        fora.push(m);
    }
    return fora.length === 0 ? null : fora;
}

/**
 * A idade do indice, e o que ela permite.
 *
 * Ela pediu: *"Acompanhe o bloco da indexação para detectar dados atrasados."*
 * Com 2s por bloco na Base, 150 blocos sao 5 minutos — tarde demais para
 * decidir tiro, cedo o bastante para decidir ONDE olhar. As duas conclusoes sao
 * diferentes e a frase diz qual e qual.
 */
export const BLOCOS_DE_ATRASO_QUE_IMPORTAM = 150;

export function idadeDoIndice(blocoIndexado: number | null, blocoAgora: number | null): string {
    if (blocoIndexado === null) {
        return 'a API não informou o bloco indexado: idade DESCONHECIDA, e desconhecida não é zero. '
            + 'Serve para enumerar, não para decidir';
    }
    if (blocoAgora === null) return `índice no bloco ${blocoIndexado}; não sei o bloco de agora`;
    const atraso = blocoAgora - blocoIndexado;
    if (atraso < 0) {
        return `o índice diz um bloco À FRENTE do meu (${blocoIndexado} contra ${blocoAgora}): `
            + 'ou eu estou atrasado, ou o índice é de outra rede. Não uso';
    }
    return `índice ${atraso} bloco(s) atrás (~${((atraso * 2) / 60).toFixed(1)} min)`
        + (atraso > BLOCOS_DE_ATRASO_QUE_IMPORTAM
            ? ' — ATRASADO para decidir qualquer coisa; serve só para saber onde olhar'
            : ' — recente o bastante para orientar a leitura, e ainda assim quem decide é o eth_call');
}

/** A frase de evidência: os números que ela pediu, calculados dos contadores. */
export function comoLerADescoberta(e: {
    devolvidos: number; mercados: number; quePagam: number; confirmados: number;
    devedores: number; validados: number; requisicoes: number;
    completa: boolean; blocoIndexado: number | null; blocoAgora: number | null;
    falha: string | null;
}): string {
    const partes = [
        `${e.devolvidos} mercado(s) a API devolveu, ${e.mercados} legíveis`,
        `${e.quePagam} com LLTV ≤ 77%`,
        `${e.confirmados} CONFIRMADOS na corrente`,
        `${e.devedores} devedor(es) apontado(s), ${e.validados} validado(s) por eth_call`,
        `${e.requisicoes} requisição(ões)`,
        idadeDoIndice(e.blocoIndexado, e.blocoAgora),
    ];
    if (!e.completa) {
        partes.push('COBERTURA INCOMPLETA: a paginação não terminou, então este número é PISO, '
            + 'não total');
    }
    if (e.falha !== null) partes.push(`falha: ${e.falha}`);
    if (e.confirmados < e.quePagam) {
        partes.push(`${e.quePagam - e.confirmados} mercado(s) que pagam NÃO foram confirmados: `
            + 'eles não entram em decisão nenhuma');
    }
    return partes.join(' | ');
}
