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
import { OrcamentoHttp, comoLerODesfecho, type DesfechoDaDescoberta } from './canais';

const coder = AbiCoder.defaultAbiCoder();

/** A rede. 8453 e a Base, e ela nao e escrita de cabeca em mais lugar nenhum. */
export const CHAIN_ID_DA_BASE = 8453;

/** O teto de itens por pagina que a API aceita. Acima disto ela corta. */
export const POR_PAGINA = 100;

/**
 * O teto de paginas por varredura.
 *
 * A Base devolveu mais de 2.000 mercados em producao, e o limite anterior
 * cortava toda varredura na pagina 20 (a API ainda oferecia cursor).
 * O teto maior continua sujeito ao OrcamentoHttp de chamadas e tempo e
 * encerra de forma INCOMPLETA quando nao for possivel finalizar.
 */
export const TETO_DE_PAGINAS = 40;

/** Espera entre paginas, para respeitar o limite de requisicoes da API. */
export const ENTRE_PAGINAS_MS = 250;

/** O transporte, injetado. Nunca `fetch` global: ver o cabecalho. */
export interface TransporteHttp {
    (url: string, opcoes?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        /**
         * O CANCELAMENTO, e ele e um sinal de verdade e nao um booleano meu.
         *
         * Este projeto ja mediu o custo de nao passar sinal: `cotacoesDaBinance`
         * montava o proprio timeout e nunca via o podao do orcamento, entao a
         * perna que nunca respondia segurava a volta inteira e o teto era letra
         * morta. Um `fetch` ignorado nao e um `fetch` cancelado.
         */
        signal?: AbortSignal;
    }): Promise<{ status: number; text(): Promise<string> }>;
}

