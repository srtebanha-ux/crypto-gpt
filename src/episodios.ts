/**
 * EPISODIOS DE DISPONIBILIDADE — a medicao que decide se a meta existe.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Em 2026-10-10 eu respondi que nao ha evidencia
 * de US$ 50/dia e que falta UMA medicao: quanto TEMPO existe alvo ao alcance.
 * Ela corrigiu tres coisas da minha formulacao, e as tres estao no desenho:
 *
 *   1. "Registre tempo efetivo, nao apenas quantidade de ciclos." O intervalo
 *      entre ciclos varia de 200ms a 8000ms pela postura, entao contar ciclos
 *      mede a POSTURA, nao a disponibilidade. Aqui se acumula tempo de parede,
 *      e uma lacuna de coleta NAO e contada como observacao.
 *
 *   2. "Nao transforme cada ciclo ou tentativa em uma nova oportunidade de
 *      receber o mesmo premio." A unidade e o EPISODIO: a mesma posicao vista
 *      em 400 ciclos e UM episodio com uma duracao, nao 400 chances de ganhar
 *      o mesmo premio. As tentativas sao contadas DENTRO dele.
 *
 *   3. "Nao use 0,20% como limite universal." Aquele numero saiu de uma
 *      amostra de 15 escritas. Aqui a distancia e gravada em FAIXAS e o
 *      criterio de "ao alcance" NAO esta embutido na coleta — quem analisa
 *      depois escolhe o corte, sem que a coleta tenha favorecido um.
 *
 * E QUATRO ESTADOS que ela mandou separar e que eu vinha misturando:
 *
 *     alvoProximo              falta pouco, e so isso
 *     posicaoLiquidavel        a saude cruzou 1
 *     simulacaoComSucesso      o `eth_call` do nosso contrato devolveu lucro
 *     potencialmenteCapturavel os tres acima E a economia autoriza o tiro
 *
 * Nenhum deles implica o seguinte. O mais caro de confundir e o ultimo: ele e
 * o unico que responde "isto daria dinheiro", e os tres primeiros acontecem
 * sem ele.
 */

/** O teto de uma lacuna que ainda conta como observacao contigua. */
export const LACUNA_QUE_AINDA_CONTA_MS = 30_000;

/** As faixas de distancia, em pontos percentuais de queda que falta ao alvo. */
export const FAIXAS_DE_DISTANCIA = [0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.00] as const;

/** Em que faixa cai uma distancia. `null` acima da ultima faixa. */
export function faixaDaDistancia(faltaPct: number): number | null {
    if (!Number.isFinite(faltaPct) || faltaPct < 0) return null;
    for (const f of FAIXAS_DE_DISTANCIA) if (faltaPct <= f) return f;
    return null;
}

export type EstadoDoEpisodio =
    | 'alvoProximo'
    | 'posicaoLiquidavel'
    | 'simulacaoComSucesso'
    | 'potencialmenteCapturavel';

/** Como um episodio terminou. `perdiDeVista` NAO e desfecho da posicao. */
export type DesfechoDoEpisodio =
    | 'cruzou'
    | 'recuperou'
    | 'dividaPaga'
    | 'liquidadaPorTerceiro'
    | 'perdiDeVista'
    | 'aberto';

