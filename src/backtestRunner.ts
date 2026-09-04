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
import { resolveStrategyParams } from './strategyParams';
import { createLogger } from './logger';
import { runBacktest, type BacktestResult, type EntryStrategy, type StrategyParams, type Trade } from './backtest';
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


function pct(fraction: Decimal): string {
    return `${fraction.mul(100).toFixed(2)}%`;
}

interface SymbolOutcome {
    symbol: string;
    strategy: EntryStrategy;
    trades: number;
    winRate: Decimal;
    expectancy: Decimal;
    netProfit: Decimal;
    returnFraction: Decimal;
    maxDrawdown: Decimal;
    buyHold: Decimal;
    /** A estratégia superou simplesmente comprar e segurar o ativo? */
    beatBuyHold: boolean;
    /** Resultado separado por regime de mercado na entrada. */
    porRegime: Record<'alta' | 'baixa', ResumoRegime>;
    /** Funil do sinal até a operação — explica "zero operações". */
    funnel: BacktestResult['funnel'];
    /** Operações individuais, para listagem. */
    trades_: Trade[];
    /** Velas usadas, para converter índice em data. */
    candles: Candle[];
}

function evaluate(
    symbol: string,
    strategy: EntryStrategy,
    candles: Candle[],
    capital: Decimal,
    params: StrategyParams,
): SymbolOutcome {
    const result = runBacktest(candles, capital, { ...params, entryStrategy: strategy });
    const buyHold = candles[candles.length - 1].close.dividedBy(candles[0].close).minus(1);
    const returnFraction = result.totalNetProfit.dividedBy(capital);
    return {
        symbol,
        strategy,
        trades: result.trades.length,
        winRate: result.winRate,
        expectancy: expectancyPerTrade(result.winRate, result.avgWin, result.avgLoss),
        netProfit: result.totalNetProfit,
        returnFraction,
        maxDrawdown: result.maxDrawdownFraction,
        buyHold,
        beatBuyHold: returnFraction.greaterThan(buyHold),
        porRegime: resumirPorRegime(result.trades),
        funnel: result.funnel,
        trades_: result.trades,
        candles,
    };
}

/**
 * Imprime CADA operação: quando entrou, quando saiu, a que preço e com que
 * resultado.
 *
 * O agregado responde "vale a pena?" e não responde "o que ele faz?". Quem
 * ainda não viu a estratégia operar não tem como confiar num número resumido —
 * e nem como perceber que ela está comprando algo absurdo. Uma lista de
 * operações com data e preço é verificável contra o gráfico à mão.
 */
function reportTrades(o: SymbolOutcome, limite: number): void {
    if (o.trades_.length === 0) return;
    const mostrar = o.trades_.slice(-limite);
    log.info(`${o.symbol} — ${o.strategy} — últimas ${mostrar.length} de ${o.trades_.length} operações`, {
        legenda: 'data entrada → data saída | preços | motivo | resultado líquido',
    });
    for (const t of mostrar) {
        const entrada = new Date(o.candles[t.entryIndex].openTime).toISOString().slice(0, 16).replace('T', ' ');
        const saida = new Date(o.candles[t.exitIndex].openTime).toISOString().slice(0, 16).replace('T', ' ');
        const variacao = t.exitPrice.minus(t.entryPrice).dividedBy(t.entryPrice).mul(100);
        log.info(
            `  ${entrada} → ${saida} | ${t.entryPrice.toFixed(6)} → ${t.exitPrice.toFixed(6)} ` +
                `(${variacao.toFixed(2)}%) | ${t.exitReason} | $${t.netProfit.toFixed(4)} | regime ${t.regimeAtEntry}`,
        );
    }
}

interface ResumoRegime {
    operacoes: number;
    lucro: Decimal;
    acertos: number;
}

/**
 * Separa as operações pelo regime de mercado NA ENTRADA.
 *
 * É o que responde "sobrevive a um bear market?" sem escolher uma janela de
 * baixa à mão — escolha que sempre carrega a suspeita de ter sido feita depois
 * de ver o resultado. Numa corrida longa os dois regimes aparecem, e as
 * operações se separam sozinhas.
 */
/**
 * As três famílias, rodadas sobre os mesmos dados.
 *
 * `momentum` entra por rompimento COM volume e sai no alvo — feita para moeda
 * pequena que sobe explosivo e devolve. As outras duas continuam aqui de
 * propósito: sem elas não há contra que comparar, e "essa é a boa" viraria
 * opinião de novo.
 */
