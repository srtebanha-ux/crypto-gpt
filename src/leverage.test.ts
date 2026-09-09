// Arquivo: src/leverage.test.ts
//
// O que estes testes protegem não é uma fórmula bonita: é a diferença entre
// "arrisquei 2% do capital" e "perdi tudo". Alavancado, se a liquidação chega
// antes do stop, o número de risco que o dimensionamento calculou deixa de
// valer — e nada no sistema acusa isso. Não há exceção, não há log vermelho:
// a conta simplesmente zera numa operação que parecia comum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    MARGEM_DE_MANUTENCAO_PADRAO,
    alavancagemEfetiva,
    custoDeIdaEVoltaSobreCapital,
    distanciaAteLiquidacao,
    stopDisparaAntesDaLiquidacao,
} from './leverage';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

test('a liquidação chega ANTES de 1/alavancagem, porque a manutenção come parte da margem', () => {
    // A 10x a intuição diz 10%. A conta real diz 9,5% — e a diferença é
    // justamente a faixa onde alguém acharia estar seguro e não está.
    assert.equal(distanciaAteLiquidacao(new Decimal(10)).toString(), '0.095');
    assert.equal(distanciaAteLiquidacao(new Decimal(5)).toString(), '0.195');
    assert.equal(distanciaAteLiquidacao(new Decimal(2)).toString(), '0.495');
});

test('sem alavancagem não existe liquidação', () => {
    // No spot o preço pode ir a zero e ninguém fecha nada. 100% expressa isso;
    // devolver 0 faria toda operação à vista ser recusada pelo guarda.
    assert.equal(distanciaAteLiquidacao(new Decimal(1)).toString(), '1');
    assert.equal(distanciaAteLiquidacao(new Decimal('0.5')).toString(), '1');
});

test('alavancagem inválida falha em vez de devolver número utilizável', () => {
    assert.throws(() => distanciaAteLiquidacao(new Decimal(0)), /Alavancagem inválida/);
    assert.throws(() => distanciaAteLiquidacao(new Decimal(-3)), /Alavancagem inválida/);
});

test('o guarda RECUSA a operação em que a liquidação viria antes do stop', () => {
    // O caso real: alt em pump com ATR de 5% no gráfico de 15m. Stop a 2x ATR
    // fica a 10% do preço; a 10x a liquidação está a 9,5%. A operação que
    // parecia arriscar 2% do capital arrisca 100% dele.
    const veredicto = stopDisparaAntesDaLiquidacao({
        distanciaDoStop: new Decimal('0.10'),
        alavancagem: new Decimal(10),
    });
    assert.equal(veredicto.seguro, false);
    assert.ok(!veredicto.seguro && /liquidada ANTES do stop/.test(veredicto.motivo));
});

test('o guarda ACEITA o stop apertado que a alavancagem comporta', () => {
    // Stop a 2% com liquidação a 9,5%: sobra folga de verdade.
    const veredicto = stopDisparaAntesDaLiquidacao({
        distanciaDoStop: new Decimal('0.02'),
        alavancagem: new Decimal(10),
    });
    assert.equal(veredicto.seguro, true);
});

test('o guarda exige FOLGA em vez de deixar o stop encostar na liquidação', () => {
    // 9% de stop cabe dentro de 9,5% de liquidação — e mesmo assim é recusado.
    // A distância até a liquidação é uma ESTIMATIVA (a conta real da Binance
    // ainda desconta taxas de abertura e fechamento); confiar no último
    // centésimo dela é confiar demais numa aproximação.
    const encostando = stopDisparaAntesDaLiquidacao({
        distanciaDoStop: new Decimal('0.09'),
        alavancagem: new Decimal(10),
    });
    assert.equal(encostando.seguro, false, 'stop dentro da liquidação mas sem folga deve ser recusado');

    // Com folga explícita de 100% o mesmo stop passa — quem quiser assumir
    // esse risco tem que pedir por ele.
    const semFolga = stopDisparaAntesDaLiquidacao({
        distanciaDoStop: new Decimal('0.09'),
        alavancagem: new Decimal(10),
        folga: new Decimal(1),
    });
    assert.equal(semFolga.seguro, true);
});

test('à vista o guarda nunca recusa por liquidação', () => {
    // Um stop de 50% é péssima ideia, mas não é liquidação — e este guarda só
    // responde por liquidação. Recusar aqui bloquearia o motor spot inteiro.
    const veredicto = stopDisparaAntesDaLiquidacao({
        distanciaDoStop: new Decimal('0.5'),
        alavancagem: new Decimal(1),
    });
    assert.equal(veredicto.seguro, true);
});

test('stop inexistente é recusado, não tratado como stop perfeito', () => {
    const veredicto = stopDisparaAntesDaLiquidacao({
        distanciaDoStop: new Decimal(0),
        alavancagem: new Decimal(10),
    });
    assert.equal(veredicto.seguro, false);
    assert.ok(!veredicto.seguro && /zero ou negativa/.test(veredicto.motivo));
});

test('a alavancagem cai para 1x ao ATINGIR o alvo, não depois de passar dele', () => {
    const alvo = new Decimal(5000);
    const max = new Decimal(10);
    assert.equal(alavancagemEfetiva({ patrimonio: new Decimal(4999), alvo, alavancagemMaxima: max }).toString(), '10');
    assert.equal(alavancagemEfetiva({ patrimonio: new Decimal(5000), alvo, alavancagemMaxima: max }).toString(), '1');
    assert.equal(alavancagemEfetiva({ patrimonio: new Decimal(9000), alvo, alavancagemMaxima: max }).toString(), '1');
});

test('a regra do alvo é avaliada por patrimônio corrente, então ela VOLTA a alavancar se a conta cair', () => {
    // Consequência deliberada e vale estar escrita: passar de $5.000 e cair
    // para $4.000 religa a alavancagem. Quem quiser travar de vez ao tocar o
    // alvo precisa baixar DIRECTIONAL_LEVERAGE, não contar com esta regra.
    const alvo = new Decimal(5000);
    const max = new Decimal(10);
    assert.equal(alavancagemEfetiva({ patrimonio: new Decimal(4000), alvo, alavancagemMaxima: max }).toString(), '10');
});

test('alvo zerado desliga a regra, e alavancagem 1 ignora o alvo', () => {
    const max = new Decimal(10);
    assert.equal(
        alavancagemEfetiva({ patrimonio: new Decimal(999999), alvo: new Decimal(0), alavancagemMaxima: max }).toString(),
        '10',
        'sem alvo, a alavancagem configurada vale sempre',
    );
    assert.equal(
        alavancagemEfetiva({ patrimonio: new Decimal(1), alvo: new Decimal(5000), alavancagemMaxima: new Decimal(1) }).toString(),
        '1',
    );
});

test('o custo por operação é sobre o CAPITAL, e a 10x ele é 1% — não 0,05%', () => {
    // Olhar a taxa por perna e concluir que é barata é o erro que faz uma
    // estratégia lucrativa no papel sangrar até zerar. Cem operações a 10x
    // consomem a conta inteira em pedágio, sem ter perdido nenhuma.
    const taxaFuturos = new Decimal('0.0005');
    assert.equal(custoDeIdaEVoltaSobreCapital(new Decimal(10), taxaFuturos).toString(), '0.01');
    assert.equal(custoDeIdaEVoltaSobreCapital(new Decimal(1), taxaFuturos).toString(), '0.001');
    // A margem de manutenção padrão é a mais alta da faixa, de propósito.
    assert.equal(MARGEM_DE_MANUTENCAO_PADRAO.toString(), '0.005');
});