export interface Episodio {
    devedor: string;
    /** O protocolo e o par — `mercado` no vocabulario dela. */
    mercado: string;
    abriuEm: number;
    abriuNoBloco: number;
    ultimoVistoEm: number;
    ultimoBloco: number;
    fechouEm: number | null;
    desfecho: DesfechoDoEpisodio;
    /** Tempo EFETIVO de observacao: soma das lacunas que contam. */
    observadoMs: number;
    /** A maior lacuna entre duas leituras — a honestidade da duracao. */
    maiorLacunaMs: number;
    /** Quantas leituras entraram neste episodio. */
    leituras: number;
    /** A menor distancia ja vista, e a ultima. Em pontos percentuais. */
    faltaMinPct: number | null;
    faltaUltimaPct: number | null;
    dividaUsd: number | null;
    garantiaUsd: number | null;
    premioEstimadoUsd: number | null;
    /** Os estados que este episodio JA alcancou, uma vez cada. */
    estados: Set<EstadoDoEpisodio>;
    /** Tentativas enviadas DENTRO deste episodio — nao sao oportunidades. */
    tentativas: number;
    /** Por que a decisao recusou, da ultima vez. */
    porqueNaoAtirei: string | null;
    /** O que a simulacao disse: lucro cru, ou o motivo da reversao. */
    simulacao: string | null;
    /** Idade do dado de preco/posicao quando a leitura foi feita. */
    idadeDoDadoMs: number | null;
    /**
     * O par e imune a preco? NAO exclui da coleta — marca.
     *
     * Excluir seria a coleta escolhendo o resultado: um imune pode cair pela
     * acao do dono (medido em 2026-09-28, `0x43ec917e` andou 2,41 pontos de
     * saude em 70 minutos porque o dono sacou garantia). Quem analisa filtra;
     * a coleta guarda.
     */
    imune: boolean;
    /** Divida tao pequena que nao paga o proprio gas. Tambem marca, nao exclui. */
    poeira: boolean;
    /**
     * Quantos episodios DESTE alvo e mercado ja fecharam antes deste.
     *
     * Uma posicao que sai da lista e volta abre episodio NOVO — mas e a MESMA
     * posicao e o MESMO premio. Sem este contador, sair e voltar dez vezes
     * leria como dez oportunidades, que e exatamente o que ela proibiu.
     */
    reaberturaDe: number;
}

export interface LeituraDeEpisodio {
    devedor: string;
    mercado: string;
    agoraMs: number;
    bloco: number;
    faltaPct: number | null;
    dividaUsd?: number | null;
    garantiaUsd?: number | null;
    premioEstimadoUsd?: number | null;
    estados?: EstadoDoEpisodio[];
    porqueNaoAtirei?: string | null;
    simulacao?: string | null;
    idadeDoDadoMs?: number | null;
    imune?: boolean;
    poeira?: boolean;
}

/**
 * O livro dos episodios.
 *
 * Nao e um contador: e um registro por POSICAO, com inicio, fim e tempo
 * efetivo. O `resumo()` devolve disponibilidade como FRACAO DO TEMPO
 * OBSERVADO, que e a unica forma de a resposta nao depender da postura.
 */
export class LivroDeEpisodios {
    private abertos = new Map<string, Episodio>();

    private fechados: Episodio[] = [];

    private comecouEm: number | null = null;

    private vistoPorUltimoEm: number | null = null;

    private observadoTotalMs = 0;

    private lacunasPerdidas = 0;

    private lacunaPerdidaMs = 0;

    /** Quantos episodios ja fecharam, por alvo+mercado. */
    private jaFechados = new Map<string, number>();

    constructor(private readonly tetoDeLacunaMs = LACUNA_QUE_AINDA_CONTA_MS) {}

    /** Marca que o livro estava vivo neste instante, com alvo ou sem. */
    bateuPonto(agoraMs: number): void {
        if (this.comecouEm === null) this.comecouEm = agoraMs;
        if (this.vistoPorUltimoEm !== null) {
            const d = agoraMs - this.vistoPorUltimoEm;
            if (d > 0 && d <= this.tetoDeLacunaMs) this.observadoTotalMs += d;
            else if (d > this.tetoDeLacunaMs) {
                // Lacuna de coleta: NAO entra como observacao, e e declarada.
                this.lacunasPerdidas += 1;
                this.lacunaPerdidaMs += d;
            }
        }
        this.vistoPorUltimoEm = agoraMs;
    }

