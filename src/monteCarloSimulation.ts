// Arquivo: src/monteCarloSimulation.ts
//
// Simulação de sensibilidade (Monte Carlo), NÃO uma previsão: reutiliza o
// RiskManager real do projeto contra séries de preço sintéticas com ruído
// de microestrutura + dislocamentos ocasionais, para explorar como a taxa
// de oportunidades líquidas de taxa varia conforme hipóteses de "quão
// barulhento/dislocado" é o mercado. Os parâmetros de ruído são SUPOSIÇÕES
// explícitas — isso complementa, mas não substitui, o opportunitySniffer.ts
// (que mede o mercado real).
//
// Cada oportunidade, quando ocorre, tem seu próprio lucro líquido — por
// isso a métrica que realmente importa para bater uma meta mensal não é
// "oportunidades por hora" isoladamente, é λ (taxa) × p̄ (lucro médio por
// oportunidade). Ver README, seção "Simulação de sensibilidade".
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { RiskManager } from './riskManager';
import { createSeededRandom, gaussianSample, RandomSource } from './prng';

const log = createLogger('montecarlo');

export interface ScenarioParams {
    name: string;
    ticks: number;
    /** Desvio-padrão do ruído contínuo de microestrutura em cada perna, em pontos-base. */
    baseNoiseBps: number;
    /** Probabilidade, por tick, de um dislocamento maior ocorrer numa perna aleatória. */
    jumpProbability: number;
    /** Magnitude média (valor absoluto) do dislocamento, em pontos-base, quando ocorre. */
    jumpMeanBps: number;
    /** Ticks por segundo assumidos, para converter contagem em taxa/hora. */
    ticksPerSecond: number;
}

export interface ScenarioResult extends ScenarioParams {
    opportunities: number;
    opportunitiesPerHour: number;
    avgNetProfitBpsWhenViable: number;
    maxNetProfitBps: number;
    /** λ (oportunidades/hora) × lucro médio (fração) — a métrica comparável contra uma meta mensal. */
    lambdaTimesP: number;
}

/**
 * Roda uma série sintética de `ticks` para o triângulo BTC/USDT-ETH/BTC-ETH/USDT
 * e conta quantas vezes o RiskManager real do projeto consideraria o ciclo
 * viável, com que lucro líquido médio. `random` é injetado para permitir
 * reprodutibilidade determinística nos testes.
 */
export function runScenario(params: ScenarioParams, random: RandomSource, capitalUsd = '50', maxSlippage = '0.0005', feeRate = '0.001'): ScenarioResult {
    const riskManager = new RiskManager(capitalUsd, maxSlippage);
    const capital = new Decimal(capitalUsd);
    const fee = new Decimal(feeRate);

    const fairP1 = 60000; // BTC/USDT
    const fairP2 = 0.05; // ETH/BTC
    const fairP3 = fairP1 * fairP2; // ETH/USDT implícito

    let opportunities = 0;
    let profitSumBps = 0;
    let maxProfitBps = 0;

    for (let i = 0; i < params.ticks; i++) {
        let p1 = fairP1 * (1 + gaussianSample(random, 0, params.baseNoiseBps / 10000));
        let p2 = fairP2 * (1 + gaussianSample(random, 0, params.baseNoiseBps / 10000));
        let p3 = fairP3 * (1 + gaussianSample(random, 0, params.baseNoiseBps / 10000));

        if (random() < params.jumpProbability) {
            const jumpBps = Math.abs(gaussianSample(random, params.jumpMeanBps, params.jumpMeanBps / 2));
            const leg = Math.floor(random() * 3);
            const direction = random() < 0.5 ? -1 : 1;
            const factor = 1 + (direction * jumpBps) / 10000;
            if (leg === 0) p1 *= factor;
            else if (leg === 1) p2 *= factor;
            else p3 *= factor;
        }

        const result = riskManager.isTriangularArbitrageViable(capital, new Decimal(p1), new Decimal(p2), new Decimal(p3), fee);
        if (result.viable) {
            opportunities += 1;
            const profitBps = result.expectedNetProfit.dividedBy(capital).mul(10000).toNumber();
            profitSumBps += profitBps;
            if (profitBps > maxProfitBps) maxProfitBps = profitBps;
        }
    }

    const hoursSimulated = params.ticks / params.ticksPerSecond / 3600;
    const opportunitiesPerHour = opportunities / hoursSimulated;
    const avgNetProfitBpsWhenViable = opportunities > 0 ? profitSumBps / opportunities : 0;

    return {
        ...params,
        opportunities,
        opportunitiesPerHour,
        avgNetProfitBpsWhenViable,
        maxNetProfitBps: maxProfitBps,
        lambdaTimesP: opportunitiesPerHour * (avgNetProfitBpsWhenViable / 10000),
    };
}

