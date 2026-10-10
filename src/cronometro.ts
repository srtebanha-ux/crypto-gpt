/**
 * O CRONOMETRO do caminho quente — onde o tempo e gasto, medido.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Em 2026-10-09 ficou medido que a ordem dentro
 * da fatia do bloco e decidida pelo LANCE, mas a FATIA em que se cai e
 * decidida pela CHEGADA. Entao a latencia e metade da captura — e nunca foi
 * medida: o que havia era `tempoDeResposta: "7952ms"` da varredura completa,
 * que e outra coisa (historico, nao urgente).
 *
 * Ela mandou, em 2026-10-10:
 *
 *   "Use relógio monotônico para durações e um identificador por avaliação.
 *    Separe tempo total de tempo acumulado das chamadas paralelas. Não some
 *    chamadas paralelas como se fossem etapas sequenciais."
 *
 * As tres exigencias estao no desenho:
 *
 *   RELOGIO MONOTONICO  `process.hrtime.bigint()`. `Date.now()` anda para tras
 *                       quando o NTP ajusta, e uma duracao negativa num log de
 *                       latencia e pior que nenhuma.
 *   UM ID POR AVALIACAO Cada candidato gera uma `Avaliacao` com id proprio, e
 *                       as etapas dela nao se misturam com as de outro.
 *   PARALELO SEPARADO   Uma etapa marcada `paralelo` entra na soma do GRUPO,
 *                       nao na soma sequencial. Somar as duas medicoes do V1 e
 *                       do V2 como se fossem sequenciais dobraria o tempo que
 *                       o bot de fato gasta.
 *
 * E o que NAO se mede aqui: inclusao. Rapidez de montagem nao prova captura —
 * esta frase e dela, e o `resumo()` a repete.
 */

export type Etapa =
    | 'sinal'        // o bloco novo chegou (WebSocket ou pergunta)
    | 'leitura'      // o multicall que le a brasa
    | 'decisao'      // `decidirTiro` e os portoes
    | 'cotacao'      // preco de mercado / do oraculo
    | 'simulacao'    // o `eth_call` dos contratos
    | 'montagem'     // `codificarCacaV1/V2` + limite de gas + piso
    | 'transmissao'; // o envio — ou o interceptador

export type ComoCorreu = 'ok' | 'timeout' | 'recusada' | 'falhou' | 'vazia';

export interface Marca {
    etapa: Etapa;
    ms: number;
    /** `true` quando esta marca correu ao lado de outras no mesmo grupo. */
    paralelo: boolean;
    /** Nome do grupo paralelo, para a parede do grupo ser medida uma vez. */
    grupo?: string;
    comoCorreu: ComoCorreu;
    /** Tentativas gastas nesta etapa (1 = passou de primeira). */
    tentativas: number;
    /** Espera deliberada dentro da etapa (recuo, fila, sono). */
    esperaMs: number;
    detalhe?: string;
}

export interface Avaliacao {
    id: string;
    /** `real` = candidato que apareceu; `controlado` = cenario que eu montei. */
    cenario: 'real' | 'controlado';
    alvo: string | null;
    bloco: number | null;
    marcas: Marca[];
    /** Parede do inicio ao fim — NAO e a soma das marcas. */
    totalMs: number | null;
    /** Parede de cada grupo paralelo, medida uma vez por grupo. */
    paredeDosGrupos: Record<string, number>;
    terminouComo: ComoCorreu | null;
    porque: string | null;
}

/** Nanossegundos monotonicos para milissegundos, com uma casa. */
const msDe = (ini: bigint, fim: bigint) => Number(fim - ini) / 1e6;

/**
 * Uma avaliacao em curso.
 *
 * O uso e `const c = cronometrar(...)`, depois `c.etapa('leitura')` devolvendo
 * um fechador, e no fim `c.fechar(...)`. Nada aqui faz I/O: o cronometro nao
 * pode custar o bloco que ele existe para medir.
 */
export class AvaliacaoEmCurso {
    private readonly ini = process.hrtime.bigint();

    private readonly marcas: Marca[] = [];

    private readonly grupos = new Map<string, { ini: bigint; fim: bigint }>();

    constructor(
        readonly id: string,
        readonly cenario: 'real' | 'controlado',
        readonly alvo: string | null,
        readonly bloco: number | null,
    ) {}

    /**
     * Abre uma etapa. O retorno fecha, com o desfecho e as tentativas.
     *
     * `grupo` marca a etapa como PARALELA: ela entra na parede do grupo, e nao
     * na soma sequencial.
     */
    etapa(etapa: Etapa, grupo?: string): (r?: {
        comoCorreu?: ComoCorreu; tentativas?: number; esperaMs?: number; detalhe?: string;
    }) => number {
        const a = process.hrtime.bigint();
        if (grupo !== undefined && !this.grupos.has(grupo)) {
            this.grupos.set(grupo, { ini: a, fim: a });
        }
        return (r = {}) => {
            const b = process.hrtime.bigint();
            const g = grupo === undefined ? undefined : this.grupos.get(grupo);
            if (g !== undefined && b > g.fim) g.fim = b;
            const ms = msDe(a, b);
            this.marcas.push({
                etapa, ms, paralelo: grupo !== undefined, grupo,
                comoCorreu: r.comoCorreu ?? 'ok',
                tentativas: r.tentativas ?? 1,
                esperaMs: r.esperaMs ?? 0,
                detalhe: r.detalhe,
            });
            return ms;
        };
    }