    /** Uma leitura de uma posicao. Abre o episodio ou estende o que existe. */
    ver(l: LeituraDeEpisodio): Episodio {
        this.bateuPonto(l.agoraMs);
        const chave = `${l.devedor.toLowerCase()}|${l.mercado}`;
        const existente = this.abertos.get(chave);
        if (existente === undefined) {
            const novo: Episodio = {
                devedor: l.devedor.toLowerCase(),
                mercado: l.mercado,
                abriuEm: l.agoraMs,
                abriuNoBloco: l.bloco,
                ultimoVistoEm: l.agoraMs,
                ultimoBloco: l.bloco,
                fechouEm: null,
                desfecho: 'aberto',
                observadoMs: 0,
                maiorLacunaMs: 0,
                leituras: 1,
                faltaMinPct: l.faltaPct,
                faltaUltimaPct: l.faltaPct,
                dividaUsd: l.dividaUsd ?? null,
                garantiaUsd: l.garantiaUsd ?? null,
                premioEstimadoUsd: l.premioEstimadoUsd ?? null,
                estados: new Set(l.estados ?? []),
                tentativas: 0,
                porqueNaoAtirei: l.porqueNaoAtirei ?? null,
                simulacao: l.simulacao ?? null,
                idadeDoDadoMs: l.idadeDoDadoMs ?? null,
                imune: l.imune ?? false,
                poeira: l.poeira ?? false,
                reaberturaDe: this.jaFechados.get(chave) ?? 0,
            };
            this.abertos.set(chave, novo);
            return novo;
        }
        const lacuna = l.agoraMs - existente.ultimoVistoEm;
        if (lacuna > existente.maiorLacunaMs) existente.maiorLacunaMs = lacuna;
        // A MESMA regra do `bateuPonto`: lacuna grande nao e observacao.
        if (lacuna > 0 && lacuna <= this.tetoDeLacunaMs) existente.observadoMs += lacuna;
        existente.ultimoVistoEm = l.agoraMs;
        existente.ultimoBloco = l.bloco;
        existente.leituras += 1;
        existente.faltaUltimaPct = l.faltaPct;
        if (l.faltaPct !== null
            && (existente.faltaMinPct === null || l.faltaPct < existente.faltaMinPct)) {
            existente.faltaMinPct = l.faltaPct;
        }
        if (l.dividaUsd !== undefined) existente.dividaUsd = l.dividaUsd;
        if (l.garantiaUsd !== undefined) existente.garantiaUsd = l.garantiaUsd;
        if (l.premioEstimadoUsd !== undefined) existente.premioEstimadoUsd = l.premioEstimadoUsd;
        for (const e of l.estados ?? []) existente.estados.add(e);
        if (l.porqueNaoAtirei !== undefined) existente.porqueNaoAtirei = l.porqueNaoAtirei;
        if (l.simulacao !== undefined) existente.simulacao = l.simulacao;
        if (l.idadeDoDadoMs !== undefined) existente.idadeDoDadoMs = l.idadeDoDadoMs;
        if (l.imune !== undefined) existente.imune = l.imune;
        if (l.poeira !== undefined) existente.poeira = l.poeira;
        return existente;
    }

    /** Uma tentativa DENTRO de um episodio. Nao cria oportunidade nova. */
    tentou(devedor: string, mercado: string): void {
        const e = this.abertos.get(`${devedor.toLowerCase()}|${mercado}`);
        if (e !== undefined) e.tentativas += 1;
    }

    /** Fecha um episodio com desfecho DECLARADO. */
    fechar(devedor: string, mercado: string, desfecho: DesfechoDoEpisodio, agoraMs: number): void {
        const chave = `${devedor.toLowerCase()}|${mercado}`;
        const e = this.abertos.get(chave);
        if (e === undefined) return;
        e.fechouEm = agoraMs;
        e.desfecho = desfecho;
        this.abertos.delete(chave);
        this.fechados.push(e);
        this.jaFechados.set(chave, (this.jaFechados.get(chave) ?? 0) + 1);
    }