/** λ×p̄ (fração/hora) necessário para ir de `startCapital` a `targetMonthly` em `hoursPerMonth`. */
export function requiredLambdaTimesP(startCapital: number, targetMonthly: number, hoursPerMonth = 720): number {
    return targetMonthly / startCapital / hoursPerMonth;
}

const DEFAULT_SCENARIOS: Omit<ScenarioParams, 'ticks' | 'ticksPerSecond'>[] = [
    { name: 'Conservador — ruído 1bp, sem dislocamentos', baseNoiseBps: 1, jumpProbability: 0, jumpMeanBps: 0 },
    { name: 'Moderado — ruído 3bp, dislocamento raro ~15bp', baseNoiseBps: 3, jumpProbability: 0.0001, jumpMeanBps: 15 },
    { name: 'Fronteira — ruído 4.5bp, dislocamento ~32bp, prob 0.035%/tick', baseNoiseBps: 4.5, jumpProbability: 0.00035, jumpMeanBps: 32 },
    { name: 'Agressivo — ruído 5bp, dislocamento ~40bp', baseNoiseBps: 5, jumpProbability: 0.0005, jumpMeanBps: 40 },
    { name: 'Extremo — ruído 8bp, dislocamento ~80bp', baseNoiseBps: 8, jumpProbability: 0.002, jumpMeanBps: 80 },
];

function main() {
    const seed = Number(process.env.SIM_SEED ?? '42');
    const ticks = Number(process.env.SIM_TICKS ?? '500000');
    const ticksPerSecond = Number(process.env.SIM_TICKS_PER_SECOND ?? '5');
    const startCapital = Number(process.env.SIM_START_CAPITAL ?? '5000');
    const targetMonthly = Number(process.env.SIM_TARGET_MONTHLY ?? '20000');

    const target = requiredLambdaTimesP(startCapital, targetMonthly);
    log.info('Simulação de sensibilidade — parâmetros de ruído são suposições, não dados reais.', {
        seed,
        ticks,
        horasSimuladas: (ticks / ticksPerSecond / 3600).toFixed(1),
        // A razão alvo/capital é adimensional — mesma unidade monetária do
        // resto do projeto (USD, ver CAPITAL_USD), não R$; a matemática não
        // muda com a moeda, só a interpretação de quem lê.
        metaRequerida: `${target.toFixed(6)}/hora (capital ${startCapital} -> meta ${targetMonthly}/mês)`,
    });

    for (const scenarioDef of DEFAULT_SCENARIOS) {
        const random = createSeededRandom(seed);
        const result = runScenario({ ...scenarioDef, ticks, ticksPerSecond }, random);
        log.info(result.name, {
            oportunidadesPorHora: result.opportunitiesPerHour.toFixed(3),
            lucroMedioBps: result.avgNetProfitBpsWhenViable.toFixed(2),
            maiorLucroBps: result.maxNetProfitBps.toFixed(2),
            lambdaTimesP: result.lambdaTimesP.toFixed(6),
            razaoVsMeta: (result.lambdaTimesP / target).toFixed(2) + 'x',
        });
    }
}

if (require.main === module) {
    main();
}
