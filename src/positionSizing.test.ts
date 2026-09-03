// Arquivo: src/positionSizing.test.ts
//
// Estes testes cobrem os erros de EXECUÇÃO — a única classe de erro que dá
// para levar a zero numa estratégia direcional. Cada caso aqui é uma forma
// conhecida de destruir uma conta sem que nada tenha "quebrado": posição
// grande demais, stop do lado errado, quantidade arredondada para cima,
// stop que afrouxa quando o preço cai.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    consecutiveLossesSurvivable,
    expectancyPerTrade,
    planPosition,
    tradeNetPnl,
    truncateToStep,
    updateTrailingStop,
    updateTrailingStopAtr,
} from './positionSizing';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const d = (v: string) => new Decimal(v);

// --- Dimensionamento pela perda máxima --------------------------------------

test('a posição sai da distância até o stop, não do capital disponível', () => {
    // Capital 1000, risco 2% => aceita perder 20.
    // Entrada 100, stop 90 => arrisca 10 por unidade => 2 unidades.
    const plan = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('90'),
    });
    assert.equal(plan.quantity.toString(), '2');
    assert.equal(plan.riskAmount.toString(), '20');
    // Repare: o notional é 200, não 1000. "Comprar com tudo" seria 10 unidades
    // e uma perda de 100 no mesmo movimento — 5x o planejado.
    assert.equal(plan.notional.toString(), '200');
});

test('stop mais próximo => posição maior, com a MESMA perda em dinheiro', () => {
    // É a propriedade que mantém o risco constante entre ativos de
    // volatilidade diferente.
    const distante = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('80'),
    });
    const proximo = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('95'),
    });
    assert.ok(proximo.quantity.greaterThan(distante.quantity));
    assert.equal(proximo.riskAmount.toString(), distante.riskAmount.toString());
});

test('o capital é teto: stop muito próximo não gera posição alavancada', () => {
    // Entrada 100, stop 99.9 => a fórmula pediria 200 unidades (20000 de
    // notional) com capital de 1000. Sem o teto isso viraria alavancagem
    // acidental — o motor pedindo dinheiro que não existe.
    const plan = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('99.9'),
    });
    assert.ok(plan.notional.lessThanOrEqualTo(d('1000')));
    assert.equal(plan.quantity.toString(), '10');
});

// --- Recusas: situações em que NÃO operar é a resposta certa -----------------

test('stop acima da entrada é recusado — sem isso viraria venda a descoberto', () => {
    // Distância negativa produziria quantidade negativa, que uma camada acima
    // interpretaria como ordem de venda que ninguém pediu.
    const plan = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('110'),
    });
    assert.equal(plan.quantity.toString(), '0');
    assert.match(plan.reason!, /ABAIXO da entrada/);
});

test('stop igual à entrada é recusado (divisão por zero)', () => {
    const plan = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('100'),
    });
    assert.equal(plan.quantity.toString(), '0');
});

test('notional abaixo do mínimo da corretora recusa em vez de inflar a posição', () => {
    // A tentação seria "arredonda pra cima só pra passar do mínimo" — o que
    // furaria o limite de risco justamente quando o capital é pequeno.
    const plan = planPosition({
        capital: d('20'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('90'),
        minNotional: d('10'),
    });
    assert.equal(plan.quantity.toString(), '0');
    assert.match(plan.reason!, /abaixo do mínimo/);
});

test('capital, risco e preços inválidos são recusados com motivo, sem lançar', () => {
    // Recusar operar é resposta legítima e frequente, não exceção.
    const casos = [
        { capital: d('0'), riskFraction: d('0.02'), entryPrice: d('100'), stopPrice: d('90') },
        { capital: d('1000'), riskFraction: d('0'), entryPrice: d('100'), stopPrice: d('90') },
        { capital: d('1000'), riskFraction: d('1.5'), entryPrice: d('100'), stopPrice: d('90') },
        { capital: d('1000'), riskFraction: d('0.02'), entryPrice: d('0'), stopPrice: d('90') },
    ];
    for (const caso of casos) {
        const plan = planPosition(caso);
        assert.equal(plan.quantity.toString(), '0');
        assert.ok(plan.reason && plan.reason.length > 0);
    }
});

// --- Passo de quantidade ----------------------------------------------------

test('quantidade é truncada para BAIXO, nunca para cima', () => {
    // Arredondar para cima produz ordem maior que a planejada: fura o risco e,
    // no limite do saldo, a corretora rejeita por fundos insuficientes.
    assert.equal(truncateToStep(d('2.7'), d('1')).toString(), '2');
    assert.equal(truncateToStep(d('0.00123456'), d('0.00001')).toString(), '0.00123');
    assert.equal(truncateToStep(d('5'), undefined).toString(), '5');
});

test('passo grande demais para o capital => recusa, não posição zero silenciosa', () => {
    const plan = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('90'),
        stepSize: d('10'),
    });
    assert.equal(plan.quantity.toString(), '0');
    assert.match(plan.reason!, /truncada a zero/);
});