    /**
     * Fecha quem nao apareceu nesta volta.
     *
     * `perdiDeVista` e o desfecho honesto: NAO se sabe se a posicao se
     * recuperou, foi paga ou liquidada. Confundir isso com 'recuperou' seria
     * inventar desfecho — o defeito que este projeto persegue.
     */
    fecharOsAusentes(vistosAgora: Iterable<string>, agoraMs: number,
        desfecho: DesfechoDoEpisodio = 'perdiDeVista'): number {
        const vistos = new Set<string>();
        for (const v of vistosAgora) vistos.add(v.toLowerCase());
        let quantos = 0;
        for (const [chave, e] of [...this.abertos]) {
            if (vistos.has(e.devedor)) continue;
            e.fechouEm = agoraMs;
            e.desfecho = desfecho;
            this.abertos.delete(chave);
            this.fechados.push(e);
            this.jaFechados.set(chave, (this.jaFechados.get(chave) ?? 0) + 1);
            quantos += 1;
        }
        return quantos;
    }

    todos(): Episodio[] {
        return [...this.fechados, ...this.abertos.values()];
    }

    /**
     * A DISPONIBILIDADE, por faixa de distancia e como fracao do tempo
     * observado. E este numero — e nao a contagem de episodios — que
     * multiplica o EV por tentativa para dar receita por dia.
     *
     * `premioMinimoUsd` NAO tem padrao: quem analisa escolhe, e o resumo diz
     * qual corte usou. Embutir um padrao aqui seria escolher o resultado.
     */
    resumo(premioMinimoUsd: number | null = null): {
        msEntreLeituras: number;
        msSemDados: number;
        alvosDistintos: number;
        reaberturas: number;
        imunes: number;
        poeiras: number;
        observadoMs: number;
        janelaDeParedeMs: number;
        lacunas: { quantas: number; msPerdidos: number };
        episodios: number;
        abertos: number;
        porFaixa: {
            atePct: number;
            episodios: number;
            msComAlvo: number;
            fracaoDoObservado: number;
            comPremioAcimaDoCorte: number;
        }[];
        desfechos: Record<string, number>;
        estados: Record<EstadoDoEpisodio, number>;
        cortePremioUsd: number | null;
    } {
        const todos = this.todos();
        const porFaixa = FAIXAS_DE_DISTANCIA.map((f) => {
            const dentro = todos.filter((e) => e.faltaMinPct !== null && e.faltaMinPct <= f);
            const ms = dentro.reduce((s, e) => s + e.observadoMs, 0);
            return {
                atePct: f,
                episodios: dentro.length,
                msComAlvo: ms,
                fracaoDoObservado: this.observadoTotalMs > 0 ? ms / this.observadoTotalMs : 0,
                comPremioAcimaDoCorte: premioMinimoUsd === null ? dentro.length
                    : dentro.filter((e) => e.premioEstimadoUsd !== null
                        && e.premioEstimadoUsd >= premioMinimoUsd).length,
            };
        });
        const desfechos: Record<string, number> = {};
        for (const e of todos) desfechos[e.desfecho] = (desfechos[e.desfecho] ?? 0) + 1;
        const estados: Record<EstadoDoEpisodio, number> = {
            alvoProximo: 0, posicaoLiquidavel: 0, simulacaoComSucesso: 0, potencialmenteCapturavel: 0,
        };
        for (const e of todos) for (const s of e.estados) estados[s] += 1;
        const distintos = new Set(todos.map((e) => `${e.devedor}|${e.mercado}`));
        return {
            // `msEntreLeituras` e ESTIMADO (o intervalo conta inteiro);
            // `msSemDados` e lacuna descartada. Ela mandou separar os dois.
            msEntreLeituras: this.observadoTotalMs,
            msSemDados: this.lacunaPerdidaMs,
            alvosDistintos: distintos.size,
            reaberturas: todos.filter((e) => e.reaberturaDe > 0).length,
            imunes: todos.filter((e) => e.imune).length,
            poeiras: todos.filter((e) => e.poeira).length,
            observadoMs: this.observadoTotalMs,
            janelaDeParedeMs: this.comecouEm === null || this.vistoPorUltimoEm === null
                ? 0 : this.vistoPorUltimoEm - this.comecouEm,
            lacunas: { quantas: this.lacunasPerdidas, msPerdidos: this.lacunaPerdidaMs },
            episodios: todos.length,
            abertos: this.abertos.size,
            porFaixa,
            desfechos,
            estados,
            cortePremioUsd: premioMinimoUsd,
        };
    }
}

