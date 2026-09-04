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
import { encodeAddress, SELECTORS, decodeAddressWord, decodeDecimals, decodeReserves, decodeUintWord, encodeUint256, fromRawUnits } from './evmAbi';
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
 * Chamadas por segundo que a varredura se permite fazer.
 *
 * O padrão vem da restrição real de um tier gratuito: a Alchemy dá ~330
 * unidades de computação por segundo e um `eth_call` custa 26, o que dá ~12
 * chamadas por segundo. 10 deixa margem.
 *
 * O que existia antes era uma PAUSA fixa entre lotes, com padrão zero — os
 * lotes saíam na velocidade da rede e 200 chamadas partiam em um segundo,
 * estourando o limite em vinte vezes antes de qualquer espera entrar em ação.
 * Pausa entre lotes não é a mesma coisa que taxa: com lote de 100 e pausa de
 * 200 ms o pico continua sendo 100 chamadas de uma vez.
 */
const DEFAULT_CALLS_PER_SEC = 10;
/**
 * Varreduras seguidas com o MESMO ciclo lucrativo antes de tratá-lo como
 * suspeito. Numa rede com bots competindo por bloco, margem real não sobrevive.
 */
const PERSISTENCIA_SUSPEITA = 3;
/** Intervalo entre linhas de progresso numa varredura longa. */
const PROGRESS_INTERVAL_MS = 10_000;

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
    etapa?: string,
): Promise<string[]> {
    const results: string[] = [];
    let size = Math.max(1, Math.floor(initialBatchSize));
    const extraDelayMs = Math.max(0, Number(process.env.DEX_RPC_DELAY_MS ?? '0'));
    let callsPerSec = Math.max(0.5, Number(process.env.DEX_RPC_CALLS_PER_SEC ?? String(DEFAULT_CALLS_PER_SEC)));
    let delayMs = 0;
    let rateLimitRetries = 0;
    let nextAllowedAt = 0;
    let i = 0;
    // Ritmar 1200 chamadas a 10/s leva minutos. Sem sinal de vida, quem roda
    // não distingue "trabalhando" de "travado" — e a resposta certa para os
    // dois casos é oposta. O progresso sai por TEMPO, não por lote: a cada
    // lote afogaria o relatório, e é o relógio parado que assusta.
    const inicio = Date.now();
    let ultimoProgresso = inicio;
    while (i < calls.length) {
        if (etapa && Date.now() - ultimoProgresso >= PROGRESS_INTERVAL_MS) {
            ultimoProgresso = Date.now();
            const feito = i / calls.length;
            const decorrido = (Date.now() - inicio) / 1000;
            log.info(`${etapa}: ${i}/${calls.length} chamadas.`, {
                percentual: `${(feito * 100).toFixed(0)}%`,
                decorridoS: decorrido.toFixed(0),
                faltamS: feito > 0 ? ((decorrido / feito) * (1 - feito)).toFixed(0) : '?',
                chamadasPorSegundo: callsPerSec,
            });
        }
        const lote = calls.slice(i, i + size);
        try {
            // Espera até a taxa permitir ESTE lote. É o que impede a rajada
            // inicial: o custo de um lote é pago em tempo antes de ele sair,
            // não depois.
            const agora = Date.now();
            if (agora < nextAllowedAt) await sleep(nextAllowedAt - agora);
            if (delayMs > 0) await sleep(delayMs);
            if (extraDelayMs > 0) await sleep(extraDelayMs);
            nextAllowedAt = Date.now() + (lote.length / callsPerSec) * 1000;
            results.push(...(await batchEthCall(rpcUrl, lote)));
            i += size;
        } catch (err) {
            if (err instanceof RateLimitedError) {
                if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
                    throw new Error(
                        `RPC recusou ${rateLimitRetries} vezes seguidas, já com lote de ${size} e ` +
                            `${callsPerSec} chamadas/s. Mensagem do provedor: "${err.message}". ` +
                            `Reduza DEX_SCAN_LIMIT, baixe DEX_RPC_CALLS_PER_SEC, ou use um endpoint ` +
                            `com mais capacidade em DEX_RPC_URL.`,
                    );
                }
                rateLimitRetries += 1;
                // Espera crescente antes de repetir ESTE lote, e desaceleração
                // permanente dos seguintes: bater no limite uma vez é sinal de
                // que o ritmo atual não se sustenta pelo resto da varredura.
                const base = rateLimitBaseDelayMs();
                const espera = base * 2 ** (rateLimitRetries - 1);
                // O provedor recusou no ritmo atual, então o ritmo é que está
                // errado: cortar a taxa pela metade ataca a causa, enquanto
                // aumentar a pausa entre lotes só adia o mesmo pico.
                callsPerSec = Math.max(0.5, callsPerSec / 2);
                delayMs = Math.max(delayMs, base);
                // Encolher o lote também: menos chamadas por lote é um pico
                // menor, e cobre o caso de a mensagem ter sido classificada
                // como ritmo quando na verdade era tamanho.
                size = Math.max(1, Math.floor(size / 2));
                nextAllowedAt = 0;
                log.warn('RPC no limite de taxa; esperando e desacelerando a varredura.', {
                    tentativa: rateLimitRetries,
                    esperaMs: espera,
                    ritmoEntreLotesMs: delayMs,
                    tamanhoDoLote: size,
                    chamadasPorSegundo: callsPerSec,
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
    const results = await chunkedEthCall(rpcUrl, calls, undefined, 'Lendo reservas dos pools');

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
    const decimalResults = await chunkedEthCall(
        rpcUrl,
        tokens.map((t) => ({ to: t, data: SELECTORS.decimals })),
        undefined,
        'Lendo decimais dos tokens',
    );
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
        // Estimativa grosseira, mas suficiente para a única pergunta que
        // importa enquanto não sai linha nenhuma: isso é normal ou travou?
        duracaoEstimadaS: Math.round(
            (indices.length * 4) / Math.max(0.5, Number(process.env.DEX_RPC_CALLS_PER_SEC ?? String(DEFAULT_CALLS_PER_SEC))),
        ),
    });

    const addressResults = await chunkedEthCall(
        rpcUrl,
        indices.map((i) => ({ to: factory, data: SELECTORS.allPairs + encodeUint256(i) })),
        undefined,
        'Enumerando endereços de pools',
    );
    return addressResults.map((r) => decodeAddressWord(r, 0));
}

/**
 * Pergunta a VÁRIAS factories pelo MESMO par, via `getPair(tokenA, tokenB)`.
 *
 * É a resposta à topologia que a varredura aleatória mediu: a Uniswap V2 na
 * Base é um grafo estrela — 3 milhões de tokens, cada um pareado só com WETH,
 * nenhum token em dois pools. Nesse grafo não existe triângulo, e amostrar mais
 * pools não muda isso. A única estrutura que ainda fecha ciclo é o mesmo par em
 * duas DEXs diferentes, e achá-la por amostragem é impossível: sortear o mesmo
 * par dos dois lados entre milhões tem probabilidade praticamente zero.
 *
 * Perguntar dirigido custa 1 chamada por (token, factory) e encontra o que a
 * amostragem nunca encontraria.
 */
export async function discoverPairsAcrossFactories(
    rpcUrl: string,
    factories: string[],
    tokens: string[],
    baseToken: string,
): Promise<string[]> {
    const alvos: Array<{ factory: string; token: string }> = [];
    for (const factory of factories) {
        for (const token of tokens) {
            if (token === baseToken) continue;
            alvos.push({ factory, token });
        }
    }
    if (alvos.length === 0) return [];

    const results = await chunkedEthCall(
        rpcUrl,
        alvos.map((a) => ({
            to: a.factory,
            data: SELECTORS.getPair + encodeAddress(a.token) + encodeAddress(baseToken),
        })),
        undefined,
        'Consultando o mesmo par em cada DEX',
    );

    const encontrados: string[] = [];
    const porToken = new Map<string, number>();
    for (let i = 0; i < alvos.length; i++) {
        let endereco: string;
        try {
            endereco = decodeAddressWord(results[i], 0);
        } catch {
            continue; // resposta vazia: par inexistente nessa factory
        }
        if (/^0x0+$/.test(endereco)) continue;
        encontrados.push(endereco);
        porToken.set(alvos[i].token, (porToken.get(alvos[i].token) ?? 0) + 1);
    }

    if (encontrados.length === 0) {
        // Zero resultados tem duas causas com ações opostas, e sem distinguir
        // as duas o operador procuraria no lugar errado.
        throw new Error(
            `Nenhuma factory conhece nenhum dos ${tokens.length} tokens pareado com o token base. ` +
                `Ou os tokens/factories informados não têm esses pares, ou o seletor de getPair está errado ` +
                `para estas factories. Confira um par que você SABE que existe (ex.: WETH/USDC na DEX principal).`,
        );
    }

    // Verificação do seletor com um par que voltou: se getPair estivesse
    // errado, o "endereço" seria lixo e não responderia factory().
    const [factoryDoPrimeiro] = await batchEthCall(rpcUrl, [{ to: encontrados[0], data: SELECTORS.factory }]);
    let confere = false;
    try {
        confere = factories.includes(decodeAddressWord(factoryDoPrimeiro, 0));
    } catch {
        confere = false;
    }
    if (!confere) {
        throw new Error(
            `getPair devolveu ${encontrados[0]}, mas esse endereço não se declara criado por nenhuma das ` +
                `factories informadas. O seletor de getPair provavelmente não corresponde a estas factories — ` +
                `pare aqui em vez de medir sobre endereço não confirmado.`,
        );
    }

    const emDuasOuMais = Array.from(porToken.values()).filter((n) => n > 1).length;
    log.info('Pares encontrados por consulta dirigida.', {
        consultas: alvos.length,
        paresEncontrados: encontrados.length,
        tokensPresentesEmDuasOuMaisDEXs: emDuasOuMais,
        nota:
            emDuasOuMais === 0
                ? 'Nenhum token existe em duas DEXs ao mesmo tempo — sem isso não há ciclo de 2 pools.'
                : 'São estes que podem fechar ciclo entre DEXs.',
    });
    return Array.from(new Set(encontrados));
}

/**
 * Descobre os TOKENS negociados nos pools de uma factory.
 *
 * Existe para tirar do operador uma tarefa que a máquina faz melhor. Pedir
 * "os endereços de USDC, cbBTC e DAI" transfere para quem opera um trabalho de
 * garimpo em explorador de blocos, com risco de colar o endereço errado — e
 * endereço errado não estoura, vira medição de outro token.
 *
 * Os pools MAIS ANTIGOS de uma factory são os pares principais: foram os
 * primeiros criados, e são justamente os que têm chance de existir também em
 * outra DEX. É o oposto do modo `newest`, que a medição mostrou ser lixo.
 */
export async function discoverTokensFromFactory(
    rpcUrl: string,
    factory: string,
    baseToken: string,
    limite: number,
): Promise<string[]> {
    const pools = (await discoverPoolAddresses(rpcUrl, factory)).slice(0, limite);
    if (pools.length === 0) return [];

    const calls: RpcCall[] = [];
    for (const p of pools) {
        calls.push({ to: p, data: SELECTORS.token0 });
        calls.push({ to: p, data: SELECTORS.token1 });
    }
    const results = await chunkedEthCall(rpcUrl, calls, undefined, 'Lendo tokens dos pools principais');

    const tokens = new Set<string>();
    for (let i = 0; i < pools.length; i++) {
        for (const idx of [i * 2, i * 2 + 1]) {
            try {
                const t = decodeAddressWord(results[idx], 0);
                // O token base é o eixo do grafo: pedir getPair(base, base) não
                // faz sentido, e ele já entra em todo par por construção.
                if (t !== baseToken && !/^0x0+$/.test(t)) tokens.add(t);
            } catch {
                // Pool que não responde token0/token1 já é descartado adiante.
            }
        }
    }
    log.info('Tokens extraídos dos pools principais da primeira factory.', {
        poolsLidos: pools.length,
        tokensDistintos: tokens.size,
        nota: 'São estes que serão perguntados a cada DEX. Nenhum endereço veio de fora.',
    });
    return Array.from(tokens);
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
    // Tokens estabelecidos, fornecidos por quem roda. É a entrada da busca
    // dirigida entre DEXs — o que a amostragem aleatória não consegue achar.
    const crossTokens = (process.env.DEX_TOKENS ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
    // Lista, não endereço único: arbitragem entre DEXs é a estrutura que mais
    // produz ciclo on-chain, e ela exige pools de FACTORIES diferentes. Dentro
    // de uma factory só, o mesmo par existe uma vez — não há o que comparar.
    let factories = (process.env.DEX_FACTORY ?? '')
        .split(',')
        .map((f) => f.trim().toLowerCase())
        .filter((f) => f.length > 0);
    const feeFraction = new Decimal(process.env.DEX_POOL_FEE ?? '0.003');
    const flashLoanFee = new Decimal(process.env.FLASH_LOAN_FEE ?? '0.0005'); // Aave V3; Balancer = 0
    const gasUnits = new Decimal(process.env.DEX_GAS_UNITS ?? String(DEFAULT_GAS_UNITS));

    if (explicitPools.length === 0 && factories.length === 0 && !seedPool && crossTokens.length === 0) {
        log.error('Defina DEX_SEED_POOL (mais simples), DEX_FACTORY ou DEX_POOLS.', {
            maisSimples:
                'DEX_SEED_POOL=0x... — um endereço de pool qualquer da DEX. A factory é descoberta a partir dele via factory().',
            porque:
                'Nenhum endereço vem embutido de propósito: endereço errado não estoura, vira número plausível e errado no relatório.',
            varreduraAmpla:
                'DEX_FACTORY=0x...,0x... — enumera pools de UMA OU MAIS factories. Duas DEXs diferentes é o que permite arbitragem entre elas; uma só raramente fecha ciclo.',
            enderecosEspecificos:
                'DEX_POOLS=0xabc...,0xdef... — quando você já sabe quais pools quer conferir. Precisam ser de produto constante (V2), não V3.',
            entreDexs:
                'DEX_TOKENS=0xUSDC,0xcbBTC + DEX_FACTORY=0xUmaDEX,0xOutraDEX — pergunta a cada DEX pelo MESMO par. É o modo com chance real de fechar ciclo.',
        });
        process.exit(1);
    }

    log.info('Lendo pools on-chain (nenhuma transação será enviada).', {
        rpc: rpcUrl,
        modo: factories.length > 0 ? `descoberta via ${factories.length} factory(s)` : seedPool ? 'descoberta via pool semente' : 'lista explícita',
        tokenBase: baseToken,
        taxaPool: feeFraction.toString(),
        taxaFlashLoan: flashLoanFee.toString(),
    });

    if (factories.length === 0 && seedPool) {
        factories = [await discoverFactoryFromPool(rpcUrl, seedPool)];
    }
    const descobertos: string[] = [];
    // Com DUAS OU MAIS factories, o modo padrão passa a ser a busca dirigida:
    // varrer pools de cada uma separadamente e torcer para o mesmo par cair na
    // amostra dos dois lados tem probabilidade praticamente zero. Os tokens
    // saem dos pools mais antigos da primeira factory quando não forem dados.
    let tokensParaCruzar = crossTokens;
    if (tokensParaCruzar.length === 0 && factories.length > 1) {
        // Os pares principais são os PRIMEIROS criados numa factory, e são os
        // únicos com chance real de existir também em outra DEX. `newest` traz
        // lançamentos que só existem num lugar — foi o que a medição mostrou.
        if (!process.env.DEX_SCAN_MODE) process.env.DEX_SCAN_MODE = 'oldest';
        tokensParaCruzar = await discoverTokensFromFactory(
            rpcUrl,
            factories[0],
            baseToken,
            Number(process.env.DEX_CROSS_SEED_POOLS ?? '60'),
        );
    }
    if (tokensParaCruzar.length > 0) {
        // Busca dirigida substitui a varredura: enumerar milhões de pools para
        // encontrar por acaso o mesmo par em duas DEXs é impossível, enquanto
        // perguntar por ele custa uma chamada.
        descobertos.push(...(await discoverPairsAcrossFactories(rpcUrl, factories, tokensParaCruzar, baseToken)));
    } else {
        for (const f of factories) {
            descobertos.push(...(await discoverPoolAddresses(rpcUrl, f)));
        }
    }
    const poolAddresses =
        factories.length > 0
            ? Array.from(new Set([...explicitPools, ...(seedPool ? [seedPool] : []), ...descobertos]))
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
        // Zero ciclos não diz se o problema é o token base, a escolha dos pools
        // ou a topologia — e a ação certa é diferente em cada caso. O censo
        // abaixo distingue os três.
        const tokens = new Set<string>();
        let tocamBase = 0;
        const paresPorToken = new Map<string, number>();
        for (const p of pools) {
            tokens.add(p.token0);
            tokens.add(p.token1);
            if (p.token0 === baseToken || p.token1 === baseToken) tocamBase += 1;
            for (const t of [p.token0, p.token1]) {
                if (t !== baseToken) paresPorToken.set(t, (paresPorToken.get(t) ?? 0) + 1);
            }
        }
        const tokensComMaisDeUmPool = Array.from(paresPorToken.values()).filter((n) => n > 1).length;
        // Proporcional, não exato: um único pool fora do padrão não muda o
        // fato de o grafo ser uma estrela. Exigir 100% fez o diagnóstico certo
        // não aparecer justamente na medição que o comprovou (386 de 387).
        const todosContraBase = tocamBase >= pools.length * 0.95 && tokensComMaisDeUmPool === 0;

        log.warn('Nenhum ciclo fechado entre os pools carregados.', {
            pools: pools.length,
            tokensDistintos: tokens.size,
            poolsQueTocamOTokenBase: tocamBase,
            tokensPresentesEmMaisDeUmPool: tokensComMaisDeUmPool,
            diagnostico: todosContraBase
                ? 'Todos os pools pareiam contra o token base e nenhum token aparece em dois pools. ' +
                  'Numa única factory isso NUNCA fecha ciclo: cada par existe uma vez só, então não há ' +
                  'segundo caminho de volta. É o retrato típico dos pools mais recentes, que são lançamentos TOKEN/WETH.'
                : 'Os pools carregados não compartilham tokens suficientes para fechar um ciclo.',
            saidas: [
                'DEX_TOKENS=0xUSDC,0xcbBTC + DEX_FACTORY=0xUmaDEX,0xOutraDEX — pergunta dirigida pelo MESMO par em cada DEX. É o único modo com chance real aqui.',
                'DEX_SCAN_LIMIT maior NÃO resolve grafo estrela: mais pools trazem mais tokens únicos, não mais conexões.',
            ],
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
    /**
     * Oportunidades DISTINTAS, indexadas pelo ciclo.
     *
     * Somar cada avistamento inflaria a projeção pelo número de varreduras: uma
     * oportunidade parada que ninguém executa aparece em toda leitura e viraria
     * "dezenas por hora". O que interessa é quantas oportunidades DIFERENTES
     * surgiram, e por quanto tempo cada uma sobreviveu.
     */
    const vistas = new Map<string, { lucro: Decimal; varreduras: number; avisada: boolean }>();
    const startedAt = Date.now();
    // Câmbio só para traduzir a projeção; não entra em decisão nenhuma.
    const brlPorUsd = new Decimal(process.env.BRL_POR_USD ?? '5.5');

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
        // Só o que é LUCRATIVO entra na projeção. Somar margem negativa
        // "quase lá" inventaria um ganho que nenhuma execução produziria.
        let somaDaVarredura = new Decimal(0);
        /** Ciclos lucrativos DESTA varredura, para medir persistência. */
        const lucrativosDaVarredura = new Map<string, Decimal>();

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
                somaDaVarredura = somaDaVarredura.plus(evaluation.netProfit);
                lucrativosDaVarredura.set(describeCycle(cycle), evaluation.netProfit);
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
        // Ciclos que sumiram nesta varredura deixam de acumular persistência.
        for (const [chave, registro] of vistas) {
            if (!lucrativosDaVarredura.has(chave)) registro.varreduras = 0;
        }
        for (const [chave, lucro] of lucrativosDaVarredura) {
            const anterior = vistas.get(chave);
            if (!anterior) {
                vistas.set(chave, { lucro, varreduras: 1, avisada: false });
                continue;
            }
            anterior.varreduras += 1;
            if (lucro.greaterThan(anterior.lucro)) anterior.lucro = lucro;
            if (anterior.varreduras >= PERSISTENCIA_SUSPEITA && !anterior.avisada) {
                anterior.avisada = true;
                log.warn('OPORTUNIDADE PARADA — trate como armadilha até provar o contrário.', {
                    ciclo: chave,
                    varredurasSeguidas: anterior.varreduras,
                    porque:
                        'Uma margem de verdade nesta rede é tomada em um ou dois blocos. Sobreviver minutos ' +
                        'significa que algo impede a extração, e o candidato mais comum é token com taxa de ' +
                        'transferência ou trava de venda: a matemática de produto constante assume que se recebe ' +
                        'exatamente o que a fórmula diz, e um token que cobra na transferência quebra isso.',
                    antesDeExecutar:
                        'Confira o contrato do token no explorador — taxa de transferência, blacklist, pausa. ' +
                        'A transação reverte se o lucro não sair, então o custo de tentar é o gás; mas tentar ' +
                        'repetidamente numa armadilha é queimar gás em série.',
                });
            }
        }
        if (bestNet.greaterThan(bestEverNet)) {
            bestEverNet = bestNet;
            bestEverDescription = bestDescription;
        }

        const horas = (Date.now() - startedAt) / 3_600_000;
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
            horasObservando: horas.toFixed(2),
            // Traduz a observação para a pergunta que realmente se quer
            // responder. Sem isto, "melhor líquido 0,00012 ETH" não diz se a
            // meta é alcançável ou está a três ordens de grandeza de distância.
            ...(horas > 0.02
                ? (() => {
                      const distintas = Array.from(vistas.values());
                      const soma = distintas.reduce((acc, v) => acc.plus(v.lucro), new Decimal(0));
                      const paradas = distintas.filter((v) => v.varreduras >= PERSISTENCIA_SUSPEITA).length;
                      return {
                          oportunidadesDISTINTAS: distintas.length,
                          dasQuaisParadas: `${paradas} (persistem há ${PERSISTENCIA_SUSPEITA}+ varreduras)`,
                          somaDosLucrosDistintos: `${soma.toFixed(8)} (unidade do token base)`,
                          projecaoPorDia: `${soma.dividedBy(horas).mul(24).toFixed(8)} por dia no ritmo observado`,
                          aviso:
                              'Conta oportunidades DISTINTAS, não avistamentos: uma margem parada aparece em toda ' +
                              'varredura e inflaria a projeção pelo número de leituras. Ainda assim é projeção ' +
                              'linear de janela curta, e a disputa consome a maior parte na execução.',
                      };
                  })()
                : {}),
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