    /**
     * Registra uma etapa cuja duracao foi medida FORA daqui.
     *
     * Existe para o 'sinal': o instante do aviso de bloco e capturado no laco
     * de espera, e a duracao ate a primeira leitura nao cabe no par
     * abre/fecha. Sem isto eu empurrava direto no array privado — e o
     * TypeScript recusou, com razao.
     */
    marcarDuracao(etapa: Etapa, ms: number, r: {
        comoCorreu?: ComoCorreu; tentativas?: number; esperaMs?: number; detalhe?: string;
    } = {}): void {
        this.marcas.push({
            etapa, ms: Number.isFinite(ms) && ms >= 0 ? ms : 0, paralelo: false,
            comoCorreu: r.comoCorreu ?? 'ok', tentativas: r.tentativas ?? 1,
            esperaMs: r.esperaMs ?? 0, detalhe: r.detalhe,
        });
    }

    fechar(terminouComo: ComoCorreu, porque: string | null = null): Avaliacao {
        return {
            id: this.id, cenario: this.cenario, alvo: this.alvo, bloco: this.bloco,
            marcas: [...this.marcas],
            totalMs: msDe(this.ini, process.hrtime.bigint()),
            paredeDosGrupos: Object.fromEntries(
                [...this.grupos].map(([n, g]) => [n, msDe(g.ini, g.fim)]),
            ),
            terminouComo, porque,
        };
    }
}

export function cronometrar(
    id: string, cenario: 'real' | 'controlado',
    alvo: string | null = null, bloco: number | null = null,
): AvaliacaoEmCurso {
    return new AvaliacaoEmCurso(id, cenario, alvo, bloco);
}

/** Um id curto e unico por avaliacao, sem depender de biblioteca. */
let contador = 0;
export function idDeAvaliacao(): string {
    contador += 1;
    return `${Date.now().toString(36)}-${contador.toString(36)}`;
}

/** O percentil de uma lista. Vazia devolve `null` — nao zero. */
export function percentil(v: number[], q: number): number | null {
    if (v.length === 0) return null;
    const s = [...v].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
    return s[i]!;
}

export interface ResumoDeEtapa {
    etapa: Etapa;
    amostras: number;
    p50: number | null;
    p90: number | null;
    p99: number | null;
    max: number | null;
    /** Quantas vezes esta etapa NAO correu bem, por desfecho. */
    desfechos: Partial<Record<ComoCorreu, number>>;
    tentativasExtras: number;
    esperaTotalMs: number;
    /** `true` se esta etapa foi medida dentro de grupo paralelo em algum caso. */
    houveParalelo: boolean;
}

/**
 * O livro das avaliacoes, com janela de parede e contagem de amostras.
 *
 * Guarda no maximo `teto` avaliacoes: medir latencia nao pode virar vazamento
 * de memoria no processo que precisa ser rapido.
 */
export class LivroDeTempos {
    private avaliacoes: Avaliacao[] = [];

    private primeiraEm: number | null = null;

    private ultimaEm: number | null = null;

    constructor(private readonly teto = 500) {}

    guardar(a: Avaliacao): void {
        const agora = Date.now();
        if (this.primeiraEm === null) this.primeiraEm = agora;
        this.ultimaEm = agora;
        this.avaliacoes.push(a);
        if (this.avaliacoes.length > this.teto) this.avaliacoes.shift();
    }

    quantas(cenario?: 'real' | 'controlado'): number {
        return cenario === undefined
            ? this.avaliacoes.length
            : this.avaliacoes.filter((a) => a.cenario === cenario).length;
    }

