/**
 * ROTAS MISTAS V3 + AERODROME — descoberta, direcoes e funil economico.
 *
 * POR QUE ESTE ARQUIVO EXISTE, e nao e outra arquitetura paralela: ele e o
 * UNICO lugar que monta rota mista, e os dois caminhos o usam — o cacador ao
 * vivo (`cacarArbitragem.ts`) para descobrir e classificar, e o avaliador em
 * fork para cotar e simular. Duas copias seriam a REGRA 3 deste projeto outra
 * vez, e a copia provaria a copia.
 *
 * ORDEM DELA, 2026-10-15: *"Substitua o estado `NAO_VALIDADA` genérico dos
 * pools V3 e Aerodrome por descoberta efetiva de rotas compatíveis, incluindo
 * as duas direções e tamanhos otimizados."* E: *"Não confunda quantidade de
 * pools observados com quantidade de oportunidades."*
 *
 * As duas direcoes existem porque a fonte de credito pode ser qualquer um dos
 * dois pools, e o lucro vive numa delas:
 *
 *   A) o AERODROME empresta (paga WETH, sai o token) e o V3 vende o token
 *   B) o V3 empresta (entra WETH exato, sai o token) e o AERODROME vende
 *
 * Medido em 2026-10-15: a direcao B foi a que FECHOU na prova de execucao
 * atomica (recibo status=1, liquido 0,0598 WETH). Avaliar so a A era metade da
 * busca, e "nenhuma fecha" dali nao era resposta sobre o mercado.
 */

export type Venue = 'v3' | 'aerodrome';

export interface PoolMisto {
    endereco: string;
    token0: string;
    token1: string;
    venue: Venue;
    /** Fee tier do V3, em centesimos de ponto base. `null` no Aerodrome. */
    taxa: number | null;
}

/** Uma perna na forma que o `CacadorV3` recebe. */
export interface PernaMista {
    pool: string;
    tokenEntra: string;
    /** 0 = V3, 1 = Aerodrome. O contrato usa este inteiro. */
    tipo: 0 | 1;
    /** Aerodrome: quanto pagar. `0n` numa perna interna = gasta tudo. */
    pagamento: bigint;
}

export interface CandidataMista {
    /** O token do meio — o que nao e a base. */
    token: string;
    poolAerodrome: string;
    poolV3: string;
    /** 'A' = Aerodrome empresta. 'B' = V3 empresta. */
    direcao: 'A' | 'B';
    /** A chave que identifica a rota, para nao contar a mesma duas vezes. */
    chave: string;
}

/**
 * Monta as candidatas: um pool Aerodrome e um pool V3 que compartilham o par
 * {base, token}. As DUAS direcoes de cada par entram.
 *
 * `tokenBase` tem de estar nos dois pools: e nele que o ciclo comeca e termina,
 * e e nele que o custo do gas e medido sem precisar de preco.
 */
export function candidatasMistas(
    pools: PoolMisto[], tokenBase: string,
): CandidataMista[] {
    const base = tokenBase.toLowerCase();
    const outro = (q: PoolMisto): string | null => {
        const t0 = q.token0.toLowerCase();
        const t1 = q.token1.toLowerCase();
        if (t0 === base) return t1;
        if (t1 === base) return t0;
        return null;
    };
    const aeroPorToken = new Map<string, string[]>();
    const v3PorToken = new Map<string, string[]>();
    for (const q of pools) {
        const t = outro(q);
        if (t === null) continue;
        const m = q.venue === 'aerodrome' ? aeroPorToken : v3PorToken;
        const l = m.get(t) ?? [];
        l.push(q.endereco.toLowerCase());
        m.set(t, l);
    }
    const fora: CandidataMista[] = [];
    const vistas = new Set<string>();
    for (const [token, aeros] of aeroPorToken) {
        const v3s = v3PorToken.get(token);
        if (v3s === undefined) continue;
        for (const pa of aeros) {
            for (const pv of v3s) {
                for (const direcao of ['A', 'B'] as const) {
                    const chave = `${direcao}|${pa}|${pv}|${token}`;
                    if (vistas.has(chave)) continue;
                    vistas.add(chave);
                    fora.push({
                        token, poolAerodrome: pa, poolV3: pv, direcao, chave,
                    });
                }
            }
        }
    }
    return fora;
}

/**
 * A rota na forma do contrato.
 *
 * `pagamento` so e declarado na perna 0 do Aerodrome: ali nao ha nada em maos
 * ainda. Em perna interna o `0n` quer dizer "gasta o que a perna anterior
 * entregou", e o contrato resolve e PERSISTE o valor — defeito medido em
 * 2026-10-15, quando o valor ficava numa variavel local e o callback pagava
 * zero, levando o Aerodrome a `InsufficientInputAmount()`.
 */
