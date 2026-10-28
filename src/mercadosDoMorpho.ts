import {abrirSnapshotMorpho} from './morphoDescobertaRpc';
import {CursoresMorpho} from './morphoCursores';
import {rotasMorphoHabilitadas} from './titanMorphoDiretorDeRota';
// Arquivo: src/mercadosDoMorpho.ts
//
// OS MERCADOS DO MORPHO BLUE DE LLTV BAIXO — a lista que decide se vale a obra.
//
// POR QUE ESTA FERRAMENTA EXISTE, e por que ela e ferramenta e nao script
// descartavel: a decisao sobre o Morpho depende de UMA lista que eu nao consigo
// produzir daqui. O censo deste projeto mediu que o incentivo do Morpho e uma
// funcao do LLTV — 12,68% a 62,5% contra 1,06% a 96,5% — e que os mercados de
// LLTV <= 77% sao o grupo que paga. Mas QUAIS sao eles, e se ha posicao perto de
// liquidar, so se sabe varrendo os eventos `CreateMarket`.
//
// E o `eth_getLogs` do RPC publico recusou 23 de 24 janelas em 2026-10-09
// (cobertura 4,2%, zero eventos). O log de producao dela, no mesmo dia, diz
// `rpc: base-mainnet.g.alchemy.com`: **o eth_getLogs que me bloqueia aqui
// funciona la.** Entao a ferramenta roda onde o RPC responde, em vez de eu
// esperar por um acesso.
//
// O QUE ELA NAO FAZ: nao manda transacao, nao gasta nada, nao precisa de chave
// privada. E leitura.
//
// COMO RODAR:
//     RPC_URL='https://base-mainnet.g.alchemy.com/v2/SUA_CHAVE' npx tsx src/mercadosDoMorpho.ts
//
// (a chave fica na variavel de ambiente; ela nao vai para log nenhum — o unico
// lugar onde o endereco do RPC aparece e o host, sem o caminho.)
import { Decimal } from 'decimal.js';
import { examinarSaudeMorpho,precisaPreflightIntegralMorpho } from './titanMorphoRadar';
import { id, AbiCoder } from 'ethers';
import { MULTICALL3, codificarAggregate3, decodificarAggregate3Rapido } from './multicall';
import { ProxyAgent, fetch } from 'undici';
import { createLogger } from './logger';
import { faixasDeBlocos, RPCS_PARA_TENTAR } from './liquidacoes';
import { listaDeRpcs } from './escadaDeRpc';
import { tamanhosASondar, PEDACO_MINIMO } from './cacarAoVivo';
import { incentivoDeLiquidacao, bonusPct, saudeNoMorpho, ESCALA_DO_ORACULO } from './morpho';

const log = createLogger('morpho');
const coder = AbiCoder.defaultAbiCoder();
const sel = (a: string) => id(a).slice(0, 10);
const MP = '(address,address,address,address,uint256)';

/**
 * A SUPERFICIE do Morpho Blue — e e por ela que o contrato se identifica.
 *
 * O endereco NAO e escrito de cabeca aqui: ele entra como candidato e a corrente
 * decide. Um contrato que tem estes dez seletores no bytecode e responde a
 * `owner()` nao e outra coisa. Foi assim que ele foi identificado em
 * 2026-10-09, depois de o `eth_getLogs` recusar a varredura por evento e de a
 * busca pelos contratos mais chamados nao o achar em 40 blocos.
 *
 * O defeito que isto evita esta na REGRA 0 deste projeto: o `0x80d1e0f4...` que
 * eu escrevi de cabeca e publiquei sem conferir.
 */
export const SELETORES_DO_MORPHO: Record<string, string> = {
    'market(bytes32)': sel('market(bytes32)'),
    'position(bytes32,address)': sel('position(bytes32,address)'),
    'idToMarketParams(bytes32)': sel('idToMarketParams(bytes32)'),
    [`liquidate(${MP},address,uint256,uint256,bytes)`]: sel(`liquidate(${MP},address,uint256,uint256,bytes)`),
    [`supply(${MP},uint256,uint256,address,bytes)`]: sel(`supply(${MP},uint256,uint256,address,bytes)`),
    [`borrow(${MP},uint256,uint256,address,address)`]: sel(`borrow(${MP},uint256,uint256,address,address)`),
    [`createMarket(${MP})`]: sel(`createMarket(${MP})`),
    'DOMAIN_SEPARATOR()': sel('DOMAIN_SEPARATOR()'),
    'owner()': sel('owner()'),
    'isLltvEnabled(uint256)': sel('isLltvEnabled(uint256)'),
};

/** O seletor do callback que o `CacadorMorpho` implementa. */
export const SELETOR_DO_CALLBACK = sel('onMorphoLiquidate(uint256,bytes)');

/** `CreateMarket(bytes32 indexed id, MarketParams marketParams)`. */
export const TOPICO_CREATE_MARKET = id(`CreateMarket(bytes32,${MP})`);

/**
 * O veredicto de identidade. `null` quando o candidato NAO e o Morpho — e
 * dizer "nao e" e melhor que seguir com um endereco so porque ele tem codigo.
 */
export function julgarMorpho(codigo: string): { eh: boolean; faltando: string[]; temCallback: boolean } {
    if (!codigo || codigo === '0x') return { eh: false, faltando: Object.keys(SELETORES_DO_MORPHO), temCallback: false };
    const faltando = Object.entries(SELETORES_DO_MORPHO)
        .filter(([, s]) => !codigo.includes(s.slice(2)))
        .map(([k]) => k);
    return {
        eh: faltando.length === 0,
        faltando,
        temCallback: codigo.includes(SELETOR_DO_CALLBACK.slice(2)),
    };
}

/**
 * A FAIXA DE LLTV QUE PAGA, medida pelo censo de 10 dias deste projeto.
 *
 * Nao e escolha: `incentivoDeLiquidacao` devolve 7,41% a 77% e 4,38% a 86%, e o
 * alvo real da Aave de 2026-10-07 rendeu 4,56% de bonus. Ou seja, acima de 77%
 * o Morpho paga o MESMO que a Aave — e aí nao ha razao para a obra.
 */
import {
    enumerarMercados, enumerarDevedores, soOsQuePagam, mercadosParaSondagem, soDaBase, codificarIdToMarketParams,
    consultaMercadosMorphoComDivida,lerRankingMercadosMorpho,consultaRiscoGlobalMorpho,lerRiscoGlobalMorpho,
    selecionarDevedoresPorRisco,
    codificarPosition, codificarMarket, lerMarket, lerIdToMarketParams, lerPosition, apiConfereComACorrente,
    paraCache, doCache, cursorDeCache, comoLerADescoberta, type MercadoDaApi, type TransporteHttp,
} from './morphoApi';
import {
    disponibilidadeDoCanal, comoLerOsCanais, OrcamentoHttp,
    type EstadoDaInfra, type DesfechoDaDescoberta,
} from './canais';
import {
    lerMemoria, juntar, nomeTemporario, resumoCurto as resumoDaDescoberta,
    VERSAO_DA_MEMORIA, type MemoriaDaDescoberta, type RegistroDaDescoberta,
} from './memoriaDaDescoberta';

