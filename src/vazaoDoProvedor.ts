/**
 * O ORCAMENTO DE LEITURA, num lugar so.
 *
 * MEDIDO em 2026-10-10, rodando o artefato de producao contra
 * `mainnet.base.org`: **214 linhas** de `request limit reached` em 90 segundos.
 * Com o conserto de `classificarRecusa` a escada de espera passou a absorve-las
 * (antes a mensagem nao casava com nenhuma palavra da lista e subia como erro
 * duro) — mas cada chamada esperava a SUA escada, sozinha. Cinco pernas
 * paralelas descobriam o mesmo limite cinco vezes e o log repetia a mesma linha
 * dezenas de vezes.
 *
 * Ela pediu: *"Coordene o orçamento de requisições entre varredura, censo,
 * Morpho, monitoramento e reconexões... Aplique concorrência limitada, recuo
 * progressivo e prioridade para leituras essenciais."* Sao tres coisas
 * diferentes e este arquivo tem as tres:
 *
 *   CONCORRENCIA  um teto de chamadas ao mesmo tempo, para todo mundo.
 *   RECUO         quando UMA chamada ve limite de taxa, TODAS recuam. O
 *                 provedor nao tem uma cota por perna.
 *   PRIORIDADE    `essencial` (a brasa, a decisao do tiro) passa na frente e
 *                 atravessa o recuo; `demorada` (censo, Morpho, varredura de 3
 *                 anos) espera. Sem isto, uma varredura de censo pode consumir
 *                 a vazao no instante em que um alvo cruza.
 *
 * O QUE ISTO NAO E: nao e medicao de CU nem de cobranca. O provedor nao expoe
 * credito consumido nesta resposta, e inventar um numero de CU a partir de
 * contagem de chamadas seria o defeito que este projeto persegue. O que existe
 * aqui e contagem de CHAMADAS por metodo e por prioridade, que e fato.
 */

export type Prioridade = 'essencial' | 'normal' | 'demorada';

/** Quanto cada prioridade pode esperar no recuo, em ms. */
export const TETO_DE_ESPERA_MS: Record<Prioridade, number> = {
    // ESSENCIAL atravessa quase na hora: o alvo cruza num bloco de 2s, e
    // esperar o recuo inteiro e perder o alvo para proteger uma cota.
    essencial: 250,
    normal: 5_000,
    demorada: 60_000,
};

export interface ContagemDeChamadas {
    porMetodo: Record<string, number>;
    porPrioridade: Record<Prioridade, number>;
    recuos: number;
    msEmRecuo: number;
    recusasAbsorvidas: number;
}

export class GovernadorDeVazao {
    private emVoo = 0;
    private fila: Array<() => void> = [];
    private recuoAteMs = 0;
    private esperaAtualMs = 0;
    readonly contagem: ContagemDeChamadas = {
        porMetodo: {},
        porPrioridade: { essencial: 0, normal: 0, demorada: 0 },
        recuos: 0, msEmRecuo: 0, recusasAbsorvidas: 0,
    };

    constructor(
        private readonly maxEmVoo = 6,
        private readonly agora: () => number = () => Date.now(),
        private readonly dormir: (ms: number) => Promise<void>
            = (ms) => new Promise<void>((r) => { setTimeout(r, ms); }),
    ) {}

    /**
     * O RECUO COMPARTILHADO: uma recusa de taxa recua todo mundo.
     *
     * Dobra a cada recusa seguida, com teto, e volta ao chao quando uma chamada
     * passa (`deuCerto`). Era isto que faltava: 214 recusas em 90s eram cinco
     * escadas independentes subindo e descendo sozinhas.
     */
    recuar(baseMs = 1000, tetoMs = 8000): number {
        this.esperaAtualMs = this.esperaAtualMs === 0
            ? baseMs
            : Math.min(this.esperaAtualMs * 2, tetoMs);
        const ate = this.agora() + this.esperaAtualMs;
        if (ate > this.recuoAteMs) this.recuoAteMs = ate;
        this.contagem.recuos += 1;
        this.contagem.recusasAbsorvidas += 1;
        return this.esperaAtualMs;
    }

