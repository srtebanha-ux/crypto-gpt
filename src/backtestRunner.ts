// Arquivo: src/backtestRunner.ts
//
// Roda o backtest da estratégia direcional contra candles REAIS da Binance.
// Não envia ordem, não usa API key — só o endpoint público de klines.
//
// Por que isto vem antes de qualquer robô direcional ao vivo: uma estratégia
// direcional erra 40-60% das vezes por construção, então observar algumas
// operações ao vivo não distingue "estratégia ruim" de "sequência ruim
// normal". Só a amostra grande separa as duas — e ela custa uma chamada HTTP
// em vez de semanas de dinheiro real.
//
// O resultado NÃO é promessa de futuro. Backtest mede o que teria acontecido
// num período específico; parâmetros ajustados até o passado ficar bonito
// (overfitting) produzem exatamente isso e nada mais. Por isso o relatório
// insiste em janelas separadas.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { runBacktest, type StrategyParams } from './backtest';
import { consecutiveLossesSurvivable, expectancyPerTrade } from './positionSizing';
import type { Candle } from './signals';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const log = createLogger('backtest');

const BINANCE_REST = 'https://api.binance.com';
/** Teto por requisição da Binance. */
const MAX_KLINES_PER_REQUEST = 1000;

/**
 * Uma kline da Binance vem como array posicional:
 * [openTime, open, high, low, close, volume, closeTime, ...]
 */
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

export function parseKline(raw: RawKline): Candle {
    return {
        openTime: raw[0],
        open: new Decimal(raw[1]),
        high: new Decimal(raw[2]),
        low: new Decimal(raw[3]),
        close: new Decimal(raw[4]),
        volume: new Decimal(raw[5]),
    };
}

/**
 * Verifica que a série é utilizável antes de qualquer conta.
 *
 * Uma série com buracos (candles faltando) ou fora de ordem produz sinais
 * calculados sobre janelas que não existiram — e o backtest não reclama, só
 * devolve números errados com cara de certos.
 */