export interface MercadoDaApi extends MercadoDoMorpho {
    /** O bloco que a API diz ter indexado. `null` quando ela nao informa. */
    blocoIndexado: number | null;
    /** `true` so depois de a CORRENTE confirmar os parametros. */
    confirmadoNaCorrente: boolean;
    /**
     * O chain id que o PROPRIO item declara. `null` quando a API nao informa.
     *
     * `null` nao e descarte: ver `soDaBase`. Serve para o log poder dizer que a
     * API devolveu mercado de outra rede apesar do `chain_id` na URL.
     */
    chainId: number | null;
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
    /**
     * A requisicao HTTP SAIU, ao menos uma.
     *
     * Ela pediu isto por nome: *"Requisicao HTTP realmente iniciada"*. E o
     * discriminador entre "a tarefa nao executou" e "a API falhou", que pedem
     * consertos opostos — agendamento contra rede. Sem este campo as duas
     * situacoes produzem a mesma lista vazia, e foi a confusao delas que custou
     * o deploy de 2026-10-14.
     */
    tentou: boolean;
    /**
     * ERRO DE SCHEMA: a API respondeu 200 e eu NAO soube ler o corpo.
     *
     * `null` quando nao houve. Este campo existe porque em 2026-10-14 um HTTP
     * 200 produziu zero mercados e o log nao distinguia "a Base nao tem
     * mercado" de "eu nao entendi a resposta". As duas pedem consertos opostos.
     */
    erroDeSchema: string | null;
    /** Quantos ELEMENTOS as listas trouxeram, antes da decodificacao. */
    elementosRecebidos: number;
    /** Quantas paginas vieram por CURSOR (contrato REST) e nao por offset. */
    paginouPorCursor: boolean;
    /** Cursor da próxima página, para continuar em outra rodada sem recomeçar. */
    proximoCursor?: string | null;
    /**
     * Os status HTTP REAIS observados, um por requisicao, na ordem.
     *
     * Numeros, nao a minha prosa sobre eles: *"Status HTTP real"*. Lista vazia
     * com `tentou: true` quer dizer que o transporte lancou antes de haver
     * resposta — que e diferente de um 200 com corpo ruim.
     */
    statusHttp: number[];
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
    opcoes: {
        base?: string;
        reservaDeRequisicoes?: number;
        /** Cursor opaco da última página aceita em uma rodada anterior. */
        inicio?: string | null;
        porPagina?: number;
        dormir?: (ms: number) => Promise<void>;
        orcamento?: OrcamentoHttp;
    } = {},
): Promise<ResultadoDaEnumeracao> {
    const base = opcoes.base ?? 'https://api.morpho.org/v1/blue/markets';
    const porPagina = Math.min(opcoes.porPagina ?? POR_PAGINA, POR_PAGINA);
    const dormir = opcoes.dormir ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
    const mercados: MercadoDaApi[] = [];
    const vistos = new Set<string>();
    const statusHttp: number[] = [];
    const cursoresUsados = new Set<string>();
    let requisicoes = 0;
    let paginas = 0;
    let devolvidos = 0;
    let elementosRecebidos = 0;
    let blocoIndexado: number | null = null;
    let tentou = false;
    let erroDeSchema: string | null = null;
    let paginouPorCursor = false;
    let cursor: string | null = typeof opcoes.inicio === 'string'
        && opcoes.inicio.length > 0 && opcoes.inicio.length <= 2048
        ? opcoes.inicio : null;
    if (cursor !== null) { cursoresUsados.add(cursor); paginouPorCursor = true; }

    const parcial = (falha: string | null, completa: boolean): ResultadoDaEnumeracao => ({
        mercados, devolvidos, paginas, requisicoes, blocoIndexado, falha, completa,
        tentou, statusHttp, erroDeSchema, elementosRecebidos, paginouPorCursor,
        proximoCursor: completa ? null : cursor,
    });

    for (let pagina = 0; pagina < TETO_DE_PAGINAS; pagina += 1) {
        if(opcoes.orcamento && (opcoes.reservaDeRequisicoes??0)>0 && opcoes.orcamento.tetoDeRequisicoes-opcoes.orcamento.gastas
            <=(opcoes.reservaDeRequisicoes??0))return parcial('capacidade reservada para devedores',false);
        if (opcoes.orcamento && !opcoes.orcamento.pedir()) {
            return parcial(
                `o orçamento encerrou a enumeração: ${opcoes.orcamento.encerrado ?? 'sem motivo registrado'}`,
                false,
            );
        }
        // PAGINACAO POR CURSOR, que e o contrato REST documentado.
        //
        // Era `offset`, e ela corrigiu. O `offset` fica como partida da PRIMEIRA
        // pagina apenas quando nao ha cursor — sem ele a primeira requisicao
        // nao teria como existir. A partir da segunda, quem manda e o cursor
        // opaco que a API devolveu; sem cursor, a paginacao ENCERRA, porque
        // inventar a proxima pagina e pedir o que nao foi oferecido.
        const url = `${base}?chain_id=${CHAIN_ID_DA_BASE}&limit=${porPagina}`
            + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        requisicoes += 1;
        tentou = true;
        let cru: string;
        let status: number;
        try {
            const r = await buscar(url, {
                headers: { Accept: 'application/json' },
                ...(opcoes.orcamento ? { signal: opcoes.orcamento.sinal } : {}),
            });
            status = r.status;
            statusHttp.push(status);
            cru = await r.text();
        } catch (e) {
            return parcial(
                `o transporte falhou na página ${pagina}: `
                    + sanitizar(e instanceof Error ? e.message : String(e)),
                false,
            );
        }
        if (status !== 200) {
            return parcial(
                `a API respondeu HTTP ${status} na página ${pagina}`
                    + (status === 429 ? ' (limite de requisições: não insisto)' : ''),
                false,
            );
        }
        let corpo: unknown;
        try {
            corpo = JSON.parse(cru);
        } catch {
            return parcial(
                `a API respondeu NÃO-JSON na página ${pagina}: começa com `
                    + `"${sanitizar(cru.slice(0, 50))}"`,
                false,
            );
        }
        const lido = lerPaginaDeMercados(corpo);
        if (lido.blocoIndexado !== null) blocoIndexado = lido.blocoIndexado;
        devolvidos += lido.itens.length;
        elementosRecebidos += lido.elementos;
        paginas += 1;
        if (lido.erroDeSchema !== null && erroDeSchema === null) erroDeSchema = lido.erroDeSchema;

        let novos = 0;
        for (const m of lido.itens) {
            if (vistos.has(m.id)) continue;
            vistos.add(m.id);
            mercados.push(m);
            novos += 1;
        }

        // 200 COM ELEMENTOS E NENHUM DECODIFICADO NAO E "COBERTURA COMPLETA".
        //
        // E o defeito do log de 2026-10-14: a pagina "vazia" encerrava com
        // `completa: true`, e um erro de contrato virava a afirmacao de que a
        // enumeracao terminou e nao havia mercado. Agora isso e FALHA.
        if (lido.erroDeSchema !== null) {
            return parcial(lido.erroDeSchema, false);
        }

        // SEM CURSOR encerra: a API nao ofereceu proxima pagina.
        const proximo = lido.cursor;
        if (proximo === null) {
            return parcial(null, true);
        }
        // CURSOR REPETIDO e laco: encerra DECLARANDO, porque continuar pediria
        // a mesma pagina para sempre e a cobertura nao seria completa.
        if (cursoresUsados.has(proximo)) {
            return parcial(
                `a API repetiu o cursor na página ${pagina}: encerro para não entrar em laço`,
                false,
            );
        }
        if (proximo.length > 2048) {
            return parcial('a API enviou cursor grande demais; não persisto', false);
        }
        // Não avanço o cursor se a página não é utilizável.
        if (lido.itens.length === 0 && lido.elementos === 0) return parcial(null, true);
        if (novos === 0) {
            return parcial(
                `a página ${pagina} não trouxe nenhum mercado novo apesar do cursor: encerro`,
                false,
            );
        }
        cursoresUsados.add(proximo);
        cursor = proximo;
        paginouPorCursor = true;
        await dormir(ENTRE_PAGINAS_MS);
    }
    return parcial(`a paginação passou de ${TETO_DE_PAGINAS} páginas e eu parei`, false);
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
export interface PaginaLida {
    itens: MercadoDaApi[];
    blocoIndexado: number | null;
    /** O cursor opaco da proxima pagina, quando a API devolve um. */
    cursor: string | null;
    /**
     * Quantos ELEMENTOS a lista trazia, antes da decodificacao.
     *
     * Este e o numero que separa "a API nao mandou nada" de "a API mandou e eu
     * nao entendi" — e as duas situacoes pediam consertos opostos enquanto
     * produziam o mesmo zero.
     */
    elementos: number;
    /**
     * O DIAGNOSTICO quando vieram elementos e nenhum decodificou.
     *
     * `null` quando nao ha o que diagnosticar. Ele carrega NOMES DE CHAVE e
     * contagens, nunca valores: ela pediu *"Não publique dados sensíveis nem
     * corpos enormes nos logs."*
     */
    erroDeSchema: string | null;
}

/**
 * Le uma pagina de mercados.
 *
 * O DEFEITO QUE ISTO CONSERTA, medido no Railway em 2026-10-14 sobre `598df41`:
 * a API respondeu **HTTP 200** e a descoberta publicou **zero mercados
 * enumerados**, com a memoria registrando SEM SUCESSO. Status bom e lista
 * vazia: as duas unicas coisas que o log dizia, e elas nao distinguem "a Base
 * nao tem mercado Morpho" de "eu nao soube ler o corpo".
 *
 * A causa provavel e o CONTRATO: a dona do bot aponta a documentacao do
 * `GET /v1/blue/markets`, que define envelope `data`, paginacao por `cursor` e
 * campos `market_id`, `lltv_wad`, `oracle_address`, `irm_address` — enquanto
 * este parser exigia `id`/`uniqueKey` e `lltv`, que sao os nomes do GraphQL.
 * Cada item seria recusado, `itens.length` cairia a zero, e o laco encerraria
 * declarando `completa: true`. Zero por construcao.
 *
 * **Eu NAO pude conferir o contrato:** `api.morpho.org` e `docs.morpho.org`
 * respondem 403 CONNECT neste sandbox. Entao os nomes REST entram por citacao
 * DELA, declarada como tal, e nao da minha memoria — endereco e nome de campo
 * escritos de cabeca sao o defeito do `0x80d1e0f4…` que a REGRA 0 registra.
 *
 * E e por isso que a correcao que DECIDE nao e a lista de nomes: e o
 * `erroDeSchema`. Aceitar mais nomes e aposta; recusar-se a publicar zero
 * quando vieram elementos que nao decodificaram e verificavel, e faz o proximo
 * log do Railway dizer a verdade mesmo que eu tenha errado os nomes.
 */
export function lerPaginaDeMercados(corpo: unknown): PaginaLida {
    const itens: MercadoDaApi[] = [];
    const vazia = (erro: string | null): PaginaLida => ({
        itens, blocoIndexado: null, cursor: null, elementos: 0, erroDeSchema: erro,
    });
    if (typeof corpo !== 'object' || corpo === null) {
        return vazia(`o corpo não é objeto nem lista: é ${typeof corpo}`);
    }
    const o = corpo as Record<string, unknown>;

    // O ENVELOPE. `data` primeiro, porque e o do contrato REST documentado.
    const dentroDeData = (typeof o.data === 'object' && o.data !== null && !Array.isArray(o.data))
        ? o.data as Record<string, unknown>
        : null;
    const achado: { lista: unknown[]; onde: string } | null =
        Array.isArray(corpo) ? { lista: corpo, onde: 'raiz (lista)' }
            : Array.isArray(o.data) ? { lista: o.data, onde: 'data' }
                : Array.isArray(o.items) ? { lista: o.items, onde: 'items' }
                    : Array.isArray(o.markets) ? { lista: o.markets, onde: 'markets' }
                        : Array.isArray(o.results) ? { lista: o.results, onde: 'results' }
                            : dentroDeData !== null && Array.isArray(dentroDeData.markets)
                                ? { lista: dentroDeData.markets as unknown[], onde: 'data.markets' }
                                : dentroDeData !== null && Array.isArray(dentroDeData.items)
                                    ? { lista: dentroDeData.items as unknown[], onde: 'data.items' }
                                    : null;

    const cursor = lerCursor(o, dentroDeData);
    const bloco = lerBloco(o) ?? (dentroDeData === null ? null : lerBloco(dentroDeData));

    // NENHUMA LISTA: isto NAO e lista vazia. 200 com envelope desconhecido e
    // ERRO DE SCHEMA, e a frase nomeia as chaves que chegaram para a proxima
    // volta nao depender de eu adivinhar.
    if (achado === null) {
        return {
            itens, blocoIndexado: bloco, cursor, elementos: 0,
            erroDeSchema: 'HTTP 200 e NENHUMA lista de mercados no corpo. Chaves do objeto: '
                + `[${chavesDe(o)}]`
                + (dentroDeData === null ? '' : ` | chaves de data: [${chavesDe(dentroDeData)}]`)
                + '. Isto NÃO é "a Base não tem mercados": é "não encontrei o array"',
        };
    }

    for (const cru of achado.lista) {
        const m = lerUmMercado(cru);
        if (m !== null) itens.push(m);
    }

    // VEIO E NAO DECODIFICOU: o caso exato do log de 2026-10-14. A frase diz
    // quantos vieram, de onde, e QUE CAMPOS faltaram no primeiro item — nomes,
    // nunca valores.
    const erroDeSchema = achado.lista.length > 0 && itens.length === 0
        ? `HTTP 200 trouxe ${achado.lista.length} elemento(s) em "${achado.onde}" e NENHUM `
            + `decodificou. ${porQueNaoDecodificou(achado.lista[0])}`
        : null;

    return { itens, blocoIndexado: bloco, cursor, elementos: achado.lista.length, erroDeSchema };
}

/** Os nomes das chaves, ordenados e com teto. NOMES, nunca valores. */
function chavesDe(o: Record<string, unknown>, teto = 25): string {
    const ks = Object.keys(o).sort();
    return ks.slice(0, teto).join(', ') + (ks.length > teto ? `, …+${ks.length - teto}` : '');
}

/**
 * Por que ESTE item nao virou mercado, campo por campo.
 *
 * E o que transforma "zero mercados" em causa acionavel. Publica o NOME do
 * campo que faltou e as chaves que o item tinha — nunca os valores, que podem
 * carregar o que nao deve entrar em log.
 */
export function porQueNaoDecodificou(cru: unknown): string {
    if (typeof cru !== 'object' || cru === null) {
        return `o primeiro elemento não é objeto: é ${typeof cru}`;
    }
    const o = cru as Record<string, unknown>;
    const params = (typeof o.params === 'object' && o.params !== null
        ? o.params as Record<string, unknown> : o);
    const faltando: string[] = [];
    const id = texto(o.id ?? o.uniqueKey ?? o.unique_key ?? o.market_id ?? o.marketId);
    if (id === null) faltando.push('id/market_id (ausente)');
    else if (!/^0x[0-9a-fA-F]{64}$/.test(id)) faltando.push('id/market_id (não é 32 bytes hex)');
    if (endereco(params.loanAsset ?? params.loan_token ?? params.loanToken) === null) {
        faltando.push('loan_token');
    }
    if (endereco(params.collateralAsset ?? params.collateral_token
        ?? params.collateralToken) === null) {
        faltando.push('collateral_token');
    }
    if (endereco(params.oracle ?? params.oracle_address ?? params.oracleAddress) === null) {
        faltando.push('oracle_address');
    }
    if (endereco(params.irm ?? params.irm_address ?? params.irmAddress) === null) {
        faltando.push('irm_address');
    }
    if (lerLltv(params.lltv ?? params.lltv_wad ?? params.lltvWad) === null) {
        faltando.push('lltv/lltv_wad');
    }
    return `campos que eu não achei: [${faltando.join(', ')}]. `
        + `Chaves que o elemento TEM: [${chavesDe(o)}]`
        + (params !== o ? ` | dentro de params: [${chavesDe(params)}]` : '');
}

/**
 * O CURSOR opaco da proxima pagina.
 *
 * Ela corrigiu isto: o contrato REST pagina por `cursor`, nao por `offset`.
 * Aceita os lugares plausiveis porque eu nao pude conferir o corpo real, e
 * devolve `null` quando nao ha — e `null` encerra a paginacao, que e o unico
 * criterio seguro quando nao se sabe o formato.
 */
/**
 * O CHAIN ID do proprio item. `null` quando a API nao informa.
 *
 * `null` NAO e descarte: a maioria das respostas filtradas por `chain_id` nao
 * repete o campo em cada item, e exigi-lo jogaria fora todos os mercados.
 * Quem descarta e `soDaBase`, e so quando o campo existe e e OUTRA rede.
 */
export function lerChain(
    o: Record<string, unknown>, params: Record<string, unknown>,
): number | null {
    for (const fonte of [o, params]) {
        for (const chave of ['chain_id', 'chainId']) {
            const v = fonte[chave];
            if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
            if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number.parseInt(v, 10);
        }
        const c = fonte.chain;
        if (typeof c === 'object' && c !== null) {
            const n = (c as Record<string, unknown>).id;
            if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
            if (typeof n === 'string' && /^\d+$/.test(n.trim())) return Number.parseInt(n, 10);
        }
    }
    return null;
}

/**
 * So os mercados da BASE.
 *
 * Dois baldes, e e de proposito: `null` de chain NAO vai para fora. Ela pediu
 * *"Valide a Base, chain ID 8453"* e tambem *"Não descarte mercados por erro
 * de conversão numérica"* — entao desconhecido conta como candidato, e a
 * contagem de descartados por chain sai separada para o log poder dizer que a
 * API ignorou o filtro.
 */
export function soDaBase(ms: MercadoDaApi[]): {
    daBase: MercadoDaApi[]; deOutraChain: number; semChain: number;
} {
    const daBase: MercadoDaApi[] = [];
    let deOutraChain = 0;
    let semChain = 0;
    for (const m of ms) {
        if (m.chainId === null) { semChain += 1; daBase.push(m); continue; }
        if (m.chainId === CHAIN_ID_DA_BASE) { daBase.push(m); continue; }
        deOutraChain += 1;
    }
    return { daBase, deOutraChain, semChain };
}

export function lerCursor(
    o: Record<string, unknown>,
    dentroDeData: Record<string, unknown> | null,
): string | null {
    const candidatos: unknown[] = [];
    for (const fonte of [o, dentroDeData, o.pagination, o.page, o.meta,
        dentroDeData?.pagination, dentroDeData?.page]) {
        if (typeof fonte !== 'object' || fonte === null) continue;
        const f = fonte as Record<string, unknown>;
        candidatos.push(f.next_cursor, f.nextCursor, f.cursor, f.next);
    }
    for (const c of candidatos) {
        if (typeof c === 'string' && c.trim() !== '') return c.trim();
    }
    return null;
}

function lerBloco(o: Record<string, unknown>): number | null {
    for (const chave of ['indexed_block', 'indexedBlock', 'block', 'blockNumber']) {
        const v = o[chave];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
        if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
    }
    return null;
}

/**
 * Um mercado da API, ou `null` quando falta campo essencial.
 *
 * ACEITA OS DOIS CONTRATOS: os nomes do REST documentado (`market_id`,
 * `lltv_wad`, `oracle_address`, `irm_address`, `loan_token`,
 * `collateral_token`) e os do GraphQL (`uniqueKey`, `lltv`, `oracle`, `irm`,
 * `loanAsset`, `collateralAsset`).
 *
 * Os nomes REST entram por CITACAO da dona do bot, declarada: eu nao pude
 * conferir contra o servico nem contra a documentacao — os dois respondem 403
 * CONNECT neste sandbox. Aceitar mais nomes nao quebra a forma que ja
 * funcionava, e o que fecha o diagnostico quando eu errar e o `erroDeSchema`
 * da pagina, que nomeia as chaves recebidas.
 *
 * O que NAO e tolerado continua nao sendo: campo essencial ausente devolve
 * `null`, nunca um padrao. Supor um LLTV seria inventar o premio, porque o
 * incentivo e funcao dele.
 */
export function lerUmMercado(cru: unknown): MercadoDaApi | null {
    if (typeof cru !== 'object' || cru === null) return null;
    const o = cru as Record<string, unknown>;
    const id = texto(o.id ?? o.uniqueKey ?? o.unique_key ?? o.market_id ?? o.marketId);
    if (id === null || !/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
    const params = (typeof o.params === 'object' && o.params !== null
        ? o.params as Record<string, unknown> : o);
    const loan = endereco(params.loanAsset ?? params.loan_token ?? params.loanToken);
    const col = endereco(params.collateralAsset ?? params.collateral_token ?? params.collateralToken);
    const oracle = endereco(params.oracle ?? params.oracle_address ?? params.oracleAddress);
    const irm = endereco(params.irm ?? params.irm_address ?? params.irmAddress);
    const lltv = lerLltv(params.lltv ?? params.lltv_wad ?? params.lltvWad);
    // SEM LLTV NAO HA MERCADO UTIL: o incentivo e funcao dele, e supor um valor
    // seria inventar o premio. Igual para os enderecos.
    if (loan === null || col === null || oracle === null || irm === null || lltv === null) return null;
    return {
        id: id.toLowerCase(),
        loanToken: loan, collateralToken: col, oracle, irm,
        lltv, bonusPct: bonusPct(lltv),
        blocoDaCriacao: 0,
        // A CHAIN do proprio item, quando ela vem. Filtrar por ela e diferente
        // de confiar no parametro da URL: a API pode ignorar o filtro, e um
        // mercado de outra rede validado contra a Base daria divergencia que
        // leria como "mercado recusado" em vez de "mercado de outra chain".
        chainId: lerChain(o, params),
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

/**
 * Universo para TRIAGEM, nao para envio. O corte de 77% mede onde o bonus
 * teorico supera o caso Aave de referencia, NAO se a liquidacao pode
 * pagar gas. O proprio censo real encontrou bonus positivo em LLTV
 * 86%, 91,5%, 94,5% e 96,5%. Excluir esses mercados impedia a validacao
 * onchain de posicoes grandes que podem ser economicamente interessantes.
 *
 * Nao autoriza transacao: nem a API nem o incentivo teorico provam HF<1,
 * saldo, liquidez de swap ou lucro apos gas. O portao economico continua
 * dentro da simulacao atomica do executor.
 */
export function mercadosParaSondagem(ms: readonly MercadoDaApi[]): MercadoDaApi[] {
    return ms.filter(m=>m.lltv.isFinite()&&m.lltv.gt(0)&&m.lltv.lt(1)
        &&m.bonusPct!==null&&m.bonusPct.isFinite()&&m.bonusPct.gt(0));
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

/** Full market struct for bounded interest-accrual hints. The legacy
 * lerMarket contract stays backward-compatible for the other callers.
 */
export function lerMarketComTempo(dados:string):
 ((NonNullable<ReturnType<typeof lerMarket>>)&{lastUpdate:bigint;fee:bigint})|null{
 const base=lerMarket(dados);
 if(!base)return null;
 try{
   const decoded=coder.decode(
     ['uint128','uint128','uint128','uint128','uint128','uint128'],dados,
   ) as unknown as bigint[];
   return {...base,lastUpdate:decoded[4]!,fee:decoded[5]!};
 }catch{return null;}
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

/** Global health-factor feed from the Morpho API. This is only an
 * over-inclusive discovery hint; every market and borrower is rechecked onchain
 * before any paid transaction. The API does not authorize execution.
 * Based on the public Morpho Blue bot's marketPositions schema.
 */
export type CandidatoGlobalMorpho={mercado:string;usuario:string;healthFactor?:number};
export function consultaRiscoGlobalMorpho(skip=0):string{
 // Collect index hints on both sides of the liquidation boundary.
 // Client-side ranking below favors liquidatable debt *near* HF 1,
 // then nearly liquidatable debt, ahead of deep insolvent bad debt.
 // All of these are hints, never permission to transact.
 if(!Number.isSafeInteger(skip)||skip<0||skip>1_000_000)
   throw Error('offset do feed de risco Morpho invalido');
 return JSON.stringify({
   query:`query RiskOnBase($chainIds:[Int!],$hfLte:Float!,$first:Int!,$skip:Int!){
     marketPositions(
       where:{chainId_in:$chainIds,healthFactor_lte:$hfLte,marketListed:true}
       orderBy:HealthFactor,orderDirection:Desc,first:$first,skip:$skip
     ){pageInfo{count countTotal}items{healthFactor market{marketId}user{address}}}
   }`,
   variables:{chainIds:[8453],hfLte:1.02,first:1000,skip},
 });
}
export function lerRiscoGlobalMorpho(corpo:unknown):
 {candidatos:CandidatoGlobalMorpho[];total:number|null}|null {
 if(!corpo||typeof corpo!=='object')return null;
 const o=corpo as Record<string,unknown>;
 if(Array.isArray(o.errors)&&o.errors.length)return null;
 const data=o.data as Record<string,unknown>|undefined;
 const mp=data?.marketPositions as Record<string,unknown>|undefined;
 if(!Array.isArray(mp?.items))return null;
 const info=mp.pageInfo as Record<string,unknown>|undefined;
 if(info&&typeof info.count==='number'&&info.count!==mp.items.length)return null;
 const seen=new Set<string>(),candidatos:CandidatoGlobalMorpho[]=[];
 for(const raw of mp.items.slice(0,1000)){
   if(!raw||typeof raw!=='object')continue;
   const item=raw as Record<string,unknown>;
   const mercado=(item.market as Record<string,unknown>|undefined)?.marketId;
   const usuario=(item.user as Record<string,unknown>|undefined)?.address;
   if(typeof mercado!=='string'||!/^0x[0-9a-f]{64}$/i.test(mercado)
     ||typeof usuario!=='string'||!/^0x[0-9a-f]{40}$/i.test(usuario))continue;
   const key=mercado.toLowerCase()+'|'+usuario.toLowerCase();
   if(seen.has(key))continue;
   seen.add(key);
   const rawHf=item.healthFactor;
   const hf=typeof rawHf==='number'?rawHf:
     typeof rawHf==='string'&&rawHf.trim()!==''?Number(rawHf):NaN;
   candidatos.push({mercado:mercado.toLowerCase(),usuario:usuario.toLowerCase(),
     ...(Number.isFinite(hf)&&hf>=0&&hf<=1.02?{healthFactor:hf}:{})});
 }
 // Rank by absolute distance to the liquidation line, not merely HF
 // ascending/descending. Deep bad debt must not outrank a borrower at 1.0001.
 // At equal distance, a currently below-line borrower is tested first.
 // Stable ties retain the API order. Unknown HF remains last.
 candidatos.sort((a,b)=>{
   if(a.healthFactor===undefined)return b.healthFactor===undefined?0:1;
   if(b.healthFactor===undefined)return -1;
   const da=Math.abs(1-a.healthFactor),db=Math.abs(1-b.healthFactor);
   return da!==db?da-db:Number(a.healthFactor>1)-Number(b.healthFactor>1);
 });
 return{candidatos,total:typeof info?.countTotal==='number'?info.countTotal:null};
}

// ---------------------------------------------------------------------------
// OS DEVEDORES, por GraphQL.
// ---------------------------------------------------------------------------

/** A consulta. `first`/`skip` porque e o que a API documenta para paginar. */
/**
 * O GraphQL documenta a ordenação por BorrowAssetsUsd para ordenar
 * os mercados da Base que têm empréstimos relevantes. Só PRIORIZA
 * o trabalho; jamais substitui a validação dos parâmetros onchain.
 */
export function consultaMercadosMorphoComDivida():string {
    return JSON.stringify({
        query: `query {
            markets(first: 100, orderBy: BorrowAssetsUsd, orderDirection: Desc,
              where: { chainId_in: [8453] }) {
                items { marketId }
            }
        }`,
    });
}
export function lerRankingMercadosMorpho(corpo:unknown):string[]|null {
    if(!corpo||typeof corpo!=='object')return null;
    const o=corpo as Record<string,unknown>;
    if(Array.isArray(o.errors)&&o.errors.length>0)return null;
    const data=o.data as Record<string,unknown>|undefined;
    const markets=data?.markets as Record<string,unknown>|undefined;
    if(!Array.isArray(markets?.items))return null;
    const vistos=new Set<string>();
    for(const raw of markets.items) {
        if(!raw||typeof raw!=='object')continue;
        const marketId=(raw as Record<string,unknown>).marketId;
        if(typeof marketId!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(marketId))continue;
        vistos.add(marketId.toLowerCase());
    }
    return [...vistos];
}
/** Cobre dezenas de posições na fila em vez de sempre os primeiros 12
 * mercados descobertos. O ranking ajuda, mas não concede autorização.
 */
/**
 * Seleciona ate `quantidade` mercados; 1/3 de alta divida sao fixos,
 * 2/3 circulam no universo restante a cada rodada. Sem esta rotacao, a
 * descoberta confirmava os MESMOS 24 mercados para sempre e 1.300+
 * mercados elegiveis nao chegavam ao eth_call. Isso ainda NAO e sinal de
 * liquidacao: ranking apenas altera prioridade de validacao.
 *
 * `rodada=0` conserva a ordem de preferencia inicial e serve aos testes.
 * Em producao o numero de rodada vem do relogio UTC dividido em fatias;
 * a rotacao nunca ultrapassa o numero de validacoes no RPC.
 */
export function priorizarMercadosDaLista(
    elegiveis:readonly MercadoDaApi[],ranking:readonly string[]|null,
    quantidade:number,rodada=0,
):MercadoDaApi[] {
    if(!Number.isSafeInteger(quantidade)||quantidade<=0
       ||!Number.isSafeInteger(rodada)||rodada<0)return[];
    const disponiveis=new Map(elegiveis.map(m=>[m.id.toLowerCase(),m]));
    const ordenar:MercadoDaApi[]=[];
    for(const id of ranking??[]) {
        const m=disponiveis.get(id.toLowerCase());
        if(!m)continue;
        ordenar.push(m);disponiveis.delete(id.toLowerCase());
    }
    // Mantem um grupo fixo para as posicoes com mais divida, se houver
    // ranking confiavel. Sem ranking distribui a busca por TODO o universo.
    const fixos=ranking===null?0:Math.min(
        Math.floor(quantidade/3),ordenar.length);
    const selecao=ordenar.slice(0,fixos);
    const restantes=[...ordenar.slice(fixos),...disponiveis.values()];
    const vagas=Math.min(quantidade-selecao.length,restantes.length);
    if(vagas===0)return selecao;
    // Mantem a amostragem DISTRIBUIDA usada antes da rotacao. A rodada
    // altera o indice dentro de cada segmento, evitando que os mesmos
    // 16 ids monopolizem a capacidade entre ciclos.
    for(let i=0;i<vagas;i++){
        const inicio=Math.floor(i*restantes.length/vagas);
        const fim=Math.floor((i+1)*restantes.length/vagas);
        const largura=Math.max(1,fim-inicio);
        const indice=inicio+((rodada+Math.floor(largura/2))%largura);
        selecao.push(restantes[indice]!);
    }
    return selecao;
}
/** Entre mercados confirmados, preserva os de maior divida e visita
 * mercados diferentes a cada rodada. Nunca aumenta a cota HTTP/RPC.
 */
export function selecionarMercadosParaDevedores<T>(
    mercados: readonly T[],quantidade:number,rodada:number,
):T[]{
    if(!Number.isSafeInteger(quantidade)||quantidade<=0
       ||!Number.isSafeInteger(rodada)||rodada<0)return [];
    if(mercados.length<=quantidade)return [...mercados];
    const fixos=Math.max(1,Math.floor(quantidade/2));
    const resultado=mercados.slice(0,fixos);
    const outros=mercados.slice(fixos);
    const vagas=quantidade-fixos;
    const indices=new Set<number>();
    for(let i=0;i<vagas;i++){
        const inicio=Math.floor(i*outros.length/vagas);
        const fim=Math.floor((i+1)*outros.length/vagas);
        const largura=Math.max(1,fim-inicio);
        const idx=inicio+(rodada%largura);
        indices.add(idx);
    }
    for(const idx of indices)resultado.push(outros[idx]!);
    return resultado;
}

/** Mantem maiores devedores e alterna os demais, sem confiar em API para tiro. */
export function selecionarDevedoresParaConferir<T>(
    devedores:readonly T[],limite:number,rodada:number,
):T[]{
    return selecionarMercadosParaDevedores(devedores,limite,rodada);
}

/**
 * Prioriza quem esta perto de LLTV (somente DADO API para ordenacao).
 * O scanner onchain CONTINUA conferindo shares, colateral e oracle no mesmo
 * bloco. Uma classificacao API errada nunca autoriza um tiro.
 *
 * Preserva metade da capacidade para a ordem rotativa original: pequenos
 * devedores e posicoes sem valor USD ainda entram no scanner.
 */
export function selecionarDevedoresPorRisco(
    devedores:readonly DevedorDaApi[],lltv:Decimal,limite:number,rodada:number,
):DevedorDaApi[]{
    if(!Number.isSafeInteger(limite)||limite<=0
      ||!Number.isSafeInteger(rodada)||rodada<0)return [];
    if(devedores.length<=limite)return [...devedores];
    const medidos=devedores.map(d=>{
        let hf:Decimal|null=null;
        try{
            if(d.borrowAssetsUsd!==null&&d.collateralUsd!==null){
                const debt=new Decimal(d.borrowAssetsUsd);
                const col=new Decimal(d.collateralUsd);
                if(debt.isFinite()&&col.isFinite()&&debt.gt(0)&&col.gte(0)&&lltv.gt(0))
                    hf=col.mul(lltv).div(debt);
            }
        }catch{hf=null}
        return{d,hf};
    }).filter(x=>x.hf!==null);
    if(medidos.length===0)return selecionarDevedoresParaConferir(devedores,limite,rodada);
    medidos.sort((a,b)=>a.hf!.cmp(b.hf!));
    const metade=Math.ceil(limite/2);
    const prioritarios=medidos.slice(0,metade).map(x=>x.d);
    const excluidos=new Set(prioritarios.map(x=>x.endereco.toLowerCase()));
    const demais=devedores.filter(x=>!excluidos.has(x.endereco.toLowerCase()));
    const rotativos=selecionarDevedoresParaConferir(demais,limite-prioritarios.length,rodada);
    return [...prioritarios,...rotativos];
}
export function consultaDeDevedores(idDoMercado: string, primeiros: number, pular: number): string {
    return JSON.stringify({
        query: `query($id: String!, $first: Int!, $skip: Int!) {
  marketPositions(where: { marketUniqueKey_in: [$id] }, first: $first, skip: $skip, orderBy: BorrowShares, orderDirection: Desc) {
    items { user { address } state { borrowShares collateral borrowAssetsUsd collateralUsd } }
  }
}`,
        variables: { id: idDoMercado, first: primeiros, skip: pular },
    });
}

export interface DevedorDaApi {
    endereco: string;
    /** As shares que a API diz. CONFERENCIA, nunca fonte para decidir. */
    borrowSharesDaApi: bigint | null;
    /** Valores USD da API so para priorizar risco; jamais decidem liquidação. */
    borrowAssetsUsd: string | null;
    collateralUsd: string | null;
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
        const usd=(v:unknown):string|null=>{
            if(typeof v!=='string'&&typeof v!=='number')return null;
            try{
                const n=new Decimal(v);
                return n.isFinite()&&n.gte(0)?n.toString():null;
            }catch{return null}
        };
        fora.push({ endereco: end, borrowSharesDaApi: shares,
            borrowAssetsUsd:usd(estado?.borrowAssetsUsd),
            collateralUsd:usd(estado?.collateralUsd) });
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
        inicio?: number; orcamento?: OrcamentoHttp; signal?: AbortSignal;
        dormir?: (ms: number) => Promise<void> } = {},
): Promise<{ devedores: DevedorDaApi[]; requisicoes: number; falha: string | null;
    completa: boolean; proximo: number }> {
    const url = opcoes.url ?? 'https://api.morpho.org/graphql';
    const porPagina = Math.max(1, Math.min(opcoes.porPagina ?? POR_PAGINA, POR_PAGINA));
    const teto = Math.max(0, opcoes.tetoDePaginas ?? TETO_DE_PAGINAS);
    const dormir = opcoes.dormir ?? ((ms: number) => new Promise<void>(r => setTimeout(r,ms)));
    const devedores: DevedorDaApi[] = [];
    const vistos = new Set<string>();
    let proximo = Number.isSafeInteger(opcoes.inicio) && opcoes.inicio! >= 0 ? opcoes.inicio! : 0;
    const inicio = proximo;
    let requisicoes = 0;
    const parcial = (falha: string | null, completa = false) =>
        ({devedores,requisicoes,falha,completa,proximo});
    const signal = opcoes.signal ?? opcoes.orcamento?.sinal;
    for (let pagina=0; pagina<teto; pagina++) {
        if(signal?.aborted || (opcoes.orcamento && !opcoes.orcamento.pedir()))
            return parcial('orcamento ou cancelamento encerrou paginas de devedores');
        requisicoes++;
        let corpo: unknown;
        try {
            const r=await buscar(url,{method:'POST',
                headers:{'Content-Type':'application/json',Accept:'application/json'},
                body:consultaDeDevedores(idDoMercado,porPagina,proximo),signal});
            if(r.status!==200)return parcial(`o GraphQL respondeu HTTP ${r.status}`);
            corpo=JSON.parse(await r.text());
        } catch(e) { return parcial(`o transporte/JSON falhou: ${sanitizar(String(e))}`); }
        if(signal?.aborted)return parcial('cancelado antes de aceitar pagina');
        const envelope=corpo as {data?:{marketPositions?:{items?:unknown}};errors?:unknown[]}|null;
        const itens=envelope?.data?.marketPositions?.items;
        if(!Array.isArray(itens)||envelope?.errors?.length)
            return parcial('GraphQL HTTP 200 sem marketPositions.items valido ou com errors');
        const lidos=lerDevedores(corpo);
        let novos=0;
        for(const d of lidos)if(!vistos.has(d.endereco)){
            vistos.add(d.endereco);devedores.push(d);novos++;
        }
        if(itens.length<porPagina){
            proximo=0;
            // Completion means a full pass, not just reaching the end from a cursor.
            return parcial(null,inicio===0);
        }
        if(novos===0)return parcial('pagina repetida ou sem enderecos validos; cursor conservado');
        proximo+=itens.length;
        if(pagina+1<teto)await dormir(ENTRE_PAGINAS_MS);
    }
    return parcial(`paginacao parcial: teto de ${teto} paginas; retomar em ${proximo}`);
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
    /** Próxima página REST; null quando atingiu o fim da enumeração. */
    proximoCursor?: string | null;
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
    proximoCursor: string | null = null,
): CacheDeMercados {
    return {
        versao: VERSAO_DO_CACHE_MORPHO, gravadoEm: agora, blocoIndexado, completo,
        proximoCursor,
        mercados: ms.map((m) => ({
            id: m.id, loanToken: m.loanToken, collateralToken: m.collateralToken,
            oracle: m.oracle, irm: m.irm, lltv: m.lltv.toString(),
            confirmadoNaCorrente: m.confirmadoNaCorrente,
        })),
    };
}

/** Cursor durável apenas de cache com versão conhecida; nunca confiar em string arbitrária. */
export function cursorDeCache(x: unknown): string | null {
    if (!x || typeof x !== 'object') return null;
    const c = x as Record<string, unknown>;
    const v = c.proximoCursor;
    return c.versao === VERSAO_DO_CACHE_MORPHO && typeof v === 'string'
        && v.length > 0 && v.length <= 2048 ? v : null;
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
    tentou?: boolean;
    statusHttp?: number[];
    desfecho?: DesfechoDaDescoberta;
    naoConfirmadosGuardados?: number;
    porqueNaoValidou?: string | null;
    /** Quantos ELEMENTOS a API mandou, antes de eu decodificar. */
    elementosRecebidos?: number;
    /** O erro de contrato, quando 200 nao decodificou. */
    erroDeSchema?: string | null;
    /** Descartados por serem de OUTRA chain. */
    deOutraChain?: number;
    /** Paginou pelo cursor do contrato REST. */
    paginouPorCursor?: boolean;
    /** O estado do RPC e o motivo de recusa, em uma frase. */
    estadoDoRpc?: string | null;
}): string {
    const partes = [
        e.desfecho === undefined ? 'desfecho NÃO REGISTRADO' : comoLerODesfecho(e.desfecho),
        e.tentou === undefined
            ? 'requisição HTTP: DESCONHECIDO (campo não registrado)'
            : e.tentou
                ? `requisição HTTP INICIADA, status ${
                    (e.statusHttp ?? []).length === 0
                        ? 'NENHUM (o transporte lançou antes da resposta)'
                        : (e.statusHttp ?? []).join(', ')}`
                : 'NENHUMA requisição HTTP saiu',
        // AS ETAPAS SEPARADAS, e e isto que o log de 2026-10-14 nao tinha:
        // "recebidos" e "decodificados" eram o mesmo numero, entao um erro de
        // contrato era indistinguivel de uma lista vazia.
        e.elementosRecebidos === undefined
            ? `${e.devolvidos} mercado(s) decodificados (recebidos: NÃO REGISTRADO)`
            : `${e.elementosRecebidos} elemento(s) RECEBIDOS da API, `
                + `${e.devolvidos} DECODIFICADOS`,
        `${e.mercados} na lista de trabalho`
            + (e.deOutraChain === undefined || e.deOutraChain === 0
                ? ''
                : ` (${e.deOutraChain} descartado(s) por serem de OUTRA chain)`),
        `${e.quePagam} com LLTV ≤ 77%`,
        `${e.confirmados} CONFIRMADOS na corrente`,
        `${e.devedores} devedor(es) apontado(s), ${e.validados} validado(s) por eth_call`,
        `${e.requisicoes} requisição(ões)`
            + (e.paginouPorCursor === true ? ', paginado por CURSOR' : ''),
        idadeDoIndice(e.blocoIndexado, e.blocoAgora),
    ];
    // O ERRO DE CONTRATO vem ANTES da cobertura: ele explica o zero, e sem ele
    // a linha seguinte seria lida como "a Base não tem mercados Morpho".
    if (e.erroDeSchema !== undefined && e.erroDeSchema !== null) {
        partes.push(`ERRO DE CONTRATO: ${e.erroDeSchema}`);
    }
    if (!e.tentou) {
        partes.push('COBERTURA INDETERMINADA: nenhuma requisição saiu, então eu não sei quantos '
            + 'mercados existem — e isto NÃO é zero');
    } else if (e.erroDeSchema !== undefined && e.erroDeSchema !== null) {
        // 200 que nao decodificou NAO e cobertura de nada.
        partes.push('COBERTURA INDETERMINADA: a resposta veio e eu não a entendi, então o número '
            + 'de mercados da Base continua DESCONHECIDO');
    } else if (!e.completa) {
        partes.push('COBERTURA PARCIAL: a paginação não terminou, então este número é PISO, '
            + 'não total');
    } else {
        partes.push('COBERTURA COMPLETA da enumeração: a paginação terminou');
    }
    if (e.falha !== null && e.falha !== e.erroDeSchema) partes.push(`falha: ${e.falha}`);
    if (e.estadoDoRpc !== undefined && e.estadoDoRpc !== null) {
        partes.push(`RPC: ${e.estadoDoRpc}`);
    }
    if (e.confirmados < e.quePagam) {
        partes.push(`${e.quePagam - e.confirmados} mercado(s) que pagam NÃO foram confirmados: `
            + 'eles não entram em decisão nenhuma'
            + (e.porqueNaoValidou ? ` — ${e.porqueNaoValidou}` : ''));
    }
    if (e.naoConfirmadosGuardados !== undefined && e.naoConfirmadosGuardados > 0) {
        partes.push(`${e.naoConfirmadosGuardados} guardado(s) como NÃO CONFIRMADOS para validar na `
            + 'próxima volta: a enumeração não se perde quando o RPC cai');
    }
    return partes.join(' | ');
}
