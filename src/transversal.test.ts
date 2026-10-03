// Arquivo: src/transversal.test.ts
//
// O que estes testes protegem é a honestidade do sinal, não o cálculo — a
// média é trivial. As recusas é que importam: sem elas o módulo devolve
// "extremos" de um universo que não tem extremo nenhum, e a medição mede a
// própria ordenação em vez do mercado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { extremosTransversais, retornoDaJanela, RetornoDoSimbolo } from './transversal';
import { Vela1m } from './volumeSpike';

function vela(fechamento: string): Vela1m {
    return {
        aberturaMs: 0,
        abertura: new Decimal(fechamento),
        maxima: new Decimal(fechamento),
        minima: new Decimal(fechamento),
        fechamento: new Decimal(fechamento),
        volume: new Decimal(1),
    };
}

function r(symbol: string, retornoPct: string): RetornoDoSimbolo {
    return { symbol, retorno: new Decimal(retornoPct).dividedBy(100), preco: new Decimal(1) };
}

test('retorno é fechado a fechado da janela pedida', () => {
    const velas = [vela('100'), vela('101'), vela('102'), vela('103')];
    // 3 minutos = 4 velas: de 100 a 103.
    assert.equal(retornoDaJanela(velas, 3)?.mul(100).toFixed(2), '3.00');
    // 2 minutos = 3 velas: de 101 a 103, e NÃO de 100.
    assert.equal(retornoDaJanela(velas, 2)?.mul(100).toFixed(2), '1.98');
});

test('sem velas suficientes devolve null, não zero', () => {
    // Zero seria um retorno VÁLIDO e jogaria a moeda para o MEIO do ranking.
    // Uma moeda que acabou de entrar no universo apareceria como a mais
    // estável de todas — exatamente o contrário do que se sabe sobre ela.
    assert.equal(retornoDaJanela([vela('100'), vela('101')], 60), null);
    assert.equal(retornoDaJanela([], 1), null);
});

test('marca os extremos com a direção do MOMENTO (contra = reversão)', () => {
    // A convenção está registrada antes de existir amostra: quem subiu mais
    // recebe 'alta'. A hipótese pré-registrada é a coluna `contra` da grade,
    // ou seja, a REVERSÃO. Se este teste inverter um dia, a hipótese mudou
    // de significado sem ninguém avisar.
    const sinais = extremosTransversais({
        retornos: [r('A', '5'), r('B', '1'), r('C', '0'), r('D', '-1'), r('E', '-6')],
        quantos: 1,
        minimoDeSimbolos: 5,
    });
    assert.deepEqual(
        sinais.map((s) => [s.symbol, s.direcao]),
        [['A', 'alta'], ['E', 'baixa']],
    );
});

test('recusa universo pequeno demais para ter extremo', () => {
    const poucos = [r('A', '5'), r('B', '0'), r('C', '-5')];
    assert.deepEqual(extremosTransversais({ retornos: poucos, quantos: 1, minimoDeSimbolos: 8 }), []);
});

test('recusa quando topo e fundo se sobreporiam — a mesma moeda nos dois lados', () => {
    // Com 4 moedas e quantos=3, a de índice 2 seria comprada E vendida.
    const quatro = [r('A', '5'), r('B', '2'), r('C', '-2'), r('D', '-5')];
    assert.deepEqual(extremosTransversais({ retornos: quatro, quantos: 3, minimoDeSimbolos: 4 }), []);
    assert.equal(extremosTransversais({ retornos: quatro, quantos: 2, minimoDeSimbolos: 4 }).length, 4);
});

test('recusa quando todas andaram quase igual — ordenar empate não é sinal', () => {
    // Quinze moedas variando 0,02% entre si: existe primeiro e último
    // colocado, mas não existe extremo. Sem esta guarda o motor geraria
    // sinal a cada rodada e mediria a própria ordenação.
    const empatadas = Array.from({ length: 15 }, (_, i) => r(`S${i}`, (i * 0.002).toFixed(3)));
    assert.deepEqual(
        extremosTransversais({
            retornos: empatadas,
            quantos: 2,
            minimoDeSimbolos: 10,
            separacaoMinima: new Decimal('0.02'), // exige 2 pontos percentuais
        }),
        [],
    );
});

test('aceita quando a separação é real', () => {
    const espalhadas = Array.from({ length: 15 }, (_, i) => r(`S${i}`, (i * 0.5 - 3.5).toFixed(2)));
    const sinais = extremosTransversais({
        retornos: espalhadas,
        quantos: 2,
        minimoDeSimbolos: 10,
        separacaoMinima: new Decimal('0.02'),
    });
    assert.equal(sinais.length, 4);
    assert.equal(sinais.filter((s) => s.direcao === 'alta').length, 2);
    assert.equal(sinais.filter((s) => s.direcao === 'baixa').length, 2);
    // O melhor de todos tem de estar no topo, o pior no fundo.
    assert.equal(sinais[0].symbol, 'S14');
    assert.equal(sinais[3].symbol, 'S0');
});

test('a fronteira exata: N minutos exigem N+1 velas fechadas', () => {
    // Este é o erro de um que quase custou uma noite de medição. A Binance
    // devolve `limite` velas com a última em formação, então `fechadas` fica
    // com `limite - 1`. Pedir 61 dá 60 fechadas, e um retorno de 60 minutos
    // precisa de 61 — devolveria null em todo símbolo, para sempre, sem
    // erro nenhum no log.
    const sessenta = Array.from({ length: 60 }, (_, i) => vela(String(100 + i)));
    assert.equal(retornoDaJanela(sessenta, 60), null, '60 velas NÃO bastam para 60 minutos');

    const sessentaEUma = Array.from({ length: 61 }, (_, i) => vela(String(100 + i)));
    assert.ok(retornoDaJanela(sessentaEUma, 60) !== null, '61 velas bastam');
});
