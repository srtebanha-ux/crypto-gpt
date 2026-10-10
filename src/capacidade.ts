/**
 * ESGOTAMENTO DE CAPACIDADE: a recusa que NAO passa com o tempo.
 *
 * POR QUE ESTE ARQUIVO EXISTE. O provedor respondeu, com estas palavras:
 *
 *     Monthly capacity limit exceeded
 *
 * `classificarRecusa` ja a classifica como 'cota' e NAO a absorve esperando —
 * isso esta certo e e o que impede a escada de espera de queimar o que sobrou.
 * Mas havia um buraco maior atras disso: **a recusa era esquecida.** Cada
 * chamada nova descobria o esgotamento de novo, e `talvezVoltarAoPrimario`
 * devolvia o trafego ao provedor esgotado assim que o castigo de tempo vencia —
 * porque o castigo mede TEMPO, e cota nao volta com tempo.
 *
 * Ela mandou: *"Suspenda o retorno automático frequente à Alchemy enquanto
 * essa condição persistir. Registre o motivo e defina recuperação por
 * confirmação de disponibilidade, mudança de configuração ou sondagem espaçada
 * com limite explícito."*
 *
 * As TRES recuperacoes estao aqui, e nenhuma delas e "esperar um pouco":
 *
 *   1. CONFIRMACAO   uma sondagem que PASSA libera o provedor (`confirmou`).
 *   2. CONFIGURACAO  trocar a lista de RPC reinicia o estado (`esquecer`).
 *   3. SONDAGEM      espacada, com TETO EXPLICITO de tentativas por janela.
 *      Esgotado o teto, nao se sonda mais ate a janela virar — porque sondar
 *      contra cota zerada e gastar o que nao existe.
 *
 * O QUE ISTO NAO SABE, declarado: quanto credito resta, quando a cota vira, e
 * quanto cada chamada custa em CU. Nada disso vem na resposta do provedor. O
 * inventario abaixo conta CHAMADAS OBSERVADAS, que e fato; CU seria estimativa,
 * e `inventarioComCU` a marca como tal em todas as linhas.
 */

/** Quanto esperar entre duas sondagens de um provedor esgotado. */
export const ENTRE_SONDAGENS_MS = 30 * 60_000;

/** Quantas sondagens no maximo, por janela de cota. */
export const SONDAGENS_POR_JANELA = 6;

/** A janela em que o teto de sondagens vale. Um dia, nao um mes: */
// a cota e MENSAL, mas um teto mensal de 6 sondagens deixaria o bot cego por
// semanas se a cota virasse no dia seguinte. Seis por DIA, espacadas de 30
// minutos, custam 6 chamadas e descobrem a virada em meio dia.
export const JANELA_DE_SONDAGEM_MS = 24 * 60 * 60_000;

export interface EstadoDeProvedor {
    /** `null` enquanto nunca foi declarado esgotado. */
    esgotadoEm: number | null;
    /** A mensagem SANITIZADA que declarou o esgotamento. */
    motivo: string | null;
    sondagens: number;
    ultimaSondagemEm: number | null;
    /** Quando a janela de sondagem comecou a contar. */
    janelaComecouEm: number | null;
}

/**
 * Tira de uma mensagem de erro qualquer coisa que possa ser credencial.
 *
 * A URL do provedor TEM a chave no caminho, e mensagens de erro repetem a URL.
 * Sem isto, a linha de log que explica o esgotamento publicaria a chave.
 */
export function sanitizar(mensagem: string): string {
    return mensagem
        .replace(/[a-z]+:\/\/[^\s"']+/gi, (url) => {
            try { return `${new URL(url).protocol}//${new URL(url).host}/…`; } catch { return '…'; }
        })
        // Qualquer palavra longa de aparencia aleatoria: chave de API.
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '…')
        .slice(0, 200);
}

export class ControleDeCapacidade {
    private readonly porProvedor = new Map<string, EstadoDeProvedor>();

    constructor(private readonly agora: () => number = () => Date.now()) {}

    private estado(chave: string): EstadoDeProvedor {
        const e = this.porProvedor.get(chave)
            ?? { esgotadoEm: null, motivo: null, sondagens: 0, ultimaSondagemEm: null, janelaComecouEm: null };
        this.porProvedor.set(chave, e);
        return e;
    }

    /** Declara o provedor esgotado. Idempotente: nao reinicia o relogio. */
    esgotou(chave: string, mensagem: string): void {
        const e = this.estado(chave);
        if (e.esgotadoEm === null) {
            e.esgotadoEm = this.agora();
            e.motivo = sanitizar(mensagem);
            e.janelaComecouEm = this.agora();
            e.sondagens = 0;
        }
    }

