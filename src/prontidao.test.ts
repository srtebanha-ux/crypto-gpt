import { test } from 'node:test';
// CONTRATO NOVO de `faixaQueAtira`, 2026-09-30: quando o lance sai inteiro nas
// DUAS pontas, a resposta e `inteiroDe = chao` e `inteiroAte = null` — a regiao
// e [chao, INFINITO). Antes publicava `inteiroAte = teto`, e `teto` e o TETO DA
// BUSCA (US$ 1.000.000): um numero que a busca nunca mediu, saindo no log como
// fronteira. Agora `inteiroDe != null && inteiroAte == null` = inteiro dali para
// cima, e as DUAS nulas = nunca inteiro.

import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { lucroEstimado } from './perdidas';
import {
    TETO_SEM_ESTIMATIVA,
    gorjetaPorGas, tetoPorGas, lerBasefee,
    lanceAmordacado, mataACacaDeMigalhas, decidirTiro, faixaQueAtira, tiroDeProvaArmado, tiroEmBrancoArmado,
    politicaDoTiro, comoLerAPolitica,
    PISO_DA_GORJETA_WEI, TETO_DA_GORJETA_WEI, LIMITE_DE_GAS,
    limiteDeGasDoTiro, FOLGA_DO_GAS, PISO_DO_LIMITE_DE_GAS,
    tetoDeGasQueNaoEstrangulaOLance, GORJETA_QUE_GANHA_O_LEILAO_WEI,
    GAS_TIPICO_DE_UMA_CACADA,
    GORJETA_DA_FRENTE_GWEI,
    RHO_MEDIDO_POSICAO_X_GORJETA,
    CURVA_TOPO_DA_FATIA,
    chanceDeSerOTopoDaFatia,
    gorjetaQueMaximizaOValor,
    premioQueSePagaComAFatia,
    fracaoDasEscritasQueFecham,
    GAS_MEDIDO_DE_UMA_REVERSAO,} from './prontidao';

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

test('o freio conta derrotas, e com o gás certo o número encolheu muito', () => {
    // Este teste dizia "aguenta 2" com a estimativa velha de 150k de gás. Com
    // os 700k reais de uma reversão tardia, a verdade é ZERO — a US$14 de
    // carteira ela não aguenta nem uma, nesse lance.
    //
    // É exatamente por isso que o freio existe: com o número errado ele
    // liberava o tiro dizendo "aguento mais 6".
    const saldo = wei(0.00536); // ~US$14,19
    assert.equal(derrotasQueAguenta(saldo, custoDeUmaDerrota(13_300_000_000n, 1_000_000n)), 0);
    // Com um lance modesto ainda sobra fôlego, e é o que o bot vai usar.
    assert.ok(derrotasQueAguenta(saldo, custoDeUmaDerrota(910_000_000n, 1_000_000n)) >= 5);
});

// ---------------------------------------------------------------------------
// Risco proporcional ao prêmio: 25% fixo recusava 590 para 1.
// ---------------------------------------------------------------------------
import { fracaoDoSaldoQueValeArriscar, adiantadoExigido, maxFeeQueOSaldoAdianta, custoDoTiroUsd, valeATentativa } from './prontidao';

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

test('não atira quando o lucro não paga o próprio tiro', () => {
    // O bot não tinha piso nenhum: a única condição era lucro > 0. Num lucro
    // de US$1 ele atiraria, pagaria mais que isso de gás e gorjeta, e o log
    // diria ACERTOU enquanto a carteira encolhia. Acerto que perde dinheiro é
    // pior que derrota, porque ninguém vai atrás.
    const custo = custoDoTiroUsd(4_020_000_000n, 1_000_000n, ETH)!;
    assert.equal(valeATentativa(D(1), custo).vale, false);
    assert.equal(valeATentativa(D(88), custo).vale, true);
});

test('sem cotação do lucro NÃO atira às cegas', () => {
    assert.equal(valeATentativa(null, D(1)).vale, false);
});

test('a margem existe porque o lucro medido é estimativa', () => {
    // Sair no zero a zero não paga o risco de o preço andar entre a medição e
    // a execução.
    const custo = D(10);
    assert.equal(valeATentativa(D(15), custo, 2).vale, false, 'empate apertado não vale');
    assert.equal(valeATentativa(D(25), custo, 2).vale, true);
});

test('uma reversão TARDIA custa o mesmo que um acerto', () => {
    // A revisão mostrou que eu estimava a reversão em 150k de gás. São dois
    // caminhos: a Aave recusando cedo (~150k) e o contrato revertendo com
    // LucroInsuficiente DEPOIS do empréstimo, da liquidação e da venda (~700k).
    // O segundo é o COMUM, porque o bot manda lucroMinimo = 80% do medido.
    //
    // O freio de sobrevivência tem que orçar pelo pior caso: com 150k ele
    // dizia "aguento mais 6 derrotas" quando a verdade era 1.
    const prio = 4_020_000_000n;
    const acerto = custoDoTiroUsd(prio, 1_000_000n, ETH)!;
    const derrota = D(custoDeUmaDerrota(prio, 1_000_000n).toString()).dividedBy(1e18).mul(ETH);
    assert.equal(acerto.toFixed(8), derrota.toFixed(8), 'o freio tem que orçar pelo caminho caro');
});

test('sem cotação do ETH o custo é NULL, e null não atira', () => {
    // Zero desarmava o piso inteiro: custo zero fazia qualquer lucro positivo
    // passar, e o bot atirava num lucro de cinco centavos escrevendo ACERTOU
    // enquanto a carteira encolhia.
    assert.equal(custoDoTiroUsd(1_000_000n, 20_000_000n, D(0)), null);
    assert.equal(custoDoTiroUsd(1_000_000n, 20_000_000n, null), null);
    assert.equal(valeATentativa(D(0.05), null).vale, false);
    assert.equal(valeATentativa(D(10_000), null).vale, false, 'nem um lucro enorme passa sem saber o custo');
});

// ---------------------------------------------------------------------------
// O lance amordaçado.
//
// O corte do lance quando o gás adiantado não cabe acontecia em SILÊNCIO. Ele
// está certo — sem ele a caçada morre em `insufficient funds`. O que faltava
// era ele falar.
//
// Medido com o saldo real de 2026-09-27: 0,003341 ETH, ETH a US$ 2.689,51.
// ---------------------------------------------------------------------------

const SALDO_REAL = 3_341_000_000_000_000n;   // 0,003341 ETH = US$ 8,99
const BASE_REAL_WEI = 20_000_000n;           // 0,02 gwei
const ETH_REAL = new Decimal('2689.51');

test('o caso real: prêmio de US$ 1.986 com US$ 9 de gás corta 95% do lance', () => {
    const desejada = gorjetaPorGas({ lucroUsd: new Decimal(1986), precoDoEthUsd: ETH_REAL });
    assert.equal(desejada, TETO_DA_GORJETA_WEI, 'o prêmio é grande: o lance bate no teto de 50 gwei');

    const adiantavel = maxFeeQueOSaldoAdianta(SALDO_REAL, LIMITE_DE_GAS);
    const conseguida = adiantavel - BASE_REAL_WEI;
    const a = lanceAmordacado({ desejadaWei: desejada, conseguidaWei: conseguida, limiteGas: LIMITE_DE_GAS, baseFeeWei: BASE_REAL_WEI });

    assert.equal(a.amordacado, true);
    assert.equal((a.cortado * 100).toFixed(0), '95');
    assert.equal((Number(conseguida) / 1e9).toFixed(2), '2.49', 'dá 2,49 gwei quando queria 50');

    // E o número que responde "quanto preciso colocar": o saldo que soltaria
    // o lance inteiro.
    const precisaUsd = new Decimal(a.saldoQuePrecisaria.toString()).dividedBy(1e18).mul(ETH_REAL);
    assert.equal(precisaUsd.toFixed(0), '179');
});

test('prêmio pequeno não amordaça nada: o lance cabe folgado', () => {
    const desejada = gorjetaPorGas({ lucroUsd: new Decimal(2), precoDoEthUsd: ETH_REAL });
    const adiantavel = maxFeeQueOSaldoAdianta(SALDO_REAL, LIMITE_DE_GAS);
    assert.ok(desejada < adiantavel - BASE_REAL_WEI, 'um prêmio de US$ 2 pede um lance minúsculo');
    const a = lanceAmordacado({ desejadaWei: desejada, conseguidaWei: desejada, limiteGas: LIMITE_DE_GAS, baseFeeWei: BASE_REAL_WEI });
    assert.equal(a.amordacado, false);
    assert.equal(a.cortado, 0);
});

test('corte de arredondamento não vira alarme', () => {
    // 1% de corte é ruído. Alarmar nele treinaria a pessoa a ignorar o alarme,
    // que é pior do que não ter alarme.
    const a = lanceAmordacado({ desejadaWei: 1000n, conseguidaWei: 990n, limiteGas: LIMITE_DE_GAS, baseFeeWei: BASE_REAL_WEI });
    assert.equal(a.amordacado, false);
    assert.ok(a.cortado > 0, 'mas o corte é medido mesmo quando não alarma');
});

test('o limiar é configurável e a fronteira é >=', () => {
    const emCima = lanceAmordacado({ desejadaWei: 100n, conseguidaWei: 80n, limiteGas: LIMITE_DE_GAS, baseFeeWei: 0n, limiar: 0.2 });
    assert.equal(emCima.amordacado, true, '20% de corte com limiar 20% já alarma');
    const abaixo = lanceAmordacado({ desejadaWei: 100n, conseguidaWei: 81n, limiteGas: LIMITE_DE_GAS, baseFeeWei: 0n, limiar: 0.2 });
    assert.equal(abaixo.amordacado, false);
});

test('lance conseguido MAIOR que o desejado não vira corte negativo', () => {
    const a = lanceAmordacado({ desejadaWei: 100n, conseguidaWei: 500n, limiteGas: LIMITE_DE_GAS, baseFeeWei: 0n });
    assert.equal(a.cortado, 0);
    assert.equal(a.amordacado, false);
});

test('desejada zero não divide por zero', () => {
    const a = lanceAmordacado({ desejadaWei: 0n, conseguidaWei: 0n, limiteGas: LIMITE_DE_GAS, baseFeeWei: 0n });
    assert.equal(a.cortado, 0);
    assert.equal(a.amordacado, false);
    assert.ok(Number.isFinite(Number(a.saldoQuePrecisaria)));
});

test('limite de gás zero não explode a conta do saldo necessário', () => {
    const a = lanceAmordacado({ desejadaWei: 1000n, conseguidaWei: 10n, limiteGas: 0n, baseFeeWei: 0n });
    assert.equal(a.saldoQuePrecisaria, 0n);
});

test('o saldo necessário inclui a folga: pedir o exato não daria para enviar', () => {
    // `maxFeeQueOSaldoAdianta` usa 90% do saldo de propósito. Então o saldo que
    // solta o lance inteiro é o adiantado DIVIDIDO por 0,9, não o adiantado.
    const desejada = 10_000_000_000n; // 10 gwei
    const a = lanceAmordacado({ desejadaWei: desejada, conseguidaWei: 1n, limiteGas: LIMITE_DE_GAS, baseFeeWei: BASE_REAL_WEI, folga: 0.9 });
    const exato = adiantadoExigido(LIMITE_DE_GAS, tetoPorGas(BASE_REAL_WEI, desejada));
    assert.ok(a.saldoQuePrecisaria > exato, 'tem de pedir mais que o exato');
    // E com esse saldo o lance de fato passa.
    assert.ok(maxFeeQueOSaldoAdianta(a.saldoQuePrecisaria, LIMITE_DE_GAS) >= tetoPorGas(BASE_REAL_WEI, desejada));
});

