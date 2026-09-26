// Arquivo: src/makerEntry.test.ts
//
// O que estes testes protegem não é a economia de taxa — é a integridade do
// livro. Um erro na decisão sobre uma ordem passiva não estoura: produz
// posição FANTASMA (o motor acha que comprou e não comprou) ou ÓRFÃ (comprou
// e o motor não sabe). Os dois já aconteceram neste projeto por outros
// caminhos, e nenhum dos dois gerou uma linha de erro no log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { decidirEntradaPassiva, economiaPorOperacao, precoDaCompraPassiva } from './makerEntry';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const ZERO = new Decimal(0);

test('ordem preenchida é assumida MESMO com o prazo vencido', () => {
    // A corrida clássica: o prazo vence no mesmo instante em que a ordem
    // preenche. Checar o relógio primeiro faria o motor cancelar uma ordem já
    // executada e seguir sem posição — a receita exata de posição órfã.
    const decisao = decidirEntradaPassiva({
        status: 'FILLED',
        preenchido: new Decimal('10'),
        msDecorridos: 999_999,
        msDeEspera: 5000,
        atravessarNoVencimento: true,
    });
    assert.equal(decisao.acao, 'assumir-preenchida');
});

test('cancelada COM preenchimento parcial vira posição, não descarte', () => {
    // Cancelar não desfaz o que já executou. Tratar como "não comprei" deixaria
    // moeda real na corretora sem stop e sem ninguém olhando.
    const decisao = decidirEntradaPassiva({
        status: 'CANCELED',
        preenchido: new Decimal('3'),
        msDecorridos: 100,
        msDeEspera: 5000,
        atravessarNoVencimento: true,
    });
    assert.equal(decisao.acao, 'assumir-parcial');
});

test('cancelada SEM preenchimento atravessa a mercado', () => {
    const decisao = decidirEntradaPassiva({
        status: 'CANCELED',
        preenchido: ZERO,
        msDecorridos: 100,
        msDeEspera: 5000,
        atravessarNoVencimento: true,
    });
    assert.equal(decisao.acao, 'cancelar-e-atravessar');
});

test('recusada por executar na hora NÃO é erro: é o preço tendo andado a favor', () => {
    // LIMIT_MAKER é recusada quando cruzaria o book. A oportunidade continua
    // lá; desistir aqui perderia justamente a entrada que o mercado confirmou.
    const decisao = decidirEntradaPassiva({
        status: 'REJECTED',
        preenchido: ZERO,
        msDecorridos: 10,
        msDeEspera: 5000,
        atravessarNoVencimento: true,
    });
    assert.equal(decisao.acao, 'cancelar-e-atravessar');
    assert.ok(decisao.acao === 'cancelar-e-atravessar' && /andou a favor/.test(decisao.motivo));
});

test('antes do prazo, espera; depois do prazo sem preencher, atravessa', () => {
    const base = {
        status: 'NEW' as const,
        preenchido: ZERO,
        msDeEspera: 5000,
        atravessarNoVencimento: true,
    };
    assert.equal(decidirEntradaPassiva({ ...base, msDecorridos: 4999 }).acao, 'aguardar');
    assert.equal(decidirEntradaPassiva({ ...base, msDecorridos: 5000 }).acao, 'cancelar-e-atravessar');
});

test('parcial no vencimento fica com o que veio, em vez de pagar taxa duas vezes', () => {
    const decisao = decidirEntradaPassiva({
        status: 'PARTIALLY_FILLED',
        preenchido: new Decimal('4'),
        msDecorridos: 6000,
        msDeEspera: 5000,
        atravessarNoVencimento: true,
    });
    assert.equal(decisao.acao, 'assumir-parcial');
});

test('com atravessarNoVencimento desligado, desiste em vez de pagar taxa cheia', () => {
    const decisao = decidirEntradaPassiva({
        status: 'NEW',
        preenchido: ZERO,
        msDecorridos: 6000,
        msDeEspera: 5000,
        atravessarNoVencimento: false,
    });
    assert.equal(decisao.acao, 'desistir');
});

