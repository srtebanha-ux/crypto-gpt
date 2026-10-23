// Arquivo: src/tetoDaCarteira.test.ts
//
// A INVARIANTE DO BOLSO, pedida por ela em 2026-10-02:
//
//     "o suborno exigido vai ultrapassar o saldo atual, o que fará a transação
//      falhar na rede por fundos insuficientes"
//
// Medido no mesmo dia com o saldo real (0,0158 ETH): o medo não se realiza. O
// teto da carteira (`maxFeeQueOSaldoAdianta`) corta ANTES — num prêmio de
// US$ 1.986 a política quer 50 gwei e a carteira entrega 11,845, com 0,014220
// ETH adiantados de 0,015800. E quando nem o básico cabe, `decidirTiro` recusa
// com "o gás adiantado não cabe no saldo" em vez de mandar.
//
// Então por que este arquivo existe, se nada estava quebrado?
//
// Porque a garantia era IMPLÍCITA, e neste projeto garantia implícita já quebrou
// cinco vezes na mesma semana — sempre do mesmo jeito: alguém muda o mecanismo e
// não vai reler quem dependia dele. Três botões independentes decidem o
// adiantado (`TETO_DA_GORJETA_WEI`, a folga de `maxFeeQueOSaldoAdianta` e o
// limite de gás dinâmico de `limiteDeGasDoTiro`), e qualquer um deles mexido
// para cima rompe a conta sem que nenhum teste existente reclame.
//
// O que a rede exige, e é aritmética do nó, não opinião:
//
//     saldo >= gasLimit x maxFeePerGas        (congelado no ato, devolvido depois)
//     maxFeePerGas >= baseFeePerGas           (senão nem entra no bloco)
//     maxPriorityFeePerGas <= maxFee - baseFee
//
// Estes testes varrem a grade de saldos, baseFees, prêmios e limites de gás e
// afirmam: SE `atira` é true, as três valem. Um tiro que a rede recusa não é
// tiro — é a liquidação perdida com o log dizendo que atirou.
import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { decidirTiro, politicaDoTiro, maxFeeQueOSaldoAdianta, adiantadoExigido } from './prontidao';

const ETH = new Decimal(4200);

/** O saldo dela em 2026-10-02, e os vizinhos que importam. */
const SALDOS: Array<[string, bigint]> = [
    ['0,0158 ETH (o dela)', 15_800_000_000_000_000n],
    ['0,0033 ETH (o de antes)', 3_341_000_000_000_000n],
    ['0,0005 ETH (quase seco)', 500_000_000_000_000n],
    ['0,00002 ETH (seco)', 20_000_000_000_000n],
    ['1 wei', 1n],
    ['zero', 0n],
];
/** baseFee medido na Base: costuma viver abaixo de 0,01 gwei e salta em pico. */
const BASES: bigint[] = [1n, 5_000_000n, 50_000_000n, 500_000_000n, 5_000_000_000n, 50_000_000_000n];
/** Os prêmios que o censo e a fila real produziram, incluindo o de US$ 1.986. */
const PREMIOS = [0.05, 0.5, 20, 105, 288, 1986, 50_000];
/** O limite de gás é DINÂMICO desde 2026-10-01: a grade cobre a faixa dele. */
const GASES: bigint[] = [700_000n, 900_000n, 1_200_000n, 3_000_000n];

function decidir(saldo: bigint, base: bigint, premio: number, limiteGas: bigint, prova: boolean) {
    return decidirTiro({
        lucroUsd: new Decimal(premio),
        precoDoEthUsd: ETH,
        saldoWei: saldo,
        baseFeeWei: base,
        ...politicaDoTiro(),
        limiteGas,
        perdasSeguidas: 0,
        tiroDeProva: prova,
    });
}