    deuCerto(): void { this.esperaAtualMs = 0; this.recuoAteMs = 0; }

    /** Quanto falta do recuo, em ms. Zero quando nao ha recuo. */
    recuoRestanteMs(): number { return Math.max(0, this.recuoAteMs - this.agora()); }

    /**
     * A vez de uma chamada. Devolve a funcao que libera a vaga.
     *
     * Chamar sem liberar travaria a vazao para sempre, entao quem chama usa
     * `try/finally` — e o teste exige que uma chamada que ESTOURA libere.
     */
    async vez(metodo: string, prioridade: Prioridade = 'normal'): Promise<() => void> {
        this.contagem.porMetodo[metodo] = (this.contagem.porMetodo[metodo] ?? 0) + 1;
        this.contagem.porPrioridade[prioridade] += 1;
        const espera = Math.min(this.recuoRestanteMs(), TETO_DE_ESPERA_MS[prioridade]);
        if (espera > 0) {
            this.contagem.msEmRecuo += espera;
            await this.dormir(espera);
        }
        if (this.emVoo >= this.maxEmVoo) {
            await new Promise<void>((r) => { this.fila.push(r); });
        }
        this.emVoo += 1;
        let liberou = false;
        return () => {
            if (liberou) return;
            liberou = true;
            this.emVoo -= 1;
            const proximo = this.fila.shift();
            if (proximo !== undefined) proximo();
        };
    }

    /** Para o log: quantas estao em voo e quantas esperando. */
    estado(): { emVoo: number; naFila: number; recuoRestanteMs: number } {
        return { emVoo: this.emVoo, naFila: this.fila.length, recuoRestanteMs: this.recuoRestanteMs() };
    }
}

/**
 * O AGRUPADOR DE AVISOS IGUAIS.
 *
 * 214 linhas identicas enterram o evento de verdade — e foi exatamente isso que
 * aconteceu no log dela, onde `[BLOCOS] conexão de blocos caiu` e a recusa do
 * provedor somavam centenas de linhas e um alvo real passava no meio.
 *
 * A regra: o PRIMEIRO exemplo sai inteiro, na hora; os seguintes viram
 * contagem, e a contagem sai numa linha por janela. Ela pediu os dois —
 * *"Agrupe erros repetidos com contagem e identificação de lote, preservando
 * exemplos completos."*
 */
export class AgrupadorDeAvisos {
    private readonly grupos = new Map<string, { quantos: number; primeiroEm: number; exemplo: unknown }>();

    constructor(
        private readonly janelaMs = 10_000,
        private readonly agora: () => number = () => Date.now(),
    ) {}

    /**
     * Registra um aviso. Devolve o que DEVE ser logado agora, ou `null`.
     *
     * `null` nunca quer dizer "o aviso nao aconteceu": ele foi contado, e a
     * contagem sai na proxima janela. A diferenca importa porque silencio com
     * cara de ausencia e o defeito que este projeto persegue.
     */
    registrar(chave: string, exemplo: unknown): { primeira: boolean; quantos: number; exemplo: unknown } | null {
        const agora = this.agora();
        const g = this.grupos.get(chave);
        if (g === undefined) {
            this.grupos.set(chave, { quantos: 1, primeiroEm: agora, exemplo });
            return { primeira: true, quantos: 1, exemplo };
        }
        g.quantos += 1;
        if (agora - g.primeiroEm >= this.janelaMs) {
            const saida = { primeira: false, quantos: g.quantos, exemplo: g.exemplo };
            this.grupos.set(chave, { quantos: 0, primeiroEm: agora, exemplo });
            return saida;
        }
        return null;
    }

    /** O que ficou pendente, para a linha de resumo do ciclo nao perder nada. */
    pendentes(): Array<{ chave: string; quantos: number }> {
        return [...this.grupos.entries()]
            .filter(([, g]) => g.quantos > 0)
            .map(([chave, g]) => ({ chave, quantos: g.quantos }));
    }
}
