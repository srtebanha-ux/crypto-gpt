/**
 * TRES NUMEROS QUE NAO SAO O MESMO NUMERO.
 *
 * Ela pediu: *"Explique a diferença entre bloco observado, último bloco
 * tentado e cobertura contígua persistida. Não avance o cursor sobre lacunas;
 * recupere-as de forma limitada e observável."*
 *
 *   blocoObservado      o maior bloco que a corrente ja me mostrou. E so uma
 *                       leitura do mundo: nao diz que eu li nada dele.
 *   ultimoTentado       o maior bloco que eu TENTEI varrer. Pode ter falhado.
 *                       Publicar este como progresso e o defeito classico.
 *   cursorContiguo      o maior bloco abaixo do qual TUDO foi lido sem buraco.
 *                       E o unico que pode ir ao disco como progresso, porque
 *                       e o unico de onde o proximo boot pode continuar.
 *
 * Confundir o segundo com o terceiro grava o buraco PARA SEMPRE: o boot
 * seguinte comeca depois dele e ninguem volta. `CacheDeDevedores.ultimoBloco`
 * ja documenta essa regra; este arquivo a torna EXECUTAVEL e observavel, com as
 * lacunas em fila de recuperacao LIMITADA, em vez de um comentario pedindo
 * cuidado.
 */

export interface Lacuna {
    de: number;
    ate: number;
    /** Quantas vezes a recuperacao desta lacuna ja foi tentada. */
    tentativas: number;
    /** Por que ela existe, para o log nao ter de adivinhar. */
    motivo: string;
}

/**
 * Quantas vezes tentar recuperar a MESMA lacuna antes de parar.
 *
 * Limite explicito porque a alternativa — tentar para sempre — e o que
 * transforma uma janela que o provedor recusa num laco infinito, gastando a
 * cota que o monitoramento precisa. Tres: uma pode ser rajada, duas pode ser
 * azar, tres seguidas e propriedade da janela.
 */
export const TENTATIVAS_POR_LACUNA = 3;

/** Quantas lacunas recuperar por volta. O resto espera a volta seguinte. */
export const LACUNAS_POR_VOLTA = 2;

export class CursorDeColeta {
    private readonly lacunas: Lacuna[] = [];
    /** Lacunas que esgotaram as tentativas: ficam DECLARADAS, nao esquecidas. */
    private readonly desistidas: Lacuna[] = [];

    constructor(
        public cursorContiguo: number,
        public blocoObservado = 0,
        public ultimoTentado = 0,
    ) {}

    /** A corrente mostrou um bloco. Isto NAO e leitura. */
    viBloco(n: number): void {
        if (n > this.blocoObservado) this.blocoObservado = n;
    }

    /**
     * Uma faixa foi varrida. `ok: false` abre lacuna e o cursor NAO passa.
     *
     * A ordem importa e e a razao de a funcao existir: marcar o tentado e o
     * contiguo no mesmo lugar e o que impede os dois de divergirem em silencio.
     */
    varri(de: number, ate: number, ok: boolean, motivo = 'leitura falhou'): void {
        if (ate > this.ultimoTentado) this.ultimoTentado = ate;
        if (!ok) {
            this.lacunas.push({ de, ate, tentativas: 0, motivo });
            return;
        }
        // O cursor so avanca ate o inicio da PRIMEIRA lacuna aberta: avancar
        // por cima dela gravaria o buraco para sempre.
        const limite = this.primeiraLacuna();
        const candidato = limite === null ? ate : Math.min(ate, limite - 1);
        if (candidato > this.cursorContiguo) this.cursorContiguo = candidato;
    }

    /** O inicio da lacuna aberta mais antiga. `null` quando nao ha nenhuma. */
    primeiraLacuna(): number | null {
        if (this.lacunas.length === 0) return null;
        return this.lacunas.reduce((min, l) => (l.de < min ? l.de : min), this.lacunas[0]!.de);
    }

    /** As lacunas a recuperar nesta volta, no maximo `LACUNAS_POR_VOLTA`. */
    aRecuperar(): Lacuna[] {
        return [...this.lacunas]
            .sort((a, b) => a.de - b.de)
            .slice(0, LACUNAS_POR_VOLTA);
    }

    /** Resultado de uma recuperacao. `ok` fecha a lacuna; falha conta tentativa. */
    recuperei(de: number, ate: number, ok: boolean): void {
        const i = this.lacunas.findIndex((l) => l.de === de && l.ate === ate);
        if (i < 0) return;
        const l = this.lacunas[i]!;
        if (ok) {
            this.lacunas.splice(i, 1);
            // Fechar a lacuna mais antiga pode destravar o cursor: ele sobe ate
            // o inicio da proxima, ou ate o tentado quando nao sobra nenhuma.
            const limite = this.primeiraLacuna();
            const alvo = limite === null ? this.ultimoTentado : limite - 1;
            if (alvo > this.cursorContiguo) this.cursorContiguo = alvo;
            return;
        }
        l.tentativas += 1;
        if (l.tentativas >= TENTATIVAS_POR_LACUNA) {
            this.lacunas.splice(i, 1);
            this.desistidas.push(l);
        }
    }

    abertas(): Lacuna[] { return [...this.lacunas]; }
    naoRecuperadas(): Lacuna[] { return [...this.desistidas]; }

    /** Quantos blocos de lacuna existem — aberta ou desistida. */
    blocosEmFalta(): number {
        const soma = (ls: Lacuna[]) => ls.reduce((t, l) => t + (l.ate - l.de + 1), 0);
        return soma(this.lacunas) + soma(this.desistidas);
    }

    /**
     * A frase do log, com os TRES numeros lado a lado.
     *
     * Eles aparecem juntos de proposito: separados, cada um parece progresso.
     */
    comoLer(): string {
        const partes = [
            `bloco OBSERVADO ${this.blocoObservado} (a corrente me mostrou; não quer dizer que eu li)`,
            `último TENTADO ${this.ultimoTentado} (tentei varrer; pode ter falhado)`,
            `cobertura CONTÍGUA ${this.cursorContiguo} (tudo abaixo disto foi lido — é o único que vai ao disco)`,
        ];
        if (this.lacunas.length > 0) {
            partes.push(
                `${this.lacunas.length} lacuna(s) ABERTA(S) somando ${this.blocosEmFalta()} blocos: `
                + `o cursor NÃO passa por cima delas, e recupero ${LACUNAS_POR_VOLTA} por volta, `
                + `no máximo ${TENTATIVAS_POR_LACUNA} tentativas cada`,
            );
        }
        if (this.desistidas.length > 0) {
            partes.push(
                `${this.desistidas.length} lacuna(s) NÃO RECUPERADA(S) depois de `
                + `${TENTATIVAS_POR_LACUNA} tentativas — ficam declaradas, e a cobertura abaixo do `
                + 'cursor continua sendo a única que eu afirmo',
            );
        }
        return partes.join(' | ');
    }
}
