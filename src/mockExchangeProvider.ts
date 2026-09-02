// Arquivo: src/mockExchangeProvider.ts
import { Decimal } from 'decimal.js';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { ExecutionResult, IExchangeProvider, OrderSide, OrderType } from './types';

// ============================================================================
// MOCK: EXCHANGE PROVIDER (feed sintético, sem I/O de rede real)
// Usado apenas para demonstrar/testar o engine sem credenciais de corretora.
// ============================================================================
export class MockExchangeProvider extends EventEmitter implements IExchangeProvider {
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
