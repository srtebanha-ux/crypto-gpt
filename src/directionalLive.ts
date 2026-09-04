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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { BinanceExchangeProvider } from './binanceExchangeProvider';
import {
    atr,
    detectBreakout,
    detectMomentumSurge,
    detectOversoldReversion,
    isAboveTrend,
    rsiSeries,
    type Candle,
} from './signals';
import { planPosition, tradeNetPnl, updateTrailingStopAtr } from './positionSizing';
import { resolveStrategyParams, type ResolvedStrategyParams } from './strategyParams';
import type { EntryStrategy } from './backtest';


Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const log = createLogger('direcional');

const BINANCE_REST = 'https://api.binance.com';
/** Velas de histórico mantidas por ativo — suficiente para média de 50 + folga. */
const HISTORY_CANDLES = 300;

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

/** Estado que precisa sobreviver a um reinício do processo. */
export interface BookState {
    capital: string;
    realizedPnl: string;
    wins: number;
    losses: number;
    somaGanhos?: string;
    somaPerdas?: string;
    committed: string;
    positions: Array<{
        symbol: string;
        entryPrice: string;
        quantity: string;
        notional: string;
        initialRisk: string;
        stopPrice: string;
        highestSinceEntry: string;
        openedAt: number;
    }>;
}

/**
 * Grava o estado de forma atômica: escreve num temporário e renomeia.
 *
 * Sem isso, um reinício no meio da escrita deixaria um JSON truncado — e o
 * motor subiria sem as posições que acabou de salvar, que é o cenário exato
 * que a persistência existe para evitar.
 */
export function saveState(path: string, books: Record<string, BookState>): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(books, null, 2));
    renameSync(tmp, path);
}

export function loadState(path: string): Record<string, BookState> {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, BookState>;
    } catch {
        return {};
    }
}

/**
 * O que fazer quando o livro e o saldo real da corretora divergem.
 *
 * Isolado como função pura porque é a decisão que importa e a que pode estar
 * errada — o resto é I/O. Os quatro casos têm ações opostas, e confundir dois
 * deles custa caro: tratar órfã como "nada a fazer" deixa dinheiro real sem
 * stop; tratar fantasma como posição bloqueia o caixa para sempre.
 */
export type ReconcileAction = 'nada' | 'remover-fantasma' | 'adotar-orfa' | 'alertar-orfa';

export function decideReconcile(params: {
    temPosicaoNoLivro: boolean;
    valorDoSaldo: Decimal;
    minNotional: Decimal;
    podeAdotar: boolean;
}): ReconcileAction {
    // "Relevante" é o mesmo piso que impede abrir posição: abaixo do notional
    // mínimo a corretora nem aceitaria vender, então poeira de saldo não é
    // posição. Sem esse piso, restos de arredondamento virariam posições
    // fantasma a cada ciclo.
    const relevante = params.valorDoSaldo.greaterThanOrEqualTo(params.minNotional);
    if (params.temPosicaoNoLivro && !relevante) return 'remover-fantasma';
    if (!params.temPosicaoNoLivro && relevante) return params.podeAdotar ? 'adotar-orfa' : 'alertar-orfa';
    return 'nada';
}

