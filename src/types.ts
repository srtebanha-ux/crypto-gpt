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

/**
 * Um triângulo de arbitragem operável pelo engine, em formato de PAR interno
 * (ex.: "BTC/USDT") — não o formato de símbolo cru da Binance ("BTCUSDT")
 * usado por opportunitySniffer.ts/triangleTopology.ts para assinar streams
 * diretamente. `id` identifica o triângulo de forma estável (ex.:
 * "USDT-BTC-ETH"), usado pelo engine como chave do EwmaTracker dedicado a
 * cada triângulo — cada um mede sua própria linha de base, nunca uma
 * combinada entre triângulos diferentes.
 */
export interface Triangle {
    id: string;
    leg1: string; // USDT -> base, lado ASK (ex.: "BTC/USDT")
    leg2: string; // base -> alt, lado ASK (ex.: "ETH/BTC")
    leg3: string; // alt -> USDT, lado BID (ex.: "ETH/USDT")
}

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

/** Um nível de preço do order book (usado para estimativas de execução por VWAP). */
export interface OrderBookLevel {
    price: Decimal;
    qty: Decimal;
}

/** Snapshot da profundidade do book de um símbolo, do melhor para o pior preço. */
export interface OrderBookSnapshot {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
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
    /**
     * Profundidade atual do book para um símbolo, se este provider a mantiver
     * (opcional — mantido em memória a partir de um stream, nunca via chamada
     * de rede síncrona no caminho de execução). `undefined` quando o provider
     * não suporta profundidade ou ainda não recebeu dados para o símbolo; o
     * engine trata isso como "confirmação por profundidade indisponível" e,
     * conforme sua configuração, ou ignora essa camada extra do kill switch,
     * ou bloqueia o disparo até haver dado suficiente.
     */
    getOrderBookSnapshot?(symbol: string): OrderBookSnapshot | undefined;
}
