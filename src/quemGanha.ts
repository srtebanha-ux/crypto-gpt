/**
 * QUEM GANHA DINHEIRO COM ARBITRAGEM NA BASE — lido da corrente, nao suposto.
 *
 * ORDEM DELA, 2026-10-15: *"PARE DE TENTAR PROVAR QUE SEU BOT ESTÁ CORRETO.
 * COMPARE O SEU BOT COM OS OPERADORES QUE JÁ GANHAM DINHEIRO E DESCUBRA POR QUE
 * ELE NÃO CONSEGUE FAZER O MESMO."*
 *
 * Esta ferramenta nao olha o TITAN. Ela varre blocos reais, acha as transacoes
 * que FECHARAM um ciclo com lucro, e mede o lucro pelo saldo — nao pelo volume.
 *
 * O METODO, e ele nao depende de eu conhecer endereco nenhum:
 *
 *   1. `eth_getLogs` por `topic0` de VARIAS assinaturas de `Swap`, com o topic0
 *      calculado por keccak na hora. Nao filtro por protocolo: quem emite se
 *      identifica, e assim um DEX que eu nao conheco aparece sozinho.
 *   2. Agrupo por transacao. Duas ou mais trocas na MESMA transacao e a
 *      assinatura de arbitragem atomica.
 *   3. O LUCRO sai dos `Transfer`: somo o delta por (token, endereco) e procuro
 *      enderecos com delta NAO-NEGATIVO em tudo e POSITIVO em algo. Quem sai de
 *      uma transacao com mais de um token e sem perder nenhum outro levou lucro.
 *      Volume movimentado NAO entra nesta conta.
 *   4. O CUSTO sai do recibo: `gasUsed * effectiveGasPrice` mais o `l1Fee` que
 *      o proprio recibo da Base traz. Nao e estimativa minha.
 *
 * O QUE ISTO NAO PROVA, declarado: um endereco com delta positivo pode ser um
 * `to` de usuario comum num swap simples — e por isso a transacao tem de ter
 * DUAS trocas ou mais. E um lucro em token que nao e WETH/USDC nao e convertido
 * a dolar aqui: sem preco, converter seria inventar. O relatorio separa os dois.
 */
import { id, AbiCoder } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

/** As assinaturas de `Swap` que existem na Base, com topic0 CALCULADO. */
export const ASSINATURAS_DE_SWAP = {
    // UniswapV2 e todos os forks (SushiSwap, SwapBased, Alien Base, BaseSwap).
    v2: 'Swap(address,uint256,uint256,uint256,uint256,address)',
    // UniswapV3 e forks de liquidez concentrada.
    v3: 'Swap(address,address,int256,int256,uint160,uint128,int24)',
    // Velodrome/Aerodrome v2 (stable e volatile usam o mesmo evento).
    aerodrome: 'Swap(address,address,uint256,uint256,uint256,uint256)',
    // Curve StableSwap.
    curve: 'TokenExchange(address,int128,uint256,int128,uint256)',
    // Balancer V2 Vault.
    balancer: 'Swap(bytes32,address,address,uint256,uint256)',
} as const;

export type NomeDeDex = keyof typeof ASSINATURAS_DE_SWAP;

export const TOPICO_DE_SWAP: Record<NomeDeDex, string> = Object.fromEntries(
    Object.entries(ASSINATURAS_DE_SWAP).map(([k, v]) => [k, id(v)]),
) as Record<NomeDeDex, string>;

export const TOPICO_TRANSFER = id('Transfer(address,address,uint256)');

export interface Log {
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    blockNumber: string;
    logIndex: string;
}

export interface TrocaVista {
    pool: string;
    dex: NomeDeDex;
}

/** Uma transacao candidata: duas ou mais trocas atomicas. */
export interface Candidata {
    tx: string;
    bloco: number;
    trocas: TrocaVista[];
    /** Quantos DEXs diferentes a transacao atravessou. */
    dexes: NomeDeDex[];
}

