// Arquivo: src/kelly.test.ts
//
// O teste que carrega este arquivo é o do Kelly negativo. Ele demonstra, com
// os números exatos da configuração pedida, que "arriscar menos" não é
// mitigação: quando f* ≤ 0, todo tamanho de posição perde, e reduzir só troca
// a velocidade da ruína.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { chanceDeSequenciaRuim, dimensionarPorKelly, fracaoDeKelly, perdasSeguidasSuportadas } from './kelly';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

// +0,3% / −0,4%, taker na entrada e no stop, maker no alvo, com desconto BNB.
const GANHO_PEDIDO = new Decimal('0.003').minus('0.00045').minus('0.00018'); // 0,237%
const PERDA_PEDIDA = new Decimal('0.004').plus('0.00045').plus('0.00045'); //  0,490%

test('a configuração pedida dá Kelly ZERO a 55% de acerto — nenhum tamanho a salva', () => {
    const f = fracaoDeKelly({ acerto: new Decimal('0.55'), ganho: GANHO_PEDIDO, perda: PERDA_PEDIDA });
    assert.equal(f.toString(), '0');
});

test('e continua zero a 65% — a razão ganho/perda é ruim demais', () => {
    const f = fracaoDeKelly({ acerto: new Decimal('0.65'), ganho: GANHO_PEDIDO, perda: PERDA_PEDIDA });
    assert.equal(f.toString(), '0');
});

test('inverter alvo e stop muda tudo: 0,6%/0,3% a 55% já tem Kelly positivo', () => {
    const ganho = new Decimal('0.006').minus('0.00045').minus('0.00018');
    const perda = new Decimal('0.003').plus('0.00045').plus('0.00045');
    const f = fracaoDeKelly({ acerto: new Decimal('0.55'), ganho, perda });
    assert.equal(f.greaterThan(0), true);
    assert.equal(f.mul(100).toFixed(1), '11.1'); // meio Kelly
});

test('o teto de 25% por operação vale mesmo com vantagem enorme', () => {
    const f = fracaoDeKelly({
        acerto: new Decimal('0.95'),
        ganho: new Decimal('0.02'),
        perda: new Decimal('0.002'),
    });
    assert.equal(f.toString(), '0.25');
});

test('meio Kelly é metade do Kelly cheio — abaixo do teto', () => {
    // Valores escolhidos para o Kelly cheio ficar sob os 25%, senão o teto
    // corta o cheio e a razão de 2 deixa de valer — que é o comportamento
    // certo: o teto limita o RISCO FINAL, não a fórmula.
    const cheio = fracaoDeKelly({
        acerto: new Decimal('0.55'),
        ganho: new Decimal('0.005'),
        perda: new Decimal('0.004'),
        fracaoDeUso: new Decimal(1),
    });
    const meio = fracaoDeKelly({ acerto: new Decimal('0.55'), ganho: new Decimal('0.005'), perda: new Decimal('0.004') });
    assert.equal(cheio.lessThan('0.25'), true);
    assert.equal(meio.mul(2).toFixed(6), cheio.toFixed(6));
});

test('o teto de 25% corta o Kelly cheio ANTES de qualquer fração de uso', () => {
    const cheio = fracaoDeKelly({
        acerto: new Decimal('0.6'),
        ganho: new Decimal('0.005'),
        perda: new Decimal('0.004'),
        fracaoDeUso: new Decimal(1),
    });
    assert.equal(cheio.toString(), '0.25'); // f* seria 0,28
});

test('ganho ou perda não positivos devolvem zero em vez de dividir por zero', () => {
    assert.equal(fracaoDeKelly({ acerto: new Decimal('0.9'), ganho: new Decimal(0), perda: new Decimal('0.004') }).toString(), '0');
    assert.equal(fracaoDeKelly({ acerto: new Decimal('0.9'), ganho: new Decimal('0.004'), perda: new Decimal(0) }).toString(), '0');
});

test('dimensionar a configuração pedida RECUSA, e diz por quê', () => {
    const d = dimensionarPorKelly({
        banca: new Decimal(35),
        acerto: new Decimal('0.55'),
        ganho: GANHO_PEDIDO,
        perda: PERDA_PEDIDA,
        perdaPorNocional: PERDA_PEDIDA,
        alavancagemMaxima: new Decimal(30),
        nocionalMinimo: new Decimal(5),
    });
    assert.equal(d.operar, false);
    if (!d.operar) assert.match(d.motivo, /perde mais devagar/);
});

test('é o STOP que converte risco em nocional, não a alavancagem', () => {
    const ganho = new Decimal('0.006').minus('0.00045').minus('0.00018');
    const perda = new Decimal('0.003').plus('0.00045').plus('0.00045');
    const d = dimensionarPorKelly({
        banca: new Decimal(35),
        acerto: new Decimal('0.55'),
        ganho,
        perda,
        perdaPorNocional: perda,
        alavancagemMaxima: new Decimal(30),
        nocionalMinimo: new Decimal(5),
    });
    assert.equal(d.operar, true);
    if (d.operar) {
        // risco = 35 × 11,1% = 3,90 USDT; nocional = 3,90 / 0,39% = ~1001
        assert.equal(d.riscoEmUsdt.toFixed(2), '3.90');
        assert.equal(d.nocional.toFixed(0), '1001');
    }
});

test('a alavancagem entra só como TETO — nunca aumenta o nocional', () => {
    const ganho = new Decimal('0.006').minus('0.00045').minus('0.00018');
    const perda = new Decimal('0.003').plus('0.00045').plus('0.00045');
    const d = dimensionarPorKelly({
        banca: new Decimal(35),
        acerto: new Decimal('0.55'),
        ganho,
        perda,
        perdaPorNocional: perda,
        alavancagemMaxima: new Decimal(5), // 35 × 5 = 175 < 997
        nocionalMinimo: new Decimal(5),
    });
    assert.equal(d.operar, true);
    if (d.operar) assert.equal(d.nocional.toFixed(0), '175');
});

test('banca pequena demais para o mínimo da corretora recusa com o número na frente', () => {
    const ganho = new Decimal('0.006').minus('0.00045').minus('0.00018');
    const perda = new Decimal('0.003').plus('0.00045').plus('0.00045');
    const d = dimensionarPorKelly({
        banca: new Decimal('0.10'),
        acerto: new Decimal('0.55'),
        ganho,
        perda,
        perdaPorNocional: perda,
        alavancagemMaxima: new Decimal(30),
        nocionalMinimo: new Decimal(5),
    });
    assert.equal(d.operar, false);
    if (!d.operar) assert.match(d.motivo, /abaixo do mínimo/);
});

test('arriscar 11% aguenta 14 perdas seguidas; arriscar 100% aguenta 1', () => {
    assert.equal(perdasSeguidasSuportadas({ fracaoDaBanca: new Decimal('0.111') }), 14);
    assert.equal(perdasSeguidasSuportadas({ fracaoDaBanca: new Decimal(1) }), 1);
});

test('cinco perdas seguidas a 60% de acerto NÃO são azar: acontecem quase sempre em 1000 operações', () => {
    const c = chanceDeSequenciaRuim({ acerto: new Decimal('0.6'), n: 5, operacoes: 1000 });
    assert.equal(c.greaterThan('0.9'), true);
    // Quem dimensiona para não aguentar cinco perdas está apostando em não
    // encontrar o que estatisticamente encontra.
});

test('sequências longas são raras — a conta distingue improvável de impossível', () => {
    const c = chanceDeSequenciaRuim({ acerto: new Decimal('0.6'), n: 15, operacoes: 1000 });
    assert.equal(c.lessThan('0.05'), true);
});
