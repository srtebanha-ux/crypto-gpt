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
import { simulateNetFill } from './simulatedFill';

const log = createLogger('papertrading');

/** Um triângulo sintético: preços "justos" (sem arbitragem embutida — p3 ≈ p1·p2) que o ruído do cenário distorce a cada tick. */
export interface SyntheticTriangleSpec extends Triangle {
    fairP1: number;
    fairP2: number;
    fairP3: number;
}

export const DEFAULT_SYNTHETIC_TRIANGLE: SyntheticTriangleSpec = {
    id: 'USDT-BTC-ETH',
    leg1: 'BTC/USDT',
    leg2: 'ETH/BTC',
    leg3: 'ETH/USDT',
    fairP1: 60000,
    fairP2: 0.05,
    fairP3: 3000,
};

/**
 * Conjunto de 5 triângulos sintéticos INDEPENDENTES (símbolos disjuntos entre
 * si, de propósito — cada um recebe seu próprio ruído/dislocamento, nunca
 * compartilhando preço com outro) para ilustrar qualitativamente o efeito de
 * monitorar vários triângulos ao mesmo tempo (ver README, "Múltiplos
 * triângulos"). O NÚMERO 5 é uma suposição ilustrativa, não uma contagem
 * medida — quantos triângulos reais existem de fato e com que correlação só
 * `opportunitySniffer.ts` rodando contra a Binance real pode responder.
 */
export const ILLUSTRATIVE_FIVE_TRIANGLES: SyntheticTriangleSpec[] = [
    DEFAULT_SYNTHETIC_TRIANGLE,
    { id: 'USDT-BNB-SOL', leg1: 'BNB/USDT', leg2: 'SOL/BNB', leg3: 'SOL/USDT', fairP1: 550, fairP2: 0.36, fairP3: 198 },
    { id: 'USDT-FDUSD-XRP', leg1: 'FDUSD/USDT', leg2: 'XRP/FDUSD', leg3: 'XRP/USDT', fairP1: 1.0, fairP2: 0.57, fairP3: 0.57 },
    { id: 'USDT-LTC-DOGE', leg1: 'LTC/USDT', leg2: 'DOGE/LTC', leg3: 'DOGE/USDT', fairP1: 95, fairP2: 0.00147, fairP3: 0.13965 },
    { id: 'USDT-AVAX-ADA', leg1: 'AVAX/USDT', leg2: 'ADA/AVAX', leg3: 'ADA/USDT', fairP1: 32, fairP2: 0.01875, fairP3: 0.6 },
];

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
 * que injeta erros propositalmente. Modela N triângulos sintéticos
 * INDEPENDENTES (cada um com seu próprio ruído/dislocamento a cada tick) —
 * por isso os `triangles` passados devem usar símbolos disjuntos entre si:
 * o provider não modela nenhuma correlação entre eles.
 */
export class SimulatedExchangeProvider extends EventEmitter implements IExchangeProvider {
    private feeRate = new Decimal('0.001');

    constructor(
        private random: RandomSource,
        private scenario: NoiseScenario,
        private triangles: SyntheticTriangleSpec[] = [DEFAULT_SYNTHETIC_TRIANGLE]
    ) {
        super();
    }

    public advanceTick(): void {
        const now = Date.now();
        const spread = 0.0002; // spread bid/ask sintético de 2bp em cada perna
        for (const t of this.triangles) {
            let p1 = t.fairP1 * (1 + gaussianSample(this.random, 0, this.scenario.baseNoiseBps / 10000));
            let p2 = t.fairP2 * (1 + gaussianSample(this.random, 0, this.scenario.baseNoiseBps / 10000));
            let p3 = t.fairP3 * (1 + gaussianSample(this.random, 0, this.scenario.baseNoiseBps / 10000));

            if (this.random() < this.scenario.jumpProbability) {
                const jumpBps = Math.abs(gaussianSample(this.random, this.scenario.jumpMeanBps, this.scenario.jumpMeanBps / 2));
                const leg = Math.floor(this.random() * 3);
                const direction = this.random() < 0.5 ? -1 : 1;
                const factor = 1 + (direction * jumpBps) / 10000;
                if (leg === 0) p1 *= factor;
                else if (leg === 1) p2 *= factor;
                else p3 *= factor;
            }

            this.emit('ticker', { symbol: t.leg1, bid: new Decimal(p1 * (1 - spread)), ask: new Decimal(p1), timestamp: now });
            this.emit('ticker', { symbol: t.leg2, bid: new Decimal(p2 * (1 - spread)), ask: new Decimal(p2), timestamp: now });
            this.emit('ticker', { symbol: t.leg3, bid: new Decimal(p3), ask: new Decimal(p3 * (1 + spread)), timestamp: now });
        }
    }

    public async executeOrder(symbol: string, side: OrderSide, _type: OrderType, qty: Decimal, price?: Decimal): Promise<ExecutionResult> {
        const fillPrice = price ?? new Decimal('0');
        const { netProceeds, feePaid, feePaidAsset } = simulateNetFill(symbol, side, qty, fillPrice, this.feeRate);
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
    maxSlippage = '0.0005',
    triangleSpecs: SyntheticTriangleSpec[] = [DEFAULT_SYNTHETIC_TRIANGLE]
): Promise<PaperTradingResult> {
    const random = createSeededRandom(seed);
    const provider = new SimulatedExchangeProvider(random, scenario, triangleSpecs);
    const riskManager = new RiskManager(maxSlippage);
    const triangles: Triangle[] = triangleSpecs.map(({ id, leg1, leg2, leg3 }) => ({ id, leg1, leg2, leg3 }));
    const engine = new TriangularArbitrageEngine(provider, riskManager, triangles, capitalUsd, engineConfig);

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

    // 'single' (padrão) = comportamento original, 1 triângulo. 'illustrative5'
    // = 5 triângulos sintéticos independentes (ver ILLUSTRATIVE_FIVE_TRIANGLES
    // acima) — ilustra qualitativamente o efeito de monitorar vários
    // triângulos, NÃO uma contagem real medida.
    const triangleSet = process.env.PAPER_TRIANGLE_SET === 'illustrative5' ? ILLUSTRATIVE_FIVE_TRIANGLES : [DEFAULT_SYNTHETIC_TRIANGLE];

    log.info('Iniciando paper trading — cenário de ruído é hipótese, não dado real.', {
        capitalBRL,
        BRL_PER_USD,
        capitalUsd,
        dias: days,
        totalTicks,
        seed,
        scenario,
        triangleSet: triangleSet.map((t) => t.id),
    });

    const result = await runPaperTradingSimulation(capitalUsd, scenario, totalTicks, seed, {}, '0.0005', triangleSet);

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
