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
    /** `factory()` do pool. Duas fabricas diferentes e o caso que os vencedores usam. */
    fabrica?: string | null;
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

/**
 * UMA PERNA DESCRITA — pool, token que entra, protocolo, fabrica, fee e curva.
 *
 * ORDEM DELA, 2026-10-16: *"NAO reutilize incorretamente os campos
 * `poolAerodrome` e `poolV3` para representar dois pools V3. Generalize a
 * candidata para conter duas pernas tipadas, com pool, token de entrada,
 * protocolo, fabrica, fee tier e direcao."*
 *
 * A DIRECAO esta na ORDEM: a perna 0 EMPRESTA (entra a base) e a perna 1 VENDE
 * (entra o token do meio). Nao existe campo `direcao` nesta forma — a troca das
 * duas pernas E a outra direcao, e isso elimina a classe de defeito em que o
 * rotulo e a rota discordam.
 */
export interface PernaDescrita {
    pool: string;
    /** O token que ENTRA nesta perna. */
    tokenEntra: string;
    protocolo: Venue;
    /** `factory()` do pool. `null` = nao lida; nao lida nao autoriza supor. */
    fabrica: string | null;
    /** Fee tier do V3 em centesimos de ponto base. `null` no Aerodrome. */
    taxa: number | null;
    /** `stable()` do Aerodrome. `null` no V3 ou nao lido. */
    estavel: boolean | null;
    /** `token0` do pool — diz de que lado o token entra. */
    token0: string;
}

export interface CandidataMista {
    /** O token do meio — o que nao e a base. */
    token: string;
    poolAerodrome?: string;
    poolV3?: string;
    /**
     * SO em rota mista (uma perna Aerodrome, uma V3). Ausente em rota
     * concentrado<->concentrado, onde "A/B" nao descreve nada.
     */
    direcao?: 'A' | 'B';
    /**
     * `token0` do pool V3, em minusculo — ele diz de que LADO o token do meio
     * esta, e e isso que inverte a razao do filtro. Vem da descoberta, nao de
     * leitura nova. `null` manda cotar: lado desconhecido nao descarta.
     */
    token0DoV3?: string | null;
    /** `token0` do pool AERODROME, em minusculo — diz qual reserva e a de entrada. */
    token0DoAero?: string | null;
    /** `stable()` do pool Aerodrome. So `false` autoriza descarte. */
    aeroEstavel?: boolean | null;
    /** A chave que identifica a rota, para nao contar a mesma duas vezes. */
    chave: string;
    /**
     * AS DUAS PERNAS, tipadas: a 0 empresta, a 1 vende. E esta a forma que o
     * motor le — filtro, dimensionamento, cotacao e consistencia.
     */
    pernas: [PernaDescrita, PernaDescrita];
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
    const descrever = (q: PoolMisto, tokenEntra: string): PernaDescrita => ({
        pool: q.endereco.toLowerCase(),
        tokenEntra,
        protocolo: q.venue,
        fabrica: q.fabrica === undefined ? null : (q.fabrica?.toLowerCase() ?? null),
        taxa: q.taxa,
        estavel: q.estavel ?? null,
        token0: q.token0.toLowerCase(),
    });

    // Por TOKEN DO MEIO: todo pool que compartilha o par {base, token}.
    const porToken = new Map<string, PoolMisto[]>();
    for (const q of pools) {
        const t = outro(q);
        if (t === null) continue;
        const l = porToken.get(t) ?? [];
        l.push(q);
        porToken.set(t, l);
    }