const FAMILIAS: EntryStrategy[] = ['breakout', 'reversion', 'momentum'];

function resumirPorRegime(trades: Trade[]): Record<'alta' | 'baixa', ResumoRegime> {
    const vazio = (): ResumoRegime => ({ operacoes: 0, lucro: new Decimal(0), acertos: 0 });
    const out: Record<'alta' | 'baixa', ResumoRegime> = { alta: vazio(), baixa: vazio() };
    for (const t of trades) {
        const r = out[t.regimeAtEntry];
        r.operacoes += 1;
        r.lucro = r.lucro.plus(t.netProfit);
        if (t.netProfit.greaterThan(0)) r.acertos += 1;
    }
    return out;
}

function descreverRegime(r: ResumoRegime): string {
    if (r.operacoes === 0) return 'nenhuma operação';
    const taxa = ((r.acertos / r.operacoes) * 100).toFixed(1);
    return `${r.operacoes} op, $${r.lucro.toFixed(4)}, ${taxa}% de acerto`;
}

function reportOutcome(o: SymbolOutcome): void {
    log.info(`${o.symbol} — ${o.strategy}`, {
        operacoes: o.trades,
        taxaAcerto: pct(o.winRate),
        // O número que decide. Positivo com 40% de acerto vale mais que
        // negativo com 90%.
        expectativaPorOperacao: `$${o.expectancy.toFixed(4)}`,
        lucroLiquido: `$${o.netProfit.toFixed(4)}`,
        retorno: pct(o.returnFraction),
        piorQueda: pct(o.maxDrawdown),
        comprarESegurar: pct(o.buyHold),
        bateuComprarESegurar: o.beatBuyHold ? 'sim' : 'NÃO',
        // A pergunta que uma janela só não responde: e quando o mercado cai?
        emMercadoDeALTA: descreverRegime(o.porRegime.alta),
        emMercadoDeBAIXA: descreverRegime(o.porRegime.baixa),
        // O funil responde "por que zero operações?", cuja causa tem ações
        // opostas: sinal restritivo demais, filtro de tendência barrando, ou
        // capital pequeno demais para o preço.
        funil:
            `${o.funnel.velasAvaliadas} velas → ${o.funnel.sinaisDisparados} sinais → ` +
            `${o.funnel.barradosPorTendencia} barrados por tendência, ` +
            `${o.funnel.recusadosPorRisco} recusados por risco → ${o.trades} operações`,
    });
}

