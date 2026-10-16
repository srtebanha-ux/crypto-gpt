// Arquivo: src/futurosMath.test.ts
//
// Os três erros que estes testes existem para impedir, em ordem de quanto
// custam: (1) achar que a margem é "parte" da banca quando é a banca toda,
// (2) achar que a liquidação a 30x fica a 3,33% quando fica antes disso, e
// (3) arredondar o stop para longe da entrada e perder mais do que o
// configurado sem que nada no log apareça diferente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    alavancagemPermitida,
    fracaoDaBancaEmMargem,
    margemNecessaria,
    movimentoAteLiquidacao,
    precoDeLiquidacao,
    precoDeSaidaNaGrade,
    quantidadeNaGrade,
    quantidadeParaNocional,
    saidasNaGrade,
    stopAntesDaLiquidacao,
} from './futurosMath';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const FILTROS = {
    tickSize: new Decimal('0.0001'),
    stepSize: new Decimal('1'),
    minQty: new Decimal('1'),
    minNotional: new Decimal('5'),
};

test('US$ 750 a 30x tranca US$ 25 — que é a banca inteira, não uma parte dela', () => {
    const nocional = new Decimal('750');
    const alavancagem = new Decimal('30');
    assert.equal(margemNecessaria({ nocional, alavancagem }).toString(), '25');

    const fracao = fracaoDaBancaEmMargem({ nocional, alavancagem, banca: new Decimal('25') });
    assert.equal(fracao.toString(), '1');
    // 1 significa: não sobra um centavo para uma segunda posição nem para a taxa.
});

test('metade do nocional deixa metade da banca livre — a diferença entre respirar e não', () => {
    const fracao = fracaoDaBancaEmMargem({
        nocional: new Decimal('375'),
        alavancagem: new Decimal('30'),
        banca: new Decimal('25'),
    });
    assert.equal(fracao.toString(), '0.5');
});

test('banca zerada devolve Infinity em vez de dividir por zero', () => {
    const fracao = fracaoDaBancaEmMargem({
        nocional: new Decimal('750'),
        alavancagem: new Decimal('30'),
        banca: new Decimal('0'),
    });
    assert.equal(fracao.isFinite(), false);
});

test('a liquidação a 30x NÃO fica a 3,33%: a manutenção adianta ela para 2,83%', () => {
    const mov = movimentoAteLiquidacao({ alavancagem: new Decimal('30'), manutencao: new Decimal('0.005') });
    assert.equal(mov.toFixed(6), '0.028333');
    // 2,83%, não 3,33%. Meio ponto percentual de diferença que uma altcoin
    // atravessa num gap de abertura sem tocar em nenhum preço no meio.
});

test('alavancagem cuja manutenção engole a margem inicial devolve 0, não negativo', () => {
    const mov = movimentoAteLiquidacao({ alavancagem: new Decimal('250'), manutencao: new Decimal('0.01') });
    assert.equal(mov.toString(), '0');
    // 1/250 = 0,4% < 1% de manutenção: a posição já nasce liquidável.
});

test('o preço de liquidação inverte de lado com a direção', () => {
    const comprado = precoDeLiquidacao({
        entrada: new Decimal('100'),
        direcao: 'alta',
        alavancagem: new Decimal('30'),
        manutencao: new Decimal('0.005'),
    });
    const vendido = precoDeLiquidacao({
        entrada: new Decimal('100'),
        direcao: 'baixa',
        alavancagem: new Decimal('30'),
        manutencao: new Decimal('0.005'),
    });
    assert.equal(comprado.lessThan(100), true);
    assert.equal(vendido.greaterThan(100), true);
    assert.equal(comprado.toFixed(4), '97.1666');
    assert.equal(vendido.toFixed(4), '102.8333');
});

test('um stop de 0,4% cabe MUITO antes da liquidação a 30x — é o único conforto da configuração', () => {
    const dentro = stopAntesDaLiquidacao({
        entrada: new Decimal('100'),
        stop: new Decimal('99.6'),
        direcao: 'alta',
        alavancagem: new Decimal('30'),
        manutencao: new Decimal('0.005'),
    });
    assert.equal(dentro, true);
});

