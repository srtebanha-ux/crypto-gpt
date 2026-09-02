// Arquivo: src/live.ts
//
// Bootstrap do engine contra a Binance real (Spot Testnet por padrão),
// pensado para rodar 24/7 como worker de longa duração (ex.: Railway —
// ver Dockerfile/railway.json na raiz do repo).
//
// Variáveis obrigatórias:
//   BINANCE_API_KEY, BINANCE_API_SECRET
// Variáveis opcionais:
//   CAPITAL_USD           (padrão "50.00")
//   MAX_SLIPPAGE           (padrão "0.0005")
//   BINANCE_LIVE           ("true" para produção; qualquer outro valor => testnet)
//   BINANCE_LIVE_CONFIRM   (deve ser exatamente "I_UNDERSTAND_THE_RISK" quando BINANCE_LIVE=true)
//   STAT_MIN_SAMPLES        (padrão 20 — kill switch estatístico, ver engine.ts)
//   STAT_Z_THRESHOLD        (padrão 3)
//   RATIO_EWMA_ALPHA        (padrão 0.05)
//   HEARTBEAT_INTERVAL_MIN  (padrão 5 — log periódico de "estou vivo" para observabilidade 24/7)
//
// Gate de segurança: para enviar ordens reais (dinheiro real) é preciso
// setar BINANCE_LIVE=true *e* BINANCE_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK
// simultaneamente. Sem isso, o processo se recusa a iniciar em modo live
// e cai para o Spot Testnet (fills simulados, sem risco financeiro).
//
// Antes de operar, o capital configurado (CAPITAL_USD) é sempre reduzido
// (nunca aumentado) até o saldo livre real de USDT na conta.
//
// Sobre reinício automático (Railway ou qualquer orquestrador com restart
// policy): se um ciclo falhar e o unwind de emergência do engine TAMBÉM
// falhar ('critical-exposure'), o engine se HALTA PERMANENTEMENTE por
// conta própria (engine.isHalted() nunca mais volta a false) — este
// processo NÃO chama process.exit() nesse caso. Isso é proposital: matar o
// processo aqui faria a restart policy relançá-lo, e ele voltaria a operar
// às cegas sobre uma posição que pode não ter sido neutralizada. Em vez
// disso, o processo continua de pé (WS conectado, heartbeat rodando) mas
// permanentemente parado de negociar, gritando no log até um humano
// investigar a conta manualmente e decidir se/como reiniciar o deploy.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { RiskManager } from './riskManager';
import { EngineConfig, TriangularArbitrageEngine } from './engine';
import { BinanceExchangeProvider } from './binanceExchangeProvider';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const log = createLogger('live');
const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_THE_RISK';

function resolveLiveMode(): boolean {
    const wantsLive = process.env.BINANCE_LIVE === 'true';
    if (!wantsLive) return false;

    if (process.env.BINANCE_LIVE_CONFIRM !== LIVE_CONFIRM_PHRASE) {
        throw new Error(
            `BINANCE_LIVE=true exige também BINANCE_LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE} para confirmar que ` +
            `você entende que isso envia ordens reais com dinheiro real. Abortando.`
        );
    }
    return true;
}

function resolveEngineConfig(): Partial<EngineConfig> {
    const config: Partial<EngineConfig> = {};
    if (process.env.STAT_MIN_SAMPLES) config.statMinSamples = Number(process.env.STAT_MIN_SAMPLES);
    if (process.env.STAT_Z_THRESHOLD) config.statZThreshold = new Decimal(process.env.STAT_Z_THRESHOLD);
    if (process.env.RATIO_EWMA_ALPHA) config.ratioEwmaAlpha = new Decimal(process.env.RATIO_EWMA_ALPHA);
    return config;
}

async function resolveStartingCapital(exchange: BinanceExchangeProvider, configuredCapital: Decimal): Promise<Decimal> {
    try {
        const freeUsdt = await exchange.fetchAvailableBalance('USDT');
        if (freeUsdt.lessThan(configuredCapital)) {
            log.warn('Saldo livre de USDT é menor que CAPITAL_USD configurado — reduzindo capital de partida.', {
                configurado: configuredCapital.toString(),
                saldoLivre: freeUsdt.toString(),
            });
            return freeUsdt;
        }
        return configuredCapital;
    } catch (err) {
        log.warn('Não foi possível consultar o saldo da conta; seguindo com CAPITAL_USD configurado.', {
            error: err instanceof Error ? err.message : String(err),
        });
        return configuredCapital;
    }
}

async function bootstrap() {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error('Defina BINANCE_API_KEY e BINANCE_API_SECRET no ambiente antes de rodar src/live.ts.');
    }

    const live = resolveLiveMode();
    const configuredCapital = new Decimal(process.env.CAPITAL_USD ?? '50.00');
    const MAX_SLIPPAGE = process.env.MAX_SLIPPAGE ?? '0.0005';
    const heartbeatIntervalMin = Number(process.env.HEARTBEAT_INTERVAL_MIN ?? '5');

    log.info(`APEX-ZERO: HFT Triangular Arbitrage Engine booting em modo ${live ? 'LIVE — DINHEIRO REAL' : 'TESTNET'}.`);
    if (live) {
        log.warn('*** MODO LIVE ATIVO: ordens reais serão enviadas à Binance. ***');
    }

    const exchange = new BinanceExchangeProvider({ apiKey, apiSecret, live });
    await exchange.connect();

    const startingCapital = await resolveStartingCapital(exchange, configuredCapital);
    const riskManager = new RiskManager(startingCapital.toString(), MAX_SLIPPAGE);
    const engine = new TriangularArbitrageEngine(exchange, riskManager, startingCapital.toString(), resolveEngineConfig());

    engine.on('critical-exposure', ({ leg1, leg2, error }) => {
        log.error('*** PARADA DE EMERGÊNCIA: exposição direcional não neutralizada. Engine parado permanentemente. Intervenção manual necessária. ***', {
            leg1Symbol: leg1 ? 'BTC/USDT' : undefined,
            leg2Symbol: leg2 ? 'ETH/BTC' : undefined,
            error: error instanceof Error ? error.message : String(error),
        });
        // Sem process.exit() aqui de propósito — ver o cabeçalho do arquivo.
    });

    if (heartbeatIntervalMin > 0) {
        setInterval(() => {
            log.info('Heartbeat — engine ativo.', {
                halted: engine.isHalted(),
                capital: engine.getCurrentCapital().toFixed(6),
            });
        }, heartbeatIntervalMin * 60_000).unref();
    }

    const shutdown = (exitCode: number) => {
        log.info('Encerrando conexão com a Binance...');
        exchange.shutdown();
        process.exit(exitCode);
    };
    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

    // Crash genuíno e inesperado (bug): loga com detalhe e sai com erro —
    // esse SIM deve acionar a restart policy do orquestrador (ON_FAILURE no
    // railway.json), diferente da parada de emergência acima.
    process.on('uncaughtException', (err) => {
        log.error('uncaughtException — encerrando para a restart policy relançar o processo.', { error: err.message, stack: err.stack });
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        log.error('unhandledRejection — encerrando para a restart policy relançar o processo.', {
            reason: reason instanceof Error ? reason.message : String(reason),
        });
        process.exit(1);
    });
}

bootstrap().catch((err) => {
    log.error('Falha ao inicializar o engine contra a Binance.', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
