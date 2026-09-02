// Arquivo: src/paperTradingSimulation.ts
//
// "Paper trading" offline: roda o TriangularArbitrageEngine e o RiskManager
// REAIS do projeto (não uma reimplementação) contra um feed sintético
// gerado com o mesmo modelo de ruído+dislocamento do monteCarloSimulation.ts,
// exercitando o pipeline INTEIRO — os 3 kill switches de disparo, unwind de
// emergência, circuit breaker de drawdown — em vez de só a matemática do
// RiskManager isolada.
//
// Isso importa porque foi rodando uma simulação assim, por vários dias
// simulados, que se descobriu um bug real: uma versão anterior do
// RiskManager fixava um teto de capital no valor INICIAL e travava
// silenciosamente após o primeiro ciclo lucrativo (porque o capital do
// engine cresce, e todo ciclo seguinte passava a ser rejeitado). Nenhum
// teste de ciclo único pegava isso — só uma simulação de múltiplos ciclos
// em sequência exercitava esse caminho.
//
// O cenário de ruído usado aqui é uma SUPOSIÇÃO (o mesmo "fronteira" do
// monteCarloSimulation.ts, calibrado para ficar perto de bater metas
// típicas), não dado real — ver opportunitySniffer.ts para isso.
import { Decimal } from 'decimal.js';
import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { RiskManager } from './riskManager';
import { EngineConfig, TriangularArbitrageEngine } from './engine';
import { ExecutionResult, IExchangeProvider, OrderSide, OrderType, Triangle } from './types';
import { createSeededRandom, gaussianSample, RandomSource } from './prng';

const log = createLogger('papertrading');

// SimulatedExchangeProvider só modela os preços sintéticos de UM triângulo
// (ver advanceTick abaixo) — extensão para múltiplos triângulos sintéticos
// fica fora do escopo desta simulação por ora (o engine real já suporta
// vários; ver src/engine.ts e src/binanceExchangeProvider.ts).
const SIMULATED_TRIANGLE: Triangle = { id: 'USDT-BTC-ETH', leg1: 'BTC/USDT', leg2: 'ETH/BTC', leg3: 'ETH/USDT' };

export interface NoiseScenario {
    baseNoiseBps: number;
    jumpProbability: number;
    jumpMeanBps: number;
}

/**
 * Provider síncrono/determinístico que gera preços sintéticos sob demanda
 * (via `advanceTick()`, chamado externamente — não em tempo real) e simula
 * fills líquidos de taxa como o MockExchangeProvider. Não modela rejeição
 * de ordem, fill parcial ou erro de rede — só o caminho feliz de execução;
 * a robustez a falhas já é coberta pelos testes do engine com um provider
 * que injeta erros propositalmente.
 */
export class SimulatedExchangeProvider extends EventEmitter implements IExchangeProvider {
    private feeRate = new Decimal('0.001');

    constructor(
        private random: RandomSource,
        private scenario: NoiseScenario,
        private fairP1 = 60000, // BTC/USDT
        private fairP2 = 0.05, // ETH/BTC
        private fairP3 = 3000 // ETH/USDT implícito
    ) {
        super();
    }

    public advanceTick(): void {
        let p1 = this.fairP1 * (1 + gaussianSample(this.random, 0, this.scenario.baseNoiseBps / 10000));
        let p2 = this.fairP2 * (1 + gaussianSample(this.random, 0, this.scenario.baseNoiseBps / 10000));
        let p3 = this.fairP3 * (1 + gaussianSample(this.random, 0, this.scenario.baseNoiseBps / 10000));

        if (this.random() < this.scenario.jumpProbability) {
            const jumpBps = Math.abs(gaussianSample(this.random, this.scenario.jumpMeanBps, this.scenario.jumpMeanBps / 2));
            const leg = Math.floor(this.random() * 3);
            const direction = this.random() < 0.5 ? -1 : 1;
            const factor = 1 + (direction * jumpBps) / 10000;
            if (leg === 0) p1 *= factor;
            else if (leg === 1) p2 *= factor;
            else p3 *= factor;
        }

        const now = Date.now();
        const spread = 0.0002; // spread bid/ask sintético de 2bp em cada perna
        this.emit('ticker', { symbol: 'BTC/USDT', bid: new Decimal(p1 * (1 - spread)), ask: new Decimal(p1), timestamp: now });
        this.emit('ticker', { symbol: 'ETH/BTC', bid: new Decimal(p2 * (1 - spread)), ask: new Decimal(p2), timestamp: now });
        this.emit('ticker', { symbol: 'ETH/USDT', bid: new Decimal(p3), ask: new Decimal(p3 * (1 + spread)), timestamp: now });
    }

