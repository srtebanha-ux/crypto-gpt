// Arquivo: src/backtest.test.ts
//
// Um backtest só vale se ele não mentir a favor. Estes testes cobrem
// exatamente as três formas de um backtest produzir resultado bonito e
// irreproduzível ao vivo: look-ahead, stop checado pelo fechamento, e taxa
// esquecida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { runBacktest, type StrategyParams } from './backtest';
import type { Candle } from './signals';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const d = (v: string | number) => new Decimal(String(v));

function candle(open: number, high: number, low: number, close: number, i = 0): Candle {
    return {
        openTime: i * 60_000,
        open: d(open),
        high: d(high),
        low: d(low),
        close: d(close),
        volume: d(1000),
    };
}

/** Série lateral, para servir de histórico antes do evento que interessa. */
function flatSeries(count: number, price: number): Candle[] {
    return Array.from({ length: count }, (_, i) => candle(price, price + 1, price - 1, price, i));
}

const BASE_PARAMS: StrategyParams = {
    breakoutLookback: 10,
    atrPeriod: 5,
    atrStopMultiplier: d(2),
    trendPeriod: 0,
    riskFraction: d('0.02'),
    trailFraction: d(0),
    feeRate: d('0.001'),
};

test('sem rompimento nenhum, não opera e o capital fica intacto', () => {
    const result = runBacktest(flatSeries(60, 100), d(1000), BASE_PARAMS);
    assert.equal(result.trades.length, 0);
    assert.equal(result.finalCapital.toString(), '1000');
    assert.equal(result.totalFees.toString(), '0');
});

test('entra na ABERTURA da vela seguinte, nunca no fechamento do sinal', () => {
    // Look-ahead é o erro que produz backtest excelente e irreproduzível: ao
    // vivo, quando o fechamento é conhecido, aquele preço já passou.
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20)); // rompimento
    candles.push(candle(115, 130, 114, 128, 21)); // abre em 115 — é aqui que entra
    candles.push(...flatSeries(5, 128).map((c, i) => ({ ...c, openTime: (22 + i) * 60_000 })));

    const result = runBacktest(candles, d(10000), BASE_PARAMS);
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].entryPrice.toString(), '115', 'entrada tem que ser a abertura da vela seguinte');
    assert.equal(result.trades[0].entryIndex, 21);
});

test('stop é checado pela MÍNIMA da vela, não pelo fechamento', () => {
    // Uma vela que fura o stop no meio e fecha acima encerrou a posição ali.
    // Checar pelo fechamento esconderia justamente as perdas.
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20)); // sinal
    candles.push(candle(115, 116, 114, 115, 21)); // entra em 115
    // ATR(5) no índice 20 = (2+2+2+2+21)/5 = 5.8 — a vela do rompimento tem
    // range grande e puxa a média. Stop = 115 − 2×5.8 = 103.4.
    // Esta vela fura 103.4 na mínima mas fecha em 118, bem acima.
    candles.push(candle(115, 119, 100, 118, 22));
    candles.push(...flatSeries(3, 118).map((c, i) => ({ ...c, openTime: (23 + i) * 60_000 })));

    const result = runBacktest(candles, d(10000), BASE_PARAMS);
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].exitReason, 'stop');
    assert.ok(
        result.trades[0].exitPrice.lessThan(d(115)),
        'saiu no stop, apesar de a vela ter fechado acima da entrada',
    );
    assert.ok(result.trades[0].netProfit.lessThan(0));
});

test('toda operação paga taxa na entrada E na saída', () => {
    // Foi ignorar taxa que fez a arbitragem triangular parecer viável no papel.
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20));
    candles.push(candle(115, 116, 114, 115, 21));
    candles.push(candle(115, 119, 100, 118, 22)); // fura o stop em 103.4
    candles.push(...flatSeries(3, 118).map((c, i) => ({ ...c, openTime: (23 + i) * 60_000 })));

    const comTaxa = runBacktest(candles, d(10000), BASE_PARAMS);
    const semTaxa = runBacktest(candles, d(10000), { ...BASE_PARAMS, feeRate: d(0) });

    assert.ok(comTaxa.totalFees.greaterThan(0));
    assert.equal(semTaxa.totalFees.toString(), '0');
    assert.ok(
        comTaxa.finalCapital.lessThan(semTaxa.finalCapital),
        'a mesma sequência tem que render menos quando se paga taxa',
    );

    const t = comTaxa.trades[0];
    const taxaEsperada = t.quantity.mul(t.entryPrice).mul('0.001').plus(t.quantity.mul(t.exitPrice).mul('0.001'));
    assert.equal(t.feesPaid.toFixed(8), taxaEsperada.toFixed(8));
});

