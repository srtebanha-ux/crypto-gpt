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
// por quem roda (DEX_POOLS), e cada um é VERIFICADO na leitura: se não
// responder como um pool de produto constante, o relatório diz qual falhou e
// por quê, em vez de silenciosamente ignorar.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { evaluateCycle, cycleSpotRatio } from './ammMath';
import { findTriangularCycles, findTwoPoolCycles, hopsForCycle, type Cycle, type PoolInfo } from './dexGraph';
import { SELECTORS, decodeAddressWord, decodeDecimals, decodeReserves, decodeUintWord, fromRawUnits } from './evmAbi';

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
async function batchEthCall(rpcUrl: string, calls: RpcCall[]): Promise<string[]> {
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
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${await res.text()}`);

    const body = (await res.json()) as Array<{ id: number; result?: string; error?: { message: string } }>;
    if (!Array.isArray(body)) {
        throw new Error(`RPC não devolveu lote (o endpoint pode não suportar batch): ${JSON.stringify(body).slice(0, 300)}`);
    }

    const byId = new Map(body.map((r) => [r.id, r]));
    return payload.map((p) => {
        const r = byId.get(p.id);
        if (!r) throw new Error(`RPC não devolveu resposta para a chamada ${p.id}.`);
        if (r.error) throw new Error(`RPC erro na chamada ${p.id}: ${r.error.message}`);
        return r.result ?? '0x';
    });
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
async function loadPools(rpcUrl: string, addresses: string[], feeFraction: Decimal): Promise<PoolInfo[]> {
    const calls: RpcCall[] = [];
    for (const address of addresses) {
        calls.push({ to: address, data: SELECTORS.token0 });
        calls.push({ to: address, data: SELECTORS.token1 });
        calls.push({ to: address, data: SELECTORS.getReserves });
    }
    const results = await batchEthCall(rpcUrl, calls);

    const raw: Array<{ address: string; token0: string; token1: string; r0: Decimal; r1: Decimal }> = [];
    for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        try {
            const token0 = decodeAddressWord(results[i * 3], 0);
            const token1 = decodeAddressWord(results[i * 3 + 1], 0);
            const reserves = decodeReserves(results[i * 3 + 2]);
            if (reserves.reserve0.lessThanOrEqualTo(0) || reserves.reserve1.lessThanOrEqualTo(0)) {
                log.warn(`Pool ${address} tem reserva zerada — descartado (pool morto ou recém-criado).`);
                continue;
            }
            raw.push({ address, token0, token1, r0: reserves.reserve0, r1: reserves.reserve1 });
        } catch (err) {
            log.error(`Pool ${address} NÃO respondeu como pool de produto constante — descartado.`, {
                erro: err instanceof Error ? err.message : String(err),
                nota: 'Confira o endereço. Pool V3 (liquidez concentrada) não expõe getReserves() e não serve aqui.',
            });
        }
    }

    // Decimais de cada token: sem normalizar, comparar USDC (6 casas) com WETH
    // (18) erra por 1e12 — e o erro sai como "arbitragem gigante".
    const tokens = Array.from(new Set(raw.flatMap((p) => [p.token0, p.token1])));
    const decimalResults = await batchEthCall(rpcUrl, tokens.map((t) => ({ to: t, data: SELECTORS.decimals })));
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

function describeCycle(cycle: Cycle): string {
    return cycle.path.map((t) => t.slice(0, 6)).join('->') + ` [${cycle.pools.map((p) => p.address.slice(0, 8)).join(', ')}]`;
}

async function main() {
    const rpcUrl = process.env.DEX_RPC_URL ?? DEFAULT_RPC_URL;
    const baseToken = (process.env.DEX_BASE_TOKEN ?? DEFAULT_BASE_TOKEN).toLowerCase();
    const poolAddresses = (process.env.DEX_POOLS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    const feeFraction = new Decimal(process.env.DEX_POOL_FEE ?? '0.003');
    const flashLoanFee = new Decimal(process.env.FLASH_LOAN_FEE ?? '0.0005'); // Aave V3; Balancer = 0
    const gasUnits = new Decimal(process.env.DEX_GAS_UNITS ?? String(DEFAULT_GAS_UNITS));

    if (poolAddresses.length === 0) {
        log.error('Defina DEX_POOLS com os endereços dos pools, separados por vírgula.', {
            porque:
                'Nenhum endereço vem embutido de propósito: endereço errado não estoura, vira número plausível e errado no relatório.',
            comoObter:
                'Pegue os pools de maior liquidez na interface da DEX (Aerodrome/Uniswap na Base) ou no Basescan. Precisam ser pools de produto constante (V2), não V3.',
            exemplo: 'DEX_POOLS=0xabc...,0xdef... npm run sniff-dex',
        });
        process.exit(1);
    }

    log.info('Lendo pools on-chain (nenhuma transação será enviada).', {
        rpc: rpcUrl,
        pools: poolAddresses.length,
        tokenBase: baseToken,
        taxaPool: feeFraction.toString(),
        taxaFlashLoan: flashLoanFee.toString(),
    });

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

    let profitableCount = 0;
    let bestNet = new Decimal(0);
    let bestDescription = 'nenhum';

    for (const cycle of cycles) {
        const hops = hopsForCycle(cycle);
        const spot = cycleSpotRatio(hops);
        const smallestReserveIn = hops.reduce((min, h) => (h.reserveIn.lessThan(min) ? h.reserveIn : min), hops[0].reserveIn);
        const maxAmountIn = smallestReserveIn.mul(maxFraction);

        const evaluation = evaluateCycle(hops, maxAmountIn, {
            flashLoanFeeFraction: flashLoanFee,
            gasCostInToken,
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
            });
        } else {
            log.debug('ciclo sem lucro líquido', {
                ciclo: describeCycle(cycle),
                razaoSpot: spot.toFixed(8),
                lucroLiquido: evaluation.netProfit.toFixed(8),
            });
        }
    }

    log.info('=== RESUMO ===', {
        ciclosAvaliados: cycles.length,
        ciclosLucrativos: profitableCount,
        melhorLucroLiquido: bestNet.toFixed(8),
        melhorCiclo: bestDescription,
        gasPorTentativa: gasCostInToken.toFixed(8),
    });

    log.info('=== COMO LER ===', {
        ponto1: 'Isto é UM instante do mercado. Zero ciclos lucrativos numa leitura não encerra a questão — rode em momentos diferentes, sobretudo em volatilidade.',
        ponto2: 'Ciclo lucrativo aqui NÃO significa lucro capturável: on-chain a inclusão é leiloada (MEV), e searchers profissionais competem entregando o lucro ao validador.',
        ponto3: 'O que este número mede é o piso: se nem o lucro BRUTO aparece, não há o que disputar e não vale escrever o contrato.',
        ponto4: 'Taxa de 0,3% por pool é o pior caso. Faixas menores (0,05%/0,01%) e pools de stablecoin baixam muito o piso — vale medir esses também via DEX_POOL_FEE.',
    });

    process.exit(0);
}

main().catch((err) => {
    log.error('Falha ao medir arbitragem on-chain.', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
