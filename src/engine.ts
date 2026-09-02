// Arquivo: src/engine.ts
import { Decimal } from 'decimal.js';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { EwmaTracker } from './statistics';
import { ExecutionResult, IExchangeProvider, Ticker } from './types';
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
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
    maxTickAgeMs: new Decimal(100),
    ratioEwmaAlpha: new Decimal('0.05'),
    statMinSamples: 20,
    statZThreshold: new Decimal('3'),
};

// ============================================================================
// CORE ENGINE: TRIANGULAR ARBITRAGE HFT
//
// Três camadas independentes de kill switch precisam concordar antes de
// qualquer capital ser comprometido:
//   1. Determinística  (RiskManager.isTriangularArbitrageViable)      — o
//      retorno líquido projetado no topo do book supera capital + slippage.
//   2. Estatística      (EwmaTracker sobre R = P3/(P1·P2))             — a
//      ineficiência observada é uma anomalia frente à linha de base recente
//      do próprio par sintético, não um tick isolado ruidoso.
//   3. Profundidade      (RiskManager.isTriangularArbitrageViableWithDepth,
//      opcional — só quando o provider expõe getOrderBookSnapshot)    — o
//      book tem liquidez real o suficiente, nos preços reais, para sustentar
//      o ciclo inteiro dentro do orçamento de cada perna.
//
// Eventos emitidos:
//   'cycle-success'     (payload: { profit: Decimal; capital: Decimal })
//   'cycle-failure'     (payload: { error: unknown; unwound: boolean })
//   'critical-exposure' (payload: { leg1?: ExecutionResult; leg2?: ExecutionResult; error: unknown })
//     — o unwind de emergência também falhou; há posição direcional aberta
//     na corretora que o engine não conseguiu neutralizar sozinho. A partir
//     daqui o engine se HALTA PERMANENTEMENTE (isHalted() === true): nunca
//     mais inicia um novo ciclo sozinho, mesmo que o processo continue de
//     pé — decidido assim de propósito, para não competir com um restart
//     automático de infraestrutura (ver src/live.ts) que reativaria o robô
//     às cegas sobre uma posição não neutralizada.
// ============================================================================
export class TriangularArbitrageEngine extends EventEmitter {
    private readonly exchange: IExchangeProvider;
    private readonly riskManager: RiskManager;
    private readonly config: EngineConfig;
    private readonly ratioTracker: EwmaTracker;
    private readonly orderBookState: Map<string, Ticker> = new Map();
    private isExecutingCycle = false;
    private haltedPermanently = false;
    private currentCapital: Decimal;

    constructor(exchange: IExchangeProvider, riskManager: RiskManager, initialCapital: string, config: Partial<EngineConfig> = {}) {
        super();
        this.exchange = exchange;
        this.riskManager = riskManager;
        this.currentCapital = new Decimal(initialCapital);
        this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
        this.ratioTracker = new EwmaTracker(this.config.ratioEwmaAlpha);

        this.initializeFeed();
    }

    public getCurrentCapital(): Decimal {
        return this.currentCapital;
    }

    public isHalted(): boolean {
        return this.haltedPermanently;
    }

    private initializeFeed() {
        this.exchange.on('ticker', (ticker: Ticker) => {
            this.orderBookState.set(ticker.symbol, ticker);
            this.evaluateInefficiency();
        });
        log.info('Triangular Arbitrage Engine inicializado.', {
            capitalBase: this.currentCapital.toString(),
            statMinSamples: this.config.statMinSamples,
            statZThreshold: this.config.statZThreshold.toString(),
        });
    }

    private async evaluateInefficiency() {
        if (this.haltedPermanently) return; // parada de emergência definitiva — ver cabeçalho da classe
        if (this.isExecutingCycle) return; // prevenção estrita de race conditions e sobreposição de I/O

        const btcUsdt = this.orderBookState.get('BTC/USDT');
        const ethBtc = this.orderBookState.get('ETH/BTC');
        const ethUsdt = this.orderBookState.get('ETH/USDT');
        if (!btcUsdt || !ethBtc || !ethUsdt) return;

        // Kill switch #0 — obsolescência temporal do dado.
        const now = Date.now();
        const maxAge = this.config.maxTickAgeMs.toNumber();
        if (now - btcUsdt.timestamp > maxAge || now - ethBtc.timestamp > maxAge || now - ethUsdt.timestamp > maxAge) {
            return;
        }

        const p1Ask = btcUsdt.ask;
        const p2Ask = ethBtc.ask;
        const p3Bid = ethUsdt.bid;
        if (!p1Ask.greaterThan(0) || !p2Ask.greaterThan(0) || !p3Bid.greaterThan(0)) return;

        // Kill switch #1 — estatístico: pontua a razão de eficiência ANTES de
        // incorporá-la ao EWMA (senão o próprio outlier diluiria seu z-score
        // — ver a nota em EwmaTracker), depois sempre atualiza o tracker.
        const ratio = p3Bid.dividedBy(p1Ask.mul(p2Ask));
        const zScore = this.ratioTracker.zScore(ratio);
        const sampleCountBeforeUpdate = this.ratioTracker.sampleCount();
        this.ratioTracker.update(ratio); // sempre aprende do tick, mesmo quando o gate abaixo bloqueia o disparo

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
            const snap1 = this.exchange.getOrderBookSnapshot('BTC/USDT');
            const snap2 = this.exchange.getOrderBookSnapshot('ETH/BTC');
            const snap3 = this.exchange.getOrderBookSnapshot('ETH/USDT');
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
        await this.executeArbitrageCycle(p1Ask, p2Ask, p3Bid, projectedProfit);
    }

