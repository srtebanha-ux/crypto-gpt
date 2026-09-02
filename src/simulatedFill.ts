// Arquivo: src/simulatedFill.ts
//
// Núcleo de contabilidade de taxa/netProceeds compartilhado pelos dois
// providers SINTÉTICOS do projeto (MockExchangeProvider, para a demo, e
// SimulatedExchangeProvider, para paper trading) — nunca usado pelo
// conector real da Binance, que calcula netProceeds a partir de comissões
// REAIS devolvidas pela corretora (ver binanceExchangeProvider.ts). Extraído
// pra um único lugar porque as duas implementações reimplementavam a mesma
// fórmula separadamente, arriscando divergir silenciosamente numa mudança
// futura de modelo de taxa (ex.: desconto BNB, distinção maker/taker).
import { Decimal } from 'decimal.js';
import { OrderSide } from './types';

export interface SimulatedFill {
    netProceeds: Decimal;
    feePaid: Decimal;
    feePaidAsset: string;
}

/**
 * Simula o líquido de taxa de uma ordem preenchida por completo, no mesmo
 * lado em que a Binance realmente cobra (ativo-base para BUY, ativo-cotação
 * para SELL) — ver a nota sobre `netProceeds` em types.ts.
 */
export function simulateNetFill(pairSymbol: string, side: OrderSide, qty: Decimal, fillPrice: Decimal, feeRate: Decimal): SimulatedFill {
    const [baseAsset, quoteAsset] = pairSymbol.split('/');
    const feeFactor = new Decimal(1).minus(feeRate);

    if (side === 'BUY') {
        return {
            netProceeds: qty.mul(feeFactor),
            feePaid: qty.mul(feeRate),
            feePaidAsset: baseAsset,
        };
    }

    const grossQuote = qty.mul(fillPrice);
    return {
        netProceeds: grossQuote.mul(feeFactor),
        feePaid: grossQuote.mul(feeRate),
        feePaidAsset: quoteAsset,
    };
}
