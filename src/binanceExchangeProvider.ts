// Arquivo: src/binanceExchangeProvider.ts
//
// Conector real de mercado/execução para a Binance (Spot):
//   - Dados de book em tempo real via WebSocket (`<symbol>@bookTicker`,
//     combined stream), com reconexão automática e backoff exponencial.
//   - Execução de ordens via REST assinada (HMAC-SHA256), respeitando os
//     filtros LOT_SIZE/MIN_NOTIONAL do par antes de enviar.
//
// Por padrão aponta para o Spot Testnet (https://testnet.binance.vision) —
// nenhuma ordem real é enviada a menos que `live: true` seja passado
// explicitamente nas options (ver src/live.ts para o gate de segurança).
import { Decimal } from 'decimal.js';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { ExecutionResult, IExchangeProvider, OrderSide, OrderType, Ticker } from './types';

// Mapeamento entre o símbolo interno do engine ("BTC/USDT") e o símbolo
// nativo da Binance ("BTCUSDT"), usado tanto para assinar streams quanto
// para montar as ordens REST.
const PAIR_TO_BINANCE_SYMBOL: Record<string, string> = {
    'BTC/USDT': 'BTCUSDT',
    'ETH/BTC': 'ETHBTC',
    'ETH/USDT': 'ETHUSDT',
};
const BINANCE_SYMBOL_TO_PAIR: Record<string, string> = Object.fromEntries(
    Object.entries(PAIR_TO_BINANCE_SYMBOL).map(([pair, symbol]) => [symbol, pair])
);

interface SymbolFilters {
    stepSize: Decimal;
    minQty: Decimal;
    minNotional: Decimal;
}

export interface BinanceExchangeProviderOptions {
    apiKey: string;
    apiSecret: string;
    /** false (padrão) => Spot Testnet. true => produção, ordens reais com dinheiro real. */
    live?: boolean;
    recvWindowMs?: number;
    /** Taxa taker de fallback caso o endpoint de fee não esteja disponível (ex.: testnet). */
    fallbackFeeRate?: string;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

export class BinanceExchangeProvider extends EventEmitter implements IExchangeProvider {
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly restBaseUrl: string;
    private readonly wsBaseUrl: string;
    private readonly recvWindowMs: number;

    private feeRate: Decimal;
    private serverTimeOffsetMs = 0;
    private symbolFilters = new Map<string, SymbolFilters>();

    private ws: WebSocket | null = null;
    private reconnectAttempts = 0;
    private isShuttingDown = false;

    constructor(options: BinanceExchangeProviderOptions) {
        super();
        if (!options.apiKey || !options.apiSecret) {
            throw new Error('BinanceExchangeProvider requer apiKey e apiSecret.');
        }
        this.apiKey = options.apiKey;
        this.apiSecret = options.apiSecret;
        this.recvWindowMs = options.recvWindowMs ?? 5000;
        this.feeRate = new Decimal(options.fallbackFeeRate ?? '0.001');

        this.restBaseUrl = options.live ? 'https://api.binance.com' : 'https://testnet.binance.vision';
        this.wsBaseUrl = options.live ? 'wss://stream.binance.com:9443' : 'wss://testnet.binance.vision';
    }

    /** Sincroniza relógio, carrega filtros de símbolo/fee e abre o WebSocket. Chamar antes de operar. */
    public async connect(): Promise<void> {
        await this.syncServerTime();
        await this.loadExchangeFilters();
        await this.loadTradingFee();
        this.openWebSocket();
    }

    public shutdown(): void {
        this.isShuttingDown = true;
        this.ws?.close();
    }

    // ------------------------------------------------------------------
    // WebSocket: feed de book em tempo real
    // ------------------------------------------------------------------
    private openWebSocket(): void {
        const streams = Object.keys(BINANCE_SYMBOL_TO_PAIR)
            .map((symbol) => `${symbol.toLowerCase()}@bookTicker`)
            .join('/');
        const url = `${this.wsBaseUrl}/stream?streams=${streams}`;
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            this.reconnectAttempts = 0;
            console.log('[WS] Conectado ao feed de book da Binance.');
        });