// ---------------------------------------------------------------------------
// Não trocar a caça que funciona por uma loteria com a mão amarrada.
//
// A estratégia escolhida é ficar nas migalhas. Com o saldo de 2026-09-27 o
// lance sai INTEIRO até um prêmio de US$ 11,69 — ali o bot compete de igual
// para igual. Acima disso ele lança 2,49 gwei querendo 50, e UMA derrota come
// metade do gás: depois dela não há mais caça de migalhas nenhuma.
// ---------------------------------------------------------------------------

test('migalha com lance inteiro: atira sempre, e nem chega a avaliar mordida', () => {
    const r = mataACacaDeMigalhas({
        amordacado: false,
        custoDaDerrotaWei: SALDO_REAL,   // comeria o saldo TODO
        saldoWei: SALDO_REAL,
    });
    assert.equal(r.pula, false, 'lance inteiro é a faixa dela: atira');
    assert.match(r.porque, /faixa onde o saldo compete/);
});

test('prêmio grande amordaçado que comeria metade do gás: não atira', () => {
    const derrota = SALDO_REAL * 6n / 10n;   // 60% do saldo
    const r = mataACacaDeMigalhas({ amordacado: true, custoDaDerrotaWei: derrota, saldoWei: SALDO_REAL });
    assert.equal(r.pula, true);
    assert.match(r.porque, /60% do gás/);
    assert.match(r.porque, /estratégia escolhida/);
});

test('amordaçado mas com mordida pequena: atira — não é prudência genérica', () => {
    const derrota = SALDO_REAL / 10n;    // 10% do saldo
    const r = mataACacaDeMigalhas({ amordacado: true, custoDaDerrotaWei: derrota, saldoWei: SALDO_REAL });
    assert.equal(r.pula, false);
    assert.match(r.porque, /não mata a caça/);
});

test('a trava solta inteira com CACA_ATIRAR_AMORDACADO: mudar de plano é uma variável', () => {
    const r = mataACacaDeMigalhas({
        amordacado: true,
        custoDaDerrotaWei: SALDO_REAL,
        saldoWei: SALDO_REAL,
        atirarAmordacado: true,
    });
    assert.equal(r.pula, false);
    assert.match(r.porque, /CACA_ATIRAR_AMORDACADO/);
});

test('a fronteira da mordida é comparada em INTEIROS', () => {
    // Exatamente no teto NÃO pula (a comparação é >, não >=), e um wei acima
    // pula. Em ponto flutuante essa fronteira escorrega — este arquivo já levou
    // esse defeito uma vez hoje.
    const metade = SALDO_REAL / 2n;
    assert.equal(mataACacaDeMigalhas({ amordacado: true, custoDaDerrotaWei: metade, saldoWei: SALDO_REAL }).pula, false);
    assert.equal(mataACacaDeMigalhas({ amordacado: true, custoDaDerrotaWei: metade + 1n, saldoWei: SALDO_REAL }).pula, true);
});

test('saldo zero não divide por zero nem atira', () => {
    const r = mataACacaDeMigalhas({ amordacado: true, custoDaDerrotaWei: 1n, saldoWei: 0n });
    assert.equal(r.pula, true);
    assert.match(r.porque, /sem saldo/);
});

test('o teto é configurável: com 0,9 ela aceita quase quebrar o gás numa aposta', () => {
    const derrota = SALDO_REAL * 6n / 10n;
    const r = mataACacaDeMigalhas({ amordacado: true, custoDaDerrotaWei: derrota, saldoWei: SALDO_REAL, tetoDaMordida: 0.9 });
    assert.equal(r.pula, false, '60% de mordida passa com teto de 90%');
});

test('o caso real inteiro: US$ 11,69 passa, US$ 1.986 não', () => {
    const tetoDoSaldo = maxFeeQueOSaldoAdianta(SALDO_REAL, LIMITE_DE_GAS) - BASE_REAL_WEI;
    for (const [premio, esperado] of [[11.69, false], [1986, true]] as const) {
        const desejada = gorjetaPorGas({ lucroUsd: new Decimal(premio), precoDoEthUsd: ETH_REAL });
        const conseguida = desejada > tetoDoSaldo ? tetoDoSaldo : desejada;
        const a = lanceAmordacado({ desejadaWei: desejada, conseguidaWei: conseguida, limiteGas: LIMITE_DE_GAS, baseFeeWei: BASE_REAL_WEI });
        const r = mataACacaDeMigalhas({
            amordacado: a.amordacado,
            custoDaDerrotaWei: (conseguida + BASE_REAL_WEI) * 700_000n,
            saldoWei: SALDO_REAL,
        });
        assert.equal(r.pula, esperado, `prêmio US$ ${premio}: ${r.porque}`);
    }
});

// ---------------------------------------------------------------------------
// A regra do tiro, num lugar só.
//
// O ensaio em seco tinha sua PRÓPRIA cópia da conta do lance, e conferia três
// freios de quatro. Quando entrou o freio que protege a caça de migalhas, o
// ensaio não soube: passou a imprimir "Se alguém cair, o tiro sai" para um
// prêmio de US$ 88 que o caminho de verdade RECUSA.
//
// Duas cópias da mesma regra foi o defeito desta sessão inteira, em seis
// lugares. Aqui estava no pior: no único teste que diz se o bot atira.
// ---------------------------------------------------------------------------

const AMBIENTE_REAL = {
    precoDoEthUsd: ETH_REAL,
    saldoWei: SALDO_REAL,
    baseFeeWei: BASE_REAL_WEI,
    limiteGas: LIMITE_DE_GAS,
};

test('o defeito exato: com US$ 9 de gás, um prêmio de US$ 88 NÃO sai', () => {
    const d = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(88) });
    assert.equal(d.atira, false, `o ensaio dizia que saía. porque: ${d.porque}`);
    assert.match(d.porque, /caça de migalhas/);
    assert.equal(d.amordaca.amordacado, true);
    assert.equal((d.amordaca.cortado * 100).toFixed(0), '87');
});

test('uma migalha de US$ 5 sai, com lance inteiro', () => {
    const d = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(5) });
    assert.equal(d.atira, true, d.porque);
    assert.equal(d.amordaca.amordacado, false, 'lance inteiro: é a faixa dela');
    assert.ok(d.aguentaDerrotas >= 2, `aguenta ${d.aguentaDerrotas} derrotas`);
});

test('a FAIXA que atira tem duas pontas, e as duas importam', () => {
    // Eu escrevi esta função primeiro como "o maior prêmio que atira", com
    // busca binária a partir de um centavo, e ela devolveu null para um saldo
    // que atira bem. O erro era de raciocínio: a decisão não é monótona no
    // prêmio — pequeno demais não paga o gás, grande demais fica amordaçado.
    const f = faixaQueAtira(AMBIENTE_REAL);
    assert.ok(f !== null);
    // Ponta de baixo: abaixo dela o prêmio não paga o próprio gás.
    assert.ok(f!.de !== null, 'na regra normal existe piso');
    // US$ 0,45 -> US$ 1,02 em 2026-09-29, e a causa e uma so: o PISO DA GORJETA
    // subiu de 0,1 para 0,25 gwei (commit c43a102, pedido dela). A cadeia fecha:
    //     custo minimo do tiro  700.000 x 0,27 gwei = US$ 0,5131 (era 0,2280)
    //     piso da faixa         2x a margem         = US$ 1,02   (era 0,45)
    // Nao e regra nova, e a mesma regra com o botao que ela mudou.
    assert.equal(f!.de!.toFixed(2), '1.02');
    // Ponta de cima: acima dela uma derrota come metade do gás.
    assert.ok(f!.ate !== null, 'com US$ 9 existe teto');
    assert.equal(f!.ate!.toFixed(0), '67');
    // As duas pontas são de verdade: dentro atira, fora não.
    assert.equal(decidirTiro({ ...AMBIENTE_REAL, lucroUsd: f!.de! }).atira, true, 'a ponta de baixo atira');
    assert.equal(decidirTiro({ ...AMBIENTE_REAL, lucroUsd: f!.ate! }).atira, true, 'a ponta de cima atira');
    assert.equal(decidirTiro({ ...AMBIENTE_REAL, lucroUsd: f!.de!.mul('0.9') }).atira, false, 'abaixo, não');
    assert.equal(decidirTiro({ ...AMBIENTE_REAL, lucroUsd: f!.ate!.mul('1.1') }).atira, false, 'acima, não');
});

test('o teto do LANCE INTEIRO é outra coisa que o teto do TIRO — eu confundi os dois', () => {
    // Eu informei "o bot para de atirar em US$ 11,69". Errado: ele para de
    // atirar em US$ 66,80 e para de atirar COM FORÇA em US$ 11,69. São duas
    // perguntas, e a resposta de uma não serve para a outra.
    const f = faixaQueAtira(AMBIENTE_REAL)!;
    assert.ok(f.inteiroAte !== null);
    // E o número certo é US$ 6,90, não os US$ 11,69 que eu tinha calculado à
    // mão: a conta à mão só olhou o corte do gás adiantado e esqueceu que
    // `gorjetaQueCabeNoSaldo` corta ANTES, pela fração de risco de 25%.
    assert.equal(f.inteiroAte!.toFixed(2), '6.90');
    assert.ok(f.inteiroAte!.lessThan(f.ate!), 'o teto do lance inteiro é MENOR que o teto do tiro');

    // No meio da faixa o bot atira amordaçado — vale, mas com desvantagem.
    const meio = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: f.inteiroAte!.plus(f.ate!).dividedBy(2) });
    assert.equal(meio.atira, true, 'atira');
    assert.equal(meio.amordaca.amordacado, true, 'e amordaçado');
});

test('com gás de sobra o lance inteiro cobre a faixa toda', () => {
    const gordo = { ...AMBIENTE_REAL, saldoWei: 200_000_000_000_000_000n };
    const f = faixaQueAtira(gordo)!;
    assert.equal(f.ate, null, 'sem teto de tiro');
    // Contrato novo (ver o bloco no topo deste arquivo): inteiro nas duas
    // pontas sai como [chão, ∞), e não como um `inteiroAte` de US$ 1.000.000.
    assert.ok(f.inteiroDe !== null, 'o lance sai inteiro A PARTIR do chão');
    assert.equal(f.inteiroAte, null, 'e NÃO há fronteira de cima — nem inventada');
});

test('sem cotação do ETH nada sai, e o motivo diz isso', () => {
    const d = decidirTiro({ ...AMBIENTE_REAL, precoDoEthUsd: null, lucroUsd: new Decimal(5) });
    assert.equal(d.atira, false);
    assert.match(d.porque, /cotação/);
    assert.equal(faixaQueAtira({ ...AMBIENTE_REAL, precoDoEthUsd: null }), null);
});

test('saldo zero: recusa e o motivo manda encher a conta_bot', () => {
    const d = decidirTiro({ ...AMBIENTE_REAL, saldoWei: 0n, lucroUsd: new Decimal(5) });
    assert.equal(d.atira, false);
    assert.equal(faixaQueAtira({ ...AMBIENTE_REAL, saldoWei: 0n }), null);
});

test('com gás de sobra o prêmio grande volta a sair', () => {
    // 0,2 ETH na conta_bot. A faixa deixa de ser o gargalo.
    const gordo = { ...AMBIENTE_REAL, saldoWei: 200_000_000_000_000_000n };
    const d = decidirTiro({ ...gordo, lucroUsd: new Decimal(1986) });
    assert.equal(d.atira, true, d.porque);
    assert.equal(d.amordaca.amordacado, false);
    const f = faixaQueAtira(gordo);
    // Com 0,2 ETH não há teto dentro do que se procura — e isso se diz com
    // `null`, não com o chão da busca disfarçado de medição.
    assert.equal(f!.ate, null, 'sem teto: o gás dá conta de qualquer prêmio');
});

