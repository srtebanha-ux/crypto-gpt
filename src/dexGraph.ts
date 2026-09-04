// Arquivo: src/dexGraph.ts
//
// Monta o grafo de pools e enumera ciclos de arbitragem.
//
// A parte perigosa aqui não é achar os ciclos — é ORIENTAR as reservas. Cada
// pool guarda (reserve0, reserve1) numa ordem fixa por endereço de token, mas
// um swap tem direção: ao ir de A para B, reserveIn é a reserva de A e
// reserveOut é a de B; ao ir de B para A, é o contrário. Trocar isso não gera
// exceção nenhuma — gera um preço invertido, que atravessa a otimização e sai
// como "arbitragem enorme" no relatório. É o mesmo modo de falha que o resto
// deste projeto trata como inaceitável, então a orientação tem teste próprio.
//
// Sem I/O: funções puras sobre dados já lidos da rede.
import { Decimal } from 'decimal.js';
import type { Hop } from './ammMath';

export interface PoolInfo {
    address: string;
    /** Endereço do token0, minúsculo (ordem definida pelo contrato do pool). */
    token0: string;
    token1: string;
    /** Reservas JÁ normalizadas para unidade humana (ver fromRawUnits). */
    reserve0: Decimal;
    reserve1: Decimal;
    feeFraction: Decimal;
}

/** Um ciclo: sequência de pools que sai de um token e volta a ele. */
export interface Cycle {
    /** Token de partida e de chegada. */
    startToken: string;
    /** Pools na ordem em que são atravessados. */
    pools: PoolInfo[];
    /** Tokens visitados, em ordem: [start, t1, t2, ..., start]. */
    path: string[];
}

/** O outro token do pool, dado um deles. Null se o token não pertence ao pool. */
export function counterToken(pool: PoolInfo, token: string): string | null {
    const t = token.toLowerCase();
    if (pool.token0 === t) return pool.token1;
    if (pool.token1 === t) return pool.token0;
    return null;
}

/**
 * Orienta as reservas do pool para um swap na direção `tokenIn -> tokenOut`.
 *
 * É aqui que a inversão silenciosa aconteceria. A função não aceita ambiguidade:
 * se o token de entrada não pertence ao pool, ela lança em vez de escolher uma
 * orientação arbitrária.
 */
export function hopFor(pool: PoolInfo, tokenIn: string): Hop {
    const t = tokenIn.toLowerCase();
    if (pool.token0 === t) {
        return { reserveIn: pool.reserve0, reserveOut: pool.reserve1, feeFraction: pool.feeFraction };
    }
    if (pool.token1 === t) {
        return { reserveIn: pool.reserve1, reserveOut: pool.reserve0, feeFraction: pool.feeFraction };
    }
    throw new Error(`Token ${tokenIn} não pertence ao pool ${pool.address} (${pool.token0}/${pool.token1}).`);
}

/** Traduz um ciclo em hops orientados, prontos para a matemática de AMM. */
export function hopsForCycle(cycle: Cycle): Hop[] {
    const hops: Hop[] = [];
    let current = cycle.startToken.toLowerCase();
    for (const pool of cycle.pools) {
        hops.push(hopFor(pool, current));
        const next = counterToken(pool, current);
        if (next === null) {
            throw new Error(`Ciclo inconsistente: ${current} não pertence ao pool ${pool.address}.`);
        }
        current = next;
    }
    if (current !== cycle.startToken.toLowerCase()) {
        throw new Error(`Ciclo não fecha: partiu de ${cycle.startToken} e terminou em ${current}.`);
    }
    return hops;
}

/** Índice token -> pools que o contêm, para não varrer a lista inteira por hop. */
function buildTokenIndex(pools: PoolInfo[]): Map<string, PoolInfo[]> {
    const index = new Map<string, PoolInfo[]>();
    for (const pool of pools) {
        for (const token of [pool.token0, pool.token1]) {
            const list = index.get(token);
            if (list) list.push(pool);
            else index.set(token, [pool]);
        }
    }
    return index;
}

