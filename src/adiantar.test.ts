import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    precoDeQueda, quemCaiPrimeiro, jaCairamNoMercado, desvioDoOraculo,
    qualPostura, ritmoDaPostura, custoDaVigiliaEmCUs, DESVIO_TIPICO_PCT,
    atirarNaEscritaIminente, SALTO_P50_PCT, SALTO_P90_PCT, SALTO_MAX_PCT, APOSTA_MINIMA_USD,
} from './adiantar';

const D = (n: number | string) => new Decimal(n);
const ETH = D(2646.93); // o preço que o oráculo mostrava hoje

test('queda de 1% vira um preço 1% abaixo', () => {
    assert.equal(precoDeQueda(D(1000), D(1)).toFixed(2), '990.00');
});

test('quem já está caído não tem preço de queda no futuro', () => {
    assert.equal(precoDeQueda(D(1000), D(0)).toNumber(), 1000);
});

test('a fila sai ordenada por PREÇO ALVO, quem cai primeiro na frente', () => {
    // Menor queda necessária = preço alvo mais alto = cai primeiro.
    const fila = quemCaiPrimeiro([
        { devedor: '0xlonge', quedaPct: D(14.6) },
        { devedor: '0xperto', quedaPct: D(0.04) },
        { devedor: '0xmeio', quedaPct: D(3) },
    ], ETH);
    assert.deepEqual(fila.map((g) => g.devedor), ['0xperto', '0xmeio', '0xlonge']);
    assert.ok(fila[0].precoAlvo.greaterThan(fila[1].precoAlvo));
});

test('o mercado derruba antes do oráculo saber', () => {
    // A posição mais frágil de hoje: 0,04% de margem.
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(0.04) }], ETH);
    const alvo = fila[0].precoAlvo; // ~2645,87
    // Oráculo ainda diz 2646,93. Mercado já está abaixo do alvo.
    assert.equal(jaCairamNoMercado(fila, alvo.minus(1)).length, 1);
    assert.equal(jaCairamNoMercado(fila, alvo.plus(1)).length, 0);
});

test('o desvio mede o quanto a blockchain está desatualizada', () => {
    // Mercado 0,5% abaixo do que está escrito on-chain.
    const mercado = ETH.mul(0.995);
    assert.equal(desvioDoOraculo(mercado, ETH).toFixed(2), '0.50');
    // Mercado SUBINDO dá desvio negativo, e não aciona nada.
    assert.ok(desvioDoOraculo(ETH.mul(1.01), ETH).lessThan(0));
});

test('preço parado = dormindo, e dormindo é o ritmo barato', () => {
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(14.6) }], ETH);
    assert.equal(qualPostura(ETH, ETH, fila), 'dormindo');
    assert.equal(ritmoDaPostura('dormindo', 8000), 8000);
});

test('mercado andou meio por cento mas ninguém cai = atento', () => {
    // Ninguém está perto: a fila mais frágil precisa de 14,6%.
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(14.6) }], ETH);
    const mercado = ETH.mul(0.994); // 0,6% abaixo
    assert.equal(qualPostura(mercado, ETH, fila), 'atento');
    assert.equal(ritmoDaPostura('atento', 8000), 1000);
});

test('mercado já derrubou alguém = DEDO NO GATILHO, mesmo com desvio pequeno', () => {
    // Este é o caso que a estratégia inteira existe para pegar: uma queda
    // minúscula, longe de acionar o feed por desvio, que mesmo assim já
    // derruba quem estava a 0,04% de cair.
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(0.04) }], ETH);
    // METADE do limiar medido, e derivado dele de propósito: o limiar é um
    // número MEDIDO, e número medido tem data de validade. Em 2026-10-06 ele
    // caiu de 0,5 (palpite) para 0,10 (medido nos eventos do agregador), e este
    // teste quebrou por ter o 0,1% cravado. Amarrado à constante, ele passa a
    // afirmar a REGRA em vez do número.
    const mercado = ETH.mul(1 - DESVIO_TIPICO_PCT.toNumber() / 200);
    assert.ok(desvioDoOraculo(mercado, ETH).lessThan(DESVIO_TIPICO_PCT));
    assert.equal(qualPostura(mercado, ETH, fila), 'dedo no gatilho');
    assert.equal(ritmoDaPostura('dedo no gatilho', 8000), 200);
});

