// Arquivo: src/volumeSpike.test.ts
//
// O que estes testes protegem é a diferença entre um gatilho que dispara no
// evento e um que dispara no fim da vela. Num scalp que busca 0,3% a 0,8%,
// sessenta segundos de atraso não é imprecisão — é o movimento inteiro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { detectarPicoDeVolume, precosDeSaida, type Vela1m } from './volumeSpike';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const vela = (volume: string, abertura = '100', fechamento = '100'): Vela1m => ({
    aberturaMs: 0,
    abertura: new Decimal(abertura),
    maxima: new Decimal(fechamento),
    minima: new Decimal(abertura),
    fechamento: new Decimal(fechamento),
    volume: new Decimal(volume),
});

/** Dez velas calmas, volume 100 cada. */
const referencia = () => Array.from({ length: 10 }, () => vela('100'));

const base = {
    multiplicador: new Decimal(3),
    variacaoMinima: new Decimal('0.001'),
};

test('a comparação é por TAXA, não por total — o pico é detectado aos 5 segundos', () => {
    // O ponto central do módulo. Aos 5 segundos, uma vela com volume 30 tem
    // taxa de 6/s contra a média de 1,67/s: é 3,6x. Comparando TOTAIS, 30
    // contra 100 pareceria "vela ainda vazia" e o gatilho só dispararia perto
    // do fim — quando o movimento já aconteceu.
    const sinal = detectarPicoDeVolume({
        ...base,
        velasFechadas: referencia(),
        emFormacao: vela('30', '100', '100.5'),
        segundosDecorridos: 5,
    });
    assert.ok(sinal, 'pico real nos primeiros segundos precisa ser detectado');
    assert.equal(sinal!.direcao, 'alta');
    assert.ok(sinal!.multiploDoVolume.greaterThan(3));
});

test('vela em ritmo NORMAL não dispara, por mais tempo que passe', () => {
    // Aos 30 segundos com volume 50, a taxa é 1,67/s — exatamente a média.
    const sinal = detectarPicoDeVolume({
        ...base,
        velasFechadas: referencia(),
        emFormacao: vela('50', '100', '100.5'),
        segundosDecorridos: 30,
    });
    assert.equal(sinal, null);
});

test('volume explosivo com preço PARADO não dispara', () => {
    // Volume alto acontece nos dois lados de uma briga: comprador agressivo
    // contra vendedor agressivo, preço no meio. É a pior entrada possível para
    // um scalp de stop apertado.
    const sinal = detectarPicoDeVolume({
        ...base,
        velasFechadas: referencia(),
        emFormacao: vela('500', '100', '100.02'),
        segundosDecorridos: 20,
    });
    assert.equal(sinal, null, 'sem direção confirmada, não é sinal');
});

test('queda com volume vira sinal de BAIXA', () => {
    const sinal = detectarPicoDeVolume({
        ...base,
        velasFechadas: referencia(),
        emFormacao: vela('200', '100', '99.4'),
        segundosDecorridos: 10,
    });
    assert.ok(sinal);
    assert.equal(sinal!.direcao, 'baixa');
    assert.ok(sinal!.variacao.lessThan(0));
});

test('os primeiros segundos são bloqueados — a taxa é ruidosa com pouca amostra', () => {
    // Um único negócio grande no primeiro segundo produziria uma taxa absurda.
    const cedo = detectarPicoDeVolume({
        ...base,
        velasFechadas: referencia(),
        emFormacao: vela('50', '100', '100.5'),
        segundosDecorridos: 2,
    });
    assert.equal(cedo, null);
});

test('amostra insuficiente devolve null, não "sem sinal"', () => {
    // São coisas diferentes: tratar "não sei" como "não" faria o motor operar
    // no boot com uma média de duas velas.
    const sinal = detectarPicoDeVolume({
        ...base,
        velasFechadas: [vela('100'), vela('100')],
        emFormacao: vela('1000', '100', '101'),
        segundosDecorridos: 10,
    });
    assert.equal(sinal, null);
});

test('média de volume zero não vira divisão por zero', () => {
    const sinal = detectarPicoDeVolume({
        ...base,
        velasFechadas: Array.from({ length: 10 }, () => vela('0')),
        emFormacao: vela('100', '100', '101'),
        segundosDecorridos: 10,
    });
    assert.equal(sinal, null);
});

// ---------------------------------------------------------------------------
// Saídas
// ---------------------------------------------------------------------------

test('na COMPRA o alvo fica acima e o stop abaixo', () => {
    const s = precosDeSaida({
        entrada: new Decimal(100),
        direcao: 'alta',
        alvo: new Decimal('0.008'),
        stop: new Decimal('0.004'),
    });
    assert.equal(s.alvo.toFixed(2), '100.80');
    assert.equal(s.stop.toFixed(2), '99.60');
});

test('na VENDA os dois INVERTEM — o erro que transforma stop em alvo', () => {
    // Numa posição vendida o lucro está abaixo e o risco acima. Um stop
    // colocado do lado errado não protege nada: ele fecha a posição no lucro e
    // deixa a perda correr sem limite.
    const s = precosDeSaida({
        entrada: new Decimal(100),
        direcao: 'baixa',
        alvo: new Decimal('0.008'),
        stop: new Decimal('0.004'),
    });
    assert.equal(s.alvo.toFixed(2), '99.20', 'vendido, o alvo é ABAIXO');
    assert.equal(s.stop.toFixed(2), '100.40', 'vendido, o stop é ACIMA');
});