/** Retry an individual malformed/failed Multicall3 result on the SAME pinned
 * block. Never retry a valid onchain zero-debt position: that is evidence,
 * not an infrastructure failure. Caller must bound total direct RPC retries.
 */
export async function lerPosicaoMorphoComFallback(
    resposta:{ok:boolean;dados:string}|undefined,
    direto:()=>Promise<string|null>,
    permitirDireto:boolean,
):Promise<{posicao:ReturnType<typeof lerPosition>;tentouDireto:boolean}>{
    const posicao=resposta?.ok?lerPosition(resposta.dados):null;
    if(posicao!==null||!permitirDireto)return{posicao,tentouDireto:false};
    const cru=await direto();
    return{posicao:cru===null?null:lerPosition(cru),tentouDireto:true};
}

export const LLTV_MAXIMO_QUE_PAGA = new Decimal('0.77');

export interface MercadoDoMorpho {
    id: string;
    loanToken: string;
    collateralToken: string;
    oracle: string;
    irm: string;
    lltv: Decimal;
    bonusPct: Decimal | null;
    blocoDaCriacao: number;
}

/** Le os `CreateMarket` de uma faixa e devolve os mercados. */
export function lerCreateMarket(logs: Array<{ topics: string[]; data: string; blockNumber: string }>): MercadoDoMorpho[] {
    const fora: MercadoDoMorpho[] = [];
    for (const l of logs) {
        try {
            const [p] = coder.decode([MP], l.data) as unknown as [[string, string, string, string, bigint]];
            const lltv = new Decimal(p[4].toString()).dividedBy(1e18);
            fora.push({
                id: l.topics[1]!,
                loanToken: p[0].toLowerCase(),
                collateralToken: p[1].toLowerCase(),
                oracle: p[2].toLowerCase(),
                irm: p[3].toLowerCase(),
                lltv,
                bonusPct: bonusPct(lltv),
                blocoDaCriacao: Number.parseInt(l.blockNumber, 16),
            });
        } catch {
            // Evento que nao decodifica nao vira mercado inventado: ele e
            // CONTADO como nao lido pela cobertura e some. Ausencia declarada.
        }
    }
    return fora;
}

