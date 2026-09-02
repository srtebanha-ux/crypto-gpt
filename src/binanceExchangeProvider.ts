// Arquivo: src/binanceExchangeProvider.ts
//
// Conector real de mercado/execução para a Binance (Spot):
//   - Dados de book em tempo real via WebSocket: `<symbol>@bookTicker` (topo
//     do book, dispara o kill switch determinístico/estatístico) e
//     `<symbol>@depth5@100ms` (5 níveis de profundidade, mantidos em
//     memória e usados pelo kill switch de confirmação por VWAP — ver
//     getOrderBookSnapshot / RiskManager.isTriangularArbitrageViableWithDepth).
//     Ambos no mesmo combined stream, com reconexão automática e backoff
//     exponencial.
//   - Execução de ordens via REST assinada (HMAC-SHA256), respeitando os
//     filtros LOT_SIZE/MIN_NOTIONAL do par antes de enviar.
//   - Contabilidade de taxa fiel à Binance: a taxa é debitada do ativo que
//     você RECEBE na perna (base para BUY, cotação para SELL), então
//     `netProceeds` já vem líquido — ver a nota em `types.ts`.
//
// Por padrão aponta para o Spot Testnet (https://testnet.binance.vision) —
// nenhuma ordem real é enviada a menos que `live: true` seja passado
// explicitamente nas options (ver src/live.ts para o gate de segurança).
import { Decimal } from 'decimal.js';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createLogger } from './logger';
import { ExecutionResult, IExchangeProvider, OrderBookLevel, OrderBookSnapshot, OrderSide, OrderType, Ticker } from './types';

const log = createLogger('binance');

/**
 * Converte os pares [preço, quantidade] crus de um payload de profundidade
 * da Binance em `OrderBookLevel[]`, descartando entradas malformadas e
 * níveis com quantidade zero (nos streams de diff isso sinaliza remoção do
 * nível; num snapshot como `depth5` não deveria aparecer, mas filtrar é
 * defensivo e barato). Exportada para ser testada isoladamente, sem WS.
 */
export function parseDepthLevels(raw: unknown): OrderBookLevel[] {
    if (!Array.isArray(raw)) return [];
    const levels: OrderBookLevel[] = [];
    for (const entry of raw) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        let price: Decimal;
        let qty: Decimal;
        try {
            price = new Decimal(entry[0]);
            qty = new Decimal(entry[1]);
        } catch {
            continue; // preço/qty não numérico — payload malformado, descarta só este nível
        }
        if (price.lessThanOrEqualTo(0) || qty.lessThanOrEqualTo(0)) continue;
        levels.push({ price, qty });
    }
    return levels;
}

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
const STARTUP_RETRY_ATTEMPTS = 3;
const STARTUP_RETRY_BASE_DELAY_MS = 500;