/**
 * A COBERTURA do registro, declarada — porque sem isto a disponibilidade e um
 * numero sem denominador.
 *
 * Ela mandou: *"Declare a cobertura do registro de episódios. Informe quais
 * posições entram na coleta, quais ficam fora e como mudanças na lista
 * monitorada afetam os episódios."*
 */
export const COBERTURA_DO_REGISTRO = {
    entram: 'as posicoes da BRASA (233 vagas), lidas a cada ciclo, com `queda` '
        + 'dentro da faixa mais larga (1%)',
    ficamFora: [
        'quem esta acima de 1% de distancia — nao e perguntado, e nao aparece como ausencia',
        'quem nao entrou na brasa: a lista quente (~1.400) e a lista completa (~61.800) '
            + 'nao alimentam o livro no ciclo curto',
        'a varredura completa ADICIONA e ATUALIZA, mas nao FECHA: senao todo alvo que ela '
            + 've e a brasa nao viraria episodio novo a cada 15 minutos',
    ],
    mudancaDeLista: 'a brasa e reordenada na varredura completa. Uma posicao que sai da brasa '
        + 'fecha como `perdiDeVista` — e isso NAO e desfecho da posicao. Se ela volta, abre '
        + 'episodio novo com `reaberturaDe` > 0, e a soma de episodios deixa de ser a soma de '
        + 'oportunidades: use `alvosDistintos`',
    reinicioDoProcesso: 'o livro mora na MEMORIA. Todo deploy zera. A janela de parede comeca '
        + 'no boot, entao a disponibilidade medida e sempre DESTE boot — e o Railway reinicia '
        + 'varias vezes por dia',
    tempoEstimado: '`msEntreLeituras` e tempo ESTIMADO: o intervalo entre duas leituras conta '
        + 'inteiro como observacao. `msSemDados` e tempo SEM DADOS: lacuna acima do teto, '
        + 'descartada. Somar os dois daria a parede; so o primeiro e observacao',
} as const;

/**
 * A frase do log.
 *
 * Diz a JANELA DE PAREDE ao lado do TEMPO OBSERVADO, porque a diferenca entre
 * os dois e a lacuna de coleta — e foi por nao ter esse par que eu li
 * `maisFragilA` de 15 minutos de idade como se fosse o estado do instante.
 */
export function comoLerOsEpisodios(r: ReturnType<LivroDeEpisodios['resumo']>): string {
    if (r.episodios === 0) {
        return r.observadoMs === 0
            ? 'NADA observado ainda — e isto não é "não houve alvo"'
            : `nenhum episódio em ${(r.observadoMs / 60000).toFixed(1)} min observados. `
              + 'Isto é ausência MEDIDA, não falta de medição';
    }
    const faixas = r.porFaixa
        .filter((f) => f.episodios > 0)
        .map((f) => `≤${f.atePct}%: ${f.episodios} ep, ${(100 * f.fracaoDoObservado).toFixed(2)}% do tempo`
            + (r.cortePremioUsd === null ? '' : ` (${f.comPremioAcimaDoCorte} com prêmio ≥ US$ ${r.cortePremioUsd})`))
        .join(' | ');
    const cobertura = r.janelaDeParedeMs > 0
        ? `${(100 * r.observadoMs / r.janelaDeParedeMs).toFixed(1)}% da parede`
        : 'sem janela';
    return `${r.episodios} episódio(s) em ${r.alvosDistintos} alvo(s) distinto(s)`
        + `${r.reaberturas > 0 ? ` (${r.reaberturas} reabertura(s): a MESMA posição voltou à lista, `
            + 'e isso não é oportunidade nova)' : ''}`
        + `, ${r.abertos} aberto(s) | observei `
        + `${(r.observadoMs / 60000).toFixed(1)} min de ${(r.janelaDeParedeMs / 60000).toFixed(1)} `
        + `de parede (${cobertura}), ${r.lacunas.quantas} lacuna(s) descartada(s) `
        + `somando ${(r.lacunas.msPerdidos / 60000).toFixed(1)} min`
        + (faixas === '' ? '' : ` || ${faixas}`);
}