export function pernasDaCandidata(
    c: CandidataMista, tokenBase: string, pagamentoAerodrome: bigint,
): PernaMista[] {
    const base = tokenBase.toLowerCase();
    if (c.direcao === 'A') {
        return [
            { pool: c.poolAerodrome, tokenEntra: base, tipo: 1, pagamento: pagamentoAerodrome },
            { pool: c.poolV3, tokenEntra: c.token, tipo: 0, pagamento: 0n },
        ];
    }
    return [
        { pool: c.poolV3, tokenEntra: base, tipo: 0, pagamento: 0n },
        { pool: c.poolAerodrome, tokenEntra: c.token, tipo: 1, pagamento: 0n },
    ];
}

/**
 * O FUNIL ECONOMICO, com as cinco coisas que ela mandou registrar SEPARADAS.
 *
 * *"Registre separadamente: deslocamento artificial criado no teste;
 * oportunidade histórica identificada depois da execução; oportunidade
 * detectada em observação sem informações futuras; operação economicamente
 * validada em fork; lucro efetivamente realizado na rede."*
 *
 * Elas nao sao graus da mesma coisa — sao origens diferentes de evidencia, e
 * somar duas delas e exatamente como se fabrica um resultado.
 */
export interface FunilMisto {
    blocosObservados: number;
    poolsVistos: { v3: number; aerodrome: number };
    /** Rotas DISTINTAS (par + direcao), nao pools. */
    rotasDistintas: number;
    cotacoesTentadas: number;
    cotacoesComSobra: number;
    simulacoesCompletas: number;
    simulacoesRevertidas: number;
    /** Por causa, a partir do erro IDENTIFICADO. */
    porCausa: Record<string, number>;
    /** As cinco origens, e nenhuma soma com a outra. */
    deslocamentoArtificial: number;
    historicaDepoisDaExecucao: number;
    detectadaEmObservacao: number;
    validadaEmFork: number;
    realizadaNaRede: number;
    /** O melhor liquido MEDIDO em fork, em wei do token base. */
    melhorLiquidoWei: bigint | null;
}

export const funilVazio = (): FunilMisto => ({
    blocosObservados: 0,
    poolsVistos: { v3: 0, aerodrome: 0 },
    rotasDistintas: 0,
    cotacoesTentadas: 0,
    cotacoesComSobra: 0,
    simulacoesCompletas: 0,
    simulacoesRevertidas: 0,
    porCausa: {},
    deslocamentoArtificial: 0,
    historicaDepoisDaExecucao: 0,
    detectadaEmObservacao: 0,
    validadaEmFork: 0,
    realizadaNaRede: 0,
    melhorLiquidoWei: null,
});

/**
 * A limitacao DOMINANTE, pedida por ela: *"se a limitação dominante é
 * cobertura, custo ou latência."*
 *
 * A ordem das perguntas e a ordem da evidencia: sem rota nao se fala de custo,
 * e sem sobra bruta nao se fala de latencia.
 */
export function limitacaoDominante(f: FunilMisto): string {
    if (f.rotasDistintas === 0) {
        return 'COBERTURA: nenhuma rota mista existe no universo observado — não há par '
            + '{Aerodrome, V3} compartilhando token com a base. Nada aqui é sobre custo ou '
            + 'latência';
    }
    if (f.cotacoesComSobra === 0) {
        return 'CUSTO: há rota, e nenhuma cotação devolveu sobra BRUTA. A diferença de preço '
            + 'entre os dois pools não cobre as taxas somadas — e isso é anterior a gás e a '
            + 'latência';
    }
    if (f.validadaEmFork === 0) {
        return 'CUSTO: houve sobra bruta e nenhuma sobreviveu ao custo completo (gás + L1). O '
            + 'desequilíbrio existe mas é menor que o custo de capturá-lo';
    }
    return 'LATÊNCIA: houve operação economicamente validada em fork. O que separa isso de '
        + 'lucro na rede é chegar no bloco — e nenhuma linha deste funil mede inclusão';
}

export function comoLerOFunilMisto(f: FunilMisto): string {
    const causas = Object.entries(f.porCausa)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n}x ${k}`)
        .join(', ');
    return `FUNIL MISTO — ${f.blocosObservados} bloco(s) observados | pools `
        + `${f.poolsVistos.v3} V3 + ${f.poolsVistos.aerodrome} Aerodrome | `
        + `${f.rotasDistintas} ROTA(S) DISTINTA(S) (par + direção, não pools) | `
        + `${f.cotacoesTentadas} cotação(ões), ${f.cotacoesComSobra} com sobra bruta | `
        + `${f.simulacoesCompletas} simulação(ões) ATÔMICA(S) completa(s), `
        + `${f.simulacoesRevertidas} revertida(s)${causas === '' ? '' : ` [${causas}]`} | `
        + `ORIGENS: ${f.deslocamentoArtificial} deslocamento artificial, `
        + `${f.historicaDepoisDaExecucao} histórica vista depois do fato, `
        + `${f.detectadaEmObservacao} detectada em observação sem futuro, `
        + `${f.validadaEmFork} VALIDADA em fork, `
        + `${f.realizadaNaRede} realizada na REDE | melhor líquido `
        + `${f.melhorLiquidoWei === null ? 'nenhum' : `${f.melhorLiquidoWei} wei`} | `
        + limitacaoDominante(f);
}