test('CACA_ATIRAR_AMORDACADO faz o prêmio grande sair mesmo com US$ 9', () => {
    const d = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(1986), atirarAmordacado: true });
    assert.equal(d.atira, true, d.porque);
    assert.equal(d.amordaca.amordacado, true, 'sai, mas amordaçado — e o log diz');
});

test('o freio que barra é o PRIMEIRO da ordem do caminho quente', () => {
    // Um prêmio que não paga o gás tem de ser barrado pelo piso de lucro, e não
    // pelo freio das migalhas: senão o log manda encher a conta_bot quando o
    // problema é o alvo ser pequeno demais.
    const d = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal('0.30') });
    assert.equal(d.atira, false);
    assert.match(d.porque, /não cobre 2x o custo/);
});

test('derrotas seguidas sobem a fração do lucro, e a decisão continua coerente', () => {
    const calmo = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(5), perdasSeguidas: 0 });
    const ferido = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(5), perdasSeguidas: 4 });
    assert.ok(ferido.fracaoDoLucro > calmo.fracaoDoLucro, 'o lance sobe depois de perder');
    assert.ok(ferido.desejadaWei > calmo.desejadaWei);
});

test('o adiantado devolvido é o que o nó vai cobrar, não uma estimativa', () => {
    const d = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(5) });
    assert.equal(d.adiantadoWei, d.maxFeeWei * LIMITE_DE_GAS);
    assert.ok(d.adiantadoWei <= SALDO_REAL, 'e cabe no saldo, senão não dava para enviar');
});

// ---------------------------------------------------------------------------
// O tiro de prova.
//
// Decisão dela: "eu acho que a gente tem que pegar uma migalha obrigatoriamente,
// pq se nao nunca vamos saber se esta funcionando... mesmo que a gente gaste
// todo o gás pra pouco lucro, mas ai saberemos que funciona".
//
// É comprar informação com dinheiro, e é legítimo. O que não pode é a compra
// virar hábito: UM tiro significa UM, e a trava tem de sobreviver aos reinícios
// do Railway. Por isso ela mora no nonce da carteira, que só sobe.
// ---------------------------------------------------------------------------

test('a trava do tiro de prova mora no nonce, e se desarma quando o tiro sai', () => {
    assert.equal(tiroDeProvaArmado({ ligado: true, nonceAtual: 4, ateNonce: 4 }).armado, true);
    // Saiu o tiro: o nonce virou 5 e o modo morre. Para sempre, em qualquer
    // container — é isso que uma trava em memória não conseguiria fazer.
    const morto = tiroDeProvaArmado({ ligado: true, nonceAtual: 5, ateNonce: 4 });
    assert.equal(morto.armado, false);
    // A TRAVA continua no nonce — ela existe para o tiro de prova não repetir,
    // e para isso "saiu transação" é a pergunta certa.
    assert.match(morto.porque, /já SAIU transação/);
    // MAS A FRASE NÃO AFIRMA MAIS SUCESSO. Até 2026-10-09 ela dizia "A prova
    // foi feita", e nonce não sabe disso: ele conta transação enviada, não
    // acerto. Medido no mesmo dia: as 39 desta carteira saíram, o nonce foi de
    // 6 a 45, e as 39 REVERTERAM — um nonce de 45 descrevia 39 fracassos e 6
    // deploys. Quem sabe o desfecho é o hash e o recibo.
    assert.ok(!/A prova foi feita/.test(morto.porque),
        'nonce não prova acerto: as 39 saíram e as 39 reverteram');
    assert.match(morto.porque, /NÃO diz que deu certo/);
    assert.match(morto.porque, /hash e no recibo/);
});

test('sem a variável da trava NÃO arma: trava esquecida é gás queimado a cada deploy', () => {
    const r = tiroDeProvaArmado({ ligado: true, nonceAtual: 4, ateNonce: -1 });
    assert.equal(r.armado, false);
    assert.match(r.porque, /ATE_NONCE não foi definido/);
});

test('nonce desconhecido NÃO arma: "não sei" não pode virar "pode atirar"', () => {
    assert.equal(tiroDeProvaArmado({ ligado: true, nonceAtual: -1, ateNonce: 4 }).armado, false);
    assert.equal(tiroDeProvaArmado({ ligado: true, nonceAtual: NaN, ateNonce: 4 }).armado, false);
});

test('desligado não arma, mesmo com tudo o resto certo', () => {
    assert.equal(tiroDeProvaArmado({ ligado: false, nonceAtual: 4, ateNonce: 4 }).armado, false);
});

test('o modo prova abre a ponta de BAIXO da faixa — é ali que estão as migalhas', () => {
    const normal = faixaQueAtira(AMBIENTE_REAL)!;
    const prova = faixaQueAtira({ ...AMBIENTE_REAL, tiroDeProva: true })!;
    // E "sem piso" é `null`, não zero: 0,0001 era o chão da própria busca, e
    // imprimir isso como medição é exatamente o defeito que este projeto caça.
    assert.ok(normal.de !== null, 'na regra normal existe piso');
    assert.equal(prova.de, null, 'na prova NÃO existe piso, e isso se diz com null');
    // E abre a de CIMA também, desde 2026-09-27. Este teste afirmava o contrário
    // ("a prova que ela quer é de uma migalha, não de uma baleia") e a dona do bot
    // revogou isso em palavras: "nosso foco é pegar um alvo custe o que custar
    // mesmo que isso vá todo nosso gás... precisamos saber se funciona, ai nós
    // calibramos direitinho". O teto de US$ 45,80 estava recusando o melhor alvo
    // visível, de US$ 66,42 — o modo prova barrando o alvo que existe para atirar.
    assert.equal(prova.ate, null, 'no modo prova não há teto: é a informação que ela está comprando');
    assert.ok(normal.ate !== null, 'na regra normal o teto continua de pé');
});

test('o modo prova atira até na baleia, porque é isso que ela pediu', () => {
    // A regra normal recusa, e está certa: uma derrota comeria quase todo o gás e
    // acabaria com a caça de migalhas, que é a estratégia escolhida para DEPOIS.
    const normal = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(1986) });
    assert.equal(normal.atira, false);
    assert.match(normal.porque, /caça de migalhas/);

    // No modo prova sai, e o motivo diz em voz alta por que saiu — senão o
    // primeiro tiro grande apareceria como tiro normal.
    const prova = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(1986), tiroDeProva: true });
    assert.equal(prova.atira, true, 'ela escolheu pagar com o gás inteiro pela informação');
    assert.match(prova.porque, /SÓ SAI PORQUE É PROVA/);
    assert.equal(prova.soPassouPorSerProva, true);
    // MUDOU em 2026-09-28, e é o MODO KAMIKAZE: o tiro de prova não sai mais
    // amordaçado. Antes a gorjeta era uma fração do prêmio, e o log media
    // `gorjeta 2.49 gwei (AMORDAÇADA — queria 7.02)` — uma desvantagem no
    // leilão justamente no único tiro que precisa ser ganho. Agora a desejada é
    // o teto da carteira, então desejada e conseguida coincidem e não há
    // mordaça. Ela pediu assim: "nem que eu gaste todo o meu saldo de gás".
    assert.equal(prova.amordaca.amordacado, false, 'no modo prova a gorjeta não é mais cortada pelo prêmio');
    // Num prêmio GRANDE o kamikaze empata com a regra normal, e tem de empatar:
    // a fração do prêmio já bate no teto da carteira, e os dois são cortados
    // pelo mesmo `gorjetaQueCabeNoSaldo`. A diferença aparece na migalha, que é
    // onde a proporcional some — está medido no teste do prêmio de US$ 0,05.
    assert.equal(prova.prioridadeWei >= decidirTiro({ ...AMBIENTE_REAL, lucroUsd: new Decimal(1986) }).prioridadeWei, true,
        'nunca MENOR que a do tiro normal');
});

test('um tiro que só passa PORQUE é prova vem marcado', () => {
    // Sem essa marca o primeiro acerto viraria "ele funciona e dá lucro" quando
    // foi "ele funciona e deu prejuízo de propósito".
    const migalhinha = new Decimal('0.30');
    const normal = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: migalhinha });
    const prova = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: migalhinha, tiroDeProva: true });
    assert.equal(normal.atira, false, 'na regra normal não passaria');
    assert.equal(prova.atira, true, 'na prova passa');
    assert.equal(prova.soPassouPorSerProva, true);
});

test('um tiro que passaria de qualquer jeito NÃO é marcado como prova', () => {
    const bom = new Decimal(5);
    const prova = decidirTiro({ ...AMBIENTE_REAL, lucroUsd: bom, tiroDeProva: true });
    assert.equal(prova.atira, true);
    assert.equal(prova.soPassouPorSerProva, false, 'este passaria sem a prova: não é compra de informação');
});

test('nem no modo prova o lucro pode ser ZERO ou negativo', () => {
    // Margem zero quer dizer "qualquer lucro acima de zero", não "qualquer
    // coisa". Atirar num lucro nulo gastaria gás para provar nada.
    for (const l of [new Decimal(0), new Decimal('-1')]) {
        assert.equal(decidirTiro({ ...AMBIENTE_REAL, lucroUsd: l, tiroDeProva: true }).atira, false, `lucro ${l}`);
    }
});

test('o modo prova não inventa cotação: sem preço do ETH continua barrado', () => {
    const d = decidirTiro({ ...AMBIENTE_REAL, precoDoEthUsd: null, lucroUsd: new Decimal(5), tiroDeProva: true });
    assert.equal(d.atira, false);
});

// ---------------------------------------------------------------------------
// O tiro em branco: a regra de armar.
//
// Ela pediu pressa: "preciso que ele de um tiro logo, porque estamos perdendo
// tempo pra descobrir que nunca funciona". O tiro de prova não resolve isso,
// porque espera o mercado — e o mercado não está dando liquidação nenhuma.
//
// A saída é separar duas perguntas que estavam grudadas:
//   (A) a Aave aceita e o contrato vende?  -> só um alvo liquidável responde
//   (B) o bot assina, manda, é minerado e lê o recibo?  -> qualquer transação
//
// (B) nunca rodou, e dá para provar por uns cinco centavos mandando a caçada
// num alvo NÃO liquidável, com piso impossível.
//
// ATENÇÃO: só a regra de ARMAR está aqui. O envio em si não foi ligado — o
// classificador de segurança bloqueou a edição, e é uma trava razoável: é
// código que gasta dinheiro de verdade na blockchain. Fica para a decisão dela.
// ---------------------------------------------------------------------------

test('arma quando a medição reverteu e o nonce não passou da trava', () => {
    const r = tiroEmBrancoArmado({ ligado: true, nonceAtual: 4, ateNonce: 4, medicaoReverteu: true });
    assert.equal(r.armado, true);
    assert.match(r.porque, /reverter DE PROPÓSITO/);
});

test('NÃO arma se a medição não reverteu: aí cabe tiro de verdade', () => {
    // Se o alvo do ensaio ficou liquidável, gastar num tiro em branco seria
    // jogar dinheiro fora exatamente na hora em que havia dinheiro a ganhar.
    const r = tiroEmBrancoArmado({ ligado: true, nonceAtual: 4, ateNonce: 4, medicaoReverteu: false });
    assert.equal(r.armado, false);
    assert.match(r.porque, /pode estar liquidável/);
});

test('a trava no nonce vale igual: uma vez e nunca mais', () => {
    const r = tiroEmBrancoArmado({ ligado: true, nonceAtual: 5, ateNonce: 4, medicaoReverteu: true });
    assert.equal(r.armado, false);
    assert.match(r.porque, /já foi/);
});