test('gatilho tem precedência sobre atento', () => {
    const fila = quemCaiPrimeiro([{ devedor: '0xa', quedaPct: D(0.04) }], ETH);
    // Mercado despencou 2%: aciona os dois critérios, e o urgente ganha.
    assert.equal(qualPostura(ETH.mul(0.98), ETH, fila), 'dedo no gatilho');
});

test('fila vazia nunca vira dedo no gatilho', () => {
    // Sem ninguém para cair, correr não adianta e só gastaria CU.
    assert.equal(qualPostura(ETH.mul(0.5), ETH, []), 'atento');
});

test('viver assim cabe no orçamento, porque os segundos caros são raros', () => {
    // Teto da conta: 38,1M CU/mês. O ciclo normal já usa ~9M.
    const vigilia = custoDaVigiliaEmCUs({
        cuPorLeitura: 26,
        minutosAtentoPorDia: 60,
        minutosNoGatilhoPorDia: 10,
    });
    assert.ok(vigilia < 10_000_000, `vigília custaria ${vigilia.toLocaleString('pt-BR')} CU/mês`);
});

test('ficar com o dedo no gatilho o DIA INTEIRO não caberia', () => {
    // Guarda a razão de existir das três posturas: o ritmo rápido só é
    // pagável enquanto for raro.
    const sempre = custoDaVigiliaEmCUs({
        cuPorLeitura: 26,
        minutosAtentoPorDia: 0,
        minutosNoGatilhoPorDia: 1440,
    });
    assert.ok(sempre > 38_095_238, `daria ${sempre} CU/mês`);
});

// ---------------------------------------------------------------------------
// A regra corrigida: o feed precisa ESCREVER, e a escrita precisa DERRUBAR.
// ---------------------------------------------------------------------------
import { posturaPorMargem } from './adiantar';

test('queda pequena NÃO vira dedo no gatilho, mesmo derrubando alguém no papel', () => {
    // O erro que esta função existe para corrigir. Alguém a 0,04% de cair e um
    // mercado que caiu MENOS que o limiar de escrita: o preço on-chain não se
    // move, ninguém fica liquidável, e correr a 200ms gastaria CU para nada.
    //
    // A queda de prova é metade do limiar, derivada dele — com 0,1% cravado
    // este teste passou a falhar quando a MEDIÇÃO de 2026-10-06 mostrou que
    // 0,1% JÁ faz o feed escrever (limiar real 0,103% no cbBTC).
    const metade = DESVIO_TIPICO_PCT.dividedBy(2);
    assert.equal(posturaPorMargem(metade, D(0.04)), 'dormindo');
});

test('queda que faz o feed escrever E derruba alguém = dedo no gatilho', () => {
    assert.equal(posturaPorMargem(D(0.6), D(0.04)), 'dedo no gatilho');
});

test('queda que faz o feed escrever mas não derruba ninguém = atento', () => {
    // O feed vai escrever, mas o mais frágil está a 3% e a queda é de 0,6%.
    assert.equal(posturaPorMargem(D(0.6), D(3)), 'atento');
});

test('chegando perto do limiar já aperta o passo', () => {
    // A faixa do 'atento' é [limiar x 0.6, limiar). Escrita relativa, porque é
    // o limiar que muda quando alguém o mede de novo.
    const limiar = DESVIO_TIPICO_PCT.toNumber();
    assert.equal(posturaPorMargem(D(limiar * 0.8), D(0.04)), 'atento');
    assert.equal(posturaPorMargem(D(limiar * 0.5), D(0.04)), 'dormindo');
});

test('sem ninguém na brasa nunca vira dedo no gatilho', () => {
    // Correr sem alvo é só gastar.
    assert.equal(posturaPorMargem(D(5), null), 'atento');
});

test('o estado caro se limita sozinho', () => {
    // Enquanto o desvio não chega ao limiar, não se corre. Quando chega, o
    // feed escreve em segundos e a corrida acaba. É isso que impede o ritmo
    // de 200ms de virar o ritmo do dia inteiro.
    const limiar = DESVIO_TIPICO_PCT.toNumber();
    assert.equal(posturaPorMargem(D(limiar * 0.98), D(0.01)), 'atento');
    assert.equal(posturaPorMargem(D(limiar), D(0.01)), 'dedo no gatilho');
});

