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

import { classificarRecusa, type TipoDeRecusa } from './cobertura';

/** Quanto esperar entre duas sondagens de um provedor esgotado. */
export const ENTRE_SONDAGENS_MS = 30 * 60_000;

/** Quantas sondagens no maximo, por janela de cota. */
export const SONDAGENS_POR_JANELA = 6;

/** A janela em que o teto de sondagens vale. Um dia, nao um mes: */
// a cota e MENSAL, mas um teto mensal de 6 sondagens deixaria o bot cego por
// semanas se a cota virasse no dia seguinte. Seis por DIA, espacadas de 30
// minutos, custam 6 chamadas e descobrem a virada em meio dia.
export const JANELA_DE_SONDAGEM_MS = 24 * 60 * 60_000;

/**
 * O que se sabe sobre um provedor. TRES estados, nao dois.
 *
 * Ela recusou a frase `capacidade: "nenhum provedor esgotado"`: *"'Nenhum
 * esgotado' deve distinguir estado desconhecido de disponibilidade
 * confirmada."* Estava certa — aquela frase saia para um provedor que nunca foi
 * consultado e para um que acabou de responder, e sao conclusoes diferentes.
 *
 *   'desconhecido' nenhuma leitura ainda. NAO e disponibilidade.
 *   'disponivel'   uma leitura PASSOU, e quando.
 *   'esgotado'     respondeu esgotamento de capacidade.
 */
export type CondicaoDoProvedor = 'desconhecido' | 'disponivel' | 'esgotado';

export interface EstadoDeProvedor {
    /** `null` enquanto nunca foi declarado esgotado. */
    esgotadoEm: number | null;
    /** Quando uma leitura PASSOU por este provedor. `null` = nunca. */
    confirmadoEm: number | null;
    /**
     * Quando cada METODO passou neste provedor. `eth_getBalance` passar NAO
     * diz nada sobre `eth_getLogs`: sao limites diferentes no mesmo provedor, e
     * foi um `eth_getBalance` bom convivendo com `eth_getLogs` recusado que
     * motivou isto. Ela pediu: *"Sucesso em `eth_getBalance` não libera
     * automaticamente histórico por `eth_getLogs`."*
     */
    confirmadoPorMetodo: Record<string, number>;
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
            ?? { esgotadoEm: null, confirmadoEm: null, confirmadoPorMetodo: {}, motivo: null,
                sondagens: 0, ultimaSondagemEm: null, janelaComecouEm: null };
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

    /**
     * RECUPERACAO 1: uma leitura que PASSOU prova disponibilidade.
     *
     * Devolve `true` so quando isto FOI uma recuperacao — o provedor estava
     * esgotado e deixou de estar. Uma leitura normal apenas registra a
     * disponibilidade, e e ela que tira o provedor de 'desconhecido'.
     *
     * O estado NAO e apagado: apagar devolveria o provedor a 'desconhecido', e
     * "nunca perguntei" nao e o mesmo que "respondeu agora".
     */
    confirmou(chave: string, metodo?: string): boolean {
        const e = this.estado(chave);
        const recuperou = e.esgotadoEm !== null;
        e.esgotadoEm = null;
        e.motivo = null;
        e.confirmadoEm = this.agora();
        if (metodo !== undefined) e.confirmadoPorMetodo[metodo] = this.agora();
        return recuperou;
    }

    /** A condicao de um provedor. 'desconhecido' nao e disponibilidade. */
    condicao(chave: string, metodo?: string): CondicaoDoProvedor {
        const e = this.porProvedor.get(chave);
        if (e === undefined) return 'desconhecido';
        if (e.esgotadoEm !== null) return 'esgotado';
        if (metodo !== undefined) {
            // POR METODO: o provedor pode estar servindo `eth_call` e recusando
            // `eth_getLogs`. Herdar a disponibilidade de um metodo para outro
            // seria publicar como medido o que nao foi perguntado.
            return e.confirmadoPorMetodo[metodo] === undefined ? 'desconhecido' : 'disponivel';
        }
        return e.confirmadoEm === null ? 'desconhecido' : 'disponivel';
    }

    /** Os metodos que JA passaram neste provedor, com a idade da confirmacao. */
    metodosConfirmados(chave: string): Array<{ metodo: string; haQuantoMs: number }> {
        const e = this.porProvedor.get(chave);
        if (e === undefined) return [];
        return Object.entries(e.confirmadoPorMetodo)
            .map(([metodo, em]) => ({ metodo, haQuantoMs: this.agora() - em }));
    }

