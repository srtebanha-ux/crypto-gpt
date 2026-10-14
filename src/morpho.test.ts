import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    incentivoDeLiquidacao, bonusPct, saudeNoMorpho, quedaAteLiquidarNoMorpho,
    saudeConfere, TETO_DO_INCENTIVO, ESCALA_DO_ORACULO,
} from './morpho';

test('o incentivo confere com as SEIS medianas que o censo mediu', () => {
    // Esta é a verificação da fórmula, e ela não vem da minha memória: vem do
    // censo de 10 dias deste projeto (cobertura 100%, 1.385 janelas, 60
    // liquidações, bônus tirado dos próprios eventos sem preço externo).
    //
    // Quatro de seis dentro de 0,11 ponto. Se alguma sessão futura mexer no
    // CURSOR ou no TETO, estes quatro casos reprovam.
    const batem: [string, string][] = [
        ['0.86', '4.40'], ['0.915', '2.73'], ['0.945', '1.68'], ['0.965', '1.11'],
    ];
    for (const [lltv, medido] of batem) {
        const f = bonusPct(new Decimal(lltv))!;
        assert.ok(
            f.minus(medido).abs().lessThan(0.25),
            `LLTV ${lltv}: fórmula ${f.toFixed(2)}% contra censo ${medido}%`,
        );
    }
});

test('as duas que DIVERGEM corrigem um número que este projeto publicou', () => {
    // O CLAUDE.md registra "bônus de 9–16% nos mercados de LLTV ≤ 77%". O teto
    // do protocolo é 15%: 16,47% não é alcançável por incentivo nenhum, e o
    // excesso é deriva do oráculo — a armadilha que o próprio censo declarou
    // ("o oráculo é lido AGORA e as liquidações são do passado"), que morde
    // justamente nos pares exóticos de LLTV baixo.
    const a625 = bonusPct(new Decimal('0.625'))!;
    assert.ok(a625.lessThan(16.47), 'o censo mediu 16,47% e a fórmula tem de dar MENOS');
    assert.ok(a625.greaterThan(12) && a625.lessThan(13), `${a625.toFixed(2)}%`);

    // E NADA passa do teto, em LLTV nenhum — nem no limite.
    for (const l of ['0.01', '0.1', '0.3', '0.5', '0.625', '0.99']) {
        assert.ok(incentivoDeLiquidacao(new Decimal(l))!.lessThanOrEqualTo(TETO_DO_INCENTIVO));
    }
    assert.ok(bonusPct(new Decimal('0.01'))!.lessThanOrEqualTo(15));

    // E a conclusão da estratégia, com o número CERTO: ainda vale a obra.
    // 4,56% foi o bônus medido no alvo real da Aave de 2026-10-07.
    assert.ok(a625.dividedBy(4.56).greaterThan(2.5), 'ainda é 2,5x+ a Aave');
});

test('LLTV fora da faixa não devolve número inventado', () => {
    for (const ruim of ['0', '1', '1.5', '-0.5']) {
        assert.equal(incentivoDeLiquidacao(new Decimal(ruim)), null, `lltv ${ruim}`);
        assert.equal(bonusPct(new Decimal(ruim)), null);
    }
    assert.equal(incentivoDeLiquidacao(new Decimal(NaN)), null);
});

test('a saúde do Morpho é POR MERCADO, e dívida zero não é saúde infinita', () => {
    // Uma posição folgada: 1 unidade de garantia a preço 1:1, LLTV 77%,
    // devendo metade do que poderia.
    const preco = ESCALA_DO_ORACULO; // 1:1 na escala do oráculo
    const folgada = saudeNoMorpho({
        garantiaCrua: new Decimal(1000),
        dividaCrua: new Decimal(385),
        precoDoOraculo: preco,
        lltv: new Decimal('0.77'),
    })!;
    // maxDivida = 1000 × 0,77 = 770; saúde = 770/385 = 2
    assert.equal(folgada.toFixed(4), '2.0000');

    // Exatamente no limite: saúde 1.
    const noFio = saudeNoMorpho({
        garantiaCrua: new Decimal(1000),
        dividaCrua: new Decimal(770),
        precoDoOraculo: preco,
        lltv: new Decimal('0.77'),
    })!;
    assert.equal(noFio.toFixed(6), '1.000000');
    assert.equal(quedaAteLiquidarNoMorpho({
        garantiaCrua: new Decimal(1000), dividaCrua: new Decimal(770),
        precoDoOraculo: preco, lltv: new Decimal('0.77'),
    })!.toNumber(), 0, 'no fio já é liquidável, a queda pedida é ZERO');

    // DÍVIDA ZERO É `null`, não infinito e não 1. As duas mentiriam em
    // direções opostas: infinito esconde, 1 inventa alvo.
    assert.equal(saudeNoMorpho({
        garantiaCrua: new Decimal(1000), dividaCrua: new Decimal(0),
        precoDoOraculo: preco, lltv: new Decimal('0.77'),
    }), null);
    assert.equal(quedaAteLiquidarNoMorpho({
        garantiaCrua: new Decimal(1000), dividaCrua: new Decimal(0),
        precoDoOraculo: preco, lltv: new Decimal('0.77'),
    }), null);
});

test('a queda pedida é a mesma regra da Aave: 1 − 1/saúde', () => {
    const preco = ESCALA_DO_ORACULO;
    // saúde 2 -> a garantia pode cair 50%
    const q = quedaAteLiquidarNoMorpho({
        garantiaCrua: new Decimal(1000), dividaCrua: new Decimal(385),
        precoDoOraculo: preco, lltv: new Decimal('0.77'),
    })!;
    assert.equal(q.toFixed(4), '50.0000');
});

test('o portão `saudeConfere` grita nas DUAS direções, e não adivinha', () => {
    const liquidavel = new Decimal('0.98');
    const sadia = new Decimal('1.20');

    // Concordância, nos dois sentidos.
    assert.equal(saudeConfere(liquidavel, true).confere, true);
    assert.equal(saudeConfere(sadia, false).confere, true);

    // EU digo liquidável e o protocolo recusa: minha escala está errada, e
    // atirar aqui é pagar gás por nada. É o caso que protege a
    // ESCALA_DO_ORACULO, que ainda não foi verificada contra a rede.
    const euErrei = saudeConfere(liquidavel, false);
    assert.equal(euErrei.confere, false);
    assert.match(euErrei.porque, /escala ou meu LLTV estão errados/);

    // EU digo sadia e o protocolo aceita: estou deixando alvo passar.
    const deixeiPassar = saudeConfere(sadia, true);
    assert.equal(deixeiPassar.confere, false);
    assert.match(deixeiPassar.porque, /deixando alvo passar/);

    // Sem conta minha, o veredicto não vira "confere" de graça quando o
    // protocolo viu alvo: isso é cegueira minha e tem de aparecer.
    assert.equal(saudeConfere(null, true).confere, false);
    assert.equal(saudeConfere(null, false).confere, true);
});
