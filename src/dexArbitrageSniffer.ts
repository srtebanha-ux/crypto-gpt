// Arquivo: src/dexArbitrageSniffer.ts
//
// Medição empírica de arbitragem on-chain — NÃO envia transação nenhuma, não
// assina nada, não precisa de chave privada. Só leitura via `eth_call`.
//
// Terceira aplicação da mesma disciplina que já resolveu duas perguntas hoje:
// medir antes de construir. A arbitragem triangular na Binance consumiu um dia
// de argumento e dez minutos de medição — o mercado oferecia 0,124% contra um
// custo de 0,225%. Aqui a pergunta é se vale escrever um contrato Solidity de
// flash loan, e a resposta custa alguns `eth_call`.
//
// POR QUE NENHUM ENDEREÇO DE POOL VEM EMBUTIDO NO CÓDIGO:
// um endereço errado não estoura — ele lê outro contrato, ou devolve vazio, e
// vira um número plausível e errado no relatório. O mesmo vale para endereços
// que eu escrevesse de memória. Então os pools são obrigatoriamente fornecidos
// por quem roda (DEX_POOLS) ou descobertos enumerando uma factory informada
// (DEX_FACTORY), e cada um é VERIFICADO na leitura: se não responder como um
// pool de produto constante, é descartado e contabilizado no resumo, nunca
// tratado em silêncio como pool vazio.
//
// O modo DEX_FACTORY é o que serve à cauda longa: searchers profissionais
// concentram atenção nos pools grandes, porque a infraestrutura deles tem
// custo fixo alto. Varrer pools recém-criados é procurar onde ninguém está
// olhando — e com flash loan isso é acessível, já que o risco clássico de
// ficar preso num token ilíquido desaparece quando a transação reverte.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { evaluateCycle, cycleSpotRatio } from './ammMath';
import { findTriangularCycles, findTwoPoolCycles, hopsForCycle, type Cycle, type PoolInfo } from './dexGraph';
import { SELECTORS, decodeAddressWord, decodeDecimals, decodeReserves, decodeUintWord, encodeUint256, fromRawUnits } from './evmAbi';
import { assertPlausiblePoolCount, parseScanMode, selectPoolIndices } from './poolDiscovery';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

const log = createLogger('dex-sniffer');

/** WETH na Base — predeploy padrão do OP Stack, igual em todas as chains OP. */
const DEFAULT_BASE_TOKEN = '0x4200000000000000000000000000000000000006';
const DEFAULT_RPC_URL = 'https://mainnet.base.org';
/** Gas típico de uma arbitragem com flash loan (2-3 swaps + callback). */
const DEFAULT_GAS_UNITS = 450_000;

interface RpcCall {
    to: string;
    data: string;
}

let rpcId = 0;

/**
 * Envia várias chamadas num único request JSON-RPC em lote. Sequencial seria
 * dezenas de round-trips contra um RPC público — lento a ponto de as reservas
 * lidas no começo já estarem obsoletas quando as últimas chegassem, o que
 * produziria "arbitragem" entre dois instantes diferentes do mercado.
 */
export async function batchEthCall(rpcUrl: string, calls: RpcCall[]): Promise<string[]> {
    const payload = calls.map((c) => ({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'eth_call',
        params: [{ to: c.to, data: c.data }, 'latest'],
    }));

    const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const text = await res.text();
        // 429 é a forma HTTP do mesmo problema que alguns provedores devolvem
        // como erro JSON-RPC. Os dois caminhos precisam levar ao mesmo lugar.
        if (res.status === 429 || isRateLimit(text)) throw new RateLimitedError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        throw new Error(`RPC HTTP ${res.status}: ${text}`);
    }

    const body = (await res.json()) as Array<{ id: number; result?: string; error?: { message: string } }>;
    if (!Array.isArray(body)) {
        // Um erro no lugar do array significa lote recusado. A causa mais comum
        // é limite de tamanho — o RPC público da Base aceita 10 chamadas por
        // lote, provedores pagos aceitam centenas —, e a mensagem varia por
        // provedor. Em vez de tentar reconhecer cada texto, sinalizamos a
        // possibilidade e deixamos o chamador encolher e tentar de novo: se
        // falhar até com uma chamada, aí sim o endpoint não faz lote.
        throw new BatchRejectedError(
            `RPC recusou o lote de ${calls.length}: ${JSON.stringify(body).slice(0, 300)}`,
        );
    }

    const byId = new Map(body.map((r) => [r.id, r]));
    return payload.map((p) => {
        const r = byId.get(p.id);
        if (!r) throw new Error(`RPC não devolveu resposta para a chamada ${p.id}.`);
        if (r.error) {
            if (isRateLimit(r.error.message)) throw new RateLimitedError(r.error.message);
            throw new Error(`RPC erro na chamada ${p.id}: ${r.error.message}`);
        }
        return r.result ?? '0x';
    });
}

