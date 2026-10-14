/**
 * ROTAS DE 2, 3 E 4 SWAPS — e a matematica de CADA tipo de pool.
 *
 * A dona do bot foi explicita: *"Não trate pools stable como V2
 * convencional."* Entao um pool aqui carrega o seu TIPO, e o tipo decide a
 * conta. Nao existe uma formula para todos.
 *
 * TRES TIPOS, e os tres estao MEDIDOS na corrente em 2026-10-14:
 *
 *   v2              Uniswap V2 / SushiSwap / SwapBased / Alien Base.
 *                   Produto constante, taxa 0,3% na entrada. A conta e local e
 *                   exata, espelhando `FlashArb._amountOut` em BigInt — e um
 *                   teste em fork exige igualdade bit a bit com o contrato.
 *   aerodromeVolatil  Produto constante, mas a taxa vem da FABRICA:
 *                   `getFee(pool,false)` devolveu **30** (0,30%).
 *   aerodromeStable   Invariante x³y+y³x=k, taxa `getFee(pool,true)` = **5**
 *                   (0,05%). **Eu NAO reimplemento este invariante.**
 *
 * POR QUE NAO REIMPLEMENTO: o pool da Aerodrome expoe
 * `getAmountOut(uint256,address)` e faz a propria conta. Medido no par
 * WETH/USDC com 0,01 WETH: volatil devolveu 24.215.310 e stable 24.222.112.
 * Reescrever o invariante aqui seria uma copia que o pool desmente — e este
 * projeto ja pagou por "a copia prova a copia". Entao a cotacao de hop
 * Aerodrome e PERGUNTADA, e as funcoes locais devolvem `null` para ela em vez
 * de um palpite.
 *
 * O QUE ISTO NAO RESOLVE, declarado: `FlashArb._venderNoOutroPool` calcula a
 * saida com a formula V2. Usar um pool Aerodrome como perna de VENDA com o
 * contrato atual produziria conta errada — e por isso o executor de N pernas
 * (`contracts/FlashArbN.sol`) pergunta ao pool quando o hop e Aerodrome.
 */
import { saidaCrua, entradaNecessariaCrua } from './ammMath';

export type TipoDePool = 'v2' | 'aerodromeVolatil' | 'aerodromeStable';

export interface PoolParaRota {
    endereco: string;
    token0: string;
    token1: string;
    reserva0: bigint;
    reserva1: bigint;
    tipo: TipoDePool;
    /**
     * Taxa em por dez mil. 30 = 0,30%. MEDIDA por pool: a V2 canonica e 30, e
     * a Aerodrome responde pela fabrica (`getFee`), que deu 30 e 5.
     */
    taxaPorDezMil: number;
    /** De qual fabrica veio. Rota dentro de uma fabrica so nao fecha ciclo. */
    fabrica: string;
}

/** Um passo da rota: por qual pool, de qual token para qual. */
export interface Hop {
    pool: PoolParaRota;
    de: string;
    para: string;
}

export interface Rota {
    /** Os hops, em ordem. 2, 3 ou 4. */
    hops: Hop[];
    /** O token em que a rota comeca e termina. */
    token: string;
    /** Quantos pools DISTINTOS. Rota que repete pool trava no reentrancy. */
    poolsDistintos: number;
}

/**
 * A SAIDA DE UM HOP, quando da para calcular localmente.
 *
 * `null` para hop Aerodrome: a conta e do pool, e inventa-la seria o defeito
 * que esta docstring de arquivo descreve. Quem precisa do numero pergunta.
 */
export function saidaDoHop(h: Hop, entrada: bigint): bigint | null {
    if (h.pool.tipo !== 'v2' && h.pool.tipo !== 'aerodromeVolatil') return null;
    const daEntrada = h.pool.token0 === h.de ? h.pool.reserva0 : h.pool.reserva1;
    const daSaida = h.pool.token0 === h.de ? h.pool.reserva1 : h.pool.reserva0;
    // A TAXA DO POOL entra aqui, e nao uma constante global: `saidaCrua`
    // embute 997/1000, que e a V2 canonica. Para taxa diferente a conta tem
    // de usar a taxa do pool, senao o numero sai errado para o pool certo.
    if (h.pool.taxaPorDezMil === 30) return saidaCrua(entrada, daEntrada, daSaida);
    if (daEntrada <= 0n || daSaida <= 0n || entrada <= 0n) return null;
    const g = BigInt(10_000 - h.pool.taxaPorDezMil);
    const comTaxa = entrada * g;
    return (comTaxa * daSaida) / (daEntrada * 10_000n + comTaxa);
}

/**
 * A ENTRADA necessaria num hop para obter `saida`, arredondada PARA CIMA.
 *
 * E o numero que o flash swap EXIGE de volta na primeira perna. Para baixo
 * aprova o que o pool recusa — e o `+1` de `entradaNecessariaCrua` existe por
 * isso.
 */