test('um stop de 4% a 30x é ficção: a corretora liquida antes e cobra a taxa por cima', () => {
    const dentro = stopAntesDaLiquidacao({
        entrada: new Decimal('100'),
        stop: new Decimal('96'),
        direcao: 'alta',
        alavancagem: new Decimal('30'),
        manutencao: new Decimal('0.005'),
    });
    assert.equal(dentro, false);
});

test('o stop de venda também tem de ficar antes da liquidação, do lado de cima', () => {
    assert.equal(
        stopAntesDaLiquidacao({
            entrada: new Decimal('100'),
            stop: new Decimal('100.4'),
            direcao: 'baixa',
            alavancagem: new Decimal('30'),
            manutencao: new Decimal('0.005'),
        }),
        true,
    );
    assert.equal(
        stopAntesDaLiquidacao({
            entrada: new Decimal('100'),
            stop: new Decimal('104'),
            direcao: 'baixa',
            alavancagem: new Decimal('30'),
            manutencao: new Decimal('0.005'),
        }),
        false,
    );
});

test('a faixa escolhida é a MENOR que ainda comporta o nocional', () => {
    const faixas = [
        { nocionalMaximo: new Decimal('5000'), alavancagemMaxima: new Decimal('50'), manutencao: new Decimal('0.01') },
        { nocionalMaximo: new Decimal('50000'), alavancagemMaxima: new Decimal('20'), manutencao: new Decimal('0.025') },
    ];
    const faixa = alavancagemPermitida({ faixas, nocional: new Decimal('750') });
    assert.equal(faixa?.alavancagemMaxima.toString(), '50');
});

test('nocional que sobe de faixa perde alavancagem — a recusa por "margem insuficiente" que confunde', () => {
    const faixas = [
        { nocionalMaximo: new Decimal('5000'), alavancagemMaxima: new Decimal('50'), manutencao: new Decimal('0.01') },
        { nocionalMaximo: new Decimal('50000'), alavancagemMaxima: new Decimal('20'), manutencao: new Decimal('0.025') },
    ];
    const faixa = alavancagemPermitida({ faixas, nocional: new Decimal('20000') });
    assert.equal(faixa?.alavancagemMaxima.toString(), '20');
});

test('nocional acima de qualquer faixa devolve null: a posição não existe nesse tamanho', () => {
    const faixas = [
        { nocionalMaximo: new Decimal('5000'), alavancagemMaxima: new Decimal('50'), manutencao: new Decimal('0.01') },
    ];
    assert.equal(alavancagemPermitida({ faixas, nocional: new Decimal('9999999') }), null);
});

test('as faixas entram fora de ordem e a escolha continua certa', () => {
    const faixas = [
        { nocionalMaximo: new Decimal('50000'), alavancagemMaxima: new Decimal('20'), manutencao: new Decimal('0.025') },
        { nocionalMaximo: new Decimal('5000'), alavancagemMaxima: new Decimal('50'), manutencao: new Decimal('0.01') },
    ];
    assert.equal(alavancagemPermitida({ faixas, nocional: new Decimal('750') })?.alavancagemMaxima.toString(), '50');
});

test('a quantidade desce para a grade, nunca sobe: não se envia mais do que se pretende', () => {
    assert.equal(quantidadeNaGrade(new Decimal('7.99'), new Decimal('1')).toString(), '7');
    assert.equal(quantidadeNaGrade(new Decimal('0.12345'), new Decimal('0.001')).toString(), '0.123');
});

test('stepSize zero não trava a conta — devolve a quantidade como está', () => {
    assert.equal(quantidadeNaGrade(new Decimal('7.99'), new Decimal('0')).toString(), '7.99');
});

test('o nocional devolvido é o REAL, depois da grade — não o pedido', () => {
    const r = quantidadeParaNocional({ nocional: new Decimal('750'), preco: new Decimal('97'), filtros: FILTROS });
    assert.equal(r.ok, true);
    assert.equal(r.quantidade.toString(), '7'); // 750/97 = 7.73 -> 7
    assert.equal(r.nocionalReal.toString(), '679');
    // US$ 71 a menos do que o pedido. A margem trancada segue o nocional REAL.
});

