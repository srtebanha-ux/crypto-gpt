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
    /**
     * `stable()` do pool Aerodrome. `false` = volatile COMPROVADO, e so nesse
     * caso existe teto demonstrado. `null` = nao li, e nao li nao descarta.
     */
    estavel?: boolean | null;
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
    /**
     * `token0` do pool V3, em minusculo — ele diz de que LADO o token do meio
     * esta, e e isso que inverte a razao do filtro. Vem da descoberta, nao de
     * leitura nova. `null` manda cotar: lado desconhecido nao descarta.
     */
    token0DoV3: string | null;
    /** `token0` do pool AERODROME, em minusculo — diz qual reserva e a de entrada. */
    token0DoAero: string | null;
    /** `stable()` do pool Aerodrome. So `false` autoriza descarte. */
    aeroEstavel: boolean | null;
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
    const token0PorPool = new Map<string, string>();
    const estavelPorPool = new Map<string, boolean | null>();
    for (const q of pools) {
        const t = outro(q);
        if (t === null) continue;
        const m = q.venue === 'aerodrome' ? aeroPorToken : v3PorToken;
        const l = m.get(t) ?? [];
        l.push(q.endereco.toLowerCase());
        m.set(t, l);
        token0PorPool.set(q.endereco.toLowerCase(), q.token0.toLowerCase());
        estavelPorPool.set(q.endereco.toLowerCase(), q.estavel ?? null);
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
                        token,
                        poolAerodrome: pa,
                        poolV3: pv,
                        direcao,
                        token0DoV3: token0PorPool.get(pv) ?? null,
                        token0DoAero: token0PorPool.get(pa) ?? null,
                        aeroEstavel: estavelPorPool.get(pa) ?? null,
                        chave,
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
    /**
     * Blocos varridos para DESCOBRIR pools. Nao e estado avaliado.
     *
     * DEFEITO MEDIDO e apontado por ela: o relatorio dizia "250 blocos
     * observados" e cotava tudo em UM estado, porque o `hardhat_reset`
     * acontecia uma vez no fim da janela. *"250 blocos observados não são 250
     * estados avaliados."* Os dois numeros agora existem separados, e o que
     * conta para a economia e `estadosAvaliados`.
     */
    blocosVarridosParaDescoberta: number;
    /** Estados DISTINTOS em que as rotas foram cotadas. */
    estadosAvaliados: number;
    poolsVistos: { v3: number; aerodrome: number };
    /** Rotas DISTINTAS (par + direcao), nao pools. */
    rotasDistintas: number;
    /**
     * Rotas que PASSARAM a triagem — e isto nao e cotacao.
     *
     * ORDEM DELA, 2026-10-15: *"`cotacoesTentadas` só pode aumentar quando
     * houver uma cotação realmente executada. Uma rota que passou pela triagem
     * é TRIADA, não COTADA."* Eu estava somando a triagem em `cotacoesTentadas`
     * no cacador ao vivo, onde cotacao nenhuma acontece: o funil publicava
     * cotacao que nunca existiu. As cinco etapas — DESCOBERTA, TRIAGEM,
     * COTACAO, EXECUCAO EM FORK e EXECUCAO NA REDE — tem contador proprio, e
     * nenhuma soma com a outra.
     */
    rotasTriadas: number;
    /** Cotacoes REALMENTE executadas (um `eth_call` que foi e voltou). */
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
    /**
     * AS CINCO RAZOES DE NAO TER DADO, separadas por pedido dela.
     *
     * *"O funil separa falta de spread, limitação de cobertura, falta de dados,
     * expiração e falha de execução."* Elas pedem acoes opostas: falta de
     * spread e o mercado; cobertura e varrer mais; falta de dado e o avaliador;
     * expiracao e latencia; falha de execucao e o contrato. Somar duas e perder
     * a unica informacao que o funil tem.
     */
    faltaDeSpread: number;
    limitacaoDeCobertura: number;
    faltaDeDados: number;
    /** Nao descartado por NAO HAVER PROVA para o invariante daquele pool. */
    semProvaMatematica: number;
    expirado: number;
    falhaDeExecucao: number;
    /**
     * Cotacoes cujo estado MUDOU entre a leitura e a cotacao.
     *
     * Nao e expiracao e nao e falta de spread: e a conta ter sido feita com
     * dados de dois instantes. *"Nao declare uma arbitragem lucrativa
     * utilizando dados incompativeis."*
     */
    estadosInconsistentes: number;
}

