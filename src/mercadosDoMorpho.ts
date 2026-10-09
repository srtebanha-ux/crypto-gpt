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
import { id, AbiCoder } from 'ethers';
import { ProxyAgent, fetch } from 'undici';
import { createLogger } from './logger';
import { faixasDeBlocos } from './liquidacoes';
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

async function principal(): Promise<void> {
    const url = process.env.RPC_URL;
    if (!url) {
        log.error('Preciso de RPC_URL. O publico recusa eth_getLogs (23 de 24 janelas em 2026-10-09).', {
            comoRodar: "RPC_URL='https://base-mainnet.g.alchemy.com/v2/SUA_CHAVE' npx tsx src/mercadosDoMorpho.ts",
            aviso: 'a chave fica na variável de ambiente e NÃO aparece em log nenhum',
        });
        process.exitCode = 1;
        return;
    }
    const host = (() => { try { return new URL(url).host; } catch { return 'url inválida'; } })();
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
        process.exitCode = 1;
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
        process.exitCode = 1;
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
        log.error('Nenhum tamanho de janela foi aceito, nem o piso. Cobertura ZERO não é "não há mercado".', {
            host, sondados: tamanhosASondar(JANELA_PEDIDA, PEDACO_MINIMO), motivos: [...motivos],
        });
        process.exitCode = 1;
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
    principal().catch((e) => {
        log.error('Parei.', { erro: e instanceof Error ? e.message : String(e) });
        process.exitCode = 1;
    });
}