/**
 * Tamanho máximo de um lote JSON-RPC. RPCs públicos rejeitam (ou truncam)
 * lotes muito grandes, e varrer 200 pools são 600 chamadas — bem acima do que
 * a maioria aceita de uma vez.
 */
const DEFAULT_BATCH_SIZE = 10;
/**
 * Primeira espera após um limite de taxa; dobra a cada nova recusa.
 *
 * Configurável porque a sequência completa de esperas leva mais de meio minuto
 * de relógio — tempo justificado contra um RPC real, absurdo dentro de um
 * teste que só precisa verificar que houve retentativa.
 */
const rateLimitBaseDelayMs = () => Number(process.env.DEX_RPC_RETRY_BASE_MS ?? '500');
/** Depois disso, esperar mais não resolve — o endpoint não serve à varredura. */
const MAX_RATE_LIMIT_RETRIES = 6;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lote recusado pelo endpoint — provavelmente grande demais.
 *
 * Existe como tipo próprio para o chamador poder reagir encolhendo o lote, em
 * vez de confundir isso com um erro de leitura de contrato.
 */
export class BatchRejectedError extends Error {}

/** Limite de taxa do provedor — passa se esperar, ao contrário de um revert. */
export class RateLimitedError extends Error {}

/**
 * Reconhece limite de taxa pelo texto do erro.
 *
 * É heurística, e assumidamente: cada provedor escreve de um jeito. O risco de
 * errar é pequeno nos dois sentidos — classificar um revert como limite custa
 * algumas tentativas antes de o erro aparecer mesmo assim, e classificar um
 * limite como revert só devolve o comportamento anterior a esta função.
 *
 * Não se retenta erro genérico: `eth_call` que reverte reverte sempre, e
 * retentar cada pool morto numa varredura de 200 multiplicaria o tempo sem
 * mudar nenhum resultado.
 */
function isRateLimit(message: string): boolean {
    const m = message.toLowerCase();
    // Mensagem que fala em lote é problema de TAMANHO, não de ritmo — esperar
    // não resolve, encolher resolve. Sem esta exceção, "batch size exceeded"
    // cairia em 'exceeded' e o scanner esperaria minutos por nada.
    if (m.includes('batch')) return false;
    return (
        m.includes('rate limit') ||
        m.includes('ratelimit') ||
        m.includes('too many requests') ||
        m.includes('429') ||
        m.includes('-32005') ||
        m.includes('capacity') ||
        m.includes('compute unit')
    );
}

/**
 * Divide em lotes aceitáveis, preservando a ordem das respostas.
 *
 * O tamanho do lote se ADAPTA: começa no configurado e cai pela metade a cada
 * recusa, até 1. Fixar um número foi um erro real — 100 funcionava no provedor
 * que eu tinha em mente e quebrava no RPC público da Base, que aceita 10. Como
 * o limite varia por provedor e não é anunciado em lugar nenhum, descobri-lo
 * na prática é mais confiável do que pedir para o operador adivinhar.
 *
 * O tamanho que funcionou vale para os lotes seguintes, então a redução é paga
 * uma vez por execução, não a cada lote.
 */
