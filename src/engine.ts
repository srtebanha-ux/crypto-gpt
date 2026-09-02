// Arquivo: src/engine.ts
import { Decimal } from 'decimal.js';
import { IExchangeProvider, Ticker } from './types';
import { RiskManager } from './riskManager';

// ============================================================================
// CORE ENGINE: TRIANGULAR ARBITRAGE HFT
// ============================================================================
export class TriangularArbitrageEngine {
    private exchange: IExchangeProvider;
    private riskManager: RiskManager;
    private orderBookState: Map<string, Ticker> = new Map();
    private isExecutingCycle: boolean = false;
    private currentCapital: Decimal;

    constructor(exchange: IExchangeProvider, riskManager: RiskManager, initialCapital: string) {
        this.exchange = exchange;
        this.riskManager = riskManager;
        this.currentCapital = new Decimal(initialCapital);

        this.initializeFeed();
    }

    private initializeFeed() {
        this.exchange.on('ticker', (ticker: Ticker) => {
            this.orderBookState.set(ticker.symbol, ticker);
            this.evaluateInefficiency();
        });
        console.log(`[SYS] Triangular Arbitrage Engine Initialized. Capital Base: $${this.currentCapital.toString()}`);
    }

    private async evaluateInefficiency() {
        if (this.isExecutingCycle) return; // Prevenção estrita de race conditions e sobreposição de I/O

        const btcUsdt = this.orderBookState.get('BTC/USDT');
        const ethBtc = this.orderBookState.get('ETH/BTC');
        const ethUsdt = this.orderBookState.get('ETH/USDT');

        if (!btcUsdt || !ethBtc || !ethUsdt) return;

        // Verifica a obsolescência temporal do dado (Kill Switch de Timestamp)
        const now = Date.now();
        const maxAge = 100; // ms
        if ((now - btcUsdt.timestamp > maxAge) || (now - ethBtc.timestamp > maxAge) || (now - ethUsdt.timestamp > maxAge)) {
            return;
        }

        const p1Ask = btcUsdt.ask;
        const p2Ask = ethBtc.ask;
        const p3Bid = ethUsdt.bid;

        const analysis = this.riskManager.isTriangularArbitrageViable(
            this.currentCapital,
            p1Ask,
            p2Ask,
            p3Bid,
            this.exchange.getFeeRate()
        );

        if (analysis.viable) {
            this.isExecutingCycle = true;
            await this.executeArbitrageCycle(p1Ask, p2Ask, p3Bid, analysis.expectedNetProfit);
        }
    }

    private async executeArbitrageCycle(p1Ask: Decimal, p2Ask: Decimal, p3Bid: Decimal, projectedProfit: Decimal) {
        console.log(`\n[EXEC] Ineficiência Matemática Detectada. Projected Net Profit: $${projectedProfit.toFixed(6)}`);
        const startTime = Date.now();

        try {
            // Perna 1: Comprar BTC com USDT
            const feeFactor = new Decimal(1).minus(this.exchange.getFeeRate());
            let btcQty = this.currentCapital.dividedBy(p1Ask).mul(feeFactor);
            const leg1 = await this.exchange.executeOrder('BTC/USDT', 'BUY', 'MARKET', btcQty, p1Ask);

            // Perna 2: Comprar ETH com BTC
            let ethQty = leg1.executedQty.dividedBy(p2Ask).mul(feeFactor);
            const leg2 = await this.exchange.executeOrder('ETH/BTC', 'BUY', 'MARKET', ethQty, p2Ask);

            // Perna 3: Vender ETH para USDT
            const leg3 = await this.exchange.executeOrder('ETH/USDT', 'SELL', 'MARKET', leg2.executedQty, p3Bid);

            // Resolução do fluxo
            const finalCapital = leg3.executedQty.mul(leg3.executedPrice).mul(feeFactor);
            const actualProfit = finalCapital.minus(this.currentCapital);
            this.currentCapital = finalCapital;

            console.log(`[SUCCESS] Arbitragem Concluída. Tempo de Execução: ${Date.now() - startTime}ms`);
            console.log(`[STATE] Capital Atualizado: $${this.currentCapital.toFixed(6)} | Lucro Realizado: $${actualProfit.toFixed(6)}`);

        } catch (error) {
            console.error(`[FATAL] Falha de Execução de Ciclo. Risco de Exposição Direcional. Abortando processos.`, error);
            // Em produção, isso acionaria um pipeline de descarte de posição a mercado para neutralizar o Delta.
        } finally {
            this.isExecutingCycle = false;
        }
    }
}
