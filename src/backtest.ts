// Arquivo: src/backtest.ts
//
// Executa a estratégia direcional sobre candles históricos e mede o que ela
// teria feito. É a peça que separa "acho que funciona" de "aqui está o
// número" — a mesma disciplina que já resolveu a arbitragem triangular.
//
// Três decisões que impedem o backtest de mentir a favor:
//
//   1. TAXA EM TODA ENTRADA E TODA SAÍDA. Foi ignorar taxa que fez a
//      arbitragem triangular parecer viável no papel. Uma estratégia
//      direcional com muitas operações morre de taxa antes de morrer de
//      mercado.
//   2. DECISÃO NA VELA N, EXECUÇÃO NA ABERTURA DA VELA N+1. Decidir e executar
//      no mesmo fechamento é look-ahead: ao vivo, quando o fechamento é
//      conhecido, aquele preço já passou. Backtests que fazem isso produzem
//      resultados excelentes e irreprodutíveis.
//   3. STOP CHECADO PELA MÍNIMA DA VELA, NÃO PELO FECHAMENTO. Se o preço
//      furou o stop no meio da vela, a posição foi encerrada ali — mesmo que
//      tenha fechado acima. Assumir o contrário esconde justamente as perdas.
//
// Sem I/O: recebe candles já carregados.
import { Decimal } from 'decimal.js';
import { detectBreakout, isAboveTrend, type Candle } from './signals';
import { planPosition, updateTrailingStop } from './positionSizing';

export interface StrategyParams {
    /** Velas olhadas para trás no rompimento de máxima. */
    breakoutLookback: number;
    /** Período do ATR usado para posicionar o stop. */
    atrPeriod: number;
    /** Multiplicador do ATR: stop = entrada − (mult × ATR). */
    atrStopMultiplier: Decimal;
    /** Período da média de tendência. 0 desliga o filtro. */
    trendPeriod: number;
    /** Fração do capital arriscada por operação. */
    riskFraction: Decimal;
    /** Fração de trailing stop (0 desliga). */
    trailFraction: Decimal;
    /** Taxa taker por execução (entrada e saída pagam cada uma). */
    feeRate: Decimal;
    minNotional?: Decimal;
    stepSize?: Decimal;
}

export interface Trade {
    entryIndex: number;
    exitIndex: number;
    entryPrice: Decimal;
    exitPrice: Decimal;
    quantity: Decimal;
    /** Lucro líquido em moeda de cotação, já descontadas as duas taxas. */
    netProfit: Decimal;
    feesPaid: Decimal;
    exitReason: 'stop' | 'fim-dos-dados';
}

export interface BacktestResult {
    trades: Trade[];
    initialCapital: Decimal;
    finalCapital: Decimal;
    totalNetProfit: Decimal;
    totalFees: Decimal;
    wins: number;
    losses: number;
    winRate: Decimal;
    avgWin: Decimal;
    avgLoss: Decimal;
    /** Soma dos ganhos dividida pela soma das perdas. Abaixo de 1 = perdedora. */
    profitFactor: Decimal | null;
    /** Maior queda percentual do capital em relação ao pico anterior. */
    maxDrawdownFraction: Decimal;
    /** Operações recusadas pelo controle de risco (notional mínimo, etc.). */
    skippedByRisk: number;
}

interface OpenPosition {
    entryIndex: number;
    entryPrice: Decimal;
    quantity: Decimal;
    stopPrice: Decimal;
    highestSinceEntry: Decimal;
    entryFee: Decimal;
}