/**
 * Repete uma chamada GET idempotente com backoff exponencial. NUNCA usar
 * para `executeOrder`: uma ordem MARKET pode já ter sido preenchida do lado
 * da corretora mesmo que a resposta HTTP falhe, e reenviá-la cegamente
 * arrisca duplicar a execução.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < STARTUP_RETRY_ATTEMPTS) {
                const delayMs = STARTUP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
                log.warn(`${label} falhou (tentativa ${attempt}/${STARTUP_RETRY_ATTEMPTS}), retentando em ${delayMs}ms.`, {
                    error: err instanceof Error ? err.message : String(err),
                });
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError;
}

export class BinanceExchangeProvider extends EventEmitter implements IExchangeProvider {
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly restBaseUrl: string;
    private readonly wsBaseUrl: string;
    private readonly recvWindowMs: number;

    private feeRate: Decimal;
    private serverTimeOffsetMs = 0;
    private symbolFilters = new Map<string, SymbolFilters>();
    /** Profundidade mais recente por par interno ("BTC/USDT"), atualizada pelo stream @depth5. */
    private depthState = new Map<string, OrderBookSnapshot>();

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
        await withRetry('Sincronização de horário', () => this.syncServerTime());
        await withRetry('Carga de exchangeInfo', () => this.loadExchangeFilters());
        await this.loadTradingFee(); // best-effort, não bloqueia o startup
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
            .flatMap((symbol) => [`${symbol.toLowerCase()}@bookTicker`, `${symbol.toLowerCase()}@depth5@100ms`])
            .join('/');
        const url = `${this.wsBaseUrl}/stream?streams=${streams}`;
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            this.reconnectAttempts = 0;
            log.info('Conectado ao feed de book/profundidade da Binance.', { url: this.wsBaseUrl });
        });

        this.ws.on('message', (raw: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(raw.toString());
                const streamName: string | undefined = payload.stream; // combined stream envelopa em {stream, data}
                const data = payload.data ?? payload;
                if (streamName?.includes('@depth')) {
                    this.handleDepthUpdate(streamName, data);
                } else {
                    this.handleBookTicker(data);
                }
            } catch (err) {
                log.error('Falha ao parsear mensagem do book.', { error: err instanceof Error ? err.message : String(err) });
            }
        });

        this.ws.on('error', (err: Error) => {
            log.error('Erro de conexão WebSocket.', { error: err.message });
        });

        this.ws.on('close', (code: number) => {
            if (this.isShuttingDown) return;
            log.warn('Conexão WebSocket encerrada. Agendando reconexão...', { code });
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

    private handleDepthUpdate(streamName: string, data: { bids?: unknown; asks?: unknown }): void {
        const binanceSymbol = streamName.split('@')[0]?.toUpperCase();
        const pair = binanceSymbol ? BINANCE_SYMBOL_TO_PAIR[binanceSymbol] : undefined;
        if (!pair) return;

        this.depthState.set(pair, {
            bids: parseDepthLevels(data.bids),
            asks: parseDepthLevels(data.asks),
            timestamp: Date.now(),
        });
    }

    /**
     * Profundidade mais recente conhecida para um par ("BTC/USDT"), mantida
     * em memória a partir do stream `@depth5` — nunca via chamada de rede
     * síncrona (isso violaria o orçamento de latência de HFT). `undefined`
     * antes da primeira mensagem de profundidade chegar para esse símbolo.
     */
    public getOrderBookSnapshot(symbol: string): OrderBookSnapshot | undefined {
        return this.depthState.get(symbol);
    }

    // ------------------------------------------------------------------
    // REST: metadados de exchange (filtros de quantidade, taxa, saldo)
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
            log.warn('Não foi possível carregar a taxa taker real; usando fallback.', {
                fallback: this.feeRate.toString(),
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    public getFeeRate(): Decimal {
        return this.feeRate;
    }

    /** Saldo disponível (livre, não travado em ordens) de um ativo na conta Spot. */
    public async fetchAvailableBalance(asset: string): Promise<Decimal> {
        const query = this.signParams({ timestamp: this.serverTimestamp() });
        const res = await fetch(`${this.restBaseUrl}/api/v3/account?${query}`, {
            headers: { 'X-MBX-APIKEY': this.apiKey },
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Falha ao consultar saldo da conta: HTTP ${res.status} — ${body}`);
        }
        const account = (await res.json()) as { balances: Array<{ asset: string; free: string }> };
        const balance = account.balances.find((b) => b.asset === asset);
        return new Decimal(balance?.free ?? '0');
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
        if (filters && price) {
            const estimatedNotional = roundedQty.mul(price);
            if (estimatedNotional.lessThan(filters.minNotional)) {
                throw new Error(
                    `Notional estimado ${estimatedNotional.toString()} abaixo do minNotional (${filters.minNotional.toString()}) para ${symbol}.`
                );
            }
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
            fills?: Array<{ commission?: string; commissionAsset?: string }>;
            msg?: string;
            code?: number;
        };

        if (!res.ok) {
            throw new Error(`Ordem rejeitada pela Binance (${symbol} ${side}): ${body.msg ?? res.statusText} (code ${body.code ?? res.status})`);
        }

        const executedQty = new Decimal(body.executedQty ?? '0');
        const cumulativeQuoteQty = new Decimal(body.cummulativeQuoteQty ?? '0');
        const executedPrice = executedQty.isZero() ? new Decimal(price ?? '0') : cumulativeQuoteQty.dividedBy(executedQty);

        // A Binance cobra a taxa no ativo que você RECEBE na perna: base
        // asset para BUY, quote asset para SELL (exceto quando o desconto em
        // BNB está ativo, caso em que commissionAsset === 'BNB' e não deve
        // ser subtraído do que você recebeu no par negociado).
        const [baseAsset, quoteAsset] = pairSymbol.split('/');
        const receivedAsset = side === 'BUY' ? baseAsset : quoteAsset;
        const grossReceived = side === 'BUY' ? executedQty : cumulativeQuoteQty;

        let commissionInReceivedAsset = new Decimal(0);
        let totalFeePaid = new Decimal(0);
        let feePaidAsset = receivedAsset;
        for (const fill of body.fills ?? []) {
            const commission = new Decimal(fill.commission ?? '0');
            totalFeePaid = totalFeePaid.plus(commission);
            if (fill.commissionAsset === receivedAsset) {
                commissionInReceivedAsset = commissionInReceivedAsset.plus(commission);
            } else if (fill.commissionAsset) {
                feePaidAsset = fill.commissionAsset;
            }
        }
        const netProceeds = grossReceived.minus(commissionInReceivedAsset);

        const status: ExecutionResult['status'] =
            body.status === 'FILLED' ? 'FILLED' : body.status === 'EXPIRED' || body.status === 'CANCELED' ? 'REJECTED' : 'FAILED';

        if (status !== 'FILLED') {
            throw new Error(`Ordem não preenchida (${symbol} ${side}): status=${body.status}`);
        }

        return {
            orderId: String(body.orderId ?? crypto.randomUUID()),
            status,
            executedPrice,
            executedQty,
            netProceeds,
            feePaid: totalFeePaid,
            feePaidAsset,
            timestamp: body.transactTime ?? Date.now(),
        };
    }
}
