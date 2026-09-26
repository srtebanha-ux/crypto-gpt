// Arquivo: src/futurosMath.ts
//
// A aritmética do USDT-M Futures, separada da rede.
//
// O Futures muda três coisas em relação ao Spot/Margem, e as três matam de
// jeitos diferentes:
//
//   1. A margem é CONSUMIDA, não emprestada contra colateral. Um nocional de
//      US$ 750 a 30x tranca US$ 25 de margem. Se a banca inteira é US$ 25,
//      a posição não usa "parte" do dinheiro: usa TODO ele. Não sobra nada
//      para uma segunda posição nem para absorver a taxa. `margemNecessaria`
//      e `fracaoDaBancaEmMargem` existem para que isso apareça ANTES da
//      ordem, não no extrato.
//
//   2. Existe LIQUIDAÇÃO, e ela chega antes do que a alavancagem sugere. A
//      30x o movimento contrário que zera a margem NÃO é 1/30 = 3,33%: é
//      3,33% MENOS a margem de manutenção que a corretora exige (tipicamente
//      0,5% em altcoins), ou seja ~2,83%. E o gap de abertura de uma altcoin
//      atravessa 2,83% sem tocar em nenhum preço no meio.
//
//   3. O preço tem GRADE (tickSize). Um stop fora da grade é recusado — e
//      arredondar sem pensar pode empurrar o stop para LONGE da entrada,
//      aumentando a perda. Por isso a regra aqui é uma só e vale para os
//      dois lados: o arredondamento sempre ENCURTA a distância até a
//      entrada, nunca aumenta. Alvo mais perto = ganha um pouco menos.
//      Stop mais perto = perde um pouco menos. Nenhum dos dois surpreende.
import { Decimal } from 'decimal.js';

/** Filtros de um símbolo de futuros (PRICE_FILTER / LOT_SIZE / MIN_NOTIONAL). */
export interface FiltrosDeFuturos {
    tickSize: Decimal;
    stepSize: Decimal;
    minQty: Decimal;
    minNotional: Decimal;
}

/** Uma faixa de alavancagem da Binance: até `nocionalMaximo`, no máximo `alavancagemMaxima`. */
export interface FaixaDeAlavancagem {
    nocionalMaximo: Decimal;
    alavancagemMaxima: Decimal;
    /** Margem de manutenção da faixa, em fração (0.005 = 0,5%). */
    manutencao: Decimal;
}

/** Margem que a corretora tranca para sustentar um nocional. */
export function margemNecessaria(params: { nocional: Decimal; alavancagem: Decimal }): Decimal {
    if (params.alavancagem.lessThanOrEqualTo(0)) throw new Error('Alavancagem tem de ser positiva.');
    return params.nocional.dividedBy(params.alavancagem);
}

/**
 * Quanto da banca a posição tranca. 1 = a posição inteira é a banca inteira:
 * não sobra nada, e a primeira liquidação é a última.
 */
export function fracaoDaBancaEmMargem(params: { nocional: Decimal; alavancagem: Decimal; banca: Decimal }): Decimal {
    if (params.banca.lessThanOrEqualTo(0)) return new Decimal(Infinity);
    return margemNecessaria(params).dividedBy(params.banca);
}

/**
 * Movimento contrário, em fração do preço de entrada, que zera a margem.
 *
 * Não é 1/alavancagem: a corretora liquida quando a margem cai ABAIXO da
 * manutenção, não quando chega a zero. Devolve 0 se a manutenção já engole
 * a margem inicial (alavancagem alta demais para a faixa).
 */
export function movimentoAteLiquidacao(params: { alavancagem: Decimal; manutencao: Decimal }): Decimal {
    const inicial = new Decimal(1).dividedBy(params.alavancagem);
    const sobra = inicial.minus(params.manutencao);
    return sobra.greaterThan(0) ? sobra : new Decimal(0);
}

/** Preço em que a corretora liquida, dado o lado da posição. */
export function precoDeLiquidacao(params: {
    entrada: Decimal;
    direcao: 'alta' | 'baixa';
    alavancagem: Decimal;
    manutencao: Decimal;
}): Decimal {
    const mov = movimentoAteLiquidacao({ alavancagem: params.alavancagem, manutencao: params.manutencao });
    return params.direcao === 'alta'
        ? params.entrada.mul(new Decimal(1).minus(mov))
        : params.entrada.mul(new Decimal(1).plus(mov));
}

/**
 * A alavancagem pedida cabe no nocional pedido?
 *
 * A Binance corta a alavancagem por FAIXA de nocional: quanto maior a
 * posição, menor a alavancagem permitida. Pedir 30x num nocional que só
 * aceita 20x não é rejeitado com uma mensagem clara — a ordem simplesmente
 * é recusada por margem insuficiente, que é o erro errado para diagnosticar.
 */
export function alavancagemPermitida(params: { faixas: FaixaDeAlavancagem[]; nocional: Decimal }): FaixaDeAlavancagem | null {
    const ordenadas = [...params.faixas].sort((a, b) => a.nocionalMaximo.comparedTo(b.nocionalMaximo));
    for (const faixa of ordenadas) {
        if (params.nocional.lessThanOrEqualTo(faixa.nocionalMaximo)) return faixa;
    }
    return null; // nocional acima de qualquer faixa: a posição não existe nesse tamanho
}