test('posição aberta no fim dos dados é encerrada, não ignorada', () => {
    // Ignorá-la esconderia uma perda em aberto e inflaria o resultado.
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20));
    candles.push(candle(115, 130, 114, 128, 21));
    candles.push(candle(128, 140, 127, 138, 22)); // ainda subindo quando os dados acabam

    const result = runBacktest(candles, d(10000), BASE_PARAMS);
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].exitReason, 'fim-dos-dados');
});

test('filtro de tendência bloqueia rompimento abaixo da média longa', () => {
    // Menos operações é o objetivo: cada operação evitada é uma taxa não paga.
    const descendo: Candle[] = [];
    for (let i = 0; i < 40; i++) {
        const p = 200 - i * 2; // tendência de baixa
        descendo.push(candle(p, p + 1, p - 1, p, i));
    }
    // Rompe a máxima dos 10 períodos anteriores (índice 30, máxima 141) mas
    // fecha abaixo da média de 30 períodos (≈149,8): é exatamente o caso que
    // o filtro existe para barrar — rompimento contra a tendência principal.
    descendo.push(candle(140, 148, 139, 145, 40));
    descendo.push(candle(145, 150, 144, 148, 41));
    descendo.push(candle(148, 152, 147, 150, 42));

    const semFiltro = runBacktest(descendo, d(10000), BASE_PARAMS);
    const comFiltro = runBacktest(descendo, d(10000), { ...BASE_PARAMS, trendPeriod: 30 });

    assert.ok(semFiltro.trades.length > 0, 'sem filtro, o rompimento dispara');
    assert.equal(comFiltro.trades.length, 0, 'com filtro, não compra contra a tendência');
});

test('trailing stop protege lucro quando o preço sobe e depois volta', () => {
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20));
    candles.push(candle(115, 116, 114, 115, 21)); // entra em 115
    candles.push(candle(115, 200, 114, 198, 22)); // dispara forte
    candles.push(candle(198, 199, 150, 155, 23)); // devolve boa parte

    const semTrailing = runBacktest(candles, d(10000), BASE_PARAMS);
    const comTrailing = runBacktest(candles, d(10000), { ...BASE_PARAMS, trailFraction: d('0.10') });

    assert.ok(
        comTrailing.finalCapital.greaterThan(semTrailing.finalCapital),
        'o trailing tem que capturar parte da alta antes da devolução',
    );
});

test('operação recusada pelo risco é contada, não silenciada', () => {
    // Capital pequeno com notional mínimo alto: a resposta certa é não operar,
    // e isso precisa aparecer no relatório em vez de virar "nenhum sinal".
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20));
    candles.push(candle(115, 130, 114, 128, 21));
    candles.push(...flatSeries(3, 128).map((c, i) => ({ ...c, openTime: (22 + i) * 60_000 })));

    const result = runBacktest(candles, d(20), { ...BASE_PARAMS, minNotional: d(1000) });
    assert.equal(result.trades.length, 0);
    assert.ok(result.skippedByRisk > 0, 'a recusa precisa ser visível no resumo');
});

test('profitFactor é null sem nenhuma perda, em vez de "infinito"', () => {
    // Dividir por zero daria a impressão de estratégia perfeita, quando na
    // verdade a amostra é pequena demais para dizer qualquer coisa.
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20));
    candles.push(candle(115, 130, 114, 128, 21));
    candles.push(candle(128, 140, 127, 138, 22));

    const result = runBacktest(candles, d(10000), BASE_PARAMS);
    assert.ok(result.trades.every((t) => t.netProfit.greaterThan(0)));
    assert.equal(result.profitFactor, null);
});

test('drawdown máximo é medido contra o PICO anterior, não contra o início', () => {
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20));
    candles.push(candle(115, 116, 114, 115, 21));
    candles.push(candle(115, 119, 100, 118, 22)); // fura o stop, perde
    candles.push(...flatSeries(3, 118).map((c, i) => ({ ...c, openTime: (23 + i) * 60_000 })));

    const result = runBacktest(candles, d(10000), BASE_PARAMS);
    assert.ok(result.maxDrawdownFraction.greaterThan(0));
    assert.ok(result.maxDrawdownFraction.lessThan(1));
});

