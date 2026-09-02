// Arquivo: src/opportunitySniffer.ts
//
// Ferramenta de MEDIÇÃO EMPÍRICA, não de execução: descobre dinamicamente
// todos os triângulos USDT→base→alt→USDT realmente listados na Binance
// (via REST /api/v3/exchangeInfo) e assina o book em tempo real de cada
// símbolo envolvido, registrando com que frequência e de que tamanho
// ineficiências líquidas de taxa realmente aparecem — em vez de assumir um
// número e calcular pra trás.
//
// Nenhuma ordem é enviada aqui. É só leitura de mercado + estatística.
//
// Precisa de acesso de rede real à Binance (não roda em sandboxes com
// egress restrito) — rode local (`npm run sniff`) ou como um segundo
// serviço no mesmo projeto Railway.
import { Decimal } from 'decimal.js';
import WebSocket from 'ws';
import { createLogger } from './logger';

const log = createLogger('sniffer');

const BINANCE_REST_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';
const SUBSCRIBE_BATCH_SIZE = 200; // limite de streams por conexão é 1024; batching evita payloads gigantes
const SUBSCRIBE_BATCH_DELAY_MS = 250; // espaçamento entre lotes — a Binance limita ~5 msgs de controle/s por conexão
const MAX_LEG_AGE_MS = 3000; // idade máxima aceita de CADA perna para uma avaliação contar como simultânea

const TAKER_FEE = new Decimal(process.env.SNIFFER_TAKER_FEE ?? '0.001');
const TARGET_NET_PROFIT = new Decimal(process.env.SNIFFER_TARGET_NET_PROFIT ?? '0.0002'); // 0.02% líquido
const INTERMEDIATE_BASES = (process.env.SNIFFER_BASES ?? 'BTC,ETH,BNB').split(',').map((s) => s.trim().toUpperCase());

// ============================================================================
// [1] FUNÇÕES PURAS (testadas isoladamente em opportunitySniffer.test.ts,
// sem rede) — mapeamento topológico e avaliação de triângulo.
// ============================================================================
export interface SymbolInfo {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
}

export interface Triangle {
    id: string;
    leg1: string; // USDT -> base (ex.: BTCUSDT), lado ASK
    leg2: string; // base -> alt (ex.: ETHBTC), lado ASK
    leg3: string; // alt -> USDT (ex.: ETHUSDT), lado BID
}

/**
 * Constrói o grafo de triângulos USDT→base→alt→USDT que são REALMENTE
 * negociáveis (os três lados existem como par listado), a partir da lista
 * real de símbolos da Binance — em vez de assumir uma contagem de
 * triângulos combinatorialmente possível mas não necessariamente listada.
 */
export function buildTriangles(symbols: SymbolInfo[], intermediateBases: string[]): Triangle[] {
    const symbolSet = new Set(symbols.map((s) => s.symbol));
    const triangles: Triangle[] = [];

    for (const base of intermediateBases) {
        const leg1 = `${base}USDT`;
        if (!symbolSet.has(leg1)) continue;

        for (const s of symbols) {
            if (s.quoteAsset !== base || s.baseAsset === 'USDT') continue;
            const altAsset = s.baseAsset;
            const leg3 = `${altAsset}USDT`;
            if (!symbolSet.has(leg3)) continue;

            triangles.push({ id: `USDT-${base}-${altAsset}`, leg1, leg2: s.symbol, leg3 });
        }
    }
    return triangles;
}

export interface BookTick {
    bid: Decimal;
    ask: Decimal;
    timestamp: number;
}

export interface TriangleEvaluation {
    triangleId: string;
    grossReturn: Decimal;
    netProfitPct: Decimal;
    isOpportunity: boolean;
}

/**
 * Avalia um triângulo dado o estado em cache de suas 3 pernas. Retorna
 * `null` quando algum preço é inválido (<=0) — mesmo kill switch de
 * sanidade usado no RiskManager do motor de execução.
 */