export async function varrerMercadosDoMorpho(): Promise<void> {
    /**
     * O RPC SAI DA MESMA ESCADA QUE O BOT USA, e nao de uma variavel nova.
     *
     * A primeira versao desta ferramenta pedia `RPC_URL`. Isso era eu pedindo a
     * ela que configurasse de novo um acesso que o bot JA TEM: o caçador le
     * `CACA_RPC_URL`, `RPC_URL_1..9` e `CACA_RPC_URLS` por `listaDeRpcs`, e o
     * log de producao de 2026-10-09 mostra `rpc: base-mainnet.g.alchemy.com`.
     *
     * Entao aqui a mesma funcao decide, na mesma ordem. No Railway, onde a
     * variavel ja existe, `npm run morpho` roda SEM configurar nada. E a escada
     * continua sendo uma escada: se o primeiro recusar, tenta o seguinte.
     *
     * E a REGRA 3: a lista de RPC em dois lugares seria a mesma regra em dois
     * lugares, e a copia provaria a copia.
     */
    const escada = listaDeRpcs(process.env, RPCS_PARA_TENTAR.base ?? ['https://mainnet.base.org']);
    const nomeDoHost = (u: string) => { try { return new URL(u).host; } catch { return 'url inválida'; } };
    log.info('[RPC] A escada, na ordem em que vou tentar.', {
        degraus: escada.map(nomeDoHost),
        deOndeVem: 'CACA_RPC_URL, RPC_URL_1..9, CACA_RPC_URLS — as MESMAS que o caçador lê',
        aviso: 'só o host aparece aqui: a chave fica na variável de ambiente',
    });
    let url = escada[0]!;
    const host = nomeDoHost(url);
    const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    let pedidos = 0;
    const motivos = new Map<string, number>();
    const chamar = async (method: string, params: unknown[], tentativas = 4): Promise<any> => {
        for (let t = 0; t < tentativas; t++) {
            try {
                pedidos++;
                const r = await fetch(url, {
                    ...(agente ? { dispatcher: agente } : {}),
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                });
                const j = await r.json() as any;
                if (j.error) motivos.set(String(j.error.message).slice(0, 60), (motivos.get(String(j.error.message).slice(0, 60)) ?? 0) + 1);
                else return j.result;
            } catch (e) {
                motivos.set(String(e).slice(0, 60), (motivos.get(String(e).slice(0, 60)) ?? 0) + 1);
            }
            await new Promise((s) => setTimeout(s, 400 * 2 ** t));
        }
        return null;
    };

    const topoHex = await chamar('eth_blockNumber', []);
    if (topoHex === null) {
        log.error('O RPC não respondeu nem o número do bloco.', { host, motivos: [...motivos] });
        if (require.main === module) process.exitCode = 1;
        return;
    }
    const topo = Number.parseInt(topoHex, 16);

    // 1. QUEM E O MORPHO — candidato meu, veredicto da corrente.
    const CANDIDATOS = (process.env.MORPHO_CANDIDATOS ?? '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
        .split(',').map((s) => s.trim()).filter(Boolean);
    let morpho: string | null = null;
    for (const c of CANDIDATOS) {
        const codigo = await chamar('eth_getCode', [c, 'latest']);
        const v = julgarMorpho(codigo ?? '0x');
        log.info('[IDENTIDADE] Candidato julgado pelo bytecode, não pela minha memória.', {
            candidato: c,
            bytes: codigo && codigo !== '0x' ? (codigo.length - 2) / 2 : 0,
            veredicto: v.eh ? 'É O MORPHO BLUE: a superfície inteira está no código' : 'NÃO é',
            faltando: v.faltando.length === 0 ? 'nada' : v.faltando,
            onMorphoLiquidate: `${SELETOR_DO_CALLBACK} ${v.temCallback ? 'ESTÁ no bytecode dele' : 'NÃO está'}`,
        });
        if (v.eh) { morpho = c; break; }
    }
    if (morpho === null) {
        log.error('Nenhum candidato passou. NÃO publico endereço, e não concluo nada sobre o Morpho.', {
            comoDestravar: 'MORPHO_CANDIDATOS=0x...,0x... com outros candidatos',
        });
        if (require.main === module) process.exitCode = 1;
        return;
    }

    // 2. OS MERCADOS, pelos eventos. O tamanho da janela e SONDADO, nunca
    //    cravado: o teto do provedor mudou tres vezes em cinco dias (2.000 ->
    //    500 -> 312) e um piso cravado devolve "zero encontrados" em silencio.
    const JANELA_PEDIDA = Number(process.env.MORPHO_JANELA ?? '10000');
    const DIAS = Number(process.env.MORPHO_DIAS ?? '400');
    const de = Math.max(0, topo - Math.round((DIAS * 86400) / 2));
    let tamanho = 0;
    for (const t of tamanhosASondar(JANELA_PEDIDA, PEDACO_MINIMO)) {
        const teste = await chamar('eth_getLogs', [{
            fromBlock: `0x${(topo - t + 1).toString(16)}`,
            toBlock: `0x${topo.toString(16)}`,
            address: morpho,
            topics: [TOPICO_CREATE_MARKET],
        }], 2);
        if (teste !== null) { tamanho = t; break; }
    }
    if (tamanho === 0) {
        // DEGRAU SEGUINTE antes de desistir: um provedor recusar eth_getLogs
        // nao e "a rede nao tem". Isto e a escada fazendo o trabalho dela.
        for (const proximo of escada.slice(1)) {
            log.warn('[RPC] Este degrau recusou TODA janela. Subo para o próximo.', {
                recusou: nomeDoHost(url), tentando: nomeDoHost(proximo), motivos: [...motivos],
            });
            url = proximo;
            for (const t of tamanhosASondar(JANELA_PEDIDA, PEDACO_MINIMO)) {
                const teste = await chamar('eth_getLogs', [{
                    fromBlock: `0x${(topo - t + 1).toString(16)}`,
                    toBlock: `0x${topo.toString(16)}`,
                    address: morpho,
                    topics: [TOPICO_CREATE_MARKET],
                }], 2);
                if (teste !== null) { tamanho = t; break; }
            }
            if (tamanho > 0) break;
        }
    }
    if (tamanho === 0) {
        log.error('NENHUM degrau da escada aceitou janela alguma. Cobertura ZERO não é "não há mercado".', {
            degrausTentados: escada.map(nomeDoHost),
            sondados: tamanhosASondar(JANELA_PEDIDA, PEDACO_MINIMO),
            motivos: [...motivos],
            comoDestravar: 'um RPC que sirva eth_getLogs em CACA_RPC_URL ou RPC_URL_1 '
                + '(o Railway dela já tem um: o log de produção mostra base-mainnet.g.alchemy.com)',
        });
        if (require.main === module) process.exitCode = 1;
        return;
    }

    const faixas = faixasDeBlocos(de, topo, tamanho);
    const mercados: MercadoDoMorpho[] = [];
    let ok = 0;
    for (const [a, b] of faixas) {
        const r = await chamar('eth_getLogs', [{
            fromBlock: `0x${a.toString(16)}`,
            toBlock: `0x${b.toString(16)}`,
            address: morpho,
            topics: [TOPICO_CREATE_MARKET],
        }], 3);
        if (r === null) continue;
        ok++;
        mercados.push(...lerCreateMarket(r));
    }
    const cobertura = faixas.length === 0 ? 0 : (100 * ok) / faixas.length;
    const quePagam = mercados
        .filter((m) => m.lltv.lessThanOrEqualTo(LLTV_MAXIMO_QUE_PAGA))
        .sort((x, y) => x.lltv.comparedTo(y.lltv));

    log.info('[MERCADOS] Os mercados do Morpho Blue, e os que de fato pagam.', {
        morpho,
        rpc: host,
        janelaMedida: `${tamanho} blocos (pedi ${JANELA_PEDIDA}; o provedor aceitou ${tamanho})`,
        olhei: `${((topo - de) * 2 / 86400).toFixed(1)} dias, blocos ${de}–${topo}`,
        cobertura: `${ok} de ${faixas.length} janelas (${cobertura.toFixed(1)}%)`,
        aviso: cobertura < 99
            ? `COBERTURA INCOMPLETA: ${(100 - cobertura).toFixed(1)}% das janelas falhou, então esta lista é PISO, não total`
            : 'cobertura cheia',
        mercadosAchados: mercados.length,
        comLltvQuePaga: `${quePagam.length} com LLTV ≤ ${LLTV_MAXIMO_QUE_PAGA.mul(100).toFixed(0)}%`,
        porQueEsseCorte: 'acima de 77% a fórmula dá 7,41% ou menos, e o alvo real da Aave de '
            + '2026-10-07 rendeu 4,56%: sem vantagem, sem obra',
        osQuePagam: quePagam.slice(0, 40).map((m) => ({
            id: m.id,
            lltv: `${m.lltv.mul(100).toFixed(1)}%`,
            bonus: m.bonusPct === null ? 'fora da faixa' : `${m.bonusPct.toFixed(2)}%`,
            divida: m.loanToken,
            garantia: m.collateralToken,
            oraculo: m.oracle,
        })),
        escalaDoOraculo: `a conta da saúde usa ${ESCALA_DO_ORACULO.toExponential()} — VERIFICADA em fork `
            + 'em 2026-10-09 contra o aceita/recusa do próprio Morpho, nos dois lados',
        oProximoPasso: 'com os ids em mão, `position(id, devedor)` e `market(id)` dão a saúde por '
            + 'mercado, e `saudeNoMorpho` já faz a conta',
        pedidosAoRpc: pedidos,
        recusas: motivos.size === 0 ? 'nenhuma' : [...motivos],
    });
}

if (require.main === module) {
    varrerMercadosDoMorpho().catch((e) => {
        log.error('Parei.', { erro: e instanceof Error ? e.message : String(e) });
        process.exitCode = 1;
    });
}

/**
 * A DESCOBERTA SEM `eth_getLogs`: API para enumerar, corrente para validar.
 *
 * `varrerMercadosDoMorpho` (acima) depende de `eth_getLogs`, e em 2026-10-14 ele
 * estava recusado em TODOS os provedores configurados. Esta funcao e o caminho
 * que nao depende dele. Ela NAO substitui a outra: quando o `getLogs` voltar, as
 * duas se conferem — e divergencia entre elas e achado, nao ruido.
 *
 * Roda desgrudada do laco de caca, igual a irma: nenhuma descoberta pode atrasar
 * um tiro, e se ela falhar o bot segue cacando com o que tem.
 */
export async function descobrirMorphoPorApi(
    opcoes: {
        /** O transporte HTTP da API. Injetado para o teste e para o proxy. */
        buscar?: TransporteHttp;
        /** Read-only RPC transport, injectable for deterministic offline tests. */
        pedirRpc?: import('./morphoDescobertaRpc').PedidoMorphoRpc;
        /** Quantos mercados validar na corrente nesta volta. Teto de orcamento. */
        tetoDeValidacoes?: number;
        /** Quantos mercados consultar devedores. Cada um e uma requisicao. */
        tetoDeMercadosComDevedores?: number;
        /** Numero de posicoes efetivamente lidas onchain em cada mercado selecionado. */
        tetoDePosicoesPorMercado?: number;
        /** Rotacao alinhada ao intervalo real do servico, nao a 15 minutos fixos. */
        indiceDaRodada?: number;
        caminhoDoCache?: string;
        /**
         * O estado da infraestrutura, para a decisao de CANAL.
         *
         * Ele entra para o log poder DIZER que o RPC estava esgotado e que isso
         * nao bloqueou a enumeracao. Ele NAO e consultado para autorizar a
         * chamada HTTP: `disponibilidadeDoCanal('apiHttp')` nao le campo de RPC,
         * e foi essa subordinacao que impediu a descoberta de executar.
         */
        infra?: EstadoDaInfra;
        /** Teto de requisicoes HTTP desta volta. */
        tetoDeRequisicoes?: number;
        /** Teto de tempo desta volta, em ms. Cancela o que estiver em voo. */
        tetoDeMs?: number;
        /** Onde a MEMORIA da descoberta mora. Sobrevive ao deploy. */
        caminhoDaMemoria?: string;
        /**
         * Contadores do inventario. Injetados porque `cacarAoVivo.ts` sobe o bot
         * ao ser importado — este modulo nao pode importa-lo, e replicar o
         * inventario aqui provaria a copia.
         *
         * HTTP e RPC entram SEPARADOS: requisicao a `api.morpho.org` nao consome
         * CU de provedor de RPC, e somar as duas produziria uma projecao de
         * consumo que nao existe.
         */
        contarHttp?: (host: string) => void;
        contarRpc?: (metodo: string) => void;
    } = {},
): Promise<void> {
    const { readFile, writeFile, mkdir } = await import('fs/promises');
    const { dirname } = await import('path');
    const caminho = opcoes.caminhoDoCache
        ?? process.env.CACA_CACHE_MORPHO
        ?? '/app/data/mercadosMorpho.json';
    const tetoValid = opcoes.tetoDeValidacoes ?? 24;
    const tetoDev = opcoes.tetoDeMercadosComDevedores ?? 8;
    const tetoPosicoes = opcoes.tetoDePosicoesPorMercado ?? 5;
    const infra: EstadoDaInfra = opcoes.infra
        ?? { provedoresEsgotados: [], noFallback: false };

    // O CANAL DECIDE, e so ele. `apiHttp` nao le estado de RPC: ver a
    // docstring de `disponibilidadeDoCanal`. Esta chamada esta aqui para a
    // politica ter UM dono, e nao para criar um portao novo.
    const canal = disponibilidadeDoCanal('apiHttp', infra);
    if (!canal.pode) {
        log.warn('[MORPHO/API] A TAREFA NÃO EXECUTOU.', {
            evidencia: comoLerADescoberta({
                devolvidos: 0, mercados: 0, quePagam: 0, confirmados: 0, devedores: 0,
                validados: 0, requisicoes: 0, completa: false, blocoIndexado: null,
                blocoAgora: null, falha: null, tentou: false, statusHttp: [],
                desfecho: 'naoExecutou',
            }),
            porque: canal.porque,
        });
        return;
    }

    // ORCAMENTO PROPRIO: requisicoes, tempo e CANCELAMENTO de verdade. Ele e
    // o unico limitador deste canal — nao a cota de RPC, que e de outro.
    const orcamento = new OrcamentoHttp(
        opcoes.tetoDeRequisicoes ?? 65,
        opcoes.tetoDeMs ?? 45_000,
    );

    // O CACHE PRIMEIRO: se a API cair, e ele que mantem o monitoramento. Ler
    // antes de pedir nada tambem responde "o que eu já sabia" na mesma linha.
    let doDisco: MercadoDaApi[] | null = null;
    let cursorInicial: string | null = null;
    try {
        const cacheAnterior = JSON.parse(await readFile(caminho, 'utf8'));
        doDisco = doCache(cacheAnterior);
        cursorInicial = doDisco === null ? null : cursorDeCache(cacheAnterior);
    } catch { doDisco = null; cursorInicial = null; }

    const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    // A CONTAGEM DE HTTP MORA AQUI, num lugar so, por fora do transporte.
    //
    // Ela foi explicita: *"Não conte duas vezes uma chamada instrumentada em
    // camadas diferentes."* Entao o contador envolve o transporte em vez de
    // viver dentro dele: assim vale igual para o transporte real e para o
    // injetado do teste, e nenhuma das duas camadas conta por conta propria.
    const contado = (t: TransporteHttp): TransporteHttp => async (url, o) => {
        try {
            opcoes.contarHttp?.(new URL(url).host);
        } catch { opcoes.contarHttp?.('host ilegível'); }
        return t(url, o);
    };
    const buscarCru: TransporteHttp = opcoes.buscar ?? (async (url, o) => {
        // `fetch` do Node ignora o HTTPS_PROXY e cai numa politica mais estreita
        // — este arquivo ja registra isso. Dispatcher explicito.
        const r = await fetch(url, {
            ...(agente ? { dispatcher: agente } : {}),
            method: o?.method ?? 'GET',
            headers: o?.headers,
            body: o?.body,
            // O SINAL VIAJA. Sem isto o orcamento seria letra morta no caminho
            // mais lento, que e exatamente o defeito medido em `cotacoesDaBinance`.
            ...(o?.signal ? { signal: o.signal } : {}),
        } as Parameters<typeof fetch>[1]);
        return { status: r.status, text: () => r.text() };
    });
    const buscar: TransporteHttp = contado(buscarCru);

    const cursores=new CursoresMorpho(caminho+'.devedores.json');
    await cursores.carregar();
    const enumeracao = await enumerarMercados(buscar, { orcamento,
        inicio:cursorInicial,
        reservaDeRequisicoes:Math.min(1+tetoDev*3,Math.floor(orcamento.tetoDeRequisicoes/2)) });
    // Janelas distintas devem ACUMULAR mercados. Apenas uma varredura que
    // começou no início e chegou ao fim substitui o inventário anterior.
    const inventario = new Map<string, MercadoDaApi>();
    if (!enumeracao.completa || cursorInicial !== null) {
        for (const m of doDisco ?? []) inventario.set(m.id,m);
    }
    for (const m of enumeracao.mercados) inventario.set(m.id,m);
    const legiveis = [...inventario.values()];
    const veioDoCache = enumeracao.mercados.length === 0 && doDisco !== null;
    const completoNoCache = enumeracao.completa && cursorInicial === null;
    // Um cursor de API inválido não pode aprisionar o scanner para sempre.
    const cursorInvalido = enumeracao.mercados.length === 0 &&
        /HTTP 400|HTTP 404|repetiu o cursor|nenhum mercado novo|NÃO-JSON/.test(enumeracao.falha ?? '');
    const proximoCursor = enumeracao.completa || cursorInvalido
        ? null : (enumeracao.proximoCursor ?? cursorInicial);
    // A BASE, pelo chain do PROPRIO item. Filtrar aqui e diferente de confiar
    // no `chain_id` da URL: a API pode ignorar o parametro, e validar um
    // mercado de outra rede contra a Base daria divergencia de campos — que
    // leria como "mercado recusado" em vez de "mercado de outra chain".
    const porChain = soDaBase(legiveis);
    const quePagam = soOsQuePagam(porChain.daBase);
    // Observacao inclui LLTV mais alto com bonus positivo. O antigo corte de
    // 77% e apenas uma comparacao de bonus com a Aave, nao um criterio
    // para ignorar devedores. O API continua incapaz de autorizar tiro.
    const candidatosParaSondagem=mercadosParaSondagem(porChain.daBase);
    // Morpho REST lista identidade, não dívida. Antes a seleção era
    // `slice(0,12)` e os primeiros mercados NÃO tinham devedores.
    // Uma consulta GraphQL ordenada pela dívida atual prioriza de fato
    // mercados usados. Se falhar, amostramos TODA a lista elegível.
    let rankingDeDividas:string[]|null=null;
    if(candidatosParaSondagem.length>0&&orcamento.pedir()) {
        try {
            const resp=await buscar('https://api.morpho.org/graphql',{
                method:'POST',headers:{'content-type':'application/json',
                    'accept':'application/json'},
                body:consultaMercadosMorphoComDivida(),signal:orcamento.sinal,
            });
            if(resp.status===200)rankingDeDividas=
                lerRankingMercadosMorpho(JSON.parse(await resp.text()));
        }catch{/* Sem ranking nunca vira "sem mercado"; existe fallback. */}
    }
    // A single durable queue chooses the markets that can ALSO collect borrowers.
    // Two wall-clock rotations used to validate a market and discard it before
    // enumeration. No cursor advanced for that market, so a known market was
    // incorrectly treated as effective borrower coverage.
    const rodada=opcoes.indiceDaRodada ?? Math.floor(Date.now()/900_000);
    const escolhidos=cursores.selecionarMercados(candidatosParaSondagem,rankingDeDividas,
        tetoDev===0?tetoValid:Math.min(tetoValid,tetoDev));
    log.info('[MORPHO/API] Selecao de mercados para conferir na Base.',{
        mercadosEnumerados:candidatosParaSondagem.length,
        llTvAte77PorCento:quePagam.length,
        llTvMaisAltoTambemElegivelASondagem:candidatosParaSondagem.length>quePagam.length,
        rankingComDivida:rankingDeDividas?.length??null,
        candidatosParaProva:escolhidos.length,
        posicoesOnchainPorMercado:tetoPosicoes,
        mercadosComDevedoresPorRodada:tetoDev,
        rodada,
        fixosDeAltaDivida:rankingDeDividas
            ?escolhidos.slice(0,Math.floor(escolhidos.length/4))
                .filter(m=>rankingDeDividas!.some(id=>id.toLowerCase()===m.id.toLowerCase())).length:0,
        politica:'25% vagas para maior divida validavel; 75% rodizio persistente por tentativa mais antiga; sem descarte antes de ler devedores',
        leitura:'tentativa nao comprova coleta bem-sucedida, liquidabilidade ou lucro',
    });

    if (veioDoCache) {
        log.warn('[MORPHO/API] A API não respondeu: sigo com o CACHE.', {
            falha: enumeracao.falha,
            mercadosNoCache: legiveis.length,
            quePagam: quePagam.length,
            oQueIssoNaoE: 'não é "não há mercados": é "não consegui enumerar agora". '
                + 'O cache mantém o monitoramento possível e NÃO é cobertura nova',
        });
    }

    // A CORRENTE VALIDA, e so ela autoriza. Teto de validacoes porque cada uma
    // e um `eth_call`, e orcamento e orcamento.
    const escada = listaDeRpcs(process.env, RPCS_PARA_TENTAR.base ?? ['https://mainnet.base.org']);
    let chamadasRpc=0;
    const pedirRpc:import('./morphoDescobertaRpc').PedidoMorphoRpc=async(url,method,params)=>{
        // RPC has its own bounded request allowance, but shares the round deadline.
        if(orcamento.sinal.aborted||chamadasRpc>=240)throw Error('orcamento RPC/deadline encerrado');
        chamadasRpc++;opcoes.contarRpc?.(method);
        if(opcoes.pedirRpc)return opcoes.pedirRpc(url,method,params);
        const response=await fetch(url,{
            ...(agente?{dispatcher:agente}:{}),method:'POST',
            headers:{'content-type':'application/json'},signal:orcamento.sinal,
            body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
        } as Parameters<typeof fetch>[1]);
        if(!response.ok)throw Error('RPC HTTP '+response.status);
        const j=await response.json() as {result?:unknown;error?:unknown};
        if(j.error||j.result===undefined)throw Error('RPC sem resultado valido');
        return j.result;
    };
    const snapshot=await abrirSnapshotMorpho(escada,
        (process.env.MORPHO_CANDIDATOS??'').split(','),pedirRpc,c=>julgarMorpho(c).eh);
    const morpho=snapshot?.morpho??'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
    const url=snapshot?.url??escada[0]!;
    const blocoDoRadar=snapshot?.bloco??null;
    const rpcMudo=snapshot===null;
    const porqueNaoValidou=rpcMudo?'nenhum RPC confirmou Base, superficie e snapshot Morpho':null;
    const chamarRpc=async(data:string,alvo=morpho):Promise<string|null>=>
        snapshot? snapshot.chamar(data,alvo):null;
    let confirmados = 0;
    const recusados: string[] = [];
    for(const m of escolhidos)m.confirmadoNaCorrente=false;
    for (const m of rpcMudo ? [] : escolhidos) {
        const cru = await chamarRpc(codificarIdToMarketParams(m.id));
        const veredicto = apiConfereComACorrente(m, cru === null ? null : lerIdToMarketParams(cru));
        m.confirmadoNaCorrente = veredicto.confere;
        if (veredicto.confere) confirmados += 1;
        else {
            recusados.push(`${m.id.slice(0, 10)}…: ${veredicto.porque}`);
            await cursores.marcarTentativa(m.id);
        }
    }

    // OS DEVEDORES, so dos mercados CONFIRMADOS. Pedir devedor de mercado que a
    // corrente nao confirmou seria gastar requisicao sobre dado que nao decide.
    let devedores = 0;
    let validados = 0;
    // Risk radar is read-only, strictly lower priority than CACA hot-path.
    // Protocol liquidation is NOT proved by this health estimate.
    let posicoesAvaliadas = 0;
    let pertoDoLimiar = 0;
    let cruzaramEstimado = 0;
    let oraculosIndisponiveis = 0;
    const alvosDeRisco: Array<{mercado:string;usuario:string;
        distanciaBps:string;dividaCrua:string;situacao:string}> = [];
    // Crossed and nearby positions can enter bounded accrual-inclusive probes.
    // Neither classification can authorize transmission. Candidates enter
    // the V3 execution funnel. The funnel rechecks health and liquidate() itself.
    const liquidaveisParaPreflight: Array<{mercado:MercadoDaApi;usuario:string}> = [];
    const falhasDeDevedores: string[] = [];
    // Every confirmed selection has a borrower slot. Hot positions keep their
    // independent per-block worker; this queue broadens discovery fairly.
    const mercadosComDevedores=tetoDev===0?[]:escolhidos.filter(x=>x.confirmadoNaCorrente);
    for (const m of mercadosComDevedores) {
        // A deadline must not falsely advance markets that were never queried.
        if(orcamento.sinal.aborted||orcamento.gastas>=orcamento.tetoDeRequisicoes)break;
        let totais = null as ReturnType<typeof lerMarket>;
        let precoOracle: bigint | null = null;
        // Same-block full position valuation, not merely "borrowShares>0".
        // Only the market whose FIVE identity fields were confirmed onchain
        // can be used. Oracle address is from those confirmed parameters.
        if(blocoDoRadar !== null) {
            const estado=await chamarRpc(codificarMarket(m.id));
            totais=estado===null?null:lerMarket(estado);
            if(/^0x[0-9a-fA-F]{40}$/.test(m.oracle)
                && !/^0x0{40}$/i.test(m.oracle)){
                const preco=await chamarRpc(id('price()').slice(0,10),m.oracle);
                if(preco!==null&&/^0x[0-9a-fA-F]{64}$/.test(preco)){
                    try { precoOracle=BigInt(preco); } catch {precoOracle=null;}
                }
            }
        }
        if(precoOracle===null || precoOracle<=0n)oraculosIndisponiveis+=1;
        // Tres paginas no maximo por mercado: consulta os maiores por
        // BorrowShares antes do prazo do job. COMPLETA=false caso sobrem
        // paginas, sem declarar que os demais devedores nao existem.
        const r = await enumerarDevedores(buscar, m.id, {tetoDePaginas:3,
            inicio:cursores.obter(m.id).proximo,orcamento});
        if(r.requisicoes>0)await cursores.marcarTentativa(m.id);
        await cursores.guardar(m.id,r.proximo,r.devedores);
        log.info('[MORPHO/COBERTURA-DEVEDORES] Resultado da consulta por mercado.',{
            mercado:m.id,bloco:blocoDoRadar,requisicoes:r.requisicoes,
            recebidos:r.devedores.length,cursorSeguinte:r.proximo,
            completa:r.completa,falha:r.falha,
            observacao:'registro de descoberta; nao autoriza envio',
        });
        devedores += r.devedores.length;
        if (r.falha !== null) falhasDeDevedores.push(`${m.id.slice(0, 10)}…: ${r.falha}`);
        // Metade dos cinco maiores mantida; a outra metade visita
        // devedores diferentes, sempre conferidos por position() onchain.
        // Multicall3 faz ate 60 verificacoes de devedor num UNICO eth_call
        // no mesmo bloco do preco do oracle e dos totais. Antes isto eram
        // dezenas de round trips e a fila parava no primeiro HTTP 429.
        const candidatos=selecionarDevedoresPorRisco(cursores.obter(m.id).devedores,m.lltv,tetoPosicoes,rodada);
        const dadosLote=candidatos.length>0
            ?await chamarRpc(codificarAggregate3(candidatos.map(d=>({
                alvo:morpho,dados:codificarPosition(m.id,d.endereco),
            }))),MULTICALL3)
            :null;
        const respostas=dadosLote===null?[]:decodificarAggregate3Rapido(dadosLote);
        if(candidatos.length>0&&respostas.length!==candidatos.length){
            log.warn('[MORPHO/RADAR-LOTE] Multicall3 incompleto: fail closed neste mercado.',{
                mercado:m.id,esperadas:candidatos.length,recebidas:respostas.length,
                fallback:'maximo 5 leituras diretas para nao matar a rodada',
            });
        }
        let tentativasDiretas=0;
        let posicoesSemDivida=0;
        let posicoesSemLeitura=0;
        let posicoesComDivida=0;
        for (const [indice,d] of candidatos.entries()) {
            // A single reverted or truncated position is not proof of zero
            // debt. Retry up to five missing individual Multicall3 results
            // directly at the SAME pinned block. Never bypass protocol checks.
            const lida=await lerPosicaoMorphoComFallback(
                respostas[indice],
                ()=>chamarRpc(codificarPosition(m.id,d.endereco)),
                tentativasDiretas<5,
            );
            if(lida.tentouDireto)tentativasDiretas++;
            const p=lida.posicao;
            if(p===null){posicoesSemLeitura++;continue;}
            if(p.borrowShares===0n){posicoesSemDivida++;continue;}
            posicoesComDivida++;
            if (p.borrowShares > 0n) {
                validados += 1;
                if(totais!==null&&precoOracle!==null&&precoOracle>0n) {
                    const lltvCru=BigInt(m.lltv.mul('1000000000000000000')
                        .floor().toFixed(0));
                    const risco=examinarSaudeMorpho({
                        borrowShares:p.borrowShares,collateral:p.collateral,
                        totalBorrowAssets:totais.totalBorrowAssets,
                        totalBorrowShares:totais.totalBorrowShares,
                        precoOracle,lltvWad:lltvCru,
                    });
                    posicoesAvaliadas+=1;
                    if(risco.situacao==='proxima'||risco.situacao==='cruzou-estimado'){
                        // Feed the per-block Morpho executor with actually confirmed
                        // borrowers, not only 3-minute API radar logs.
                        if(m.confirmadoNaCorrente&&risco.distanciaBps!==null) {
                            const {registrarQuenteMorpho}=await import('./titanMorphoHot');
                            registrarQuenteMorpho(m,d.endereco,risco.distanciaBps);
                        }
                        if(m.confirmadoNaCorrente){
                            const alvo={mercado:m,usuario:d.endereco};
                            if(risco.situacao==='cruzou-estimado')liquidaveisParaPreflight.unshift(alvo);
                            else if(precisaPreflightIntegralMorpho(risco)&&liquidaveisParaPreflight.length<3)
                                liquidaveisParaPreflight.push(alvo);
                            if(liquidaveisParaPreflight.length>3)liquidaveisParaPreflight.pop();
                        }
                        if(risco.situacao==='proxima')pertoDoLimiar+=1;
                        else {
                            cruzaramEstimado+=1;
                        }
                        if(alvosDeRisco.length<20&&risco.distanciaBps!==null
                            &&risco.dividaCrua!==null)
                            alvosDeRisco.push({
                                mercado:m.id,usuario:d.endereco,
                                distanciaBps:risco.distanciaBps.toString(),
                                dividaCrua:risco.dividaCrua.toString(),
                                situacao:risco.situacao,
                            });
                    }
                }
            }
        }
        if(candidatos.length>0)log.info('[MORPHO/PROVA-POSICOES] Resultado onchain por mercado.',{
            mercado:m.id,candidatos:candidatos.length,
            comDivida:posicoesComDivida,semDividaConfirmada:posicoesSemDivida,
            semLeitura:posicoesSemLeitura,tentativasDiretas,
            nota:'semDividaConfirmada significa borrowShares=0 na corrente; semLeitura nao significa saudavel',
        });
    }
    log.info('[MORPHO/RADAR] Posições avaliadas com preço e LLTV da Base.', {
        bloco:blocoDoRadar??'DESCONHECIDO: sem avaliação econômica',
        mercadosComDevedores:mercadosComDevedores.length,
        posicoesComDividaValidadas:validados,
        maximoDePosicoesOnchain:tetoPosicoes*mercadosComDevedores.length,
        saudesCalculadas:posicoesAvaliadas,
        proximas:pertoDoLimiar,
        cruzadasEstimadas:cruzaramEstimado,
        oraculosSemLeitura:oraculosIndisponiveis,
        candidatos:alvosDeRisco,
        aviso:'SOMENTE TRIAGEM: nao e comprovacao de que liquidate passara; '
          +'juros, liquidez, saldo, oracle atualizado, swap, nonce e gas '
          +'ainda precisam de eth_call no executor antes de qualquer envio.',
    });

    // Real Morpho V3 bridge. No future hypothetical target is sent. Each
    // crossed position goes through the whole deployed contract by eth_call,
    // an onchain loan-token -> WETH fee comparison, fresh gas and strict nonce.
    // V3 can only sign if Aave signing is OFF (one wallet cannot have two senders).
    if (rotasMorphoHabilitadas(process.env)) {
        if (liquidaveisParaPreflight.length === 0) {
            log.info('[TITAN/MORPHO-V3] Nenhuma posicao cruzada ou proxima para sonda nesta rodada.', {
                radar: 'ativo; aguardando posicao onchain verdadeiramente liquidavel',
                contrato:process.env.CACA_MORPHO_V3_CONTRATO
                    ? 'informado (imutaveis exigidos no preflight)' : 'NAO IMPLANTADO/CONFIGURADO',
                modo:'sem posicao liquidavel, nenhum gas gasto',
            });
        } else {
            const {avaliarSaidasMorpho}=await import('./titanMorphoDiretorDeRota');
            for(const alvo of liquidaveisParaPreflight){
                const {via,resultado}=await avaliarSaidasMorpho({
                    mercado:alvo.mercado,usuario:alvo.usuario,signal:orcamento.sinal,
                    // PublicNode pode devolver 403 no preflight/transmissao;
                    // o executor nao herda o RPC do censo por acidente.
                    rpcUrl:process.env.CACA_MORPHO_V3_RPC_URL??url,
                });
                log.warn('[TITAN/MORPHO-V3] Preflight do executor real.',{
                    mercado:alvo.mercado.id,usuario:alvo.usuario,
                    via,resultado,
                    nota:'so hash+recibo confirma transacao; estimativa nao e lucro',
                });
            }
        }
    }

    const blocoAgora=blocoDoRadar===null?null:Number.parseInt(blocoDoRadar,16);

    // O DESFECHO, entre as quatro situacoes que ela mandou separar. A ordem
    // importa: cada ramo exclui o anterior, e nenhuma delas e silenciosa.
    const desfecho: DesfechoDaDescoberta = !enumeracao.tentou
        // Nenhuma requisicao saiu. So acontece com orcamento zerado.
        ? 'naoExecutou'
        // ERRO DE CONTRATO vem ANTES de tudo, e e a correcao do log de
        // 2026-10-14: HTTP 200 que nao decodificou nao e "vazio" nem "falha de
        // rede". Sem este ramo, um nome de campo errado virava "a Base nao tem
        // mercados Morpho" — a conclusao mais cara possivel, pelo motivo mais
        // barato de consertar.
        : enumeracao.erroDeSchema !== null
            ? 'erroDeSchema'
            : enumeracao.falha !== null && legiveis.length === 0
                // A requisicao saiu e a resposta nao serviu.
                ? 'apiFalhou'
                : enumeracao.elementosRecebidos === 0 && legiveis.length === 0
                    // Formato RECONHECIDO e lista vazia. Agora sim e RESPOSTA,
                    // e so pode ser dita depois de o formato ter sido lido.
                    ? 'apiVaziaDeVerdade'
                    : candidatosParaSondagem.length === 0
                        // Ha mercado e o FILTRO nao selecionou nenhum. E escolha
                        // nossa, nao ausencia de dado.
                        ? 'foraDaFaixa'
                        : rpcMudo
                            // A API deu e o RPC nao pode confirmar. Guardado.
                            ? 'rpcIndisponivel'
                            : confirmados === 0
                                ? 'validacaoRecusou'
                                : 'confirmou';

    log.info('[MORPHO/API] Descoberta SEM eth_getLogs.', {
        evidencia: comoLerADescoberta({
            devolvidos: enumeracao.devolvidos,
            mercados: legiveis.length,
            quePagam: quePagam.length,
            confirmados,
            devedores,
            validados,
            requisicoes: orcamento.gastas,
            completa: completoNoCache,
            blocoIndexado: enumeracao.blocoIndexado,
            blocoAgora,
            falha: enumeracao.falha,
            tentou: enumeracao.tentou,
            statusHttp: enumeracao.statusHttp,
            desfecho,
            elementosRecebidos: enumeracao.elementosRecebidos,
            erroDeSchema: enumeracao.erroDeSchema,
            deOutraChain: porChain.deOutraChain,
            paginouPorCursor: enumeracao.paginouPorCursor,
            estadoDoRpc: rpcMudo
                ? 'o eth_getCode não respondeu: validação não rodou, e os mercados ficam NÃO '
                    + 'CONFIRMADOS para a próxima volta'
                : `${disponibilidadeDoCanal('validacao', infra).degradado ? 'degradado' : 'livre'}`
                    + ` — ${chamadasRpc} chamada(s) eth_call/eth_getCode nesta volta`,
            naoConfirmadosGuardados: candidatosParaSondagem.filter((x) => x.confirmadoNaCorrente !== true).length,
            porqueNaoValidou,
        }),
        orcamento: orcamento.comoLer(),
        canais: comoLerOsCanais(infra),
        chamadasEthCall: chamadasRpc,
        deOndeVeioALista: veioDoCache ? 'CACHE (a API não respondeu)' : 'API',
        mercadosRecusadosNaCorrente: recusados.slice(0, 5),
        falhasDeDevedores: falhasDeDevedores.slice(0, 3),
        oQueIssoNAOProva: 'a API ENUMERA; ela não decide tiro. Mercado não confirmado pela '
            + 'corrente não entra, e devedor não validado por eth_call não é alvo. '
            + 'Cobertura de devedores é PISO: o teto desta volta é pequeno de propósito',
    });

    // A MEMORIA, e ela e o conserto da cegueira operacional.
    //
    // Ela abriu um trecho de log 15,7 min depois do boot e perguntou se a API
    // tinha executado. A resposta existia em UMA linha, no boot, e nada a
    // re-imprimia. Agora o resultado vai ao disco com data e e re-impresso no
    // `[BLOCO]`.
    //
    // E a REGRA DURA: *"Uma falha posterior não pode apagar o último resultado
    // válido."* `juntar` troca `ultimoSucesso` so por SUCESSO.
    const oQueBloqueia: string | null = (() => {
        if (!enumeracao.tentou) return 'o orçamento HTTP não deixou sair requisição nenhuma';
        // O CONTRATO DE DADOS vem primeiro: ele e barato de consertar e explica
        // o zero inteiro. Dizer "o RPC" sobre um erro de parser mandaria
        // consertar a coisa errada.
        if (enumeracao.erroDeSchema !== null) {
            return `o CONTRATO de dados da API: ${enumeracao.erroDeSchema.slice(0, 220)}`;
        }
        if (enumeracao.falha !== null && legiveis.length === 0) {
            return `a API da Morpho: ${enumeracao.falha}`;
        }
        // SEM MERCADO NAO HA O QUE VALIDAR, entao o RPC nao e o bloqueio.
        //
        // Medido no artefato: com `data: []` o bloqueio saia "o RPC não
        // respondeu ao eth_getCode", e isso mandaria consertar o RPC quando a
        // resposta da API e que estava vazia. O portao do RPC tinha de vir
        // DEPOIS de haver candidato — ele so bloqueia quem existe.
        if (legiveis.length === 0) {
            return 'a API respondeu no formato esperado e com ZERO mercados: não há o que '
                + 'validar, e isto é RESPOSTA e não falha';
        }
        if (candidatosParaSondagem.length === 0) {
            return 'nenhum mercado com LLTV valido e incentivo positivo para sondagem; '
                + 'a API enumerou, mas nenhum candidato passou no filtro de observacao';
        }
        if (rpcMudo) return 'o RPC não respondeu ao eth_getCode: sem ele não valido mercado nenhum';
        if (confirmados === 0) {
            // O MOTIVO REAL, e nao um rotulo so. `apiConfereComACorrente` ja
            // separa "a corrente nao devolveu parametros legiveis" (que e RPC
            // ou id que a corrente nao conhece) de "divergiu em lltv" (que e
            // dado) — e este bloqueio colapsava os dois em "divergiram",
            // mandando consertar o parser quando o problema era a leitura.
            return `nenhum mercado confirmado na corrente. Primeiro motivo: ${
                recusados[0] ?? 'nenhum motivo registrado'}`;
        }
        if (devedores === 0) {
            return 'nenhum devedor veio do GraphQL para os mercados confirmados'
                + (falhasDeDevedores.length > 0 ? ` — ${falhasDeDevedores[0]}` : '');
        }
        if (validados === 0) return 'nenhum devedor passou a validação por eth_call';
        return null;
    })();

    const registro: RegistroDaDescoberta = {
        em: Date.now(),
        desfecho,
        tentou: enumeracao.tentou,
        statusHttp: enumeracao.statusHttp,
        mercadosRecebidos: enumeracao.elementosRecebidos,
        mercadosEnumerados: legiveis.length,
        mercadosQuePagam: quePagam.length,
        mercadosConfirmados: confirmados,
        devedoresEncontrados: devedores,
        devedoresValidados: validados,
        blocoIndexado: enumeracao.blocoIndexado,
        coberturaCompleta: completoNoCache,
        falha: enumeracao.falha,
        requisicoesHttp: orcamento.gastas,
        chamadasRpc,
        // A LISTA VEIO DO CACHE? Sem isto, uma volta com a API morta renovaria
        // a idade do ultimo sucesso para sempre.
        veioDoCache,
        oQueBloqueia,
    };
    const caminhoMem = opcoes.caminhoDaMemoria
        ?? process.env.CACA_MEMORIA_MORPHO
        ?? '/app/data/descobertaMorpho.json';
    try {
        let antes: MemoriaDaDescoberta | null = null;
        try {
            antes = lerMemoria(JSON.parse(await readFile(caminhoMem, 'utf8')));
        } catch { antes = null; }
        const juntada = juntar(antes, registro);
        await mkdir(dirname(caminhoMem), { recursive: true });
        const tmp = nomeTemporario(caminhoMem);
        await writeFile(tmp, JSON.stringify({ ...juntada, versao: VERSAO_DA_MEMORIA }));
        const { rename } = await import('fs/promises');
        await rename(tmp, caminhoMem);
        log.info('[MORPHO/API] Memória da descoberta gravada.', {
            caminho: caminhoMem,
            agora: resumoDaDescoberta(juntada, Date.now()),
            oUltimoSucessoSobreviveu: juntada.ultimoSucesso !== null
                && antes?.ultimoSucesso !== null
                && juntada.ultimoSucesso?.em === antes?.ultimoSucesso?.em
                ? 'SIM: esta tentativa não foi sucesso e NÃO apagou o resultado anterior'
                : 'esta tentativa é o resultado mais recente',
        });
    } catch (e) {
        // NAO MATA A CACA. Falhar ao gravar a memoria e perder a resposta da
        // proxima vez, nao perder o bot.
        log.warn('[MORPHO/API] NÃO gravei a memória da descoberta.', {
            caminho: caminhoMem,
            erro: e instanceof Error ? e.message : String(e),
            oQueIssoCusta: 'o próximo boot não saberá o resultado desta volta',
        });
    }

    // GRAVA o que foi confirmado, para a proxima volta nao recomecar.
    if (legiveis.length > 0) {
        try {
            await mkdir(dirname(caminho), { recursive: true });
            const tmp = `${caminho}.${process.pid}.${Date.now()}.tmp`;
            await writeFile(tmp, JSON.stringify(
                paraCache(legiveis, enumeracao.blocoIndexado, completoNoCache, Date.now(), proximoCursor),
            ));
            const { rename } = await import('fs/promises');
            await rename(tmp, caminho);
            log.info('[MORPHO/API] Cache gravado.', {
                caminho, mercados: legiveis.length, completo: completoNoCache,
                mercadoDaApiNestaRodada: enumeracao.mercados.length,
                retomouDaPaginaAnterior: cursorInicial !== null,
                temProximaPagina: proximoCursor !== null,
                porque: 'nome único por gravação e rename atômico — a mesma regra do cache de '
                    + 'devedores, que já custou uma gravação perdida a este projeto',
            });
        } catch (e) {
            log.warn('[MORPHO/API] NÃO gravei o cache.', {
                erro: e instanceof Error ? e.message : String(e),
            });
        }
    }
}