export function entradaDoHop(h: Hop, saida: bigint): bigint | null {
    if (h.pool.tipo !== 'v2' && h.pool.tipo !== 'aerodromeVolatil') return null;
    const daEntrada = h.pool.token0 === h.de ? h.pool.reserva0 : h.pool.reserva1;
    const daSaida = h.pool.token0 === h.de ? h.pool.reserva1 : h.pool.reserva0;
    if (h.pool.taxaPorDezMil === 30) return entradaNecessariaCrua(saida, daEntrada, daSaida);
    if (daEntrada <= 0n || daSaida <= 0n || saida <= 0n || saida >= daSaida) return null;
    const g = BigInt(10_000 - h.pool.taxaPorDezMil);
    return (daEntrada * saida * 10_000n) / ((daSaida - saida) * g) + 1n;
}

/**
 * Percorre a rota: entra com `entrada` no primeiro hop e devolve o que sai do
 * ultimo. `null` quando qualquer hop nao calcula localmente.
 *
 * `cotarFora` permite que o chamador resolva os hops que a conta local recusa
 * — e a porta pela qual a Aerodrome entra, PERGUNTANDO ao pool.
 */
export function percorrer(
    r: Rota, entrada: bigint,
    cotarFora?: (h: Hop, entrada: bigint) => bigint | null,
): bigint | null {
    let valor = entrada;
    for (const h of r.hops) {
        const local = saidaDoHop(h, valor);
        const proximo = local ?? (cotarFora ? cotarFora(h, valor) : null);
        if (proximo === null || proximo <= 0n) return null;
        valor = proximo;
    }
    return valor;
}

/**
 * A SOBRA de executar a rota como FLASH SWAP pelo primeiro pool.
 *
 * O desenho e o mesmo que a ENTREGA 1 provou, generalizado: empresta `quantia`
 * do token de entrada do hop 0, percorre os hops 1..n-1, e devolve ao pool do
 * hop 0 o que ele exige — em unidades do token que ele recebe.
 *
 * E o lucro sobra NO TOKEN DEVOLVIDO, nao no emprestado. Essa troca custou uma
 * reversao real em fork na ENTREGA 1, e aqui ela esta no desenho.
 */
export function sobraDaRota(
    r: Rota, quantia: bigint,
    cotarFora?: (h: Hop, entrada: bigint) => bigint | null,
): { recebido: bigint; devido: bigint; sobra: bigint } | null {
    if (r.hops.length < 2) return null;
    const primeiro = r.hops[0]!;
    // As pernas de VENDA: do hop 1 ao fim. O hop 0 e o emprestimo.
    const vendas: Rota = { ...r, hops: r.hops.slice(1) };
    const recebido = percorrer(vendas, quantia, cotarFora);
    if (recebido === null) return null;
    // O PAGAMENTO: quanto do token devolvido o pool do hop 0 exige para ter
    // soltado `quantia` do token emprestado.
    const inverso: Hop = { pool: primeiro.pool, de: primeiro.para, para: primeiro.de };
    const devido = entradaDoHop(inverso, quantia);
    if (devido === null) return null;
    return { recebido, devido, sobra: recebido - devido };
}

/** O teto de tamanho: fracao da reserva do token emprestado. */
export function tetoDaRota(r: Rota): bigint {
    const h = r.hops[0]!;
    const daSaida = h.pool.token0 === h.de ? h.pool.reserva1 : h.pool.reserva0;
    return daSaida / 3n;
}

/**
 * O TAMANHO OTIMO por busca ternaria sobre a FUNCAO QUE DECIDE.
 *
 * Ternaria e nao formula fechada porque a sobra inclui a divisao inteira com
 * `+1` do pagamento, e a formula fechada ignora esse arredondamento — aprovando
 * um tamanho que a conta do contrato recusa.
 */
export function melhorTamanhoDaRota(
    r: Rota, passos = 50,
    cotarFora?: (h: Hop, entrada: bigint) => bigint | null,
): { quantia: bigint; sobra: bigint; recebido: bigint; devido: bigint } | null {
    const teto = tetoDaRota(r);
    if (teto <= 0n) return null;
    const em = (q: bigint): bigint => {
        const s = sobraDaRota(r, q, cotarFora);
        return s === null ? -1n : s.sobra;
    };
    let baixo = 1n;
    let alto = teto;
    for (let i = 0; i < passos && alto - baixo > 1n; i += 1) {
        const a = baixo + (alto - baixo) / 3n;
        const b = alto - (alto - baixo) / 3n;
        if (em(a) < em(b)) baixo = a + 1n; else alto = b;
    }
    let melhor = baixo;
    let melhorSobra = em(baixo);
    for (const q of [alto, (baixo + alto) / 2n]) {
        const s = em(q);
        if (s > melhorSobra) { melhor = q; melhorSobra = s; }
    }
    const s = sobraDaRota(r, melhor, cotarFora);
    if (s === null) return null;
    return { quantia: melhor, ...s };
}

/** Quantos swaps a rota tem. Nome proprio porque e o criterio da entrega. */
export const TAMANHOS_DE_ROTA = [2, 3, 4] as const;

