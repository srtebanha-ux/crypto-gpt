// Arquivo: src/directionalLive.ts
//
// Motor DIRECIONAL rodando 24/7: compra na baixa (RSI sobrevendido que já
// virou) ou no rompimento, com stop e stop móvel, sobre vários ativos.
//
// Diferente do motor de arbitragem, aqui a posição fica exposta ao preço e
// pode dar prejuízo sem que nada tenha falhado tecnicamente. Por isso duas
// escolhas estruturais:
//
//   1. USA EXATAMENTE O MESMO CÓDIGO DE SINAL E DIMENSIONAMENTO DO BACKTEST
//      (`signals.ts`, `positionSizing.ts`). Se o motor ao vivo decidisse por
//      lógica própria, o backtest não estaria medindo o que vai operar — e
//      todo o trabalho de validação viraria decoração.
//   2. PADRÃO É PAPEL. Sem ordem real, sem chave, sem risco: acompanha o
//      mercado de verdade e registra o que teria feito. Ordens reais exigem
//      DIRECTIONAL_LIVE=true e DIRECTIONAL_LIVE_CONFIRM, mesmo padrão de gate
//      do motor de arbitragem.
//
// Decide no FECHAMENTO da vela e executa na abertura da seguinte — igual ao
// backtest. Reagir no meio da vela produziria comportamento que o backtest
// nunca mediu.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { BinanceExchangeProvider } from './binanceExchangeProvider';
import { atr, detectBreakout, detectOversoldReversion, isAboveTrend, rsiSeries, type Candle } from './signals';
import { planPosition, tradeNetPnl, updateTrailingStopAtr } from './positionSizing';
import { resolveStrategyParams, type ResolvedStrategyParams } from './strategyParams';


Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const log = createLogger('direcional');

const BINANCE_REST = 'https://api.binance.com';
/** Velas de histórico mantidas por ativo — suficiente para média de 50 + folga. */
const HISTORY_CANDLES = 300;

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

interface OpenPosition {
    symbol: string;
    entryPrice: Decimal;
    quantity: Decimal;
    /** Caixa preso nesta posição (quantidade × preço de entrada). */
    notional: Decimal;
    stopPrice: Decimal;
    highestSinceEntry: Decimal;
    openedAt: number;
}

interface Config {
    symbols: string[];
    interval: string;
    capital: Decimal;
    pollSeconds: number;
    live: boolean;
    /**
     * Parâmetros de sinal e risco, resolvidos pelo MESMO código que o backtest
     * usa. Operar com parâmetros diferentes dos medidos é operar às cegas — e
     * já aconteceu aqui, quando as duas leituras eram separadas e os padrões
     * divergiram sozinhos.
     */
    strategy: ResolvedStrategyParams;
}

function parseKline(raw: RawKline): Candle {
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
 * Busca as velas FECHADAS de um símbolo.
 *
 * A última vela devolvida pela Binance é a que ainda está em formação. Usá-la
 * é o equivalente ao vivo do look-ahead do backtest: o "fechamento" ainda vai
 * mudar, e um sinal disparado sobre ele some no minuto seguinte. Por isso ela
 * é descartada.
 */
async function fetchClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const res = await fetch(`${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit + 1}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar klines de ${symbol}`);
    const raw = (await res.json()) as RawKline[];
    return raw.slice(0, -1).map(parseKline);
}