export const funilVazio = (): FunilMisto => ({
    blocosVarridosParaDescoberta: 0,
    estadosAvaliados: 0,
    poolsVistos: { v3: 0, aerodrome: 0 },
    rotasDistintas: 0,
    rotasTriadas: 0,
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
    faltaDeSpread: 0,
    limitacaoDeCobertura: 0,
    faltaDeDados: 0,
    semProvaMatematica: 0,
    expirado: 0,
    falhaDeExecucao: 0,
    estadosInconsistentes: 0,
});

/**
 * A limitacao DOMINANTE, pedida por ela: *"se a limitação dominante é
 * cobertura, custo ou latência."*
 *
 * A ordem das perguntas e a ordem da evidencia: sem rota nao se fala de custo,
 * e sem sobra bruta nao se fala de latencia.
 */
export function limitacaoDominante(f: FunilMisto): string {
    if (f.estadosAvaliados === 0) {
        return 'NADA AVALIADO: nenhum estado distinto foi cotado. Varrer blocos para descobrir '
            + 'pool não é avaliar estado, e sem estado avaliado não há conclusão econômica';
    }
    if (f.expirado > 0 && f.expirado >= f.cotacoesTentadas) {
        return 'LATÊNCIA: todo sinal EXPIROU antes da decisão. Isto não é prejuízo e não é '
            + 'falta de spread — é o avaliador chegando tarde ao próprio estado que leu';
    }
    if (f.rotasDistintas === 0) {
        return 'COBERTURA: nenhuma rota mista existe no universo observado — não há par '
            + '{Aerodrome, V3} compartilhando token com a base. Nada aqui é sobre custo ou '
            + 'latência';
    }
    if (f.cotacoesTentadas === 0 && f.rotasTriadas > 0) {
        // TRIADA e nao cotada: o filtro deixou passar e nada foi cotado. A
        // causa nao e o mercado, e sim nao haver cotador neste caminho.
        return 'SEM COTAÇÃO: o filtro deixou passar rotas e nenhuma foi COTADA neste caminho. '
            + 'Isto não é "não há oportunidade" nem "não há spread": é ausência de cotador, e a '
            + 'conclusão econômica depende de uma cotação que não aconteceu';
    }
    if (f.cotacoesTentadas === 0 && f.faltaDeSpread > 0) {
        // ETIQUETA QUE DESCREVE O CONJUNTO. Com zero cotacao tentada, dizer
        // "nenhuma cotacao devolveu sobra" afirma uma medicao que nao houve —
        // o defeito que da nome a este projeto. Aqui a recusa veio do FILTRO, e
        // a prova dele e valida em todo tamanho; nada foi cotado.
        return 'SEM SPREAD: nenhuma cotação foi tentada porque o filtro descartou TODAS as '
            + 'rotas com prova válida em qualquer tamanho (o produto das razões máximas não '
            + 'passa de 1). Isto não é "cotei e não deu": é "não havia o que cotar"';
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
    return `FUNIL MISTO — ${f.blocosVarridosParaDescoberta} bloco(s) varridos para DESCOBERTA`
        + ` e ${f.estadosAvaliados} ESTADO(S) distinto(s) avaliado(s) | pools `
        + `${f.poolsVistos.v3} V3 + ${f.poolsVistos.aerodrome} Aerodrome | `
        + `${f.rotasDistintas} ROTA(S) DISTINTA(S) (par + direção, não pools) | `
        + `${f.rotasTriadas} TRIADA(S) (passaram o filtro; triada não é cotada) | `
        + `${f.cotacoesTentadas} cotação(ões) EXECUTADA(S), `
        + `${f.cotacoesComSobra} com sobra bruta`
        // AS CAUSAS sao das COTACOES, e ficavam colados em "simulacoes
        // revertidas" — uma corrida com 36 cotacoes e ZERO simulacoes publicou
        // "0 revertida(s) [33x PagamentoCurto]", etiqueta descrevendo um
        // conjunto vazio com os motivos de outro.
        + `${causas === '' ? '' : ` [motivos: ${causas}]`} | `
        + `${f.simulacoesCompletas} simulação(ões) ATÔMICA(S) completa(s), `
        + `${f.simulacoesRevertidas} revertida(s) | `
        + `ORIGENS: ${f.deslocamentoArtificial} deslocamento artificial, `
        + `${f.historicaDepoisDaExecucao} histórica vista depois do fato, `
        + `${f.detectadaEmObservacao} detectada em observação sem futuro, `
        + `${f.validadaEmFork} VALIDADA em fork, `
        + `${f.realizadaNaRede} realizada na REDE | melhor líquido `
        + `${f.melhorLiquidoWei === null ? 'nenhum' : `${f.melhorLiquidoWei} wei`} | `
        + `SEM DADO POR: ${f.faltaDeSpread} falta de spread, `
        + `${f.limitacaoDeCobertura} cobertura, ${f.faltaDeDados} falta de dados, `
        + `${f.semProvaMatematica} SEM PROVA do invariante (pool stable: não descartado), `
        + `${f.expirado} EXPIRADO, ${f.estadosInconsistentes} ESTADO_INCONSISTENTE, `
        + `${f.falhaDeExecucao} falha de execução | `
        + limitacaoDominante(f);
}

/**
 * O LIMITE DE SPREAD — uma RAZAO maxima, e nao um teto por tamanho.
 *
 * DOIS DEFEITOS MEUS que isto conserta, os dois apontados por ela em
 * 2026-10-15, e os dois podiam DESCARTAR ARBITRAGEM LUCRATIVA:
 *
 * 1. MISTURA DE UNIDADE na direcao B. O avaliador passava
 *    `tokenDoEmprestimo = q` com `q` em WETH, e `valeSimular` tratava aquilo
 *    como quantidade do token do MEIO para calcular a saida do V3 — depois
 *    comparava o resultado (em token) com o custo (em WETH). Comparar grandezas
 *    de unidades diferentes nao e filtro conservador: e sorteio.
 *
 * 2. UM TETO POR TAMANHO NAO PROVA NADA SOBRE OS OUTROS TAMANHOS. A frase
 *    "esta rota nao fecha em tamanho nenhum" era falsa: o teto era calculado
 *    para UM `q`.
 *
 * O CONSERTO e trocar teto por RAZAO. Em AMM a saida e concava na entrada:
 * `saida/entrada` e MAXIMA no tamanho infinitesimal e so cai dali. Entao a
 * razao marginal de cada perna e um teto da razao media de QUALQUER tamanho, e
 * o produto das duas razoes e um teto do ciclo inteiro:
 *
 *     razao do ciclo <= razaoMax(perna 1) x razaoMax(perna 2)
 *
 * Se esse produto nao passa de 1, o ciclo devolve menos do que entrou em
 * TAMANHO NENHUM — e a recusa e valida para todos eles. As unidades se cancelam
 * de propósito: (token por WETH) x (WETH por token) e adimensional.
 *
 * As duas razoes vem de FONTES DIFERENTES, e nenhuma de conta minha:
 *
 *   V3        o preco spot de `sqrtPriceX96`, que e o limite quando o tamanho
 *             tende a zero. Taxa e cruzamento de tick so pioram
 *   AERODROME `getAmountOut(epsilon, tokenEntra)` — a conta do PROPRIO pool num
 *             tamanho pequeno. `epsilon` tem de ser MENOR que os tamanhos
 *             avaliados, senao a razao dele nao e teto
 */

/** Uma razao `saida/entrada` como fracao exata, para nao dividir inteiros. */
export interface RazaoMaxima {
    num: bigint;
    den: bigint;
}

/**
 * A razao maxima de um pool V3, do preco spot.
 *
 * `entraEhToken0` diz de que lado se entra. `price = (sqrtP/2^96)^2` e token1
 * por token0, entao o inverso vale quando se entra pelo token1.
 */
export function razaoMaximaV3(
    sqrtPriceX96: bigint, entraEhToken0: boolean,
): RazaoMaxima | null {
    if (sqrtPriceX96 <= 0n) return null;
    const Q192 = (1n << 96n) * (1n << 96n);
    const p2 = sqrtPriceX96 * sqrtPriceX96;
    return entraEhToken0 ? { num: p2, den: Q192 } : { num: Q192, den: p2 };
}

/**
 * A razao maxima de um pool Aerodrome VOLATILE, DEMONSTRADA do invariante.
 *
 * ELA DERRUBOU A VERSAO ANTERIOR, 2026-10-15, e estava certa:
 * *"`getAmountOut(epsilon) / epsilon` NÃO É UMA RAZÃO MÁXIMA. Em pools
 * Aerodrome volatile, o resultado de uma entrada finita já sofre impacto de
 * preço... usá-la como teto pode produzir falso negativo."* E: *"VOCÊ USA O
 * MESMO EPSILON BRUTO PARA TOKENS DIFERENTES. `10^12` representa 0,000001 WETH
 * com 18 decimais, mas 1.000.000 de tokens com 6 decimais."*
 *
 * MEDIDO com a formula exata (reservas 1000/1000, taxa 30bp):
 *
 *     x = 1e12  ->  saida/x = 0,99700000
 *     x = 1e18  ->  saida/x = 0,99600698
 *     x = 1e20  ->  saida/x = 0,90661089
 *     marginal (rSai/rEntra) = 1,00000000
 *
 * A razao CAI com o tamanho e fica SEMPRE abaixo da marginal — entao a cotacao
 * num tamanho finito e um teto do que vem DEPOIS dele, nunca do que vem antes.
 * E `x = 1` devolveu ZERO por truncamento de inteiro, que o filtro antigo lia
 * como "sem dado" num token de 6 casas.
 *
 * A DEMONSTRACAO do teto certo, do invariante `x·y = k`:
 *
 *     saida(x) = rSai · x' / (rEntra + x'),  com x' = x·(1 − taxa) <= x
 *
 *     saida(x)/x = rSai·x' / (x·(rEntra + x'))
 *                <= rSai·x' / (x·rEntra)          porque rEntra + x' >= rEntra
 *                <= rSai / rEntra                 porque x' <= x
 *
 * Vale para TODO x > 0, inclusive abaixo de qualquer epsilon, e nao desconta
 * taxa — descontar tornaria o teto mais apertado e, portanto, capaz de recusar
 * rota boa. As reservas sao CRUAS nas duas pontas, entao a razao e "unidade
 * crua de saida por unidade crua de entrada": a mesma unidade da razao do V3,
 * que vem de `sqrtPriceX96`. Os decimais se cancelam no produto sem nenhuma
 * normalizacao, e NAO existe mais epsilon para errar de unidade.
 *
 * SO PARA VOLATILE: o pool stable usa outro invariante (`x³y + y³x = k`), e
 * este teto nao esta demonstrado para ele. `ehVolatile !== true` devolve `null`,
 * e `null` manda cotar.
 */
export function razaoMaximaAerodrome(
    reservaEntra: bigint | null, reservaSai: bigint | null, ehVolatile: boolean | null,
): RazaoMaxima | null {
    if (ehVolatile !== true) return null;
    if (reservaEntra === null || reservaSai === null) return null;
    if (reservaEntra <= 0n || reservaSai <= 0n) return null;
    return { num: reservaSai, den: reservaEntra };
}

/** O produto de duas razoes passa de 1? Por multiplicacao cruzada, sem dividir. */
export function produtoPassaDeUm(a: RazaoMaxima, b: RazaoMaxima): boolean {
    return a.num * b.num > a.den * b.den;
}

export interface VeredictoDoSpread {
    /** `true` = vale cotar. `false` = NENHUM tamanho fecha. */
    vale: boolean;
    porque: string;
    /** As duas razoes, para o log poder ser auditado. */
    razoes: { emprestimo: RazaoMaxima | null; venda: RazaoMaxima | null };
}

/**
 * O FILTRO, nas DUAS direcoes, com as unidades batendo.
 *
 * direcao A: Aerodrome empresta (WETH -> token) e o V3 vende (token -> WETH)
 *            razao = (token/WETH no Aerodrome) x (WETH/token no V3)
 *
 * direcao B: V3 empresta (WETH -> token) e o Aerodrome vende (token -> WETH)
 *            razao = (token/WETH no V3) x (WETH/token no Aerodrome)
 *
 * Nos dois casos o produto e adimensional, e e isso que torna a comparacao com
 * 1 legitima. `null` em qualquer razao NAO recusa: ausencia manda cotar.
 */
export function semSpreadEmTamanhoNenhum(e: {
    direcao: 'A' | 'B';
    /** `sqrtPriceX96` do pool V3. */
    sqrtPriceX96: bigint | null;
    /** No pool V3, o token do MEIO e o token0? */
    tokenDoMeioEhToken0NoV3: boolean;
    /** Reserva CRUA do token que ENTRA na perna do Aerodrome. */
    reservaEntraNoAero: bigint | null;
    /** Reserva CRUA do token que SAI na perna do Aerodrome. */
    reservaSaiNoAero: bigint | null;
    /**
     * O pool Aerodrome e COMPROVADAMENTE volatile (`stable() == false`)?
     *
     * `null` ou `true` (stable) NAO descarta: o teto so esta demonstrado para o
     * invariante `x·y = k`. Pool stable, token de comportamento nao
     * convencional e estado sem leitura ficam NAO VALIDADOS, por ordem dela.
     */
    aeroEhVolatile: boolean | null;
}): VeredictoDoSpread {
    // No V3 a perna da direcao A vende o token do meio (entra o token do
    // meio); na direcao B ela compra (entra o WETH, isto e, NAO o token do
    // meio). E so isso que muda de lado.
    const entraPeloToken0NoV3 = e.direcao === 'A'
        ? e.tokenDoMeioEhToken0NoV3
        : !e.tokenDoMeioEhToken0NoV3;
    const rV3 = razaoMaximaV3(e.sqrtPriceX96 ?? 0n, entraPeloToken0NoV3);
    const rAero = razaoMaximaAerodrome(
        e.reservaEntraNoAero, e.reservaSaiNoAero, e.aeroEhVolatile,
    );
    const razoes = e.direcao === 'A'
        ? { emprestimo: rAero, venda: rV3 }
        : { emprestimo: rV3, venda: rAero };

    if (rV3 === null || rAero === null) {
        // AUSENCIA NAO RECUSA. Sem uma das razoes nao ha produto, e "nao sei"
        // nunca autoriza descartar — autoriza cotar. O pool stable cai aqui de
        // proposito: o teto nao esta demonstrado para o invariante dele.
        const porque = e.aeroEhVolatile === true
            ? 'falta o `slot0` do V3 ou as reservas do Aerodrome: sem o produto não há prova '
                + 'de inviabilidade, e ausência não descarta rota'
            : 'o pool Aerodrome não é COMPROVADAMENTE volatile (recebi '
                + `\`${String(e.aeroEhVolatile)}\` onde só \`true\` autoriza descartar`
                + '): o teto só está demonstrado para o invariante `x·y = k`, então esta '
                + 'rota fica NÃO VALIDADA em vez de descartada';
        return { vale: true, porque, razoes };
    }
    if (produtoPassaDeUm(rAero, rV3)) {
        return {
            vale: true,
            porque: 'o produto das razões máximas passa de 1: não dá para descartar, e só a '
                + 'execução decide',
            razoes,
        };
    }
    return {
        vale: false,
        porque: 'o produto das razões MÁXIMAS das duas pernas não passa de 1. Em AMM a razão '
            + 'saída/entrada é máxima no tamanho infinitesimal e só cai, então nenhum tamanho '
            + 'fecha — e as unidades se cancelam, (token/WETH) × (WETH/token)',
        razoes,
    };
}

/**
 * O ESTADO LIDO, na forma que o filtro precisa — e nada alem dela.
 *
 * Isto existe para o filtro rodar nos DOIS caminhos (cacador ao vivo e
 * avaliador em fork) sem duas implementacoes: cada caminho le a corrente com o
 * seu transporte e entrega AQUI o que leu. A triagem em si e a mesma funcao.
 */
export interface LeiturasDoEstado {
    /** `sqrtPriceX96` por pool V3, endereco em minusculo. Ausente = nao li. */
    sqrtPorPoolV3: Map<string, bigint | null>;
    /** `token0` por pool, tudo em minusculo. */
    token0PorPool: Map<string, string>;
    /**
     * As reservas CRUAS por pool Aerodrome, na ordem `token0, token1`.
     *
     * Elas substituiram `getAmountOut(epsilon, ...)`, que NAO era teto e
     * dependia de um epsilon em unidade crua — o mesmo `10^12` valendo
     * 0,000001 com 18 casas e 1.000.000 com 6. Reserva nao tem epsilon.
     */
    reservasAerodrome: Map<string, { r0: bigint; r1: bigint } | null>;
    /** O bloco do estado. E ele que diz a IDADE do dado na decisao. */
    bloco: number;
    /**
     * O SALDO DA BASE em cada pool V3, cru.
     *
     * Ele existe porque a capacidade de EMPRESTIMO e do pool que empresta, e na
     * direcao B quem empresta e o V3. Dimensionar a direcao B pela reserva do
     * AERODROME — o que o codigo fazia — e o defeito que ela nomeou: *"Nao
     * reutilize a liquidez de um pool como se fosse a capacidade de emprestimo
     * de outro."* Ausente = nao li, e sem isso nao se dimensiona nada.
     */
    saldoDaBaseNoV3?: Map<string, bigint | null>;
}

export interface Triagem {
    /** Vale cotar: o produto passa de 1, ou falta dado (ausencia nao descarta). */
    valem: CandidataMista[];
    /** Recusadas com PROVA valida em todo tamanho. */
    recusadasPorSpread: CandidataMista[];
    /** Entraram em `valem` por FALTA DE DADO (leitura que nao veio). */
    semDados: number;
    /**
     * Entraram em `valem` por NAO HAVER PROVA para o invariante do pool.
     *
     * ORDEM DELA: *"Para pools stable, tokens de comportamento não convencional
     * ou estados sem prova matemática, NÃO descarte pelo filtro. Classifique
     * como não validado."* Isto nao e falta de dado: a leitura veio, e diz que
     * o pool usa `x³y + y³x = k`, para o qual o teto nao esta demonstrado. As
     * duas pedem acoes diferentes — uma e o RPC, a outra e matematica que falta
     * fazer — e somar as duas esconderia qual das duas e.
     */
    semProvaDoInvariante: number;
    veredictos: Map<string, VeredictoDoSpread>;
}

/**
 * Triagem de um ESTADO: aplica o filtro a cada candidata.
 *
 * `faltaDeDados` e contado SEPARADO de `faltaDeSpread` de proposito: as duas
 * mandam a rota para a cotacao, mas pedem consertos opostos — falta de dado e
 * defeito do avaliador, falta de spread e propriedade do mercado. Somar as duas
 * apagaria a unica informacao que o funil tem.
 */
export function triarCandidatas(
    cs: CandidataMista[], tokenBase: string, L: LeiturasDoEstado,
): Triagem {
    const base = tokenBase.toLowerCase();
    const t = {
        valem: [] as CandidataMista[],
        recusadasPorSpread: [] as CandidataMista[],
        semDados: 0,
        semProvaDoInvariante: 0,
        veredictos: new Map<string, VeredictoDoSpread>(),
    };
    for (const c of cs) {
        const t0V3 = L.token0PorPool.get(c.poolV3.toLowerCase()) ?? c.token0DoV3;
        // Na direcao A o Aerodrome recebe a BASE; na B recebe o token do meio.
        const entraNoAero = c.direcao === 'A' ? base : c.token.toLowerCase();
        const res = L.reservasAerodrome.get(c.poolAerodrome.toLowerCase()) ?? null;
        // Qual reserva e a de ENTRADA depende do `token0` do pool do Aerodrome.
        // Sem ele a ordem e desconhecida, e trocar as duas inverteria a razao.
        const entraEhToken0NoAero = c.token0DoAero !== null && c.token0DoAero === entraNoAero;
        const temOrdem = c.token0DoAero !== null && res !== null;
        const v = semSpreadEmTamanhoNenhum({
            direcao: c.direcao,
            sqrtPriceX96: L.sqrtPorPoolV3.get(c.poolV3.toLowerCase()) ?? null,
            tokenDoMeioEhToken0NoV3: t0V3 !== null && t0V3 === c.token.toLowerCase(),
            reservaEntraNoAero: temOrdem ? (entraEhToken0NoAero ? res.r0 : res.r1) : null,
            reservaSaiNoAero: temOrdem ? (entraEhToken0NoAero ? res.r1 : res.r0) : null,
            aeroEhVolatile: t0V3 === null ? null : (c.aeroEstavel === null ? null : !c.aeroEstavel),
        });
        t.veredictos.set(c.chave, v);
        if (!v.vale) { t.recusadasPorSpread.push(c); continue; }
        if (v.razoes.emprestimo === null || v.razoes.venda === null) {
            if (c.aeroEstavel === true) t.semProvaDoInvariante += 1; else t.semDados += 1;
        }
        t.valem.push(c);
    }
    return t;
}