/** Arredonda para baixo na grade de quantidade (nunca envia mais do que se pretende). */
export function quantidadeNaGrade(qtd: Decimal, stepSize: Decimal): Decimal {
    if (stepSize.lessThanOrEqualTo(0)) return qtd;
    return qtd.dividedToIntegerBy(stepSize).mul(stepSize);
}

/** Por que um nocional não vira ordem. */
export type RecusaDeQuantidade = 'abaixo_do_minimo_de_qtd' | 'abaixo_do_nocional_minimo' | 'quantidade_zerada';

export type QuantidadeDaOrdem =
    | { ok: true; quantidade: Decimal; nocionalReal: Decimal }
    | { ok: false; motivo: RecusaDeQuantidade; quantidade: Decimal; nocionalReal: Decimal };

/**
 * Converte um nocional em dólares na quantidade que a corretora aceita.
 *
 * Devolve o nocional REAL (quantidade já na grade x preço), não o pedido: a
 * diferença entre os dois é o que faz a margem calculada divergir da margem
 * trancada de verdade.
 */
export function quantidadeParaNocional(params: {
    nocional: Decimal;
    preco: Decimal;
    filtros: FiltrosDeFuturos;
}): QuantidadeDaOrdem {
    if (params.preco.lessThanOrEqualTo(0)) throw new Error('Preço tem de ser positivo.');
    const bruta = params.nocional.dividedBy(params.preco);
    const qtd = quantidadeNaGrade(bruta, params.filtros.stepSize);
    const nocionalReal = qtd.mul(params.preco);

    if (qtd.lessThanOrEqualTo(0)) return { ok: false, motivo: 'quantidade_zerada', quantidade: qtd, nocionalReal };
    if (qtd.lessThan(params.filtros.minQty)) return { ok: false, motivo: 'abaixo_do_minimo_de_qtd', quantidade: qtd, nocionalReal };
    if (nocionalReal.lessThan(params.filtros.minNotional)) {
        return { ok: false, motivo: 'abaixo_do_nocional_minimo', quantidade: qtd, nocionalReal };
    }
    return { ok: true, quantidade: qtd, nocionalReal };
}

/**
 * Põe um preço de saída na grade ENCURTANDO a distância até a entrada.
 *
 * Vale para alvo e stop, dos dois lados. A assimetria que essa regra evita é
 * a que não tem volta: um stop arredondado para longe é uma perda maior do
 * que a configurada, e a 30x a perda configurada já é 12% da banca.
 */
export function precoDeSaidaNaGrade(params: { preco: Decimal; entrada: Decimal; tickSize: Decimal }): Decimal {
    if (params.tickSize.lessThanOrEqualTo(0)) return params.preco;
    const acimaDaEntrada = params.preco.greaterThan(params.entrada);
    const ticks = params.preco.dividedBy(params.tickSize);
    // Acima da entrada, encurtar é descer (floor). Abaixo, encurtar é subir (ceil).
    const naGrade = acimaDaEntrada ? ticks.floor() : ticks.ceil();
    return naGrade.mul(params.tickSize);
}

/** As duas ordens de saída, sempre juntas — ver precosDeSaida em volumeSpike.ts. */
export interface SaidasNaGrade {
    alvo: Decimal;
    stop: Decimal;
    /** Distância REAL até o stop depois da grade, em fração. É ela que dimensiona a perda. */
    distanciaDoStop: Decimal;
    /** Distância REAL até o alvo depois da grade, em fração. */
    distanciaDoAlvo: Decimal;
}

export function saidasNaGrade(params: {
    entrada: Decimal;
    alvo: Decimal;
    stop: Decimal;
    tickSize: Decimal;
}): SaidasNaGrade {
    const alvo = precoDeSaidaNaGrade({ preco: params.alvo, entrada: params.entrada, tickSize: params.tickSize });
    const stop = precoDeSaidaNaGrade({ preco: params.stop, entrada: params.entrada, tickSize: params.tickSize });
    return {
        alvo,
        stop,
        distanciaDoStop: stop.minus(params.entrada).abs().dividedBy(params.entrada),
        distanciaDoAlvo: alvo.minus(params.entrada).abs().dividedBy(params.entrada),
    };
}

/**
 * O stop cabe DENTRO da liquidação?
 *
 * Se o preço de liquidação estiver entre a entrada e o stop, a corretora
 * fecha a posição antes do stop — e cobra a taxa de liquidação por cima.
 * Nesse caso o stop configurado é ficção: a perda real é a margem inteira.
 */
export function stopAntesDaLiquidacao(params: {
    entrada: Decimal;
    stop: Decimal;
    direcao: 'alta' | 'baixa';
    alavancagem: Decimal;
    manutencao: Decimal;
}): boolean {
    const liq = precoDeLiquidacao(params);
    return params.direcao === 'alta' ? params.stop.greaterThan(liq) : params.stop.lessThan(liq);
}
