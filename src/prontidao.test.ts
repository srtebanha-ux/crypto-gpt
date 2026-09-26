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
    // E o valor é econômico: 40% de US$88 = US$35,20, divididos pelo gás que a
    // caçada USA — não pelo teto que se manda. Dividir pelo teto de 2M quando
    // ela usa ~700k faria o lance efetivo virar 14% do lucro enquanto o log
    // dizia 40%: o bot pagaria menos do que decidiu pagar.
    const esperado = D(88).dividedBy(ETH).mul(0.4).mul(1e18).dividedBy(700_000);
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

test('o limite de gás é folgado, mas não a ponto de estrangular o lance', () => {
    // Eu tinha escrito aqui que "gás não usado volta, então teto generoso é de
    // graça". É verdade só para quem tem carteira grande. O nó congela
    // gasLimit × maxFeePerGas ADIANTADO, pelo teto e não pelo consumo — então
    // num saldo pequeno cada unidade de teto a mais é lance a menos.
    //
    // Dois lados, e os dois custam: apertado demais mata a transação sem gás
    // depois de pagar; largo demais prende o dinheiro do lance.
    assert.ok(LIMITE_DE_GAS > 700_000n, 'tem que sobrar folga sobre o que a caçada usa');
    assert.ok(LIMITE_DE_GAS < 2_000_000n, 'mas sem congelar adiantado à toa');
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

// ---------------------------------------------------------------------------
// O freio de sobrevivência: um bot sem gás não perde uma liquidação, perde
// todas as seguintes — e em silêncio.
// ---------------------------------------------------------------------------
import { custoDeUmaDerrota, gorjetaQueCabeNoSaldo, derrotasQueAguenta, GAS_DE_UMA_REVERSAO } from './prontidao';

const wei = (eth: number) => BigInt(new Decimal(eth).mul(1e18).toFixed(0));

test('derrota também custa: a gorjeta é paga mesmo perdendo', () => {
    // Isto quase passou batido. Prioridade se paga pelo gás consumido, dê a
    // transação certo ou não.
    const custo = custoDeUmaDerrota(13_300_000_000n, 1_000_000n);
    assert.ok(custo > 0n);
    // 13,3 gwei × 150k de gás ≈ 0,002 ETH ≈ US$5,28 a US$2646.
    assert.equal(custo / GAS_DE_UMA_REVERSAO, 13_301_000_000n);
});

test('o lance é limitado pelo que a carteira aguenta, não só pelo lucro', () => {
    // US$14,19 em ETH a US$2646,93.
    const saldo = wei(14.19 / 2646.93);
    const desejada = 45_340_000_000n; // 80% de um lucro de US$300
    const cabe = gorjetaQueCabeNoSaldo({ gorjetaDesejadaWei: desejada, saldoWei: saldo, baseFeeWei: 1_000_000n });
    assert.ok(cabe < desejada, 'tem que cortar: essa gorjeta custava mais que a carteira inteira');
    // E o que sobrou aguenta pelo menos quatro derrotas (25% do saldo cada).
    assert.ok(derrotasQueAguenta(saldo, custoDeUmaDerrota(cabe, 1_000_000n)) >= 4);
});

test('gorjeta modesta passa inteira quando cabe', () => {
    const saldo = wei(1);
    const desejada = 6_650_000_000n;
    assert.equal(gorjetaQueCabeNoSaldo({ gorjetaDesejadaWei: desejada, saldoWei: saldo, baseFeeWei: 1_000_000n }), desejada);
});

test('carteira vazia não oferece gorjeta nenhuma', () => {
    assert.equal(gorjetaQueCabeNoSaldo({ gorjetaDesejadaWei: 10n ** 12n, saldoWei: 0n, baseFeeWei: 0n }), 0n);
});

test('o freio conta derrotas, que é o número que decide', () => {
    const saldo = wei(0.00536); // ~US$14,19
    assert.equal(derrotasQueAguenta(saldo, custoDeUmaDerrota(13_300_000_000n, 1_000_000n)), 2);
    assert.ok(derrotasQueAguenta(saldo, custoDeUmaDerrota(910_000_000n, 1_000_000n)) > 30);
});

// ---------------------------------------------------------------------------
// Risco proporcional ao prêmio: 25% fixo recusava 590 para 1.
// ---------------------------------------------------------------------------
import { fracaoDoSaldoQueValeArriscar, adiantadoExigido, maxFeeQueOSaldoAdianta } from './prontidao';

const SALDO = D(14.19);

test('prêmio pequeno perto do saldo fica na fração base', () => {
    assert.equal(fracaoDoSaldoQueValeArriscar({ lucroUsd: D(12), saldoUsd: SALDO }), 0.25);
});

test('prêmio muito maior que o saldo justifica arriscar mais', () => {
    // Era isto que a regra fixa recusava: uma aposta de 590 para 1 tratada
    // igual a uma de 3 para 1.
    const baleia = fracaoDoSaldoQueValeArriscar({ lucroUsd: D(2103), saldoUsd: SALDO });
    assert.equal(baleia, 0.6);
    assert.ok(baleia > fracaoDoSaldoQueValeArriscar({ lucroUsd: D(12), saldoUsd: SALDO }));
});

test('entre os extremos, sobe sem degrau', () => {
    const p88 = fracaoDoSaldoQueValeArriscar({ lucroUsd: D(88), saldoUsd: SALDO });
    const p300 = fracaoDoSaldoQueValeArriscar({ lucroUsd: D(300), saldoUsd: SALDO });
    assert.ok(p88 > 0.25 && p88 < 0.6, `deu ${p88}`);
    assert.ok(p300 > p88, 'prêmio maior, risco maior');
});

test('nunca arrisca o saldo inteiro, por maior que seja o prêmio', () => {
    // Ficar sem gás não perde uma liquidação: perde todas as seguintes.
    const f = fracaoDoSaldoQueValeArriscar({ lucroUsd: D(1_000_000), saldoUsd: SALDO });
    assert.ok(f <= 0.6, `deu ${f}`);
    assert.ok(f < 1);
});

test('sem saldo não arrisca nada', () => {
    assert.equal(fracaoDoSaldoQueValeArriscar({ lucroUsd: D(2103), saldoUsd: D(0) }), 0);
});

test('sem cotação do ETH, o risco cai no BÁSICO e não em zero', () => {
    // O defeito que este teste guarda: risco zero fazia gorjetaQueCabeNoSaldo
    // devolver 0, que caía em "SEM GÁS PARA ATIRAR" — o bot recusava o tiro
    // culpando o gás, tendo gás. Diagnóstico errado com cara de certeza.
    const comRiscoZero = gorjetaQueCabeNoSaldo({
        gorjetaDesejadaWei: 6_650_000_000n,
        saldoWei: wei(1),
        baseFeeWei: 1_000_000n,
        fracaoMaximaDoSaldo: 0,
    });
    assert.equal(comRiscoZero, 0n, 'risco zero realmente zera o lance — por isso não pode ser o padrão');

    const comRiscoBasico = gorjetaQueCabeNoSaldo({
        gorjetaDesejadaWei: 6_650_000_000n,
        saldoWei: wei(1),
        baseFeeWei: 1_000_000n,
        fracaoMaximaDoSaldo: 0.25,
    });
    assert.ok(comRiscoBasico > 0n, 'com o risco básico o tiro sai');
});

test('o nó exige o gás ADIANTADO pelo teto, não pelo que a caçada usa', () => {
    // O defeito mais caro da revisão. Com o teto de 2M e uma gorjeta boa, o
    // adiantado passava de três vezes o saldo inteiro, e toda caçada morria em
    // `insufficient funds` — com o log culpando a rede. O bot pareceria sem
    // alvo, tendo alvo e tendo gás.
    const saldo = wei(14.19 / 2646.93);
    const maxFee = 20_000_000_000n; // 20 gwei
    assert.ok(adiantadoExigido(LIMITE_DE_GAS, maxFee) > saldo, 'é isso que quebrava');

    const cabe = maxFeeQueOSaldoAdianta(saldo, LIMITE_DE_GAS);
    assert.ok(adiantadoExigido(LIMITE_DE_GAS, cabe) <= saldo, 'com o teto certo, cabe');
    assert.ok(cabe > 0n);
});

test('saldo zerado não adianta nada, e zero aqui quer dizer NÃO ATIRE', () => {
    assert.equal(maxFeeQueOSaldoAdianta(0n, LIMITE_DE_GAS), 0n);
});

test('o teto de gás não pode estrangular o lance', () => {
    // Descoberto pelo ensaio da cadeia inteira: com 2M de teto e US$14 de
    // saldo, o maior lance possível caía para 2,41 gwei — dois terços do poder
    // de lance presos garantindo gás que nunca seria usado. Nenhum teste de
    // função pegava, porque cada peça estava certa sozinha.
    const saldo = wei(14.19 / 2646.93);
    const com2M = maxFeeQueOSaldoAdianta(saldo, 2_000_000n);
    const comOAtual = maxFeeQueOSaldoAdianta(saldo, LIMITE_DE_GAS);
    assert.ok(comOAtual > com2M, 'o teto atual tem que permitir lance maior que 2M permitia');
    assert.ok(LIMITE_DE_GAS >= 1_000_000n, 'folga sobre os ~700k que a caçada usa');
    assert.ok(LIMITE_DE_GAS < 2_000_000n, 'mas sem congelar adiantado à toa');
});
