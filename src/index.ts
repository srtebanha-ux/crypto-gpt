// Arquivo: src/index.ts
//
// Demo do HFT Triangular Arbitrage Engine contra um feed mock (sem rede
// real, sem credenciais). Para operar contra a Binance de verdade, veja
// src/live.ts + README.md.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { RiskManager } from './riskManager';
import { TriangularArbitrageEngine } from './engine';
import { MockExchangeProvider } from './mockExchangeProvider';
import { Triangle } from './types';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const log = createLogger('demo');

function bootstrap() {
    log.info('APEX-ZERO: HFT Triangular Arbitrage Engine (DEMO/MOCK) booting...');

    // Capital de $50, tolerância de slippage rigorosa (0.0005 = 0.05%)
    const C0_BASE = '50.00';
    const MAX_SLIPPAGE = '0.0005';

    const exchange = new MockExchangeProvider();
    const riskManager = new RiskManager(MAX_SLIPPAGE);
    const demoTriangle: Triangle = { id: 'USDT-BTC-ETH', leg1: 'BTC/USDT', leg2: 'ETH/BTC', leg3: 'ETH/USDT' };

    // statMinSamples: 0 desativa o kill switch estatístico (camada #2) para
    // a demo: o feed mock repete sempre a mesma distorção fixa, então nunca
    // teria uma variância real para julgar um tick como "anomalia" — esse
    // gate só faz sentido contra um feed de mercado genuíno (ver src/live.ts).
    new TriangularArbitrageEngine(exchange, riskManager, [demoTriangle], C0_BASE, { statMinSamples: 0 });
}

bootstrap();
