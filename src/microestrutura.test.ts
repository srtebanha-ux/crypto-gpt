// Arquivo: src/microestrutura.test.ts
//
// O que estes testes protegem é a aritmética que separa "scalping" de
// "doação". A conta é curta e implacável: atravessar o spread nas duas pontas
// custa um spread inteiro, e nenhum sinal de microestrutura, por melhor que
// seja, sobrevive a um custo maior que o movimento que ele prevê.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    analisarSpread,
    desequilibrioDoLivro,
    desequilibrioPonderado,
    lucroPorGiroColocandoOferta,
    movimentoParaLucrarAtravessando,
    sinalPorDesequilibrio,
} from './microestrutura';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const nivel = (preco: string, qtd: string) => ({ preco: new Decimal(preco), quantidade: new Decimal(qtd) });

test('o tique como fração do preço é o PISO de qualquer spread', () => {
    // BTC a $100.000 com tique de $0,01: o menor spread possível vale
    // 0,00001% do preço — desprezível. É por isso que par de preço alto é
    // barato de atravessar mesmo sem taxa zero.
    const btc = analisarSpread({
        melhorCompra: new Decimal('100000.00'),
        melhorVenda: new Decimal('100000.01'),
        tickSize: new Decimal('0.01'),
    });
    assert.ok(btc);
    assert.equal(btc.spreadEmTiques.toString(), '1');
    assert.ok(btc.tiqueFracao.lessThan('0.0000002'), 'no BTC o tique é ruído');

    // Uma moeda de centavos com o MESMO spread de 1 tique: o tique vale 0,08%
    // do preço. O menor custo possível de ida e volta já é maior que a taxa
    // da corretora — e nenhuma taxa zero conserta isso.
    const moedinha = analisarSpread({
        melhorCompra: new Decimal('0.0012340'),
        melhorVenda: new Decimal('0.0012350'),
        tickSize: new Decimal('0.0000010'),
    });
    assert.ok(moedinha);
    assert.equal(moedinha.spreadEmTiques.toString(), '1');
    assert.ok(moedinha.tiqueFracao.greaterThan('0.0008'), 'na moeda de centavos o tique é o custo dominante');
});

test('atravessar as duas pontas exige movimento MAIOR que o spread, mesmo com taxa ZERO', () => {
    // O ponto que derruba "lucrar com casas decimais atravessando o book":
    // sem taxa nenhuma, ainda sobra o spread inteiro para pagar.
    const spread = analisarSpread({
        melhorCompra: new Decimal('0.0012340'),
        melhorVenda: new Decimal('0.0012350'),
        tickSize: new Decimal('0.0000010'),
    })!;
    const veredicto = movimentoParaLucrarAtravessando({
        spread,
        taxaPorPerna: new Decimal(0),
        folga: new Decimal(1),
    });
    assert.ok(veredicto.operavel);
    assert.ok(
        veredicto.operavel && veredicto.movimentoMinimo.greaterThan('0.0008'),
        'com taxa zero o piso continua sendo o spread',
    );
});

test('taxa zero num par de preço alto torna o custo desprezível — é aí que a conta vira', () => {
    const spread = analisarSpread({
        melhorCompra: new Decimal('100000.00'),
        melhorVenda: new Decimal('100000.01'),
        tickSize: new Decimal('0.01'),
    })!;
    const comTaxa = movimentoParaLucrarAtravessando({
        spread,
        taxaPorPerna: new Decimal('0.00075'),
        folga: new Decimal(1),
    });
    const semTaxa = movimentoParaLucrarAtravessando({
        spread,
        taxaPorPerna: new Decimal(0),
        folga: new Decimal(1),
    });
    assert.ok(comTaxa.operavel && semTaxa.operavel);
    assert.ok(comTaxa.operavel && comTaxa.movimentoMinimo.greaterThan('0.0014'), 'com taxa, precisa de 0,15%');
    assert.ok(semTaxa.operavel && semTaxa.movimentoMinimo.lessThan('0.0000002'), 'sem taxa, praticamente nada');
});

test('colocar oferta RECEBE o spread — o lado oposto da mesma moeda', () => {
    const spread = analisarSpread({
        melhorCompra: new Decimal('0.0012340'),
        melhorVenda: new Decimal('0.0012350'),
        tickSize: new Decimal('0.0000010'),
    })!;
    const giro = lucroPorGiroColocandoOferta({
        spread,
        taxaMakerPorPerna: new Decimal(0),
        selecaoAdversaEstimada: new Decimal(0),
    });
    assert.ok(giro.positivo);
    assert.ok(giro.lucroFracao.greaterThan('0.0008'), 'o mesmo spread que mata o taker paga o maker');
});

test('a seleção adversa é o que derruba o market maker amador', () => {
    // Sem estimar isso, a conta devolveria lucro garantido em qualquer par com
    // spread — falso, e caro. A compra parada preenche preferencialmente
    // quando o preço cai; a venda, quando sobe.
    const spread = analisarSpread({
        melhorCompra: new Decimal('0.0012340'),
        melhorVenda: new Decimal('0.0012350'),
        tickSize: new Decimal('0.0000010'),
    })!;
    const giro = lucroPorGiroColocandoOferta({
        spread,
        taxaMakerPorPerna: new Decimal(0),
        selecaoAdversaEstimada: new Decimal('0.0015'),
    });
    assert.equal(giro.positivo, false, 'seleção adversa maior que o spread torna o giro perdedor');
});

