// Arquivo: src/bnbFeeDiscount.test.ts
//
// Cobre a regra de desconto de BNB do BinanceExchangeProvider. O ponto
// sensível não é aplicar o desconto — é NÃO aplicar quando o BNB não existe:
// nesse caso a Binance cobra a taxa cheia, e um motor que calcula com a taxa
// descontada aceitaria ciclos marginais que perdem dinheiro de verdade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { BinanceExchangeProvider } from './binanceExchangeProvider';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

/**
 * Constrói um provider com a taxa base fixada por fallbackFeeRate (não há
 * rede nos testes, então loadTradingFee nunca roda) e com fetchAvailableBalance
 * substituído pelo saldo de BNB que o cenário quer exercitar.
 */
function providerWithBnbBalance(
    balance: string | Error,
    options: { bnbFeeDiscount: boolean; minBnbBalanceForDiscount?: string },
): BinanceExchangeProvider {
    const provider = new BinanceExchangeProvider({
        apiKey: 'k',
        apiSecret: 's',
        fallbackFeeRate: '0.001',
        ...options,
    });
    (provider as unknown as { fetchAvailableBalance: (asset: string) => Promise<Decimal> }).fetchAvailableBalance =
        async (asset: string) => {
            assert.equal(asset, 'BNB');
            if (balance instanceof Error) throw balance;
            return new Decimal(balance);
        };
    return provider;
}

test('desconto desligado: taxa efetiva é a taxa base cheia', async () => {
    const provider = providerWithBnbBalance('10', { bnbFeeDiscount: false });
    await provider.applyBnbDiscountIfFunded();
    assert.equal(provider.getFeeRate().toString(), '0.001');
});

test('desconto ligado com BNB suficiente: taxa cai 25% (0.001 -> 0.00075)', async () => {
    const provider = providerWithBnbBalance('0.5', { bnbFeeDiscount: true });
    await provider.applyBnbDiscountIfFunded();
    assert.equal(provider.getFeeRate().toString(), '0.00075');
});

test('desconto ligado mas SEM BNB: mantém a taxa cheia (não assume desconto que a Binance não vai dar)', async () => {
    const provider = providerWithBnbBalance('0', { bnbFeeDiscount: true });
    await provider.applyBnbDiscountIfFunded();
    assert.equal(provider.getFeeRate().toString(), '0.001');
});

test('saldo de BNB abaixo do mínimo exigido: mantém a taxa cheia', async () => {
    const provider = providerWithBnbBalance('0.0005', {
        bnbFeeDiscount: true,
        minBnbBalanceForDiscount: '0.001',
    });
    await provider.applyBnbDiscountIfFunded();
    assert.equal(provider.getFeeRate().toString(), '0.001');
});

test('regressão: BNB acaba durante a operação => taxa volta ao valor cheio', async () => {
    // Primeiro refresh com saldo; segundo refresh já sem saldo.
    let balance = '1';
    const provider = new BinanceExchangeProvider({
        apiKey: 'k',
        apiSecret: 's',
        fallbackFeeRate: '0.001',
        bnbFeeDiscount: true,
    });
    (provider as unknown as { fetchAvailableBalance: () => Promise<Decimal> }).fetchAvailableBalance = async () =>
        new Decimal(balance);

    await provider.applyBnbDiscountIfFunded();
    assert.equal(provider.getFeeRate().toString(), '0.00075', 'com BNB o desconto vale');

    balance = '0';
    await provider.applyBnbDiscountIfFunded();
    assert.equal(
        provider.getFeeRate().toString(),
        '0.001',
        'sem BNB o motor precisa voltar a calcular com a taxa cheia',
    );
});

test('falha ao consultar o saldo: assume o pior caso (taxa cheia), nunca o desconto', async () => {
    const provider = providerWithBnbBalance(new Error('HTTP 401'), { bnbFeeDiscount: true });
    await provider.applyBnbDiscountIfFunded();
    assert.equal(provider.getFeeRate().toString(), '0.001');
});
