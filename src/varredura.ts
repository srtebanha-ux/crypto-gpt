// Arquivo: src/varredura.ts
//
// A conta da meta de R$60/dia fecha em três eventos por dia com 50% de
// acerto. O gargalo não é a alavancagem, nem o alvo, nem o stop: é a
// QUANTIDADE DE EVENTOS. Cascatas de liquidação com queda de 8% não
// acontecem três vezes por dia em quinze moedas — acontecem algumas vezes por
// semana. Olhando quinze pares, a estratégia não tem o que operar.
//
// A Binance lista 528 perpétuos em USDT. E o endpoint que devolve o preço de
// TODOS eles de uma vez custa peso 2 — duas chamadas de vela. Vigiar o mercado
// inteiro é literalmente mais barato do que vigiar quinze pares um a um.
//
// Trinta e cinco vezes mais cobertura pelo preço de nada é o que transforma
// "algumas por semana" em "algumas por dia". É a diferença entre a conta
// fechar e não fechar, e ela estava o tempo todo do lado da varredura, não da
// engenharia de risco.
//
// A comparação aqui é contra a fita MAIS ANTIGA da janela, nunca contra a
// anterior. Uma cascata que desce 8% em quatro degraus de 2% ao longo de
// quarenta segundos não aparece em nenhuma comparação consecutiva — e é
// exatamente essa a forma de uma liquidação em cadeia, que vai comendo o
// livro em ondas.
import { Decimal } from 'decimal.js';

/** Uma fita de preços: todos os símbolos num instante. */
export interface Fita {
    emMs: number;
    precos: Map<string, Decimal>;
}

export interface QuedaDetectada {
    symbol: string;
    /** Queda em fração, do preço de referência até o atual. */
    queda: Decimal;
    de: Decimal;
    para: Decimal;
    /** Há quantos milissegundos estava o preço de referência. */
    idadeMs: number;
}

/**
 * Guarda as últimas fitas e acha as quedas dentro da janela.
 *
 * Mantém as fitas num anel de tamanho fixo: a memória é limitada por
 * construção, não por disciplina de quem chama.
 */
export class VarreduraDeMercado {
    private readonly fitas: Fita[] = [];

    constructor(
        private readonly params: {
            /** Quanto tempo de histórico manter. */
            janelaMs: number;
            /** Queda mínima para reportar (0.08 = 8%). */
            quedaMinima: Decimal;
        },
    ) {}

    public registrar(fita: Fita): void {
        this.fitas.push(fita);
        const corte = fita.emMs - this.params.janelaMs;
        while (this.fitas.length > 0 && this.fitas[0].emMs < corte) this.fitas.shift();
    }

    public get profundidade(): number {
        return this.fitas.length;
    }

    /**
     * Quedas dentro da janela, medidas contra o preço MAIS ALTO visto nela.
     *
     * Contra o mais alto, e não contra o mais antigo, porque a cascata começa
     * do topo: um par que subiu 3% e depois caiu 8% viveu uma cascata de 8%,
     * mesmo terminando 5% acima de onde a janela começou. Medir da ponta é o
     * que captura a queda de verdade em vez do saldo líquido dela.
     */
    public quedas(agora: Fita): QuedaDetectada[] {
        if (this.fitas.length === 0) return [];
        const achados: QuedaDetectada[] = [];

        for (const [symbol, atual] of agora.precos) {
            if (atual.lessThanOrEqualTo(0)) continue;
            let topo: Decimal | null = null;
            let topoEmMs = agora.emMs;

            for (const f of this.fitas) {
                const p = f.precos.get(symbol);
                // Símbolo ausente da fita antiga (listagem nova) é PULADO, não
                // tratado como variação — senão toda estreia viraria cascata.
                if (!p || p.lessThanOrEqualTo(0)) continue;
                if (topo === null || p.greaterThan(topo)) {
                    topo = p;
                    topoEmMs = f.emMs;
                }
            }
            if (topo === null) continue;

            const queda = topo.minus(atual).dividedBy(topo);
            if (queda.greaterThanOrEqualTo(this.params.quedaMinima)) {
                achados.push({ symbol, queda, de: topo, para: atual, idadeMs: agora.emMs - topoEmMs });
            }
        }

        // Maior queda primeiro: com uma posição por vez, a ordem decide qual
        // evento é operado quando dois aparecem no mesmo instante.
        achados.sort((a, b) => b.queda.comparedTo(a.queda));
        return achados;
    }
}

/**
 * Quantos eventos por dia a meta exige.
 *
 * Existe como função para que a meta seja verificada contra o que o motor
 * REALMENTE encontra, e não contra o que se esperava encontrar. Uma meta que
 * precisa de dez eventos por dia num mercado que entrega dois não é uma meta
 * agressiva: é uma meta que não vai acontecer, e é melhor saber disso pelo
 * log do que pelo extrato.
 */
export function eventosNecessariosPorDia(params: {
    metaDiariaUsdt: Decimal;
    nocional: Decimal;
    acerto: Decimal;
    ganhoPorNocional: Decimal;
    perdaPorNocional: Decimal;
}): Decimal | null {
    const ev = params.nocional.mul(
        params.acerto
            .mul(params.ganhoPorNocional)
            .minus(new Decimal(1).minus(params.acerto).mul(params.perdaPorNocional)),
    );
    if (ev.lessThanOrEqualTo(0)) return null; // sem vantagem, nenhum número de eventos fecha
    return params.metaDiariaUsdt.dividedBy(ev);
}
