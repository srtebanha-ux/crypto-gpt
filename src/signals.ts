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
 *
 * Recebe os fechamentos JÁ EXTRAÍDOS, não os candles: extrair aqui dentro
 * alocaria o array inteiro a cada vela avaliada, transformando a varredura em
 * O(n²). Num backtest de 10 mil velas isso é a diferença entre segundos e
 * dezenas de minutos.
 */
export function isAboveTrend(closes: Decimal[], index: number, trendPeriod: number): boolean | null {
    const trend = sma(closes, index, trendPeriod);
    if (trend === null) return null;
    return closes[index].greaterThan(trend);
}

/**
 * RSI (Relative Strength Index) com suavização de Wilder.
 *
 *   RS = média de ganhos / média de perdas   |   RSI = 100 − 100/(1 + RS)
 *
 * Abaixo de 30 é convenção de "sobrevendido" — caiu muito rápido em relação
 * ao próprio histórico recente. É a tradução mecânica de "comprar na baixa".
 *
 * Usa a suavização de Wilder (média exponencial com α = 1/period) e não média
 * simples, porque a simples faz o indicador SALTAR quando uma vela antiga sai
 * da janela: o RSI mudaria de patamar sem que nada tivesse acontecido no
 * mercado, disparando entradas por um artefato de cálculo.
 */
export function rsi(candles: Candle[], endIndex: number, period: number): Decimal | null {
    if (period <= 0 || endIndex < period || endIndex >= candles.length) return null;

    // Primeira média: simples sobre as `period` variações iniciais.
    let gainSum = new Decimal(0);
    let lossSum = new Decimal(0);
    for (let i = 1; i <= period; i++) {
        const change = candles[i].close.minus(candles[i - 1].close);
        if (change.greaterThan(0)) gainSum = gainSum.plus(change);
        else lossSum = lossSum.plus(change.abs());
    }
    let avgGain = gainSum.dividedBy(period);
    let avgLoss = lossSum.dividedBy(period);

    // Depois, suavização de Wilder até endIndex.
    for (let i = period + 1; i <= endIndex; i++) {
        const change = candles[i].close.minus(candles[i - 1].close);
        const gain = change.greaterThan(0) ? change : new Decimal(0);
        const loss = change.lessThan(0) ? change.abs() : new Decimal(0);
        avgGain = avgGain.mul(period - 1).plus(gain).dividedBy(period);
        avgLoss = avgLoss.mul(period - 1).plus(loss).dividedBy(period);
    }

    // Sem nenhuma perda no período o RS é infinito; por definição o RSI é 100.
    // Devolver o valor da divisão por zero deixaria Infinity vazar para a
    // comparação de limiar.
    if (avgLoss.isZero()) return new Decimal(100);

    const rs = avgGain.dividedBy(avgLoss);
    return new Decimal(100).minus(new Decimal(100).dividedBy(rs.plus(1)));
}

/**
 * Série completa de RSI em UMA passada, O(n).
 *
 * `rsi()` acima recalcula desde o índice 0 a cada chamada, o que é aceitável
 * para uma consulta pontual e desastroso num backtest: chamada por vela, vira
 * O(n²). Esta versão faz a suavização de Wilder incrementalmente e devolve o
 * valor de cada índice (null onde ainda não há histórico suficiente).
 */
export function rsiSeries(candles: Candle[], period: number): (Decimal | null)[] {
    const out: (Decimal | null)[] = new Array(candles.length).fill(null);
    if (period <= 0 || candles.length <= period) return out;

    let gainSum = new Decimal(0);
    let lossSum = new Decimal(0);
    for (let i = 1; i <= period; i++) {
        const change = candles[i].close.minus(candles[i - 1].close);
        if (change.greaterThan(0)) gainSum = gainSum.plus(change);
        else lossSum = lossSum.plus(change.abs());
    }
    let avgGain = gainSum.dividedBy(period);
    let avgLoss = lossSum.dividedBy(period);
    out[period] = avgLoss.isZero()
        ? new Decimal(100)
        : new Decimal(100).minus(new Decimal(100).dividedBy(avgGain.dividedBy(avgLoss).plus(1)));

    for (let i = period + 1; i < candles.length; i++) {
        const change = candles[i].close.minus(candles[i - 1].close);
        const gain = change.greaterThan(0) ? change : new Decimal(0);
        const loss = change.lessThan(0) ? change.abs() : new Decimal(0);
        avgGain = avgGain.mul(period - 1).plus(gain).dividedBy(period);
        avgLoss = avgLoss.mul(period - 1).plus(loss).dividedBy(period);
        out[i] = avgLoss.isZero()
            ? new Decimal(100)
            : new Decimal(100).minus(new Decimal(100).dividedBy(avgGain.dividedBy(avgLoss).plus(1)));
    }
    return out;
}

export interface ReversionSignal {
    triggered: boolean;
    rsiValue: Decimal | null;
    atrValue: Decimal | null;
}

/**
 * Entrada por reversão: o ativo caiu o bastante para ficar sobrevendido, MAS
 * segue acima da tendência de longo prazo.
 *
 * O filtro de tendência é mais importante aqui do que no rompimento, e não
 * menos: comprar queda dentro de uma tendência de baixa é comprar algo que
 * está caindo porque continua caindo. Sem esse filtro, "comprar na baixa"
 * vira comprar cada degrau de um tombo — a forma mais comum de perder dinheiro
 * achando que se está comprando barato.
 *
 * Exige também que o RSI tenha VIRADO para cima (subiu em relação à vela
 * anterior). Comprar no RSI ainda caindo é apostar num fundo que não se
 * confirmou; esperar a virada troca um pouco de preço por evidência de que a
 * queda perdeu força.
 */
export function detectOversoldReversion(
    candles: Candle[],
    index: number,
    rsiValues: (Decimal | null)[],
    rsiThreshold: Decimal,
    atrPeriod: number,
): ReversionSignal {
    const atrValue = atr(candles, index, atrPeriod);
    const current = index >= 0 && index < rsiValues.length ? rsiValues[index] : null;
    const previous = index - 1 >= 0 && index - 1 < rsiValues.length ? rsiValues[index - 1] : null;

    if (current === null || previous === null || atrValue === null) {
        return { triggered: false, rsiValue: current, atrValue };
    }

    const estavaSobrevendido = previous.lessThan(rsiThreshold);
    const virouParaCima = current.greaterThan(previous);
    return { triggered: estavaSobrevendido && virouParaCima, rsiValue: current, atrValue };
}