export function assertUsableSeries(candles: Candle[], expectedIntervalMs: number): void {
    if (candles.length < 2) throw new Error(`Série curta demais: ${candles.length} candle(s).`);
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].openTime <= candles[i - 1].openTime) {
            throw new Error(`Candles fora de ordem no índice ${i}.`);
        }
    }
    const gaps = candles.filter((c, i) => i > 0 && c.openTime - candles[i - 1].openTime !== expectedIntervalMs).length;
    if (gaps > 0) {
        log.warn('Série tem buracos — o mercado ficou sem negócios em alguns períodos.', {
            buracos: gaps,
            total: candles.length,
            nota: 'Comum em ativos de baixa liquidez. Muitos buracos tornam o resultado pouco confiável.',
        });
    }
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const candles: Candle[] = [];
    let endTime: number | undefined;

    // A Binance limita 1000 por chamada; para janelas maiores é preciso
    // paginar para trás pelo endTime.
    while (candles.length < limit) {
        const batch = Math.min(MAX_KLINES_PER_REQUEST, limit - candles.length);
        const url =
            `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${batch}` +
            (endTime ? `&endTime=${endTime}` : '');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar klines de ${symbol}: ${await res.text()}`);

        const raw = (await res.json()) as RawKline[];
        if (raw.length === 0) break;
        const parsed = raw.map(parseKline);
        candles.unshift(...parsed);
        endTime = parsed[0].openTime - 1;
        if (raw.length < batch) break; // acabou o histórico disponível
    }

    return candles;
}

function resolveParams(): StrategyParams {
    return {
        breakoutLookback: Number(process.env.BT_BREAKOUT_LOOKBACK ?? '20'),
        atrPeriod: Number(process.env.BT_ATR_PERIOD ?? '14'),
        atrStopMultiplier: new Decimal(process.env.BT_ATR_STOP_MULT ?? '2'),
        trendPeriod: Number(process.env.BT_TREND_PERIOD ?? '50'),
        riskFraction: new Decimal(process.env.BT_RISK_FRACTION ?? '0.02'),
        trailFraction: new Decimal(process.env.BT_TRAIL_FRACTION ?? '0.15'),
        // Taker com desconto de BNB. Sem o desconto, use 0.001.
        feeRate: new Decimal(process.env.BT_FEE_RATE ?? '0.00075'),
        minNotional: new Decimal(process.env.BT_MIN_NOTIONAL ?? '5'),
    };
}

function pct(fraction: Decimal): string {
    return `${fraction.mul(100).toFixed(2)}%`;
}

function report(label: string, result: ReturnType<typeof runBacktest>, capital: Decimal): void {
    const exp = expectancyPerTrade(result.winRate, result.avgWin, result.avgLoss);
    log.info(`=== ${label} ===`, {
        operacoes: result.trades.length,
        acertos: result.wins,
        erros: result.losses,
        taxaAcerto: pct(result.winRate),
        ganhoMedio: `$${result.avgWin.toFixed(4)}`,
        perdaMedia: `$${result.avgLoss.toFixed(4)}`,
        // O número que decide: expectativa por operação. Positiva com 40% de
        // acerto é melhor que negativa com 90%.
        expectativaPorOperacao: `$${exp.toFixed(4)}`,
        fatorLucro: result.profitFactor ? result.profitFactor.toFixed(3) : 'n/d (sem perdas na amostra)',
        capitalInicial: `$${capital.toFixed(2)}`,
        capitalFinal: `$${result.finalCapital.toFixed(2)}`,
        retorno: pct(result.totalNetProfit.dividedBy(capital)),
        piorQueda: pct(result.maxDrawdownFraction),
        taxasPagas: `$${result.totalFees.toFixed(4)}`,
        recusadasPeloRisco: result.skippedByRisk,
    });
}

async function main() {
    const symbol = (process.env.BT_SYMBOL ?? 'ZECUSDT').toUpperCase();
    const interval = process.env.BT_INTERVAL ?? '1h';
    const limit = Number(process.env.BT_CANDLES ?? '2000');
    const capital = new Decimal(process.env.BT_CAPITAL ?? '20');
    const params = resolveParams();

    log.info('Buscando candles reais na Binance (nenhuma ordem será enviada).', {
        simbolo: symbol,
        intervalo: interval,
        candles: limit,
        capital: capital.toString(),
        risco: pct(params.riskFraction),
        perdasSeguidasSuportadas: consecutiveLossesSurvivable(params.riskFraction),
    });

    const candles = await fetchKlines(symbol, interval, limit);
    const intervalMs = candles.length > 1 ? candles[1].openTime - candles[0].openTime : 0;
    assertUsableSeries(candles, intervalMs);

    const inicio = new Date(candles[0].openTime).toISOString();
    const fim = new Date(candles[candles.length - 1].openTime).toISOString();
    log.info(`Série carregada: ${candles.length} candles, de ${inicio} a ${fim}.`);

    // Duas janelas separadas de propósito. Parâmetros que só funcionam na
    // primeira metade e falham na segunda são overfitting — a estratégia foi
    // moldada ao passado, não descobriu nada sobre o mercado. Uma janela só
    // não denuncia isso.
    const meio = Math.floor(candles.length / 2);
    report('PERÍODO COMPLETO', runBacktest(candles, capital, params), capital);
    report('PRIMEIRA METADE', runBacktest(candles.slice(0, meio), capital, params), capital);
    report('SEGUNDA METADE', runBacktest(candles.slice(meio), capital, params), capital);

    // Referência obrigatória: se comprar e segurar rende mais, a estratégia
    // não está agregando nada — está só pagando taxa para chegar ao mesmo
    // lugar por um caminho pior.
    const buyHold = candles[candles.length - 1].close.dividedBy(candles[0].close).minus(1);
    log.info('=== REFERÊNCIA: COMPRAR E SEGURAR ===', {
        retorno: pct(buyHold),
        nota: 'A estratégia precisa bater ISTO para ter valido a pena. Bater o zero não basta.',
    });

    log.info('=== COMO LER ===', {
        ponto1: 'Taxa de acerto baixa NÃO é problema. Expectativa por operação negativa é.',
        ponto2: 'Se a primeira e a segunda metade discordam muito, os parâmetros foram moldados ao passado e não vão se repetir.',
        ponto3: 'Se "comprar e segurar" rende mais, a estratégia está pagando taxa para chegar a um lugar pior.',
        ponto4: 'Backtest mede o passado. É o piso da decisão, não promessa de futuro.',
    });

    process.exit(0);
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha ao rodar o backtest.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
