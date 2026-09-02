// Arquivo: src/engine.ts
import { Decimal } from 'decimal.js';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { ExecutionResult, IExchangeProvider, Ticker } from './types';
import { RiskManager } from './riskManager';

const log = createLogger('engine');

// ============================================================================
// CORE ENGINE: TRIANGULAR ARBITRAGE HFT
//
// Eventos emitidos:
//   'cycle-success'    (payload: { profit: Decimal; capital: Decimal })
//   'cycle-failure'    (payload: { error: unknown })
//   'critical-exposure' (payload: { leg1?: ExecutionResult; leg2?: ExecutionResult; error: unknown })
//     — o unwind de emergência também falhou; há posição direcional aberta
//     na corretora que o engine não conseguiu neutralizar sozinho. Quem
//     consome o engine deve tratar isso como um alerta de intervenção
//     manual imediata (ex.: parar o processo — ver src/live.ts).
// ============================================================================
export class TriangularArbitrageEngine extends EventEmitter {
    private exchange: IExchangeProvider;
    private riskManager: RiskManager;
    private orderBookState: Map<string, Ticker> = new Map();
    private isExecutingCycle: boolean = false;
    private currentCapital: Decimal;

    constructor(exchange: IExchangeProvider, riskManager: RiskManager, initialCapital: string) {
        super();
        this.exchange = exchange;
        this.riskManager = riskManager;
        this.currentCapital = new Decimal(initialCapital);

        this.initializeFeed();
    }

    public getCurrentCapital(): Decimal {
        return this.currentCapital;
    }

    private initializeFeed() {
        this.exchange.on('ticker', (ticker: Ticker) => {
            this.orderBookState.set(ticker.symbol, ticker);
            this.evaluateInefficiency();
        });
        log.info('Triangular Arbitrage Engine inicializado.', { capitalBase: this.currentCapital.toString() });
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
        log.info('Ineficiência matemática detectada — iniciando ciclo.', { projectedNetProfit: projectedProfit.toFixed(6) });
        const startTime = Date.now();

        let leg1: ExecutionResult | undefined;
        let leg2: ExecutionResult | undefined;

        try {
            // Perna 1: Comprar BTC com todo o capital disponível em USDT.
            const btcQtyToRequest = this.currentCapital.dividedBy(p1Ask);
            leg1 = await this.exchange.executeOrder('BTC/USDT', 'BUY', 'MARKET', btcQtyToRequest, p1Ask);

            // Perna 2: Comprar ETH com todo o BTC líquido recebido na perna 1.
            const ethQtyToRequest = leg1.netProceeds.dividedBy(p2Ask);
            leg2 = await this.exchange.executeOrder('ETH/BTC', 'BUY', 'MARKET', ethQtyToRequest, p2Ask);

            // Perna 3: Vender todo o ETH líquido recebido na perna 2 de volta para USDT.
            const leg3 = await this.exchange.executeOrder('ETH/USDT', 'SELL', 'MARKET', leg2.netProceeds, p3Bid);

            // leg3.netProceeds já é o USDT líquido final — o provider aplicou
            // a taxa real de cada perna, nada a descontar aqui de novo.
            const finalCapital = leg3.netProceeds;
            const actualProfit = finalCapital.minus(this.currentCapital);
            this.currentCapital = finalCapital;

            log.info('Arbitragem concluída com sucesso.', {
                executionTimeMs: Date.now() - startTime,
                capital: this.currentCapital.toFixed(6),
                profit: actualProfit.toFixed(6),
            });
            this.emit('cycle-success', { profit: actualProfit, capital: this.currentCapital });
        } catch (error) {
            log.error('Falha na execução do ciclo — risco de exposição direcional. Iniciando unwind de emergência.', {
                error: error instanceof Error ? error.message : String(error),
            });
            await this.emergencyUnwind(leg1, leg2, p1Ask, p3Bid, error);
        } finally {
            this.isExecutingCycle = false;
        }
    }

    /**
     * Neutraliza a exposição direcional deixada por um ciclo que falhou no
     * meio do caminho: se a perna 2 (ETH) já preencheu, vende o ETH residual
     * a mercado por USDT; senão, se apenas a perna 1 (BTC) preencheu, vende
     * o BTC residual a mercado por USDT. Se o próprio unwind falhar, emite
     * 'critical-exposure' para o chamador tratar como incidente — não há
     * mais nada que o engine possa fazer sozinho.
     */
    private async emergencyUnwind(leg1: ExecutionResult | undefined, leg2: ExecutionResult | undefined, p1Ask: Decimal, p3Bid: Decimal, originalError: unknown) {
        try {
            if (leg2) {
                const unwind = await this.exchange.executeOrder('ETH/USDT', 'SELL', 'MARKET', leg2.netProceeds, p3Bid);
                this.currentCapital = unwind.netProceeds;
                log.warn('Unwind concluído: ETH residual vendido a mercado.', { capitalAposUnwind: this.currentCapital.toFixed(6) });
                this.emit('cycle-failure', { error: originalError, unwound: true });
                return;
            }
            if (leg1) {
                const unwind = await this.exchange.executeOrder('BTC/USDT', 'SELL', 'MARKET', leg1.netProceeds, p1Ask);
                this.currentCapital = unwind.netProceeds;
                log.warn('Unwind concluído: BTC residual vendido a mercado.', { capitalAposUnwind: this.currentCapital.toFixed(6) });
                this.emit('cycle-failure', { error: originalError, unwound: true });
                return;
            }
            // Falhou antes de qualquer perna preencher: nenhuma posição para neutralizar.
            this.emit('cycle-failure', { error: originalError, unwound: false });
        } catch (unwindError) {
            log.error('FALHA NO UNWIND DE EMERGÊNCIA — exposição direcional NÃO neutralizada. Intervenção manual necessária.', {
                unwindError: unwindError instanceof Error ? unwindError.message : String(unwindError),
            });
            this.emit('critical-exposure', { leg1, leg2, error: unwindError });
        }
    }
}