    /**
     * O resumo, SEPARADO por cenario — porque misturar um cenario controlado
     * com observacao real daria um numero que nao descreve nenhum dos dois.
     */
    resumo(cenario: 'real' | 'controlado'): {
        cenario: 'real' | 'controlado';
        amostras: number;
        janelaMs: number;
        total: { p50: number | null; p90: number | null; p99: number | null; max: number | null };
        /** A soma das etapas SEQUENCIAIS, mediana — o caminho critico. */
        somaSequencialP50: number | null;
        etapas: ResumoDeEtapa[];
        paredeDosGrupos: Record<string, { p50: number | null; p90: number | null }>;
        oQueIssoNaoMede: string;
    } {
        const minhas = this.avaliacoes.filter((a) => a.cenario === cenario);
        const etapas: Etapa[] = ['sinal', 'leitura', 'decisao', 'cotacao', 'simulacao', 'montagem', 'transmissao'];
        const porEtapa = etapas.map((e): ResumoDeEtapa => {
            const marcas = minhas.flatMap((a) => a.marcas.filter((m) => m.etapa === e));
            const ms = marcas.map((m) => m.ms);
            const desfechos: Partial<Record<ComoCorreu, number>> = {};
            for (const m of marcas) desfechos[m.comoCorreu] = (desfechos[m.comoCorreu] ?? 0) + 1;
            return {
                etapa: e, amostras: marcas.length,
                p50: percentil(ms, 0.5), p90: percentil(ms, 0.9),
                p99: percentil(ms, 0.99), max: ms.length === 0 ? null : Math.max(...ms),
                desfechos,
                tentativasExtras: marcas.reduce((s, m) => s + (m.tentativas - 1), 0),
                esperaTotalMs: marcas.reduce((s, m) => s + m.esperaMs, 0),
                houveParalelo: marcas.some((m) => m.paralelo),
            };
        });
        const totais = minhas.map((a) => a.totalMs).filter((x): x is number => x !== null);
        // A soma SEQUENCIAL de cada avaliacao: as paralelas entram pela parede
        // do grupo, uma vez — somar cada uma inflaria o caminho critico.
        const somas = minhas.map((a) => {
            const seq = a.marcas.filter((m) => !m.paralelo).reduce((s, m) => s + m.ms, 0);
            const grupos = Object.values(a.paredeDosGrupos).reduce((s, v) => s + v, 0);
            return seq + grupos;
        });
        const nomes = new Set(minhas.flatMap((a) => Object.keys(a.paredeDosGrupos)));
        const paredeDosGrupos: Record<string, { p50: number | null; p90: number | null }> = {};
        for (const n of nomes) {
            const v = minhas.map((a) => a.paredeDosGrupos[n]).filter((x): x is number => x !== undefined);
            paredeDosGrupos[n] = { p50: percentil(v, 0.5), p90: percentil(v, 0.9) };
        }
        return {
            cenario, amostras: minhas.length,
            janelaMs: this.primeiraEm === null || this.ultimaEm === null ? 0 : this.ultimaEm - this.primeiraEm,
            total: {
                p50: percentil(totais, 0.5), p90: percentil(totais, 0.9),
                p99: percentil(totais, 0.99), max: totais.length === 0 ? null : Math.max(...totais),
            },
            somaSequencialP50: percentil(somas, 0.5),
            etapas: porEtapa,
            paredeDosGrupos,
            oQueIssoNaoMede: 'INCLUSÃO. Rapidez de montagem ou simulação não prova captura: '
                + 'a fatia em que a transação cai depende da chegada, e isso só o recibo diz',
        };
    }

    /** A etapa que mais pesa na mediana — o gargalo OBSERVADO. */
    gargalo(cenario: 'real' | 'controlado'): { etapa: Etapa; p50: number } | null {
        const r = this.resumo(cenario);
        let pior: { etapa: Etapa; p50: number } | null = null;
        for (const e of r.etapas) {
            if (e.p50 === null) continue;
            if (pior === null || e.p50 > pior.p50) pior = { etapa: e.etapa, p50: e.p50 };
        }
        return pior;
    }
}

/** A frase do log. Diz AMOSTRAS e JANELA ao lado dos percentis, sempre. */
export function comoLerOsTempos(r: ReturnType<LivroDeTempos['resumo']>): string {
    if (r.amostras === 0) {
        return `nenhuma avaliação ${r.cenario} medida ainda — e isto não é "o bot é rápido"`;
    }
    const etapas = r.etapas
        .filter((e) => e.amostras > 0)
        .map((e) => `${e.etapa} ${e.p50?.toFixed(1)}/${e.p90?.toFixed(1)}ms`
            + (e.houveParalelo ? ' [paralela]' : '')
            + (e.tentativasExtras > 0 ? ` +${e.tentativasExtras} retent.` : '')
            + (Object.entries(e.desfechos).filter(([k]) => k !== 'ok')
                .map(([k, v]) => ` ${v}x ${k}`).join('')))
        .join(' | ');
    const grupos = Object.entries(r.paredeDosGrupos)
        .map(([n, g]) => `${n}: parede ${g.p50?.toFixed(1)}ms`).join(', ');
    // O `total` e PAREDE DO CICLO: ele inclui o sono da postura (8000ms
    // dormindo, 200ms no gatilho). Publicar isso como "latencia" seria o
    // defeito que este projeto persegue — um numero que nao descreve o que o
    // nome diz. A latencia e o CAMINHO CRITICO.
    return `${r.amostras} avaliação(ões) ${r.cenario} em ${(r.janelaMs / 1000).toFixed(0)}s `
        + `| LATÊNCIA (caminho crítico, só o trabalho) p50 ${r.somaSequencialP50?.toFixed(1)}ms `
        + `| parede do ciclo — INCLUI o sono da postura — p50 ${r.total.p50?.toFixed(1)}ms `
        + `p90 ${r.total.p90?.toFixed(1)}ms p99 ${r.total.p99?.toFixed(1)}ms `
        + `|| ${etapas}${grupos === '' ? '' : ` || grupos paralelos — ${grupos}`}`;
}