    /** RECUPERACAO 1: uma leitura que PASSOU prova disponibilidade. */
    confirmou(chave: string): boolean {
        const e = this.porProvedor.get(chave);
        if (e === undefined || e.esgotadoEm === null) return false;
        this.porProvedor.delete(chave);
        return true;
    }

    /** RECUPERACAO 2: mudanca de configuracao apaga o que se sabia. */
    esquecer(): void { this.porProvedor.clear(); }

    estaEsgotado(chave: string): boolean {
        return this.porProvedor.get(chave)?.esgotadoEm != null;
    }

    /**
     * RECUPERACAO 3: pode sondar agora?
     *
     * Devolve `false` quando o provedor nao esta esgotado (nao ha o que sondar),
     * quando a ultima sondagem foi recente, e quando o TETO da janela acabou.
     * Quem chama marca a tentativa com `sondou`, mesmo que ela falhe — senao
     * uma falha nao contaria e o teto seria letra morta.
     */
    podeSondar(chave: string): boolean {
        const e = this.porProvedor.get(chave);
        if (e === undefined || e.esgotadoEm === null) return false;
        const agora = this.agora();
        if (e.janelaComecouEm !== null && agora - e.janelaComecouEm >= JANELA_DE_SONDAGEM_MS) {
            e.janelaComecouEm = agora;
            e.sondagens = 0;
        }
        if (e.sondagens >= SONDAGENS_POR_JANELA) return false;
        if (e.ultimaSondagemEm !== null && agora - e.ultimaSondagemEm < ENTRE_SONDAGENS_MS) return false;
        return true;
    }

    /** Marca uma sondagem tentada. Conta mesmo quando ela falha. */
    sondou(chave: string): void {
        const e = this.estado(chave);
        e.sondagens += 1;
        e.ultimaSondagemEm = this.agora();
    }

    /** A frase do log: por que este provedor esta de fora e o que o traz de volta. */
    comoLer(chave: string): string {
        const e = this.porProvedor.get(chave);
        if (e === undefined || e.esgotadoEm === null) return `${chave}: sem esgotamento registrado`;
        const min = (this.agora() - e.esgotadoEm) / 60_000;
        const restam = SONDAGENS_POR_JANELA - e.sondagens;
        return `${chave}: CAPACIDADE ESGOTADA há ${min.toFixed(0)} min — "${e.motivo}". `
            + 'Isto NÃO é falha transitória: esperar não resolve, e repetir gasta o que sobrou. '
            + `Volta por (1) sondagem que passe, (2) troca de configuração, ou (3) sondagem `
            + `espaçada de ${(ENTRE_SONDAGENS_MS / 60_000).toFixed(0)} min — `
            + `${restam} de ${SONDAGENS_POR_JANELA} restam nesta janela de 24h`;
    }

    /** Os provedores esgotados, para o resumo do ciclo. */
    esgotados(): string[] {
        return [...this.porProvedor.entries()].filter(([, e]) => e.esgotadoEm !== null).map(([k]) => k);
    }
}

// ---------------------------------------------------------------------------
// INVENTARIO DE CONSUMO, por TAREFA e por METODO.
//
// Ela pediu: *"Separe chamadas observadas de estimativas de CU."* As duas coisas
// vivem em campos diferentes de proposito, e a frase do inventario diz qual e
// qual. O provedor nao devolve CU consumido em nenhuma resposta — entao CU aqui
// e sempre multiplicacao minha por uma tabela, e a tabela esta declarada.
// ---------------------------------------------------------------------------

/** As tarefas que gastam RPC. Separadas porque PAUSAM em ordem diferente. */
export type Tarefa = 'monitoramento' | 'varreduraCompleta' | 'historico' | 'morpho' | 'reconexao' | 'sondagem';

/** As tarefas SECUNDARIAS: pausam primeiro, antes de sobrecarregar o fallback. */
export const SECUNDARIAS: readonly Tarefa[] = ['historico', 'morpho', 'varreduraCompleta'];

/**
 * ESTIMATIVA de CU por metodo. NAO MEDIDO: nenhuma resposta do provedor diz
 * quanto custou. Sao os pesos publicados da Alchemy como eu os conheco, e por
 * isso toda linha derivada daqui sai rotulada ESTIMADO.
 *
 * Se algum dia o painel der o numero real, ele entra aqui e o rotulo muda.
 */
export const CU_ESTIMADO_POR_METODO: Record<string, number> = {
    eth_call: 26,
    eth_getLogs: 75,
    eth_blockNumber: 10,
    eth_getBalance: 11,
    eth_getTransactionCount: 11,
    eth_getBlockByNumber: 16,
    eth_estimateGas: 87,
    eth_sendRawTransaction: 250,
    net_version: 0,
};

