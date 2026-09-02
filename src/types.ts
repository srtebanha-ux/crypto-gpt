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
    /** Preço médio de execução. */
    executedPrice: Decimal;
    /** Quantidade BRUTA do ativo-base negociada (antes da taxa) — útil para log/auditoria. */
    executedQty: Decimal;
    /**
     * Quantidade LÍQUIDA (já descontada a taxa da corretora) do ativo que
     * fica disponível para a próxima perna do ciclo: para uma ordem BUY é o
     * ativo-base recebido líquido; para uma ordem SELL é o ativo-cotação
     * recebido líquido. É este campo — nunca `executedQty` — que deve ser
     * usado para dimensionar a próxima ordem, pois a taxa já foi aplicada
     * aqui pelo provider (que é quem realmente sabe o quanto foi cobrado).
     */
    netProceeds: Decimal;
    /** Taxa cobrada, na unidade de `feePaidAsset`. */
    feePaid: Decimal;
    /** Ativo em que a taxa foi efetivamente cobrada (ex.: "BTC", "USDT", ou "BNB" com desconto). */
    feePaidAsset: string;
    timestamp: number;
}

/**
 * Contrato que qualquer fonte de mercado/execução (mock ou corretora real)
 * deve implementar para ser consumida pelo TriangularArbitrageEngine.
 * Deve emitir eventos 'ticker' (payload: Ticker) para cada atualização de
 * book (bid/ask) recebida.
 *
 * IMPORTANTE: `executeOrder` nunca deve ser reenviada automaticamente por
 * quem a chama em caso de timeout/erro de rede — uma ordem MARKET pode já
 * ter sido preenchida do lado da corretora mesmo que a resposta HTTP falhe,
 * e reenviá-la cegamente arrisca duplicar a execução.
 */
export interface IExchangeProvider extends EventEmitter {
    executeOrder(symbol: string, side: OrderSide, type: OrderType, qty: Decimal, price?: Decimal): Promise<ExecutionResult>;
    getFeeRate(): Decimal;
}
