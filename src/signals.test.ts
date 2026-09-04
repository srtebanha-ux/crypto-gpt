// Arquivo: src/signals.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    atr,
    detectBreakout,
    detectMomentumSurge,
    detectOversoldReversion,
    highestHighBefore,
    isAboveTrend,
    lowestLowBefore,
    rsi,
    rsiSeries,
    sma,
    trueRange,
    volumeRatio,
    type Candle,
} from './signals';

/** Igual a `candle`, mas com volume explícito — a família `momentum` depende dele. */
function vela(open: number, high: number, low: number, close: number, i: number, volume: number): Candle {
    return { openTime: i * 60_000, open: d(open), high: d(high), low: d(low), close: d(close), volume: d(volume) };
}

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const d = (v: string | number) => new Decimal(String(v));

function candle(open: number, high: number, low: number, close: number, i = 0): Candle {
    return { openTime: i * 60_000, open: d(open), high: d(high), low: d(low), close: d(close), volume: d(1) };
}

/** Série a partir de fechamentos, com máx/mín coladas — isola o indicador. */
function fromCloses(closes: number[]): Candle[] {
    return closes.map((c, i) => candle(c, c + 0.5, c - 0.5, c, i));
}

// --- Médias e extremos ------------------------------------------------------

test('sma devolve null sem histórico suficiente, nunca média parcial', () => {
    // Média parcial disfarçada de completa faria as primeiras velas gerarem
    // sinais baseados em quase nenhum dado.
    const values = [d(1), d(2), d(3)];
    assert.equal(sma(values, 1, 3), null);
    assert.equal(sma(values, 2, 3)!.toString(), '2');
});

test('highestHighBefore EXCLUI a vela atual', () => {
    // Incluí-la faria "fechou acima da máxima do período" ser quase sempre
    // falso, quebrando o rompimento silenciosamente.
    const candles = [candle(10, 12, 9, 11, 0), candle(11, 13, 10, 12, 1), candle(12, 50, 11, 49, 2)];
    assert.equal(highestHighBefore(candles, 2, 2)!.toString(), '13', 'a máxima 50 da vela atual não pode entrar');
});

test('lowestLowBefore encontra a mínima do período anterior', () => {
    const candles = [candle(10, 12, 5, 11, 0), candle(11, 13, 8, 12, 1), candle(12, 14, 1, 13, 2)];
    assert.equal(lowestLowBefore(candles, 2, 2)!.toString(), '5');
});

// --- True range e ATR -------------------------------------------------------

test('trueRange captura gap de abertura, não só o range interno da vela', () => {
    // Sem isso, um stop dimensionado pelo range subestimaria o movimento real
    // justamente nos momentos de maior volatilidade.
    const comGap = candle(100, 105, 98, 104);
    assert.equal(trueRange(comGap, d(80)).toString(), '25', '|105 − 80| = 25 supera o range interno de 7');
    assert.equal(trueRange(comGap, null).toString(), '7', 'sem fechamento anterior, usa o range interno');
});

test('atr é a média dos true ranges e cresce com a volatilidade', () => {
    const calmo = fromCloses([100, 100, 100, 100, 100, 100]);
    const agitado = [
        candle(100, 101, 99, 100, 0),
        candle(100, 120, 80, 110, 1),
        candle(110, 130, 90, 100, 2),
        candle(100, 140, 70, 120, 3),
        candle(120, 150, 100, 130, 4),
        candle(130, 160, 110, 140, 5),
    ];
    assert.ok(atr(agitado, 5, 3)!.greaterThan(atr(calmo, 5, 3)!));
});

test('atr devolve null sem histórico suficiente', () => {
    assert.equal(atr(fromCloses([100, 101, 102]), 1, 5), null);
});

// --- Rompimento -------------------------------------------------------------

test('rompimento dispara pelo FECHAMENTO acima da máxima anterior', () => {
    // Disparar pela máxima intradiária pareceria ótimo no backtest e ao vivo
    // viraria compra no topo de um movimento já revertido.
    const candles = [...fromCloses([100, 100, 100, 100, 100, 100, 100, 100, 100, 100])];
    candles.push(candle(100, 120, 99, 118, 10));
    const sinal = detectBreakout(candles, 10, 5, 5);
    assert.ok(sinal.triggered);
    assert.equal(sinal.breakoutLevel!.toString(), '100.5');
});

test('vela que TOCA a máxima mas fecha abaixo não dispara rompimento', () => {
    const candles = [...fromCloses([100, 100, 100, 100, 100, 100, 100, 100, 100, 100])];
    candles.push(candle(100, 130, 99, 100, 10)); // espetou e voltou
    assert.equal(detectBreakout(candles, 10, 5, 5).triggered, false);
});

