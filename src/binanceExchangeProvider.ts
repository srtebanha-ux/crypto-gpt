// Arquivo: src/binanceExchangeProvider.ts
//
// Conector real de mercado/execução para a Binance (Spot):
//   - Descoberta dinâmica de TODOS os triângulos USDT->base->alt->USDT
//     realmente listados na Binance (via REST /api/v3/exchangeInfo), usando
//     o mesmo mecanismo do opportunitySniffer.ts (ver triangleTopology.ts) —
//     em vez de um único triângulo fixo hardcoded.
//   - Dados de book em tempo real via WebSocket: `<symbol>@bookTicker` (topo
//     do book, dispara o kill switch determinístico/estatístico) e
//     `<symbol>@depth5@100ms` (5 níveis de profundidade, mantidos em
//     memória e usados pelo kill switch de confirmação por VWAP — ver
//     getOrderBookSnapshot / RiskManager.isTriangularArbitrageViableWithDepth).
//     Ambos no mesmo combined stream (necessário: o payload cru de
//     `@depth5` não inclui o símbolo — só o wrapper `{stream, data}` do
//     combined stream permite saber a qual símbolo cada mensagem pertence),
//     com reconexão automática e backoff exponencial.
//   - Execução de ordens via REST assinada (HMAC-SHA256), respeitando os
//     filtros LOT_SIZE/MIN_NOTIONAL reais de cada par antes de enviar.
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
import { ExecutionResult, IExchangeProvider, OrderBookLevel, OrderBookSnapshot, OrderSide, OrderType, Ticker, Triangle } from './types';
import { buildEnginePairTriangles } from './triangleTopology';

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

// Bases intermediárias padrão para a descoberta de triângulos — mesmo
// padrão do opportunitySniffer.ts (ver SNIFFER_BASES), configurável via
// BinanceExchangeProviderOptions.intermediateBases (ver TRIANGLE_BASES em
// src/live.ts).
const DEFAULT_INTERMEDIATE_BASES = ['BTC', 'ETH', 'BNB', 'FDUSD'];
// Limite documentado da Binance para o número de streams numa única conexão
// combined-stream — só relevante se INTERMEDIATE_BASES for configurado de
// forma extremamente ampla (o padrão gera dezenas de streams, não centenas).
const MAX_WS_STREAMS_PER_CONNECTION = 1024;

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
    /**
     * Ative quando a conta tiver "pagar taxas com BNB" ligado na Binance.
     *
     * Por que isso precisa ser explícito: `/sapi/v1/asset/tradeFee` devolve a
     * comissão BASE do símbolo — ele NÃO reflete o abatimento de BNB, que a
     * Binance aplica só no momento da execução. Sem esta flag o motor calcula
     * com 0,1% enquanto a conta paga 0,075%, ficando 25% mais conservador que
     * a realidade e recusando ciclos que de fato dariam lucro.
     *
     * O desconto só é aplicado se houver BNB de verdade em saldo (ver
     * MIN_BNB_BALANCE_FOR_DISCOUNT): sem BNB a Binance cobra a taxa cheia no
     * ativo negociado, e assumir o desconto deixaria a matemática otimista —
     * o motor aceitaria ciclos marginais que perdem dinheiro.
     */
    bnbFeeDiscount?: boolean;
    /** Saldo mínimo de BNB (em BNB) para considerar o desconto ativo. Padrão "0.001". */
    minBnbBalanceForDiscount?: string;
    /**
     * Bases intermediárias usadas para descobrir dinamicamente todos os
     * triângulos USDT->base->alt->USDT realmente listados na Binance (ver
     * triangleTopology.ts). Padrão: BTC, ETH, BNB, FDUSD — mesmo padrão do
     * opportunitySniffer.ts.
     */
    intermediateBases?: string[];
}