// --- Stop móvel -------------------------------------------------------------

test('trailing stop sobe com o preço', () => {
    const novo = updateTrailingStop(d('90'), d('120'), d('0.10'));
    assert.equal(novo.toString(), '108'); // 120 * 0.9
});

test('trailing stop NUNCA desce — é o que impede "dar mais uma chance"', () => {
    // Um stop que afrouxa quando o preço cai transforma perda pequena e
    // planejada em perda grande. É o erro de execução mais caro que existe.
    const mantido = updateTrailingStop(d('108'), d('100'), d('0.10'));
    assert.equal(mantido.toString(), '108');
});

test('fração de trailing inválida mantém o stop atual em vez de corrompê-lo', () => {
    assert.equal(updateTrailingStop(d('108'), d('200'), d('0')).toString(), '108');
    assert.equal(updateTrailingStop(d('108'), d('200'), d('1')).toString(), '108');
});

// --- A conta que realmente decide lucratividade -----------------------------

test('acertar 40% pode ser lucrativo; acertar 90% pode quebrar a conta', () => {
    // O ponto central: "taxa de erro mínima" é a métrica errada. O que decide
    // é ganho médio contra perda média.
    const poucosAcertosGanhosGrandes = expectancyPerTrade(d('0.40'), d('300'), d('100'));
    const muitosAcertosPerdasGrandes = expectancyPerTrade(d('0.90'), d('100'), d('1000'));

    assert.ok(poucosAcertosGanhosGrandes.greaterThan(0), '40% de acerto com ganho 3x é lucrativo');
    assert.ok(muitosAcertosPerdasGrandes.lessThan(0), '90% de acerto com perda 10x quebra');
});

test('expectativa zero quando ganho e perda se equilibram na proporção certa', () => {
    // 50% de acerto com ganho igual à perda => jogo justo (antes das taxas).
    assert.equal(expectancyPerTrade(d('0.5'), d('100'), d('100')).toString(), '0');
});

// --- Sobrevivência a sequências de perda ------------------------------------

test('risco menor por operação => sobrevive a mais perdas seguidas', () => {
    // Sequências de 8-10 perdas seguidas acontecem em qualquer estratégia
    // direcional. O parâmetro de risco tem que ser escolhido para sobreviver a
    // elas, não para maximizar o ganho da próxima operação.
    const risco2 = consecutiveLossesSurvivable(d('0.02'));
    const risco10 = consecutiveLossesSurvivable(d('0.10'));
    assert.ok(risco2 > risco10);
    assert.ok(risco2 > 30, 'a 2% por operação, dezenas de perdas seguidas ainda deixam metade do capital');
    assert.ok(risco10 < 10, 'a 10% por operação, menos de dez perdas seguidas já custam metade');
});

test('risco inválido devolve zero sobrevivências em vez de número sem sentido', () => {
    assert.equal(consecutiveLossesSurvivable(d('0')), 0);
    assert.equal(consecutiveLossesSurvivable(d('1')), 0);
});

// --- Stop móvel em ATR (a correção do trailing percentual) -------------------

test('trailing em ATR engata assim que o preço avança mais que a volatilidade', () => {
    // O defeito do trailing percentual: com ATR de 1h ~0,5% do preço, o stop
    // inicial fica ~1% abaixo da entrada e um trailing de 15% só passaria a
    // valer depois de +16,5%. Na prática nunca engatava, e toda operação
    // morria no stop — 3% de taxa de acerto, assinatura de estratégia sem
    // saída de lucro.
    const entrada = d('100000');
    const atrValue = d('500');
    const stopInicial = entrada.minus(atrValue.mul(2)); // 99000

    // Percentual: precisa de +16,5% para o candidato superar o stop inicial.
    const percentual = updateTrailingStop(stopInicial, d('105000'), d('0.15'));
    assert.equal(percentual.toString(), stopInicial.toString(), 'com +5% o trailing percentual nem se mexe');

    // ATR: com o mesmo +5%, já sobe.
    const porAtr = updateTrailingStopAtr(stopInicial, d('105000'), atrValue, d('3'));
    assert.ok(porAtr.greaterThan(stopInicial), 'o trailing em ATR acompanha o avanço');
    assert.equal(porAtr.toString(), '103500'); // 105000 − 3×500
});

