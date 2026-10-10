// Arquivo: src/ammMath.ts
//
// Matemática de AMM de produto constante (x·y=k, padrão Uniswap V2 e seus
// forks — Aerodrome na Base, Camelot na Arbitrum etc.) e busca do tamanho
// ótimo de uma arbitragem cíclica.
//
// Por que produto constante e não liquidez concentrada (Uniswap V3): a curva
// de V3 exige percorrer ticks e é uma ordem de grandeza mais complexa. Como
// esta é uma ferramenta de MEDIÇÃO — responder "existe oportunidade?" antes
// de escrever contrato nenhum — um piso conservador sobre pools V2 responde a
// pergunta. Se a resposta for "não existe nem aqui", V3 não salvaria.
//
// Nada aqui faz I/O: tudo função pura, testável sem rede e sem RPC.
import { Decimal } from 'decimal.js';

/** Um hop do ciclo: um pool, com as reservas na direção do swap. */
export interface Hop {
    /** Reserva do token que ENTRA neste pool. */
    reserveIn: Decimal;
    /** Reserva do token que SAI deste pool. */
    reserveOut: Decimal;
    /** Taxa do pool em fração (0.003 = 0,3%, padrão Uniswap V2). */
    feeFraction: Decimal;
}

/**
 * Fórmula de saída do produto constante com taxa:
 *
 *   dy = (y · dx · γ) / (x + dx · γ),  onde γ = 1 - taxa
 *
 * A taxa incide sobre a ENTRADA (é assim que V2 implementa), por isso γ
 * multiplica dx nos dois lugares — e não o resultado no fim.
 */
export function getAmountOut(amountIn: Decimal, hop: Hop): Decimal {
    if (amountIn.lessThanOrEqualTo(0)) return new Decimal(0);
    if (hop.reserveIn.lessThanOrEqualTo(0) || hop.reserveOut.lessThanOrEqualTo(0)) return new Decimal(0);

    const amountInWithFee = amountIn.mul(new Decimal(1).minus(hop.feeFraction));
    const numerator = hop.reserveOut.mul(amountInWithFee);
    const denominator = hop.reserveIn.plus(amountInWithFee);
    return numerator.dividedBy(denominator);
}

/** Encadeia os hops: a saída de um é a entrada do seguinte. */
export function simulateCycle(amountIn: Decimal, hops: Hop[]): Decimal {
    let amount = amountIn;
    for (const hop of hops) {
        amount = getAmountOut(amount, hop);
        if (amount.lessThanOrEqualTo(0)) return new Decimal(0);
    }
    return amount;
}

/** Lucro bruto do ciclo (ainda sem taxa de flash loan e sem gas). */
export function grossCycleProfit(amountIn: Decimal, hops: Hop[]): Decimal {
    return simulateCycle(amountIn, hops).minus(amountIn);
}

export interface OptimalCycle {
    /** Valor de entrada que maximiza o lucro bruto. */
    amountIn: Decimal;
    grossProfit: Decimal;
}

/**
 * Acha o tamanho de entrada que maximiza o lucro do ciclo.
 *
 * Usa busca ternária em vez da fórmula fechada de propósito. A forma fechada
 * para 2 pools existe, mas erra fácil e não generaliza para 3+ hops nem para
 * taxas diferentes por pool — e um erro aqui não aparece como exceção, aparece
 * como um número plausível e errado, que é o pior modo de falha numa
 * ferramenta cuja função é decidir se vale investir semanas construindo o
 * resto. A busca ternária é obviamente correta sobre função unimodal, e o
 * lucro É unimodal em `amountIn`: sobe enquanto a ineficiência compensa o
 * slippage, e cai depois disso.
 *
 * `maxAmountIn` deve refletir o teto real (liquidez do flash loan, ou uma
 * fração das reservas) — a busca nunca propõe acima disso.
 */