/** Abatimento de 25% que a Binance dá no Spot quando as taxas são pagas em BNB. */
const BNB_FEE_DISCOUNT_MULTIPLIER = '0.75';

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
    private readonly intermediateBases: string[];

    /** Taxa efetivamente usada pelo motor (já com desconto de BNB, se aplicável). */
    private feeRate: Decimal;
    /** Taxa base do símbolo, SEM desconto — origem para recalcular o desconto a cada refresh. */
    private baseFeeRate: Decimal;
    private readonly bnbFeeDiscount: boolean;
    private readonly minBnbBalanceForDiscount: Decimal;
    private serverTimeOffsetMs = 0;
    private symbolFilters = new Map<string, SymbolFilters>();
    /** Profundidade mais recente por par interno ("BTC/USDT"), atualizada pelo stream @depth5. */
    private depthState = new Map<string, OrderBookSnapshot>();
    /** Triângulos reais descobertos na última chamada de connect() — ver getDiscoveredTriangles(). */
    private discoveredTriangles: Triangle[] = [];
    /** Mapeamento dinâmico par interno <-> símbolo nativo Binance, construído a partir dos triângulos descobertos. */
    private pairToBinanceSymbol = new Map<string, string>();
    private binanceSymbolToPair = new Map<string, string>();

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
        this.baseFeeRate = new Decimal(options.fallbackFeeRate ?? '0.001');
        this.feeRate = this.baseFeeRate;
        this.bnbFeeDiscount = options.bnbFeeDiscount ?? false;
        this.minBnbBalanceForDiscount = new Decimal(options.minBnbBalanceForDiscount ?? '0.001');
        this.intermediateBases = options.intermediateBases ?? DEFAULT_INTERMEDIATE_BASES;

        // A Binance separa REST e WebSocket em subdomínios diferentes em
        // produção (api.binance.com vs stream.binance.com) — o testnet
        // segue a MESMA convenção (testnet.binance.vision vs
        // stream.testnet.binance.vision), não o mesmo host pros dois. Usar
        // testnet.binance.vision pro WebSocket (sem o subdomínio `stream.`)
        // resulta em 404 no handshake — não existe handler em `/stream`
        // nesse host, só no de streaming.
        this.restBaseUrl = options.live ? 'https://api.binance.com' : 'https://testnet.binance.vision';
        this.wsBaseUrl = options.live ? 'wss://stream.binance.com:9443' : 'wss://stream.testnet.binance.vision';
    }

    /** Sincroniza relógio, descobre a topologia real de triângulos + filtros de símbolo/fee e abre o WebSocket. Chamar antes de operar. */
    public async connect(): Promise<void> {
        await withRetry('Sincronização de horário', () => this.syncServerTime());
        await withRetry('Descoberta de triângulos e filtros de símbolo', () => this.discoverTrianglesAndFilters());
        await this.loadTradingFee(); // best-effort, não bloqueia o startup
        this.openWebSocket();
    }

    public shutdown(): void {
        this.isShuttingDown = true;
        this.ws?.close();
    }

    /** Triângulos USDT->base->alt->USDT reais descobertos na Binance na última chamada de connect(). */
    public getDiscoveredTriangles(): Triangle[] {
        return this.discoveredTriangles;
    }

    // ------------------------------------------------------------------
    // WebSocket: feed de book em tempo real
    // ------------------------------------------------------------------
    private openWebSocket(): void {
        const streams = Array.from(this.binanceSymbolToPair.keys()).flatMap((symbol) => [
            `${symbol.toLowerCase()}@bookTicker`,
            `${symbol.toLowerCase()}@depth5@100ms`,
        ]);
        if (streams.length > MAX_WS_STREAMS_PER_CONNECTION) {
            log.warn(
                `Número de streams (${streams.length}) excede o limite documentado de ${MAX_WS_STREAMS_PER_CONNECTION} por conexão combined-stream da Binance — considere reduzir intermediateBases/TRIANGLE_BASES.`
            );
        }
        const url = `${this.wsBaseUrl}/stream?streams=${streams.join('/')}`;
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
        const pair = this.binanceSymbolToPair.get(data.s);
        if (!pair) return;

        const ticker: Ticker = {
            symbol: pair,
            bid: new Decimal(data.b),
            ask: new Decimal(data.a),
            // O stream bookTicker não traz timestamp de evento; usamos o
            // horário de recebimento local, que é o que o kill switch de
            // obsolescência do engine (evaluateTriangle) espera.
            timestamp: Date.now(),
        };
        this.emit('ticker', ticker);
    }

    private handleDepthUpdate(streamName: string, data: { bids?: unknown; asks?: unknown }): void {
        const binanceSymbol = streamName.split('@')[0]?.toUpperCase();
        const pair = binanceSymbol ? this.binanceSymbolToPair.get(binanceSymbol) : undefined;
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

    /**
     * Busca o exchangeInfo COMPLETO (não dá pra filtrar por símbolo antes de
     * saber quais símbolos existem — mesma abordagem do
     * opportunitySniffer.ts) e descobre, a partir dos pares realmente
     * listados e em TRADING, todos os triângulos USDT->base->alt->USDT
     * operáveis (ver triangleTopology.ts). Constrói dinamicamente os mapas
     * par<->símbolo nativo e os filtros LOT_SIZE/MIN_NOTIONAL reais de cada
     * símbolo envolvido — nada disso fica mais hardcoded para 3 pares fixos.
     */
    private async discoverTrianglesAndFilters(): Promise<void> {
        const res = await fetch(`${this.restBaseUrl}/api/v3/exchangeInfo`);
        if (!res.ok) throw new Error(`Falha ao carregar exchangeInfo: HTTP ${res.status}`);
        const json = (await res.json()) as {
            symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string; filters: Array<Record<string, string>> }>;
        };
        const activeSymbols = (json.symbols ?? []).filter((s) => s.status === 'TRADING');

        this.discoveredTriangles = buildEnginePairTriangles(
            activeSymbols.map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset })),
            this.intermediateBases
        );
        if (this.discoveredTriangles.length === 0) {
            throw new Error(
                `Nenhum triângulo USDT->base->alt->USDT real encontrado para as bases intermediárias configuradas (${this.intermediateBases.join(',')}).`
            );
        }

        const infoBySymbol = new Map(activeSymbols.map((s) => [s.symbol, s]));
        this.pairToBinanceSymbol = new Map();
        this.binanceSymbolToPair = new Map();
        this.symbolFilters = new Map();

        for (const t of this.discoveredTriangles) {
            for (const pair of [t.leg1, t.leg2, t.leg3]) {
                if (this.pairToBinanceSymbol.has(pair)) continue; // símbolo compartilhado por mais de um triângulo
                const [base, quote] = pair.split('/');
                const rawSymbol = `${base}${quote}`;
                this.pairToBinanceSymbol.set(pair, rawSymbol);
                this.binanceSymbolToPair.set(rawSymbol, pair);

                const info = infoBySymbol.get(rawSymbol);
                const lotSize = info?.filters.find((f) => f.filterType === 'LOT_SIZE');
                const notionalFilter = info?.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
                this.symbolFilters.set(rawSymbol, {
                    stepSize: new Decimal(lotSize?.stepSize ?? '0.00000001'),
                    minQty: new Decimal(lotSize?.minQty ?? '0'),
                    minNotional: new Decimal(notionalFilter?.minNotional ?? notionalFilter?.notional ?? '0'),
                });
            }
        }

        log.info('Topologia real de triângulos descoberta na Binance.', {
            triangulosOperaveis: this.discoveredTriangles.length,
            simbolosUnicos: this.pairToBinanceSymbol.size,
            basesIntermediarias: this.intermediateBases.join(','),
        });
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
            if (btcUsdtFee) this.baseFeeRate = new Decimal(btcUsdtFee.takerCommission);
        } catch (err) {
            log.warn('Não foi possível carregar a taxa taker real; usando fallback.', {
                fallback: this.baseFeeRate.toString(),
                error: err instanceof Error ? err.message : String(err),
            });
        }
        await this.applyBnbDiscountIfFunded();
    }

    /**
     * Recalcula a taxa efetiva a partir da taxa base, aplicando o abatimento de
     * BNB apenas se a conta realmente tiver BNB para queimar.
     *
     * Precisa ser reavaliado periodicamente (o live.ts chama isto no heartbeat):
     * se o BNB acabar no meio da operação, a Binance volta a cobrar a taxa cheia,
     * e continuar calculando com 0,075% faria o motor aceitar ciclos marginais
     * que na verdade perdem dinheiro.
     */
    public async applyBnbDiscountIfFunded(): Promise<void> {
        if (!this.bnbFeeDiscount) {
            this.feeRate = this.baseFeeRate;
            return;
        }
        let bnbBalance: Decimal;
        try {
            bnbBalance = await this.fetchAvailableBalance('BNB');
        } catch (err) {
            // Não dá pra confirmar o saldo => assume o pior caso (taxa cheia).
            this.feeRate = this.baseFeeRate;
            log.warn('Não foi possível confirmar o saldo de BNB; usando a taxa CHEIA por segurança.', {
                taxaEfetiva: this.feeRate.toString(),
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        if (bnbBalance.lt(this.minBnbBalanceForDiscount)) {
            const wasDiscounted = !this.feeRate.eq(this.baseFeeRate);
            this.feeRate = this.baseFeeRate;
            log.warn('BNB_FEE_DISCOUNT está ligado, mas o saldo de BNB é insuficiente — usando a taxa CHEIA.', {
                saldoBnb: bnbBalance.toString(),
                minimoExigido: this.minBnbBalanceForDiscount.toString(),
                taxaEfetiva: this.feeRate.toString(),
                aviso: wasDiscounted
                    ? 'O BNB acabou durante a operação; a taxa voltou ao valor cheio.'
                    : 'Compre BNB no Spot e ligue "pagar taxas com BNB" na Binance para o desconto valer.',
            });
            return;
        }
        this.feeRate = this.baseFeeRate.mul(BNB_FEE_DISCOUNT_MULTIPLIER);
        log.info('Desconto de BNB aplicado à taxa taker usada pelo motor.', {
            taxaBase: this.baseFeeRate.toString(),
            taxaEfetiva: this.feeRate.toString(),
            saldoBnb: bnbBalance.toString(),
        });
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
        const symbol = this.pairToBinanceSymbol.get(pairSymbol);
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
            // FOK (Fill-Or-Kill): preenche a quantidade INTEIRA imediatamente
            // ao preço informado (ou melhor) ou cancela por completo — nunca
            // fill parcial. Usado pelo engine nas 3 pernas de ENTRADA do
            // ciclo (ver executeArbitrageCycle): se o preço já se moveu
            // contra o esperado entre a decisão e o envio, a ordem
            // simplesmente não preenche (falha limpa, sem exposição) em vez
            // de preencher a mercado a um preço pior que o que justificou o
            // disparo. As pernas de UNWIND continuam MARKET de propósito —
            // ver o comentário em engine.ts.emergencyUnwind.
            params.timeInForce = 'FOK';
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
