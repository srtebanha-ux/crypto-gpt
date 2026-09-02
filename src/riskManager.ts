// Arquivo: src/riskManager.ts
import { Decimal } from 'decimal.js';

// ============================================================================
// RISK MANAGER (Kill Switch e Validação de Estado)
// ============================================================================
export class RiskManager {
    private maxCapitalAllocated: Decimal;
    private maxSlippageTolerance: Decimal;

    constructor(capital: string, slippageTolerance: string) {
        this.maxCapitalAllocated = new Decimal(capital);
        this.maxSlippageTolerance = new Decimal(slippageTolerance);
    }

    public isTriangularArbitrageViable(
        initialCapital: Decimal,
        p1Ask: Decimal,
        p2Ask: Decimal,
        p3Bid: Decimal,
        feeRate: Decimal
    ): { viable: boolean; expectedNetProfit: Decimal } {
        if (initialCapital.greaterThan(this.maxCapitalAllocated)) {
            return { viable: false, expectedNetProfit: new Decimal(0) };
        }
        // Kill switch de sanidade: preços não positivos (feed corrompido,
        // símbolo desconhecido, book vazio) nunca devem passar para a divisão
        // — sem isso, dividedBy(0) do decimal.js retorna Infinity em vez de
        // lançar, e isViable acabaria "true" por um dado inválido. Nota:
        // `Decimal.isPositive()` considera 0 positivo, por isso o teste
        // explícito de "> 0" abaixo em vez de usá-lo.
        if (!p1Ask.greaterThan(0) || !p2Ask.greaterThan(0) || !p3Bid.greaterThan(0)) {
            return { viable: false, expectedNetProfit: new Decimal(0) };
        }

        // Fator de retenção por perna = (1 - fee)
        const retentionRate = new Decimal(1).minus(feeRate);
        const retentionCubed = retentionRate.pow(3);

        // Q1 (USDT -> BTC) = (C0 / Ask1)
        const q1 = initialCapital.dividedBy(p1Ask);
        // Q2 (BTC -> ETH) = (Q1 / Ask2)
        const q2 = q1.dividedBy(p2Ask);
        // Q3 (ETH -> USDT) = (Q2 * Bid3)
        const grossReturn = q2.mul(p3Bid);

        const netReturn = grossReturn.mul(retentionCubed);
        const expectedNetProfit = netReturn.minus(initialCapital);

        // Kill Switch Inequality: Net Return > Capital + Slippage Margin
        const minAcceptableReturn = initialCapital.mul(new Decimal(1).plus(this.maxSlippageTolerance));
        const isViable = netReturn.greaterThan(minAcceptableReturn);

        return { viable: isViable, expectedNetProfit };
    }
}