export function runBacktest(candles: Candle[], initialCapital: Decimal, params: StrategyParams): BacktestResult {
    let capital = initialCapital;
    let position: OpenPosition | null = null;
    const trades: Trade[] = [];
    let skippedByRisk = 0;

    let peakCapital = initialCapital;
    let maxDrawdown = new Decimal(0);

    const closePosition = (pos: OpenPosition, exitIndex: number, exitPrice: Decimal, reason: Trade['exitReason']) => {
        const grossOut = pos.quantity.mul(exitPrice);
        const exitFee = grossOut.mul(params.feeRate);
        const grossIn = pos.quantity.mul(pos.entryPrice);
        const netProfit = grossOut.minus(exitFee).minus(grossIn).minus(pos.entryFee);

        capital = capital.plus(netProfit);
        trades.push({
            entryIndex: pos.entryIndex,
            exitIndex,
            entryPrice: pos.entryPrice,
            exitPrice,
            quantity: pos.quantity,
            netProfit,
            feesPaid: pos.entryFee.plus(exitFee),
            exitReason: reason,
        });

        if (capital.greaterThan(peakCapital)) peakCapital = capital;
        if (peakCapital.greaterThan(0)) {
            const dd = peakCapital.minus(capital).dividedBy(peakCapital);
            if (dd.greaterThan(maxDrawdown)) maxDrawdown = dd;
        }
    };

    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];

        if (position) {
            // Stop pela MÍNIMA da vela: se furou no meio do caminho, a posição
            // acabou ali. Checar pelo fechamento esconderia a perda real.
            if (candle.low.lessThanOrEqualTo(position.stopPrice)) {
                closePosition(position, i, position.stopPrice, 'stop');
                position = null;
            } else {
                if (candle.high.greaterThan(position.highestSinceEntry)) {
                    position.highestSinceEntry = candle.high;
                }
                position.stopPrice = updateTrailingStop(
                    position.stopPrice,
                    position.highestSinceEntry,
                    params.trailFraction,
                );
            }
        }

        if (position) continue;

        // Sinal decidido nesta vela; execução só na abertura da próxima.
        const signal = detectBreakout(candles, i, params.breakoutLookback, params.atrPeriod);
        if (!signal.triggered || signal.atrValue === null) continue;

        if (params.trendPeriod > 0) {
            const aboveTrend = isAboveTrend(candles, i, params.trendPeriod);
            if (aboveTrend !== true) continue;
        }

        const nextIndex = i + 1;
        if (nextIndex >= candles.length) break; // sem vela seguinte, não há como executar
        const entryPrice = candles[nextIndex].open;
        const stopPrice = entryPrice.minus(signal.atrValue.mul(params.atrStopMultiplier));

        const plan = planPosition({
            capital,
            riskFraction: params.riskFraction,
            entryPrice,
            stopPrice,
            minNotional: params.minNotional,
            stepSize: params.stepSize,
        });
        if (plan.quantity.lessThanOrEqualTo(0)) {
            skippedByRisk += 1;
            continue;
        }

        position = {
            entryIndex: nextIndex,
            entryPrice,
            quantity: plan.quantity,
            stopPrice,
            highestSinceEntry: entryPrice,
            entryFee: plan.notional.mul(params.feeRate),
        };
        i = nextIndex; // a vela de entrada já foi consumida
    }

    // Posição ainda aberta no fim dos dados fecha ao último preço. Ignorá-la
    // esconderia uma perda em aberto e inflaria o resultado.
    if (position) {
        closePosition(position, candles.length - 1, candles[candles.length - 1].close, 'fim-dos-dados');
    }

    return summarize(trades, initialCapital, capital, maxDrawdown, skippedByRisk);
}

function summarize(
    trades: Trade[],
    initialCapital: Decimal,
    finalCapital: Decimal,
    maxDrawdownFraction: Decimal,
    skippedByRisk: number,
): BacktestResult {
    const wins = trades.filter((t) => t.netProfit.greaterThan(0));
    const losses = trades.filter((t) => t.netProfit.lessThanOrEqualTo(0));

    const sum = (list: Trade[]) => list.reduce((acc, t) => acc.plus(t.netProfit), new Decimal(0));
    const grossWin = sum(wins);
    const grossLoss = sum(losses).abs();

    return {
        trades,
        initialCapital,
        finalCapital,
        totalNetProfit: finalCapital.minus(initialCapital),
        totalFees: trades.reduce((acc, t) => acc.plus(t.feesPaid), new Decimal(0)),
        wins: wins.length,
        losses: losses.length,
        winRate: trades.length > 0 ? new Decimal(wins.length).dividedBy(trades.length) : new Decimal(0),
        avgWin: wins.length > 0 ? grossWin.dividedBy(wins.length) : new Decimal(0),
        avgLoss: losses.length > 0 ? grossLoss.dividedBy(losses.length) : new Decimal(0),
        // null quando não houve perda nenhuma: dividir por zero daria
        // "infinito", que num relatório vira a impressão de estratégia
        // perfeita quando na verdade a amostra é pequena demais.
        profitFactor: grossLoss.greaterThan(0) ? grossWin.dividedBy(grossLoss) : null,
        maxDrawdownFraction,
        skippedByRisk,
    };
}
