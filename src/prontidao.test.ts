import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    gorjetaPorGas, tetoPorGas, lerBasefee,
    lanceAmordacado, mataACacaDeMigalhas, decidirTiro, faixaQueAtira, tiroDeProvaArmado, tiroEmBrancoArmado,
    politicaDoTiro, comoLerAPolitica,
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
    assert.equal(f!.de!.toFixed(2), '0.45');
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
    assert.ok(f.inteiroAte !== null, 'e o lance inteiro cobre até onde se procurou');
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
    assert.match(morto.porque, /já saiu tiro/);
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
    assert.equal(prova.amordaca.amordacado, true, 'sai amordaçado, e o log tem de dizer isso');
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
    assert.equal(usd.toFixed(4), '0.0484');
    assert.ok(usd.lessThan('0.10'), 'se isto passar de dez centavos o argumento muda');
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
    const f = faixaQueAtira({
        precoDoEthUsd: new Decimal('2692.43'),
        saldoWei: 3341111000000000n,
        baseFeeWei: 20_000_000n,
        ...politicaDoTiro({ CACA_FRACAO_GORJETA: '0.15', CACA_RISCO_MAXIMO: '0.8', CACA_LIMITE_GAS: '1200000' }),
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
        ...politicaDoTiro({ CACA_FRACAO_GORJETA: '0.15', CACA_RISCO_MAXIMO: '0.8', CACA_LIMITE_GAS: '1200000' }),
    };
    const premioDaBaleia = new Decimal('1985.95');

    // A pergunta do CENSO: a baleia NÃO entra. É isto que sustenta a decisão do
    // gás registrada no CLAUDE.md.
    const censo = faixaQueAtira({ ...ambiente, tiroDeProva: false })!;
    assert.ok(censo.ate !== null, 'a faixa sustentável TEM teto');
    assert.ok(premioDaBaleia.greaterThan(censo.ate!), 'e a baleia está acima dele');

    // A pergunta do TIRO: a baleia entra, porque ela pediu um alvo custe o que custar.
    assert.equal(faixaQueAtira({ ...ambiente, tiroDeProva: true })!.ate, null);
    assert.equal(decidirTiro({ ...ambiente, tiroDeProva: true, lucroUsd: premioDaBaleia }).atira, true);
});