    const fora: CandidataMista[] = [];
    const vistas = new Set<string>();
    for (const [token, lista] of porToken) {
        for (let a = 0; a < lista.length; a += 1) {
            for (let b = 0; b < lista.length; b += 1) {
                if (a === b) continue;
                const empresta = lista[a]!;
                const vende = lista[b]!;
                if (empresta.endereco.toLowerCase() === vende.endereco.toLowerCase()) continue;
                // DOIS POOLS DO MESMO AERODROME nao formam ciclo util aqui: o
                // executor empresta de um e vende no outro, e dois pools
                // Velodrome V2 do mesmo par e o caso que a ENTREGA 1 ja cobre.
                // O que ENTRA agora e concentrado<->concentrado, medido: 2 das
                // 7 operacoes lucrativas sao exatamente esta forma (`CC`, 2
                // swaps), e 131 dos 156 pares no mesmo token cruzam fabrica.
                if (empresta.venue === 'aerodrome' && vende.venue === 'aerodrome') continue;
                // A chave e a ORDEM das duas pernas: trocar a ordem e a outra
                // direcao, e as duas contam separado.
                const chave = `${empresta.endereco.toLowerCase()}>${vende.endereco.toLowerCase()}`
                    + `|${token}`;
                if (vistas.has(chave)) continue;
                vistas.add(chave);
                const pernas: [PernaDescrita, PernaDescrita] = [
                    descrever(empresta, base),
                    descrever(vende, token),
                ];
                // Os campos antigos ficam SO quando descrevem a rota de
                // verdade: uma perna Aerodrome e uma V3. Em rota
                // concentrado<->concentrado eles ficam ausentes em vez de
                // mentir sobre qual pool e qual.
                const misto = (empresta.venue === 'aerodrome') !== (vende.venue === 'aerodrome');
                const aero = empresta.venue === 'aerodrome' ? empresta : vende;
                const v3 = empresta.venue === 'aerodrome' ? vende : empresta;
                fora.push({
                    token,
                    chave,
                    pernas,
                    ...(misto ? {
                        direcao: empresta.venue === 'aerodrome' ? 'A' as const : 'B' as const,
                        poolAerodrome: aero.endereco.toLowerCase(),
                        poolV3: v3.endereco.toLowerCase(),
                        token0DoV3: v3.token0.toLowerCase(),
                        aeroEstavel: aero.estavel ?? null,
                    } : {}),
                });
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
    c: CandidataMista, tokenBase: string, pagamentoDaPerna0: bigint,
): PernaMista[] {
    const base = tokenBase.toLowerCase();
    return c.pernas.map((p, i) => ({
        pool: p.pool,
        tokenEntra: i === 0 ? base : p.tokenEntra,
        tipo: (p.protocolo === 'aerodrome' ? 1 : 0) as 0 | 1,
        // O `pagamento` so e declarado na perna 0 do AERODROME: ali nao ha nada
        // em maos ainda. No V3 o callback paga pelo que o swap pede, e em perna
        // interna o `0n` quer dizer "gasta o que a anterior entregou".
        pagamento: i === 0 && p.protocolo === 'aerodrome' ? pagamentoDaPerna0 : 0n,
    }));
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
    /**
     * Amostras de estado LIDAS — inclui as que repetem o estado anterior.
     *
     * DEFEITO QUE ELA ACHOU: `estadosAvaliados` era incrementado ANTES do
     * descarte por impressao repetida, entao ele contava amostra, nao estado
     * distinto. Quatro perguntas diferentes viravam um numero so.
     */
    amostrasLidas: number;
    /** Estados DISTINTOS (impressao nova). */
    estadosDistintos: number;
    /** Estados distintos em que algum pool DE UMA ROTA mudou. */
    estadosComRotaAfetada: number;
    /** Sinais que de fato foram cotados (um `eth_call` que foi e voltou). */
    sinaisCotados: number;
    /** @deprecated use `estadosDistintos`. Mantido para o funil antigo. */
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
    amostrasLidas: 0,
    estadosDistintos: 0,
    estadosComRotaAfetada: 0,
    sinaisCotados: 0,
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
    if (f.estadosDistintos === 0) {
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
        + ` | ${f.amostrasLidas} amostra(s) lida(s), ${f.estadosDistintos} ESTADO(S) DISTINTO(S), `
        + `${f.estadosComRotaAfetada} com pool de rota alterado, `
        + `${f.sinaisCotados} sinal(is) COTADO(S) | pools `
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
    /**
     * A LIQUIDEZ ATIVA de cada pool V3.
     *
     * Ela existe porque `sqrtPriceX96` sozinho nao detecta mudanca de liquidez,
     * e liquidez mudada muda o resultado de um swap no MESMO preco. Ausente =
     * nao li, e nao li nao autoriza afirmar que o estado e o mesmo.
     */
    liquidezDoV3?: Map<string, bigint | null>;
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
    const t = {
        valem: [] as CandidataMista[],
        recusadasPorSpread: [] as CandidataMista[],
        semDados: 0,
        semProvaDoInvariante: 0,
        veredictos: new Map<string, VeredictoDoSpread>(),
    };
    for (const c of cs) {
        const v = semSpreadNoCiclo(c, L);
        t.veredictos.set(c.chave, v);
        if (!v.vale) { t.recusadasPorSpread.push(c); continue; }
        if (v.razoes.emprestimo === null || v.razoes.venda === null) {
            // STABLE e "nao li" pedem acoes OPOSTAS: a primeira e matematica
            // que falta fazer, a segunda e o RPC. Somar as duas esconderia qual.
            const stable = c.pernas.some(
                (p) => p.protocolo === 'aerodrome' && p.estavel === true,
            );
            if (stable) t.semProvaDoInvariante += 1; else t.semDados += 1;
        }
        t.valem.push(c);
    }
    return t;
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

/**
 * A RAZAO MAXIMA DE UMA PERNA, qualquer que seja o protocolo.
 *
 * V3        o preco spot de `sqrtPriceX96` — limite quando o tamanho tende a
 *           zero. Taxa e cruzamento de tick so pioram.
 * AERODROME `rSai / rEntra`, demonstrado de `x·y = k`, e SO para volatile
 *           comprovado. Stable devolve `null`, e `null` manda cotar.
 */
export function razaoDaPerna(p: PernaDescrita, L: LeiturasDoEstado): RazaoMaxima | null {
    const pool = p.pool.toLowerCase();
    if (p.protocolo === 'v3') {
        const sq = L.sqrtPorPoolV3.get(pool) ?? null;
        // A LIQUIDEZ tambem tem de estar lida: sem ela nao se pode afirmar que
        // o estado e conhecido, e o filtro so recusa com estado conhecido.
        const liq = L.liquidezDoV3?.get(pool);
        if (liq === null) return null;
        const entraEhToken0 = p.tokenEntra.toLowerCase() === p.token0;
        return razaoMaximaV3(sq ?? 0n, entraEhToken0);
    }
    const res = L.reservasAerodrome.get(pool) ?? null;
    if (res === null) return null;
    const entraEhToken0 = p.tokenEntra.toLowerCase() === p.token0;
    return razaoMaximaAerodrome(
        entraEhToken0 ? res.r0 : res.r1,
        entraEhToken0 ? res.r1 : res.r0,
        p.estavel === null ? null : !p.estavel,
    );
}

/**
 * O FILTRO DO CICLO, para DUAS pernas de qualquer protocolo.
 *
 * O produto das razoes maximas e adimensional por construcao — (token por base)
 * x (base por token) — e so recusa quando nao passa de 1. Ausencia de qualquer
 * razao manda cotar: "nao sei" nunca descarta.
 */
export function semSpreadNoCiclo(
    c: CandidataMista, L: LeiturasDoEstado,
): VeredictoDoSpread {
    const rEmp = razaoDaPerna(c.pernas[0], L);
    const rVen = razaoDaPerna(c.pernas[1], L);
    const razoes = { emprestimo: rEmp, venda: rVen };
    if (rEmp === null || rVen === null) {
        const qual = rEmp === null ? c.pernas[0] : c.pernas[1];
        return {
            vale: true,
            porque: qual.protocolo === 'aerodrome' && qual.estavel !== false
                ? 'perna Aerodrome que não é COMPROVADAMENTE volatile: o teto só está demonstrado '
                    + 'para `x·y = k`, então esta rota fica NÃO VALIDADA em vez de descartada'
                : `falta estado da perna ${qual.protocolo} ${qual.pool.slice(0, 10)} (preço, `
                    + 'liquidez ou reservas): sem o produto não há prova de inviabilidade, e '
                    + 'ausência não descarta rota',
            razoes,
        };
    }
    if (produtoPassaDeUm(rEmp, rVen)) {
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
            + 'fecha — e as unidades se cancelam, (token/base) × (base/token)',
        razoes,
    };
}