// ---------------------------------------------------------------------------
// Dormir de olho aberto: olhar o mercado custa zero, ler a blockchain não.
// ---------------------------------------------------------------------------
import { dormirDeOlho } from './adiantar';

test('dorme em fatias e olha entre elas', async () => {
    const dormiu: number[] = [];
    let olhadas = 0;
    const acordouCedo = await dormirDeOlho(
        8000, 1000,
        async () => { olhadas += 1; return false; },
        async (ms) => { dormiu.push(ms); },
    );
    assert.equal(acordouCedo, false);
    assert.equal(dormiu.reduce((a, b) => a + b, 0), 8000, 'o sono total tem que ser o pedido');
    assert.equal(dormiu.length, 8);
    // Olha entre as fatias, não depois da última — olhar e já sair é desperdício.
    assert.equal(olhadas, 7);
});

test('acorda na hora quando o mercado muda no meio do sono', async () => {
    // O ponto inteiro: sem isto, uma queda no segundo 1 só seria vista no
    // segundo 8, e a liquidação já teria ido embora.
    const dormiu: number[] = [];
    let olhadas = 0;
    const acordouCedo = await dormirDeOlho(
        8000, 1000,
        async () => { olhadas += 1; return olhadas >= 2; },
        async (ms) => { dormiu.push(ms); },
    );
    assert.equal(acordouCedo, true);
    assert.equal(dormiu.reduce((a, b) => a + b, 0), 2000, 'acordou no segundo 2, não no 8');
});

test('sono curto não vira olhadas desnecessárias', async () => {
    // Com o dedo no gatilho o sono é de 200ms: fatiar isso só gastaria
    // chamadas à Binance sem ganhar reação nenhuma.
    let olhadas = 0;
    const dormiu: number[] = [];
    await dormirDeOlho(200, 1000, async () => { olhadas += 1; return false; }, async (ms) => { dormiu.push(ms); });
    assert.equal(olhadas, 0);
    assert.deepEqual(dormiu, [200]);
});

test('sono zero ou negativo não dorme nem olha', async () => {
    let chamou = 0;
    await dormirDeOlho(0, 1000, async () => { chamou += 1; return false; }, async () => { chamou += 1; });
    assert.equal(chamou, 0);
});

// ---------------------------------------------------------------------------
// Chegar pronto: a Aave não deixa arrematar antes, mas deixa chegar armado.
// ---------------------------------------------------------------------------
import { quemArmar, valeArmar } from './adiantar';

test('arma os mais frágeis, que são os primeiros da lista ordenada', () => {
    const brasa = ['0xa', '0xb', '0xc', '0xd'];
    assert.deepEqual(quemArmar(brasa, 2), ['0xa', '0xb']);
});

test('armar zero ou menos não arma ninguém', () => {
    assert.deepEqual(quemArmar(['0xa'], 0), []);
    assert.deepEqual(quemArmar(['0xa'], -1), []);
});

test('pedir mais do que existe não quebra', () => {
    assert.deepEqual(quemArmar(['0xa'], 99), ['0xa']);
});

test('dormindo NÃO arma: seria leitura a toa a cada balanço do mercado', () => {
    assert.equal(valeArmar('dormindo', 999_999, 5000), false);
});

test('arma quando o feed está perto de escrever e o que tem já envelheceu', () => {
    assert.equal(valeArmar('atento', 6000, 5000), true);
    assert.equal(valeArmar('dedo no gatilho', 6000, 5000), true);
});

test('não rearma o que ainda está fresco', () => {
    // Rearmar a cada ciclo do gatilho (200ms) gastaria uma leitura por ciclo
    // justamente no momento mais caro.
    assert.equal(valeArmar('dedo no gatilho', 100, 5000), false);
});

// ===========================================================================
// ATIRAR NA ESCRITA IMINENTE — a rota que a autopsia de 2026-10-07 justificou.
// ===========================================================================