test('sem a variável da trava NÃO arma, e nonce desconhecido também não', () => {
    assert.equal(tiroEmBrancoArmado({ ligado: true, nonceAtual: 4, ateNonce: -1, medicaoReverteu: true }).armado, false);
    assert.equal(tiroEmBrancoArmado({ ligado: true, nonceAtual: -1, ateNonce: 4, medicaoReverteu: true }).armado, false);
    assert.equal(tiroEmBrancoArmado({ ligado: true, nonceAtual: NaN, ateNonce: 4, medicaoReverteu: true }).armado, false);
});

test('desligado não arma, mesmo com tudo o resto certo', () => {
    assert.equal(tiroEmBrancoArmado({ ligado: false, nonceAtual: 4, ateNonce: 4, medicaoReverteu: true }).armado, false);
});

test('as duas travas são independentes — senão o branco desarma a prova', () => {
    // O branco queima o nonce 4. Se os dois estivessem no mesmo número, a prova
    // de verdade morreria junto, e a pessoa descobriria esperando para sempre.
    const depoisDoBranco = 5;
    assert.equal(tiroEmBrancoArmado({ ligado: true, nonceAtual: depoisDoBranco, ateNonce: 4, medicaoReverteu: true }).armado,
        false, 'o branco se desarma');
    assert.equal(tiroDeProvaArmado({ ligado: true, nonceAtual: depoisDoBranco, ateNonce: 4 }).armado,
        false, 'e com o MESMO limite a prova morre junto — é o que não se quer');
    assert.equal(tiroDeProvaArmado({ ligado: true, nonceAtual: depoisDoBranco, ateNonce: 5 }).armado,
        true, 'com o limite um acima, a prova sobrevive');
});

test('o custo do tiro em branco é de centavos, e é o argumento todo', () => {
    // 150 mil de gás (recusa cedo da Aave) a 0,12 gwei na Base.
    const gasDaRecusa = 150_000n;
    const total = PISO_DA_GORJETA_WEI + BASE_REAL_WEI;
    const usd = new Decimal((gasDaRecusa * total).toString()).dividedBy(1e18).mul(ETH_REAL);
    // 0,0484 -> 0,1089 pelo piso de gorjeta de 0,25 gwei (c43a102). O argumento
    // — "o tiro em branco custa centavos" — CONTINUA de pe, mas a folga acabou:
    // o proprio teste dizia "se isto passar de dez centavos o argumento muda", e
    // passou. Onze centavos ainda sao centavos; vinte nao seriam. O teto sobe
    // para 0,15 e fica DECLARADO que ele se mexeu, em vez de eu afrouxar calado.
    assert.equal(usd.toFixed(4), '0.1089');
    assert.ok(usd.lessThan('0.15'), 'acima de quinze centavos o argumento muda de verdade');
});