    /**
     * A linha de capacidade do log, POR PROVEDOR e com os tres estados.
     *
     * `provedores` e a lista configurada: um provedor que nunca foi chamado tem
     * de aparecer como DESCONHECIDO, e nao faltar da lista — faltar leria como
     * "esta tudo bem com ele".
     */
    porProvedorConfigurado(provedores: string[]): Array<{ provedor: string; condicao: CondicaoDoProvedor; detalhe: string }> {
        return provedores.map((p) => {
            const c = this.condicao(p);
            const e = this.porProvedor.get(p);
            if (c === 'esgotado') return { provedor: p, condicao: c, detalhe: this.comoLer(p) };
            if (c === 'disponivel') {
                const min = (this.agora() - (e!.confirmadoEm ?? 0)) / 60_000;
                return {
                    provedor: p, condicao: c,
                    detalhe: `uma leitura passou há ${min.toFixed(1)} min: disponibilidade CONFIRMADA`,
                };
            }
            return {
                provedor: p, condicao: c,
                detalhe: 'nenhuma leitura por este provedor nesta execução: estado DESCONHECIDO, '
                    + 'e desconhecido NÃO é disponível',
            };
        });
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
        // O INTERVALO VALE PARA A PRIMEIRA TAMBEM, e isto e um conserto.
        //
        // Ela mediu a contradicao: o castigo da escada e de 300s, e
        // `ultimaSondagemEm === null` deixava a primeira sondagem passar na
        // hora — entao a sondagem efetiva acontecia a 5 MINUTOS do
        // esgotamento, nao aos 30 que a frase anunciava. O relogio da primeira
        // conta de `esgotadoEm`.
        const desde = e.ultimaSondagemEm ?? e.esgotadoEm;
        if (agora - desde < ENTRE_SONDAGENS_MS) return false;
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

// ---------------------------------------------------------------------------
// A DECISAO SOBRE UMA RECUSA, fora do laco quente para poder ser exercitada.
//
// Ela pediu um teste de integracao com *"primário retornando exatamente essa
// recusa e secundário respondendo normalmente"*. `chamar` mora em
// `cacarAoVivo.ts`, que sobe o bot ao ser importado — entao um teste nao pode
// invoca-la. Replicar a decisao no teste provaria a COPIA, que e o defeito que
// este projeto registra mais vezes.
//
// A saida e esta funcao: ela decide, `chamar` a obedece, e um teste de codigo
// exige que `chamar` a chame em vez de decidir por conta.
// ---------------------------------------------------------------------------

export interface DecisaoSobreRecusa {
    /** Marcar o provedor como de capacidade esgotada. */
    marcarEsgotado: boolean;
    /** Deixar a escada trocar de degrau. */
    trocarDeProvedor: boolean;
    /** Esperar e repetir (so limitacao temporaria). */
    esperarERepetir: boolean;
    /** Lancar para quem chamou. */
    lancar: boolean;
    porque: string;
}

/**
 * O que fazer com uma recusa, dado o tipo e se a escada a reconhece.
 *
 * A ORDEM aqui e o conserto do log de 2026-10-10 19:57:12: a mensagem
 * `Monthly capacity limit exceeded` casa com `ehFalhaDeTransporte` (ela contem
 * `capacity` e `exceeded`), entao a escada a absorvia e o ramo da cota nunca
 * rodava. A classificacao vem PRIMEIRO; a troca de degrau continua
 * acontecendo, porque trocar esta certo — esquecer o motivo nao estava.
 */
export function decidirSobreRecusa(e: {
    mensagem: string;
    ehTransporte: boolean;
    classificar?: (m: string) => { tipo: TipoDeRecusa; absorveEsperando: boolean };
}): DecisaoSobreRecusa {
    const classificar = e.classificar ?? classificarRecusa;
    const c = classificar(e.mensagem);
    if (c.tipo === 'cota') {
        return {
            marcarEsgotado: true,
            // Trocar de degrau SIM: o secundario e justamente para isto.
            trocarDeProvedor: e.ehTransporte,
            esperarERepetir: false,
            lancar: !e.ehTransporte,
            porque: 'ESGOTAMENTO DE CAPACIDADE: marco o provedor, troco de degrau se a escada '
                + 'reconhece a falha, e NÃO espero — esperar não devolve cota e repetir gasta o '
                + 'que sobrou dela',
        };
    }
    if (e.ehTransporte) {
        return {
            marcarEsgotado: false, trocarDeProvedor: true, esperarERepetir: false, lancar: false,
            porque: 'falha de transporte: a escada troca de degrau e repete na hora, sem esperar',
        };
    }
    if (c.absorveEsperando) {
        return {
            marcarEsgotado: false, trocarDeProvedor: false, esperarERepetir: true, lancar: false,
            porque: `limitação ${c.tipo}: espera progressiva compartilhada por provedor`,
        };
    }
    return {
        marcarEsgotado: false, trocarDeProvedor: false, esperarERepetir: false, lancar: true,
        porque: `recusa ${c.tipo}: não trato como limite e devolvo o erro a quem chamou`,
    };
}

// ---------------------------------------------------------------------------
// ORCAMENTO DE UMA TAREFA INTEIRA — janelas E retentativas no mesmo bolso.
//
// MEDIDO no log de 2026-10-10 21:14:45, com `336bd0f` no ar: o censo de
// liquidacoes terminou com `janelasLidas: 0` e `janelasQueFalharam: 40`. O laco
// rodava as 40 janelas sempre, e cada `chamar` ainda repetia ate 4 vezes com a
// sua propria escada: ate 160 `eth_getLogs` contra um provedor que recusava
// tudo. O conserto de `336bd0f` era na DESCOBERTA DE DEVEDORES — outro
// chamador. Corrigir um nao corrige os demais.
//
// Este orcamento e por TAREFA: as janelas e as retentativas saem do mesmo
// numero, e quando ele acaba a tarefa ADIA em vez de insistir.
// ---------------------------------------------------------------------------

export class OrcamentoDaTarefa {
    private tentativasGastas = 0;
    private readonly comecouEm: number;
    private motivoDoFim: string | null = null;

    constructor(
        public readonly tarefa: Tarefa,
        private readonly tetoDeTentativas: number,
        private readonly tetoDeMs: number,
        private readonly agora: () => number = () => Date.now(),
    ) { this.comecouEm = this.agora(); }

    /** Pede uma tentativa. `false` quando o orcamento acabou. */
    pedir(): boolean {
        if (this.motivoDoFim !== null) return false;
        if (this.tentativasGastas >= this.tetoDeTentativas) {
            this.motivoDoFim = `teto de ${this.tetoDeTentativas} tentativas`;
            return false;
        }
        const decorrido = this.agora() - this.comecouEm;
        if (decorrido >= this.tetoDeMs) {
            this.motivoDoFim = `teto de ${(this.tetoDeMs / 1000).toFixed(0)}s de parede`;
            return false;
        }
        this.tentativasGastas += 1;
        return true;
    }

    /** Encerra o orcamento por um motivo de fora (recusa de cota, por exemplo). */
    encerrar(motivo: string): void { this.motivoDoFim ??= motivo; }

    esgotado(): boolean { return this.motivoDoFim !== null; }
    porqueAcabou(): string | null { return this.motivoDoFim; }
    gastas(): number { return this.tentativasGastas; }
    decorridoMs(): number { return this.agora() - this.comecouEm; }

    comoLer(): string {
        return `${this.tarefa}: ${this.tentativasGastas} de ${this.tetoDeTentativas} tentativas, `
            + `${(this.decorridoMs() / 1000).toFixed(1)}s de ${(this.tetoDeMs / 1000).toFixed(0)}s`
            + (this.motivoDoFim === null ? '' : ` — ESGOTADO: ${this.motivoDoFim}`);
    }
}

/**
 * O veredicto de uma varredura por janelas, calculado dos CONTADORES.
 *
 * MEDIDO no mesmo log: `janelasQueFalharam > janelasLidas / 4` com
 * `janelasLidas = 0` da `40 > 0` — verdadeiro —, e a frase publicada foi
 * *"um quarto das janelas falhou"* sobre 40 de 40. O denominador era o numero
 * de SUCESSOS, nao o total.
 *
 * E zero janelas lidas nao e "nenhuma liquidacao": e historico INDISPONIVEL.
 */
export function veredictoDaVarredura(e: { lidas: number; falharam: number; achados: number }): {
    disponivel: boolean; fracaoQueFalhou: number | null; frase: string;
} {
    const tentadas = e.lidas + e.falharam;
    const fracao = tentadas === 0 ? null : e.falharam / tentadas;
    if (e.lidas === 0) {
        return {
            disponivel: false, fracaoQueFalhou: fracao,
            frase: tentadas === 0
                ? 'NENHUMA janela foi tentada: não há o que concluir'
                : `HISTÓRICO INDISPONÍVEL: ${e.falharam} de ${tentadas} janelas falharam `
                  + `(${((fracao ?? 0) * 100).toFixed(1)}%) e NENHUMA foi lida. Isto não é `
                  + '"nenhuma liquidação" — é ausência de leitura, e nada pode ser concluído '
                  + 'sobre o mercado daqui',
        };
    }
    if (e.falharam > 0) {
        return {
            disponivel: true, fracaoQueFalhou: fracao,
            frase: `cobertura INCOMPLETA: ${e.lidas} janelas lidas e ${e.falharam} falharam `
                + `(${((fracao ?? 0) * 100).toFixed(1)}% das tentativas). ${e.achados} achado(s) `
                + 'é PISO, não total',
        };
    }
    return {
        disponivel: true, fracaoQueFalhou: 0,
        frase: `cobertura COMPLETA: ${e.lidas} de ${e.lidas} janelas lidas, ${e.achados} achado(s)`,
    };
}
