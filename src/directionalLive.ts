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
import type { EntryStrategy } from './backtest';


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
    /** Uma por família em execução; cada uma com livro e capital próprios. */
    livros: ResolvedStrategyParams[];
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
    const escolha = process.env.DIRECTIONAL_STRATEGY ?? 'reversion';
    if (escolha !== 'breakout' && escolha !== 'reversion' && escolha !== 'both') {
        throw new Error(`DIRECTIONAL_STRATEGY inválida: "${escolha}". Use breakout, reversion ou both.`);
    }
    // 'both' roda as duas famílias em livros SEPARADOS, com o capital dividido.
    // Separar é o ponto: misturadas, um resultado bom de uma esconderia um ruim
    // da outra, e a comparação — que é o motivo de rodar as duas — sumiria.
    const familias: EntryStrategy[] = escolha === 'both' ? ['reversion', 'breakout'] : [escolha];
    return {
        symbols: (process.env.DIRECTIONAL_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        interval: process.env.DIRECTIONAL_INTERVAL ?? '1h',
        capital: new Decimal(process.env.DIRECTIONAL_CAPITAL ?? '20'),
        pollSeconds: Number(process.env.DIRECTIONAL_POLL_SEC ?? '60'),
        live,
        strategy: resolveStrategyParams(familias[0]),
        livros: familias.map((f) => resolveStrategyParams(f)),
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
        estrategias: cfg.livros.map((l) => l.entryStrategy).join(' + '),
        capitalPorEstrategia: cfg.capital.dividedBy(cfg.livros.length).toFixed(2),
        intervalo: cfg.interval,
        capital: cfg.capital.toString(),
        riscoPorOperacao: `${cfg.strategy.riskFraction.mul(100).toFixed(2)}%`,
        taxaPorPerna: `${cfg.strategy.feeRate.mul(100).toFixed(4)}%`,
    });
    if (cfg.live) {
        log.warn('*** ORDENS REAIS SERÃO ENVIADAS. Perda é resultado possível sem nenhuma falha técnica. ***');
    }

    /**
     * Um LIVRO por família de entrada: posições, capital e placar próprios.
     *
     * Separar é o ponto de rodar as duas ao mesmo tempo. Num livro só, o
     * resultado de uma esconderia o da outra e a comparação — que é o motivo de
     * rodar as duas — desapareceria. Cada uma recebe uma fatia igual do
     * capital, então elas competem em pé de igualdade.
     */
    const criarLivro = (params: ResolvedStrategyParams, capitalInicial: Decimal) => {
    const positions = new Map<string, OpenPosition>();
    let capital = capitalInicial;
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
        const { netProfit, feesPaid } = tradeNetPnl(pos.entryPrice, exitPrice, pos.quantity, params.feeRate);
        // O dinheiro preso na posição volta ao caixa, junto com o resultado.
        committed = committed.minus(pos.notional);
        if (committed.lessThan(0)) committed = new Decimal(0);
        capital = capital.plus(netProfit);
        realizedPnl = realizedPnl.plus(netProfit);
        if (netProfit.greaterThan(0)) wins += 1;
        else losses += 1;
        positions.delete(pos.symbol);
        log.info(`[${params.entryStrategy}] SAÍDA ${pos.symbol} — ${reason}`, {
            entrada: pos.entryPrice.toFixed(6),
            saida: exitPrice.toFixed(6),
            quantidade: pos.quantity.toString(),
            resultadoLiquido: netProfit.toFixed(6),
            taxasPagas: feesPaid.toFixed(6),
            capital: capital.toFixed(6),
        });
    };

    const step = async (symbol: string, candles: Candle[]) => {
        if (candles.length < params.trendPeriod + params.atrPeriod + 5) return;
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
            const currentAtr = atr(candles, last, params.atrPeriod);
            if (currentAtr) {
                pos.stopPrice = updateTrailingStopAtr(
                    pos.stopPrice,
                    pos.highestSinceEntry,
                    currentAtr,
                    params.trailAtrMultiplier,
                );
            }
            return;
        }

        const signal =
            params.entryStrategy === 'reversion'
                ? detectOversoldReversion(candles, last, rsiSeries(candles, params.rsiPeriod), params.rsiThreshold, params.atrPeriod)
                : detectBreakout(candles, last, params.breakoutLookback, params.atrPeriod);
        const rsiAtual =
            params.entryStrategy === 'reversion' && 'rsiValue' in signal && signal.rsiValue
                ? signal.rsiValue.toFixed(1)
                : null;

        if (!signal.triggered || signal.atrValue === null) {
            diagnostico.set(
                symbol,
                rsiAtual !== null
                    ? `sem sinal (RSI ${rsiAtual}, precisa < ${params.rsiThreshold} e já subindo)`
                    : 'sem sinal',
            );
            return;
        }
        sinaisDisparados += 1;

        if (params.trendPeriod > 0) {
            const closes = candles.map((c) => c.close);
            if (isAboveTrend(closes, last, params.trendPeriod) !== true) {
                bloqueadosPorTendencia += 1;
                // Comprar queda dentro de tendência de baixa é comprar algo que
                // cai porque continua caindo. O filtro barrar é o filtro
                // funcionando, não um problema a ser afrouxado sem medir.
                diagnostico.set(symbol, `SINAL barrado pelo filtro de tendência (abaixo da média de ${params.trendPeriod})`);
                return;
            }
        }

        // Entrada ao preço corrente. No backtest é a abertura da vela seguinte;
        // ao vivo, a vela seguinte é AGORA, e seu preço corrente é o melhor
        // equivalente disponível.
        const entryPrice = candle.close;
        const stopPrice = entryPrice.minus(signal.atrValue.mul(params.atrStopMultiplier));
        const plan = planPosition({
            capital,
            availableCapital: capital.minus(committed),
            riskFraction: params.riskFraction,
            entryPrice,
            stopPrice,
            minNotional: params.minNotional,
        });
        if (plan.quantity.lessThanOrEqualTo(0)) {
            recusadosPorRisco += 1;
            diagnostico.set(symbol, `SINAL recusado pelo risco: ${plan.reason}`);
            log.warn(`[${params.entryStrategy}] ${symbol}: sinal válido mas operação recusada pelo risco.`, { motivo: plan.reason });
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
        const filledStop = filledPrice.minus(signal.atrValue.mul(params.atrStopMultiplier));
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
        log.info(`[${params.entryStrategy}] ENTRADA ${symbol}`, {
            preco: filledPrice.toFixed(6),
            quantidade: filledQty.toString(),
            stop: filledStop.toFixed(6),
            riscoSeStopar: plan.riskAmount.toFixed(6),
            notional: notional.toFixed(2),
            caixaLivreRestante: capital.minus(committed).toFixed(2),
        });
    };

    return {
        params,
        step,
        /**
         * Falha de rede num ativo precisa aparecer no censo do livro. Sem isto
         * o heartbeat mostraria "aguardando fechar a vela" para um ativo que na
         * verdade não está sendo lido — silêncio que parece paciência.
         */
        marcarFalha: (symbol: string, motivo: string) => diagnostico.set(symbol, `FALHA: ${motivo}`),
        resumo: () => ({
            estrategia: params.entryStrategy,
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
            porAtivo: cfg.symbols.map((sym) => `${sym}: ${diagnostico.get(sym) ?? 'aguardando fechar a vela'}`).join(' | '),
        }),
    };
    };

    // Capital dividido igualmente: comparação justa exige mesmo ponto de
    // partida. Com uma família só, ela fica com tudo.
    const fatia = cfg.capital.dividedBy(cfg.livros.length);
    const livros = cfg.livros.map((p) => criarLivro(p, fatia));

    for (;;) {
        for (const symbol of cfg.symbols) {
            try {
                // As velas são buscadas UMA vez por símbolo e servidas a todos
                // os livros. Cada livro buscando as suas dobraria as chamadas à
                // Binance para responder exatamente a mesma coisa — e, pior,
                // as duas famílias poderiam decidir sobre instantes diferentes.
                const candles = await fetchClosedCandles(symbol, cfg.interval, HISTORY_CANDLES);
                for (const livro of livros) {
                    await livro.step(symbol, candles);
                }
            } catch (err) {
                // Falha em um ativo não pode parar os outros nem derrubar o
                // motor: ele existe para rodar ininterruptamente.
                const motivo = err instanceof Error ? err.message : String(err);
                for (const livro of livros) livro.marcarFalha(symbol, motivo);
                log.warn(`Falha ao avaliar ${symbol}; segue no próximo ciclo.`, { erro: motivo });
            }
        }

        for (const livro of livros) {
            log.info(`Heartbeat [${livro.params.entryStrategy}] — motor direcional ativo.`, {
                modo: cfg.live ? 'LIVE' : 'PAPEL',
                leituraDaVela: `uma avaliação por vela de ${cfg.interval} — o diagnóstico abaixo é da última fechada`,
                ...livro.resumo(),
            });
        }

        await new Promise((resolve) => setTimeout(resolve, cfg.pollSeconds * 1000));
    }
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha no motor direcional.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