export function evaluateTriangle(
    triangle: Triangle,
    leg1: BookTick,
    leg2: BookTick,
    leg3: BookTick,
    retentionCubed: Decimal,
    requiredGrossSpread: Decimal
): TriangleEvaluation | null {
    if (!leg1.ask.greaterThan(0) || !leg2.ask.greaterThan(0) || !leg3.bid.greaterThan(0)) return null;

    const grossReturn = new Decimal(1).dividedBy(leg1.ask).dividedBy(leg2.ask).mul(leg3.bid);
    const netProfitPct = grossReturn.mul(retentionCubed).minus(1).mul(100);

    return {
        triangleId: triangle.id,
        grossReturn,
        netProfitPct,
        isOpportunity: grossReturn.greaterThanOrEqualTo(requiredGrossSpread),
    };
}

// ============================================================================
// [2] MOTOR DE ESTADO: descoberta de topologia + ingestão WS + avaliação O(k)
// ============================================================================
class OpportunitySniffer {
    private readonly retentionCubed: Decimal;
    private readonly requiredGrossSpread: Decimal;

    private triangles: Triangle[] = [];
    /** Índice símbolo -> triângulos afetados, construído uma vez — evita re-varrer todos os triângulos a cada tick (O(k), não O(N)). */
    private trianglesBySymbol = new Map<string, Triangle[]>();
    private orderBook = new Map<string, BookTick>();

    private ws: WebSocket | null = null;
    private isShuttingDown = false;

    private metrics = {
        ticksProcessed: 0,
        opportunitiesFound: 0,
        maxNetProfitPct: new Decimal(0),
        startTime: Date.now(),
    };

    constructor(feeRate: Decimal, targetNetProfit: Decimal) {
        this.retentionCubed = new Decimal(1).minus(feeRate).pow(3);
        this.requiredGrossSpread = new Decimal(1).plus(targetNetProfit).dividedBy(this.retentionCubed);
    }

    public async initialize(): Promise<void> {
        log.info('Iniciando mapeamento topológico real da Binance...', {
            bases: INTERMEDIATE_BASES.join(','),
            requiredGrossSpread: this.requiredGrossSpread.toFixed(6),
        });
        await this.buildTopologyGraph();
        this.connectWebSocket();
        setInterval(() => this.printReport(), 10_000);
    }

    public shutdown(): void {
        this.isShuttingDown = true;
        this.ws?.close();
    }

