// Arquivo: src/leadLag.test.ts
//
// O que estes testes protegem é a diferença entre um detector que dispara no
// evento certo e um que dispara em ruído. Cada falso positivo custa um spread
// de entrada e um de saída — e num sistema que busca movimentos de décimos de
// por cento, dez falsos positivos apagam o ganho de um acerto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DetectorDeRajada,
    EstatisticaDeAtraso,
    direcaoDaLiquidacao,
    liquidacaoRelevante,
    medirJanela,
    movimentoAFavor,
    valeSeguirOEvento,
    type NegocioDeFuturos,
} from './leadLag';

const negocio = (tsMs: number, preco: number, quantidade: number, venda: boolean): NegocioDeFuturos => ({
    tsMs,
    preco,
    quantidade,
    compradorPassivo: venda,
});

const detectorPadrao = () =>
    new DetectorDeRajada({
        janelaMs: 500,
        volumeMinimo: 100_000,
        unanimidadeMinima: 0.8,
        silencioMs: 2000,
    });

test('rajada unânime e grande dentro da janela dispara', () => {
    const d = detectorPadrao();
    // O evento sai na PRIMEIRA chamada que cruza o limiar, não na última: a
    // partir dali o silêncio bloqueia o resto da mesma rajada. Guardar só o
    // retorno da última chamada leria justamente o null do silêncio.
    let evento = null;
    for (let i = 0; i < 5 && !evento; i += 1) {
        evento = d.registrar(negocio(1000 + i * 80, 100_000, 0.3, false));
    }
    assert.ok(evento);
    assert.equal(evento!.direcao, 'alta');
    assert.equal(evento!.unanimidade, 1);
    assert.ok(evento!.volumeNocional >= 100_000);
});

test('volume grande mas DIVIDIDO não dispara — o outro lado absorveu', () => {
    // O falso positivo mais caro: negócio grande com contraparte à altura não
    // move preço. Só volume, sem direção, é ruído com aparência de sinal.
    const d = detectorPadrao();
    let evento = null;
    for (let i = 0; i < 6; i += 1) {
        evento = d.registrar(negocio(1000 + i * 50, 100_000, 0.3, i % 2 === 0));
    }
    assert.equal(evento, null);
});

test('sequência unânime de negócios MINÚSCULOS não dispara', () => {
    const d = detectorPadrao();
    let evento = null;
    for (let i = 0; i < 20; i += 1) {
        evento = d.registrar(negocio(1000 + i * 20, 100_000, 0.001, false));
    }
    assert.equal(evento, null, 'unanimidade sem volume não é evento');
});

test('volume grande ESPALHADO no tempo não dispara', () => {
    // A janela é temporal: $150k em 10 minutos é fluxo normal, não rajada.
    const d = detectorPadrao();
    let evento = null;
    for (let i = 0; i < 5; i += 1) {
        evento = d.registrar(negocio(1000 + i * 100_000, 100_000, 0.3, false));
    }
    assert.equal(evento, null);
});

test('o silêncio impede a MESMA cascata de disparar dezenas de vezes', () => {
    // Sem isto, uma cascata de 3 segundos vira dezenas de entradas na mesma
    // distorção, pagando spread em cada uma.
    const d = detectorPadrao();
    let primeiro = null;
    for (let i = 0; i < 5 && !primeiro; i += 1) primeiro = d.registrar(negocio(1000 + i * 80, 100_000, 0.3, false));
    assert.ok(primeiro);

    let durante = null;
    for (let i = 0; i < 5; i += 1) durante = d.registrar(negocio(1500 + i * 80, 100_100, 0.3, false));
    assert.equal(durante, null, 'dentro do silêncio, nada dispara');

    let depois = null;
    for (let i = 0; i < 5 && !depois; i += 1) depois = d.registrar(negocio(4000 + i * 80, 100_200, 0.3, false));
    assert.ok(depois, 'passado o silêncio, volta a valer');
});

test('venda agressiva vira evento de BAIXA', () => {
    const d = detectorPadrao();
    let evento = null;
    for (let i = 0; i < 5 && !evento; i += 1) evento = d.registrar(negocio(1000 + i * 80, 100_000, 0.3, true));
    assert.ok(evento);
    assert.equal(evento!.direcao, 'baixa');
});