    public async executeOrder(symbol: string, side: OrderSide, _type: OrderType, qty: Decimal, price?: Decimal): Promise<ExecutionResult> {
        const fillPrice = price ?? new Decimal('0');
        const [baseAsset, quoteAsset] = symbol.split('/');
        const feeFactor = new Decimal(1).minus(this.feeRate);
        let netProceeds: Decimal;
        let feePaid: Decimal;
        let feePaidAsset: string;
        if (side === 'BUY') {
            netProceeds = qty.mul(feeFactor);
            feePaid = qty.mul(this.feeRate);
            feePaidAsset = baseAsset;
        } else {
            const grossQuote = qty.mul(fillPrice);
            netProceeds = grossQuote.mul(feeFactor);
            feePaid = grossQuote.mul(this.feeRate);
            feePaidAsset = quoteAsset;
        }
        return { orderId: 'sim', status: 'FILLED', executedPrice: fillPrice, executedQty: qty, netProceeds, feePaid, feePaidAsset, timestamp: Date.now() };
    }

    public getFeeRate(): Decimal {
        return this.feeRate;
    }
}

export interface PaperTradingResult {
    initialCapital: Decimal;
    finalCapital: Decimal;
    totalCycles: number;
    halted: boolean;
    haltReason?: 'circuit-breaker-triggered' | 'critical-exposure';
}

/**
 * Roda `totalTicks` ticks sintéticos através do engine/RiskManager reais.
 * `await Promise.resolve()` entre ticks deixa o event loop drenar qualquer
 * ciclo assíncrono em andamento (3 `executeOrder` sequenciais) antes do
 * próximo tick — sem isso, uma emissão síncrona de milhões de ticks nunca
 * cederia ao microtask queue e nenhum ciclo terminaria de executar antes
 * do fim do loop.
 */
export async function runPaperTradingSimulation(
    capitalUsd: string,
    scenario: NoiseScenario,
    totalTicks: number,
    seed: number,
    engineConfig: Partial<EngineConfig> = {},
    maxSlippage = '0.0005'
): Promise<PaperTradingResult> {
    const random = createSeededRandom(seed);
    const provider = new SimulatedExchangeProvider(random, scenario);
    const riskManager = new RiskManager(maxSlippage);
    const engine = new TriangularArbitrageEngine(provider, riskManager, [SIMULATED_TRIANGLE], capitalUsd, engineConfig);

    let totalCycles = 0;
    let haltReason: PaperTradingResult['haltReason'];
    engine.on('cycle-success', () => (totalCycles += 1));
    engine.on('circuit-breaker-triggered', () => (haltReason = 'circuit-breaker-triggered'));
    engine.on('critical-exposure', () => (haltReason = 'critical-exposure'));

    for (let i = 0; i < totalTicks; i++) {
        provider.advanceTick();
        await Promise.resolve();
    }

    return {
        initialCapital: engine.getInitialCapital(),
        finalCapital: engine.getCurrentCapital(),
        totalCycles,
        halted: engine.isHalted(),
        haltReason,
    };
}

async function main() {
    const BRL_PER_USD = Number(process.env.PAPER_BRL_PER_USD ?? '5.5'); // suposição — sem cotação ao vivo aqui
    const capitalBRL = Number(process.env.PAPER_CAPITAL_BRL ?? '300');
    const capitalUsd = (capitalBRL / BRL_PER_USD).toFixed(2);
    const seed = Number(process.env.PAPER_SEED ?? '42');
    const days = Number(process.env.PAPER_DAYS ?? '1');
    const ticksPerSecond = 5;
    const totalTicks = Math.round(days * 24 * 3600 * ticksPerSecond);

    // Cenário "fronteira" do monteCarloSimulation.ts — hipótese otimista, não medição real.
    const scenario: NoiseScenario = {
        baseNoiseBps: Number(process.env.PAPER_NOISE_BPS ?? '4.5'),
        jumpProbability: Number(process.env.PAPER_JUMP_PROBABILITY ?? '0.00035'),
        jumpMeanBps: Number(process.env.PAPER_JUMP_MEAN_BPS ?? '32'),
    };

    log.info('Iniciando paper trading — cenário de ruído é hipótese, não dado real.', {
        capitalBRL,
        BRL_PER_USD,
        capitalUsd,
        dias: days,
        totalTicks,
        seed,
        scenario,
    });

    const result = await runPaperTradingSimulation(capitalUsd, scenario, totalTicks, seed);

    log.info('=== RESULTADO FINAL ===', {
        capitalInicialUSD: result.initialCapital.toFixed(6),
        capitalFinalUSD: result.finalCapital.toFixed(6),
        capitalFinalBRL: (result.finalCapital.toNumber() * BRL_PER_USD).toFixed(2),
        totalCiclos: result.totalCycles,
        halted: result.halted,
        haltReason: result.haltReason,
    });
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha na simulação de paper trading.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