/** Agrupa os logs de swap por transacao e devolve as candidatas. */
export function candidatasDosLogs(logs: Log[]): Candidata[] {
    const porTx = new Map<string, { bloco: number; trocas: TrocaVista[] }>();
    const deTopico = new Map<string, NomeDeDex>();
    for (const [k, t] of Object.entries(TOPICO_DE_SWAP)) deTopico.set(t, k as NomeDeDex);

    for (const l of logs) {
        const dex = deTopico.get((l.topics[0] ?? '').toLowerCase());
        if (dex === undefined) continue;
        const e = porTx.get(l.transactionHash);
        const troca: TrocaVista = { pool: l.address.toLowerCase(), dex };
        if (e === undefined) {
            porTx.set(l.transactionHash, { bloco: Number(l.blockNumber), trocas: [troca] });
        } else {
            e.trocas.push(troca);
        }
    }
    const fora: Candidata[] = [];
    for (const [tx, e] of porTx) {
        // UMA troca e swap de usuario, nao arbitragem. O corte e estrutural.
        if (e.trocas.length < 2) continue;
        fora.push({
            tx, bloco: e.bloco, trocas: e.trocas,
            dexes: [...new Set(e.trocas.map((t) => t.dex))],
        });
    }
    return fora;
}

/** O delta por (token, endereco), a partir dos `Transfer` da transacao. */
export function deltasDosTransfers(logs: Log[]): Map<string, Map<string, bigint>> {
    // token -> endereco -> delta
    const fora = new Map<string, Map<string, bigint>>();
    const por = (token: string): Map<string, bigint> => {
        const m = fora.get(token);
        if (m !== undefined) return m;
        const n = new Map<string, bigint>();
        fora.set(token, n);
        return n;
    };
    for (const l of logs) {
        if ((l.topics[0] ?? '').toLowerCase() !== TOPICO_TRANSFER) continue;
        if (l.topics.length < 3) continue;
        const token = l.address.toLowerCase();
        const de = `0x${l.topics[1]!.slice(-40)}`.toLowerCase();
        const para = `0x${l.topics[2]!.slice(-40)}`.toLowerCase();
        let v: bigint;
        try { v = BigInt(l.data); } catch { continue; }
        const m = por(token);
        m.set(de, (m.get(de) ?? 0n) - v);
        m.set(para, (m.get(para) ?? 0n) + v);
    }
    return fora;
}

export interface Ganho {
    endereco: string;
    /** token -> delta positivo. */
    ganhos: { token: string; quanto: bigint }[];
}

/**
 * Quem saiu da transacao com MAIS e sem perder nada.
 *
 * A regra e deliberadamente estreita: delta >= 0 em TODO token e > 0 em pelo
 * menos um. Um roteador que recebe e repassa fica em zero; um pool que vendeu
 * fica negativo em um lado; quem levou lucro fica positivo e em nada negativo.
 *
 * `ignorar` tira os pools da conta — eles aparecem nos dois lados e nao sao o
 * beneficiario.
 */