/**
 * ACHA as rotas que comecam e terminam em `tokenBase`, de 2 a 4 swaps.
 *
 * O grafo e de TOKENS, e as arestas sao pools. Uma rota e um ciclo que sai do
 * token base e volta a ele.
 *
 * DUAS REGRAS que vem de defeito medido:
 *
 *   - pool REPETIDO na rota e proibido. Na ENTREGA 1 o mesmo pool nas duas
 *     pernas reverteu com `UniswapV2: LOCKED`, o guard de reentrancia — e nao
 *     era arbitragem, era um teste que nao testava nada.
 *   - o primeiro hop e o EMPRESTIMO, e precisa de um pool que suporte flash
 *     swap. `podeEmprestar` decide isso, e so o chamador sabe: Aerodrome tem
 *     `swap` com a mesma assinatura mas callback de outro nome, e supor que
 *     atende seria reversao paga.
 */
export function acharRotas(
    pools: PoolParaRota[],
    tokenBase: string,
    opcoes: {
        maxHops?: 2 | 3 | 4;
        /** Quais pools podem ser a perna de EMPRESTIMO. */
        podeEmprestar?: (p: PoolParaRota) => boolean;
        /** Teto de rotas devolvidas, para o custo nao explodir. */
        teto?: number;
    } = {},
): Rota[] {
    const maxHops = opcoes.maxHops ?? 4;
    const teto = opcoes.teto ?? 20_000;
    const podeEmprestar = opcoes.podeEmprestar ?? (() => true);
    const base = tokenBase.toLowerCase();

    // Arestas por token: token -> [{pool, outro}]
    const porToken = new Map<string, Array<{ pool: PoolParaRota; outro: string }>>();
    for (const p of pools) {
        if (p.reserva0 <= 0n || p.reserva1 <= 0n) continue;
        const a = porToken.get(p.token0) ?? [];
        a.push({ pool: p, outro: p.token1 });
        porToken.set(p.token0, a);
        const b = porToken.get(p.token1) ?? [];
        b.push({ pool: p, outro: p.token0 });
        porToken.set(p.token1, b);
    }

    const fora: Rota[] = [];
    const caminho: Hop[] = [];
    const usados = new Set<string>();

    const andar = (atual: string): void => {
        if (fora.length >= teto) return;
        if (caminho.length >= 2 && atual === base) {
            fora.push({
                hops: [...caminho], token: base,
                poolsDistintos: new Set(caminho.map((h) => h.pool.endereco)).size,
            });
            // NAO para aqui: uma rota de 2 que fecha pode ser prefixo de uma de
            // 3 que fecha melhor, e cortar a busca no primeiro fechamento
            // perderia rotas — era o que o teto de 2 pernas escondia.
        }
        if (caminho.length >= maxHops) return;
        for (const { pool, outro } of porToken.get(atual) ?? []) {
            if (usados.has(pool.endereco)) continue;
            // O PRIMEIRO hop e o emprestimo: so pool que suporta flash swap.
            if (caminho.length === 0 && !podeEmprestar(pool)) continue;
            usados.add(pool.endereco);
            caminho.push({ pool, de: atual, para: outro });
            andar(outro);
            caminho.pop();
            usados.delete(pool.endereco);
        }
    };
    andar(base);
    return fora;
}

/**
 * ELIMINA DUPLICACAO ECONOMICA.
 *
 * A dona do bot pediu por nome: *"Elimine duplicações econômicas."* E a
 * ENTREGA 2 mostrou por que — os tres candidatos "aprovados" partilhavam o pool
 * de venda e o token: eram UMA discrepancia vista de tres angulos, e somar os
 * lucros contava o mesmo dinheiro tres vezes.
 *
 * Duas rotas sao economicamente a MESMA quando usam o mesmo CONJUNTO de pools:
 * a ordem muda o caminho, nao a ineficiencia. De cada conjunto fica a de maior
 * sobra — e a contagem do que foi colapsado sai junto, para o log nao esconder
 * que havia dez vistas do mesmo.
 */
export function semDuplicacaoEconomica<T extends { rota: Rota; sobra: bigint }>(
    avaliadas: T[],
): { unicas: T[]; colapsadas: number } {
    const melhorPorConjunto = new Map<string, T>();
    let colapsadas = 0;
    for (const a of avaliadas) {
        const chave = [...a.rota.hops.map((h) => h.pool.endereco)].sort().join('|');
        const atual = melhorPorConjunto.get(chave);
        if (atual === undefined) { melhorPorConjunto.set(chave, a); continue; }
        colapsadas += 1;
        if (a.sobra > atual.sobra) melhorPorConjunto.set(chave, a);
    }
    return {
        unicas: [...melhorPorConjunto.values()].sort(
            (x, y) => (y.sobra > x.sobra ? 1 : y.sobra < x.sobra ? -1 : 0),
        ),
        colapsadas,
    };
}

/** A rota em uma linha, para o log. */
export function comoLerARota(r: Rota): string {
    const curto = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
    const passos = r.hops.map((h) => `${curto(h.de)}→${curto(h.para)}@${h.pool.tipo}`);
    return `${r.hops.length} swap(s): ${passos.join(' | ')}`;
}
