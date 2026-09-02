// Arquivo: src/engine.ts
import { Decimal } from 'decimal.js';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { EwmaTracker } from './statistics';
import { ExecutionResult, IExchangeProvider, Ticker, Triangle } from './types';
import { RiskManager } from './riskManager';

const log = createLogger('engine');

export interface EngineConfig {
    /** Kill switch de obsolescência de dado: idade máxima aceita de um tick, em ms. */
    maxTickAgeMs: Decimal;
    /**
     * Memória do EWMA que modela a distribuição "normal" da razão de
     * eficiência R = P3 / (P1·P2). alpha = 2/(N+1) aproxima uma janela de N
     * amostras; alpha maior esquece o passado mais rápido.
     */
    ratioEwmaAlpha: Decimal;
    /**
     * Nº mínimo de ticks já incorporados ao EWMA antes do kill switch
     * estatístico liberar QUALQUER disparo — enquanto a linha de base ainda
     * não foi aprendida, a variância é artificialmente baixa e qualquer
     * desvio pareceria (erroneamente) um outlier extremo. 0 desativa esse
     * gate por completo (usado pela demo/mock, cujo feed sintético repete o
     * mesmo valor fixo e nunca teria uma variância real para comparar).
     */
    statMinSamples: number;
    /** Nº de desvios-padrão que R precisa exceder da média móvel para ser tratado como sinal, não ruído. */
    statZThreshold: Decimal;
    /**
     * Circuit breaker de perda máxima: fração do capital INICIAL que, se
     * perdida, halta o engine permanentemente — mesmo que cada ciclo
     * individual tenha passado nos três kill switches de disparo. Existe
     * porque nenhum dos outros kill switches protege contra o cenário onde
     * a ESTRATÉGIA em si perde dinheiro na prática (slippage real entre a
     * decisão e a execução de 3 ordens sequenciais, competição de bots mais
     * rápidos, etc.) mesmo disparando só em ciclos que pareciam corretos no
     * momento da decisão. 0.10 = para se o capital cair 10% abaixo do
     * inicial. Deve ser configurado ANTES de operar com capital real.
     */
    maxDrawdownFraction: Decimal;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
    maxTickAgeMs: new Decimal(100),
    ratioEwmaAlpha: new Decimal('0.05'),
    statMinSamples: 20,
    statZThreshold: new Decimal('3'),
    maxDrawdownFraction: new Decimal('0.10'),
};

// ============================================================================
// CORE ENGINE: TRIANGULAR ARBITRAGE HFT (MULTI-TRIÂNGULO)
//
// Três camadas independentes de kill switch precisam concordar antes de
// qualquer capital ser comprometido, avaliadas PARA CADA TRIÂNGULO de forma
// independente:
//   1. Determinística  (RiskManager.isTriangularArbitrageViable)      — o
//      retorno líquido projetado no topo do book supera capital + slippage.
//   2. Estatística      (EwmaTracker sobre R = P3/(P1·P2))             — a
//      ineficiência observada é uma anomalia frente à linha de base recente
//      do PRÓPRIO triângulo, não um tick isolado ruidoso. Cada triângulo tem
//      seu próprio EwmaTracker (chaveado por `triangle.id`) — o warm-up de
//      um nunca conta para o gate estatístico de outro.
//   3. Profundidade      (RiskManager.isTriangularArbitrageViableWithDepth,
//      opcional — só quando o provider expõe getOrderBookSnapshot)    — o
//      book tem liquidez real o suficiente, nos preços reais, para sustentar
//      o ciclo inteiro dentro do orçamento de cada perna.
//
// Capital, circuit breaker e o mutex de execução são GLOBAIS — compartilhados
// por todos os triângulos, nunca duplicados ou divididos entre eles. Isso é
// deliberado: é o que preserva "zero alavancagem" ao operar múltiplos
// triângulos ao mesmo tempo — nunca duas execuções em voo simultaneamente,
// então o capital nunca está comprometido em mais de um ciclo por vez, não
// importa quantos triângulos o engine monitore.
//
// Eventos emitidos:
//   'cycle-success'     (payload: { triangleId: string; profit: Decimal; capital: Decimal })
//   'cycle-failure'     (payload: { triangleId: string; error: unknown; unwound: boolean })
//   'critical-exposure' (payload: { triangleId: string; leg1?: ExecutionResult; leg2?: ExecutionResult; error: unknown })
//     — o unwind de emergência também falhou; há posição direcional aberta
//     na corretora que o engine não conseguiu neutralizar sozinho.
//   'circuit-breaker-triggered' (payload: { initialCapital: Decimal; currentCapital: Decimal; drawdownFraction: Decimal })
//     — o capital caiu além de `config.maxDrawdownFraction` do valor
//     inicial. Diferente dos outros kill switches (que decidem se um ciclo
//     deve disparar), este observa o RESULTADO acumulado: protege contra a
//     estratégia sendo sistematicamente perdedora na prática mesmo quando
//     cada ciclo individual pareceu correto no momento da decisão.
//
// Em qualquer um dos dois eventos acima, o engine se HALTA PERMANENTEMENTE
// (isHalted() === true) — para TODOS os triângulos, não só o que disparou o
// halt: nunca mais inicia um novo ciclo sozinho, mesmo que o processo
// continue de pé — decidido assim de propósito, para não competir com um
// restart automático de infraestrutura (ver src/live.ts) que reativaria o
// robô às cegas sobre uma posição não neutralizada ou uma estratégia que
// está sistematicamente perdendo dinheiro.
// ============================================================================
export class TriangularArbitrageEngine extends EventEmitter {
    private readonly exchange: IExchangeProvider;
    private readonly riskManager: RiskManager;
    private readonly config: EngineConfig;
    private readonly triangles: Triangle[];
    /** Um EwmaTracker por triângulo (chave: triangle.id) — linhas de base nunca se misturam entre triângulos. */
    private readonly ratioTrackers: Map<string, EwmaTracker> = new Map();
    /** Índice símbolo -> triângulos afetados, construído uma vez — evita re-varrer todos os triângulos a cada tick (O(k), não O(N)). */
    private readonly trianglesBySymbol: Map<string, Triangle[]> = new Map();
    private readonly orderBookState: Map<string, Ticker> = new Map();
    private readonly initialCapital: Decimal;
    /** Mutex GLOBAL — nunca dois ciclos em voo ao mesmo tempo, mesmo entre triângulos diferentes (ver cabeçalho da classe). */
    private isExecutingCycle = false;
    private haltedPermanently = false;
    private currentCapital: Decimal;