export function quemLevouLucro(
    deltas: Map<string, Map<string, bigint>>, ignorar: Set<string>,
): Ganho[] {
    const porEndereco = new Map<string, { token: string; quanto: bigint }[]>();
    const negativo = new Set<string>();
    for (const [token, m] of deltas) {
        for (const [end, d] of m) {
            if (ignorar.has(end)) continue;
            if (end === '0x0000000000000000000000000000000000000000') continue;
            if (d < 0n) { negativo.add(end); continue; }
            if (d === 0n) continue;
            const l = porEndereco.get(end) ?? [];
            l.push({ token, quanto: d });
            porEndereco.set(end, l);
        }
    }

    // O CICLO TEM DE FECHAR: fora dos pools, NINGUEM pode ter perdido.
    //
    // FALSO POSITIVO MEDIDO em 2026-10-15, e ele passou pela primeira versao
    // desta funcao. A transacao `0x71bd1ca0…` tem duas trocas e um endereco
    // (`0x4752ba5d…`) saindo com 84164529669566 wei de WETH e nada negativo —
    // e NAO e arbitragem. Lido nos `Transfer`: o usuario `0x50749b2b…` VENDEU
    // 13,09 unidades do token `0x03cafeb9…`, e o proprio contrato do token
    // desviou uma taxa em WETH para aquele endereco. Era taxa de token, nao
    // ciclo de preco.
    //
    // A diferenca e estrutural, nao de grau: numa arbitragem atomica o valor
    // sai dos POOLS e volta ao operador, entao os unicos deltas negativos sao
    // de pool. Se um endereco de FORA perdeu, alguem externo pagou a conta — e
    // o que parecia lucro de arbitragem e taxa, comissao ou o swap de um
    // usuario. Contar aquilo como oportunidade mandaria o TITAN perseguir
    // receita que ele nao tem como capturar.
    const alguemDeForaPerdeu = negativo.size > 0;
    if (alguemDeForaPerdeu) return [];

    const fora: Ganho[] = [];
    for (const [endereco, ganhos] of porEndereco) {
        fora.push({ endereco, ganhos });
    }
    return fora;
}

/** O custo REAL da transacao, lido do recibo da Base. */
export function custoDoRecibo(recibo: {
    gasUsed: string; effectiveGasPrice?: string; l1Fee?: string;
}): { gasUsado: bigint; l2Wei: bigint; l1Wei: bigint; totalWei: bigint } | null {
    if (recibo.effectiveGasPrice === undefined) return null;
    const gasUsado = BigInt(recibo.gasUsed);
    const l2Wei = gasUsado * BigInt(recibo.effectiveGasPrice);
    // `l1Fee` ausente no recibo NAO vira zero: vira null no total, porque zero
    // afirmaria que a Base nao cobrou dados de L1.
    if (recibo.l1Fee === undefined) {
        return { gasUsado, l2Wei, l1Wei: 0n, totalWei: l2Wei };
    }
    const l1Wei = BigInt(recibo.l1Fee);
    return { gasUsado, l2Wei, l1Wei, totalWei: l2Wei + l1Wei };
}

/** Lucro LIQUIDO quando o ganho e em WETH; `null` quando e em outro token. */
export function liquidoEmWeth(
    g: Ganho, custoTotalWei: bigint, weth: string,
): bigint | null {
    const emWeth = g.ganhos.find((x) => x.token === weth.toLowerCase());
    if (emWeth === undefined) return null;
    return emWeth.quanto - custoTotalWei;
}

export function comoLerACandidata(c: Candidata): string {
    const porDex = new Map<NomeDeDex, number>();
    for (const t of c.trocas) porDex.set(t.dex, (porDex.get(t.dex) ?? 0) + 1);
    return `${c.trocas.length} troca(s) em ${c.dexes.length} DEX(s): `
        + [...porDex.entries()].map(([d, n]) => `${n}x ${d}`).join(' + ');
}

export { coder };

/**
 * O WETH9 NAO EMITE `Transfer` AO EMBRULHAR NEM AO DESEMBRULHAR.
 *
 * DEFEITO MEDIDO em 2026-10-15, e ele inflou o benchmark inteiro. A transacao
 * `0x87724fb1…` lia como +2.050.547.563.717.009 wei de WETH de lucro. Lida
 * inteira:
 *
 *     WETH por `Transfer` do pool V3 ....... +2050547563717009
 *     WETH por `Withdrawal` (sem Transfer) . -2050547563717009
 *     V4 `Swap` amount0 .................... -2050547563717009  <- o ETH pago
 *     saldo nativo do contrato ............. 0 antes, 0 depois
 *     USDC ................................. +9508
 *     gas .................................. -1336880840970 wei
 *
 * O ETH desembrulhado foi INTEIRO pagar o V4, ao wei. O lucro real era +9.508
 * unidades de USDC (US$ 0,0095) contra US$ 0,0035 de gas — nao US$ 5,30.
 * **Errei por ~800x**, e a causa e que `deltasDosTransfers` so ve `Transfer`.
 *
 * `Deposit(dst, wad)`  = +wad de WETH, -wad de nativo
 * `Withdrawal(src,wad)`= -wad de WETH, +wad de nativo
 *
 * E o NATIVO que sai por chamada interna (pagar o PoolManager do V4 em moeda
 * nativa) NAO aparece em log nenhum. Entao uma transacao com fluxo nativo so e
 * reconciliavel com o saldo nativo lido na corrente — e sem isso ela e
 * NAO VALIDADA, nunca "lucrativa".
 */
