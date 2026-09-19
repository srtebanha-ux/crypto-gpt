import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { VEZES_O_GAS_EXIGIDAS, avaliar, pisoParaOContrato, type Oportunidade } from './decisao';

/** Uma liquidação da faixa do meio medida na Base: US$20.406 a 5% de ágio. */
function oportunidade(p: Partial<Oportunidade> = {}): Oportunidade {
    return {
        dividaCobertaUsd: new Decimal(20_406),
        bonus: new Decimal('0.05'),
        premioFlashLoan: new Decimal('0.0005'),
        perdaNaTroca: new Decimal('0.003'),
        gasEstimado: new Decimal(700_000),
        /*
         * 1 gwei — e esse número saiu das medições, não de um chute.
         *
         * As vitórias medidas na Base em 18/09 custaram entre R$1,35 e R$49,57.
         * Com 700 mil de gás e o ETH a US$2.600, isso corresponde a 0,135 gwei
         * no dia calmo e 4,95 gwei no bloco de pânico. Um gwei fica no meio.
         *
         * A primeira versão deste teste usava 0,005 gwei, quinhentas vezes
         * menos que o real, e por causa disso dois testes afirmavam que
         * liquidação pequena não paga o gás. Afirmavam errado.
         */
        precoDoGasWei: new Decimal('1e9'),
        precoNativoUsd: new Decimal(2_600),
        ...p,
    };
}

test('a faixa do meio da Base vale a pena com folga', () => {
    const v = avaliar(oportunidade());
    assert.equal(v.vale, true, v.leitura);
    // Ágio de 5% sobre 20.406 = 1.020,30
    assert.equal(v.lucroBrutoUsd.toFixed(2), '1020.30');
    assert.ok(v.lucroLiquidoUsd.greaterThan(900), v.leitura);
});

test('o ágio NÃO é o lucro — os três custos saem dele', () => {
    // O erro que esta conta existe para evitar: "5% de 20 mil é mil dólares"
    // ignora empréstimo, troca e gás.
    const v = avaliar(oportunidade());
    const soma = v.custoEmprestimoUsd.plus(v.custoTrocaUsd).plus(v.custoGasUsd);
    assert.equal(v.lucroBrutoUsd.minus(soma).toFixed(6), v.lucroLiquidoUsd.toFixed(6));
    assert.ok(soma.greaterThan(0), 'custo nenhum é zero neste cenário');
});

test('a perda da troca incide sobre a GARANTIA, não sobre a dívida', () => {
    // A garantia é a dívida MAIS o ágio. Calcular sobre a dívida subestimaria
    // o custo justamente nas liquidações de ágio alto, que são as melhores.
    const v = avaliar(oportunidade({ perdaNaTroca: new Decimal('0.01') }));
    const sobreDivida = new Decimal(20_406).mul('0.01');
    assert.ok(v.custoTrocaUsd.greaterThan(sobreDivida), 'tem de ser maior que sobre a dívida');
    assert.equal(v.custoTrocaUsd.toFixed(2), new Decimal(20_406).mul('1.05').mul('0.01').toFixed(2));
});

test('POEIRA não vale — mas o corte é muito mais baixo do que eu supunha', () => {
    // Eu vinha dizendo que liquidação pequena "não paga nem o gás". Com o gás
    // da Base isso só vale para a poeira de verdade. Com gás a 1 gwei, o ponto
    // de virada fica perto de US$157 de dívida — e a Base tem 394 liquidações
    // entre mil e dez mil dólares, todas confortavelmente acima disso.
    assert.equal(avaliar(oportunidade({ dividaCobertaUsd: new Decimal(20) })).vale, false);
    assert.equal(avaliar(oportunidade({ dividaCobertaUsd: new Decimal(100) })).vale, false);
    assert.equal(avaliar(oportunidade({ dividaCobertaUsd: new Decimal(500) })).vale, true);
});

test('no bloco de pânico o corte sobe dez vezes', () => {
    // O gás de pânico medido foi 4,95 gwei. A mesma liquidação de US$500 que
    // vale num dia calmo deixa de valer quando o mercado ferve — e é
    // justamente quando as oportunidades aparecem.
    const panico = { precoDoGasWei: new Decimal('4.95e9') };
    assert.equal(avaliar(oportunidade({ dividaCobertaUsd: new Decimal(500), ...panico })).vale, false);
    assert.equal(avaliar(oportunidade({ dividaCobertaUsd: new Decimal(1_000), ...panico })).vale, true);
});