test('o ALVO REAL de 2026-10-07 teria sido atirado', () => {
    // Os numeros crus, medidos na corrente:
    //   bloco 52289906  HF 1.00184180  falta cair 0,1838%
    //   bloco 52289907  LIQUIDADA (transacao 6 de 537), premio US$ 49,33
    //   o log do bot, no bloco 52289902: mercado 0,3899% abaixo do oraculo
    // O bot tinha TODA a informacao e nenhuma regra que a ligasse ao tiro.
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.3899'),
        quedaDoAlvoPct: new Decimal('0.1838'),
        precoCancela: false,
        ligada: true,
        premioUsd: new Decimal('47.12'), // o que `lucroEstimado` dá para aquela dívida
    });
    assert.equal(r.atira, true, r.porque);
    assert.ok(r.porque.includes('0.1838'), r.porque);
});

test('alvo longe demais para a escrita fechar NAO e atirado', () => {
    // O CLAUDE.md ja avisa: o oraculo persegue o mercado dentro de 0,10-0,15%,
    // entao antecipar compra ~0,15% de dianteira, nao 1%. Um alvo a 0,99% nao
    // e alcancavel por antecipacao, e atirar nele e gas perdido.
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.3899'),
        quedaDoAlvoPct: new Decimal('0.99'),
        ligada: true,
        premioUsd: new Decimal('47.12'),
    });
    assert.equal(r.atira, false);
    assert.ok(r.porque.includes('fecha no máximo'), r.porque);
});

test('a escrita NAO pode fechar mais do que o mercado andou', () => {
    // Alvo a 0,20% com o mercado so 0,12% abaixo: a escrita persegue o
    // mercado, nao o ultrapassa — ela nao tem de onde tirar os 0,20%.
    // Usar so o salto p90 (0,2216%) deixaria este tiro passar.
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.12'),
        quedaDoAlvoPct: new Decimal('0.20'),
        ligada: true,
        premioUsd: new Decimal('47.12'),
    });
    assert.equal(r.atira, false, r.porque);
    assert.ok(r.porque.includes('mercado 0.1200%'), r.porque);
});

test('sem escrita iminente nao se atira', () => {
    // Mercado 0,05% abaixo: abaixo do limiar medido de 0,10%. Nao ha escrita
    // para pegar carona, ainda que o alvo esteja colado.
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.05'),
        quedaDoAlvoPct: new Decimal('0.01'),
        ligada: true,
        premioUsd: new Decimal('47.12'),
    });
    assert.equal(r.atira, false);
    assert.ok(r.porque.includes('não há escrita iminente'), r.porque);
});

test('IMUNE a preco nunca e atirado, por perto que esteja', () => {
    // Par de mesma moeda/familia: o preco se cancela na conta da saude. Aqui
    // o gas e perda CERTA, nao aposta — e sao 21.678 dos 57.811 devedores.
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('1.5'),
        quedaDoAlvoPct: new Decimal('0.0001'),
        precoCancela: true,
        ligada: true,
        premioUsd: new Decimal('47.12'),
    });
    assert.equal(r.atira, false);
    assert.ok(r.porque.includes('imune a preço'), r.porque);
});

test('sem cotacao de mercado nao se atira: ausencia nao e oportunidade', () => {
    // `quedaDoMercado` devolve null quando a Binance nao responde, e o
    // CLAUDE.md registra que "mercado calmo" e "Binance morta" davam o mesmo
    // log. Aqui a diferenca e dinheiro.
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: null,
        quedaDoAlvoPct: new Decimal('0.01'),
        ligada: true,
        premioUsd: new Decimal('47.12'),
    });
    assert.equal(r.atira, false);
    assert.ok(r.porque.includes('não sei'), r.porque);
});

test('a chave desliga, porque o tiro gasta gas quando erra', () => {
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.3899'),
        quedaDoAlvoPct: new Decimal('0.1838'),
        ligada: false,
        premioUsd: new Decimal('47.12'),
    });
    assert.equal(r.atira, false);
    assert.ok(r.porque.includes('CACA_ATIRAR_NA_ESCRITA=0'), r.porque);
});

