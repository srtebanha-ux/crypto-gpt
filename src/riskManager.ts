// Arquivo: src/riskManager.ts
import { Decimal } from 'decimal.js';
import { OrderBookLevel } from './types';
import { estimateVwapFill } from './marketMicrostructure';

export interface ViabilityResult {
    viable: boolean;
    expectedNetProfit: Decimal;
}

export interface DepthViabilityResult extends ViabilityResult {
    /** false se a profundidade informada não sustentaria o ciclo inteiro ao preço estimado. */
    fullyFilled: boolean;
}

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
    ): ViabilityResult {
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

    /**
     * Confirmação "assertiva" de viabilidade: em vez de assumir preenchimento
     * integral no topo do book (válido só quando a ordem é ínfima frente à
     * liquidez do nível 1), caminha a profundidade real de cada perna via
     * `estimateVwapFill` e recalcula o retorno líquido sobre o preço médio
     * de execução resultante — o mesmo encadeamento de `netProceeds` que o
     * engine usa de verdade (BUY líquida no ativo-base, SELL líquida no
     * ativo-cotação), só que projetado a partir do book em vez do fill real.
     *
     * A quantidade-alvo de cada perna de COMPRA é aproximada em primeira
     * ordem pelo topo do book (capital / melhor ask) — uma única passada,
     * sem iterar até ponto fixo, para caber no orçamento de latência de
     * HFT; para Q pequeno frente à liquidez do nível 1 (o caso de uso deste
     * projeto) o erro dessa aproximação é desprezível quando o book tem
     * profundidade suficiente no topo.
     *
     * Quando NÃO tem: caminhar níveis piores para preencher essa mesma
     * quantidade-alvo custa mais caro do que o orçamento disponível (o
     * capital em USDT na perna 1, o BTC líquido recebido na perna 2) — por
     * isso `fullyFilled` também vira `false` se o notional realmente gasto
     * (`filledQty * avgPrice`) excede esse orçamento, e não só quando a
     * profundidade informada é insuficiente para a quantidade-alvo. Sem essa
     * checagem, o formato "caminhe até preencher X" ignoraria que gastar
     * mais para obter o mesmo X drena capital que o resto do ciclo não tem
     * como recuperar.
     */
    public isTriangularArbitrageViableWithDepth(
        initialCapital: Decimal,
        asksLeg1: OrderBookLevel[],
        asksLeg2: OrderBookLevel[],
        bidsLeg3: OrderBookLevel[],
        feeRate: Decimal
    ): DepthViabilityResult {
        if (initialCapital.greaterThan(this.maxCapitalAllocated)) {
            return { viable: false, expectedNetProfit: new Decimal(0), fullyFilled: false };
        }
        const topAsk1 = asksLeg1[0]?.price;
        if (!topAsk1 || !topAsk1.greaterThan(0)) {
            return { viable: false, expectedNetProfit: new Decimal(0), fullyFilled: false };
        }

        const feeFactor = new Decimal(1).minus(feeRate);

        // Perna 1: BUY BTC/USDT — qty aproximada em 1ª ordem pelo topo do book.
        const qty1Approx = initialCapital.dividedBy(topAsk1);
        const fill1 = estimateVwapFill(asksLeg1, qty1Approx);
        const notional1 = fill1.filledQty.mul(fill1.avgPrice);
        const budgetOk1 = notional1.lessThanOrEqualTo(initialCapital);
        const netBtc = fill1.filledQty.mul(feeFactor);

        // Perna 2: BUY ETH/BTC — qty aproximada pelo topo do book usando o BTC líquido da perna 1.
        const topAsk2 = asksLeg2[0]?.price;
        if (!topAsk2 || !topAsk2.greaterThan(0) || netBtc.lessThanOrEqualTo(0)) {
            return { viable: false, expectedNetProfit: new Decimal(0), fullyFilled: false };
        }
        const qty2Approx = netBtc.dividedBy(topAsk2);
        const fill2 = estimateVwapFill(asksLeg2, qty2Approx);
        const notional2 = fill2.filledQty.mul(fill2.avgPrice);
        const budgetOk2 = notional2.lessThanOrEqualTo(netBtc);
        const netEth = fill2.filledQty.mul(feeFactor);

        // Perna 3: SELL ETH/USDT — quantidade exata (não é aproximação: é o que de fato se tem para vender).
        const fill3 = estimateVwapFill(bidsLeg3, netEth);
        const netUsdt = fill3.filledQty.mul(fill3.avgPrice).mul(feeFactor);

        const expectedNetProfit = netUsdt.minus(initialCapital);
        const minAcceptableReturn = initialCapital.mul(new Decimal(1).plus(this.maxSlippageTolerance));
        const fullyFilled = fill1.fullyFilled && fill2.fullyFilled && fill3.fullyFilled && budgetOk1 && budgetOk2;
        const viable = fullyFilled && netUsdt.greaterThan(minAcceptableReturn);

        return { viable, expectedNetProfit, fullyFilled };
    }
}