test('lucro positivo mas apertado é RECUSADO, e a leitura diz por quê', () => {
    // Sobrar um pouco não basta. Tentativa perdida gasta gás e devolve nada,
    // então cada vitória precisa pagar várias tentativas.
    const v = avaliar(
        oportunidade({ dividaCobertaUsd: new Decimal(600), precoDoGasWei: new Decimal('4.95e9') }),
    );
    assert.ok(v.lucroLiquidoUsd.greaterThan(0), 'este cenário tem de ser lucrativo e ainda assim recusado');
    assert.equal(v.vale, false);
    assert.match(v.leitura, /APERTADO DEMAIS/);
    assert.match(v.leitura, /tentativa perdida também paga gás/);
});

test('a exigência é sobre a TAXA DE ACERTO, não conforto', () => {
    // Exigir 3x equivale a supor que se ganha uma em três. Se a taxa medida
    // for melhor, o número cai e mais oportunidades passam a valer.
    const o = oportunidade({ dividaCobertaUsd: new Decimal(900) });
    const exigente = avaliar(o, new Decimal(10));
    const tolerante = avaliar(o, new Decimal(1));
    assert.equal(exigente.lucroLiquidoUsd.toFixed(6), tolerante.lucroLiquidoUsd.toFixed(6));
    assert.ok(!exigente.vale || tolerante.vale, 'mais exigente nunca aprova o que o tolerante recusa');
});

test('gás caro reprova o que gás barato aprovaria', () => {
    const barato = avaliar(oportunidade({ dividaCobertaUsd: new Decimal(1500), precoDoGasWei: new Decimal(1_000_000) }));
    const caro = avaliar(oportunidade({ dividaCobertaUsd: new Decimal(1500), precoDoGasWei: new Decimal(500_000_000) }));
    assert.ok(caro.custoGasUsd.greaterThan(barato.custoGasUsd));
    assert.ok(!caro.vale || barato.vale);
});

test('sem troca o custo da troca é zero — e sobra mais', () => {
    const comTroca = avaliar(oportunidade());
    const semTroca = avaliar(oportunidade({ perdaNaTroca: new Decimal(0) }));
    assert.equal(semTroca.custoTrocaUsd.toString(), '0');
    assert.ok(semTroca.lucroLiquidoUsd.greaterThan(comTroca.lucroLiquidoUsd));
});

test('ágio maior rende mais — os bônus medidos foram 5%, 7,5% e 8,5%', () => {
    const cinco = avaliar(oportunidade({ bonus: new Decimal('0.05') }));
    const oitoEMeio = avaliar(oportunidade({ bonus: new Decimal('0.085') }));
    assert.ok(oitoEMeio.lucroLiquidoUsd.greaterThan(cinco.lucroLiquidoUsd));
});

test('VEZES_O_GAS_EXIGIDAS é o padrão quando não se passa nada', () => {
    const o = oportunidade({ dividaCobertaUsd: new Decimal(700) });
    assert.equal(avaliar(o).vale, avaliar(o, VEZES_O_GAS_EXIGIDAS).vale);
});

// ---------------------------------------------------------------------------
// O piso mandado ao contrato.
// ---------------------------------------------------------------------------

test('o piso fica ABAIXO do esperado — o preço se move entre decidir e executar', () => {
    // Exigir exatamente o esperado faria a transação reverter por um centavo,
    // queimando o gás de uma caçada boa.
    const piso = pisoParaOContrato({
        lucroLiquidoUsd: new Decimal(1000),
        custoGasUsd: new Decimal(10),
        precoDoTokenUsd: new Decimal(1),
        decimaisDoToken: 6,
    });
    // 20% de folga sobre 1000 = 800 dólares, em USDC de 6 casas.
    assert.equal(piso.toString(), '800000000');
});

test('mas o piso NUNCA desce abaixo do gás', () => {
    // Completar uma caçada que não paga o próprio gás custa gás também — só
    // que com aparência de sucesso, que é pior que reverter.
    const piso = pisoParaOContrato({
        lucroLiquidoUsd: new Decimal(12),
        custoGasUsd: new Decimal(10),
        precoDoTokenUsd: new Decimal(1),
        decimaisDoToken: 6,
    });
    // 12 × 0,8 = 9,6, que é menos que o gás: o piso vira 10.
    assert.equal(piso.toString(), '10000000');
});