export async function chunkedEthCall(
    rpcUrl: string,
    calls: RpcCall[],
    initialBatchSize = Number(process.env.DEX_RPC_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE)),
): Promise<string[]> {
    const results: string[] = [];
    let size = Math.max(1, Math.floor(initialBatchSize));
    let delayMs = Math.max(0, Number(process.env.DEX_RPC_DELAY_MS ?? '0'));
    let rateLimitRetries = 0;
    let i = 0;
    while (i < calls.length) {
        try {
            if (delayMs > 0) await sleep(delayMs);
            results.push(...(await batchEthCall(rpcUrl, calls.slice(i, i + size))));
            i += size;
        } catch (err) {
            if (err instanceof RateLimitedError) {
                if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
                    throw new Error(
                        `RPC recusou ${rateLimitRetries} vezes seguidas, já com lote de ${size} e ` +
                            `${delayMs}ms entre lotes. Mensagem do provedor: "${err.message}". ` +
                            `O endpoint público não aguenta esta varredura: reduza DEX_SCAN_LIMIT, aumente ` +
                            `DEX_RPC_DELAY_MS, ou use um DEX_RPC_URL com chave própria.`,
                    );
                }
                rateLimitRetries += 1;
                // Espera crescente antes de repetir ESTE lote, e desaceleração
                // permanente dos seguintes: bater no limite uma vez é sinal de
                // que o ritmo atual não se sustenta pelo resto da varredura.
                const base = rateLimitBaseDelayMs();
                const espera = base * 2 ** (rateLimitRetries - 1);
                delayMs = Math.max(delayMs, base) * 2;
                // Encolher também: menos chamadas por lote é menos carga por
                // segundo, e cobre o caso de a mensagem ter sido classificada
                // como ritmo quando na verdade era tamanho.
                size = Math.max(1, Math.floor(size / 2));
                log.warn('RPC no limite de taxa; esperando e desacelerando a varredura.', {
                    tentativa: rateLimitRetries,
                    esperaMs: espera,
                    ritmoEntreLotesMs: delayMs,
                    tamanhoDoLote: size,
                    // Sem a mensagem do provedor não dá para distinguir limite
                    // real de erro que só PARECE limite — e aí a espera é
                    // tempo jogado fora contra uma causa que não existe.
                    mensagemDoProvedor: err.message,
                });
                await sleep(espera);
                continue;
            }
            if (!(err instanceof BatchRejectedError) || size === 1) {
                if (err instanceof BatchRejectedError) {
                    throw new Error(
                        `${err.message} — o endpoint recusou até uma única chamada em lote. ` +
                            `Use outro DEX_RPC_URL (um provedor com suporte a JSON-RPC batch).`,
                    );
                }
                throw err;
            }
            size = Math.max(1, Math.floor(size / 2));
            log.warn('Lote recusado pelo RPC; reduzindo o tamanho e tentando de novo.', {
                novoTamanho: size,
                dica: 'Defina DEX_RPC_BATCH_SIZE para começar já no tamanho certo e evitar as tentativas.',
            });
        }
    }
    return results;
}

async function fetchGasPriceWei(rpcUrl: string): Promise<Decimal> {
    const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_gasPrice', params: [] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} em eth_gasPrice`);
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error) throw new Error(`eth_gasPrice: ${body.error.message}`);
    return decodeUintWord(`0x${(body.result ?? '0x0').replace(/^0x/, '').padStart(64, '0')}`, 0);
}

/**
 * Lê e VERIFICA um conjunto de pools. Um endereço que não responde como pool
 * de produto constante é reportado e descartado — nunca silenciosamente
 * tratado como pool vazio, que entraria no grafo como preço fantasma.
 */