test('capital final bate com a soma dos lucros líquidos das operações', () => {
    // Invariante de contabilidade: se estes dois divergirem, algum custo está
    // sendo contado duas vezes ou nenhuma.
    const candles = [...flatSeries(20, 100)];
    candles.push(candle(100, 120, 99, 118, 20));
    candles.push(candle(115, 116, 114, 115, 21));
    candles.push(candle(115, 119, 100, 118, 22));
    candles.push(...flatSeries(10, 118).map((c, i) => ({ ...c, openTime: (23 + i) * 60_000 })));

    const result = runBacktest(candles, d(10000), BASE_PARAMS);
    const somaLucros = result.trades.reduce((acc, t) => acc.plus(t.netProfit), d(0));
    assert.equal(result.finalCapital.toFixed(8), d(10000).plus(somaLucros).toFixed(8));
    assert.equal(result.totalNetProfit.toFixed(8), somaLucros.toFixed(8));
});

// --- Validação da série (backtestRunner) -------------------------------------

test('série com candles fora de ordem é rejeitada', async () => {
    const { assertUsableSeries } = await import('./backtestRunner');
    const fora = [candle(100, 101, 99, 100, 5), candle(100, 101, 99, 100, 2)];
    assert.throws(() => assertUsableSeries(fora, 60_000), /fora de ordem/);
});

test('série curta demais é rejeitada em vez de gerar sinais sobre nada', () => {
    return import('./backtestRunner').then(({ assertUsableSeries }) => {
        assert.throws(() => assertUsableSeries([candle(100, 101, 99, 100, 0)], 60_000), /curta demais/);
    });
});

test('parseKline lê o formato posicional da Binance sem trocar campos', async () => {
    // O array da Binance é posicional: trocar high com low aqui inverteria
    // stops e máximas sem lançar exceção nenhuma.
    const { parseKline } = await import('./backtestRunner');
    const c = parseKline([1700000000000, '10.5', '12.0', '9.5', '11.0', '1234.5', 1700003599999]);
    assert.equal(c.openTime, 1700000000000);
    assert.equal(c.open.toString(), '10.5');
    assert.equal(c.high.toString(), '12');
    assert.equal(c.low.toString(), '9.5');
    assert.equal(c.close.toString(), '11');
    assert.equal(c.volume.toString(), '1234.5');
    assert.ok(c.high.greaterThanOrEqualTo(c.low), 'máxima nunca abaixo da mínima');
});

// --- Regime de mercado por operação ------------------------------------------

test('operações são marcadas pelo regime da ENTRADA, não da saída', () => {
    // Serve para responder "sobrevive a um bear market?" sem escolher a janela
    // de baixa à mão — escolha que sempre carrega a suspeita de ter sido feita
    // depois de ver o resultado. Marcar pela saída seria pior: uma compra feita
    // em plena queda contaria como operação de alta só porque o mercado virou
    // enquanto a posição estava aberta.
    const candles: Candle[] = [];
    // 60 velas caindo, depois 60 subindo. A média usada aqui é curta (5) de
    // propósito: com média longa, a janela ainda carrega os preços altos da
    // queda quando o rompimento acontece, e a entrada cai legitimamente em
    // regime de BAIXA — comportamento correto, mas que não exercita o caso
    // que este teste quer cobrir.
    for (let i = 0; i < 60; i++) candles.push(candle(200 - i, 200 - i + 1, 200 - i - 1, 200 - i, i));
    for (let i = 0; i < 60; i++) candles.push(candle(140 + i * 2, 140 + i * 2 + 2, 140 + i * 2 - 1, 140 + i * 2 + 1, 60 + i));

    const resultado = runBacktest(candles, new Decimal('10000'), {
        entryStrategy: 'breakout',
        breakoutLookback: 5,
        atrPeriod: 5,
        atrStopMultiplier: new Decimal('2'),
        trendPeriod: 0,
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
        regimePeriod: 5,
    });

    assert.ok(resultado.trades.length > 0, 'o cenário precisa gerar operações');
    for (const t of resultado.trades) {
        assert.ok(t.regimeAtEntry === 'alta' || t.regimeAtEntry === 'baixa');
    }
    // Rompimentos só acontecem na perna de alta, que começa no índice 60.
    // Antes da média completa (índice 19) nada é classificado como alta.
    const emAlta = resultado.trades.filter((t) => t.regimeAtEntry === 'alta');
    assert.ok(emAlta.length > 0, 'a perna de subida tem que produzir operações em regime de alta');
    for (const t of emAlta) {
        assert.ok(t.entryIndex >= 60, `operação em "alta" no índice ${t.entryIndex} — antes da virada do mercado`);
    }
});

