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
import {
    atr,
    detectBreakout,
    detectMomentumSurge,
    detectOversoldReversion,
    isAboveTrend,
    rsiSeries,
    type Candle,
} from './signals';
import { planPosition, tradeNetPnl, updateTrailingStop, updateTrailingStopAtr } from './positionSizing';

/**
 * As duas famílias são OPOSTAS, e qual funciona é pergunta empírica:
 *
 *   - 'breakout' compra o que já está subindo, esperando que continue.
 *   - 'reversion' compra o que caiu demais, esperando que volte — a tradução
 *     mecânica de "comprar na baixa e vender na alta".
 *
 * Nenhuma das duas é a resposta certa por argumento. O backtest roda as duas
 * sobre os mesmos dados e a comparação decide.
 */
export type EntryStrategy = 'breakout' | 'reversion' | 'momentum';

export interface StrategyParams {
    /** Qual família de entrada usar. Padrão: rompimento. */
    entryStrategy?: EntryStrategy;
    /** Período do RSI (só em 'reversion'). */
    rsiPeriod?: number;
    /** Abaixo deste RSI o ativo é considerado sobrevendido (só em 'reversion'). */
    rsiThreshold?: Decimal;
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
    /** Fração de trailing stop por percentual fixo (0 desliga). */
    trailFraction: Decimal;
    /**
     * Multiplicador de ATR do stop móvel. Quando > 0, tem precedência sobre
     * `trailFraction` — é o mecanismo correto, porque usa a mesma unidade do
     * stop inicial e engata em qualquer timeframe sem calibração manual.
     */
    trailAtrMultiplier?: Decimal;
    /** Taxa taker por execução (entrada e saída pagam cada uma). */
    feeRate: Decimal;
    /** Média que separa regime de alta de regime de baixa (padrão 200). */
    regimePeriod?: number;
    /** Velas usadas na média de volume da família `momentum`. */
    volumePeriod?: number;
    /** Volume mínimo, em múltiplos da média, para a família `momentum`. */
    minVolumeRatio?: Decimal;
    /**
     * Alvo de lucro em múltiplos do risco inicial (R). `2` sai quando o ganho
     * é o dobro da perda que se aceitou. Zero ou ausente desliga.
     *
     * Existe porque stop móvel sozinho nunca vende no alto: ele só reage depois
     * que o preço já virou e caiu a distância do trailing. Numa alta explosiva
     * que devolve tudo em duas velas, essa distância é o lucro inteiro.
     */
    takeProfitR?: Decimal;
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
    exitReason: 'stop' | 'alvo' | 'fim-dos-dados';
    /**
     * Regime do mercado NA ENTRADA: preço acima ou abaixo da média longa.
     *
     * Existe para responder "isso sobrevive a um bear market?" sem precisar
     * caçar uma janela de baixa à mão — o que sempre carrega a suspeita de ter
     * sido escolhida depois de ver o resultado. Numa corrida longa os dois
     * regimes aparecem, e as operações se separam sozinhas.
     */
    regimeAtEntry: 'alta' | 'baixa';
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
    /**
     * Funil do sinal até a operação.
     *
     * "Zero operações" tem causas com ações opostas: o sinal nunca disparou
     * (parâmetro restritivo demais para o mercado), disparou e o filtro de
     * tendência barrou (comprando queda em tendência de baixa), ou disparou e
     * o risco recusou (capital pequeno demais para o preço). Sem o funil, os
     * três casos produzem o mesmo relatório vazio.
     */
    funnel: {
        velasAvaliadas: number;
        sinaisDisparados: number;
        barradosPorTendencia: number;
        recusadosPorRisco: number;
    };
}

/** Período da média que separa mercado de alta de mercado de baixa. */
export const DEFAULT_REGIME_PERIOD = 200;

interface OpenPosition {
    entryIndex: number;
    entryPrice: Decimal;
    quantity: Decimal;
    stopPrice: Decimal;
    highestSinceEntry: Decimal;
    /** Distância entrada→stop inicial, em dinheiro por unidade. É o "R". */
    initialRisk: Decimal;
}

