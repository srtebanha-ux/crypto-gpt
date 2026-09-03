// Arquivo: src/signals.ts
//
// Indicadores para estratégia direcional. Tudo função pura sobre candles já
// carregados — sem rede, sem estado escondido.
//
// A escolha de indicadores é deliberadamente conservadora: média móvel,
// máxima de N períodos e ATR. Não porque sejam sofisticados, mas porque são
// transparentes — dá para conferir o que cada número significa. Indicador que
// ninguém consegue auditar vira fé, e fé com dinheiro real é o modo de falha
// mais caro deste projeto inteiro.
import { Decimal } from 'decimal.js';

export interface Candle {
    openTime: number;
    open: Decimal;
    high: Decimal;
    low: Decimal;
    close: Decimal;
    volume: Decimal;
}

/**
 * Média móvel simples das últimas `period` amostras terminando em `endIndex`.
 * Devolve null quando não há histórico suficiente — nunca uma média parcial
 * disfarçada de completa, que faria os primeiros candles gerarem sinais
 * baseados em quase nenhum dado.
 */
export function sma(values: Decimal[], endIndex: number, period: number): Decimal | null {
    if (period <= 0 || endIndex < period - 1 || endIndex >= values.length) return null;
    let sum = new Decimal(0);
    for (let i = endIndex - period + 1; i <= endIndex; i++) {
        sum = sum.plus(values[i]);
    }
    return sum.dividedBy(period);
}

/**
 * Maior máxima nas `period` velas ANTERIORES a `endIndex` (excluindo a própria).
 *
 * Excluir a vela atual é essencial: incluí-la faria "fechou acima da máxima
 * do período" ser quase sempre falso (a própria vela é a máxima), quebrando
 * o sinal de rompimento de forma silenciosa.
 */
export function highestHighBefore(candles: Candle[], endIndex: number, period: number): Decimal | null {
    if (period <= 0 || endIndex - period < 0 || endIndex >= candles.length) return null;
    let max = candles[endIndex - period].high;
    for (let i = endIndex - period; i < endIndex; i++) {
        if (candles[i].high.greaterThan(max)) max = candles[i].high;
    }
    return max;
}

/** Menor mínima nas `period` velas anteriores a `endIndex`. */
export function lowestLowBefore(candles: Candle[], endIndex: number, period: number): Decimal | null {
    if (period <= 0 || endIndex - period < 0 || endIndex >= candles.length) return null;
    let min = candles[endIndex - period].low;
    for (let i = endIndex - period; i < endIndex; i++) {
        if (candles[i].low.lessThan(min)) min = candles[i].low;
    }
    return min;
}

/**
 * True Range de uma vela: a maior entre (máx−mín), |máx−fecho anterior| e
 * |mín−fecho anterior|.
 *
 * As duas últimas existem para capturar GAPS: quando o preço abre longe do
 * fechamento anterior, o range interno da vela subestima o movimento real, e
 * um stop dimensionado por ele ficaria apertado demais justamente nos momentos
 * de maior volatilidade.
 */
export function trueRange(candle: Candle, previousClose: Decimal | null): Decimal {
    const range = candle.high.minus(candle.low);
    if (previousClose === null) return range;
    return Decimal.max(range, candle.high.minus(previousClose).abs(), candle.low.minus(previousClose).abs());
}

/**
 * Average True Range — medida de volatilidade usada para posicionar o stop.
 *
 * Stop em ATR e não em percentual fixo porque a distância precisa respeitar
 * quanto o ativo realmente oscila: 2% é longe para uma stablecoin e é ruído
 * puro para uma altcoin volátil. Percentual fixo produz stops estourados por
 * oscilação normal num caso e stops largos demais no outro.
 */
export function atr(candles: Candle[], endIndex: number, period: number): Decimal | null {
    if (period <= 0 || endIndex < period || endIndex >= candles.length) return null;
    let sum = new Decimal(0);
    for (let i = endIndex - period + 1; i <= endIndex; i++) {
        sum = sum.plus(trueRange(candles[i], candles[i - 1].close));
    }
    return sum.dividedBy(period);
}

export interface BreakoutSignal {
    /** Verdadeiro quando a vela fechou acima da máxima do período anterior. */
    triggered: boolean;
    /** Máxima rompida, quando houve rompimento. */
    breakoutLevel: Decimal | null;
    /** ATR no momento do sinal, para dimensionar o stop. */
    atrValue: Decimal | null;
}

/**
 * Rompimento de máxima: a vela fechou acima da maior máxima das `period`
 * velas anteriores.
 *
 * Usa o FECHAMENTO, não a máxima intradiária. Disparar na máxima significaria
 * comprar num toque que se desfez antes do fim da vela — no backtest isso
 * parece ótimo (o preço "tocou" o nível) e ao vivo vira compra no topo de um
 * movimento que já reverteu.
 */
export function detectBreakout(candles: Candle[], index: number, lookback: number, atrPeriod: number): BreakoutSignal {
    const level = highestHighBefore(candles, index, lookback);
    const atrValue = atr(candles, index, atrPeriod);
    if (level === null || atrValue === null) {
        return { triggered: false, breakoutLevel: level, atrValue };
    }
    return {
        triggered: candles[index].close.greaterThan(level),
        breakoutLevel: level,
        atrValue,
    };
}

/**
 * Filtro de tendência: só compra acima da média longa.
 *
 * Rompimentos contra a tendência principal falham com muito mais frequência —
 * o filtro reduz o número de operações e é justamente aí que ele ajuda:
 * cada operação evitada é uma taxa não paga.
 */
export function isAboveTrend(candles: Candle[], index: number, trendPeriod: number): boolean | null {
    const closes = candles.map((c) => c.close);
    const trend = sma(closes, index, trendPeriod);
    if (trend === null) return null;
    return candles[index].close.greaterThan(trend);
}