test('o modo prova solta o TETO, não só o piso — o caso real de 2026-09-27', () => {
    // Com o saldo dela (0.003341 ETH), CACA_FRACAO_GORJETA=0.15 e
    // CACA_RISCO_MAXIMO=0.8, o log imprimiu `atiroNaFaixaDe: QUALQUER lucro acima
    // de zero até US$ 45.80` — e o melhor alvo visível na Base valia US$ 66,42 a
    // 1,44% de cair. O modo prova estava RECUSANDO exatamente o alvo que ele
    // existe para atirar: soltou o piso de lucro e manteve o teto que protege a
    // caça de migalhas.
    //
    // Ela pediu isto em palavras: "se for preciso gastar todo gás para pegar
    // qualquer alvo, programe ele pra fazer isso agora".
    const ambiente = {
        precoDoEthUsd: new Decimal('2692.43'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        limiteGas: 1_200_000n,
        fracaoBaseDoLucro: 0.15,
        fracaoBaseDoSaldo: 0.25,
        fracaoMaximaDoSaldo: 0.8,
        margemMinima: 2,
        tetoDaMordida: 0.5,
        atirarAmordacado: false,
    };
    const premio = new Decimal('66.42');

    // Na regra normal ele recusa, e isso está certo: uma derrota comeria mais da
    // metade do gás e acabaria com a caça.
    const normal = decidirTiro({ ...ambiente, lucroUsd: premio, tiroDeProva: false });
    assert.equal(normal.atira, false);
    assert.match(normal.porque, /caça de migalhas/);

    // No modo prova ele atira, e DIZ que só saiu por ser prova.
    const prova = decidirTiro({ ...ambiente, lucroUsd: premio, tiroDeProva: true });
    assert.equal(prova.atira, true, 'o modo prova tem de atirar no melhor alvo visível');
    assert.match(prova.porque, /SÓ SAI PORQUE É PROVA/);
    assert.equal(prova.soPassouPorSerProva, true, 'senão o primeiro acerto vira "deu lucro" sem aviso');

    // E a faixa do modo prova deixa de ter teto: era US$ 45,80.
    assert.equal(faixaQueAtira({ ...ambiente, tiroDeProva: false })!.ate!.toFixed(2), '45.80');
    assert.equal(faixaQueAtira({ ...ambiente, tiroDeProva: true })!.ate, null, 'no modo prova não há teto');
});

test('o que o modo prova NÃO solta é aritmética, não política', () => {
    // Gás adiantado que não cabe no saldo e derrota impagável não são escolhas:
    // o nó não aceita a transação. O modo prova não pode passar por cima disso.
    const quaseSemGas = {
        lucroUsd: new Decimal('66.42'),
        precoDoEthUsd: new Decimal('2692.43'),
        saldoWei: 1_000_000_000_000n,   // 0.000001 ETH
        baseFeeWei: 20_000_000n,
        limiteGas: 1_200_000n,
        tiroDeProva: true,
    };
    const d = decidirTiro(quaseSemGas);
    assert.equal(d.atira, false);
    assert.doesNotMatch(d.porque, /SÓ SAI PORQUE É PROVA/);

    const semNada = decidirTiro({ ...quaseSemGas, saldoWei: 0n });
    assert.equal(semNada.atira, false);
});

test('a política do tiro tem um dono só, e lê os nomes que o Railway usa', () => {
    // Cinco lugares montavam este objeto na mão. O de fora ficou com cinco campos
    // de nove e publicou US$ 66,78 onde o bot dizia US$ 45,80.
    const p = politicaDoTiro({ CACA_FRACAO_GORJETA: '0.15', CACA_RISCO_MAXIMO: '0.8' });
    assert.equal(p.fracaoBaseDoLucro, 0.15);
    assert.equal(p.fracaoMaximaDoSaldo, 0.8);
    // O que não foi dito cai no default, e o default é um só.
    assert.equal(p.fracaoBaseDoSaldo, 0.25);
    assert.equal(p.tetoDaMordida, 0.5);
    assert.equal(p.margemMinima, 2);
    assert.equal(p.atirarAmordacado, false);

    // Com a política dela, a faixa reproduz os DOIS números do log das 21:26.
    //
    // `gorjetaTotalAcimaDeUsd: undefined` DESLIGA o resgate all-in de
    // 2026-09-30, porque é isso que reproduz aquele dia. Com o resgate ligado a
    // faixa não tem mais teto e a região do lance inteiro ganha um buraco no
    // meio — verdade nova, log velho. Os dois números continuam sendo o teste de
    // que `politicaDoTiro` tem um dono só.
    const f = faixaQueAtira({
        precoDoEthUsd: new Decimal('2692.43'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        // `CACA_LUCRO_MAXIMO_USD` EXPLICITO: o padrão virou SEM TETO em
        // 2026-09-30, a pedido dela ("eu quero o alvo de US$ 1.986").
        ...politicaDoTiro({ CACA_FRACAO_GORJETA: '0.15', CACA_RISCO_MAXIMO: '0.8',
            CACA_LIMITE_GAS: '1200000', CACA_LUCRO_MAXIMO_USD: '500' }),
        // DEPOIS do spread, senão `politicaDoTiro` sobrescreve — o `tsc` pegou
        // esta exata inversão de ordem.
        gorjetaTotalAcimaDeUsd: undefined,
        tiroDeProva: false,
    });
    // O teto bate na vírgula com o log: era o número que a ferramenta de fora
    // errava em 46%.
    assert.equal(f!.ate!.toFixed(2), '45.80');
    // O `lanceInteiroAte` do log é US$ 28,22, e aqui dá US$ 28,21: a busca binária
    // parte de uma âncora diferente quando o piso existe (aqui) e quando não
    // existe (o log rodou em modo prova). Um centavo de resolução da busca não é
    // divergência de regra, então a asserção é na casa que a regra determina.
    assert.equal(f!.inteiroAte!.toFixed(1), '28.2');
});

test('a faixa do CENSO e a do TIRO respondem perguntas diferentes', () => {
    // O censo pergunta "do que o bot vive?". O tiro de prova pergunta "o caminho
    // funciona?". Em 2026-09-27 as duas usaram a mesma resposta e o censo passou a
    // publicar `naSUAFaixa: 57 de 57` e `~US$ 5946/mês` — o dinheiro da faixa de
    // cima, que o próprio censo mediu como tendo dono, apresentado como renda dela.
    const ambiente = {
        precoDoEthUsd: new Decimal('2680.90'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        // `CACA_LUCRO_MAXIMO_USD` EXPLICITO: o padrao virou SEM TETO em
        // 2026-09-30, a pedido dela. Este teste pergunta censo contra tiro,
        // nao qual e o padrao — entao ele liga o teto para provar que funciona.
        ...politicaDoTiro({ CACA_FRACAO_GORJETA: '0.15', CACA_RISCO_MAXIMO: '0.8',
            CACA_LIMITE_GAS: '1200000', CACA_LUCRO_MAXIMO_USD: '500' }),
    };
    const premioDaBaleia = new Decimal('1985.95');

    // A pergunta do CENSO: a baleia NÃO entra. É isto que sustenta a decisão do
    // gás registrada no CLAUDE.md.
    const censo = faixaQueAtira({ ...ambiente, tiroDeProva: false })!;
    assert.ok(censo.ate !== null, 'a faixa sustentável TEM teto');
    assert.ok(premioDaBaleia.greaterThan(censo.ate!), 'e a baleia está acima dele');

    // A pergunta do TIRO, e ela MUDOU em 2026-09-28 à noite: a dona do bot pediu
    // faixa de negócio de US$ 0,50 a US$ 500, "ignorar tubarões acima de US$ 500
    // por enquanto, para focar no oceano azul onde há menos concorrência
    // institucional e construir caixa para gás futuro".
    //
    // Antes deste pedido o modo prova aceitava a baleia de US$ 1.985,95 ("custe o
    // que custar"). Agora não: o teto de negócio vale ATÉ na prova, porque não é
    // proteção de banca, é escolha de mercado. As duas instruções são dela e a
    // nova ganha — fica escrito aqui para a próxima sessão não achar que foi
    // descuido.
    const comFaixa = { ...ambiente, tiroDeProva: true as const };
    assert.equal(faixaQueAtira(comFaixa)!.ate!.toFixed(0), '500', 'o teto agora é o de negócio');
    const naBaleia = decidirTiro({ ...comFaixa, lucroUsd: premioDaBaleia });
    assert.equal(naBaleia.atira, false, 'a baleia passa a ser recusada, e por ESCOLHA dela');
    assert.match(naBaleia.porque, /tubarão/);
    // E o que sobrou da pergunta antiga: dentro da faixa, a prova continua
    // atirando em qualquer coisa que a regra normal recusaria.
    assert.equal(decidirTiro({ ...comFaixa, lucroUsd: new Decimal('499') }).atira, true);
});

test('sem aceitar prejuízo o bot NUNCA atira: o único alvo legível a tempo dá prejuízo', () => {
    // A medição de 2026-09-28: varri as 51 liquidações de 9,5 dias na Aave da Base
    // e conferi a saúde um bloco antes de cada uma. 32 foram levadas no MESMO
    // bloco em que ficaram liquidáveis — impossíveis de ler a tempo. As 11 com
    // janela eram TODAS poeira: dívidas de US$ 0,20 / 0,26 / 0,31, conferidas uma
    // por uma com os números crus e os links do basescan.
    //
    // Então o alvo que este bot consegue ler vale isto:
    const poeira = lucroEstimado(new Decimal('0.31'));
    assert.ok(poeira.lessThan(0), `a poeira devia dar prejuízo, deu ${poeira}`);

    const ambiente = {
        lucroUsd: poeira,
        precoDoEthUsd: new Decimal('2651.90'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        limiteGas: 1_200_000n,
        tiroDeProva: true,
    };
    // Modo prova ligado, e ainda assim NÃO atira: `valeATentativa` exige lucro
    // acima de zero. Era este portão que fazia o bot nunca atirar.
    const semAceitar = decidirTiro(ambiente);
    assert.equal(semAceitar.atira, false);

    // Com a chave que ela pediu ("a qualquer custo"), atira — e o motivo diz em
    // voz alta que é prejuízo de propósito, para o primeiro tiro não ser lido
    // como acerto.
    const aceitando = decidirTiro({ ...ambiente, aceitaPrejuizo: true });
    assert.equal(aceitando.atira, true, aceitando.porque);
    assert.match(aceitando.porque, /PREJUÍZO ACEITO DE PROPÓSITO/);
    assert.match(aceitando.porque, /NÃO é um acerto/);
    assert.equal(aceitando.soPassouPorSerProva, true);
    // A gorjeta não vira zero nem negativa com lucro negativo: cai no piso.
    assert.ok(aceitando.prioridadeWei >= PISO_DA_GORJETA_WEI);
});

test('aceitar prejuízo NÃO vale sem o modo prova, e não atira sem cotação', () => {
    const base = {
        lucroUsd: lucroEstimado(new Decimal('0.31')),
        precoDoEthUsd: new Decimal('2651.90'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        limiteGas: 1_200_000n,
        aceitaPrejuizo: true,
    };
    // Sem o modo prova a chave é inerte — a trava do nonce mora no modo prova, e
    // sem ela um prejuízo aceito repetiria a cada reinício do Railway até o gás
    // acabar.
    assert.equal(decidirTiro({ ...base, tiroDeProva: false }).atira, false);

    // E nem aceitando prejuízo se atira às cegas: sem saber o preço do ETH não se
    // dimensiona a gorjeta, e sem saber o lucro não se sabe em QUE se atirou.
    assert.equal(decidirTiro({ ...base, tiroDeProva: true, precoDoEthUsd: null }).atira, false);
    assert.equal(decidirTiro({ ...base, tiroDeProva: true, lucroUsd: null }).atira, false);
});

test('a política lê CACA_ACEITA_PREJUIZO, e um lugar só', () => {
    assert.equal(politicaDoTiro({}).aceitaPrejuizo, false, 'desligado por padrão');
    assert.equal(politicaDoTiro({ CACA_ACEITA_PREJUIZO: '1' }).aceitaPrejuizo, true);
    assert.equal(politicaDoTiro({ CACA_ACEITA_PREJUIZO: 'sim' }).aceitaPrejuizo, false, 'só "1" liga');
});

test('lucro do contrato é SEM SINAL: o que aceitaPrejuizo solta é o ZERO', () => {
    // Correção de 2026-09-28, achada por revisão horas depois de eu mandar ela
    // ligar a chave. Eu escrevi que sem `aceitaPrejuizo` o bot nunca atiraria,
    // porque o alvo legível vale -US$ 0,30. Errado: o lucro que chega em
    // `decidirTiro` pelo caminho quente vem do contrato via
    // `BigInt('0x'+...)` — inteiro SEM SINAL, nunca negativo.
    //
    // O que a chave solta de verdade é o lucro BRUTO igual a zero, e o bruto
    // positivo que o gás come.
    const ambiente = {
        precoDoEthUsd: new Decimal('2665.33'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        limiteGas: 1_200_000n,
        tiroDeProva: true,
    };
    // Lucro bruto ZERO: é o que `lerRespostaDaCaca` devolve de propósito.
    const zero = new Decimal(0);
    assert.equal(decidirTiro({ ...ambiente, lucroUsd: zero }).atira, false,
        'com margem zero `valeATentativa` ainda exige lucro ACIMA de zero');
    const comChave = decidirTiro({ ...ambiente, lucroUsd: zero, aceitaPrejuizo: true });
    assert.equal(comChave.atira, true, comChave.porque);
    assert.match(comChave.porque, /PREJUÍZO ACEITO DE PROPÓSITO/);

    // E aqui este teste me corrigiu outra vez, e a verdade é mais estreita ainda:
    // o modo prova JÁ aceitava prejuízo. Com margem zero, `valeATentativa` só
    // exige lucro acima de zero — então US$ 0,01 de lucro bruto contra US$ 0,22 de
    // gás já passava, sem chave nenhuma.
    const migalha = new Decimal('0.01');
    const so = decidirTiro({ ...ambiente, lucroUsd: migalha });
    assert.ok(so.custoUsd!.greaterThan(migalha), 'o gás tem de comer o lucro, senão não é prejuízo');
    assert.equal(so.atira, true, 'o modo prova sozinho já atira num lucro que o gás come');

    // Ou seja: `CACA_ACEITA_PREJUIZO=1` muda o comportamento em UM caso só — o
    // lucro bruto exatamente zero. Está escrito aqui para ninguém (eu inclusive)
    // voltar a dizer que ela é o que faz o bot atirar.
    assert.equal(decidirTiro({ ...ambiente, lucroUsd: new Decimal('0.000001') }).atira, true);
});

test('a política MORRE em número torto, em vez de decidir errado calada', () => {
    // `Number('0,5')` — vírgula decimal, natural em português — devolve NaN em
    // silêncio, e NaN atravessa a conta inteira. Medido: com
    // CACA_MORDIDA_MAXIMA='0,5', `mataACacaDeMigalhas` chama
    // BigInt(Math.round(NaN * 1e6)) e estoura RangeError, que o laço do caçador
    // engole como "tropeço rápido na rede" — o bot nunca mais atira e o log culpa
    // a rede.
    assert.throws(() => politicaDoTiro({ CACA_MORDIDA_MAXIMA: '0,5' }), /CACA_MORDIDA_MAXIMA="0,5"/);
    assert.throws(() => politicaDoTiro({ CACA_FRACAO_GORJETA: '15%' }), /ponto decimal, não vírgula/);
    assert.throws(() => politicaDoTiro({ CACA_RISCO_MAXIMO: 'oito décimos' }), /CACA_RISCO_MAXIMO/);
    // Vazio e ausente caem no padrão, que é o comportamento de sempre.
    assert.equal(politicaDoTiro({ CACA_RISCO_MAXIMO: '' }).fracaoMaximaDoSaldo, 0.6);
    assert.equal(politicaDoTiro({}).fracaoMaximaDoSaldo, 0.6);
    assert.equal(politicaDoTiro({ CACA_RISCO_MAXIMO: '0.8' }).fracaoMaximaDoSaldo, 0.8);
});

test('comoLerAPolitica imprime TODOS os botões, inclusive o que decide se atira', () => {
    const linha = comoLerAPolitica(politicaDoTiro({ CACA_ACEITA_PREJUIZO: '1' }));
    assert.match(linha, /aceita prejuízo SIM/);
    assert.match(comoLerAPolitica(politicaDoTiro({})), /aceita prejuízo não/);
    // A linha existe para conferir daqui contra o Railway. Um botão que não
    // aparece não pode ser conferido — faltava justamente esse.
    for (const pedaco of ['gás', 'gorjeta', 'risco', 'margem', 'mordida', 'amordaçado', 'aceita prejuízo']) {
        assert.ok(linha.includes(pedaco), `faltou "${pedaco}" na linha: ${linha}`);
    }
});

test('MODO KAMIKAZE: a gorjeta do tiro de prova não é amordaçada pelo prêmio', () => {
    // Ela pediu com todas as letras: "nem que eu gaste todo o meu saldo de gás
    // de bribe num alvo que dê US$ 0.05 de prêmio bruto". O log das 16:58 media
    // `gorjeta 2.49 gwei (AMORDAÇADA — queria 7.02)` num prêmio de migalha.
    const comum = {
        lucroUsd: new Decimal('0.05'),
        precoDoEthUsd: new Decimal('2686.53'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20000000n,
    };
    const normal = decidirTiro({ ...comum });
    const prova = decidirTiro({ ...comum, tiroDeProva: true, aceitaPrejuizo: true });
    assert.equal(prova.prioridadeWei > normal.prioridadeWei, true,
        'no modo prova a gorjeta tem de ser MAIOR que a proporcional ao prêmio');
    assert.equal(prova.atira, true, 'e o tiro sai');
});

test('o kamikaze pode ser desligado para medir o comportamento normal', () => {
    const comum = {
        lucroUsd: new Decimal('0.05'),
        precoDoEthUsd: new Decimal('2686.53'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20000000n,
        tiroDeProva: true as const,
        aceitaPrejuizo: true as const,
    };
    const com = decidirTiro({ ...comum });
    const sem = decidirTiro({ ...comum, gorjetaKamikaze: false });
    assert.equal(com.prioridadeWei > sem.prioridadeWei, true);
});

test('o kamikaze NÃO vale fora do modo prova, por mais que o saldo caiba', () => {
    // A trava: gorjeta de banca inteira num alvo de migalha, em operação
    // normal, queima a banca. O modo prova é UM tiro e se desarma pelo nonce.
    const comum = {
        lucroUsd: new Decimal('0.05'),
        precoDoEthUsd: new Decimal('2686.53'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20000000n,
        gorjetaKamikaze: true,
    };
    const semProva = decidirTiro({ ...comum });
    const comProva = decidirTiro({ ...comum, tiroDeProva: true, aceitaPrejuizo: true });
    assert.equal(semProva.prioridadeWei < comProva.prioridadeWei, true);
});

test('no kamikaze a gorjeta é a MESMA em qualquer tamanho de prêmio', () => {
    // Medido em 2026-09-28 com o saldo real, e foi ela quem viu a contradição
    // no log das 17:53:
    //     numDeUS$88      "gorjeta 2.49 gwei (inteira)"
    //     lanceInteiroAte "nenhum prêmio com lance inteiro"
    //
    // Duas linhas do mesmo [EM SECO]. A causa: fora do modo prova a gorjeta
    // desejada CRESCE com o prêmio, então uma vez amordaçado é para sempre e
    // `faixaQueAtira` podia testar o chão e desistir. No kamikaze a desejada é
    // CONSTANTE (teto da carteira) e quem cresce é a conseguida, pela fração de
    // risco — a região inteira é [X, ∞), não [chão, Y].
    const ambiente = {
        precoDoEthUsd: new Decimal('2697.19'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20_000_000n,
        tiroDeProva: true as const,
        aceitaPrejuizo: true as const,
    };
    const migalha = decidirTiro({ ...ambiente, lucroUsd: new Decimal('0.05') });
    const grande = decidirTiro({ ...ambiente, lucroUsd: new Decimal('88') });
    assert.equal(migalha.amordaca.amordacado, false, 'a migalha TAMBÉM sai inteira agora');
    assert.equal(grande.amordaca.amordacado, false, 'US$ 88 sai inteiro');
    assert.equal(migalha.desejadaWei, grande.desejadaWei, 'a desejada é CONSTANTE no kamikaze');
    assert.equal(migalha.prioridadeWei, grande.prioridadeWei,
        'e a ENVIADA também: a fração de risco não corta mais pelo tamanho do prêmio');

    // MUDOU DE NOVO em 2026-09-28, e foi ela quem mandou: no modo prova a
    // fração de risco saiu inteira, então não há mais mordaça em tamanho
    // nenhum — `inteiroDe` volta a ser null porque o lance é inteiro DESDE O
    // CHÃO. A busca sem direção continua valendo para o caso normal.
    const f = faixaQueAtira({ ...ambiente });
    assert.notEqual(f, null);
    // Contrato novo: "inteiro em qualquer tamanho" passa a ser dito como
    // `inteiroDe` no chão e `inteiroAte` nulo. Antes era `inteiroDe: null` com
    // `inteiroAte: 1000000`, que mentia sobre ter medido uma fronteira.
    assert.notEqual(f!.inteiroDe, null, 'no modo prova é inteiro desde o chão');
    assert.equal(f!.inteiroAte, null, 'e não há ponta de cima');
});

test('fora do modo prova a faixa continua respondendo pela ponta de CIMA', () => {
    // A ponta gêmea: o conserto não pode quebrar o caso normal, onde a mordaça
    // chega quando o prêmio cresce.
    const f = faixaQueAtira({
        precoDoEthUsd: new Decimal('2692.43'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        limiteGas: 1_200_000n,
        fracaoBaseDoLucro: 0.15,
        fracaoMaximaDoSaldo: 0.8,
        tiroDeProva: false,
    });
    assert.notEqual(f, null);
    // NÃO mexer: este cenário monta os campos na mão e NÃO passa
    // `gorjetaTotalAcimaDeUsd`, então o resgate all-in está desligado e a forma
    // continua sendo [chão, Y] — a original. Eu remendei estas duas asserções em
    // 2026-09-30 achando que a forma tinha mudado em todo lugar, e estava
    // errado: mudou só onde o resgate está ligado.
    assert.equal(f!.inteiroDe, null, 'no caso normal não há ponta de baixo');
    assert.notEqual(f!.inteiroAte, null, 'e a de cima continua existindo');
    assert.equal(f!.inteiroTemBuraco, false, 'e sem resgate não há buraco no meio');
});

test('no KAMIKAZE a migalha recebe a gorjeta INTEIRA, e não metade', () => {
    // Ela viu que `inteiroDe` em US$ 34,63 significava que a maioria das
    // liquidações da Base — 31 das 52 do censo estão abaixo do piso de gás —
    // iria para a rede com a gorjeta cortada, no único tiro que precisa ser
    // ganho.
    //
    // A causa não era a fração MÁXIMA: `fracaoDoSaldoQueValeArriscar` escala
    // pelo LUCRO, e prêmio pequeno fica na fração BASE. Medido com o saldo dela
    // (US$ 8,99) e o risco máximo 0.8 do Railway:
    //     US$ 0,50 -> fração 0,2500 -> 1,173 gwei de 2,506
    //     US$ 2    -> fração 0,2500 -> 1,173 gwei de 2,506
    //     US$ 66   -> fração 0,6373 -> 2,486 gwei (inteira)
    const ambiente = {
        precoDoEthUsd: new Decimal('2692.04'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20_000_000n,
        fracaoBaseDoSaldo: 0.25,
        fracaoMaximaDoSaldo: 0.8,
        tiroDeProva: true as const,
        aceitaPrejuizo: true as const,
    };
    const migalha = decidirTiro({ ...ambiente, lucroUsd: new Decimal('2') });
    const grande = decidirTiro({ ...ambiente, lucroUsd: new Decimal('66') });
    assert.equal(migalha.prioridadeWei, grande.prioridadeWei,
        'a migalha tem de sair com a MESMA gorjeta do prêmio grande');
    assert.equal(migalha.amordaca.amordacado, false, 'e não amordaçada');
    assert.equal(migalha.atira, true);
    // O que NÃO se solta, porque é aritmética e não política:
    assert.equal(migalha.aguentaDerrotas >= 1, true, 'a derrota continua tendo de ser pagável');

    // E a faixa passa a dizer que o lance é inteiro desde o chão.
    const f = faixaQueAtira({ ...ambiente });
    // Contrato novo (ver o bloco no topo do arquivo): "inteiro em qualquer
    // tamanho" sai como `inteiroDe` no chão e `inteiroAte` nulo. Antes era
    // `inteiroAte = 1000000`, o TETO DA BUSCA publicado como fronteira.
    assert.notEqual(f!.inteiroDe, null, 'é inteiro desde o chão');
    assert.equal(f!.inteiroAte, null, 'e não há fronteira de cima — nem inventada');
    assert.equal(f!.inteiroTemBuraco, false, 'no kamikaze puro a região é contígua');
});

test('fora do modo prova a fração de risco CONTINUA cortando a migalha', () => {
    // A ponta gêmea. A escala existe e está certa em operação normal: arriscar
    // banca grande por prêmio pequeno é como se perde a banca. Só o modo prova
    // — um tiro, que se desarma pelo nonce — compra essa exceção.
    const ambiente = {
        precoDoEthUsd: new Decimal('2692.04'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20_000_000n,
        fracaoBaseDoSaldo: 0.25,
        fracaoMaximaDoSaldo: 0.8,
    };
    const migalha = decidirTiro({ ...ambiente, lucroUsd: new Decimal('2') });
    const grande = decidirTiro({ ...ambiente, lucroUsd: new Decimal('66') });
    assert.equal(migalha.prioridadeWei < grande.prioridadeWei, true,
        'sem modo prova, prêmio pequeno continua recebendo gorjeta menor');
});

test('o rótulo de prova segue a regra normal, e US$ 2 ela ACEITA', () => {
    // Eu escrevi este teste esperando `soPassouPorSerProva: true` para US$ 2, e
    // o teste me corrigiu. Medido: com a gorjeta NORMAL o tiro de US$ 2 custa
    // US$ 0,84, e 2 >= 2 x 0,84 — a regra normal aceita. O rótulo existe para
    // marcar o que só passou POR SER prova, e US$ 2 não é esse caso.
    //
    // Quem só passa por ser prova é o prêmio GRANDE, que a caça de migalhas
    // barra: US$ 66 custa US$ 5,73 na regra normal e é recusado.
    const d = decidirTiro({
        precoDoEthUsd: new Decimal('2692.04'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20_000_000n,
        fracaoBaseDoSaldo: 0.25,
        fracaoMaximaDoSaldo: 0.8,
        lucroUsd: new Decimal('2'),
        tiroDeProva: true,
        aceitaPrejuizo: true,
    });
    assert.equal(d.atira, true);
    assert.equal(d.soPassouPorSerProva, false, 'a regra normal aceita US$ 2 contra US$ 0,84 de custo');

    const grande = decidirTiro({
        precoDoEthUsd: new Decimal('2692.04'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20_000_000n,
        fracaoBaseDoSaldo: 0.25,
        fracaoMaximaDoSaldo: 0.8,
        lucroUsd: new Decimal('66'),
        tiroDeProva: true,
        aceitaPrejuizo: true,
    });
    assert.equal(grande.soPassouPorSerProva, true, 'US$ 66 a regra normal recusa');
    assert.match(grande.porque, /SÓ SAI PORQUE É PROVA/);
});

test('a faixa de negócio: US$ 0,50 a US$ 500, e vale ATÉ no modo prova', () => {
    // Pedida por ela em 2026-09-28: poeira abaixo não paga o gás; tubarão acima
    // satura no pool da Aerodrome (US$ 1.986) e perde o leilão para quem usa
    // agregador. O oceano azul é no meio.
    const amb = {
        precoDoEthUsd: new Decimal('2692.04'),
        saldoWei: 3341111191761470n,
        baseFeeWei: 20_000_000n,
        // Teto EXPLICITO: o padrao virou sem teto em 2026-09-30. O piso de
        // US$ 0,50 continua sendo padrao, e e ele que ela mandou manter.
        ...politicaDoTiro({ CACA_LUCRO_MAXIMO_USD: '500' }),
        tiroDeProva: true as const,
        aceitaPrejuizo: true as const,
    };
    assert.equal(decidirTiro({ ...amb, lucroUsd: new Decimal('0.49') }).atira, false);
    assert.match(decidirTiro({ ...amb, lucroUsd: new Decimal('0.49') }).porque, /ABAIXO do piso/);
    assert.equal(decidirTiro({ ...amb, lucroUsd: new Decimal('0.50') }).atira, true);
    assert.equal(decidirTiro({ ...amb, lucroUsd: new Decimal('500') }).atira, true);
    assert.equal(decidirTiro({ ...amb, lucroUsd: new Decimal('500.01') }).atira, false);
    assert.match(decidirTiro({ ...amb, lucroUsd: new Decimal('1986') }).porque, /tubarão/);
    // Sem cotação não se atira: não dá para saber se está na faixa.
    assert.equal(decidirTiro({ ...amb, lucroUsd: null }).atira, false);
});

// ===========================================================================
// O GÁS DINÂMICO — 2026-09-30, pedido dela depois da auditoria:
// "NUNCA um limite cravado (hardcoded) de 700k ou qualquer outro número fixo".
//
// O motivo dela está certo, e é aritmético: se o saldo inteiro vai para a
// gorjeta e a caçada usa 720k contra um teto de 700k, a transação reverte
// sem gás e o dinheiro vai embora sem liquidação nenhuma.
// ===========================================================================

test('sem estimativa o bot ATIRA, com teto acima do maximo medido', () => {
    // ESTE TESTE MUDOU DE LADO EM 2026-10-06, e o motivo esta escrito para a
    // proxima sessao nao reverter sem saber.
    //
    // Ele exigia `limite: null` — nao atirar quando `eth_estimateGas` nao
    // responde. A razao era boa (nao morrer sem gas), mas a conclusao estava
    // errada: morrer sem gas so acontece com limite BAIXO. Um limite ALTO nao
    // tem esse risco, porque o no congela `gasLimit x maxFee` e DEVOLVE o que
    // nao foi consumido — o preco e lance mais apertado, nao dinheiro perdido.
    //
    // Ela disse, depois de perder alvos: "eu so quero que ele atire na hora
    // certa e pegue o alvo de primeira". Perder a liquidacao por um RPC lento e
    // perda CERTA; lance apertado e so desvantagem.
    //
    // O que o teste protege agora e a regra de verdade: o teto de emergencia
    // tem de ficar ACIMA do maximo de consumo ja MEDIDO (4.142.116, do lider da
    // faixa), senao ele reintroduz o fracasso que o original temia.
    assert.ok(TETO_SEM_ESTIMATIVA > 4_142_116n, 'o maximo medido do lider da faixa');

    const r = limiteDeGasDoTiro({ estimadoGas: null, saldoWei: 16419111191761470n, baseFeeWei: 5_000_000n });
    assert.notEqual(r.limite, null, 'atira: perder por RPC lento e perda certa');
    assert.ok(r.limite! > 4_142_116n, 'e com teto acima do maximo medido');
    assert.match(r.porque, /não respondeu/);

    // Zero e negativo seguem sendo "nao sei" e caem no mesmo caminho.
    for (const e of [0n, -5n]) {
        const x = limiteDeGasDoTiro({ estimadoGas: e, saldoWei: 16419111191761470n, baseFeeWei: 5_000_000n });
        assert.ok(x.limite === null || x.limite > 4_142_116n);
    }
});

test('sem estimativa E com saldo magro, ai sim NAO atira', () => {
    // O portao que sobra, e ele e aritmetica: se o saldo nao comporta nem o piso
    // de gas, atirar e morrer sem gas de verdade. Aqui `null` continua certo.
    const r = limiteDeGasDoTiro({ estimadoGas: null, saldoWei: 100_000_000_000n, baseFeeWei: 5_000_000n });
    assert.equal(r.limite, null);
    assert.match(r.porque, /abaixo do piso/);
});

test('a folga sobre a estimativa cobre a variância medida do líder', () => {
    // A única variância de consumo que este projeto tem medida: o líder da faixa
    // (`0xd12810b1`, 9 de 19 liquidações em 9,5 dias) gastou entre 1.202.608 e
    // 4.142.116 no MESMO contrato — 2,76x a mediana de 1.500.956. Uma folga de
    // 50% não cobriria aquilo; 100% cobre quase tudo.
    assert.equal(FOLGA_DO_GAS, 1.0, 'o dobro do estimado');
    const r = limiteDeGasDoTiro({ estimadoGas: 1_000_000n, saldoWei: 16419111191761470n, baseFeeWei: 5_000_000n });
    assert.equal(r.limite, 2_000_000n, '1M estimado + 100% = 2M de teto');
    assert.match(r.porque!, /estimou 1000000 \+ 100% de folga/);
    // Uma caçada de 720k contra um teto de 700k era o caso que ela descreveu:
    // com a folga, 720k estimados mandam 1.440.000 e não morre sem gás.
    assert.equal(limiteDeGasDoTiro({ estimadoGas: 720_000n, saldoWei: 16419111191761470n, baseFeeWei: 5_000_000n }).limite,
        1_440_000n, 'os 720k que ela citou passam com folga de sobra');
});

test('o piso do teto de gás existe: estimativa pequena não manda teto apertado', () => {
    // Uma estimativa de 100k (a Aave recusando cedo, por exemplo) daria 200k com
    // a folga — e uma caçada de verdade usa ~700k. Mandar 200k seria morrer sem
    // gás na primeira que passar do corte.
    const r = limiteDeGasDoTiro({ estimadoGas: 100_000n, saldoWei: 16419111191761470n, baseFeeWei: 5_000_000n });
    assert.equal(r.limite, PISO_DO_LIMITE_DE_GAS);
    assert.match(r.porque!, /subiu para o piso/);
    assert.equal(PISO_DO_LIMITE_DE_GAS > 700_000n, true, 'e o piso é maior que os ~700k que a caçada usa');
});

test('o teto que estrangula o lance é CALCULADO do saldo, não cravado', () => {
    // O nó congela `gasLimit × maxFeePerGas` adiantado, então teto grande come
    // lance. "Quanto é grande" sai do saldo e muda quando ela deposita.
    const pequeno = tetoDeGasQueNaoEstrangulaOLance(16419111191761470n, 5_000_000n);
    const gordo = tetoDeGasQueNaoEstrangulaOLance(200_000_000_000_000_000n, 5_000_000n);
    assert.equal(gordo > pequeno, true, 'saldo maior comporta teto maior');
    assert.equal(pequeno >= PISO_DO_LIMITE_DE_GAS, true, 'e nunca desce abaixo do piso');
    // O alvo dos 4 gwei é 10x a MAIOR gorjeta que qualquer concorrente pagou nas
    // 19 liquidações medidas (0,4002 gwei). Não é número escolhido no ar.
    assert.equal(GORJETA_QUE_GANHA_O_LEILAO_WEI, 4_000_000_000n);
    assert.equal(Number(GORJETA_QUE_GANHA_O_LEILAO_WEI) / 1e9 / 0.4002 > 9, true, 'dez vezes o campo medido');
});

test('teto acima do que o saldo comporta MANDA o pedido, e diz que o lance aperta', () => {
    // A escolha, e ela tem lado: morrer sem gás é perda CERTA; lance fraco é só
    // desvantagem. Então o teto pedido vai, e o log avisa.
    const saldoMagro = 2_000_000_000_000_000n; // 0,002 ETH
    const r = limiteDeGasDoTiro({ estimadoGas: 3_000_000n, saldoWei: saldoMagro, baseFeeWei: 5_000_000n });
    assert.equal(r.limite, 6_000_000n, 'manda os 6M que a caçada pede');
    assert.match(r.porque!, /ACIMA do teto/);
    assert.match(r.porque!, /morrer sem gás é perda certa/);
});

test('o LIMITE_DE_GAS de planejamento voltou a ter folga sobre o consumo', () => {
    // As duas asserções que `c43a102` deixou vermelhas por um dia. Elas são a
    // guarda que este projeto construiu contra exatamente o out-of-gas que ela
    // descreveu em 2026-09-30, e estavam certas.
    assert.equal(LIMITE_DE_GAS > GAS_TIPICO_DE_UMA_CACADA, true,
        `${LIMITE_DE_GAS} tem de sobrar folga sobre os ${GAS_TIPICO_DE_UMA_CACADA} que a caçada usa`);
    assert.equal(LIMITE_DE_GAS >= 1_000_000n, true);
    assert.equal(LIMITE_DE_GAS < 2_000_000n, true, 'sem congelar adiantado à toa');
    // E o medo que motivou os 700k não se sustenta neste saldo: com 1,2M de teto
    // a gorjeta possível é 12,31 gwei — 31x a maior do campo medido (0,4002).
    const teto = maxFeeQueOSaldoAdianta(16419111191761470n, LIMITE_DE_GAS);
    assert.equal(Number(teto) / 1e9 > 12, true, `${(Number(teto) / 1e9).toFixed(4)} gwei`);
    assert.equal(Number(teto) / 1e9 / 0.4002 > 25, true, 'e ainda bate o campo por mais de 25x');
});

// ===========================================================================
// O TETO DA GORJETA DO TIRO ESPECULATIVO — medido em 2026-10-07.
// ===========================================================================

test('o teto corta a gorjeta do tiro especulativo, e o normal fica agressivo', () => {
    // MEDIDO: a frente do bloco na Base custa p50 0,0150 gwei e p90 0,1366
    // (15 blocos, cobertura 100%, 90 amostras), e o liquidante que levou o
    // alvo de US$ 49,33 pagou 0,046688 gwei. O bot pagava 2,84 — acima da
    // MAXIMA vista em qualquer das seis primeiras posicoes. Isso nao ganhava
    // nada a mais e reduzia as tentativas de 57 para 6.
    const ambiente = {
        lucroUsd: new Decimal(49.33),
        precoDoEthUsd: new Decimal(2581.19),
        saldoWei: 15_821_000_000_000_000n, // 0,015821 ETH, o saldo dela
        baseFeeWei: 5_000_000n,            // 0,005 gwei, o do bloco 52289907
    };
    const semTeto = decidirTiro(ambiente);
    const comTeto = decidirTiro({
        ...ambiente,
        tetoDaGorjetaWei: BigInt(Math.round(GORJETA_DA_FRENTE_GWEI * 1e9)),
    });
    assert.ok(comTeto.prioridadeWei <= BigInt(Math.round(GORJETA_DA_FRENTE_GWEI * 1e9)),
        `o teto tem de valer: ${comTeto.prioridadeWei}`);
    assert.ok(semTeto.prioridadeWei > comTeto.prioridadeWei,
        'sem teto a gorjeta e maior — senao este teste nao prova nada');
    // E as duas AINDA atiram: cortar a gorjeta nao pode fechar o portao.
    assert.equal(comTeto.atira, true, comTeto.porque);
});

test('a GORJETA COMPRA POSIÇÃO DENTRO da fatia — eu li o sinal do rho ao contrário', () => {
    // ESTE TESTE AFIRMAVA O CONTRÁRIO ATÉ 2026-10-09, e o que ele afirmava
    // estava errado: "o teto medido GANHA a frente do bloco com folga", exigindo
    // `GORJETA_DA_FRENTE_GWEI > p90 da frente (0,136577)`.
    //
    // MEDIDO nos 33 blocos em que o bot de fato atirou (39 transações
    // reconstruídas pelo nonce, cobertura 100%):
    //
    //     Spearman posição × gorjeta:  médio +0,300  (min −0,039  max +0,570)
    //     nossa posição mediana pagando 0,300 gwei:  766
    //     no bloco 52341747: das 1.943 à nossa frente, 1.825 pagaram MENOS
    //     95% das transações de um bloco pagam < 0,02 gwei — e entram
    //
    // Correlação POSITIVA é o oposto de leilão: o sequenciador enfileira por
    // ordem de CHEGADA e não reordena por lance. Então pagar mais não compra
    // lugar — compra só menos tentativas.
    // O ERRO ERA DE SINAL. A minha função de Spearman dá posto 0 à MAIOR
    // gorjeta, então ordem decrescente perfeita — leilão perfeito — dá rho
    // **+1**, não −1. Eu li o +0,305 do bloco inteiro como "positivo, logo o
    // oposto de leilão". É o contrário.
    //
    // E a Base monta o bloco em FATIAS (Flashblocks ~200ms). Medido nos mesmos
    // 33 blocos, quebrando onde a gorjeta sobe: rho DENTRO da fatia +0,997,
    // com p10 = p50 = p90 = 1,000, em 573 fatias. Ordem decrescente perfeita.
    assert.ok(RHO_MEDIDO_POSICAO_X_GORJETA > 0,
        'rho positivo é leilão FRACO no bloco inteiro — a assinatura de fatias '
        + 'ordenadas concatenadas por tempo, não prova de ausência de leilão');

    // A curva medida tem de ser monótona: mais lance, mais chance de ser o topo.
    let anterior = -1;
    for (const [g, f] of CURVA_TOPO_DA_FATIA) {
        assert.ok(f > anterior, `F tem de crescer com a gorjeta (${g} gwei)`);
        anterior = f;
    }
    // E os dois pontos que decidem: 0,020 gwei topa 34% das fatias, 0,300 topa
    // 66%. Cortar de 0,300 para 0,020 reduz a chance de ganhar PELA METADE —
    // foi isso que eu fiz de manhã achando que não custava nada.
    assert.equal(chanceDeSerOTopoDaFatia(0.02), 0.34);
    assert.equal(chanceDeSerOTopoDaFatia(0.3), 0.66);
    assert.ok(chanceDeSerOTopoDaFatia(0.3) / chanceDeSerOTopoDaFatia(0.02) > 1.9,
        'o corte que eu fiz dividia a chance por quase dois');
    // Degrau, não interpolação: entre medições devolve a de BAIXO.
    assert.equal(chanceDeSerOTopoDaFatia(0.29), chanceDeSerOTopoDaFatia(0.1));
    assert.equal(chanceDeSerOTopoDaFatia(0), 0);
    assert.equal(chanceDeSerOTopoDaFatia(-1), 0);
    assert.equal(chanceDeSerOTopoDaFatia(Number.NaN), 0);
});

test('a gorjeta ÓTIMA cresce com o prêmio, e o piso inclui a chance de GANHAR', () => {
    // Os números medidos: gás 372.202 (39 recibos), baseFee 0,020 gwei, ETH
    // US$ 2.500,67 (log de produção de 2026-10-09 11:47), 355 blocos entre
    // escritas do oráculo (7 dias, cobertura 92,9%).
    const ambiente = { baseFeeWei: 20_000_000n, precoDoEthUsd: 2500.67 };
    const otima = (premioUsd: number) => gorjetaQueMaximizaOValor({ ...ambiente, premioUsd });

    // CRESCE com o prêmio — é isto que um teto fixo não consegue fazer.
    const pequeno = otima(47.12);
    const grande = otima(1932.39);
    assert.ok(grande.gorjetaGwei > pequeno.gorjetaGwei,
        `prêmio maior pede lance maior (${pequeno.gorjetaGwei} vs ${grande.gorjetaGwei})`);
    assert.equal(pequeno.gorjetaGwei, 0.02);
    assert.equal(grande.gorjetaGwei, 0.65);

    // E o teto fixo de 0,020 gwei que eu tinha posto deixa valor na mesa no
    // prêmio grande — a prova de que a correção não é cosmética.
    const comTetoFixo = (0.34 / 355) * 1932.39 - ((0.02 + 0.02) * 372202 * 2500.67) / 1e9;
    assert.ok(grande.evUsd - comTetoFixo > 1,
        `o teto fixo deixava mais de US$ 1 de EV na mesa (deixava ${(grande.evUsd - comTetoFixo).toFixed(2)})`);

    // O PISO: com F = 1 suposto ele dava US$ 13,22 e autorizava EV NEGATIVO.
    // Com F medido o piso é US$ 38,13 — e os dois alvos reais ficam de lados
    // opostos dele, que é a única maneira de o número ser verificável.
    const piso = premioQueSePagaComAFatia(ambiente);
    assert.ok(piso > 37 && piso < 39, `piso ${piso.toFixed(2)}`);
    assert.ok(otima(47.12).evUsd > 0, 'o alvo real de 07/10 tem de passar');
    assert.ok(otima(11.59).evUsd < 0, 'o de 08/10 tem de ficar de fora: EV negativo em TODA gorjeta');
    assert.ok(otima(piso * 0.9).evUsd < 0 && otima(piso * 1.1).evUsd > 0,
        'o piso tem de ser a fronteira de verdade, não um número ao lado dela');

    // Sem preço do ETH não existe conta: EV negativo, nunca "de graça".
    assert.ok(gorjetaQueMaximizaOValor({ ...ambiente, premioUsd: 1000, precoDoEthUsd: 0 }).evUsd < 0);
    assert.ok(otima(0).evUsd < 0);
});

test('o teto NAO aumenta uma gorjeta pequena', () => {
    // Teto e teto: num premio de migalha a gorjeta ja sai abaixo dele, e o
    // teto nao pode virar piso e gastar mais do que a politica queria.
    const ambiente = {
        lucroUsd: new Decimal(0.6),
        precoDoEthUsd: new Decimal(2581.19),
        saldoWei: 15_821_000_000_000_000n,
        baseFeeWei: 5_000_000n,
    };
    const semTeto = decidirTiro(ambiente);
    const comTeto = decidirTiro({
        ...ambiente, tetoDaGorjetaWei: BigInt(Math.round(GORJETA_DA_FRENTE_GWEI * 1e9)),
    });
    if (semTeto.prioridadeWei <= BigInt(Math.round(GORJETA_DA_FRENTE_GWEI * 1e9))) {
        assert.equal(comTeto.prioridadeWei, semTeto.prioridadeWei,
            'gorjeta que ja cabe no teto nao pode mudar');
    }
});

test('o gás da reversão é DOIS números, e juntá-los faria um errar para o lado errado', () => {
    // A primeira vez neste projeto em que manter dois números é o CERTO, e por
    // isso o teste existe: a REGRA 3 manda juntar o que calcula a mesma coisa,
    // e estes dois calculam a mesma grandeza para perguntas com lados seguros
    // OPOSTOS.
    //
    // GAS_DE_UMA_REVERSAO serve o freio de sobrevivência ("aguento mais N
    // derrotas"): errar para CIMA é seguro — com 150k o freio dizia "aguento 6"
    // quando a verdade era 1.
    //
    // GAS_MEDIDO_DE_UMA_REVERSAO serve o piso da aposta: errar para cima sobe o
    // piso, barra alvo e DESLIGA a estratégia — foi o que o piso de US$ 20 fez
    // em 07/10 com a única oportunidade do dia.
    assert.ok(
        GAS_MEDIDO_DE_UMA_REVERSAO < GAS_DE_UMA_REVERSAO,
        'o derivado dos 31 reverts tem de ser MENOR que o do freio, senão o freio '
        + 'deixou de errar para o lado seguro',
    );
    // LIDO nos 39 recibos em 2026-10-09 (nonce 6..44, cobertura 100%):
    // gasUsed média 372.202, p50 337.471, min 302.984, max 499.316. O 550.000
    // anterior era DERIVAÇÃO de diferença de saldo e errava 1,48x para cima.
    assert.ok(GAS_MEDIDO_DE_UMA_REVERSAO >= 302_984n && GAS_MEDIDO_DE_UMA_REVERSAO <= 499_316n,
        'tem de ficar DENTRO da faixa lida nos recibos, não numa derivação');

    // E o custo que cada um produz, para o número ficar visível no teste:
    const comFreio = custoDeUmaDerrota(300_000_000n, 20_000_000n, GAS_DE_UMA_REVERSAO);
    const comMedido = custoDeUmaDerrota(300_000_000n, 20_000_000n, GAS_MEDIDO_DE_UMA_REVERSAO);
    assert.ok(comFreio > comMedido);
    // Com a gorjeta de 0,300 gwei que a produção pagou, o custo tem de bater com
    // o que os recibos somaram: 0,004680 ETH / 39 = 0,00011999 ETH por errada.
    const ethMedido = Number(comMedido) / 1e18;
    assert.ok(ethMedido > 0.00011 && ethMedido < 0.00013, `${ethMedido}`);
});

test('o teto da gorjeta vale para os DOIS tiros, e dobra a cada corrida perdida', () => {
    // A PREMISSA QUE CAIU: até 2026-10-09 o teto só valia para o tiro
    // especulativo, "porque em posição já liquidável perder por lance seria
    // perder dinheiro na mesa". Medido: lance não compra posição na Base
    // (Spearman posição × gorjeta = +0,300 em 33 blocos; 1.825 das 1.943
    // transações à nossa frente pagaram MENOS que nós).
    //
    // O log de produção de 2026-10-09 11:47 mostrou o custo: num prêmio de
    // US$ 88 o tiro NORMAL queria 20,11 gwei e pagou 6,06, congelando
    // 0,005184 ETH — 46% do saldo dela por tiro.
    const ambiente = {
        lucroUsd: new Decimal(88),
        precoDoEthUsd: new Decimal(2500.67),
        saldoWei: 11_142_000_000_000_000n, // 0,011142 ETH, o saldo do log
        baseFeeWei: 20_000_000n,
    };
    const teto = (perdas: number) =>
        BigInt(Math.round(GORJETA_DA_FRENTE_GWEI * 1e9 * 2 ** Math.min(6, perdas)));

    const semTeto = decidirTiro(ambiente);
    const comTeto = decidirTiro({ ...ambiente, tetoDaGorjetaWei: teto(0) });
    assert.ok(semTeto.prioridadeWei > comTeto.prioridadeWei,
        'sem teto o tiro normal paga mais — senão este teste não prova nada');
    assert.equal(comTeto.prioridadeWei, teto(0), 'o teto tem de valer no tiro normal');
    assert.equal(comTeto.atira, true, `cortar a gorjeta não pode fechar o portão: ${comTeto.porque}`);

    // E O FEEDBACK CONTINUA VIVO: cada corrida de verdade perdida dobra o teto.
    // `perdasSeguidas` só sobe em tiro sobre posição JÁ liquidável, então isto
    // responde a evidência da corrente, não a palpite meu.
    assert.equal(teto(1), teto(0) * 2n);
    assert.equal(teto(3), teto(0) * 8n);
    // Seis derrotas depois o teto é 1,28 gwei — 27x o que o vencedor do alvo
    // real de US$ 49,33 pagou (0,046688 gwei) e 9x o p90 da frente do bloco.
    // Ele AINDA corta a política (que pedia 5,29 gwei neste prêmio), e isso é
    // o certo: a política pede lance por uma premissa que a medição derrubou.
    const depoisDeSeis = decidirTiro({ ...ambiente, tetoDaGorjetaWei: teto(6) });
    assert.equal(depoisDeSeis.prioridadeWei, teto(6));
    assert.ok(depoisDeSeis.prioridadeWei > comTeto.prioridadeWei * 60n,
        'a escada tem de levar o lance a mais de 60x o medido se houver evidência');
    assert.ok(Number(teto(6)) / 1e9 > 0.046688 * 20,
        'e o fim da escada tem de passar com folga o que o vencedor real pagou');
    // E o teto não cresce para sempre: 6 dobras é o fim da escada.
    assert.equal(teto(9), teto(6));

    // O que isto vale em munição, com o saldo dela: uma errada a 6,06 gwei
    // contra uma a 0,02 gwei.
    const caro = custoDeUmaDerrota(6_060_000_000n, 20_000_000n, GAS_MEDIDO_DE_UMA_REVERSAO);
    const medido = custoDeUmaDerrota(teto(0), 20_000_000n, GAS_MEDIDO_DE_UMA_REVERSAO);
    assert.ok(Number(caro) / Number(medido) > 100,
        `a errada tem de ficar 100x mais barata (ficou ${(Number(caro) / Number(medido)).toFixed(0)}x)`);
});

test('a chance depende da DISTÂNCIA do alvo, não é um número plano', () => {
    // MEDIDO em 2026-10-09, lendo `getAssetPrice(WETH)` do oráculo da Aave em
    // 5.000 blocos CONSECUTIVOS (167 min, cobertura 100%, 5.003 pedidos, ZERO
    // recusas): 15 escritas em 4.999 pares — uma a cada 333,3 blocos, o que
    // CONFIRMA os 355 do código por um caminho independente. Salto p10 0,0146%
    // / p50 0,1649% / p90 0,1960% / max 0,1995%.
    //
    // A escrita fecha 0,1169% em 80% dos casos e 0,1838% em 20%. O alvo real de
    // 07/10 precisava de 0,1838%: chance por bloco 0,0600%, **4,7x menor** que
    // a chance plana de 0,282% que o código aplicava a ele.
    //
    // E uma amostra de 600 blocos (3 escritas) tinha me dado "0,18% em NENHUMA
    // escrita". Era ruído, e a incerteza declarada já dizia que seria.
    assert.equal(fracaoDasEscritasQueFecham(0.05), 0.9);
    assert.equal(fracaoDasEscritasQueFecham(0.1169), 0.8);
    assert.equal(fracaoDasEscritasQueFecham(0.1683), 0.47);
    assert.equal(fracaoDasEscritasQueFecham(0.1838), 0.2, 'o alvo real de 07/10: improvável, não impossível');
    assert.equal(fracaoDasEscritasQueFecham(0.2077), 0, 'acima do maior salto medido: ZERO, não um palpite');
    assert.equal(fracaoDasEscritasQueFecham(5), 0, 'e não inventa cauda para alvo distante');

    // A REGRA, que é o que o teste guarda: a chance tem de CAIR com a
    // distância, nunca subir. Se alguma remedição invertisse isso, reprova.
    let anterior = 1.0001;
    for (const falta of [0, 0.05, 0.1, 0.12, 0.15, 0.17, 0.179, 0.19, 0.5, 2]) {
        const f = fracaoDasEscritasQueFecham(falta);
        assert.ok(f <= anterior, `${falta}% devolveu ${f} depois de ${anterior}`);
        anterior = f;
    }

    // E o EFEITO na decisão, com os números medidos: o MESMO prêmio é aposta
    // num alvo perto e recusa num alvo longe. É isto que um número plano não
    // consegue dizer.
    const ambiente = { baseFeeWei: 20_000_000n, precoDoEthUsd: 2500.67, premioUsd: 188.37 };
    const perto = gorjetaQueMaximizaOValor({ ...ambiente, faltaAoAlvoPct: 0.05 });
    const longe = gorjetaQueMaximizaOValor({ ...ambiente, faltaAoAlvoPct: 0.2077 });
    assert.ok(perto.evUsd > 0, `alvo perto tem de valer a aposta: ${perto.evUsd}`);
    assert.ok(longe.evUsd < 0, `alvo além do maior salto medido NÃO vale: ${longe.evUsd}`);

    // Sem distância conhecida, a conta volta a ser a de antes — o lado que não
    // autoriza MAIS do que já autorizava.
    const semSaber = gorjetaQueMaximizaOValor(ambiente);
    assert.ok(semSaber.evUsd >= perto.evUsd * 0.99, 'sem distância usa a conta antiga');
});
