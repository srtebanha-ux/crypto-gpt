// Arquivo: src/marketMicrostructure.ts
//
// Modelagem de impacto no book: em vez de assumir preenchimento integral no
// topo do book (só válido quando a ordem é ínfima frente à liquidez do
// nível 1), caminha os níveis reais do order book para estimar o preço
// médio de execução — o mesmo princípio que algoritmos de execução
// institucionais usam para orçar slippage antes de disparar uma ordem.
import { Decimal } from 'decimal.js';
import { OrderBookLevel } from './types';

export interface VwapFillEstimate {
    /** Preço médio ponderado por volume dos níveis efetivamente consumidos. */
    avgPrice: Decimal;
    /** Quantidade que o book conseguiria preencher (== targetQty quando fullyFilled). */
    filledQty: Decimal;
    /** false quando a profundidade informada não é suficiente para cobrir targetQty. */
    fullyFilled: boolean;
    /**
     * Preço do nível mais desfavorável realmente consumido — NUNCA usar
     * `avgPrice` como preço-limite de uma ordem LIMIT real: uma ordem LIMIT
     * só combina contra níveis a esse preço ou melhor, e `avgPrice` (a média
     * ponderada) é sempre melhor que o pior nível caminhado, então uma
     * ordem limitada em `avgPrice` preencheria MENOS do que este resultado
     * assume. `worstPriceTouched` é o preço-limite correto para reproduzir
     * este mesmo preenchimento numa ordem real.
     */
    worstPriceTouched: Decimal;
}

/**
 * Caminha `levels` (assumidos já ordenados do melhor para o pior preço, como
 * chegam de um order book real) somando quantidade e notional até atingir
 * `targetQty`:
 *
 *   VWAP = Σ(price_i · qty_i) / Σ(qty_i),  i sobre os níveis consumidos
 *
 * O último nível consumido é parcialmente utilizado (clipado ao restante
 * necessário via min(qty_i, remaining)) — a função nunca assume mais
 * liquidez do que os níveis informados realmente oferecem.
 */
export function estimateVwapFill(levels: OrderBookLevel[], targetQty: Decimal): VwapFillEstimate {
    if (!targetQty.greaterThan(0)) {
        return { avgPrice: new Decimal(0), filledQty: new Decimal(0), fullyFilled: true, worstPriceTouched: new Decimal(0) };
    }

    let remaining = targetQty;
    let notional = new Decimal(0);
    let filled = new Decimal(0);
    let worstPriceTouched = new Decimal(0);

    for (const level of levels) {
        if (remaining.lessThanOrEqualTo(0)) break;
        if (level.qty.lessThanOrEqualTo(0) || level.price.lessThanOrEqualTo(0)) continue;

        const consumed = Decimal.min(level.qty, remaining);
        notional = notional.plus(consumed.mul(level.price));
        filled = filled.plus(consumed);
        remaining = remaining.minus(consumed);
        worstPriceTouched = level.price;
    }

    return {
        avgPrice: filled.isZero() ? new Decimal(0) : notional.dividedBy(filled),
        filledQty: filled,
        fullyFilled: remaining.lessThanOrEqualTo(0),
        worstPriceTouched,
    };
}