export async function loadPools(rpcUrl: string, addresses: string[], feeFraction: Decimal): Promise<PoolInfo[]> {
    const calls: RpcCall[] = [];
    for (const address of addresses) {
        calls.push({ to: address, data: SELECTORS.token0 });
        calls.push({ to: address, data: SELECTORS.token1 });
        calls.push({ to: address, data: SELECTORS.getReserves });
    }
    const results = await chunkedEthCall(rpcUrl, calls);

    const raw: Array<{ address: string; token0: string; token1: string; r0: Decimal; r1: Decimal }> = [];
    let dead = 0;
    let invalid = 0;
    for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        try {
            const token0 = decodeAddressWord(results[i * 3], 0);
            const token1 = decodeAddressWord(results[i * 3 + 1], 0);
            const reserves = decodeReserves(results[i * 3 + 2]);
            if (reserves.reserve0.lessThanOrEqualTo(0) || reserves.reserve1.lessThanOrEqualTo(0)) {
                // Em varredura ampla a maioria dos pools está morta — um aviso
                // por pool afogaria o relatório. Conta e resume; o detalhe fica
                // em LOG_LEVEL=debug para quem estiver investigando.
                dead += 1;
                log.debug(`Pool ${address} com reserva zerada — descartado.`);
                continue;
            }
            raw.push({ address, token0, token1, r0: reserves.reserve0, r1: reserves.reserve1 });
        } catch (err) {
            invalid += 1;
            log.debug(`Pool ${address} não respondeu como pool de produto constante — descartado.`, {
                erro: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (dead > 0 || invalid > 0) {
        log.info('Pools descartados na leitura.', {
            reservaZerada: dead,
            naoEhPoolV2: invalid,
            nota: 'Pool V3 (liquidez concentrada) não expõe getReserves(). Rode com LOG_LEVEL=debug para ver caso a caso.',
        });
    }

    // Decimais de cada token: sem normalizar, comparar USDC (6 casas) com WETH
    // (18) erra por 1e12 — e o erro sai como "arbitragem gigante".
    const tokens = Array.from(new Set(raw.flatMap((p) => [p.token0, p.token1])));
    const decimalResults = await chunkedEthCall(rpcUrl, tokens.map((t) => ({ to: t, data: SELECTORS.decimals })));
    const decimalsByToken = new Map<string, number>();
    tokens.forEach((token, i) => {
        try {
            decimalsByToken.set(token, decodeDecimals(decimalResults[i]));
        } catch (err) {
            log.error(`Token ${token} não respondeu decimals() — pools que o contêm serão descartados.`, {
                erro: err instanceof Error ? err.message : String(err),
            });
        }
    });

    const pools: PoolInfo[] = [];
    for (const p of raw) {
        const d0 = decimalsByToken.get(p.token0);
        const d1 = decimalsByToken.get(p.token1);
        if (d0 === undefined || d1 === undefined) continue;
        pools.push({
            address: p.address,
            token0: p.token0,
            token1: p.token1,
            reserve0: fromRawUnits(p.r0, d0),
            reserve1: fromRawUnits(p.r1, d1),
            feeFraction,
        });
    }
    return pools;
}

/**
 * Descobre endereços de pool enumerando a factory da DEX.
 *
 * É o que transforma a ferramenta de "confere estes pools que eu escolhi" em
 * "acha onde ninguém está olhando": searchers profissionais concentram
 * atenção nos pools grandes, porque a infraestrutura deles tem custo fixo
 * alto. A cauda longa fica desguarnecida — e com flash loan ela é acessível,
 * já que o risco clássico de ficar preso num token ilíquido desaparece
 * quando a transação inteira reverte.
 */
/**
 * Descobre a factory a partir de UM pool conhecido, via `factory()`.
 *
 * Existe para eliminar fricção real: endereço de factory se garimpa em
 * documentação, enquanto endereço de pool aparece na própria interface de
 * swap da DEX. Pedir o que é fácil de obter e derivar o resto reduz a chance
 * de alguém colar o endereço errado — que, como sempre neste projeto, não
 * estouraria, viraria relatório errado.
 *
 * A cadeia se autovalida: se o pool semente não for um par V2, `factory()`
 * não responde; se responder um endereço que não é factory,
 * `allPairsLength()` reprova logo em seguida.
 */
export async function discoverFactoryFromPool(rpcUrl: string, seedPool: string): Promise<string> {
    const [result] = await batchEthCall(rpcUrl, [{ to: seedPool, data: SELECTORS.factory }]);
    let factory: string;
    try {
        factory = decodeAddressWord(result, 0);
    } catch {
        throw new Error(
            `factory() não respondeu em ${seedPool} (resposta: "${result}"). ` +
                `O endereço provavelmente não é um pool de produto constante (V2). Pool V3 não serve.`,
        );
    }
    if (/^0x0+$/.test(factory)) {
        throw new Error(`factory() devolveu endereço zero em ${seedPool} — não é um par V2 válido.`);
    }
    log.info('Factory descoberta a partir do pool semente.', { poolSemente: seedPool, factory });
    return factory;
}

export async function discoverPoolAddresses(rpcUrl: string, factory: string): Promise<string[]> {
    const [lengthResult] = await batchEthCall(rpcUrl, [{ to: factory, data: SELECTORS.allPairsLength }]);
    // Um endereço que não é factory devolve `0x`, e a decodificação estoura
    // com "palavra ausente" — mensagem correta mas inútil para quem opera, que
    // iria investigar o RPC em vez do endereço. Traduz para a causa provável.
    let total: number;
    try {
        total = decodeUintWord(lengthResult, 0).toNumber();
    } catch {
        throw new Error(
            `allPairsLength() não devolveu número em ${factory} (resposta: "${lengthResult}"). ` +
                `O endereço provavelmente não é uma factory V2, ou é de outra rede.`,
        );
    }
    assertPlausiblePoolCount(total, factory);

    const mode = parseScanMode(process.env.DEX_SCAN_MODE);
    const limit = Number(process.env.DEX_SCAN_LIMIT ?? '200');
    const seed = Number(process.env.DEX_SCAN_SEED ?? '1');
    const indices = selectPoolIndices(total, limit, mode, seed);

    log.info('Factory verificada — enumerando pools.', {
        factory,
        totalNaFactory: total,
        varrendo: indices.length,
        modo: mode,
        nota: mode === 'newest' ? 'pools recém-criados: preço ainda não alinhado, menos indexados' : undefined,
    });

    const addressResults = await chunkedEthCall(
        rpcUrl,
        indices.map((i) => ({ to: factory, data: SELECTORS.allPairs + encodeUint256(i) })),
    );
    return addressResults.map((r) => decodeAddressWord(r, 0));
}

function describeCycle(cycle: Cycle): string {
    return cycle.path.map((t) => t.slice(0, 6)).join('->') + ` [${cycle.pools.map((p) => p.address.slice(0, 8)).join(', ')}]`;
}

async function main() {
    const rpcUrl = process.env.DEX_RPC_URL ?? DEFAULT_RPC_URL;
    const baseToken = (process.env.DEX_BASE_TOKEN ?? DEFAULT_BASE_TOKEN).toLowerCase();
    const explicitPools = (process.env.DEX_POOLS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    const seedPool = process.env.DEX_SEED_POOL?.trim().toLowerCase();
    let factory = process.env.DEX_FACTORY?.trim().toLowerCase();
    const feeFraction = new Decimal(process.env.DEX_POOL_FEE ?? '0.003');
    const flashLoanFee = new Decimal(process.env.FLASH_LOAN_FEE ?? '0.0005'); // Aave V3; Balancer = 0
    const gasUnits = new Decimal(process.env.DEX_GAS_UNITS ?? String(DEFAULT_GAS_UNITS));

    if (explicitPools.length === 0 && !factory && !seedPool) {
        log.error('Defina DEX_SEED_POOL (mais simples), DEX_FACTORY ou DEX_POOLS.', {
            maisSimples:
                'DEX_SEED_POOL=0x... — um endereço de pool qualquer da DEX. A factory é descoberta a partir dele via factory().',
            porque:
                'Nenhum endereço vem embutido de propósito: endereço errado não estoura, vira número plausível e errado no relatório.',
            varreduraAmpla:
                'DEX_FACTORY=0x... — enumera pools da factory da DEX e procura onde ninguém está olhando. É o modo indicado para cauda longa.',
            enderecosEspecificos:
                'DEX_POOLS=0xabc...,0xdef... — quando você já sabe quais pools quer conferir. Precisam ser de produto constante (V2), não V3.',
        });
        process.exit(1);
    }

    log.info('Lendo pools on-chain (nenhuma transação será enviada).', {
        rpc: rpcUrl,
        modo: factory ? 'descoberta via factory' : seedPool ? 'descoberta via pool semente' : 'lista explícita',
        tokenBase: baseToken,
        taxaPool: feeFraction.toString(),
        taxaFlashLoan: flashLoanFee.toString(),
    });

    if (!factory && seedPool) {
        factory = await discoverFactoryFromPool(rpcUrl, seedPool);
    }
    const poolAddresses = factory
        ? Array.from(new Set([...explicitPools, ...(seedPool ? [seedPool] : []), ...(await discoverPoolAddresses(rpcUrl, factory))]))
        : explicitPools;

    const pools = await loadPools(rpcUrl, poolAddresses, feeFraction);
    if (pools.length === 0) {
        log.error('Nenhum pool válido foi carregado — veja os erros acima.');
        process.exit(1);
    }
    log.info(`Pools válidos carregados: ${pools.length} de ${poolAddresses.length}.`);

    // Gas em ETH: é custo FIXO por tentativa e define o piso de tamanho.
    const gasPriceWei = await fetchGasPriceWei(rpcUrl);
    const gasCostEth = fromRawUnits(gasPriceWei.mul(gasUnits), 18);
    log.info('Custo de gas estimado por tentativa.', {
        gasPriceGwei: fromRawUnits(gasPriceWei, 9).toFixed(6),
        unidadesDeGas: gasUnits.toString(),
        custoEth: gasCostEth.toFixed(8),
        nota: 'Em ciclo cujo token de partida não é ETH, este custo precisa ser convertido — ver DEX_GAS_COST_IN_TOKEN.',
    });

    const gasCostInToken = process.env.DEX_GAS_COST_IN_TOKEN
        ? new Decimal(process.env.DEX_GAS_COST_IN_TOKEN)
        : gasCostEth;

    const cycles = [...findTwoPoolCycles(pools, baseToken), ...findTriangularCycles(pools, baseToken)];
    log.info(`Ciclos possíveis a partir do token base: ${cycles.length}.`);
    if (cycles.length === 0) {
        log.warn('Nenhum ciclo fechado entre os pools fornecidos.', {
            dica: 'Forneça pools que compartilhem tokens — ex.: dois pools do MESMO par em DEXs diferentes, ou um triângulo WETH/USDC + USDC/X + X/WETH.',
        });
        process.exit(0);
    }
    // Teto de entrada: fração das reservas do menor pool do ciclo. Não faz
    // sentido propor um empréstimo maior do que o pool consegue absorver — o
    // slippage já teria destruído o lucro muito antes.
    const maxFraction = new Decimal(process.env.DEX_MAX_RESERVE_FRACTION ?? '0.1');
    const watchIntervalSec = Number(process.env.DEX_WATCH_INTERVAL_SEC ?? '0');

    // Censo acumulado entre varreduras. Uma leitura pontual não responde
    // "oportunidade aparece de vez em quando?" — só a série ao longo do tempo
    // responde, e é ela que decide se vale escrever o contrato Solidity.
    let scans = 0;
    let scansWithOpportunity = 0;
    let bestEverNet = new Decimal(0);
    let bestEverDescription = 'nenhum';
    const startedAt = Date.now();

    const runScan = async (): Promise<void> => {
        scans += 1;
        // Reservas são relidas a cada varredura: são elas que mudam. A
        // topologia (quais pools existem) muda devagar e não justifica
        // reenumerar a factory toda vez.
        const fresh = await loadPools(rpcUrl, poolAddresses, feeFraction);
        const freshCycles = [...findTwoPoolCycles(fresh, baseToken), ...findTriangularCycles(fresh, baseToken)];

        const gasWei = await fetchGasPriceWei(rpcUrl);
        const gasInToken = process.env.DEX_GAS_COST_IN_TOKEN
            ? new Decimal(process.env.DEX_GAS_COST_IN_TOKEN)
            : fromRawUnits(gasWei.mul(gasUnits), 18);

        let profitableCount = 0;
        let bestNet = new Decimal(0);
        let bestDescription = 'nenhum';

        for (const cycle of freshCycles) {
            const hops = hopsForCycle(cycle);
            const smallestReserveIn = hops.reduce(
                (min, h) => (h.reserveIn.lessThan(min) ? h.reserveIn : min),
                hops[0].reserveIn,
            );
            const evaluation = evaluateCycle(hops, smallestReserveIn.mul(maxFraction), {
                flashLoanFeeFraction: flashLoanFee,
                gasCostInToken: gasInToken,
            });

            if (evaluation.netProfit.greaterThan(bestNet)) {
                bestNet = evaluation.netProfit;
                bestDescription = describeCycle(cycle);
            }
            if (evaluation.profitable) {
                profitableCount += 1;
                log.info('*** CICLO LUCRATIVO ENCONTRADO ***', {
                    ciclo: describeCycle(cycle),
                    entradaOtima: evaluation.amountIn.toFixed(8),
                    lucroBruto: evaluation.grossProfit.toFixed(8),
                    taxaFlashLoan: evaluation.flashLoanFee.toFixed(8),
                    gas: evaluation.gasCost.toFixed(8),
                    lucroLiquido: evaluation.netProfit.toFixed(8),
                    razaoSpot: cycleSpotRatio(hops).toFixed(8),
                });
            }
        }

        if (profitableCount > 0) scansWithOpportunity += 1;
        if (bestNet.greaterThan(bestEverNet)) {
            bestEverNet = bestNet;
            bestEverDescription = bestDescription;
        }

        log.info('Varredura concluída.', {
            varredura: scans,
            poolsVivos: fresh.length,
            ciclosAvaliados: freshCycles.length,
            ciclosLucrativos: profitableCount,
            melhorLiquidoNestaVarredura: bestNet.toFixed(8),
            gasPorTentativa: gasInToken.toFixed(8),
            // O acumulado é o que responde a pergunta de verdade: uma leitura
            // isolada com zero não distingue "não há oportunidade" de "não
            // havia NAQUELE instante".
            varredurasComOportunidade: `${scansWithOpportunity}/${scans}`,
            melhorLiquidoDesdeOInicio: bestEverNet.toFixed(8),
            melhorCicloDesdeOInicio: bestEverDescription,
            horasObservando: ((Date.now() - startedAt) / 3_600_000).toFixed(2),
        });
    };

    await runScan();

    if (watchIntervalSec <= 0) {
        log.info('=== COMO LER ===', {
            ponto1: 'Isto é UM instante do mercado. Zero ciclos lucrativos numa leitura não encerra a questão.',
            ponto2: 'Para responder de verdade, rode em modo contínuo: DEX_WATCH_INTERVAL_SEC=60.',
            ponto3: 'Ciclo lucrativo aqui NÃO é lucro capturável: on-chain a inclusão é leiloada (MEV) e searchers profissionais competem entregando o lucro ao validador.',
            ponto4: 'O que este número mede é o piso: se nem o lucro BRUTO aparece, não há o que disputar e não vale escrever o contrato.',
        });
        process.exit(0);
    }

    log.info('Modo contínuo ativo — varrendo indefinidamente.', {
        intervaloSegundos: watchIntervalSec,
        nota: 'Nenhuma transação é enviada. Só leitura. Interrompa com Ctrl+C.',
    });

    // Laço sequencial em vez de setInterval: com varredura mais lenta que o
    // intervalo, o setInterval empilharia execuções concorrentes disputando o
    // mesmo RPC, e as reservas de uma varredura se misturariam com as de
    // outra — produzindo "arbitragem" entre dois instantes distintos.
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, watchIntervalSec * 1000));
        try {
            await runScan();
        } catch (err) {
            // Falha de RPC não pode derrubar o monitor: ele existe para
            // acumular observação ao longo de horas.
            log.warn('Varredura falhou; tentando de novo no próximo intervalo.', {
                erro: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha ao medir arbitragem on-chain.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