test('os saltos medidos sao constantes de codigo, nao de comentario', () => {
    // Eles viviam APENAS na docstring de DESVIO_TIPICO_PCT, o que os tornava
    // inutilizaveis — e por isso a regra de antecipacao nunca pode existir.
    assert.equal(SALTO_P50_PCT.toFixed(4), '0.1603');
    assert.equal(SALTO_P90_PCT.toFixed(4), '0.2216');
    // E a ordem tem de valer: p50 < p90 < max.
    assert.ok(SALTO_P50_PCT.lessThan(SALTO_P90_PCT));
    assert.ok(SALTO_P90_PCT.lessThan(SALTO_MAX_PCT));
    // E o limiar de escrita e MENOR que o salto tipico: o oraculo escreve
    // quando o desvio passa de 0,151% e anda 0,16% no p50.
    assert.ok(DESVIO_TIPICO_PCT.lessThan(SALTO_P50_PCT));
});


test('a aposta NAO se paga em premio pequeno — e e aritmetica, nao cautela', () => {
    // MEDIDO em 2026-10-07: 7 apostas, 0 acertos, US$ 2,10 gastos. O oráculo
    // escreve 121,7 vezes/dia e a Base faz 43.200 blocos/dia, então a chance
    // CEGA de a transação cair no bloco de uma escrita é 1/355 = 0,282%. Com
    // US$ 0,30 por errada, um prêmio de US$ 1,80 exigiria 14,3% de acerto —
    // 51x o acaso. O bot apostou quatro vezes seguidas nesse prêmio.
    const base = {
        mercadoCaiuPct: new Decimal('0.3899'),
        quedaDoAlvoPct: new Decimal('0.1460'),
        ligada: true as const,
    };
    const migalha = atirarNaEscritaIminente({ ...base, premioUsd: new Decimal('1.80') });
    assert.equal(migalha.atira, false, migalha.porque);
    assert.ok(migalha.porque.includes('aritmética'), migalha.porque);

    // E o alvo que valia a pena — o de 2026-10-07, US$ 49,33 bruto — passa.
    const bom = atirarNaEscritaIminente({ ...base, premioUsd: new Decimal('47.12') });
    assert.equal(bom.atira, true, bom.porque);
});

test('sem saber o premio NAO se aposta: ausencia nao e autorizacao', () => {
    for (const premio of [undefined, null, new Decimal(Number.NaN)]) {
        const r = atirarNaEscritaIminente({
            mercadoCaiuPct: new Decimal('0.3899'),
            quedaDoAlvoPct: new Decimal('0.1460'),
            ligada: true,
            premioUsd: premio,
        });
        assert.equal(r.atira, false, `${premio}`);
        assert.ok(r.porque.includes('Ausência não é autorização'), r.porque);
    }
});

test('o piso pode ser desligado, e ai volta ao comportamento de antes', () => {
    // `CACA_APOSTA_MINIMA_USD=0` libera qualquer prêmio. A escolha é dela.
    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.3899'),
        quedaDoAlvoPct: new Decimal('0.1460'),
        ligada: true,
        premioUsd: new Decimal('1.80'),
        premioMinimoUsd: new Decimal(0),
    });
    assert.equal(r.atira, true, r.porque);
});

test('o piso medido exige que a aposta seja melhor que o acaso, nao igual', () => {
    // A tabela que justifica o número, e ela está na docstring:
    //   premio US$ 1,80 -> 14,3% (51x o acaso)   US$ 20 -> 1,5% (5x)
    // US$ 20 é escolha, não medição — a taxa real não está medida. O teste
    // guarda a ORDEM de grandeza, para a próxima sessão não baixar sem medir.
    assert.ok(APOSTA_MINIMA_USD.greaterThanOrEqualTo(5),
        'abaixo de US$ 5 a aposta precisa acertar mais de 5,7% — 20x o acaso cego');
    // E O LIMITE DE CIMA, que me pegou: em 2026-10-08, com 18,7 horas de
    // placar, a ÚNICA oportunidade real da janela rendia US$ 11,59. Um piso de
    // US$ 20 a recusou — barrou a única chance do dia. Piso acima de US$ 11,59
    // desliga a estratégia com outro nome.
    assert.ok(APOSTA_MINIMA_USD.lessThanOrEqualTo(new Decimal('11.59')),
        'o piso não pode barrar a oportunidade real medida em 2026-10-08 (US$ 11,59)');
    assert.ok(APOSTA_MINIMA_USD.lessThanOrEqualTo(106),
        'US$ 106 é onde a aposta se paga no acaso cego; acima disso o piso é pessimista demais');
});
