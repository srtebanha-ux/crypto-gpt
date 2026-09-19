// Arquivo: src/timeStop.ts
//
// Saída por TEMPO: fecha a operação que não foi a lugar nenhum.
//
// Existe por uma razão medida, não por estilo. No gráfico de 15 minutos, as
// três famílias perderam por operação praticamente o valor exato de uma ida e
// volta de taxa (breakout 0,94x a taxa, momentum 1,05x). Isso diz que o
// movimento capturado empata com o custo: a estratégia não perde por errar a
// direção, perde por PAGAR PEDÁGIO em operações que não andam.
//
// Uma operação parada custa duas coisas ao mesmo tempo:
//
//   1. A taxa, que já foi paga na entrada e será paga de novo na saída,
//      independente de o preço ter se mexido.
//   2. A VAGA. Com capital pequeno o motor segura pouquíssimas posições ao
//      mesmo tempo — muitas vezes uma só. Enquanto ela ocupa o caixa, todo
//      sinal novo é recusado por falta de dinheiro. O custo de oportunidade
//      não aparece em lugar nenhum do extrato, e é o maior dos dois.
//
// O stop clássico protege do movimento CONTRA. Não existe proteção equivalente
// contra o movimento que não acontece — e é exatamente esse que consome o
// capital de quem opera pouco dinheiro em prazo curto.
import { Decimal } from 'decimal.js';

export type DecisaoDeTempo =
    | { sair: false }
    | { sair: true; motivo: string };

/**
 * A operação já ficou tempo demais sem justificar a vaga que ocupa?
 *
 * A regra NÃO é "fechou o prazo, vende". É "fechou o prazo E não andou o
 * suficiente para pagar o próprio custo". Uma posição que está subindo bem aos
 * 20 candles não deve ser cortada por causa do relógio — cortar o ganhador é
 * como estratégias de expectativa fina morrem, já que o resultado inteiro
 * costuma vir de poucas operações que andaram muito.
 *
 * O piso de progresso é o custo de IDA E VOLTA, não zero. Sair no zero a zero
 * ainda é sair perdendo: as duas taxas já foram pagas. Exigir que a posição
 * tenha coberto o próprio pedágio é o mínimo para ela ter direito à vaga.
 */
export function decidirSaidaPorTempo(params: {
    /** Velas fechadas desde a entrada. */
    barrasSeguradas: number;
    /** Limite de velas. Zero ou negativo DESLIGA a regra. */
    maxBarras: number;
    /** Variação do preço desde a entrada, em fração (0.01 = +1%). */
    variacaoDesdeEntrada: Decimal;
    /** Taxa por perna, em fração. O custo de ida e volta é o dobro. */
    taxaPorPerna: Decimal;
}): DecisaoDeTempo {
    if (params.maxBarras <= 0) return { sair: false };
    if (params.barrasSeguradas < params.maxBarras) return { sair: false };

    const custoDeIdaEVolta = params.taxaPorPerna.mul(2);
    if (params.variacaoDesdeEntrada.greaterThan(custoDeIdaEVolta)) {
        // Está andando e já cobriu o próprio custo: o relógio não manda aqui.
        // Deixar correr é onde o resultado de uma estratégia de expectativa
        // fina é feito.
        return { sair: false };
    }

    return {
        sair: true,
        motivo:
            `parada há ${params.barrasSeguradas} velas com ${params.variacaoDesdeEntrada.mul(100).toFixed(2)}% ` +
            `de variação, abaixo do custo de ida e volta (${custoDeIdaEVolta.mul(100).toFixed(3)}%). ` +
            'A vaga vale mais que esta operação.',
    };
}

/** Milissegundos de um intervalo da Binance ("15m", "1h", "4h", "1d"). */
export function intervaloEmMs(intervalo: string): number {
    const m = /^(\d+)([mhdw])$/.exec(intervalo.trim().toLowerCase());
    if (!m) throw new Error(`Intervalo não reconhecido: "${intervalo}".`);
    const quantidade = Number(m[1]);
    const unidade = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]]!;
    return quantidade * unidade;
}

/**
 * Quantas velas FECHADAS se passaram desde a entrada.
 *
 * Usa o relógio em vez de um contador incrementado a cada ciclo porque o motor
 * roda mais vezes do que a vela fecha (poll de 30s num gráfico de 15 minutos), e
 * um contador por ciclo mediria "quantas vezes eu olhei", não "quanto tempo
 * passou" — dois números que só coincidem por acidente. Também sobrevive a
 * reinício: o carimbo de entrada está salvo no estado.
 */
export function barrasDesde(openedAtMs: number, agoraMs: number, intervalo: string): number {
    const passo = intervaloEmMs(intervalo);
    if (agoraMs <= openedAtMs) return 0;
    return Math.floor((agoraMs - openedAtMs) / passo);
}