test('o buffer circular não cresce e mantém a janela correta', () => {
    // Capacidade pequena de propósito: o que sai da janela temporal não pode
    // influenciar nada, e encher o buffer não pode quebrar a conta.
    const d = new DetectorDeRajada({
        janelaMs: 200,
        volumeMinimo: 100_000,
        unanimidadeMinima: 0.8,
        silencioMs: 0,
        capacidade: 64,
    });
    // 500 negócios pequenos e antigos, depois a rajada de verdade.
    for (let i = 0; i < 500; i += 1) d.registrar(negocio(i, 100_000, 0.0001, i % 2 === 0));
    let evento = null;
    for (let i = 0; i < 5 && !evento; i += 1) evento = d.registrar(negocio(10_000 + i * 30, 100_000, 0.3, false));
    assert.ok(evento, 'a rajada nova dispara apesar do histórico antigo');
    assert.ok(evento!.unanimidade > 0.99, 'o lixo antigo não entra na conta');
});

// ---------------------------------------------------------------------------
// A medição do atraso
// ---------------------------------------------------------------------------

test('movimento a favor tem SINAL relativo à direção prevista', () => {
    // Registrar o movimento bruto perderia a informação que interessa: acerto
    // de direção, não tamanho.
    assert.ok(movimentoAFavor({ precoAntes: 100, precoDepois: 101, direcao: 'alta' }) > 0);
    assert.ok(movimentoAFavor({ precoAntes: 100, precoDepois: 101, direcao: 'baixa' }) < 0);
    assert.ok(movimentoAFavor({ precoAntes: 100, precoDepois: 99, direcao: 'baixa' }) > 0);
});

test('preço zero não produz divisão por zero', () => {
    assert.equal(movimentoAFavor({ precoAntes: 0, precoDepois: 100, direcao: 'alta' }), 0);
});

test('a estatística mostra média E mediana, porque uma sozinha mente', () => {
    // Um único evento gigante levanta a média e cria a ilusão de um efeito que
    // não se repete. Quando média e mediana discordam muito, o que existe é um
    // outlier, não uma vantagem.
    const est = new EstatisticaDeAtraso();
    for (let i = 0; i < 9; i += 1) est.registrar({ apossMs: 100, aFavor: 0.0001 });
    est.registrar({ apossMs: 100, aFavor: 0.05 });

    const [r] = est.resumo();
    assert.equal(r.amostras, 10);
    assert.ok(r.media > 0.005, 'a média é dominada pelo outlier');
    assert.ok(r.mediana < 0.0002, 'a mediana revela que o típico é irrelevante');
    assert.equal(r.acertosDeDirecao, 1);
});

test('o resumo sai ordenado por horizonte', () => {
    const est = new EstatisticaDeAtraso();
    est.registrar({ apossMs: 500, aFavor: 0.001 });
    est.registrar({ apossMs: 50, aFavor: 0.001 });
    est.registrar({ apossMs: 200, aFavor: 0.001 });
    assert.deepEqual(est.resumo().map((r) => r.apossMs), [50, 200, 500]);
});

// ---------------------------------------------------------------------------
// A guarda de custo
// ---------------------------------------------------------------------------

test('sinal que acerta a direção ainda é recusado se não cobrir o spread', () => {
    // A equação não desaparece por o sinal vir de outro mercado.
    const v = valeSeguirOEvento({
        movimentoEsperado: 0.0002,
        spreadSpot: 0.0003,
        taxaPorPerna: 0,
    });
    assert.equal(v.vale, false);
    assert.ok(v.margem < 0);
});

test('com taxa zero e spread apertado, um movimento pequeno já paga', () => {
    const v = valeSeguirOEvento({
        movimentoEsperado: 0.003,
        spreadSpot: 0.00002,
        taxaPorPerna: 0,
    });
    assert.equal(v.vale, true);
});

test('a mesma operação com taxa cheia é recusada — é a taxa que decide', () => {
    const comum = { movimentoEsperado: 0.0015, spreadSpot: 0.00002 };
    assert.equal(valeSeguirOEvento({ ...comum, taxaPorPerna: 0 }).vale, true);
    assert.equal(valeSeguirOEvento({ ...comum, taxaPorPerna: 0.00075 }).vale, false);
});

// ---------------------------------------------------------------------------
// Liquidações e a medição T0 → T1 → T2
// ---------------------------------------------------------------------------

