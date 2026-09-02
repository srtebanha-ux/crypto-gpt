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
import { Decimal } from 'decimal.js';
import { RiskManager } from './riskManager';
import { TriangularArbitrageEngine } from './engine';
import { BinanceExchangeProvider } from './binanceExchangeProvider';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

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

async function bootstrap() {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error('Defina BINANCE_API_KEY e BINANCE_API_SECRET no ambiente antes de rodar src/live.ts.');
    }

    const live = resolveLiveMode();
    const C0_BASE = process.env.CAPITAL_USD ?? '50.00';
    const MAX_SLIPPAGE = process.env.MAX_SLIPPAGE ?? '0.0005';

    console.log(`[SYS] APEX-ZERO: HFT Triangular Arbitrage Engine (${live ? 'LIVE — DINHEIRO REAL' : 'TESTNET'}) Booting...`);
    if (live) {
        console.warn('[SYS] *** MODO LIVE ATIVO: ordens reais serão enviadas à Binance. ***');
    }

    const exchange = new BinanceExchangeProvider({ apiKey, apiSecret, live });
    const riskManager = new RiskManager(C0_BASE, MAX_SLIPPAGE);

    await exchange.connect();
    new TriangularArbitrageEngine(exchange, riskManager, C0_BASE);

    const shutdown = () => {
        console.log('\n[SYS] Encerrando conexão com a Binance...');
        exchange.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
    console.error('[FATAL] Falha ao inicializar o engine contra a Binance:', err);
    process.exit(1);
});
