import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { getAmountOut, type Hop } from './ammMath';
import { perdaNaVenda, curvaDePerda, maiorVendaAte, cabeNestePool, poolNecessarioPara } from './venda';

/** Um pool com 1.000.000 de cada lado e taxa de 0,3% — o V2 de sempre. */
function pool(reserveIn = 1_000_000, reserveOut = 1_000_000, taxa = '0.003'): Hop {
    return {
        reserveIn: new Decimal(reserveIn),
        reserveOut: new Decimal(reserveOut),
        feeFraction: new Decimal(taxa),
    };
}

test('venda minúscula perde só a taxa do pool', () => {
    const p = perdaNaVenda(new Decimal('0.000001'), pool());
    assert.ok(p.escorregamento.lessThan('0.000000001'));
    assert.ok(p.total.minus('0.003').abs().lessThan('0.000001'));
});

test('o escorregamento sai exato da fórmula, não de aproximação', () => {
    // 1% da reserva entrando: dx/(x+dx) = 10000/1010000 = 0,990099...%
    const p = perdaNaVenda(new Decimal(10_000), pool());
    assert.equal(p.escorregamento.toFixed(8), new Decimal(10_000).dividedBy(1_010_000).toFixed(8));
});

test('a perda total confere com o que o pool realmente devolve', () => {
    // A definição tem que bater com a execução, senão é outra suposição.
    const h = pool();
    const entrada = new Decimal(50_000);
    const recebido = getAmountOut(entrada, h);
    const prometido = entrada.mul(h.reserveOut.dividedBy(h.reserveIn));
    const p = perdaNaVenda(entrada, h);
    assert.equal(p.total.toFixed(10), new Decimal(1).minus(recebido.dividedBy(prometido)).toFixed(10));
});

test('vender o tamanho da reserva inteira custa mais da metade', () => {
    // O caso que interessa para os $42 milhões: tamanho da ordem do pool.
    const p = perdaNaVenda(new Decimal(1_000_000), pool());
    assert.equal(p.escorregamento.toFixed(4), '0.5000');
    assert.ok(p.total.greaterThan('0.5'));
});

test('a perda cresce com o tamanho, sempre', () => {
    const c = curvaDePerda(pool(), [1, 100, 10_000, 1_000_000].map((n) => new Decimal(n)));
    for (let i = 1; i < c.length; i += 1) {
        assert.ok(
            c[i].perda.escorregamento.greaterThan(c[i - 1].perda.escorregamento),
            `ponto ${i} não cresceu`,
        );
    }
});

test('maiorVendaAte é o inverso exato do escorregamento', () => {
    // Ida e volta: o tamanho que o teto permite, medido de novo, dá o teto.
    const h = pool();
    for (const teto of ['0.001', '0.01', '0.05', '0.5']) {
        const maior = maiorVendaAte(new Decimal(teto), h);
        assert.equal(perdaNaVenda(maior, h).escorregamento.toFixed(9), new Decimal(teto).toFixed(9));
    }
});

test('teto sobre o escorregamento, não sobre a perda total', () => {
    // Se o teto valesse sobre o total, um teto de 0,2% num pool de taxa 0,3%
    // devolveria zero e faria parecer que o pool não serve para nada — quando
    // na verdade a taxa é a mesma para qualquer tamanho.
    assert.ok(maiorVendaAte(new Decimal('0.002'), pool()).greaterThan(0));
});

test('pool vazio não devolve "sem perda" — devolve perda total', () => {
    // Zero dividido por zero é onde um relatório vira ficção: reservas
    // ausentes têm que reprovar, não passar como pool perfeito.
    const p = perdaNaVenda(new Decimal(1_000), pool(0, 0));
    assert.equal(p.escorregamento.toNumber(), 1);
    assert.equal(p.total.toNumber(), 1);
});

test('cabeNestePool diz o teto mesmo quando a resposta é não', () => {
    const v = cabeNestePool(new Decimal(500_000), pool(), new Decimal('0.01'));
    assert.equal(v.cabe, false);
    assert.ok(v.maiorQueCabe.greaterThan(0));
    assert.match(v.leitura, /O máximo aqui é/);
});

test('cabeNestePool aprova o que cabe e diz quanto ainda sobra', () => {
    const v = cabeNestePool(new Decimal(1_000), pool(), new Decimal('0.01'));
    assert.equal(v.cabe, true);
    assert.match(v.leitura, /aguenta até/);
});

test('poolNecessarioPara fecha com maiorVendaAte nos dois sentidos', () => {
    const teto = new Decimal('0.01');
    for (const venda of [1_393, 10_713, 134_130, 22_156_192]) {
        const precisa = poolNecessarioPara(new Decimal(venda), teto);
        const cabe = maiorVendaAte(teto, {
            reserveIn: precisa,
            reserveOut: precisa,
            feeFraction: new Decimal('0.003'),
        });
        assert.ok(cabe.minus(venda).abs().lessThan('0.01'), `não fechou em ${venda}`);
    }
});

test('a gigante pede um pool que não existe', () => {
    // $42.202.270 de dívida, metade coberta, mais 5% de ágio = $22.156.192 a
    // vender. A 1% de empurrão isso pede mais de dois bilhões numa moeda só.
    // Não é questão de procurar melhor: esse pool não existe na Base.
    const venda = new Decimal(42_202_270).mul('0.5').mul('1.05');
    const precisa = poolNecessarioPara(venda, new Decimal('0.01'));
    assert.ok(precisa.greaterThan(2e9), `deu ${precisa.toFixed(0)}`);
});

test('a faixa do meio pede um pool comum', () => {
    // $20.406 de dívida pede pouco mais de um milhão de reserva. Isso é pool
    // de par principal, banal na Base. É por isso que a faixa chata é o plano.
    const venda = new Decimal(20_406).mul('0.5').mul('1.05');
    const precisa = poolNecessarioPara(venda, new Decimal('0.01'));
    assert.ok(precisa.lessThan(1.2e6), `deu ${precisa.toFixed(0)}`);
});
