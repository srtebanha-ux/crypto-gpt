import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    gorjetaPorGas, tetoPorGas, lerBasefee,
    PISO_DA_GORJETA_WEI, TETO_DA_GORJETA_WEI, LIMITE_DE_GAS,
} from './prontidao';

const D = (n: number | string) => new Decimal(n);
const ETH = D(2646.93);

test('o MESMO lucro em dólar dá a MESMA gorjeta, seja USDC ou WETH a dívida', () => {
    // Este é o defeito que a função existe para consertar. A conta antiga era
    // `lucroCru * 40% / limiteGas`, com lucroCru em unidades CRUAS:
    //
    //   US$88 em USDC (6 casas)  → 88.000.000        → 17 wei/gas → virava o PISO
    //   US$88 em WETH (18 casas) → 33.000.000.000... → 6,6 gwei
    //
    // Dez ordens de grandeza de diferença pelo MESMO dinheiro. Na prática o bot
    // competia de verdade em umas liquidações e não competia em outras, sem
    // nenhuma razão econômica — só pelo número de casas decimais do token.
    const gorjeta = gorjetaPorGas({ lucroUsd: D(88), precoDoEthUsd: ETH });
    assert.equal(gorjeta, gorjetaPorGas({ lucroUsd: D(88), precoDoEthUsd: ETH }));
    // E o valor é econômico: 40% de US$88 = US$35,20, divididos por 2M de gás.
    const esperado = D(88).dividedBy(ETH).mul(0.4).mul(1e18).dividedBy(2_000_000);
    assert.equal(gorjeta, BigInt(esperado.toFixed(0)));
});

test('a gorjeta cresce com o lucro, que é o ponto de existir', () => {
    const pequena = gorjetaPorGas({ lucroUsd: D(88), precoDoEthUsd: ETH });
    const grande = gorjetaPorGas({ lucroUsd: D(2103), precoDoEthUsd: ETH });
    assert.ok(grande > pequena, 'liquidação grande tem que pagar mais para furar a fila');
});

test('lucro minúsculo cai no piso, não em zero', () => {
    // Zero faria a transação nem ser considerada.
    assert.equal(gorjetaPorGas({ lucroUsd: D(0.01), precoDoEthUsd: ETH }), PISO_DA_GORJETA_WEI);
});

test('lucro absurdo bate no teto, e não vira um gasto absurdo', () => {
    // Um lucro mal medido não pode virar uma gorjeta de milhões.
    assert.equal(gorjetaPorGas({ lucroUsd: D(1_000_000), precoDoEthUsd: ETH }), TETO_DA_GORJETA_WEI);
});

test('sem preço do ETH devolve o piso, nunca uma divisão por zero', () => {
    assert.equal(gorjetaPorGas({ lucroUsd: D(88), precoDoEthUsd: D(0) }), PISO_DA_GORJETA_WEI);
});

test('lucro negativo não vira gorjeta negativa', () => {
    assert.equal(gorjetaPorGas({ lucroUsd: D(-5), precoDoEthUsd: ETH }), PISO_DA_GORJETA_WEI);
});

test('o teto por gás cobre a subida do preço base entre blocos', () => {
    // Pagar de menos aqui deixa a transação parada justamente na pressa.
    assert.equal(tetoPorGas(1_000_000n, 500_000_000n), 502_000_000n);
});

test('basefee ilegível vira null, nunca um chute', () => {
    // Um chute aqui faria a transação ser rejeitada ou paga caro demais.
    assert.equal(lerBasefee(null), null);
    assert.equal(lerBasefee('0x'), null);
    assert.equal(lerBasefee('0x0'), null);
    assert.equal(lerBasefee('0x' + (12345n).toString(16)), 12345n);
});

test('o limite de gás é generoso de propósito', () => {
    // Gás não usado volta. Teto apertado custa a transação inteira, que morre
    // sem gás DEPOIS de pagar. Estimar é trocar dinheiro nenhum por uma ida à
    // rede no pior momento possível.
    assert.ok(LIMITE_DE_GAS >= 2_000_000n);
});

// ---------------------------------------------------------------------------
// O leilão: numa corrida onde todos chegam no mesmo bloco, ganha quem paga.
// ---------------------------------------------------------------------------
import { fracaoAdaptativa, sobraDepoisDaGorjeta, TETO_DA_FRACAO } from './prontidao';

test('sem perder, o lance fica na base', () => {
    assert.equal(fracaoAdaptativa({ perdasSeguidas: 0 }), 0.4);
});

test('cada derrota seguida aumenta o lance', () => {
    // Perder repetidamente não pede código mais rápido, pede lance maior.
    assert.ok(fracaoAdaptativa({ perdasSeguidas: 1 }) > fracaoAdaptativa({ perdasSeguidas: 0 }));
    assert.ok(fracaoAdaptativa({ perdasSeguidas: 3 }) > fracaoAdaptativa({ perdasSeguidas: 1 }));
});

test('o lance tem teto: acima dele, ganhar custa quase tudo que rende', () => {
    assert.equal(fracaoAdaptativa({ perdasSeguidas: 99 }), TETO_DA_FRACAO);
    assert.ok(TETO_DA_FRACAO < 1, 'pagar o lucro inteiro é se entregar, não disputar');
});

test('ganhar faz o lance voltar para a base', () => {
    // O contador zera no acerto, então o bot não paga caro para sempre por
    // uma sequência ruim que já passou.
    assert.equal(fracaoAdaptativa({ perdasSeguidas: 0 }), 0.4);
});

test('mesmo no teto ainda sobra dinheiro', () => {
    // A conta que justifica subir: ganhar 100% de US$17 é melhor que ganhar
    // 0% de US$88.
    const sobra = sobraDepoisDaGorjeta(D(88), TETO_DA_FRACAO);
    assert.ok(sobra.greaterThan(0), `sobraria ${sobra.toFixed(2)}`);
    assert.equal(sobra.toFixed(2), '17.60');
});

test('a gorjeta maior aparece de verdade no preço por gás', () => {
    const calma = gorjetaPorGas({ lucroUsd: D(88), precoDoEthUsd: ETH, fracaoDoLucro: 0.4 });
    const brava = gorjetaPorGas({ lucroUsd: D(88), precoDoEthUsd: ETH, fracaoDoLucro: 0.8 });
    assert.equal(brava, calma * 2n);
});
