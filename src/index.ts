// Arquivo: src/index.ts
//
// Demo do HFT Triangular Arbitrage Engine contra um feed mock (sem rede
// real, sem credenciais). Para operar contra a Binance de verdade, veja
// src/live.ts + README.md.
import { Decimal } from 'decimal.js';
import { RiskManager } from './riskManager';
import { TriangularArbitrageEngine } from './engine';
import { MockExchangeProvider } from './mockExchangeProvider';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

function bootstrap() {
    console.log('[SYS] APEX-ZERO: HFT Triangular Arbitrage Engine (DEMO/MOCK) Booting...');

    // Capital de $50, tolerância de slippage rigorosa (0.0005 = 0.05%)
    const C0_BASE = '50.00';
    const MAX_SLIPPAGE = '0.0005';

    const exchange = new MockExchangeProvider();
    const riskManager = new RiskManager(C0_BASE, MAX_SLIPPAGE);

    // Instanciação e operação perpétua em memória
    new TriangularArbitrageEngine(exchange, riskManager, C0_BASE);
}

bootstrap();