    private async executeArbitrageCycle(p1Ask: Decimal, p2Ask: Decimal, p3Bid: Decimal, projectedProfit: Decimal) {
        log.info('Ineficiência confirmada nas três camadas — iniciando ciclo.', { projectedNetProfit: projectedProfit.toFixed(6) });
        const startTime = Date.now();

        let leg1: ExecutionResult | undefined;
        let leg2: ExecutionResult | undefined;

        try {
            // Perna 1: Comprar BTC com todo o capital disponível em USDT.
            const btcQtyToRequest = this.currentCapital.dividedBy(p1Ask);
            leg1 = await this.exchange.executeOrder('BTC/USDT', 'BUY', 'MARKET', btcQtyToRequest, p1Ask);

            // Perna 2: Comprar ETH com todo o BTC líquido recebido na perna 1.
            const ethQtyToRequest = leg1.netProceeds.dividedBy(p2Ask);
            leg2 = await this.exchange.executeOrder('ETH/BTC', 'BUY', 'MARKET', ethQtyToRequest, p2Ask);

            // Perna 3: Vender todo o ETH líquido recebido na perna 2 de volta para USDT.
            const leg3 = await this.exchange.executeOrder('ETH/USDT', 'SELL', 'MARKET', leg2.netProceeds, p3Bid);

            // leg3.netProceeds já é o USDT líquido final — o provider aplicou
            // a taxa real de cada perna, nada a descontar aqui de novo.
            const finalCapital = leg3.netProceeds;
            const actualProfit = finalCapital.minus(this.currentCapital);
            this.currentCapital = finalCapital;

            log.info('Arbitragem concluída com sucesso.', {
                executionTimeMs: Date.now() - startTime,
                capital: this.currentCapital.toFixed(6),
                profit: actualProfit.toFixed(6),
            });
            this.emit('cycle-success', { profit: actualProfit, capital: this.currentCapital });
        } catch (error) {
            log.error('Falha na execução do ciclo — risco de exposição direcional. Iniciando unwind de emergência.', {
                error: error instanceof Error ? error.message : String(error),
            });
            await this.emergencyUnwind(leg1, leg2, p1Ask, p3Bid, error);
        } finally {
            this.isExecutingCycle = false;
        }
    }

    /**
     * Neutraliza a exposição direcional deixada por um ciclo que falhou no
     * meio do caminho: se a perna 2 (ETH) já preencheu, vende o ETH residual
     * a mercado por USDT; senão, se apenas a perna 1 (BTC) preencheu, vende
     * o BTC residual a mercado por USDT. Se o próprio unwind falhar, emite
     * 'critical-exposure' e o engine se HALTA PERMANENTEMENTE — não há mais
     * nada que ele possa fazer sozinho.
     */
    private async emergencyUnwind(leg1: ExecutionResult | undefined, leg2: ExecutionResult | undefined, p1Ask: Decimal, p3Bid: Decimal, originalError: unknown) {
        try {
            if (leg2) {
                const unwind = await this.exchange.executeOrder('ETH/USDT', 'SELL', 'MARKET', leg2.netProceeds, p3Bid);
                this.currentCapital = unwind.netProceeds;
                log.warn('Unwind concluído: ETH residual vendido a mercado.', { capitalAposUnwind: this.currentCapital.toFixed(6) });
                this.emit('cycle-failure', { error: originalError, unwound: true });
                return;
            }
            if (leg1) {
                const unwind = await this.exchange.executeOrder('BTC/USDT', 'SELL', 'MARKET', leg1.netProceeds, p1Ask);
                this.currentCapital = unwind.netProceeds;
                log.warn('Unwind concluído: BTC residual vendido a mercado.', { capitalAposUnwind: this.currentCapital.toFixed(6) });
                this.emit('cycle-failure', { error: originalError, unwound: true });
                return;
            }
            // Falhou antes de qualquer perna preencher: nenhuma posição para neutralizar.
            this.emit('cycle-failure', { error: originalError, unwound: false });
        } catch (unwindError) {
            this.haltedPermanently = true;
            log.error('FALHA NO UNWIND DE EMERGÊNCIA — exposição direcional NÃO neutralizada. Engine halted permanentemente. Intervenção manual necessária.', {
                unwindError: unwindError instanceof Error ? unwindError.message : String(unwindError),
            });
            this.emit('critical-exposure', { leg1, leg2, error: unwindError });
        }
    }
}