export class Inventario {
    /** chave: `${tarefa}|${metodo}` -> chamadas OBSERVADAS. */
    private readonly contas = new Map<string, number>();

    contar(tarefa: Tarefa, metodo: string, quantas = 1): void {
        const k = `${tarefa}|${metodo}`;
        this.contas.set(k, (this.contas.get(k) ?? 0) + quantas);
    }

    /** As chamadas observadas, por tarefa e metodo. Fato, sem estimativa. */
    chamadasObservadas(): Array<{ tarefa: Tarefa; metodo: string; chamadas: number }> {
        return [...this.contas.entries()]
            .map(([k, chamadas]) => {
                const [tarefa, metodo] = k.split('|') as [Tarefa, string];
                return { tarefa, metodo, chamadas };
            })
            .sort((a, b) => b.chamadas - a.chamadas);
    }

    totalObservado(): number {
        let t = 0;
        for (const v of this.contas.values()) t += v;
        return t;
    }

    /**
     * O inventario com CU ESTIMADO ao lado — e a palavra ESTIMADO em cada linha.
     *
     * Metodo sem peso na tabela sai com `cuEstimado: null`, nunca zero: zero
     * diria "nao custa nada", e o que se sabe e "eu nao sei o peso dele".
     */
    inventarioComCU(): Array<{
        tarefa: Tarefa; metodo: string; chamadasObservadas: number;
        cuEstimado: number | null; origemDoCU: string;
    }> {
        return this.chamadasObservadas().map((l) => {
            const peso = CU_ESTIMADO_POR_METODO[l.metodo];
            return {
                ...l,
                chamadasObservadas: l.chamadas,
                cuEstimado: peso === undefined ? null : peso * l.chamadas,
                origemDoCU: peso === undefined
                    ? 'NÃO SEI o peso deste método: o provedor não devolve CU em resposta nenhuma'
                    : 'ESTIMADO pela tabela de pesos, não medido',
            };
        }).map(({ chamadas, ...resto }) => { void chamadas; return resto; });
    }

    /** CU estimado total, e quantas chamadas ficaram SEM peso conhecido. */
    cuEstimadoTotal(): { cu: number; chamadasSemPeso: number } {
        let cu = 0; let semPeso = 0;
        for (const l of this.chamadasObservadas()) {
            const p = CU_ESTIMADO_POR_METODO[l.metodo];
            if (p === undefined) semPeso += l.chamadas; else cu += p * l.chamadas;
        }
        return { cu, chamadasSemPeso: semPeso };
    }

    /**
     * A projecao diaria, a partir da janela OBSERVADA.
     *
     * `null` quando a janela e curta demais para projetar — e o corte nao e
     * palpite: abaixo de 10 minutos, um unico ciclo de varredura completa (que
     * roda de 15 em 15 min) entra ou nao entra na amostra e muda a projecao por
     * um fator grande. Extrapolar dali e a REGRA 4 deste projeto.
     */
    porDia(janelaMs: number): { chamadas: number; cuEstimado: number } | null {
        if (janelaMs < 10 * 60_000) return null;
        const fator = (24 * 60 * 60_000) / janelaMs;
        return {
            chamadas: Math.round(this.totalObservado() * fator),
            cuEstimado: Math.round(this.cuEstimadoTotal().cu * fator),
        };
    }
}

/**
 * Quais tarefas PAUSAR agora, e por que.
 *
 * Ela pediu: *"Pause ou reduza tarefas secundárias antes de sobrecarregar o
 * fallback."* A ordem nao e preferencia minha: monitoramento e o unico que
 * precisa estar vivo no instante do alvo; historico e censo respondem perguntas
 * que esperam; a varredura completa esta no meio, e pausa por ultimo entre as
 * secundarias porque e ela que povoa a brasa.
 */
export function oQuePausar(e: { algumEsgotado: boolean; noFallback: boolean }): {
    pausar: Tarefa[]; porque: string;
} {
    if (e.algumEsgotado) {
        return {
            pausar: [...SECUNDARIAS],
            porque: 'capacidade esgotada em algum provedor: as secundárias param para o que sobra '
                + 'de cota ficar com o monitoramento, que é o único que precisa estar vivo no '
                + 'instante do alvo',
        };
    }
    if (e.noFallback) {
        return {
            pausar: ['historico', 'morpho'],
            porque: 'estou no provedor de reserva: histórico e censo esperam, e sobrecarregar o '
                + 'fallback é ficar sem nenhum dos dois',
        };
    }
    return { pausar: [], porque: 'nenhum provedor esgotado e estou no primário: nada a pausar' };
}