function resolveConfig(): Config {
    const live = process.env.DIRECTIONAL_LIVE === 'true';
    if (live && process.env.DIRECTIONAL_LIVE_CONFIRM !== 'I_UNDERSTAND_THE_RISK') {
        throw new Error(
            'DIRECTIONAL_LIVE=true exige DIRECTIONAL_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK. ' +
                'Ordens reais numa estratégia direcional podem perder dinheiro sem nenhuma falha técnica.',
        );
    }
    const strategy = process.env.DIRECTIONAL_STRATEGY ?? 'reversion';
    if (strategy !== 'breakout' && strategy !== 'reversion') {
        throw new Error(`DIRECTIONAL_STRATEGY inválida: "${strategy}". Use breakout ou reversion.`);
    }
    return {
        symbols: (process.env.DIRECTIONAL_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        interval: process.env.DIRECTIONAL_INTERVAL ?? '1h',
        capital: new Decimal(process.env.DIRECTIONAL_CAPITAL ?? '20'),
        pollSeconds: Number(process.env.DIRECTIONAL_POLL_SEC ?? '60'),
        live,
        strategy: resolveStrategyParams(strategy),
    };
}

async function main() {
    const cfg = resolveConfig();
    const exchange = cfg.live
        ? new BinanceExchangeProvider({
              apiKey: process.env.BINANCE_API_KEY!,
              apiSecret: process.env.BINANCE_API_SECRET!,
              live: true,
          })
        : null;
    if (exchange) {
        await exchange.connect();
        // A taxa real da conta manda: cobrar 0,1% de papel numa conta com
        // desconto de BNB (0,075%) descreveria uma operação que não é a que
        // vai acontecer.
        cfg.strategy.feeRate = exchange.getFeeRate();
    }

    log.info(`Motor direcional iniciado em modo ${cfg.live ? 'LIVE — DINHEIRO REAL' : 'PAPEL (nenhuma ordem enviada)'}.`, {
        ativos: cfg.symbols.join(','),
        estrategia: cfg.strategy.entryStrategy,
        intervalo: cfg.interval,
        capital: cfg.capital.toString(),
        riscoPorOperacao: `${cfg.strategy.riskFraction.mul(100).toFixed(2)}%`,
        taxaPorPerna: `${cfg.strategy.feeRate.mul(100).toFixed(4)}%`,
    });
    if (cfg.live) {
        log.warn('*** ORDENS REAIS SERÃO ENVIADAS. Perda é resultado possível sem nenhuma falha técnica. ***');
    }

    const positions = new Map<string, OpenPosition>();
    let capital = cfg.capital;
    let realizedPnl = new Decimal(0);
    let wins = 0;
    let losses = 0;
    /**
     * Dinheiro preso nas posições abertas. Sem isto, cada ativo dimensionaria
     * contra o capital TOTAL e quatro posições simultâneas comprometeriam
     * quatro vezes o dinheiro que existe — alavancagem acidental.
     */
    let committed = new Decimal(0);
    /**
     * Censo do ciclo: por que NÃO houve entrada.
     *
     * Sem isto o heartbeat mostra zeros para sempre e não dá para distinguir
     * "o mercado não ofereceu sinal" de "o motor está recusando tudo" — foi
     * exatamente essa cegueira que deixou o motor de arbitragem rodando um dia
     * inteiro com capital zero parecendo saudável. Zeros só são boa notícia
     * quando dá para ver o que os produziu.
     */
    const diagnostico = new Map<string, string>();
    let sinaisDisparados = 0;
    let bloqueadosPorTendencia = 0;
    let recusadosPorRisco = 0;
    /** Fecha a última vela já processada por símbolo — evita reavaliar a mesma. */
    const lastSeenCandle = new Map<string, number>();

    const closePosition = async (pos: OpenPosition, price: Decimal, reason: string) => {
        let exitPrice = price;
        if (exchange) {
            const fill = await exchange.executeOrder(
                `${pos.symbol.replace('USDT', '')}/USDT`,
                'SELL',
                'MARKET',
                pos.quantity,
            );
            // Ordem a mercado quase nunca sai no preço planejado. Registrar o
            // preço pretendido em vez do executado produziria um histórico
            // otimista justamente nas saídas por stop, que são as que
            // escorregam mais.
            if (fill.executedPrice.greaterThan(0)) exitPrice = fill.executedPrice;
        }
        const { netProfit, feesPaid } = tradeNetPnl(pos.entryPrice, exitPrice, pos.quantity, cfg.strategy.feeRate);
        // O dinheiro preso na posição volta ao caixa, junto com o resultado.
        committed = committed.minus(pos.notional);
        if (committed.lessThan(0)) committed = new Decimal(0);
        capital = capital.plus(netProfit);
        realizedPnl = realizedPnl.plus(netProfit);
        if (netProfit.greaterThan(0)) wins += 1;
        else losses += 1;
        positions.delete(pos.symbol);
        log.info(`SAÍDA ${pos.symbol} — ${reason}`, {
            entrada: pos.entryPrice.toFixed(6),
            saida: exitPrice.toFixed(6),
            quantidade: pos.quantity.toString(),
            resultadoLiquido: netProfit.toFixed(6),
            taxasPagas: feesPaid.toFixed(6),
            capital: capital.toFixed(6),
        });
    };

    const step = async (symbol: string) => {
        const candles = await fetchClosedCandles(symbol, cfg.interval, HISTORY_CANDLES);
        if (candles.length < cfg.strategy.trendPeriod + cfg.strategy.atrPeriod + 5) return;
        const last = candles.length - 1;
        const candle = candles[last];
        // Uma avaliação por vela fechada. Nos ciclos entre um fechamento e o
        // seguinte não há decisão nova a tomar, e o diagnóstico exibido no
        // heartbeat continua sendo o da última vela — por isso o heartbeat diz
        // de quando ele é, em vez de deixar parecer leitura do instante.
        if (lastSeenCandle.get(symbol) === candle.openTime) return;
        lastSeenCandle.set(symbol, candle.openTime);

        const pos = positions.get(symbol);
        if (pos) {
            diagnostico.set(symbol, `em posição (stop ${pos.stopPrice.toFixed(2)})`);
            // Stop pela MÍNIMA da vela, igual ao backtest: se furou no meio do
            // caminho, a posição acabou ali.
            if (candle.low.lessThanOrEqualTo(pos.stopPrice)) {
                await closePosition(pos, pos.stopPrice, 'stop atingido');
                return;
            }
            if (candle.high.greaterThan(pos.highestSinceEntry)) pos.highestSinceEntry = candle.high;
            const currentAtr = atr(candles, last, cfg.strategy.atrPeriod);
            if (currentAtr) {
                pos.stopPrice = updateTrailingStopAtr(
                    pos.stopPrice,
                    pos.highestSinceEntry,
                    currentAtr,
                    cfg.strategy.trailAtrMultiplier,
                );
            }
            return;
        }

        const signal =
            cfg.strategy.entryStrategy === 'reversion'
                ? detectOversoldReversion(candles, last, rsiSeries(candles, cfg.strategy.rsiPeriod), cfg.strategy.rsiThreshold, cfg.strategy.atrPeriod)
                : detectBreakout(candles, last, cfg.strategy.breakoutLookback, cfg.strategy.atrPeriod);
        const rsiAtual =
            cfg.strategy.entryStrategy === 'reversion' && 'rsiValue' in signal && signal.rsiValue
                ? signal.rsiValue.toFixed(1)
                : null;

        if (!signal.triggered || signal.atrValue === null) {
            diagnostico.set(
                symbol,
                rsiAtual !== null
                    ? `sem sinal (RSI ${rsiAtual}, precisa < ${cfg.strategy.rsiThreshold} e já subindo)`
                    : 'sem sinal',
            );
            return;
        }
        sinaisDisparados += 1;

        if (cfg.strategy.trendPeriod > 0) {
            const closes = candles.map((c) => c.close);
            if (isAboveTrend(closes, last, cfg.strategy.trendPeriod) !== true) {
                bloqueadosPorTendencia += 1;
                // Comprar queda dentro de tendência de baixa é comprar algo que
                // cai porque continua caindo. O filtro barrar é o filtro
                // funcionando, não um problema a ser afrouxado sem medir.
                diagnostico.set(symbol, `SINAL barrado pelo filtro de tendência (abaixo da média de ${cfg.strategy.trendPeriod})`);
                return;
            }
        }

        // Entrada ao preço corrente. No backtest é a abertura da vela seguinte;
        // ao vivo, a vela seguinte é AGORA, e seu preço corrente é o melhor
        // equivalente disponível.
        const entryPrice = candle.close;
        const stopPrice = entryPrice.minus(signal.atrValue.mul(cfg.strategy.atrStopMultiplier));
        const plan = planPosition({
            capital,
            availableCapital: capital.minus(committed),
            riskFraction: cfg.strategy.riskFraction,
            entryPrice,
            stopPrice,
            minNotional: cfg.strategy.minNotional,
        });
        if (plan.quantity.lessThanOrEqualTo(0)) {
            recusadosPorRisco += 1;
            diagnostico.set(symbol, `SINAL recusado pelo risco: ${plan.reason}`);
            log.warn(`${symbol}: sinal válido mas operação recusada pelo risco.`, { motivo: plan.reason });
            return;
        }

        let filledPrice = entryPrice;
        let filledQty = plan.quantity;
        if (exchange) {
            const fill = await exchange.executeOrder(`${symbol.replace('USDT', '')}/USDT`, 'BUY', 'MARKET', plan.quantity);
            if (fill.executedPrice.greaterThan(0)) filledPrice = fill.executedPrice;
            if (fill.executedQty.greaterThan(0)) filledQty = fill.executedQty;
        }
        // O stop acompanha o preço REALMENTE pago: mantê-lo ancorado no preço
        // pretendido mudaria silenciosamente a distância até o stop, e com ela
        // o risco que se aceitou correr.
        const filledStop = filledPrice.minus(signal.atrValue.mul(cfg.strategy.atrStopMultiplier));
        const notional = filledQty.mul(filledPrice);
        committed = committed.plus(notional);
        diagnostico.set(symbol, 'ENTRADA executada neste ciclo');
        positions.set(symbol, {
            symbol,
            entryPrice: filledPrice,
            quantity: filledQty,
            notional,
            stopPrice: filledStop,
            highestSinceEntry: filledPrice,
            openedAt: Date.now(),
        });
        log.info(`ENTRADA ${symbol}`, {
            preco: filledPrice.toFixed(6),
            quantidade: filledQty.toString(),
            stop: filledStop.toFixed(6),
            riscoSeStopar: plan.riskAmount.toFixed(6),
            notional: notional.toFixed(2),
            caixaLivreRestante: capital.minus(committed).toFixed(2),
        });
    };

    for (;;) {
        for (const symbol of cfg.symbols) {
            try {
                await step(symbol);
            } catch (err) {
                // Falha em um ativo não pode parar os outros nem derrubar o
                // motor: ele existe para rodar ininterruptamente.
                const motivo = err instanceof Error ? err.message : String(err);
                diagnostico.set(symbol, `FALHA: ${motivo}`);
                log.warn(`Falha ao avaliar ${symbol}; segue no próximo ciclo.`, { erro: motivo });
            }
        }

        log.info('Heartbeat — motor direcional ativo.', {
            modo: cfg.live ? 'LIVE' : 'PAPEL',
            capital: capital.toFixed(6),
            caixaLivre: capital.minus(committed).toFixed(6),
            resultadoAcumulado: realizedPnl.toFixed(6),
            posicoesAbertas: positions.size,
            ativosComPosicao: Array.from(positions.keys()).join(',') || 'nenhum',
            operacoesFechadas: wins + losses,
            acertos: wins,
            erros: losses,
            sinaisDisparados,
            bloqueadosPorTendencia,
            recusadosPorRisco,
            leituraDaVela: `uma avaliação por vela de ${cfg.interval} — o diagnóstico abaixo é da última fechada`,
            porAtivo: cfg.symbols.map((s) => `${s}: ${diagnostico.get(s) ?? 'aguardando fechar a vela'}`).join(' | '),
        });

        await new Promise((resolve) => setTimeout(resolve, cfg.pollSeconds * 1000));
    }
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha no motor direcional.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