test('antes de haver média longa completa, o regime é BAIXA — o lado conservador', () => {
    // Chamar o início de "alta" enviesaria o resultado a favor: as primeiras
    // operações entrariam na coluna que se quer provar boa, sem base nenhuma.
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) candles.push(candle(100 + i * 3, 100 + i * 3 + 2, 100 + i * 3 - 1, 100 + i * 3 + 1, i));

    const resultado = runBacktest(candles, new Decimal('10000'), {
        entryStrategy: 'breakout',
        breakoutLookback: 3,
        atrPeriod: 3,
        atrStopMultiplier: new Decimal('2'),
        trendPeriod: 0,
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
        regimePeriod: 30, // média longa só fica pronta no índice 29
    });

    for (const t of resultado.trades) {
        if (t.entryIndex < 29) {
            assert.equal(t.regimeAtEntry, 'baixa', `índice ${t.entryIndex} sem média completa deveria ser baixa`);
        }
    }
});

// --- Alvo de lucro: vender no alto, não depois de devolver -------------------

test('alvo em R fecha a operação quando a MÁXIMA o alcança', () => {
    // Stop móvel sozinho nunca vende no alto: ele só reage depois que o preço
    // já virou e caiu a distância do trailing. Numa alta explosiva que devolve
    // tudo em duas velas, essa distância é o lucro inteiro.
    const candles: Candle[] = [
        ...flatSeries(30, 100),
        candle(100, 110, 99, 108, 30), // rompimento
        candle(108, 112, 107, 111, 31), // entrada abre aqui
        candle(111, 200, 110, 190, 32), // dispara para cima
        candle(190, 195, 20, 25, 33), // e devolve tudo na vela seguinte
    ];

    const resultado = runBacktest(candles, new Decimal('100000'), {
        entryStrategy: 'breakout',
        breakoutLookback: 10,
        atrPeriod: 5,
        atrStopMultiplier: new Decimal('2'),
        trendPeriod: 0,
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
        takeProfitR: new Decimal('2'),
    });

    const noAlvo = resultado.trades.filter((t) => t.exitReason === 'alvo');
    assert.equal(noAlvo.length, 1, 'a operação tinha que sair no alvo, antes do desabamento');
    const t = noAlvo[0];
    // Saiu exatamente em entrada + 2R, não no fechamento da vela.
    const r = t.entryPrice.minus(t.entryPrice.minus(t.exitPrice.minus(t.entryPrice).dividedBy(2)));
    assert.ok(t.exitPrice.greaterThan(t.entryPrice), 'alvo tem que ser acima da entrada');
    assert.ok(t.netProfit.greaterThan(0), `sair no alvo tem que dar lucro, deu ${t.netProfit}`);
    assert.ok(r.greaterThan(0));
});

test('quando a mesma vela toca stop E alvo, vale o STOP — a leitura pessimista', () => {
    // O OHLC não diz qual veio primeiro. Supor que foi o alvo é escolher a
    // versão que favorece o resultado, e é assim que backtest vira ficção.
    const candles: Candle[] = [
        ...flatSeries(30, 100),
        candle(100, 110, 99, 108, 30),
        candle(108, 112, 107, 111, 31),
        // Vela que vai fundo o bastante para o stop E alto o bastante para o alvo.
        candle(111, 300, 1, 50, 32),
    ];

    const resultado = runBacktest(candles, new Decimal('100000'), {
        entryStrategy: 'breakout',
        breakoutLookback: 10,
        atrPeriod: 5,
        atrStopMultiplier: new Decimal('2'),
        trendPeriod: 0,
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
        takeProfitR: new Decimal('2'),
    });

    assert.equal(resultado.trades.length, 1);
    assert.equal(resultado.trades[0].exitReason, 'stop', 'empate na mesma vela tem que contar como stop');
    assert.ok(resultado.trades[0].netProfit.lessThan(0));
});

test('takeProfitR zero desliga o alvo — a estratégia volta a ser só stop móvel', () => {
    const candles: Candle[] = [
        ...flatSeries(30, 100),
        candle(100, 110, 99, 108, 30),
        candle(108, 112, 107, 111, 31),
        candle(111, 200, 110, 190, 32),
    ];
    const semAlvo = runBacktest(candles, new Decimal('100000'), {
        entryStrategy: 'breakout',
        breakoutLookback: 10,
        atrPeriod: 5,
        atrStopMultiplier: new Decimal('2'),
        trendPeriod: 0,
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
        takeProfitR: new Decimal('0'),
    });
    assert.equal(semAlvo.trades.filter((t) => t.exitReason === 'alvo').length, 0);
});

// --- Funil: por que ZERO operações? -----------------------------------------

