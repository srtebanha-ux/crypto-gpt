// Arquivo: src/kelly.ts
//
// Ter vantagem e quebrar são coisas compatíveis — e é assim que a maioria das
// contas alavancadas morre. O critério de Kelly responde a pergunta que o
// alvo e o stop não respondem: dada uma vantagem MEDIDA, quanto da banca pode
// ir por operação sem que uma sequência ruim, que virá, leve tudo.
//
//   f* = p − (1−p)/b        b = ganho/perda
//
// Duas leituras deste arquivo valem mais que a fórmula:
//
//   1. Kelly NEGATIVO não quer dizer "aposte pouco". Quer dizer NÃO APOSTE.
//      A configuração +0,3%/−0,4% dá b ≈ 0,48; a 55% de acerto o f* é
//      negativo. Não existe tamanho de posição que a torne lucrativa — e
//      "arriscar menos" só faz perder mais devagar.
//
//   2. Kelly cheio é agressivo demais para vantagem ESTIMADA. A fórmula
//      assume que p é conhecido; o nosso é medido numa amostra e vai errar
//      para os dois lados. Superestimar p em Kelly cheio leva a apostar acima
//      do ótimo, e acima do ótimo o crescimento esperado vira negativo. Por
//      isso o padrão aqui é METADE: perde-se 25% do crescimento teórico e
//      corta-se a volatilidade pela metade — troca boa quando p é palpite
//      educado, não verdade.
import { Decimal } from 'decimal.js';

/** Fração da banca a arriscar por operação. Zero significa não operar. */
export function fracaoDeKelly(params: {
    /** Taxa de acerto medida. */
    acerto: Decimal;
    /** Ganho líquido por operação, em fração do nocional. */
    ganho: Decimal;
    /** Perda líquida por operação, em fração do nocional. */
    perda: Decimal;
    /** Fração de Kelly a usar (0.5 = meio Kelly, o padrão). */
    fracaoDeUso?: Decimal;
}): Decimal {
    if (params.perda.lessThanOrEqualTo(0)) return new Decimal(0);
    if (params.ganho.lessThanOrEqualTo(0)) return new Decimal(0);

    const b = params.ganho.dividedBy(params.perda);
    const p = params.acerto;
    const f = p.minus(new Decimal(1).minus(p).dividedBy(b));

    if (f.lessThanOrEqualTo(0)) return new Decimal(0); // sem vantagem: não existe tamanho certo
    const uso = params.fracaoDeUso ?? new Decimal('0.5');
    // Teto de 25% da banca por operação. Kelly cheio numa vantagem grande
    // pede frações que só fazem sentido com p conhecido de verdade; aqui p
    // é medido, e uma sequência de quatro perdas não pode zerar a conta.
    return Decimal.min(f.mul(uso), new Decimal('0.25'));
}

export type DimensionamentoPorKelly =
    | { operar: true; nocional: Decimal; riscoEmUsdt: Decimal; fracaoDaBanca: Decimal; motivo: string }
    | { operar: false; motivo: string };

/**
 * Converte a fração de Kelly no NOCIONAL da ordem.
 *
 * A ponte entre os dois é o stop: arriscar 10% de uma banca de US$ 35 com um
 * stop de 0,4% significa um nocional de 0,10 × 35 / 0,004 = US$ 875. É o
 * stop que define quanto nocional cabe num risco — não a alavancagem, que
 * entra só depois, como limite do que a corretora aceita sustentar.
 */
export function dimensionarPorKelly(params: {
    banca: Decimal;
    acerto: Decimal;
    ganho: Decimal;
    perda: Decimal;
    /** Distância do stop MAIS as taxas — a perda real por unidade de nocional. */
    perdaPorNocional: Decimal;
    alavancagemMaxima: Decimal;
    nocionalMinimo: Decimal;
    fracaoDeUso?: Decimal;
}): DimensionamentoPorKelly {
    const f = fracaoDeKelly({
        acerto: params.acerto,
        ganho: params.ganho,
        perda: params.perda,
        fracaoDeUso: params.fracaoDeUso,
    });

    if (f.lessThanOrEqualTo(0)) {
        return {
            operar: false,
            motivo:
                `Kelly ≤ 0 com acerto de ${params.acerto.mul(100).toFixed(1)}% e razão ` +
                `${params.ganho.dividedBy(params.perda).toFixed(2)}. Não existe tamanho de posição que torne ` +
                `esta configuração lucrativa — arriscar menos só perde mais devagar.`,
        };
    }

    const riscoEmUsdt = params.banca.mul(f);
    const porRisco = riscoEmUsdt.dividedBy(params.perdaPorNocional);
    // A corretora limita o nocional pela margem disponível; Kelly limita pelo
    // risco. Vale o MENOR: nenhum dos dois é negociável.
    const porAlavancagem = params.banca.mul(params.alavancagemMaxima);
    const nocional = Decimal.min(porRisco, porAlavancagem);

    if (nocional.lessThan(params.nocionalMinimo)) {
        return {
            operar: false,
            motivo:
                `Nocional de ${nocional.toFixed(2)} USDT fica abaixo do mínimo de ` +
                `${params.nocionalMinimo.toFixed(2)}. A banca é pequena demais para arriscar ` +
                `${f.mul(100).toFixed(1)}% por operação com este stop.`,
        };
    }

    return {
        operar: true,
        nocional,
        riscoEmUsdt,
        fracaoDaBanca: f,
        motivo:
            `Meio Kelly: arrisca ${f.mul(100).toFixed(1)}% da banca (${riscoEmUsdt.toFixed(2)} USDT) por operação, ` +
            `o que dá ${nocional.toFixed(2)} USDT de nocional.`,
    };
}

/**
 * Quantas perdas seguidas a banca aguenta antes de acabar.
 *
 * Sequências ruins não são azar: com 60% de acerto, cinco perdas seguidas
 * acontecem uma vez a cada ~1.500 operações — ou seja, algumas vezes por mês
 * num sistema de alta frequência. Um dimensionamento que não sobrevive a isso
 * não é agressivo, é temporário.
 */
export function perdasSeguidasSuportadas(params: { fracaoDaBanca: Decimal }): number {
    if (params.fracaoDaBanca.lessThanOrEqualTo(0)) return Infinity;
    // Após n perdas de fração f, resta (1−f)^n. "Acabou" = restar menos de 20%.
    const restante = new Decimal(1).minus(params.fracaoDaBanca);
    if (restante.lessThanOrEqualTo(0)) return 1;
    let n = 0;
    let saldo = new Decimal(1);
    while (saldo.greaterThan('0.2') && n < 1000) {
        saldo = saldo.mul(restante);
        n += 1;
    }
    return n;
}

/** Probabilidade de ver ao menos uma sequência de `n` perdas em `operacoes` tentativas. */
export function chanceDeSequenciaRuim(params: { acerto: Decimal; n: number; operacoes: number }): Decimal {
    const q = new Decimal(1).minus(params.acerto);
    if (q.lessThanOrEqualTo(0) || params.n <= 0) return new Decimal(0);
    // Aproximação padrão: janelas independentes. Superestima levemente, o que
    // é o lado certo de errar quando se trata de ruína.
    const pSequencia = q.pow(params.n);
    const janelas = Math.max(0, params.operacoes - params.n + 1);
    const nenhuma = new Decimal(1).minus(pSequencia).pow(janelas);
    return new Decimal(1).minus(nenhuma);
}
