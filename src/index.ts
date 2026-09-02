// Arquivo: src/index.ts
//
// HFT Triangular Arbitrage Engine — núcleo de execução delta-neutral com
// precisão aritmética arbitrária (decimal.js) e kill switches defensivos.
// Ver README.md para o racional de arquitetura (Modelos 1-3) e projeções.
import { Decimal } from 'decimal.js';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// [1] CONFIGURAÇÃO GLOBAL E TIPAGEM ESTRITA
// ============================================================================
Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

type Ticker = {
    symbol: string;
    bid: Decimal;
    ask: Decimal;
    timestamp: number;
};

type OrderType = 'LIMIT' | 'MARKET';
type OrderSide = 'BUY' | 'SELL';

interface ExecutionResult {
    orderId: string;
    status: 'FILLED' | 'REJECTED' | 'FAILED';
    executedPrice: Decimal;
    executedQty: Decimal;
    feePaid: Decimal;
    timestamp: number;
}

// ============================================================================
// [2] MOCK: EXCHANGE PROVIDER (Interface de I/O Não-Bloqueante)
// ============================================================================
class ExchangeProvider extends EventEmitter {
    private readonly LATENCY_MS = 12; // Simulação de latência de rede colocalizada
    private feeRate = new Decimal('0.001'); // 0.1% Taker fee

    constructor() {
        super();
        this.simulateWebSocketFeed();
    }

    private simulateWebSocketFeed() {
        setInterval(() => {
            const now = Date.now();
            // Simulando distorção sintética onde A->B->C gera lucro líquido
            this.emit('ticker', { symbol: 'BTC/USDT', bid: new Decimal('60000'), ask: new Decimal('60010'), timestamp: now });
            this.emit('ticker', { symbol: 'ETH/BTC', bid: new Decimal('0.0500'), ask: new Decimal('0.0501'), timestamp: now });
            // Distorção proposital no ETH/USDT: eleva P3 acima do threshold de
            // viabilidade (P3 / (P1*P2) * (1-f)^3 > 1 + slippage), disparando a execução.
            this.emit('ticker', { symbol: 'ETH/USDT', bid: new Decimal('3050'), ask: new Decimal('3060'), timestamp: now });
        }, 50); // 50ms tick rate
    }

    public async executeOrder(symbol: string, side: OrderSide, type: OrderType, qty: Decimal, price?: Decimal): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            setTimeout(() => {
                const fillPrice = price || new Decimal('0'); // Fallback simplificado
                resolve({
                    orderId: crypto.randomUUID(),
                    status: 'FILLED',
                    executedPrice: fillPrice,
                    executedQty: qty,
                    feePaid: qty.mul(fillPrice).mul(this.feeRate),
                    timestamp: Date.now()
                });
            }, this.LATENCY_MS);
        });
    }

    public getFeeRate(): Decimal {
        return this.feeRate;
    }
}

// ============================================================================
// [3] RISK MANAGER (Kill Switch e Validação de Estado)
// ============================================================================
class RiskManager {
    private maxCapitalAllocated: Decimal;
    private maxSlippageTolerance: Decimal;

    constructor(capital: string, slippageTolerance: string) {
        this.maxCapitalAllocated = new Decimal(capital);
        this.maxSlippageTolerance = new Decimal(slippageTolerance);
    }

    public isTriangularArbitrageViable(
        initialCapital: Decimal,
        p1Ask: Decimal,
        p2Ask: Decimal,
        p3Bid: Decimal,
        feeRate: Decimal
    ): { viable: boolean; expectedNetProfit: Decimal } {
        if (initialCapital.greaterThan(this.maxCapitalAllocated)) {
            return { viable: false, expectedNetProfit: new Decimal(0) };
        }

        // Fator de retenção por perna = (1 - fee)
        const retentionRate = new Decimal(1).minus(feeRate);
        const retentionCubed = retentionRate.pow(3);

        // Q1 (USDT -> BTC) = (C0 / Ask1)
        const q1 = initialCapital.dividedBy(p1Ask);
        // Q2 (BTC -> ETH) = (Q1 / Ask2)
        const q2 = q1.dividedBy(p2Ask);
        // Q3 (ETH -> USDT) = (Q2 * Bid3)
        const grossReturn = q2.mul(p3Bid);

        const netReturn = grossReturn.mul(retentionCubed);
        const expectedNetProfit = netReturn.minus(initialCapital);

        // Kill Switch Inequality: Net Return > Capital + Slippage Margin
        const minAcceptableReturn = initialCapital.mul(new Decimal(1).plus(this.maxSlippageTolerance));
        const isViable = netReturn.greaterThan(minAcceptableReturn);

        return { viable: isViable, expectedNetProfit };
    }
}

// ============================================================================
// [4] CORE ENGINE: TRIANGULAR ARBITRAGE HFT
// ============================================================================
class TriangularArbitrageEngine {
    private exchange: ExchangeProvider;
    private riskManager: RiskManager;
    private orderBookState: Map<string, Ticker> = new Map();
    private isExecutingCycle: boolean = false;
    private currentCapital: Decimal;

    constructor(exchange: ExchangeProvider, riskManager: RiskManager, initialCapital: string) {
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

// ============================================================================
// [5] ORQUESTRAÇÃO DE BOOTSTRAP (ENTRY POINT)
// ============================================================================
function bootstrap() {
    console.log('[SYS] APEX-ZERO: HFT Triangular Arbitrage Engine Booting...');

    // Capital de $50, tolerância de slippage rigorosa (0.0005 = 0.05%)
    const C0_BASE = '50.00';
    const MAX_SLIPPAGE = '0.0005';

    const exchange = new ExchangeProvider();
    const riskManager = new RiskManager(C0_BASE, MAX_SLIPPAGE);

    // Instanciação e operação perpétua em memória
    new TriangularArbitrageEngine(exchange, riskManager, C0_BASE);
}

bootstrap();