export function findOptimalCycleInput(hops: Hop[], maxAmountIn: Decimal, iterations = 200): OptimalCycle {
    if (hops.length === 0 || maxAmountIn.lessThanOrEqualTo(0)) {
        return { amountIn: new Decimal(0), grossProfit: new Decimal(0) };
    }

    let low = new Decimal(0);
    let high = maxAmountIn;
    for (let i = 0; i < iterations; i++) {
        const third = high.minus(low).dividedBy(3);
        const m1 = low.plus(third);
        const m2 = high.minus(third);
        if (grossCycleProfit(m1, hops).lessThan(grossCycleProfit(m2, hops))) {
            low = m1;
        } else {
            high = m2;
        }
    }

    const amountIn = low.plus(high).dividedBy(2);
    const grossProfit = grossCycleProfit(amountIn, hops);

    // Um ciclo sem ineficiência tem ótimo em zero: a busca converge para um
    // valor minúsculo com lucro negativo. Reportar isso como "oportunidade de
    // tamanho ~0" seria ruído; reportar zero é a leitura honesta.
    if (grossProfit.lessThanOrEqualTo(0)) {
        return { amountIn: new Decimal(0), grossProfit: new Decimal(0) };
    }
    return { amountIn, grossProfit };
}

export interface FlashLoanCosts {
    /** Taxa do flash loan em fração (Aave V3 = 0.0005; Balancer = 0). */
    flashLoanFeeFraction: Decimal;
    /** Custo de gas da transação, JÁ convertido para o token do ciclo. */
    gasCostInToken: Decimal;
}

export interface CycleEvaluation {
    amountIn: Decimal;
    grossProfit: Decimal;
    flashLoanFee: Decimal;
    gasCost: Decimal;
    netProfit: Decimal;
    /** Se vale executar de verdade: lucro líquido estritamente positivo. */
    profitable: boolean;
}

/**
 * Avalia o ciclo já descontando o que a execução real cobra.
 *
 * O gas é custo FIXO por tentativa, e é ele que define o piso de tamanho: uma
 * arbitragem de $0,30 de lucro bruto é inexecutável se o gas custa $0,50, por
 * mais real que a ineficiência seja. Ignorar isso é exatamente o erro que fez
 * a arbitragem triangular parecer viável no papel.
 */
export function evaluateCycle(hops: Hop[], maxAmountIn: Decimal, costs: FlashLoanCosts): CycleEvaluation {
    const optimal = findOptimalCycleInput(hops, maxAmountIn);
    const flashLoanFee = optimal.amountIn.mul(costs.flashLoanFeeFraction);
    const netProfit = optimal.grossProfit.minus(flashLoanFee).minus(costs.gasCostInToken);

    return {
        amountIn: optimal.amountIn,
        grossProfit: optimal.grossProfit,
        flashLoanFee,
        gasCost: costs.gasCostInToken,
        netProfit,
        profitable: netProfit.greaterThan(0),
    };
}

/**
 * Preço marginal (spot) do pool, sem slippage e sem taxa: reserveOut/reserveIn.
 *
 * Serve como filtro barato ANTES da otimização: se o produto dos preços do
 * ciclo, já descontadas as taxas, não passa de 1, não existe ciclo lucrativo
 * de tamanho nenhum e nem vale rodar a busca. Com centenas de pools, a
 * diferença entre filtrar aqui e otimizar tudo é a diferença entre um scan
 * viável e um inviável.
 */
export function spotPrice(hop: Hop): Decimal {
    if (hop.reserveIn.lessThanOrEqualTo(0)) return new Decimal(0);
    return hop.reserveOut.dividedBy(hop.reserveIn);
}

/**
 * Produto dos preços spot do ciclo já com as taxas — o teste rápido de
 * viabilidade. > 1 significa que existe ineficiência explorável em tamanho
 * infinitesimal; quanto ela suporta em tamanho real é o que a otimização diz.
 */
export function cycleSpotRatio(hops: Hop[]): Decimal {
    let ratio = new Decimal(1);
    for (const hop of hops) {
        ratio = ratio.mul(spotPrice(hop)).mul(new Decimal(1).minus(hop.feeFraction));
    }
    return ratio;
}
