// Arquivo: src/timeStop.test.ts
//
// A propriedade central aqui é o que a regra NÃO faz: ela não corta o
// ganhador. Estratégia de expectativa fina vive de poucas operações que andam
// muito; um relógio que fecha posição boa por ter batido o prazo destrói
// exatamente a parte que paga todas as outras.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { barrasDesde, decidirSaidaPorTempo, intervaloEmMs } from './timeStop';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const TAXA = new Decimal('0.00075'); // 0,075% por perna

test('corta a operação parada que já pagou o prazo sem cobrir o próprio custo', () => {
    const decisao = decidirSaidaPorTempo({
        barrasSeguradas: 20,
        maxBarras: 20,
        variacaoDesdeEntrada: new Decimal('0.0003'), // +0,03%, abaixo dos 0,15% de ida e volta
        taxaPorPerna: TAXA,
    });
    assert.equal(decisao.sair, true);
    assert.ok(decisao.sair && /A vaga vale mais/.test(decisao.motivo));
});

test('NÃO corta o ganhador só porque o relógio bateu', () => {
    // O caso que mata a estratégia se for tratado errado: a posição está
    // subindo bem, mas passou do prazo. Cortar aqui destrói a operação que
    // paga todas as outras.
    const decisao = decidirSaidaPorTempo({
        barrasSeguradas: 100,
        maxBarras: 20,
        variacaoDesdeEntrada: new Decimal('0.05'), // +5%
        taxaPorPerna: TAXA,
    });
    assert.equal(decisao.sair, false);
});

test('o piso de progresso é o custo de IDA E VOLTA, não zero', () => {
    // Sair no zero a zero ainda é sair perdendo: as duas taxas já foram pagas.
    const empateAparente = decidirSaidaPorTempo({
        barrasSeguradas: 20,
        maxBarras: 20,
        variacaoDesdeEntrada: new Decimal('0.001'), // +0,1%: positivo, mas < 0,15%
        taxaPorPerna: TAXA,
    });
    assert.equal(empateAparente.sair, true, 'lucro que não cobre a taxa não é lucro');

    const cobriuOCusto = decidirSaidaPorTempo({
        barrasSeguradas: 20,
        maxBarras: 20,
        variacaoDesdeEntrada: new Decimal('0.002'), // +0,2%: acima de 0,15%
        taxaPorPerna: TAXA,
    });
    assert.equal(cobriuOCusto.sair, false);
});

test('a regra fica desligada por padrão e antes do prazo', () => {
    const desligada = decidirSaidaPorTempo({
        barrasSeguradas: 999,
        maxBarras: 0,
        variacaoDesdeEntrada: new Decimal('-0.5'),
        taxaPorPerna: TAXA,
    });
    assert.equal(desligada.sair, false, 'maxBarras 0 não pode fechar nada');

    const cedoDemais = decidirSaidaPorTempo({
        barrasSeguradas: 19,
        maxBarras: 20,
        variacaoDesdeEntrada: new Decimal('-0.02'),
        taxaPorPerna: TAXA,
    });
    assert.equal(cedoDemais.sair, false, 'quem cuida da perda antes do prazo é o stop');
});

test('intervaloEmMs entende os formatos da Binance e recusa o que não entende', () => {
    assert.equal(intervaloEmMs('15m'), 900_000);
    assert.equal(intervaloEmMs('1h'), 3_600_000);
    assert.equal(intervaloEmMs('4h'), 14_400_000);
    assert.equal(intervaloEmMs('1d'), 86_400_000);
    // Recusar é o certo: um intervalo desconhecido virando NaN faria a contagem
    // de barras dar NaN, e NaN comparado com qualquer coisa é falso — a regra
    // simplesmente nunca dispararia, em silêncio.
    assert.throws(() => intervaloEmMs('15minutos'), /não reconhecido/);
    assert.throws(() => intervaloEmMs(''), /não reconhecido/);
});

test('barrasDesde conta velas passadas, não ciclos do motor', () => {
    // O motor roda a cada 30s num gráfico de 15 minutos: contar ciclos mediria
    // "quantas vezes eu olhei", não "quanto tempo passou".
    const entrada = 1_700_000_000_000;
    assert.equal(barrasDesde(entrada, entrada, '15m'), 0);
    assert.equal(barrasDesde(entrada, entrada + 899_000, '15m'), 0, 'vela ainda não fechou');
    assert.equal(barrasDesde(entrada, entrada + 900_000, '15m'), 1);
    assert.equal(barrasDesde(entrada, entrada + 3_600_000, '15m'), 4);
    // Relógio para trás (reinício, ajuste de NTP) não pode virar contagem negativa.
    assert.equal(barrasDesde(entrada, entrada - 5000, '15m'), 0);
});