/**
 * Enumera ciclos triangulares (3 pools) que partem e voltam a `startToken`.
 *
 * Só triângulos de propósito: cada hop adicional cobra mais uma taxa de pool
 * (0,3% no padrão V2), então ciclos mais longos precisam de um desalinhamento
 * proporcionalmente maior para valer a pena. Se não houver oportunidade em 3
 * hops, ciclos de 4 são ainda menos prováveis — e o espaço de busca explode.
 *
 * AS DUAS DIREÇÕES SÃO RETORNADAS, e isso não é redundância: percorrer
 * A->B->C->A e A->C->B->A são operações diferentes. Se o ativo está caro no
 * pool 2 e barato no pool 1, só um dos sentidos dá lucro — o outro dá
 * prejuízo. Deduplicar por conjunto de pools (ignorando a ordem) descartaria
 * metade das oportunidades, e nada no relatório denunciaria a perda: sairia
 * "nenhum ciclo lucrativo" com a mesma cara de um mercado sem oportunidade.
 *
 * A chave canônica preserva a ORDEM justamente por isso — ela existe só para
 * não emitir a mesma rota, no mesmo sentido, duas vezes.
 */
export function findTriangularCycles(pools: PoolInfo[], startToken: string): Cycle[] {
    const start = startToken.toLowerCase();
    const index = buildTokenIndex(pools);
    const cycles: Cycle[] = [];
    const seen = new Set<string>();

    for (const poolA of index.get(start) ?? []) {
        const tokenB = counterToken(poolA, start)!;
        for (const poolB of index.get(tokenB) ?? []) {
            if (poolB.address === poolA.address) continue;
            const tokenC = counterToken(poolB, tokenB)!;
            // Um "triângulo" que volta ao início no 2º hop é um par de pools
            // do mesmo par de tokens, não um triângulo.
            if (tokenC === start) continue;
            for (const poolC of index.get(tokenC) ?? []) {
                if (poolC.address === poolA.address || poolC.address === poolB.address) continue;
                if (counterToken(poolC, tokenC) !== start) continue;

                // Chave preservando a ORDEM: os dois sentidos do triângulo são
                // ciclos distintos e ambos precisam ser avaliados. Ordenar
                // aqui descartaria silenciosamente metade das oportunidades.
                const key = [poolA.address, poolB.address, poolC.address].join('|');
                if (seen.has(key)) continue;
                seen.add(key);

                cycles.push({
                    startToken: start,
                    pools: [poolA, poolB, poolC],
                    path: [start, tokenB, tokenC, start],
                });
            }
        }
    }

    return cycles;
}

/**
 * Enumera ciclos de 2 pools: mesmo par de tokens em DEXs (ou faixas de taxa)
 * diferentes. É a forma mais simples e mais comum de arbitragem on-chain —
 * dois pools do mesmo par que discordam de preço — e paga só duas taxas em
 * vez de três, então o piso de desalinhamento é bem menor que o do triângulo.
 *
 * Devolve OS DOIS sentidos de cada par de pools. Qual deles dá lucro depende
 * de onde o ativo está caro, o que só a avaliação de tamanho responde — e
 * emitir apenas um sentido, escolhido pela ordem em que os pools apareceram,
 * acertaria por sorte metade das vezes.
 */
export function findTwoPoolCycles(pools: PoolInfo[], startToken: string): Cycle[] {
    const start = startToken.toLowerCase();
    const index = buildTokenIndex(pools);
    const cycles: Cycle[] = [];
    const seen = new Set<string>();

    const candidates = index.get(start) ?? [];
    for (const poolA of candidates) {
        const other = counterToken(poolA, start)!;
        for (const poolB of candidates) {
            if (poolB.address === poolA.address) continue;
            if (counterToken(poolB, start) !== other) continue;

            // Ordem preservada: vender no pool A e recomprar no B é o oposto
            // de vender no B e recomprar no A — só um dos dois dá lucro.
            const key = [poolA.address, poolB.address].join('|');
            if (seen.has(key)) continue;
            seen.add(key);

            cycles.push({ startToken: start, pools: [poolA, poolB], path: [start, other, start] });
        }
    }

    return cycles;
}