    private async buildTopologyGraph(): Promise<void> {
        const res = await fetch(BINANCE_REST_URL);
        if (!res.ok) throw new Error(`Falha ao buscar exchangeInfo: HTTP ${res.status}`);
        const data = (await res.json()) as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string }> };

        const activeSymbols: SymbolInfo[] = data.symbols
            .filter((s) => s.status === 'TRADING')
            .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));

        this.triangles = buildTriangles(activeSymbols, INTERMEDIATE_BASES);
        this.trianglesBySymbol = new Map();
        for (const t of this.triangles) {
            for (const leg of [t.leg1, t.leg2, t.leg3]) {
                const list = this.trianglesBySymbol.get(leg) ?? [];
                list.push(t);
                this.trianglesBySymbol.set(leg, list);
            }
        }

        log.info('Topologia real construída a partir dos pares de fato listados na Binance.', {
            triangulosOperaveis: this.triangles.length,
            simbolosUnicos: this.trianglesBySymbol.size,
        });
    }

    private connectWebSocket(): void {
        const streams = Array.from(this.trianglesBySymbol.keys()).map((s) => `${s.toLowerCase()}@bookTicker`);
        this.ws = new WebSocket(BINANCE_WS_URL);

        this.ws.on('open', () => {
            log.info(`Conexão WS estabelecida. Inscrevendo em ${streams.length} streams em lotes de ${SUBSCRIBE_BATCH_SIZE}...`);
            let batchIndex = 0;
            for (let i = 0; i < streams.length; i += SUBSCRIBE_BATCH_SIZE) {
                const batch = streams.slice(i, i + SUBSCRIBE_BATCH_SIZE);
                const delay = batchIndex * SUBSCRIBE_BATCH_DELAY_MS;
                batchIndex += 1;
                setTimeout(() => {
                    this.ws?.send(JSON.stringify({ method: 'SUBSCRIBE', params: batch, id: i }));
                }, delay);
            }
        });

        this.ws.on('message', (raw: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.u && msg.s && msg.b && msg.a) {
                    this.metrics.ticksProcessed += 1;
                    this.updateStateAndEvaluate(msg.s, msg.b, msg.a);
                }
            } catch {
                // mensagens de controle (resultado de SUBSCRIBE, ping/pong) não são bookTicker — ignoradas.
            }
        });

        this.ws.on('close', () => {
            if (this.isShuttingDown) return;
            log.warn('Conexão WS perdida. Reconectando em 3s...');
            setTimeout(() => this.connectWebSocket(), 3000);
        });

        this.ws.on('error', (err: Error) => {
            log.error('Erro de WebSocket.', { error: err.message });
        });
    }

    private updateStateAndEvaluate(symbol: string, bidRaw: string, askRaw: string): void {
        const now = Date.now();
        this.orderBook.set(symbol, { bid: new Decimal(bidRaw), ask: new Decimal(askRaw), timestamp: now });

        const affected = this.trianglesBySymbol.get(symbol) ?? []; // O(k): só os triângulos que usam este símbolo
        for (const t of affected) {
            const ob1 = this.orderBook.get(t.leg1);
            const ob2 = this.orderBook.get(t.leg2);
            const ob3 = this.orderBook.get(t.leg3);
            if (!ob1 || !ob2 || !ob3) continue; // ainda não temos as 3 pernas em cache

            // Kill switch de simultaneidade: sem isso, uma perna desatualizada
            // (par pouco líquido, book quase parado) pode ser comparada com
            // pernas frescas e gerar uma "ineficiência" que nunca coexistiu
            // de verdade no mercado — um falso positivo estatístico.
            if (now - ob1.timestamp > MAX_LEG_AGE_MS || now - ob2.timestamp > MAX_LEG_AGE_MS || now - ob3.timestamp > MAX_LEG_AGE_MS) {
                continue;
            }

            const evaluation = evaluateTriangle(t, ob1, ob2, ob3, this.retentionCubed, this.requiredGrossSpread);
            if (!evaluation || !evaluation.isOpportunity) continue;

            this.metrics.opportunitiesFound += 1;
            if (evaluation.netProfitPct.greaterThan(this.metrics.maxNetProfitPct)) {
                this.metrics.maxNetProfitPct = evaluation.netProfitPct;
            }

            log.info('Ineficiência líquida encontrada.', {
                triangulo: evaluation.triangleId,
                grossReturn: evaluation.grossReturn.toFixed(6),
                lucroLiquidoPct: evaluation.netProfitPct.toFixed(4),
                leg1: `${t.leg1} ask=${ob1.ask.toString()}`,
                leg2: `${t.leg2} ask=${ob2.ask.toString()}`,
                leg3: `${t.leg3} bid=${ob3.bid.toString()}`,
            });
        }
    }

    private printReport(): void {
        const uptimeSeconds = Math.floor((Date.now() - this.metrics.startTime) / 1000);
        log.info('Relatório periódico.', {
            uptimeSegundos: uptimeSeconds,
            ticksProcessados: this.metrics.ticksProcessed,
            oportunidadesLiquidas: this.metrics.opportunitiesFound,
            maiorLucroLiquidoVistoPct: this.metrics.maxNetProfitPct.toFixed(4),
            oportunidadesPorHora: uptimeSeconds > 0 ? ((this.metrics.opportunitiesFound / uptimeSeconds) * 3600).toFixed(2) : '0',
        });
    }
}

async function main() {
    const sniffer = new OpportunitySniffer(TAKER_FEE, TARGET_NET_PROFIT);
    await sniffer.initialize();

    const shutdown = () => {
        log.info('Encerrando sniffer...');
        sniffer.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha fatal no sniffer.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