export function runBacktest(candles: Candle[], initialCapital: Decimal, params: StrategyParams): BacktestResult {
    let capital = initialCapital;
    let position: OpenPosition | null = null;
    const trades: Trade[] = [];
    let skippedByRisk = 0;
    let velasAvaliadas = 0;
    let sinaisDisparados = 0;
    let barradosPorTendencia = 0;

    let peakCapital = initialCapital;
    let maxDrawdown = new Decimal(0);

    // Pré-computados UMA vez. Calcular por vela transformaria a varredura em
    // O(n²): a série de RSI refeita desde o início a cada chamada, e o array
    // de fechamentos realocado a cada filtro de tendência.
    const closes = candles.map((c) => c.close);
    const rsiValues =
        params.entryStrategy === 'reversion' ? rsiSeries(candles, params.rsiPeriod ?? 14) : [];

    // Regime por vela, pré-computado junto com o resto: preço acima da média
    // longa é mercado de alta, abaixo é de baixa. Antes de haver média completa
    // não dá para afirmar nada, e chamar isso de "alta" enviesaria o
    // resultado a favor — então o início conta como baixa, que é o lado
    // conservador.
    const regimePeriod = params.regimePeriod ?? DEFAULT_REGIME_PERIOD;
    // Soma corrente em vez de recalcular a média a cada vela: com 40 mil velas
    // e período 200, a versão ingênua faria 8 milhões de somas para responder o
    // que uma janela deslizante responde em 40 mil. Foi esse mesmo descuido que
    // tornou o backtest O(n²) antes.
    const regimes: Array<'alta' | 'baixa'> = new Array(closes.length).fill('baixa');
    let janela = new Decimal(0);
    for (let i = 0; i < closes.length; i++) {
        janela = janela.plus(closes[i]);
        if (i >= regimePeriod) janela = janela.minus(closes[i - regimePeriod]);
        if (i >= regimePeriod - 1) {
            regimes[i] = closes[i].greaterThan(janela.dividedBy(regimePeriod)) ? 'alta' : 'baixa';
        }
    }

    const closePosition = (pos: OpenPosition, exitIndex: number, exitPrice: Decimal, reason: Trade['exitReason']) => {
        // Mesma função que o motor ao vivo usa, para que papel e backtest não
        // possam divergir por uma taxa contada de um jeito só num dos dois.
        const { netProfit, feesPaid } = tradeNetPnl(pos.entryPrice, exitPrice, pos.quantity, params.feeRate);

        capital = capital.plus(netProfit);
        trades.push({
            entryIndex: pos.entryIndex,
            exitIndex,
            entryPrice: pos.entryPrice,
            exitPrice,
            quantity: pos.quantity,
            netProfit,
            feesPaid,
            exitReason: reason,
            regimeAtEntry: regimes[pos.entryIndex],
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
            } else if (
                params.takeProfitR &&
                params.takeProfitR.greaterThan(0) &&
                position.initialRisk.greaterThan(0) &&
                candle.high.greaterThanOrEqualTo(position.entryPrice.plus(position.initialRisk.mul(params.takeProfitR)))
            ) {
                // Alvo checado DEPOIS do stop, e não antes: quando a mesma vela
                // toca os dois, o OHLC não diz qual veio primeiro, e supor que
                // foi o alvo é escolher a versão que favorece o resultado. Supor
                // o stop é a leitura pessimista, e é a única honesta.
                closePosition(position, i, position.entryPrice.plus(position.initialRisk.mul(params.takeProfitR)), 'alvo');
                position = null;
            } else {
                if (candle.high.greaterThan(position.highestSinceEntry)) {
                    position.highestSinceEntry = candle.high;
                }
                const trailMult = params.trailAtrMultiplier;
                if (trailMult && trailMult.greaterThan(0)) {
                    const currentAtr = atr(candles, i, params.atrPeriod);
                    if (currentAtr !== null) {
                        position.stopPrice = updateTrailingStopAtr(
                            position.stopPrice,
                            position.highestSinceEntry,
                            currentAtr,
                            trailMult,
                        );
                    }
                } else {
                    position.stopPrice = updateTrailingStop(
                        position.stopPrice,
                        position.highestSinceEntry,
                        params.trailFraction,
                    );
                }
            }
        }

        if (position) continue;

        // Sinal decidido nesta vela; execução só na abertura da próxima.
        const signal =
            params.entryStrategy === 'momentum'
                ? detectMomentumSurge(
                      candles,
                      i,
                      params.breakoutLookback,
                      params.atrPeriod,
                      params.volumePeriod ?? 20,
                      params.minVolumeRatio ?? new Decimal('3'),
                  )
                : params.entryStrategy === 'reversion'
                ? detectOversoldReversion(
                      candles,
                      i,
                      rsiValues,
                      params.rsiThreshold ?? new Decimal(30),
                      params.atrPeriod,
                  )
                : detectBreakout(candles, i, params.breakoutLookback, params.atrPeriod);
        velasAvaliadas += 1;
        if (!signal.triggered || signal.atrValue === null) continue;
        sinaisDisparados += 1;

        if (params.trendPeriod > 0) {
            const aboveTrend = isAboveTrend(closes, i, params.trendPeriod);
            if (aboveTrend !== true) {
                barradosPorTendencia += 1;
                continue;
            }
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
            initialRisk: entryPrice.minus(stopPrice),
        };
        i = nextIndex; // a vela de entrada já foi consumida
    }

    // Posição ainda aberta no fim dos dados fecha ao último preço. Ignorá-la
    // esconderia uma perda em aberto e inflaria o resultado.
    if (position) {
        closePosition(position, candles.length - 1, candles[candles.length - 1].close, 'fim-dos-dados');
    }

    return summarize(trades, initialCapital, capital, maxDrawdown, skippedByRisk, {
        velasAvaliadas,
        sinaisDisparados,
        barradosPorTendencia,
        recusadosPorRisco: skippedByRisk,
    });
}

function summarize(
    trades: Trade[],
    initialCapital: Decimal,
    finalCapital: Decimal,
    maxDrawdownFraction: Decimal,
    skippedByRisk: number,
    funnel: BacktestResult['funnel'],
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
        funnel,
    };
}