async function main() {
    const symbols = (process.env.BT_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,ZECUSDT')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0);
    const interval = process.env.BT_INTERVAL ?? '1h';
    // Quantas operações listar por ativo/família. 0 desliga a listagem.
    const mostrarOperacoes = Number(process.env.BT_SHOW_TRADES ?? '10');
    const limit = Number(process.env.BT_CANDLES ?? '2000');
    const capital = new Decimal(process.env.BT_CAPITAL ?? '20');
    const params = resolveStrategyParams();

    log.info('Backtest multi-ativo contra candles reais da Binance (nenhuma ordem será enviada).', {
        ativos: symbols.join(','),
        intervalo: interval,
        candles: limit,
        capital: capital.toString(),
        risco: pct(params.riskFraction),
        perdasSeguidasSuportadas: consecutiveLossesSurvivable(params.riskFraction),
        nota: 'Cada ativo roda as DUAS famílias de entrada sobre os mesmos dados.',
    });

    const outcomes: SymbolOutcome[] = [];

    for (const symbol of symbols) {
        let candles: Candle[];
        try {
            candles = await fetchKlines(symbol, interval, limit);
            const intervalMs = candles.length > 1 ? candles[1].openTime - candles[0].openTime : 0;
            assertUsableSeries(candles, intervalMs);
        } catch (err) {
            // Um símbolo inexistente ou sem histórico não pode derrubar a
            // varredura inteira — reporta e segue.
            log.error(`Falha ao carregar ${symbol}; pulando.`, {
                erro: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        const inicio = new Date(candles[0].openTime).toISOString().slice(0, 10);
        const fim = new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10);
        log.info(`=== ${symbol}: ${candles.length} candles, ${inicio} a ${fim} ===`);

        for (const strategy of FAMILIAS) {
            const outcome = evaluate(symbol, strategy, candles, capital, params);
            outcomes.push(outcome);
            reportOutcome(outcome);
            // Ver a estratégia operar importa tanto quanto o número resumido:
            // é o que permite conferir uma operação contra o gráfico à mão.
            if (mostrarOperacoes > 0) reportTrades(outcome, mostrarOperacoes);
        }

        // Metades separadas no ativo, para flagrar overfitting: parâmetros que
        // só funcionam numa metade foram moldados ao passado.
        const meio = Math.floor(candles.length / 2);
        for (const strategy of FAMILIAS) {
            const primeira = evaluate(symbol, strategy, candles.slice(0, meio), capital, params);
            const segunda = evaluate(symbol, strategy, candles.slice(meio), capital, params);
            const discordam = primeira.expectancy.greaterThan(0) !== segunda.expectancy.greaterThan(0);
            log.info(`${symbol} — ${strategy} — consistência entre metades`, {
                primeiraMetade: `$${primeira.expectancy.toFixed(4)}`,
                segundaMetade: `$${segunda.expectancy.toFixed(4)}`,
                veredito: discordam ? 'INCONSISTENTE — provável overfitting' : 'consistente',
            });
        }
    }

    if (outcomes.length === 0) {
        log.error('Nenhum ativo pôde ser avaliado.');
        process.exit(1);
    }

    // Agregado: é aqui que a comparação entre as duas famílias fica visível.
    for (const strategy of FAMILIAS) {
        const doGrupo = outcomes.filter((o) => o.strategy === strategy);
        const positivos = doGrupo.filter((o) => o.expectancy.greaterThan(0));
        const bateramBuyHold = doGrupo.filter((o) => o.beatBuyHold);
        const somaLucro = doGrupo.reduce((acc, o) => acc.plus(o.netProfit), new Decimal(0));
        log.info(`=== AGREGADO: ${strategy} ===`, {
            ativosAvaliados: doGrupo.length,
            comExpectativaPositiva: `${positivos.length}/${doGrupo.length}`,
            bateramComprarESegurar: `${bateramBuyHold.length}/${doGrupo.length}`,
            lucroSomadoEntreAtivos: `$${somaLucro.toFixed(4)}`,
            operacoesTotais: doGrupo.reduce((acc, o) => acc + o.trades, 0),
            // O teste que a janela única não faz. Uma estratégia que só ganha
            // em alta está capturando o mercado, não uma vantagem própria — e
            // vai devolver tudo na primeira queda longa.
            somandoTodosOsAtivos_emALTA: descreverRegime(
                doGrupo.reduce(
                    (acc, o) => ({
                        operacoes: acc.operacoes + o.porRegime.alta.operacoes,
                        lucro: acc.lucro.plus(o.porRegime.alta.lucro),
                        acertos: acc.acertos + o.porRegime.alta.acertos,
                    }),
                    { operacoes: 0, lucro: new Decimal(0), acertos: 0 },
                ),
            ),
            somandoTodosOsAtivos_emBAIXA: descreverRegime(
                doGrupo.reduce(
                    (acc, o) => ({
                        operacoes: acc.operacoes + o.porRegime.baixa.operacoes,
                        lucro: acc.lucro.plus(o.porRegime.baixa.lucro),
                        acertos: acc.acertos + o.porRegime.baixa.acertos,
                    }),
                    { operacoes: 0, lucro: new Decimal(0), acertos: 0 },
                ),
            ),
        });
    }

    log.info('=== COMO DECIDIR ===', {
        ponto0: 'Positiva SÓ em mercado de alta é beta, não vantagem: a estratégia capturou o mercado e devolve tudo na primeira queda longa. Compare as duas linhas de regime.',
        ponto1: 'Uma família só merece ir a produção se tiver expectativa positiva na MAIORIA dos ativos, não em um sortudo.',
        ponto2: 'Se as metades discordam num ativo, os parâmetros foram moldados ao passado daquele ativo.',
        ponto3: 'bateuComprarESegurar = NÃO significa que a estratégia pagou taxa para chegar a um lugar pior que ficar parado comprado.',
        ponto4: 'Taxa de acerto baixa não reprova nada. Expectativa por operação negativa reprova.',
        ponto5: 'Backtest mede o passado. É o piso da decisão, nunca promessa de futuro.',
    });

    process.exit(0);
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha ao rodar o backtest.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