test('book cruzado, vazio ou tique inválido não devolve spread negativo', () => {
    // Spread negativo passa em QUALQUER filtro de "vale a pena" — o pior tipo
    // de erro silencioso possível aqui.
    const tick = new Decimal('0.01');
    assert.equal(analisarSpread({ melhorCompra: new Decimal(101), melhorVenda: new Decimal(100), tickSize: tick }), null);
    assert.equal(analisarSpread({ melhorCompra: new Decimal(100), melhorVenda: new Decimal(100), tickSize: tick }), null);
    assert.equal(analisarSpread({ melhorCompra: new Decimal(0), melhorVenda: new Decimal(100), tickSize: tick }), null);
    assert.equal(analisarSpread({ melhorCompra: new Decimal(100), melhorVenda: new Decimal(101), tickSize: new Decimal(0) }), null);
});

test('desequilíbrio vai de −1 a +1 e mede PRESSÃO', () => {
    const soCompra = desequilibrioDoLivro({ compras: [nivel('100', '10')], vendas: [nivel('101', '0')] });
    const soVenda = desequilibrioDoLivro({ compras: [nivel('100', '0')], vendas: [nivel('101', '10')] });
    const equilibrio = desequilibrioDoLivro({ compras: [nivel('100', '5')], vendas: [nivel('101', '5')] });
    assert.equal(soCompra?.toString(), '1');
    assert.equal(soVenda?.toString(), '-1');
    assert.equal(equilibrio?.toString(), '0');
});

test('livro vazio devolve null, não zero — "não sei" não é "neutro"', () => {
    // Zero passaria em filtros de neutralidade como se fosse informação.
    assert.equal(desequilibrioDoLivro({ compras: [], vendas: [] }), null);
});

test('a profundidade limita quantos níveis contam', () => {
    const compras = [nivel('100', '1'), nivel('99', '100')];
    const vendas = [nivel('101', '1'), nivel('102', '100')];
    const raso = desequilibrioDoLivro({ compras, vendas, profundidade: 1 });
    assert.equal(raso?.toString(), '0', 'no primeiro nível está equilibrado');
});

test('o desequilíbrio PONDERADO ignora a parede longe do preço', () => {
    // Robôs enchem níveis distantes para simular pressão que some quando o
    // preço chega perto. O desequilíbrio simples cai nessa; o ponderado não.
    const compras = [nivel('100.00', '1'), nivel('90.00', '1000')];
    const vendas = [nivel('100.01', '1')];
    const simples = desequilibrioDoLivro({ compras, vendas, profundidade: 10 })!;
    const ponderado = desequilibrioPonderado({
        compras,
        vendas,
        precoMedio: new Decimal('100.005'),
        tickSize: new Decimal('0.01'),
        profundidade: 10,
    })!;
    assert.ok(simples.greaterThan('0.99'), 'o simples enxerga pressão compradora esmagadora');
    assert.ok(ponderado.lessThan('0.5'), 'o ponderado enxerga que a parede está longe demais para importar');
});

test('sinal perfeito num par caro é recusado — prever direção não basta', () => {
    // A guarda que separa "o sinal estava certo" de "a operação deu lucro".
    const spread = analisarSpread({
        melhorCompra: new Decimal('0.0012340'),
        melhorVenda: new Decimal('0.0012350'),
        tickSize: new Decimal('0.0000010'),
    })!;
    const decisao = sinalPorDesequilibrio({
        desequilibrio: new Decimal('0.95'),
        limiar: new Decimal('0.6'),
        spread,
        taxaPorPerna: new Decimal(0),
        movimentoEsperado: new Decimal('0.0003'),
    });
    assert.equal(decisao.acao, 'nada');
    assert.match(decisao.motivo, /não cobre o custo/);
});

test('o mesmo sinal PASSA quando o movimento esperado cobre o custo', () => {
    const spread = analisarSpread({
        melhorCompra: new Decimal('100000.00'),
        melhorVenda: new Decimal('100000.01'),
        tickSize: new Decimal('0.01'),
    })!;
    const decisao = sinalPorDesequilibrio({
        desequilibrio: new Decimal('0.95'),
        limiar: new Decimal('0.6'),
        spread,
        taxaPorPerna: new Decimal(0),
        movimentoEsperado: new Decimal('0.003'),
    });
    assert.equal(decisao.acao, 'comprar');
});

test('pressão vendedora forte vira sinal de VENDA, não ausência de sinal', () => {
    const spread = analisarSpread({
        melhorCompra: new Decimal('100000.00'),
        melhorVenda: new Decimal('100000.01'),
        tickSize: new Decimal('0.01'),
    })!;
    const decisao = sinalPorDesequilibrio({
        desequilibrio: new Decimal('-0.9'),
        limiar: new Decimal('0.6'),
        spread,
        taxaPorPerna: new Decimal(0),
        movimentoEsperado: new Decimal('0.003'),
    });
    assert.equal(decisao.acao, 'vender');
});
