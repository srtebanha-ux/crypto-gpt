// Arquivo: src/live.ts
//
// Bootstrap do engine contra a Binance real (Spot Testnet por padrão).
// Configuração via variáveis de ambiente — nenhuma credencial em código.
//
// Variáveis obrigatórias:
//   BINANCE_API_KEY, BINANCE_API_SECRET
// Variáveis opcionais:
//   CAPITAL_USD          (padrão "50.00")
//   MAX_SLIPPAGE          (padrão "0.0005")
//   BINANCE_LIVE          ("true" para produção; qualquer outro valor => testnet)
//   BINANCE_LIVE_CONFIRM  (deve ser exatamente "I_UNDERSTAND_THE_RISK" quando BINANCE_LIVE=true)
//
// Gate de segurança: para enviar ordens reais (dinheiro real) é preciso
// setar BINANCE_LIVE=true *e* BINANCE_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK
// simultaneamente. Sem isso, o processo se recusa a iniciar em modo live
// e cai para o Spot Testnet (fills simulados, sem risco financeiro).
//
// Antes de operar, o capital configurado (CAPITAL_USD) é sempre reduzido
// (nunca aumentado) até o saldo livre real de USDT na conta — evita erros
// de "insufficient balance" e evita usar mais do que a conta realmente tem.
//
// Se um ciclo falhar e o unwind de emergência do engine também falhar
// ('critical-exposure'), o processo para imediatamente: com posição
// direcional aberta e não neutralizada, continuar operando é o pior curso
// de ação possível — a decisão daqui pra frente exige um humano.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { RiskManager } from './riskManager';
import { TriangularArbitrageEngine } from './engine';
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

    log.info(`APEX-ZERO: HFT Triangular Arbitrage Engine booting em modo ${live ? 'LIVE — DINHEIRO REAL' : 'TESTNET'}.`);
    if (live) {
        log.warn('*** MODO LIVE ATIVO: ordens reais serão enviadas à Binance. ***');
    }

    const exchange = new BinanceExchangeProvider({ apiKey, apiSecret, live });
    await exchange.connect();

    const startingCapital = await resolveStartingCapital(exchange, configuredCapital);
    const riskManager = new RiskManager(startingCapital.toString(), MAX_SLIPPAGE);
    const engine = new TriangularArbitrageEngine(exchange, riskManager, startingCapital.toString());

    const shutdown = (exitCode: number) => {
        log.info('Encerrando conexão com a Binance...');
        exchange.shutdown();
        process.exit(exitCode);
    };

    engine.on('critical-exposure', ({ leg1, leg2, error }) => {
        log.error('*** PARADA DE EMERGÊNCIA: exposição direcional não neutralizada. Intervenção manual necessária. ***', {
            leg1Symbol: leg1 ? 'BTC/USDT' : undefined,
            leg2Symbol: leg2 ? 'ETH/BTC' : undefined,
            error: error instanceof Error ? error.message : String(error),
        });
        shutdown(1);
    });
    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));
}

bootstrap().catch((err) => {
    log.error('Falha ao inicializar o engine contra a Binance.', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