// ---------------------------------------------------------------------------
// Preço da ordem passiva
// ---------------------------------------------------------------------------

test('a compra passiva fica NA melhor oferta, sem cruzar a melhor venda', () => {
    const preco = precoDaCompraPassiva({
        melhorCompra: new Decimal('100.00'),
        melhorVenda: new Decimal('100.05'),
        tickSize: new Decimal('0.01'),
    });
    assert.equal(preco?.toString(), '100');
});

test('recuo aumenta a economia e a seleção adversa junto — por isso o padrão é zero', () => {
    const semRecuo = precoDaCompraPassiva({
        melhorCompra: new Decimal('100.00'),
        melhorVenda: new Decimal('100.05'),
        tickSize: new Decimal('0.01'),
    });
    const comRecuo = precoDaCompraPassiva({
        melhorCompra: new Decimal('100.00'),
        melhorVenda: new Decimal('100.05'),
        tickSize: new Decimal('0.01'),
        recuoEmTiques: 3,
    });
    assert.equal(semRecuo?.toString(), '100');
    assert.equal(comRecuo?.toString(), '99.97');
});

test('book cruzado, vazio ou tique inválido recusa a ordem passiva em vez de inventar preço', () => {
    const tick = new Decimal('0.01');
    // Um preço inventado aqui viraria ordem enviada com número errado — que a
    // corretora aceita se estiver na grade, e aí o erro vira dinheiro.
    assert.equal(precoDaCompraPassiva({ melhorCompra: new Decimal('100.05'), melhorVenda: new Decimal('100.00'), tickSize: tick }), null);
    assert.equal(precoDaCompraPassiva({ melhorCompra: ZERO, melhorVenda: new Decimal('100'), tickSize: tick }), null);
    assert.equal(precoDaCompraPassiva({ melhorCompra: new Decimal('100'), melhorVenda: ZERO, tickSize: tick }), null);
    assert.equal(precoDaCompraPassiva({ melhorCompra: new Decimal('100'), melhorVenda: new Decimal('100.05'), tickSize: ZERO }), null);
});

test('recuo grande demais que zeraria o preço é recusado', () => {
    const preco = precoDaCompraPassiva({
        melhorCompra: new Decimal('0.02'),
        melhorVenda: new Decimal('0.03'),
        tickSize: new Decimal('0.01'),
        recuoEmTiques: 5,
    });
    assert.equal(preco, null);
});

test('o preço sai alinhado ao tique da corretora', () => {
    // Preço fora da grade é recusado pela Binance. Alinhar para BAIXO mantém a
    // ordem passiva; alinhar para cima poderia cruzar o book.
    const preco = precoDaCompraPassiva({
        melhorCompra: new Decimal('100.017'),
        melhorVenda: new Decimal('100.05'),
        tickSize: new Decimal('0.01'),
    });
    assert.equal(preco?.toString(), '100.01');
});

// ---------------------------------------------------------------------------
// O tamanho do prêmio
// ---------------------------------------------------------------------------

test('a economia é sobre o CAPITAL e cresce com a alavancagem', () => {
    // Taker 0,075% contra maker 0,045%: 0,03% por perna. Só a entrada vira
    // maker — a saída continua atravessando, porque stop atingido é sair agora.
    const economia = economiaPorOperacao({
        taxaTaker: new Decimal('0.00075'),
        taxaMaker: new Decimal('0.00045'),
        alavancagem: new Decimal(5),
    });
    assert.equal(economia.mul(100).toFixed(3), '0.150', '0,15% do capital por operação a 5x');
});

test('sem diferença entre as taxas a economia é zero, nunca negativa', () => {
    const economia = economiaPorOperacao({
        taxaTaker: new Decimal('0.00045'),
        taxaMaker: new Decimal('0.00075'), // maker mais cara: não existe prêmio
        alavancagem: new Decimal(5),
    });
    assert.equal(economia.toString(), '0');
});