test('INVARIANTE: todo tiro que SAI é um tiro que a rede aceita', () => {
    let atiraram = 0;
    let recusaram = 0;
    for (const [nomeSaldo, saldo] of SALDOS) {
        for (const base of BASES) {
            for (const premio of PREMIOS) {
                for (const limiteGas of GASES) {
                    for (const prova of [false, true]) {
                        const d = decidir(saldo, base, premio, limiteGas, prova);
                        if (!d.atira) { recusaram += 1; continue; }
                        atiraram += 1;
                        const onde = `saldo ${nomeSaldo}, base ${Number(base) / 1e9}gwei, `
                            + `prêmio US$ ${premio}, gás ${limiteGas}, prova ${prova}`;
                        // 1. O nó CONGELA gasLimit x maxFee no ato. É esta a conta
                        //    que devolve `insufficient funds`, e não o que a
                        //    transação acaba gastando.
                        const adiantado = adiantadoExigido(limiteGas, d.maxFeeWei);
                        assert.ok(
                            adiantado <= saldo,
                            `${onde}: adiantado ${adiantado} > saldo ${saldo} — a rede recusaria por fundos`,
                        );
                        // 2. maxFee abaixo do baseFee nem entra no bloco. Era o
                        //    caminho sutil: a carteira corta o maxFee para o que
                        //    cabe, e se o que cabe for menor que o base, o corte
                        //    produz uma transação impossível em vez de uma recusa.
                        assert.ok(
                            d.maxFeeWei >= base,
                            `${onde}: maxFee ${d.maxFeeWei} < baseFee ${base} — a rede nem aceitaria`,
                        );
                        // 3. A gorjeta não pode passar do espaço que sobra.
                        assert.ok(
                            d.prioridadeWei <= d.maxFeeWei - base,
                            `${onde}: gorjeta ${d.prioridadeWei} acima de maxFee - baseFee`,
                        );
                        // 4. E uma derrota tem de ser pagável: gorjeta é cobrada
                        //    mesmo perdendo a corrida.
                        assert.ok(
                            d.custoSePerderWei <= saldo,
                            `${onde}: uma derrota custa ${d.custoSePerderWei} e o saldo é ${saldo}`,
                        );
                    }
                }
            }
        }
    }
    // Sem isto o teste passaria vazio se um dia tudo começasse a recusar — e
    // "nenhum tiro sai" é exatamente o defeito que ele não veria.
    assert.ok(atiraram > 50, `só ${atiraram} combinações atiraram; o teste não exercitou nada`);
    assert.ok(recusaram > 50, `só ${recusaram} recusaram; a grade não cobre o lado seco`);
});

test('saldo zero não atira, e o motivo é o saldo — não o alvo', () => {
    // Culpar o alvo com a carteira vazia já aconteceu aqui: o bot pareceria sem
    // oportunidade tendo oportunidade.
    for (const premio of [0.5, 105, 1986]) {
        const d = decidir(0n, 5_000_000n, premio, 1_200_000n, false);
        assert.equal(d.atira, false);
        assert.match(d.porque, /saldo|gás|gas/i, d.porque);
    }
});

test('o teto da carteira é o que corta os 40%, e não o teto de 50 gwei', () => {
    // MEDIDO: com 0,0158 ETH e gás de 1,2M, a carteira entrega 11,85 gwei. A
    // política queria 50 (teto) num prêmio de US$ 1.986. Ou seja: quem limita é
    // o bolso, exatamente como ela pediu — e o número não é escolhido, ele SAI
    // do saldo.
    const saldo = 15_800_000_000_000_000n;
    const teto = maxFeeQueOSaldoAdianta(saldo, 1_200_000n);
    assert.equal(Number(teto) / 1e9, 11.85);
    const d = decidir(saldo, 5_000_000n, 1986, 1_200_000n, false);
    assert.equal(d.atira, true);
    assert.ok(d.desejadaWei > d.prioridadeWei, 'queria mais do que o bolso deu');
    assert.ok(d.maxFeeWei <= teto, 'o maxFee respeita o teto da carteira');
});

test('o teto da carteira CAI quando o limite de gás sobe — e o tiro continua válido', () => {
    // O limite de gás virou dinâmico em 2026-10-01 (`eth_estimateGas` + folga).
    // Isso move o teto da carteira sem ninguém pedir: mais gás congelado é menos
    // gwei por unidade. Se a conta não acompanhasse, um alvo caro de gás viraria
    // `insufficient funds`.
    const saldo = 15_800_000_000_000_000n;
    const base = 5_000_000n;
    let anterior = Number.POSITIVE_INFINITY;
    for (const gas of GASES) {
        const d = decidir(saldo, base, 1986, gas, false);
        const teto = Number(maxFeeQueOSaldoAdianta(saldo, gas)) / 1e9;
        assert.ok(teto < anterior, `gás ${gas}: o teto ${teto} não caiu`);
        anterior = teto;
        if (d.atira) {
            assert.ok(adiantadoExigido(gas, d.maxFeeWei) <= saldo, `gás ${gas}: adiantado passou do saldo`);
        }
    }
});

test('baseFee em pico não produz tiro impossível: recusa, não transação torta', () => {
    // 50 gwei de baseFee com 0,0005 ETH: o teto da carteira fica em 0,375 gwei,
    // muito abaixo do base. O corte produziria maxFee < baseFee — a transação
    // que a rede rejeita. Tem de recusar.
    const d = decidir(500_000_000_000_000n, 50_000_000_000n, 1986, 1_200_000n, false);
    assert.equal(d.atira, false);
    assert.match(d.porque, /não cabe no saldo/);
});
