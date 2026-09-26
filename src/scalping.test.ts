// Arquivo: src/scalping.test.ts
//
// O que estes testes protegem é a decisão que quase ninguém calcula antes de
// operar: a taxa de acerto que a configuração EXIGE. Alvo apertado e stop
// apertado parecem prudentes e são a armadilha — alvo menor que stop exige
// acertar mais da metade das vezes só para empatar, e a taxa empurra essa
// exigência para cima nos dois lados ao mesmo tempo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    alvoNecessario,
    aritmeticaDoScalping,
    custoPorOperacaoSobreBanca,
    operacoesAteZerarSoDeTaxa,
    veredictoDeScalping,
} from './scalping';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

/** Taxa taker de Futuros USDT-M com desconto de BNB. */
const TAXA_FUTUROS = new Decimal('0.00045');

test('alvo +0,3% com stop −0,4% exige acertar 70% — o número que reprova a configuração', () => {
    // A configuração pedida: parece controlada, e é a mais difícil de todas.
    // Ganha $1,58 quando acerta e perde $3,68 quando erra, sobre $750.
    const a = aritmeticaDoScalping({
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        taxaPorPerna: TAXA_FUTUROS,
    });
    assert.equal(a.acertoMinimo.mul(100).toFixed(1), '70.0');
    assert.ok(a.razao.lessThan(0.5), 'o erro dói mais que o dobro do acerto');
    assert.equal(a.fracaoDoGanhoComidaPelaTaxa.mul(100).toFixed(1), '30.0', 'a taxa come 30% do ganho bruto');
});

test('a taxa aparece nos DOIS lados: reduz o ganho e aumenta a perda', () => {
    const semTaxa = aritmeticaDoScalping({
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        taxaPorPerna: new Decimal(0),
    });
    const comTaxa = aritmeticaDoScalping({
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        taxaPorPerna: TAXA_FUTUROS,
    });
    // Sem taxa nenhuma, a mesma configuração já exige 57%.
    assert.equal(semTaxa.acertoMinimo.mul(100).toFixed(1), '57.1');
    // A taxa move a exigência em 13 pontos percentuais.
    assert.equal(comTaxa.acertoMinimo.mul(100).toFixed(1), '70.0');
});

test('ALAVANCAGEM NÃO muda a taxa de acerto necessária', () => {
    // Contra-intuitivo e importante: ela multiplica ganho, perda e taxa na
    // mesma proporção, então a razão entre eles não se altera. O que ela muda
    // é o tamanho de cada resultado sobre a banca.
    const cfg = { alvo: new Decimal('0.003'), stop: new Decimal('0.004'), taxaPorPerna: TAXA_FUTUROS };
    const a = aritmeticaDoScalping(cfg);
    assert.equal(a.acertoMinimo.mul(100).toFixed(1), '70.0');

    // Mas o custo sobre a BANCA muda tudo:
    assert.equal(custoPorOperacaoSobreBanca({ taxaPorPerna: TAXA_FUTUROS, alavancagem: new Decimal(1) }).mul(100).toFixed(2), '0.09');
    assert.equal(custoPorOperacaoSobreBanca({ taxaPorPerna: TAXA_FUTUROS, alavancagem: new Decimal(30) }).mul(100).toFixed(2), '2.70');
});

test('a 30x, 37 operações consomem a banca só de taxa — sem nenhuma perda', () => {
    // O número que mostra o preço de operar grande com pouco.
    assert.equal(
        operacoesAteZerarSoDeTaxa({ taxaPorPerna: TAXA_FUTUROS, alavancagem: new Decimal(30) }).toString(),
        '37',
    );
    assert.equal(
        operacoesAteZerarSoDeTaxa({ taxaPorPerna: TAXA_FUTUROS, alavancagem: new Decimal(1) }).toString(),
        '1111',
    );
});

test('alvo que não cobre a própria taxa devolve 100% de acerto necessário, não um número intermediário', () => {
    // Devolver algo entre 0 e 1 sugeriria que existe saída. Não existe: o
    // "acerto" já é prejuízo.
    const a = aritmeticaDoScalping({
        alvo: new Decimal('0.0005'),
        stop: new Decimal('0.004'),
        taxaPorPerna: TAXA_FUTUROS,
    });
    assert.ok(a.ganhoLiquido.lessThan(0));
    assert.equal(a.acertoMinimo.toString(), '1');
    assert.equal(a.razao.toString(), '0');
});

test('a pergunta invertida: com 45% de acerto, qual alvo fecha a conta?', () => {
    // A resposta é um alvo MAIOR que o stop — o oposto do instinto de pegar o
    // lucrinho rápido e cortar rápido.
    const alvo = alvoNecessario({
        acertoEsperado: new Decimal('0.45'),
        stop: new Decimal('0.004'),
        taxaPorPerna: TAXA_FUTUROS,
    });
    assert.ok(alvo);
    assert.equal(alvo!.mul(100).toFixed(3), '0.688');
    assert.ok(alvo!.greaterThan('0.004'), 'o alvo precisa ser maior que o stop');
});

test('o veredicto REPROVA a configuração de 0,3/0,4 e diz qual alvo fecharia', () => {
    const v = veredictoDeScalping({
        configuracao: { alvo: new Decimal('0.003'), stop: new Decimal('0.004'), taxaPorPerna: TAXA_FUTUROS },
        acertoRealista: new Decimal('0.45'),
    });
    assert.equal(v.viavel, false);
    assert.match(v.motivo, /70\.0%/);
    assert.ok(!v.viavel && v.alvoQueFecharia !== null);
    assert.equal(!v.viavel && v.alvoQueFecharia!.mul(100).toFixed(3), '0.688');
});

test('o veredicto APROVA quando o alvo é maior que o stop na proporção certa', () => {
    const v = veredictoDeScalping({
        configuracao: { alvo: new Decimal('0.008'), stop: new Decimal('0.004'), taxaPorPerna: TAXA_FUTUROS },
        acertoRealista: new Decimal('0.45'),
    });
    assert.equal(v.viavel, true);
    assert.ok(v.aritmetica.acertoMinimo.lessThan('0.45'));
});

test('acerto assumido fora de (0,1) devolve null em vez de número absurdo', () => {
    const comum = { stop: new Decimal('0.004'), taxaPorPerna: TAXA_FUTUROS };
    assert.equal(alvoNecessario({ ...comum, acertoEsperado: new Decimal(0) }), null);
    assert.equal(alvoNecessario({ ...comum, acertoEsperado: new Decimal(1) }), null);
    assert.equal(alvoNecessario({ ...comum, acertoEsperado: new Decimal('1.5') }), null);
});

test('acerto de 100% assumido: qualquer alvo acima da taxa passa', () => {
    // Caso extremo que serve de sanidade: se nunca erra, só precisa cobrir a
    // taxa. Serve para provar que a fórmula não tem viés embutido.
    const v = veredictoDeScalping({
        configuracao: { alvo: new Decimal('0.001'), stop: new Decimal('0.004'), taxaPorPerna: TAXA_FUTUROS },
        acertoRealista: new Decimal('0.999'),
    });
    assert.equal(v.viavel, true);
});