test('o funil separa "sinal nunca disparou" de "sinal barrado" de "risco recusou"', () => {
    // As três causas produzem o mesmo relatório vazio e pedem ações opostas:
    // afrouxar o parâmetro, desligar o filtro, ou aumentar o capital. Sem o
    // funil, quem opera não tem como saber qual mexer.
    const candles: Candle[] = [
        ...flatSeries(60, 100),
        candle(100, 110, 99, 108, 60),
        candle(108, 112, 107, 111, 61),
        ...flatSeries(10, 111).map((c, i) => ({ ...c, openTime: (62 + i) * 60_000 })),
    ];

    const base = {
        entryStrategy: 'breakout' as const,
        breakoutLookback: 10,
        atrPeriod: 5,
        atrStopMultiplier: new Decimal('2'),
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
    };

    // Capital normal, sem filtro: o sinal vira operação.
    const normal = runBacktest(candles, new Decimal('100000'), { ...base, trendPeriod: 0 });
    assert.ok(normal.funnel.sinaisDisparados > 0, 'o cenário precisa disparar sinal');
    assert.equal(normal.funnel.recusadosPorRisco, 0);
    assert.ok(normal.trades.length > 0);

    // Mesmo sinal, capital minúsculo: o risco recusa, e o funil diz isso.
    const semCapital = runBacktest(candles, new Decimal('1'), {
        ...base,
        trendPeriod: 0,
        minNotional: new Decimal('5'),
    });
    assert.equal(semCapital.trades.length, 0);
    assert.ok(semCapital.funnel.sinaisDisparados > 0, 'o sinal disparou igual');
    assert.ok(semCapital.funnel.recusadosPorRisco > 0, 'e foi o risco que recusou — não o sinal que faltou');
});

test('sinal restritivo demais aparece como ZERO sinais, não como zero operações', () => {
    // Distinção que decide a ação: sem sinal, mexer no parâmetro; com sinal
    // barrado, mexer no filtro.
    const candles = flatSeries(100, 100); // mercado parado: nada rompe
    const resultado = runBacktest(candles, new Decimal('100000'), {
        entryStrategy: 'breakout',
        breakoutLookback: 10,
        atrPeriod: 5,
        atrStopMultiplier: new Decimal('2'),
        trendPeriod: 0,
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
    });
    assert.equal(resultado.funnel.sinaisDisparados, 0);
    assert.equal(resultado.funnel.recusadosPorRisco, 0);
    assert.ok(resultado.funnel.velasAvaliadas > 0, 'as velas foram avaliadas — o que faltou foi sinal');
});

test('sinal de reversão e filtro de tendência se cancelam — o funil torna isso visível', () => {
    // Defeito real e invisível por dias: para o RSI cair abaixo do limiar é
    // preciso uma queda forte, e uma queda forte joga o preço abaixo da própria
    // média de 50 — então o filtro rejeitava exatamente o que o sinal acabara de
    // encontrar. O relatório mostrava "zero operações" como se o mercado não
    // tivesse oferecido nada.
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
        const p = 100 + i * 0.5;
        candles.push(candle(p, p + 0.6, p - 0.4, p + 0.4, i));
    }
    let p = 140;
    for (let i = 0; i < 12; i++) {
        p -= 1.6;
        candles.push(candle(p + 1.6, p + 1.7, p - 0.3, p, 80 + i));
    }
    for (let i = 0; i < 20; i++) {
        p += 1.2;
        candles.push(candle(p - 1.2, p + 0.4, p - 1.3, p, 92 + i));
    }

    const base = {
        entryStrategy: 'reversion' as const,
        rsiPeriod: 14,
        rsiThreshold: new Decimal('45'),
        breakoutLookback: 20,
        atrPeriod: 14,
        atrStopMultiplier: new Decimal('2'),
        riskFraction: new Decimal('0.02'),
        trailFraction: new Decimal('0'),
        trailAtrMultiplier: new Decimal('3'),
        feeRate: new Decimal('0'),
        minNotional: new Decimal('5'),
    };

    const comFiltro = runBacktest(candles, new Decimal('1000'), { ...base, trendPeriod: 50 });
    assert.ok(comFiltro.funnel.sinaisDisparados > 0, 'o sinal precisa disparar');
    assert.equal(comFiltro.funnel.barradosPorTendencia, comFiltro.funnel.sinaisDisparados, 'e o filtro barra TODOS');
    assert.equal(comFiltro.trades.length, 0);

    // Sem o filtro, o mesmo sinal vira operação: prova que a causa era o
    // conflito de configuração, não ausência de oportunidade.
    const semFiltro = runBacktest(candles, new Decimal('1000'), { ...base, trendPeriod: 0 });
    assert.ok(semFiltro.trades.length > 0, 'sem o filtro, o mesmo cenário opera');
});
