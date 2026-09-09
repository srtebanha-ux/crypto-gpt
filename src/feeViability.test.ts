// Arquivo: src/feeViability.test.ts
//
// O filtro que a própria medição pediu: ao medir 15 minutos nas três famílias,
// a perda por operação bateu com o custo de uma ida e volta (breakout 0,94x,
// momentum 1,05x). Isso diz que o movimento capturado empatava com o pedágio.
// Estes testes protegem a regra que recusa a mesa onde a aposta não pode pagar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { operacaoValeATaxa } from './feeViability';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const TAXA = new Decimal('0.00075'); // 0,075% por perna => 0,15% ida e volta

test('recusa o ativo parado, onde a taxa come quase todo o movimento', () => {
    // Vela típica de 0,2% pagando 0,15% de pedágio: sobram 0,05% para a
    // estratégia inteira acertar. Nenhum sinal salva isso.
    const veredicto = operacaoValeATaxa({
        atr: new Decimal('0.2'),
        preco: new Decimal('100'), // ATR = 0,2%
        taxaPorPerna: TAXA,
        minimoEmTaxas: new Decimal(4),
    });
    assert.equal(veredicto.vale, false);
    assert.equal(veredicto.atrEmTaxas.toFixed(2), '1.33');
    assert.ok(!veredicto.vale && /comeria 75% do movimento/.test(veredicto.motivo));
});

test('aceita o ativo com movimento que comporta o custo', () => {
    // Vela típica de 2%: o pedágio é 7,5% do movimento disponível.
    const veredicto = operacaoValeATaxa({
        atr: new Decimal('2'),
        preco: new Decimal('100'),
        taxaPorPerna: TAXA,
        minimoEmTaxas: new Decimal(4),
    });
    assert.equal(veredicto.vale, true);
    assert.equal(veredicto.atrEmTaxas.toFixed(2), '13.33');
});

test('a fronteira é exatamente o mínimo pedido, e ela INCLUI o valor', () => {
    // Com mínimo 4 e custo 0,15%, a fronteira é ATR de 0,6%.
    const naFronteira = operacaoValeATaxa({
        atr: new Decimal('0.6'),
        preco: new Decimal('100'),
        taxaPorPerna: TAXA,
        minimoEmTaxas: new Decimal(4),
    });
    assert.equal(naFronteira.vale, true, 'exatamente no mínimo passa');

    const logoAbaixo = operacaoValeATaxa({
        atr: new Decimal('0.59'),
        preco: new Decimal('100'),
        taxaPorPerna: TAXA,
        minimoEmTaxas: new Decimal(4),
    });
    assert.equal(logoAbaixo.vale, false);
});

test('a alavancagem NÃO salva um ativo parado', () => {
    // Vale estar escrito: alavancar multiplica o movimento E a taxa na mesma
    // proporção. A razão entre os dois — que é o que este filtro mede — não
    // muda. Um ativo que não paga a taxa a 1x também não paga a 5x.
    const semAlavancagem = operacaoValeATaxa({
        atr: new Decimal('0.2'),
        preco: new Decimal('100'),
        taxaPorPerna: TAXA,
        minimoEmTaxas: new Decimal(4),
    });
    const comAlavancagem = operacaoValeATaxa({
        atr: new Decimal('1'), // 5x o movimento
        preco: new Decimal('100'),
        taxaPorPerna: TAXA.mul(5), // 5x a taxa
        minimoEmTaxas: new Decimal(4),
    });
    assert.equal(semAlavancagem.vale, comAlavancagem.vale);
    assert.equal(semAlavancagem.atrEmTaxas.toFixed(2), comAlavancagem.atrEmTaxas.toFixed(2));
});

test('mínimo zero ou negativo desliga o filtro', () => {
    for (const minimo of ['0', '-1']) {
        const veredicto = operacaoValeATaxa({
            atr: new Decimal('0.01'),
            preco: new Decimal('100'),
            taxaPorPerna: TAXA,
            minimoEmTaxas: new Decimal(minimo),
        });
        assert.equal(veredicto.vale, true, `mínimo ${minimo} não pode recusar nada`);
    }
});

test('taxa zero ou preço zero não vira divisão por infinito silenciosa', () => {
    // Sem custo não há o que exigir. O perigo é o contrário: dividir por zero
    // produziria um número infinito que passaria em qualquer comparação, e o
    // filtro deixaria tudo entrar sem nunca acusar por quê.
    const semTaxa = operacaoValeATaxa({
        atr: new Decimal('0.2'),
        preco: new Decimal('100'),
        taxaPorPerna: new Decimal(0),
        minimoEmTaxas: new Decimal(4),
    });
    assert.equal(semTaxa.vale, true);
    assert.ok(semTaxa.atrEmTaxas.isFinite());

    const semPreco = operacaoValeATaxa({
        atr: new Decimal('0.2'),
        preco: new Decimal(0),
        taxaPorPerna: TAXA,
        minimoEmTaxas: new Decimal(4),
    });
    assert.equal(semPreco.vale, true);
    assert.ok(semPreco.atrEmTaxas.isFinite());
});