    constructor(exchange: IExchangeProvider, riskManager: RiskManager, triangles: Triangle[], initialCapital: string, config: Partial<EngineConfig> = {}) {
        super();
        if (triangles.length === 0) {
            throw new Error('TriangularArbitrageEngine requer ao menos um triângulo para operar.');
        }
        this.exchange = exchange;
        this.riskManager = riskManager;
        this.triangles = triangles;
        this.initialCapital = new Decimal(initialCapital);
        this.currentCapital = this.initialCapital;
        this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };

        for (const t of triangles) {
            this.ratioTrackers.set(t.id, new EwmaTracker(this.config.ratioEwmaAlpha));
            for (const leg of [t.leg1, t.leg2, t.leg3]) {
                const list = this.trianglesBySymbol.get(leg) ?? [];
                list.push(t);
                this.trianglesBySymbol.set(leg, list);
            }
        }

        this.initializeFeed();
    }

    public getCurrentCapital(): Decimal {
        return this.currentCapital;
    }

    public getInitialCapital(): Decimal {
        return this.initialCapital;
    }

    public isHalted(): boolean {
        return this.haltedPermanently;
    }

    /**
     * Verifica o circuit breaker de perda máxima após qualquer atualização
     * de capital (sucesso ou unwind). Chamar SEMPRE que `currentCapital`
     * mudar — inclusive após um unwind, já que ele também pode terminar em
     * prejuízo. Halta permanentemente e emite 'circuit-breaker-triggered'
     * se o drawdown acumulado ultrapassar `config.maxDrawdownFraction`.
     */
    private checkDrawdownCircuitBreaker(): void {
        if (this.haltedPermanently) return;
        const floor = this.initialCapital.mul(new Decimal(1).minus(this.config.maxDrawdownFraction));
        if (this.currentCapital.greaterThanOrEqualTo(floor)) return;

        this.haltedPermanently = true;
        const drawdownFraction = new Decimal(1).minus(this.currentCapital.dividedBy(this.initialCapital));
        log.error('CIRCUIT BREAKER DE PERDA MÁXIMA ACIONADO — engine halted permanentemente. Intervenção manual necessária.', {
            capitalInicial: this.initialCapital.toFixed(6),
            capitalAtual: this.currentCapital.toFixed(6),
            drawdown: drawdownFraction.mul(100).toFixed(2) + '%',
            limiteConfigurado: this.config.maxDrawdownFraction.mul(100).toFixed(2) + '%',
        });
        this.emit('circuit-breaker-triggered', { initialCapital: this.initialCapital, currentCapital: this.currentCapital, drawdownFraction });
    }

    private initializeFeed() {
        this.exchange.on('ticker', (ticker: Ticker) => {
            this.orderBookState.set(ticker.symbol, ticker);
            const affected = this.trianglesBySymbol.get(ticker.symbol) ?? []; // O(k): só os triângulos que usam este símbolo
            for (const triangle of affected) {
                this.evaluateTriangle(triangle);
            }
        });
        log.info('Triangular Arbitrage Engine inicializado.', {
            capitalBase: this.currentCapital.toString(),
            triangulos: this.triangles.map((t) => t.id),
            statMinSamples: this.config.statMinSamples,
            statZThreshold: this.config.statZThreshold.toString(),
        });
    }

    private async evaluateTriangle(triangle: Triangle) {
        if (this.haltedPermanently) return; // parada de emergência definitiva — ver cabeçalho da classe
        if (this.isExecutingCycle) return; // mutex GLOBAL — nunca duas execuções em voo, nem entre triângulos diferentes

        const tick1 = this.orderBookState.get(triangle.leg1);
        const tick2 = this.orderBookState.get(triangle.leg2);
        const tick3 = this.orderBookState.get(triangle.leg3);
        if (!tick1 || !tick2 || !tick3) return;

        // Kill switch #0 — obsolescência temporal do dado.
        const now = Date.now();
        const maxAge = this.config.maxTickAgeMs.toNumber();
        if (now - tick1.timestamp > maxAge || now - tick2.timestamp > maxAge || now - tick3.timestamp > maxAge) {
            return;
        }

        const p1Ask = tick1.ask;
        const p2Ask = tick2.ask;
        const p3Bid = tick3.bid;
        if (!p1Ask.greaterThan(0) || !p2Ask.greaterThan(0) || !p3Bid.greaterThan(0)) return;

        // Kill switch #1 — estatístico: pontua a razão de eficiência ANTES de
        // incorporá-la ao EWMA DESTE triângulo (senão o próprio outlier
        // diluiria seu z-score — ver a nota em EwmaTracker), depois sempre
        // atualiza o tracker. Cada triângulo tem o seu próprio (ver
        // constructor) — nunca compartilhado entre triângulos diferentes.
        const tracker = this.ratioTrackers.get(triangle.id)!;
        const ratio = p3Bid.dividedBy(p1Ask.mul(p2Ask));
        const zScore = tracker.zScore(ratio);
        const sampleCountBeforeUpdate = tracker.sampleCount();
        tracker.update(ratio); // sempre aprende do tick, mesmo quando o gate abaixo bloqueia o disparo

        // statMinSamples <= 0 desativa esta camada por completo (usado pela
        // demo/mock — ver a doc de EngineConfig.statMinSamples). Do
        // contrário, mesmo com sampleCountBeforeUpdate satisfeito, um
        // z-score de 0 (variância ainda zerada) nunca alcançaria um
        // statZThreshold > 0 sozinho, então a checagem teria o mesmo efeito
        // prático de um bypass explícito nesse caso — mas ser explícito
        // evita depender desse acidente aritmético.
        const statGateDisabled = this.config.statMinSamples <= 0;
        const statisticallySignificant =
            statGateDisabled ||
            (sampleCountBeforeUpdate >= this.config.statMinSamples && zScore.greaterThanOrEqualTo(this.config.statZThreshold));
        if (!statisticallySignificant) return;

        // Kill switch #2 — determinístico (topo do book).
        const analysis = this.riskManager.isTriangularArbitrageViable(this.currentCapital, p1Ask, p2Ask, p3Bid, this.exchange.getFeeRate());
        if (!analysis.viable) return;

        // Kill switch #3 — confirmação por profundidade real do book, só
        // quando o provider a expõe (a Binance, via WS; o mock não, então
        // esta camada é pulada na demo — ver getOrderBookSnapshot em types.ts).
        let projectedProfit = analysis.expectedNetProfit;
        if (this.exchange.getOrderBookSnapshot) {
            const snap1 = this.exchange.getOrderBookSnapshot(triangle.leg1);
            const snap2 = this.exchange.getOrderBookSnapshot(triangle.leg2);
            const snap3 = this.exchange.getOrderBookSnapshot(triangle.leg3);
            if (!snap1 || !snap2 || !snap3) return; // profundidade ainda não chegou — não dispara sem confirmação
            const depth = this.riskManager.isTriangularArbitrageViableWithDepth(
                this.currentCapital,
                snap1.asks,
                snap2.asks,
                snap3.bids,
                this.exchange.getFeeRate()
            );
            if (!depth.viable) return;
            projectedProfit = depth.expectedNetProfit;
        }

        this.isExecutingCycle = true;
        await this.executeArbitrageCycle(triangle, p1Ask, p2Ask, p3Bid, projectedProfit);
    }

    private async executeArbitrageCycle(triangle: Triangle, p1Ask: Decimal, p2Ask: Decimal, p3Bid: Decimal, projectedProfit: Decimal) {
        log.info('Ineficiência confirmada nas três camadas — iniciando ciclo.', {
            triangulo: triangle.id,
            projectedNetProfit: projectedProfit.toFixed(6),
        });
        const startTime = Date.now();

        let leg1: ExecutionResult | undefined;
        let leg2: ExecutionResult | undefined;

        try {
            // Perna 1: Comprar o ativo-base com todo o capital disponível em USDT.
            const leg1QtyToRequest = this.currentCapital.dividedBy(p1Ask);
            leg1 = await this.exchange.executeOrder(triangle.leg1, 'BUY', 'MARKET', leg1QtyToRequest, p1Ask);

            // Perna 2: Comprar o ativo intermediário com todo o líquido recebido na perna 1.
            const leg2QtyToRequest = leg1.netProceeds.dividedBy(p2Ask);
            leg2 = await this.exchange.executeOrder(triangle.leg2, 'BUY', 'MARKET', leg2QtyToRequest, p2Ask);

            // Perna 3: Vender todo o líquido recebido na perna 2 de volta para USDT.
            const leg3 = await this.exchange.executeOrder(triangle.leg3, 'SELL', 'MARKET', leg2.netProceeds, p3Bid);

            // leg3.netProceeds já é o USDT líquido final — o provider aplicou
            // a taxa real de cada perna, nada a descontar aqui de novo.
            const finalCapital = leg3.netProceeds;
            const actualProfit = finalCapital.minus(this.currentCapital);
            this.currentCapital = finalCapital;
            this.checkDrawdownCircuitBreaker();

            log.info('Arbitragem concluída com sucesso.', {
                triangulo: triangle.id,
                executionTimeMs: Date.now() - startTime,
                capital: this.currentCapital.toFixed(6),
                profit: actualProfit.toFixed(6),
            });
            this.emit('cycle-success', { triangleId: triangle.id, profit: actualProfit, capital: this.currentCapital });
        } catch (error) {
            log.error('Falha na execução do ciclo — risco de exposição direcional. Iniciando unwind de emergência.', {
                triangulo: triangle.id,
                error: error instanceof Error ? error.message : String(error),
            });
            await this.emergencyUnwind(triangle, leg1, leg2, p1Ask, p3Bid, error);
        } finally {
            this.isExecutingCycle = false;
        }
    }

    /**
     * Neutraliza a exposição direcional deixada por um ciclo que falhou no
     * meio do caminho: se a perna 2 (ativo intermediário) já preencheu,
     * vende o residual a mercado por USDT via `triangle.leg3`; senão, se
     * apenas a perna 1 (ativo-base) preencheu, vende o residual a mercado
     * por USDT via `triangle.leg1`. Se o próprio unwind falhar, emite
     * 'critical-exposure' e o engine se HALTA PERMANENTEMENTE (para TODOS os
     * triângulos) — não há mais nada que ele possa fazer sozinho.
     */
    private async emergencyUnwind(
        triangle: Triangle,
        leg1: ExecutionResult | undefined,
        leg2: ExecutionResult | undefined,
        p1Ask: Decimal,
        p3Bid: Decimal,
        originalError: unknown
    ) {
        try {
            if (leg2) {
                const unwind = await this.exchange.executeOrder(triangle.leg3, 'SELL', 'MARKET', leg2.netProceeds, p3Bid);
                this.currentCapital = unwind.netProceeds;
                this.checkDrawdownCircuitBreaker();
                log.warn('Unwind concluído: ativo intermediário residual vendido a mercado.', {
                    triangulo: triangle.id,
                    capitalAposUnwind: this.currentCapital.toFixed(6),
                });
                this.emit('cycle-failure', { triangleId: triangle.id, error: originalError, unwound: true });
                return;
            }
            if (leg1) {
                const unwind = await this.exchange.executeOrder(triangle.leg1, 'SELL', 'MARKET', leg1.netProceeds, p1Ask);
                this.currentCapital = unwind.netProceeds;
                this.checkDrawdownCircuitBreaker();
                log.warn('Unwind concluído: ativo-base residual vendido a mercado.', {
                    triangulo: triangle.id,
                    capitalAposUnwind: this.currentCapital.toFixed(6),
                });
                this.emit('cycle-failure', { triangleId: triangle.id, error: originalError, unwound: true });
                return;
            }
            // Falhou antes de qualquer perna preencher: nenhuma posição para neutralizar.
            this.emit('cycle-failure', { triangleId: triangle.id, error: originalError, unwound: false });
        } catch (unwindError) {
            this.haltedPermanently = true;
            log.error('FALHA NO UNWIND DE EMERGÊNCIA — exposição direcional NÃO neutralizada. Engine halted permanentemente. Intervenção manual necessária.', {
                triangulo: triangle.id,
                unwindError: unwindError instanceof Error ? unwindError.message : String(unwindError),
            });
            this.emit('critical-exposure', { triangleId: triangle.id, leg1, leg2, error: unwindError });
        }
    }
}