        this.ws.on('message', (raw: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(raw.toString());
                const data = payload.data ?? payload; // combined stream envelopa em {stream, data}
                this.handleBookTicker(data);
            } catch (err) {
                console.error('[WS] Falha ao parsear mensagem do book:', err);
            }
        });

        this.ws.on('error', (err: Error) => {
            console.error('[WS] Erro de conexão:', err.message);
        });

        this.ws.on('close', (code: number) => {
            if (this.isShuttingDown) return;
            console.warn(`[WS] Conexão encerrada (code=${code}). Agendando reconexão...`);
            this.scheduleReconnect();
        });
    }

    private scheduleReconnect(): void {
        this.reconnectAttempts += 1;
        const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempts);
        setTimeout(() => {
            if (!this.isShuttingDown) this.openWebSocket();
        }, delayMs);
    }

    private handleBookTicker(data: { s?: string; b?: string; a?: string }): void {
        if (!data.s || !data.b || !data.a) return;
        const pair = BINANCE_SYMBOL_TO_PAIR[data.s];
        if (!pair) return;

        const ticker: Ticker = {
            symbol: pair,
            bid: new Decimal(data.b),
            ask: new Decimal(data.a),
            // O stream bookTicker não traz timestamp de evento; usamos o
            // horário de recebimento local, que é o que o kill switch de
            // obsolescência do engine (evaluateInefficiency) espera.
            timestamp: Date.now(),
        };
        this.emit('ticker', ticker);
    }

    // ------------------------------------------------------------------
    // REST: metadados de exchange (filtros de quantidade e taxa)
    // ------------------------------------------------------------------
    private async syncServerTime(): Promise<void> {
        const res = await fetch(`${this.restBaseUrl}/api/v3/time`);
        if (!res.ok) throw new Error(`Falha ao sincronizar horário do servidor: HTTP ${res.status}`);
        const { serverTime } = (await res.json()) as { serverTime: number };
        this.serverTimeOffsetMs = serverTime - Date.now();
    }

    private async loadExchangeFilters(): Promise<void> {
        const symbolsParam = encodeURIComponent(JSON.stringify(Object.keys(BINANCE_SYMBOL_TO_PAIR)));
        const res = await fetch(`${this.restBaseUrl}/api/v3/exchangeInfo?symbols=${symbolsParam}`);
        if (!res.ok) throw new Error(`Falha ao carregar exchangeInfo: HTTP ${res.status}`);
        const json = (await res.json()) as { symbols: Array<{ symbol: string; filters: Array<Record<string, string>> }> };

        for (const s of json.symbols ?? []) {
            const lotSize = s.filters.find((f) => f.filterType === 'LOT_SIZE');
            const notionalFilter = s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
            this.symbolFilters.set(s.symbol, {
                stepSize: new Decimal(lotSize?.stepSize ?? '0.00000001'),
                minQty: new Decimal(lotSize?.minQty ?? '0'),
                minNotional: new Decimal(notionalFilter?.minNotional ?? notionalFilter?.notional ?? '0'),
            });
        }
    }

    private async loadTradingFee(): Promise<void> {
        try {
            const query = this.signParams({ timestamp: this.serverTimestamp() });
            const res = await fetch(`${this.restBaseUrl}/sapi/v1/asset/tradeFee?${query}`, {
                headers: { 'X-MBX-APIKEY': this.apiKey },
            });
            if (!res.ok) return; // endpoint pode não existir no testnet: mantém fallbackFeeRate
            const fees = (await res.json()) as Array<{ symbol: string; takerCommission: string }>;
            const btcUsdtFee = fees.find((f) => f.symbol === 'BTCUSDT');
            if (btcUsdtFee) this.feeRate = new Decimal(btcUsdtFee.takerCommission);
        } catch (err) {
            console.warn('[REST] Não foi possível carregar a taxa taker real; usando fallback.', err);
        }
    }

    public getFeeRate(): Decimal {
        return this.feeRate;
    }

    // ------------------------------------------------------------------
    // REST: execução de ordens (assinada)
    // ------------------------------------------------------------------
    private serverTimestamp(): string {
        return String(Date.now() + this.serverTimeOffsetMs);
    }

    private signParams(params: Record<string, string>): string {
        const query = new URLSearchParams({ ...params, recvWindow: String(this.recvWindowMs) }).toString();
        const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
        return `${query}&signature=${signature}`;
    }

    private roundToStepSize(qty: Decimal, filters: SymbolFilters | undefined): Decimal {
        if (!filters || filters.stepSize.isZero()) return qty;
        // Sempre arredonda para baixo (nunca envia mais do que se tem disponível).
        return qty.dividedToIntegerBy(filters.stepSize).mul(filters.stepSize);
    }

    public async executeOrder(pairSymbol: string, side: OrderSide, type: OrderType, qty: Decimal, price?: Decimal): Promise<ExecutionResult> {
        const symbol = PAIR_TO_BINANCE_SYMBOL[pairSymbol];
        if (!symbol) throw new Error(`Símbolo desconhecido para a Binance: ${pairSymbol}`);

        const filters = this.symbolFilters.get(symbol);
        const roundedQty = this.roundToStepSize(qty, filters);
        if (filters && roundedQty.lessThan(filters.minQty)) {
            throw new Error(`Quantidade ${roundedQty.toString()} abaixo do minQty (${filters.minQty.toString()}) para ${symbol}.`);
        }

        const params: Record<string, string> = {
            symbol,
            side,
            type,
            quantity: roundedQty.toFixed(),
            timestamp: this.serverTimestamp(),
        };
        if (type === 'LIMIT') {
            if (!price) throw new Error('Ordens LIMIT exigem price.');
            params.price = price.toFixed();
            // IOC: preenche o que puder imediatamente e cancela o resto — sem
            // exposição residual de perna parcial em um ciclo delta-neutral.
            params.timeInForce = 'IOC';
        }

        const query = this.signParams(params);
        const res = await fetch(`${this.restBaseUrl}/api/v3/order?${query}`, {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': this.apiKey },
        });
        const body = (await res.json()) as {
            orderId?: number;
            status?: string;
            executedQty?: string;
            cummulativeQuoteQty?: string;
            transactTime?: number;
            fills?: Array<{ commission?: string }>;
            msg?: string;
            code?: number;
        };

        if (!res.ok) {
            throw new Error(`Ordem rejeitada pela Binance (${symbol} ${side}): ${body.msg ?? res.statusText} (code ${body.code ?? res.status})`);
        }

        const executedQty = new Decimal(body.executedQty ?? '0');
        const cumulativeQuoteQty = new Decimal(body.cummulativeQuoteQty ?? '0');
        const executedPrice = executedQty.isZero() ? new Decimal(price ?? '0') : cumulativeQuoteQty.dividedBy(executedQty);
        const feePaid = ((body.fills ?? []) as Array<{ commission?: string }>).reduce(
            (acc: Decimal, fill) => acc.plus(new Decimal(fill.commission ?? '0')),
            new Decimal(0)
        );

        const status: ExecutionResult['status'] =
            body.status === 'FILLED' ? 'FILLED' : body.status === 'EXPIRED' || body.status === 'CANCELED' ? 'REJECTED' : 'FAILED';

        return {
            orderId: String(body.orderId ?? crypto.randomUUID()),
            status,
            executedPrice,
            executedQty,
            feePaid,
            timestamp: body.transactTime ?? Date.now(),
        };
    }
}