test('liquidação de POSIÇÃO COMPRADA gera ordem de VENDA e empurra o preço para BAIXO', () => {
    // A inversão mais perigosa deste módulo. Quem estava comprado e quebrou
    // gera uma ordem de VENDA no livro. Ler o lado como se fosse o da posição
    // inverteria a direção de toda operação — erro que não estoura, só perde
    // dinheiro de forma consistente.
    assert.equal(
        direcaoDaLiquidacao({ tsMs: 1, symbol: 'BTCUSDT', lado: 'SELL', preco: 100_000, quantidade: 5 }),
        'baixa',
    );
    assert.equal(
        direcaoDaLiquidacao({ tsMs: 1, symbol: 'BTCUSDT', lado: 'BUY', preco: 100_000, quantidade: 5 }),
        'alta',
    );
});

test('a relevância é medida em NOCIONAL, não em quantidade', () => {
    // 10 BTC e 10 DOGE não são o mesmo evento. Usar quantidade faria o
    // detector disparar em toda moeda barata.
    const btc = { tsMs: 1, symbol: 'BTCUSDT', lado: 'SELL' as const, preco: 100_000, quantidade: 10 };
    const doge = { tsMs: 1, symbol: 'DOGEUSDT', lado: 'SELL' as const, preco: 0.2, quantidade: 10 };
    assert.equal(liquidacaoRelevante(btc, 500_000), true);
    assert.equal(liquidacaoRelevante(doge, 500_000), false);
});

test('a medição usa T1 → T2, e o movimento perdido na latência fica SEPARADO', () => {
    // O erro que faz backtest de HFT parecer maravilhoso e produção parecer
    // quebrada: contabilizar como lucro o pedaço do movimento que já tinha
    // acontecido antes de conseguirmos agir.
    //
    // Cascata de baixa: futuros a 100.000 no evento, spot já em 99.800 quando
    // conseguimos entrar (150ms depois), e o fundo em 99.500.
    const r = medirJanela({
        tsEventoMs: 1000,
        direcao: 'baixa',
        precoFuturosT0: 100_000,
        precoSpotT1: 99_800,
        melhorSpotT2: 99_500,
        piorSpotT2: 99_850,
    });
    assert.ok(r);
    // De 99.800 até 99.500 são 0,3% — o que de fato dá para pegar.
    assert.equal((r!.capturavel * 100).toFixed(4), '0.3006');
    // Os 0,2% entre o evento e a nossa entrada NÃO entram no lucro.
    assert.equal((r!.perdidoNaLatencia * 100).toFixed(4), '0.2000');
    // E a operação ficou 0,05% contra antes de virar — o stop precisa aguentar.
    assert.equal((r!.excursaoContraria * 100).toFixed(4), '0.0501');
});

test('a mesma janela numa cascata de ALTA tem os sinais coerentes', () => {
    const r = medirJanela({
        tsEventoMs: 1000,
        direcao: 'alta',
        precoFuturosT0: 100_000,
        precoSpotT1: 100_200,
        melhorSpotT2: 100_500,
        piorSpotT2: 100_150,
    });
    assert.ok(r);
    assert.ok(r!.capturavel > 0);
    assert.ok(r!.perdidoNaLatencia > 0);
    assert.ok(r!.excursaoContraria > 0);
});

test('movimento que REVERTE antes de podermos entrar aparece como capturável NEGATIVO', () => {
    // O caso que mata a estratégia, e que precisa aparecer como número e não
    // como ausência de dado: a distorção já corrigiu quando chegamos.
    const r = medirJanela({
        tsEventoMs: 1000,
        direcao: 'baixa',
        precoFuturosT0: 100_000,
        precoSpotT1: 99_800,
        melhorSpotT2: 99_900,
        piorSpotT2: 99_900,
    });
    assert.ok(r);
    assert.ok(r!.capturavel < 0, 'chegamos tarde e o preço já tinha voltado');
});

test('sem tick do Spot a tempo, a janela é descartada em vez de estimada', () => {
    // Inventar um preço aqui produziria uma amostra que parece dado e não é.
    assert.equal(
        medirJanela({
            tsEventoMs: 1000,
            direcao: 'baixa',
            precoFuturosT0: 100_000,
            precoSpotT1: null,
            melhorSpotT2: 99_500,
            piorSpotT2: 99_900,
        }),
        null,
    );
});