test('o piso respeita as casas decimais do token', () => {
    const emWeth = pisoParaOContrato({
        lucroLiquidoUsd: new Decimal(2600),
        custoGasUsd: new Decimal(1),
        precoDoTokenUsd: new Decimal(2600),
        decimaisDoToken: 18,
    });
    // 2600 × 0,8 = 2080 dólares = 0,8 ETH
    assert.equal(emWeth.toString(), '800000000000000000');
});

test('preço de token desconhecido devolve piso zero, não um número torto', () => {
    const p = pisoParaOContrato({
        lucroLiquidoUsd: new Decimal(1000),
        custoGasUsd: new Decimal(10),
        precoDoTokenUsd: new Decimal(0),
        decimaisDoToken: 6,
    });
    assert.equal(p.toString(), '0');
});

// ---------------------------------------------------------------- resumo

import { resumirAvaliacoes, LINHAS_NO_LOG, type ItemAvaliado, type Veredicto } from './decisao';

function item(chave: string, dividaUsd: number, lucro: number, queda: number | null = 5): ItemAvaliado {
    const veredicto: Veredicto = {
        lucroBrutoUsd: new Decimal(lucro),
        custoEmprestimoUsd: new Decimal(0),
        custoTrocaUsd: new Decimal(0),
        custoGasUsd: new Decimal('0.01'),
        lucroLiquidoUsd: new Decimal(lucro),
        vezesOGas: new Decimal(lucro).dividedBy('0.01'),
        vale: lucro > 0,
        leitura: '',
    };
    return { chave, queda, dividaUsd: new Decimal(dividaUsd), veredicto };
}

test('mostra as que mais pagam, não as que chegaram primeiro', () => {
    // O defeito medido numa ronda de verdade: o vigia cortava `slice(0, 10)`
    // da lista de descoberta, e a posição mais valiosa da borda — $1.875.733
    // a 2,12% de queda — era a décima primeira. O relatório saía inteiro, sem
    // erro nenhum, e sem o número que mais importava.
    const itens = [
        ...Array.from({ length: 10 }, (_, i) => item(`0xpequena${i}`, 1_000, 20)),
        item('0x67d0938f', 1_875_733, 43_000, 2.12),
    ];
    const r = resumirAvaliacoes(itens);
    assert.equal(r.linhas.length, LINHAS_NO_LOG);
    assert.match(r.linhas[0], /0x67d0938f/);
    assert.match(r.linhas[0], /43000\.00/);
});

test('a soma é de todas as que valem, não só das que aparecem no log', () => {
    // `somaSeGanhasseTodas` dizia "todas" somando a amostra. Aqui 15 valem,
    // 10 aparecem, e a soma tem que ser das 15.
    const itens = Array.from({ length: 15 }, (_, i) => item(`0x${i}`, 1_000, 100));
    const r = resumirAvaliacoes(itens);
    assert.equal(r.quantasValem, 15);
    assert.equal(r.quantasAvaliadas, 15);
    assert.equal(r.linhas.length, LINHAS_NO_LOG);
    assert.equal(r.somaLiquidaUsd.toNumber(), 1_500);
});

test('quem não vale o gás fica fora da soma e das linhas', () => {
    const r = resumirAvaliacoes([item('0xvale', 50_000, 1_044), item('0xnao', 95, 0)]);
    assert.equal(r.quantasValem, 1);
    assert.equal(r.quantasAvaliadas, 2);
    assert.equal(r.somaLiquidaUsd.toNumber(), 1_044);
    assert.equal(r.linhas.length, 1);
});

test('conta as posições na mira com dívida zero em vez de escondê-las', () => {
    // Estar na mira significa estar perto de liquidar; ler dívida $0 aí é
    // contradição, e contradição contada vira pergunta — escondida, vira nada.
    const r = resumirAvaliacoes([item('0x1c976fa1', 0, 0, 2.24), item('0xok', 45_049, 1_044)]);
    assert.equal(r.semDivida, 1);
});

test('lista vazia não inventa linha nem soma', () => {
    const r = resumirAvaliacoes([]);
    assert.equal(r.quantasValem, 0);
    assert.equal(r.quantasAvaliadas, 0);
    assert.equal(r.somaLiquidaUsd.toNumber(), 0);
    assert.deepEqual(r.linhas, []);
});