test('trailing em ATR também nunca desce', () => {
    const mantido = updateTrailingStopAtr(d('103500'), d('101000'), d('500'), d('3'));
    assert.equal(mantido.toString(), '103500');
});

test('trailing em ATR com valores inválidos mantém o stop atual', () => {
    assert.equal(updateTrailingStopAtr(d('99000'), d('105000'), d('0'), d('3')).toString(), '99000');
    assert.equal(updateTrailingStopAtr(d('99000'), d('105000'), d('500'), d('0')).toString(), '99000');
});

test('trailing em ATR aperta sozinho quando a volatilidade cai', () => {
    // Mesma alta, ATR menor => stop mais colado. É o comportamento desejado:
    // mercado calmo permite proteger mais lucro sem ser estourado por ruído.
    const volatil = updateTrailingStopAtr(d('99000'), d('110000'), d('1000'), d('3'));
    const calmo = updateTrailingStopAtr(d('99000'), d('110000'), d('200'), d('3'));
    assert.ok(calmo.greaterThan(volatil));
});

// --- Caixa livre num motor multi-ativo --------------------------------------

test('caixa livre limita a posição — quatro ativos não comprometem quatro vezes o capital', () => {
    // Sem `availableCapital`, cada ativo dimensiona contra o capital TOTAL e
    // quatro posições simultâneas pedem quatro vezes o dinheiro que existe.
    // Isso é alavancagem acidental: ninguém pediu, e a corretora rejeita a
    // quarta ordem por saldo — ou pior, aceita usando margem.
    const semCaixa = planPosition({
        capital: d('1000'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('99.9'), // stop colado => a fórmula pede posição enorme
    });
    assert.equal(semCaixa.notional.toString(), '1000');

    const comCaixa = planPosition({
        capital: d('1000'),
        availableCapital: d('250'), // 750 já presos em outras posições
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('99.9'),
    });
    assert.equal(comCaixa.notional.toString(), '250');
});

test('o orçamento de RISCO continua saindo do patrimônio total, não do caixa livre', () => {
    // A perda aceita por operação é uma fração do patrimônio; se ela encolhesse
    // junto com o caixa, o risco por operação cairia sozinho a cada posição
    // aberta e a estratégia deixaria de ser a que foi medida no backtest.
    const plan = planPosition({
        capital: d('1000'),
        availableCapital: d('500'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('90'), // stop largo: o teto de caixa não morde
    });
    assert.equal(plan.riskAmount.toString(), '20'); // 2% de 1000, não de 500
    assert.equal(plan.quantity.toString(), '2');
});

test('sem caixa livre, recusa com motivo em vez de operar com dinheiro inexistente', () => {
    const plan = planPosition({
        capital: d('1000'),
        availableCapital: d('0'),
        riskFraction: d('0.02'),
        entryPrice: d('100'),
        stopPrice: d('90'),
    });
    assert.equal(plan.quantity.toString(), '0');
    assert.match(plan.reason!, /caixa livre/);
});

// --- Taxas nas duas pontas --------------------------------------------------

test('a taxa é cobrada na compra E na venda', () => {
    // 10 unidades a 100 = 1000 de entrada, saída a 110 = 1100.
    // Bruto +100; taxas 0,1%: 1 na entrada, 1,1 na saída => líquido 97,90.
    const { netProfit, feesPaid } = tradeNetPnl(d('100'), d('110'), d('10'), d('0.001'));
    assert.equal(netProfit.toString(), '97.9');
    assert.equal(feesPaid.toString(), '2.1');
});

test('movimento pequeno demais vira prejuízo depois das taxas', () => {
    // Este é o motivo de a taxa não poder ficar de fora do modo papel: uma alta
    // de 0,1% parece ganho e é perda. Se o papel não cobrasse taxa, o motor
    // reportaria lucro numa operação que, ao vivo, custa dinheiro.
    const { netProfit } = tradeNetPnl(d('100'), d('100.1'), d('10'), d('0.001'));
    assert.ok(netProfit.lessThan(0), `+0,1% com 0,2% de custo tem que dar prejuízo, deu ${netProfit}`);
});

test('operação sem variação de preço perde exatamente as duas taxas', () => {
    const { netProfit, feesPaid } = tradeNetPnl(d('100'), d('100'), d('10'), d('0.001'));
    assert.equal(netProfit.toString(), '-2');
    assert.equal(feesPaid.toString(), '2');
});
