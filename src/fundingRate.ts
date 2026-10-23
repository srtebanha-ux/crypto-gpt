// Arquivo: src/fundingRate.ts
//
// Matemática pura do carrego de funding rate (cash-and-carry delta-neutro):
// comprado no spot + vendido no perpétuo, mesmo notional. O preço se move nos
// dois lados e se cancela; o que sobra é a taxa de funding que os comprados
// pagam aos vendidos a cada intervalo.
//
// Diferente da arbitragem triangular, a vantagem aqui NÃO é uma corrida de
// latência — o funding é pago no relógio, a cada 8 horas. Ser lento não
// elimina o retorno. O que elimina é taxa maior que o funding, e é isso que
// estas funções medem.
//
// Nada aqui faz I/O: é tudo função pura para poder ser testada sem rede.
import { Decimal } from 'decimal.js';

/** A Binance liquida funding a cada 8 horas => 3 vezes por dia. */
export const FUNDING_INTERVALS_PER_DAY = 3;
export const DAYS_PER_YEAR = 365;

export interface FeeModel {
    /** Taxa taker do spot (0.00075 com desconto de BNB, 0.001 sem). */
    spotTakerFee: Decimal;
    /** Taxa taker de futuros USDⓈ-M (0.0005 padrão). */
    futuresTakerFee: Decimal;
}

export interface CarryProjection {
    /** Notional de CADA perna (spot e perpétuo carregam o mesmo valor). */
    notionalPerLeg: Decimal;
    /** Funding recebido em um ano, se a taxa atual se mantivesse. */
    grossAnnualFunding: Decimal;
    /** Custo de abrir + fechar a posição UMA vez (4 execuções no total). */
    roundTripCost: Decimal;
    /** grossAnnualFunding - roundTripCost. */
    netAnnualProfit: Decimal;
    /** netAnnualProfit como fração do capital total empregado. */
    netAnnualReturnFraction: Decimal;
    /** Dias de funding só para pagar o custo de montar e desmontar a posição. */
    breakEvenDays: Decimal | null;
}

/**
 * Converte a taxa de um intervalo de funding (o número que a Binance publica,
 * ex. 0.0001 = 0,01% a cada 8h) em taxa anual equivalente.
 *
 * Sem composição de propósito: o funding é sacado/creditado em caixa a cada
 * intervalo e não se reinveste sozinho na posição. Compor aqui inflaria o
 * número sem que nada no mundo real fizesse isso acontecer.
 */
export function annualizeFundingRate(ratePerInterval: Decimal): Decimal {
    return ratePerInterval.mul(FUNDING_INTERVALS_PER_DAY).mul(DAYS_PER_YEAR);
}

/**
 * Capital total exigido é o DOBRO do notional de uma perna: é preciso ter o
 * ativo no spot E a margem no perpétuo ao mesmo tempo. Ignorar isso é o erro
 * clássico que faz uma projeção de carry parecer o dobro do que é.
 *
 * Usa margem 1:1 no lado do perpétuo — alavancar reduziria o capital exigido,
 * mas introduz risco de liquidação numa estratégia cuja única virtude é ser
 * delta-neutra. Não vale a troca.
 */
export function notionalPerLegForCapital(totalCapital: Decimal): Decimal {
    return totalCapital.dividedBy(2);
}

/**
 * Custo de montar E desmontar a posição: quatro execuções ao todo (compra
 * spot + venda perp na entrada, venda spot + recompra perp na saída), cada
 * lado pagando a taxa da sua própria corretora sobre o mesmo notional.
 */
export function roundTripCost(notionalPerLeg: Decimal, fees: FeeModel): Decimal {
    const perOpenOrClose = fees.spotTakerFee.plus(fees.futuresTakerFee);
    return notionalPerLeg.mul(perOpenOrClose).mul(2);
}

/**
 * Projeta o carry anual para um capital e uma taxa de funding.
 *
 * `annualFundingRate` negativo significa que os VENDIDOS é que pagam — nesse
 * caso a posição sangra em vez de render, e a projeção sai negativa. É
 * deliberado que a função não trate isso como caso especial: um carry com
 * funding negativo é uma perda real, e mascarar isso com zero esconderia
 * exatamente o risco que decide a estratégia.
 */
export function projectCarry(totalCapital: Decimal, annualFundingRate: Decimal, fees: FeeModel): CarryProjection {
    const notionalPerLeg = notionalPerLegForCapital(totalCapital);
    const grossAnnualFunding = notionalPerLeg.mul(annualFundingRate);
    const cost = roundTripCost(notionalPerLeg, fees);
    const netAnnualProfit = grossAnnualFunding.minus(cost);

    const dailyFunding = grossAnnualFunding.dividedBy(DAYS_PER_YEAR);
    // Sem funding positivo não existe ponto de equilíbrio: o custo nunca se paga.
    const breakEven = dailyFunding.greaterThan(0) ? cost.dividedBy(dailyFunding) : null;

    return {
        notionalPerLeg,
        grossAnnualFunding,
        roundTripCost: cost,
        netAnnualProfit,
        netAnnualReturnFraction: totalCapital.greaterThan(0)
            ? netAnnualProfit.dividedBy(totalCapital)
            : new Decimal(0),
        breakEvenDays: breakEven,
    };
}

/**
 * Resumo estatístico do histórico de funding de um símbolo.
 *
 * A taxa ATUAL é uma péssima base de decisão sozinha: funding oscila e vira
 * negativo. `negativeFraction` é o número que importa de verdade — com que
 * frequência a posição estaria pagando em vez de recebendo.
 */
export interface FundingHistoryStats {
    samples: number;
    meanRate: Decimal;
    minRate: Decimal;
    maxRate: Decimal;
    /** Fração das amostras em que a taxa foi negativa (vendido paga). */
    negativeFraction: Decimal;
}

export function summarizeFundingHistory(rates: Decimal[]): FundingHistoryStats | null {
    if (rates.length === 0) return null;

    let sum = new Decimal(0);
    let min = rates[0];
    let max = rates[0];
    let negatives = 0;
    for (const r of rates) {
        sum = sum.plus(r);
        if (r.lessThan(min)) min = r;
        if (r.greaterThan(max)) max = r;
        if (r.lessThan(0)) negatives += 1;
    }

    return {
        samples: rates.length,
        meanRate: sum.dividedBy(rates.length),
        minRate: min,
        maxRate: max,
        negativeFraction: new Decimal(negatives).dividedBy(rates.length),
    };
}