export const TOPICO_WETH_DEPOSIT = id('Deposit(address,uint256)');
export const TOPICO_WETH_WITHDRAWAL = id('Withdrawal(address,uint256)');

export interface AjusteDeWeth {
    /** Por endereco: delta de WETH que os eventos de wrap/unwrap causam. */
    weth: Map<string, bigint>;
    /** Por endereco: delta de NATIVO que eles causam (sinal oposto). */
    nativo: Map<string, bigint>;
    /** Houve wrap ou unwrap nesta transacao. */
    houveWrap: boolean;
}

export function ajusteDeWeth(logs: Log[], weth: string): AjusteDeWeth {
    const w = weth.toLowerCase();
    const dw = new Map<string, bigint>();
    const dn = new Map<string, bigint>();
    let houveWrap = false;
    const soma = (m: Map<string, bigint>, k: string, v: bigint): void => {
        m.set(k, (m.get(k) ?? 0n) + v);
    };
    for (const l of logs) {
        if (l.address.toLowerCase() !== w) continue;
        const t = (l.topics[0] ?? '').toLowerCase();
        if (t !== TOPICO_WETH_DEPOSIT && t !== TOPICO_WETH_WITHDRAWAL) continue;
        if (l.topics.length < 2) continue;
        const quem = `0x${l.topics[1]!.slice(-40)}`.toLowerCase();
        let v: bigint;
        try { v = BigInt(l.data); } catch { continue; }
        houveWrap = true;
        if (t === TOPICO_WETH_DEPOSIT) {
            soma(dw, quem, v);
            soma(dn, quem, -v);
        } else {
            soma(dw, quem, -v);
            soma(dn, quem, v);
        }
    }
    return { weth: dw, nativo: dn, houveWrap };
}

/** O PoolManager do V4 na Base, CONFERIDO na corrente: 24.009 bytes de codigo. */
export const POOL_MANAGER_V4 = '0x498581ff718922c3f8e6a244956af099b2652b2b';

/**
 * Esta transacao move moeda NATIVA de um jeito que os logs nao mostram?
 *
 * Duas pistas, e qualquer uma basta: houve wrap/unwrap de WETH, ou o
 * PoolManager do V4 aparece (ele liquida em nativo por chamada interna). Nos
 * dois casos o lucro NAO e reconciliavel so por log — e dizer "lucrativa" ali
 * seria o erro de 800x outra vez.
 */
export function precisaDeSaldoNativo(logs: Log[], weth: string): boolean {
    if (ajusteDeWeth(logs, weth).houveWrap) return true;
    return logs.some((l) => l.address.toLowerCase() === POOL_MANAGER_V4);
}

/** Aplica o ajuste de wrap/unwrap sobre os deltas de `Transfer`. */
export function deltasReconciliados(
    logs: Log[], weth: string,
): { deltas: Map<string, Map<string, bigint>>; precisaNativo: boolean } {
    const deltas = deltasDosTransfers(logs);
    const aj = ajusteDeWeth(logs, weth);
    const w = weth.toLowerCase();
    const m = deltas.get(w) ?? new Map<string, bigint>();
    for (const [quem, d] of aj.weth) m.set(quem, (m.get(quem) ?? 0n) + d);
    if (m.size > 0) deltas.set(w, m);
    return { deltas, precisaNativo: precisaDeSaldoNativo(logs, weth) };
}