interface OpenPosition {
    symbol: string;
    entryPrice: Decimal;
    quantity: Decimal;
    /** Caixa preso nesta posição (quantidade × preço de entrada). */
    notional: Decimal;
    /** Distância entrada→stop inicial por unidade. É o "R" do alvo de lucro. */
    initialRisk: Decimal;
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
    /** Onde o estado é gravado para sobreviver a reinício. */
    stateFile: string;
    /** Teto de uma posição como fração do livro. Permite ter mais de uma. */
    maxPositionFraction: Decimal;
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
async function fetchClosedCandles(
    symbol: string,
    interval: string,
    limit: number,
): Promise<{ closed: Candle[]; precoAgora: Decimal }> {
    const res = await fetch(`${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit + 1}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar klines de ${symbol}`);
    const raw = (await res.json()) as RawKline[];
    const todas = raw.map(parseKline);
    // A vela em formação sai das DECISÕES e fica só para EXIBIÇÃO. Decidir
    // sobre ela é look-ahead ao vivo — o "fechamento" ainda vai mudar. Mas
    // acompanhar quanto a posição aberta está ganhando agora não é decisão, e
    // quem opera precisa desse número de minuto a minuto.
    return { closed: todas.slice(0, -1), precoAgora: todas[todas.length - 1].close };
}

function resolveConfig(): Config {
    const live = process.env.DIRECTIONAL_LIVE === 'true';
    if (live && process.env.DIRECTIONAL_LIVE_CONFIRM !== 'I_UNDERSTAND_THE_RISK') {
        throw new Error(
            'DIRECTIONAL_LIVE=true exige DIRECTIONAL_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK. ' +
                'Ordens reais numa estratégia direcional podem perder dinheiro sem nenhuma falha técnica.',
        );
    }
    // Trim e minúsculas: um espaço sobrando numa variável do painel do Railway
    // é invisível e derrubaria o motor no boot com "estratégia inválida" — falha
    // barulhenta por um erro de digitação que ninguém consegue ver.
    const escolha = (process.env.DIRECTIONAL_STRATEGY ?? 'reversion').trim().toLowerCase();
    const VALIDAS = ['breakout', 'reversion', 'momentum', 'both', 'all'];
    if (!VALIDAS.includes(escolha)) {
        throw new Error(`DIRECTIONAL_STRATEGY inválida: "${escolha}". Use ${VALIDAS.join(', ')}.`);
    }
    // 'both' e 'all' rodam as famílias em livros SEPARADOS, com o capital
    // dividido. Separar é o ponto: misturadas, um resultado bom de uma
    // esconderia um ruim da outra, e a comparação — que é o motivo de rodar
    // mais de uma — sumiria.
    const familias: EntryStrategy[] =
        escolha === 'all'
            ? ['reversion', 'breakout', 'momentum']
            : escolha === 'both'
            ? ['reversion', 'breakout']
            : [escolha as EntryStrategy];
    return {
        symbols: (process.env.DIRECTIONAL_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        interval: process.env.DIRECTIONAL_INTERVAL ?? '1h',
        capital: new Decimal(process.env.DIRECTIONAL_CAPITAL ?? '20'),
        pollSeconds: Number(process.env.DIRECTIONAL_POLL_SEC ?? '60'),
        live,
        stateFile: process.env.DIRECTIONAL_STATE_FILE ?? './data/directional-state.json',
        maxPositionFraction: new Decimal(process.env.DIRECTIONAL_MAX_POSITION_FRACTION ?? '0.34'),
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
        tetoPorPosicao: `${cfg.maxPositionFraction.mul(100).toFixed(0)}% do livro`,
        posicoesSimultaneasPossiveis: cfg.capital
            .dividedBy(cfg.livros.length)
            .mul(cfg.maxPositionFraction)
            .dividedBy(cfg.strategy.minNotional)
            .floor()
            .toString(),
    });
    if (cfg.live) {
        log.warn('*** ORDENS REAIS SERÃO ENVIADAS. Perda é resultado possível sem nenhuma falha técnica. ***');
    }
    // Dividir capital entre famílias reduz o livro de cada uma, e um livro
    // abaixo do notional mínimo da corretora recusa TUDO em silêncio — o motor
    // pareceria vivo e nunca operaria. Melhor dizer isso no boot.
    const livroPorFamilia = cfg.capital.dividedBy(cfg.livros.length).mul(cfg.maxPositionFraction);
    if (livroPorFamilia.lessThan(cfg.strategy.minNotional)) {
        log.error(
            `Cada família fica com $${livroPorFamilia.toFixed(2)} por posição, abaixo do mínimo da ` +
                `corretora ($${cfg.strategy.minNotional.toFixed(2)}). NENHUMA ordem vai passar.`,
            {
                oQueFazer:
                    `Rode menos famílias (DIRECTIONAL_STRATEGY), aumente DIRECTIONAL_CAPITAL para pelo menos ` +
                    `$${cfg.strategy.minNotional.mul(cfg.livros.length).dividedBy(cfg.maxPositionFraction).toFixed(2)}, ` +
                    `ou suba DIRECTIONAL_MAX_POSITION_FRACTION.`,
            },
        );
    }

    /**
     * Um LIVRO por família de entrada: posições, capital e placar próprios.
     *
     * Separar é o ponto de rodar as duas ao mesmo tempo. Num livro só, o
     * resultado de uma esconderia o da outra e a comparação — que é o motivo de
     * rodar as duas — desapareceria. Cada uma recebe uma fatia igual do
     * capital, então elas competem em pé de igualdade.
     */
    const estadoSalvo = loadState(cfg.stateFile);
    // Adotar posição órfã é decisão de quem opera: o motor não sabe o preço
    // pago e vai medir o resultado a partir de agora, o que distorce o placar.
    // Ainda assim é melhor que deixá-la sem stop — mas quem escolhe é você.
    const adoptOrphans = process.env.DIRECTIONAL_ADOPT_ORPHANS === 'true';
    const criarLivro = (params: ResolvedStrategyParams, capitalInicial: Decimal) => {
    const salvo = estadoSalvo[params.entryStrategy];
    const positions = new Map<string, OpenPosition>();
    let capital = salvo ? new Decimal(salvo.capital) : capitalInicial;
    let realizedPnl = new Decimal(salvo?.realizedPnl ?? '0');
    let wins = salvo?.wins ?? 0;
    let losses = salvo?.losses ?? 0;
    // Somas separadas de ganho e perda. A taxa de acerto sozinha não decide
    // nada: 40% de acerto com ganho 3x é lucrativo, 90% com perda 10x quebra.
    // O que decide é ganho médio contra perda média, e sem estes dois números
    // o heartbeat não permite comparar o papel com o backtest.
    let somaGanhos = new Decimal(salvo?.somaGanhos ?? '0');
    let somaPerdas = new Decimal(salvo?.somaPerdas ?? '0');
    /**
     * Dinheiro preso nas posições abertas. Sem isto, cada ativo dimensionaria
     * contra o capital TOTAL e quatro posições simultâneas comprometeriam
     * quatro vezes o dinheiro que existe — alavancagem acidental.
     */
    let committed = new Decimal(salvo?.committed ?? '0');
    if (salvo) {
        for (const p of salvo.positions) {
            positions.set(p.symbol, {
                symbol: p.symbol,
                entryPrice: new Decimal(p.entryPrice),
                quantity: new Decimal(p.quantity),
                notional: new Decimal(p.notional),
                // Estado antigo não tem o campo: reconstrói a partir do stop
                // atual. Fica maior que o R original se o stop já subiu, e o
                // efeito é um alvo mais distante — conservador, que é o lado
                // certo de errar quando o dado se perdeu.
                initialRisk: new Decimal(p.initialRisk ?? new Decimal(p.entryPrice).minus(p.stopPrice).toString()),
                stopPrice: new Decimal(p.stopPrice),
                highestSinceEntry: new Decimal(p.highestSinceEntry),
                openedAt: p.openedAt,
            });
        }
        log.info(`[${params.entryStrategy}] Estado recuperado do disco.`, {
            capital: capital.toFixed(6),
            posicoesReabertas: positions.size,
            ativos: Array.from(positions.keys()).join(',') || 'nenhum',
        });
    }
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
        if (netProfit.greaterThan(0)) {
            wins += 1;
            somaGanhos = somaGanhos.plus(netProfit);
        } else {
            losses += 1;
            somaPerdas = somaPerdas.plus(netProfit.abs());
        }
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

    /** Símbolos já reconciliados contra o saldo real da corretora. */
    const reconciliados = new Set<string>();

    /**
     * Confere o estado do livro contra o SALDO REAL da corretora.
     *
     * O arquivo de estado protege contra reinício do processo; não protege
     * contra o arquivo se perder (container novo sem volume), contra alguém
     * vender pela interface da Binance, nem contra uma ordem que foi executada
     * enquanto o motor estava fora do ar. Em todos esses casos o livro e a
     * realidade divergem — e a divergência não gera erro: o motor simplesmente
     * deixa de vigiar uma posição que existe, ou vigia uma que não existe mais.
     *
     * A corretora é a única fonte da verdade sobre o que se tem. Isto roda uma
     * vez por símbolo, no primeiro ciclo em que há preço disponível.
     */
    const reconcile = async (symbol: string, price: Decimal, atrValue: Decimal | null) => {
        if (!exchange || reconciliados.has(symbol)) return;
        reconciliados.add(symbol);

        const asset = symbol.replace('USDT', '');
        const saldo = await exchange.fetchAvailableBalance(asset);
        const valor = saldo.mul(price);
        const pos = positions.get(symbol);
        const acao = decideReconcile({
            temPosicaoNoLivro: pos !== undefined,
            valorDoSaldo: valor,
            minNotional: params.minNotional,
            podeAdotar: adoptOrphans && atrValue !== null,
        });
        if (acao === 'nada') return;

        if (pos && acao === 'remover-fantasma') {
            // O livro acha que tem posição, a corretora diz que não. Manter
            // seria vigiar um fantasma e bloquear o caixa para sempre.
            log.warn(`[${params.entryStrategy}] ${symbol}: posição no estado não existe na corretora — removida.`, {
                quantidadeNoEstado: pos.quantity.toString(),
                saldoReal: saldo.toString(),
                causaProvavel: 'venda manual, ou ordem executada com o motor fora do ar',
            });
            committed = committed.minus(pos.notional);
            if (committed.lessThan(0)) committed = new Decimal(0);
            positions.delete(symbol);
            return;
        }

        if (!pos) {
            // Existe posição de verdade que o motor não conhece: sem stop, sem
            // ninguém olhando. É o cenário mais perigoso possível.
            if (acao === 'alertar-orfa' || !atrValue) {
                log.error(
                    `[${params.entryStrategy}] ${symbol}: SALDO SEM POSIÇÃO NO ESTADO — ` +
                        `${saldo.toString()} ${asset} (~${valor.toFixed(2)} USDT) sem stop nenhum.`,
                    {
                        oQueFazer:
                            'Venda manualmente na Binance, OU rode com DIRECTIONAL_ADOPT_ORPHANS=true ' +
                            'para o motor adotar a posição com stop em ATR a partir do preço atual.',
                        porque: 'Posição que o motor não conhece é posição sem stop. Ignorar em silêncio é o pior caminho.',
                    },
                );
                return;
            }
            const stop = price.minus(atrValue.mul(params.atrStopMultiplier));
            const notional = saldo.mul(price);
            committed = committed.plus(notional);
            positions.set(symbol, {
                symbol,
                entryPrice: price,
                quantity: saldo,
                notional,
                initialRisk: price.minus(stop),
                stopPrice: stop,
                highestSinceEntry: price,
                openedAt: Date.now(),
            });
            log.warn(`[${params.entryStrategy}] ${symbol}: posição órfã ADOTADA com stop novo.`, {
                quantidade: saldo.toString(),
                precoDeReferencia: price.toFixed(6),
                stop: stop.toFixed(6),
                aviso:
                    'O preço de entrada real é desconhecido: o resultado desta operação será medido a partir de agora, ' +
                    'não do que foi pago. O que importa é que ela passa a ter stop.',
            });
        }
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

        // Antes de qualquer decisão: o livro bate com a corretora?
        await reconcile(symbol, candle.close, atr(candles, last, params.atrPeriod));

        const pos = positions.get(symbol);
        if (pos) {
            diagnostico.set(symbol, `em posição (stop ${pos.stopPrice.toFixed(2)})`);
            // Stop pela MÍNIMA da vela, igual ao backtest: se furou no meio do
            // caminho, a posição acabou ali.
            if (candle.low.lessThanOrEqualTo(pos.stopPrice)) {
                await closePosition(pos, pos.stopPrice, 'stop atingido');
                return;
            }
            const alvo =
                params.takeProfitR && params.takeProfitR.greaterThan(0) && pos.initialRisk.greaterThan(0)
                    ? pos.entryPrice.plus(pos.initialRisk.mul(params.takeProfitR))
                    : null;
            if (alvo && candle.high.greaterThanOrEqualTo(alvo)) {
                // Depois do stop, nunca antes: quando a vela toca os dois, o
                // OHLC não diz qual veio primeiro, e supor o alvo seria escolher
                // a versão que favorece o resultado.
                await closePosition(pos, alvo, `alvo de ${params.takeProfitR!.toString()}R atingido`);
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
            params.entryStrategy === 'momentum'
                ? detectMomentumSurge(
                      candles,
                      last,
                      params.breakoutLookback,
                      params.atrPeriod,
                      params.volumePeriod ?? 20,
                      params.minVolumeRatio ?? new Decimal('3'),
                  )
                : params.entryStrategy === 'reversion'
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
                    : 'reason' in signal && signal.reason
                    ? `sem sinal (${signal.reason})`
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
            maxPositionFraction: cfg.maxPositionFraction,
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
            initialRisk: filledPrice.minus(filledStop),
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
        /**
         * Posições abertas com o resultado NÃO REALIZADO ao preço de agora.
         *
         * Existe porque o placar do heartbeat só conta operação FECHADA, e uma
         * posição pode ficar aberta por dias. Sem isto o log mostra zero
         * enquanto há dinheiro se movendo — que é indistinguível de estar parado.
         */
        painel: (precos: Map<string, Decimal>): string[] =>
            Array.from(positions.values()).map((p) => {
                const agora = precos.get(p.symbol);
                if (!agora) return `${p.symbol}: aberta a ${p.entryPrice.toFixed(6)} (sem preço atual)`;
                const variacao = agora.minus(p.entryPrice).dividedBy(p.entryPrice).mul(100);
                const { netProfit } = tradeNetPnl(p.entryPrice, agora, p.quantity, params.feeRate);
                const ateOStop = agora.minus(p.stopPrice).dividedBy(agora).mul(100);
                return (
                    `${p.symbol}: ${p.entryPrice.toFixed(6)} → ${agora.toFixed(6)} ` +
                    `(${variacao.toFixed(2)}%) | se fechasse agora: $${netProfit.toFixed(4)} | ` +
                    `stop ${p.stopPrice.toFixed(6)} (${ateOStop.toFixed(2)}% abaixo)`
                );
            }),
        /** Snapshot serializável — o que precisa sobreviver a um reinício. */
        snapshot: (): BookState => ({
            capital: capital.toString(),
            realizedPnl: realizedPnl.toString(),
            wins,
            losses,
            somaGanhos: somaGanhos.toString(),
            somaPerdas: somaPerdas.toString(),
            committed: committed.toString(),
            positions: Array.from(positions.values()).map((p) => ({
                symbol: p.symbol,
                entryPrice: p.entryPrice.toString(),
                quantity: p.quantity.toString(),
                notional: p.notional.toString(),
                initialRisk: p.initialRisk.toString(),
                stopPrice: p.stopPrice.toString(),
                highestSinceEntry: p.highestSinceEntry.toString(),
                openedAt: p.openedAt,
            })),
        }),
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
            ...(wins + losses > 0
                ? {
                      taxaAcerto: `${((wins / (wins + losses)) * 100).toFixed(1)}%`,
                      ganhoMedio: wins > 0 ? `$${somaGanhos.dividedBy(wins).toFixed(4)}` : '—',
                      perdaMedia: losses > 0 ? `$${somaPerdas.dividedBy(losses).toFixed(4)}` : '—',
                      // O número que reprova ou aprova. Positivo = a estratégia
                      // ganha dinheiro por operação, independente da taxa de acerto.
                      expectativaPorOperacao: `$${realizedPnl.dividedBy(wins + losses).toFixed(4)}`,
                      compareComOBacktest: 'backtest 1h/reversion mediu 39,6% de acerto e $0,0245 por operação',
                  }
                : {}),
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

    // Capital recuperado do disco MANDA sobre a divisão nova: o capital de um
    // livro é o patrimônio dele, com lucro e prejuízo embutidos, e reescrevê-lo
    // apagaria o histórico. A consequência é que mudar DIRECTIONAL_CAPITAL ou o
    // número de famílias não redistribui o que já existe — e a soma pode passar
    // do capital configurado sem ninguém perceber. Em papel é contabilidade; com
    // dinheiro real seria alocar mais do que se tem.
    const somaDosLivros = livros.reduce((acc, l) => acc.plus(new Decimal(l.snapshot().capital)), new Decimal(0));
    if (!somaDosLivros.minus(cfg.capital).abs().lessThan('0.01')) {
        log.warn('A soma dos livros não bate com DIRECTIONAL_CAPITAL.', {
            somaDosLivros: somaDosLivros.toFixed(2),
            capitalConfigurado: cfg.capital.toFixed(2),
            porque:
                'Livros com estado salvo mantêm o capital que já tinham — é o patrimônio deles, com resultado ' +
                'embutido. A divisão nova só vale para livro novo.',
            paraRedistribuir: `Apague ${cfg.stateFile} para todos os livros recomeçarem da divisão atual.`,
        });
    }


    /** Último preço visto por ativo — só para exibição, nunca para decisão. */
    const precosAtuais = new Map<string, Decimal>();

    for (;;) {
        for (const symbol of cfg.symbols) {
            try {
                // As velas são buscadas UMA vez por símbolo e servidas a todos
                // os livros. Cada livro buscando as suas dobraria as chamadas à
                // Binance para responder exatamente a mesma coisa — e, pior,
                // as duas famílias poderiam decidir sobre instantes diferentes.
                const { closed, precoAgora } = await fetchClosedCandles(symbol, cfg.interval, HISTORY_CANDLES);
                precosAtuais.set(symbol, precoAgora);
                for (const livro of livros) {
                    await livro.step(symbol, closed);
                }
            } catch (err) {
                // Falha em um ativo não pode parar os outros nem derrubar o
                // motor: ele existe para rodar ininterruptamente.
                const motivo = err instanceof Error ? err.message : String(err);
                for (const livro of livros) livro.marcarFalha(symbol, motivo);
                log.warn(`Falha ao avaliar ${symbol}; segue no próximo ciclo.`, { erro: motivo });
            }
        }

        // Gravado a cada ciclo, não só quando algo muda: o stop móvel sobe
        // dentro do ciclo sem abrir nem fechar posição, e perder essa
        // atualização num reinício reabriria a posição com stop mais frouxo do
        // que o que estava valendo.
        try {
            saveState(
                cfg.stateFile,
                Object.fromEntries(livros.map((l) => [l.params.entryStrategy, l.snapshot()])),
            );
        } catch (err) {
            log.warn('Não foi possível gravar o estado; um reinício perderia as posições abertas.', {
                arquivo: cfg.stateFile,
                erro: err instanceof Error ? err.message : String(err),
            });
        }

        for (const livro of livros) {
            log.info(`Heartbeat [${livro.params.entryStrategy}] — motor direcional ativo.`, {
                modo: cfg.live ? 'LIVE' : 'PAPEL',
                leituraDaVela: `uma avaliação por vela de ${cfg.interval} — o diagnóstico abaixo é da última fechada`,
                ...livro.resumo(),
            });
            // Painel ao vivo: atualiza a cada ciclo, com o preço de agora.
            for (const linha of livro.painel(precosAtuais)) {
                log.info(`  [${livro.params.entryStrategy}] EM POSIÇÃO — ${linha}`);
            }
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