test('nocional pequeno demais é recusado com o motivo certo, não com "falhou"', () => {
    const r = quantidadeParaNocional({ nocional: new Decimal('4'), preco: new Decimal('1'), filtros: FILTROS });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.motivo, 'abaixo_do_nocional_minimo');
});

test('preço alto demais para o nocional zera a quantidade e diz isso', () => {
    const r = quantidadeParaNocional({ nocional: new Decimal('750'), preco: new Decimal('90000'), filtros: FILTROS });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.motivo, 'quantidade_zerada');
});

test('quantidade abaixo do minQty é recusada mesmo com nocional suficiente', () => {
    const filtros = { ...FILTROS, stepSize: new Decimal('0.1'), minQty: new Decimal('10'), minNotional: new Decimal('5') };
    const r = quantidadeParaNocional({ nocional: new Decimal('100'), preco: new Decimal('50'), filtros });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.motivo, 'abaixo_do_minimo_de_qtd');
});

test('preço zero ou negativo lança em vez de devolver Infinity silencioso', () => {
    assert.throws(() => quantidadeParaNocional({ nocional: new Decimal('750'), preco: new Decimal('0'), filtros: FILTROS }));
});

test('acima da entrada o arredondamento DESCE; abaixo, SOBE — sempre encurtando', () => {
    const tick = new Decimal('0.01');
    const entrada = new Decimal('100');
    assert.equal(precoDeSaidaNaGrade({ preco: new Decimal('100.3049'), entrada, tickSize: tick }).toString(), '100.3');
    assert.equal(precoDeSaidaNaGrade({ preco: new Decimal('99.5951'), entrada, tickSize: tick }).toString(), '99.6');
});

test('o stop NUNCA fica mais longe da entrada depois da grade — a perda não cresce escondida', () => {
    const tick = new Decimal('0.01');
    const entrada = new Decimal('100');
    const s = saidasNaGrade({ entrada, alvo: new Decimal('100.3'), stop: new Decimal('99.5999'), tickSize: tick });
    assert.equal(s.stop.toString(), '99.6');
    assert.equal(s.stop.greaterThanOrEqualTo('99.5999'), true); // subiu = encurtou
    assert.equal(s.distanciaDoStop.lessThanOrEqualTo('0.004001'), true);
});

test('na VENDA a regra inverte sozinha: o stop fica acima e mesmo assim encurta', () => {
    const tick = new Decimal('0.01');
    const entrada = new Decimal('100');
    const s = saidasNaGrade({ entrada, alvo: new Decimal('99.7'), stop: new Decimal('100.4001'), tickSize: tick });
    assert.equal(s.stop.toString(), '100.4'); // desceu = encurtou
    assert.equal(s.alvo.toString(), '99.7');
});

test('a distância REAL depois da grade é a que dimensiona a perda, não a configurada', () => {
    // tickSize grosso: 0,50 num preço de 100. A grade move a saída de verdade.
    const s = saidasNaGrade({
        entrada: new Decimal('100'),
        alvo: new Decimal('100.3'),
        stop: new Decimal('99.6'),
        tickSize: new Decimal('0.5'),
    });
    assert.equal(s.alvo.toString(), '100'); // encurtou até a própria entrada
    assert.equal(s.stop.toString(), '100');
    assert.equal(s.distanciaDoAlvo.toString(), '0');
    assert.equal(s.distanciaDoStop.toString(), '0');
    // Distância zero é o sinal de que o par tem grade grossa demais para um
    // scalp de 0,3%: quem consome isto tem de recusar o par, não operar.
});

test('tickSize zero não altera o preço', () => {
    const p = precoDeSaidaNaGrade({ preco: new Decimal('100.30491'), entrada: new Decimal('100'), tickSize: new Decimal('0') });
    assert.equal(p.toString(), '100.30491');
});
