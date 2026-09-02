// Arquivo: src/types.ts
//
// Tipos e contrato compartilhados entre o provider mock (demo) e o provider
// real da Binance, e usados pelo RiskManager / TriangularArbitrageEngine.
import { Decimal } from 'decimal.js';
import { EventEmitter } from 'events';

export type Ticker = {
    symbol: string;
    bid: Decimal;
    ask: Decimal;
    timestamp: number;
};

export type OrderType = 'LIMIT' | 'MARKET';
export type OrderSide = 'BUY' | 'SELL';

export interface ExecutionResult {
    orderId: string;
    status: 'FILLED' | 'REJECTED' | 'FAILED';
    executedPrice: Decimal;
    executedQty: Decimal;
    feePaid: Decimal;
    timestamp: number;
}

/**
 * Contrato que qualquer fonte de mercado/execução (mock ou corretora real)
 * deve implementar para ser consumida pelo TriangularArbitrageEngine.
 * Deve emitir eventos 'ticker' (payload: Ticker) para cada atualização de
 * book (bid/ask) recebida.
 */
export interface IExchangeProvider extends EventEmitter {
    executeOrder(symbol: string, side: OrderSide, type: OrderType, qty: Decimal, price?: Decimal): Promise<ExecutionResult>;
    getFeeRate(): Decimal;
}