// --- Tendência --------------------------------------------------------------

test('isAboveTrend separa acima e abaixo da média longa', () => {
    // Recebe fechamentos já extraídos: extrair dentro alocaria o array inteiro
    // a cada vela, tornando a varredura O(n²).
    const subindo = fromCloses([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]).map((c) => c.close);
    assert.equal(isAboveTrend(subindo, 9, 5), true);
    const caindo = fromCloses([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]).map((c) => c.close);
    assert.equal(isAboveTrend(caindo, 9, 5), false);
});

// --- RSI --------------------------------------------------------------------

test('RSI de série só de altas é 100 (sem divisão por zero vazando)', () => {
    // Sem perda nenhuma o RS é infinito; devolver o resultado da divisão
    // deixaria Infinity vazar para a comparação de limiar.
    const soAltas = fromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    assert.equal(rsi(soAltas, 15, 14)!.toString(), '100');
});

test('RSI de série só de quedas fica próximo de zero', () => {
    const soQuedas = fromCloses([25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
    assert.ok(rsi(soQuedas, 15, 14)!.lessThan(d(5)));
});

test('RSI fica entre 0 e 100 numa série mista', () => {
    const mista = fromCloses([100, 102, 101, 105, 103, 108, 106, 110, 107, 112, 109, 115, 111, 118, 114, 120]);
    const valor = rsi(mista, 15, 14)!;
    assert.ok(valor.greaterThan(0) && valor.lessThan(100));
});

test('RSI devolve null sem histórico suficiente', () => {
    assert.equal(rsi(fromCloses([100, 101, 102]), 2, 14), null);
});

test('queda forte deixa o RSI abaixo do limiar de sobrevendido', () => {
    const caindo = fromCloses([100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78, 76, 74, 72, 70]);
    assert.ok(rsi(caindo, 15, 14)!.lessThan(d(30)));
});

// --- Reversão ---------------------------------------------------------------

test('reversão exige que o RSI tenha VIRADO para cima, não só estar baixo', () => {
    // Comprar com o RSI ainda caindo é apostar num fundo não confirmado.
    const aindaCaindo = fromCloses([100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78, 76, 74, 72, 70, 68]);
    assert.equal(
        detectOversoldReversion(aindaCaindo, 16, rsiSeries(aindaCaindo, 14), d(30), 5).triggered,
        false,
        'RSI baixo mas ainda caindo não dispara',
    );
});

test('reversão dispara quando o RSI estava baixo e virou para cima', () => {
    const viradaAposQueda = fromCloses([
        100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78, 76, 74, 72, 70, 78,
    ]);
    const sinal = detectOversoldReversion(viradaAposQueda, 16, rsiSeries(viradaAposQueda, 14), d(30), 5);
    assert.ok(sinal.triggered, 'queda profunda seguida de virada é o sinal de "comprar na baixa"');
    assert.ok(sinal.rsiValue!.greaterThan(0));
    assert.notEqual(sinal.atrValue, null);
});

test('reversão não dispara em série lateral (nunca ficou sobrevendida)', () => {
    const lateral = fromCloses([100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 102]);
    assert.equal(detectOversoldReversion(lateral, 16, rsiSeries(lateral, 14), d(30), 5).triggered, false);
});

test('reversão devolve não-disparado quando falta histórico, sem lançar', () => {
    const curta = fromCloses([100, 99, 98]);
    const sinal = detectOversoldReversion(curta, 2, rsiSeries(curta, 14), d(30), 5);
    assert.equal(sinal.triggered, false);
    assert.equal(sinal.rsiValue, null);
});

// --- Série de RSI (a versão O(n) usada pelo backtest) ------------------------

test('rsiSeries concorda com rsi() ponto a ponto', () => {
    // As duas implementações precisam dar o MESMO número: a série existe só
    // por performance, e uma divergência entre elas produziria backtest
    // diferente da consulta pontual sem ninguém perceber.
    const serie = fromCloses([100, 102, 101, 105, 103, 108, 106, 110, 107, 112, 109, 115, 111, 118, 114, 120, 117]);
    const values = rsiSeries(serie, 14);
    for (let i = 14; i < serie.length; i++) {
        assert.equal(values[i]!.toFixed(10), rsi(serie, i, 14)!.toFixed(10), `divergiu no índice ${i}`);
    }
});

test('rsiSeries devolve null onde falta histórico', () => {
    const serie = fromCloses([100, 102, 101, 105, 103, 108, 106, 110, 107, 112, 109, 115, 111, 118, 114, 120]);
    const values = rsiSeries(serie, 14);
    for (let i = 0; i < 14; i++) assert.equal(values[i], null, `índice ${i} deveria ser null`);
    assert.notEqual(values[14], null);
});

test('rsiSeries com série curta demais devolve tudo null sem estourar', () => {
    assert.ok(rsiSeries(fromCloses([100, 101]), 14).every((v) => v === null));
});

// --- Volume: a confirmação que separa alta de verdade de ruído ---------------

test('volume é medido contra a média das velas ANTERIORES, não incluindo a própria', () => {
    // Incluir a vela atual na média faria o próprio pico puxar a média para
    // cima e mascarar justamente o que se quer detectar. Com 5 velas de volume
    // 100 e uma de 600: excluindo, a razão é 6x; incluindo, cairia para 3,6x.
    const velas: Candle[] = [];
    for (let i = 0; i < 5; i++) velas.push(vela(100, 101, 99, 100, i, 100));
    velas.push(vela(100, 101, 99, 100, 5, 600));
    const razao = volumeRatio(velas, 5, 5);
    assert.equal(razao?.toString(), '6');
});

test('sem histórico suficiente, volumeRatio devolve null em vez de número inventado', () => {
    const velas = Array.from({ length: 3 }, (_, i) => vela(100, 101, 99, 100, i, 100));
    assert.equal(volumeRatio(velas, 2, 5), null);
});

test('volume médio zero devolve null, não divisão por zero', () => {
    // Acontece em par sem negócio nenhum na janela — exatamente o tipo de ativo
    // que uma varredura de moeda pequena encontra.
    const velas = Array.from({ length: 6 }, (_, i) => vela(100, 101, 99, 100, i, 0));
    assert.equal(volumeRatio(velas, 5, 5), null);
});

// --- Momentum: rompimento COM volume ----------------------------------------

function serieComRompimento(volumeDoRompimento: number): Candle[] {
    const velas: Candle[] = [];
    // 30 velas laterais em 100, volume 100.
    for (let i = 0; i < 30; i++) velas.push(vela(100, 101, 99, 100, i, 100));
    // Vela que fecha acima da máxima das 10 anteriores.
    velas.push(vela(101, 130, 100, 125, 30, volumeDoRompimento));
    return velas;
}

test('rompimento SEM volume não dispara — é o que evita pagar taxa por ruído', () => {
    // Numa moeda pequena o preço rompe a máxima dezenas de vezes por dia sem
    // nada acontecer. Sem o filtro de volume a estratégia vira uma máquina de
    // pagar taxa.
    const sinal = detectMomentumSurge(serieComRompimento(110), 30, 10, 14, 20, new Decimal('3'));
    assert.equal(sinal.triggered, false);
    assert.match(sinal.reason!, /volume 1\.1x, precisa 3\.0x/);
});

test('rompimento COM volume dispara', () => {
    const sinal = detectMomentumSurge(serieComRompimento(500), 30, 10, 14, 20, new Decimal('3'));
    assert.equal(sinal.triggered, true);
    assert.equal(sinal.volumeRatio?.toString(), '5');
    assert.ok(sinal.atrValue && sinal.atrValue.greaterThan(0));
});

test('volume alto SEM rompimento não dispara', () => {
    // Volume explodindo com preço parado é distribuição, não alta começando —
    // e é o padrão de quem está vendendo para quem chegou atrasado.
    const velas: Candle[] = [];
    for (let i = 0; i < 30; i++) velas.push(vela(100, 101, 99, 100, i, 100));
    velas.push(vela(100, 101, 99, 100, 30, 900));
    const sinal = detectMomentumSurge(velas, 30, 10, 14, 20, new Decimal('3'));
    assert.equal(sinal.triggered, false);
    assert.match(sinal.reason!, /sem rompimento/);
});

test('o rompimento é pelo FECHAMENTO, não pela máxima da vela', () => {
    // Pavio que sobe e volta é exatamente o que engana quem compra no meio da
    // vela. A máxima chegou a 130, o fechamento voltou para 100: não é alta.
    const velas: Candle[] = [];
    for (let i = 0; i < 30; i++) velas.push(vela(100, 101, 99, 100, i, 100));
    velas.push(vela(100, 130, 99, 100, 30, 900));
    const sinal = detectMomentumSurge(velas, 30, 10, 14, 20, new Decimal('3'));
    assert.equal(sinal.triggered, false);
    assert.match(sinal.reason!, /sem rompimento/);
});
