// Arquivo: src/smokeTestOrder.ts
//
// Teste de fumaça do MECANISMO de execução real: conecta na Binance, compra
// uma quantidade pequena de BTC/USDT a mercado e imediatamente vende de
// volta — sem depender de nenhuma divergência de triângulo. O objetivo NÃO
// é lucro (nem faz sentido ter, já que é uma ida-e-volta no mesmo par); é
// validar que o caminho enviar ordem -> ler resposta da Binance -> calcular
// netProceeds/feePaid funciona de verdade, usando o MESMO
// BinanceExchangeProvider.executeOrder que o engine real usa — sem esperar
// o mercado cooperar com uma ineficiência.
//
// Por padrão roda contra o Spot Testnet (dinheiro fictício). Só envia
// ordens reais se BINANCE_LIVE=true estiver setado — mesmo gate de
// segurança do live.ts, e não recomendado usar esse script contra produção
// (é só um smoke test, não um teste de lucratividade).
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { BinanceExchangeProvider } from './binanceExchangeProvider';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const log = createLogger('smoke-test');

async function main() {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error('Defina BINANCE_API_KEY e BINANCE_API_SECRET no ambiente antes de rodar este script.');
    }
    const live = process.env.BINANCE_LIVE === 'true';
    // ~$10-15 de BTC ao preço típico — margem confortável acima do
    // MIN_NOTIONAL usual da Binance ($5-10), configurável se precisar ajustar.
    const qty = new Decimal(process.env.SMOKE_TEST_BTC_QTY ?? '0.0002');

    log.info(`Iniciando teste de fumaça de execução em modo ${live ? 'LIVE — DINHEIRO REAL' : 'TESTNET'}.`, { qtyBtc: qty.toString() });

    const exchange = new BinanceExchangeProvider({ apiKey, apiSecret, live });
    await exchange.connect();

    log.info('Conectado. Comprando BTC/USDT a mercado...');
    const buy = await exchange.executeOrder('BTC/USDT', 'BUY', 'MARKET', qty);
    log.info('Compra concluída — mecanismo de execução (enviar ordem -> ler resposta -> netProceeds) validado no lado BUY.', {
        orderId: buy.orderId,
        status: buy.status,
        executedPrice: buy.executedPrice.toString(),
        executedQty: buy.executedQty.toString(),
        netProceeds: buy.netProceeds.toString(),
        feePaid: buy.feePaid.toString(),
        feePaidAsset: buy.feePaidAsset,
    });

    log.info('Vendendo de volta o BTC líquido recebido (fecha a posição)...');
    const sell = await exchange.executeOrder('BTC/USDT', 'SELL', 'MARKET', buy.netProceeds);
    log.info('Venda concluída — mecanismo de execução validado no lado SELL também.', {
        orderId: sell.orderId,
        status: sell.status,
        executedPrice: sell.executedPrice.toString(),
        executedQty: sell.executedQty.toString(),
        netProceeds: sell.netProceeds.toString(),
        feePaid: sell.feePaid.toString(),
        feePaidAsset: sell.feePaidAsset,
    });

    const usdtGasto = buy.executedQty.mul(buy.executedPrice);
    const usdtRecebido = sell.netProceeds;
    log.info('=== TESTE DE FUMAÇA CONCLUÍDO COM SUCESSO ===', {
        usdtGastoAproximado: usdtGasto.toFixed(2),
        usdtRecebidoDeVolta: usdtRecebido.toFixed(2),
        diferenca: usdtRecebido.minus(usdtGasto).toFixed(2),
        nota: 'a diferença negativa aqui é esperada — é taxa das 2 pernas de ida-e-volta, não uma perda de estratégia.',
    });

    exchange.shutdown();
    process.exit(0);
}

// Guardado como os demais executáveis do projeto: sem isto, qualquer
// `import` deste módulo (inclusive de um teste) dispararia a medição de
// verdade, indo à rede no meio da suíte.
if (require.main === module) {
    main().catch((err) => {
        log.error('Falha no teste de fumaça de execução.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
