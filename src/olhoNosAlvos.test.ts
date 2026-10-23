import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { compararLeituras, naoForamLidos, leituraDeAgora, comoLerOMovimento, emQuantoTempoHumano, resumir, comoLerACobertura, type Alvo, type Leitura } from './olhoNosAlvos';

const alvo = (d: string, queda: number | null, divida = 3053, lucro = 66.44): Alvo => ({
    devedor: d, queda: queda === null ? null : new Decimal(queda),
    dividaUsd: new Decimal(divida), lucroUsd: new Decimal(lucro),
});
const leitura = (em: number, alvos: Alvo[]): Leitura => ({ em, alvos });

test('o caso real: o alvo de 1,441% andando para mais perto', () => {
    const antes = leitura(0, [alvo('0xc4d36f95', 1.441)]);
    const agora = leitura(12 * 60_000, [alvo('0xc4d36f95', 1.398)]);
    const [m] = compararLeituras(antes, agora);
    assert.equal(m!.tipo, 'andou');
    if (m!.tipo !== 'andou') return;
    assert.equal(m.deltaPontos.toFixed(3), '-0.043');
    assert.match(comoLerOMovimento(m), /CHEGOU 0\.043 mais perto em 12min/);
});

test('o sinal negativo quer dizer CHEGANDO PERTO, e isso vai escrito', () => {
    // Um sinal contraintuitivo sem palavra ao lado é um convite a ler ao
    // contrário — e aqui ler ao contrário é achar que o alvo está fugindo.
    const perto = compararLeituras(leitura(0, [alvo('0xA', 2)]), leitura(60_000, [alvo('0xA', 1.5)]))[0]!;
    const longe = compararLeituras(leitura(0, [alvo('0xA', 2)]), leitura(60_000, [alvo('0xA', 2.5)]))[0]!;
    assert.match(comoLerOMovimento(perto), /CHEGOU/);
    assert.match(comoLerOMovimento(longe), /afastou/);
});

test('parado é parado, e não vira movimento minúsculo', () => {
    const m = compararLeituras(leitura(0, [alvo('0xA', 2)]), leitura(60_000, [alvo('0xA', 2)]))[0]!;
    assert.match(comoLerOMovimento(m), /parado/);
});

test('sem leitura anterior, todos são NOVOS — não "andaram zero"', () => {
    const movs = compararLeituras(null, leitura(1000, [alvo('0xA', 1.4), alvo('0xB', 2.2)]));
    assert.equal(movs.length, 2);
    assert.ok(movs.every((m) => m.tipo === 'novo'));
    assert.match(comoLerOMovimento(movs[0]!), /NOVO/);
});

test('dívida paga vira SAIU, não margem zero', () => {
    // `quedaAteLiquidar` devolve null para quem não deve nada. Tratar isso
    // como 0% faria o alvo parecer liquidável — o pior erro possível aqui.
    const m = compararLeituras(leitura(0, [alvo('0xA', 1.4)]), leitura(60_000, [alvo('0xA', null)]))[0]!;
    assert.equal(m.tipo, 'saiu');
    assert.match(comoLerOMovimento(m), /SAIU da lista \(estava a 1\.400%\)/);
});

test('quem NÃO foi lido agora não é dado como sumido', () => {
    // Falta de leitura não é desaparecimento. Confundir os dois transforma um
    // buraco de cobertura em fato — o defeito que este projeto mais encontra.
    const antes = leitura(0, [alvo('0xA', 1.4), alvo('0xB', 2.2)]);
    const agora = leitura(60_000, [alvo('0xA', 1.3)]);
    assert.deepEqual(compararLeituras(antes, agora).map((m) => m.tipo), ['andou']);
    assert.deepEqual(naoForamLidos(antes, agora), ['0xB']);
    assert.deepEqual(naoForamLidos(null, agora), [], 'sem leitura anterior ninguém está faltando');
});

test('endereço em caixa diferente é a mesma pessoa', () => {
    const m = compararLeituras(leitura(0, [alvo('0xAbC', 2)]), leitura(60_000, [alvo('0xabc', 1.9)]))[0]!;
    assert.equal(m.tipo, 'andou');
    assert.deepEqual(naoForamLidos(leitura(0, [alvo('0xAbC', 2)]), leitura(60_000, [alvo('0xabc', 1.9)])), []);
});

test('o delta é em PONTOS da margem, não em porcentagem da margem', () => {
    // De 2% para 1% é −1 ponto, e NÃO "caiu 50%". As duas leituras são
    // diferentes e misturá-las já custou caro neste projeto.
    const m = compararLeituras(leitura(0, [alvo('0xA', 2)]), leitura(60_000, [alvo('0xA', 1)]))[0]!;
    if (m.tipo !== 'andou') return assert.fail();
    assert.equal(m.deltaPontos.toFixed(3), '-1.000');
});

test('tempo em português, em cada escala', () => {
    assert.equal(emQuantoTempoHumano(45_000), '45s');
    assert.equal(emQuantoTempoHumano(12 * 60_000), '12min');
    assert.equal(emQuantoTempoHumano(3 * 3_600_000), '3.0h');
});

test('movimento menor que a casa mostrada é PARADO, não "CHEGOU 0.000 mais perto"', () => {
    // A primeira leitura de verdade imprimiu exatamente isso: uma frase
    // afirmando movimento ao lado de um número que diz zero. O delta era real,
    // só menor que meio milésimo. Texto contradizendo o próprio número é o
    // defeito que este projeto mais encontra.
    const m = compararLeituras(
        leitura(0, [alvo('0xA', 1.4401)]),
        leitura(15_000, [alvo('0xA', 1.44005)]),
    )[0]!;
    if (m.tipo !== 'andou') return assert.fail();
    assert.ok(!m.deltaPontos.isZero(), 'o movimento existe');
    assert.match(comoLerOMovimento(m), /parado \(mexeu menos que a casa mostrada\)/);
    assert.doesNotMatch(comoLerOMovimento(m), /CHEGOU 0\.000/);
});

test('exatamente na resolução ainda conta como movimento', () => {
    const m = compararLeituras(leitura(0, [alvo('0xA', 2)]), leitura(15_000, [alvo('0xA', 1.9994)]))[0]!;
    assert.match(comoLerOMovimento(m), /CHEGOU 0\.001 mais perto/);
});

test('o resumo responde "o que vale a pena", que a lista por proximidade não respondia', () => {
    // A leitura real de 2026-09-27 imprimiu 16 linhas onde o alvo de R$ 359 e o
    // de 12 centavos tinham a mesma marca `>> ATIRA`, a seis linhas um do
    // outro. Ordenar por quem cai primeiro está certo para saber quem cai
    // primeiro, e errado para saber o que vale — são duas perguntas.
    const alvos = [
        alvo('0xPERTO_POBRE', 1.4, 19, 0.12),
        alvo('0xBOM', 1.441, 3054, 66.45),
        alvo('0xGRANDE', 3.846, 213196, 1985.95),
    ];
    const r = resumir(alvos, new Decimal('66.78'));
    assert.equal(r.naFaixa[0]!.devedor, '0xBOM', 'o melhor que ele ATIRA vem primeiro');
    assert.equal(r.naFaixa.length, 2);
    assert.equal(r.somaNaFaixa.toFixed(2), '66.57');
    assert.equal(r.melhorDeTodos!.devedor, '0xGRANDE');
    assert.equal(r.melhorForaDaFaixa!.devedor, '0xGRANDE');
});

test('sem teto, tudo cabe na faixa e não há "melhor fora"', () => {
    const r = resumir([alvo('0xA', 2, 213196, 1985.95)], null);
    assert.equal(r.naFaixa.length, 1);
    assert.equal(r.melhorForaDaFaixa, null);
});

test('o resumo ignora quem saiu e quem dá prejuízo', () => {
    const r = resumir([alvo('0xSAIU', null, 0, 0), alvo('0xPO', 1, 10, -0.3), alvo('0xBOM', 2, 3054, 66.45)], null);
    assert.equal(r.naFaixa.length, 1);
    assert.equal(r.naFaixa[0]!.devedor, '0xBOM');
});

test('no empate de prêmio, o resumo aponta quem cai primeiro', () => {
    // A gêmea do defeito de `oQueUmaQuedaRenderia`: o lucro satura no teto do
    // pool (US$ 1.985,95 medido em 2026-09-27), então duas baleias empatam até a
    // última casa e `sort` devolvia a ordem do array — a ordem em que o multicall
    // voltou. `melhorDeTodos` virava sorteio.
    //
    // Mesma lista em duas ordens, mesma resposta: a que está mais PERTO.
    const perto = alvo('0xPERTO', 2.125, 1933691, 1985.95);
    const longe = alvo('0xLONGE', 9.48, 5000000, 1985.95);
    for (const lista of [[perto, longe], [longe, perto]]) {
        const r = resumir(lista, null);
        assert.equal(r.melhorDeTodos!.devedor, '0xPERTO');
        assert.equal(r.naFaixa[0]!.devedor, '0xPERTO');
    }
    // E com teto, "o melhor que ele NÃO alcança" também é o mais perto dos dois.
    for (const lista of [[perto, longe], [longe, perto]]) {
        assert.equal(resumir(lista, new Decimal('66.78')).melhorForaDaFaixa!.devedor, '0xPERTO');
    }
});

test('a cobertura diz de onde veio o universo, e avisa até a 100%', () => {
    // O caso real: 3290 de 3290 lidos, "100.0%", e a baleia de US$ 1,93M a
    // 2,1251% fora da lista porque pegou o empréstimo antes da janela.
    const l = comoLerACobertura({ lidos: 3290, daJanela: 3290, daMemoria: 0, blocos: 320_000 });
    assert.match(l, /li 3290 de 3290 endereços \(100\.0%\)/);
    assert.match(l, /últimos 320000 blocos \(~7\.4 dias\)/);
    assert.match(l, /quem eu ACHEI, não quem existe/, 'o aviso vale inclusive a 100%');
    assert.doesNotMatch(l, /COBERTURA BAIXA/);

    // Com memória, ela aparece somada e nomeada.
    assert.match(
        comoLerACobertura({ lidos: 3294, daJanela: 3290, daMemoria: 4, blocos: 320_000 }),
        /de 3294 endereços \(100\.0%\): 3290 que pediram emprestado .* \+ 4 guardados/,
    );

    // Releitura da lista guardada: não houve janela, então não há aviso de janela.
    const so = comoLerACobertura({ lidos: 24, daJanela: 0, daMemoria: 24, blocos: 0 });
    assert.match(so, /li 24 de 24 endereços \(100\.0%\): 24 guardados/);
    assert.doesNotMatch(so, /quem eu ACHEI/);

    // Cobertura baixa continua gritando.
    assert.match(comoLerACobertura({ lidos: 86, daJanela: 100, daMemoria: 0, blocos: 2000 }), /COBERTURA BAIXA/);
});

test('janela que falhou não pode virar 100% de cobertura', () => {
    // Antes: com TODAS as janelas falhadas a linha dizia "li 24 de 24 endereços
    // (100.0%): 0 que pediram emprestado nos últimos 320000 blocos (~7.4 dias)" —
    // uma varredura que não aconteceu, publicada como censo completo. A
    // porcentagem é lidos/(daJanela+daMemoria), e perder janelas encolhe o
    // denominador: o 100% fica intacto justamente quando a medição morreu.
    const tudoFalhou = comoLerACobertura({
        lidos: 24, daJanela: 0, daMemoria: 24, blocos: 320_000,
        janelas: 160, janelasQueFalharam: 160,
    });
    assert.match(tudoFalhou, /TODAS as 160 janelas falharam/);
    assert.match(tudoFalhou, /esta varredura NÃO aconteceu/);

    // Falha parcial: diz quantas, e não finge saber o tamanho do buraco.
    const parcial = comoLerACobertura({
        lidos: 3000, daJanela: 3000, daMemoria: 0, blocos: 320_000,
        janelas: 160, janelasQueFalharam: 12,
    });
    assert.match(parcial, /12 de 160 janelas falharam/);
    assert.match(parcial, /não sei de quanto/);
    assert.match(parcial, /só 148 das 160 janelas deram certo/);

    // Sem falha nenhuma, a linha continua como era.
    const limpa = comoLerACobertura({
        lidos: 3290, daJanela: 3290, daMemoria: 0, blocos: 320_000,
        janelas: 160, janelasQueFalharam: 0,
    });
    assert.doesNotMatch(limpa, /falharam/);
    assert.match(limpa, /últimos 320000 blocos \(~7\.4 dias\)/);
});

test('quem pagou a dívida SAIU — e não pode ser chamado de "não lido"', () => {
    // O caso real de 2026-09-28. Às 14:30 UTC a varredura viu `0x4a51443b` a
    // 4,926% com US$ 29.662 de dívida. Às 15:40 o multicall respondeu por ele
    // normalmente, e a resposta era dívida ZERO — conferido com `eth_call`
    // direto no pool: colateral e dívida zerados, saúde = uint256 máximo.
    //
    // O olho imprimiu, nessa ordem, duas frases que não podem ser verdade
    // juntas:
    //
    //     li 37 de 37 endereços (100.0%)
    //     2 não foram lidos agora (NÃO quer dizer que sumiram)
    //
    // A de cima estava certa. A de baixo aparecia porque quem chama filtrava
    // `queda !== null` ANTES de comparar, e com isso o ramo `saiu` — que tem
    // teste logo acima neste arquivo — não tinha caminho até aqui.
    const antes = leitura(0, [alvo('0x4a51443b', 4.926, 29662, 598.93), alvo('0xc4d36f95', 1.427)]);
    const lido = [alvo('0xc4d36f95', 1.428), alvo('0x4a51443b', null, 0, 0)];

    const agora = leituraDeAgora(70 * 60_000, lido);
    const movs = compararLeituras(antes, agora);

    assert.deepEqual(movs.map((m) => m.tipo), ['andou', 'saiu']);
    const saiu = movs.find((m) => m.tipo === 'saiu')!;
    assert.match(comoLerOMovimento(saiu), /0x4a51443b… SAIU da lista \(estava a 4\.926%\) — pagou ou foi liquidado/);
    assert.deepEqual(naoForamLidos(antes, agora), [],
        'foi lido: chamar isso de falta de leitura é o oposto do que aconteceu');
});

test('leituraDeAgora põe os vivos por proximidade e os sem dívida no fim', () => {
    const r = leituraDeAgora(1000, [alvo('0xLonge', 4.9), alvo('0xPagou', null), alvo('0xPerto', 1.4)]);
    assert.deepEqual(r.alvos.map((a) => a.devedor), ['0xPerto', '0xLonge', '0xPagou']);
    assert.equal(r.em, 1000);
});

test('quem o multicall não respondeu continua sendo "não lido", não "saiu"', () => {
    // A outra ponta da mesma regra: o conserto acima não pode transformar um
    // buraco de cobertura em fato. Quem não veio na resposta não está na lista,
    // e por isso não vira `saiu` — vira falta de leitura, que é o que é.
    const antes = leitura(0, [alvo('0xA', 1.4), alvo('0xPedacoQueFalhou', 2.2)]);
    const agora = leituraDeAgora(60_000, [alvo('0xA', 1.3)]);
    assert.deepEqual(compararLeituras(antes, agora).map((m) => m.tipo), ['andou']);
    assert.deepEqual(naoForamLidos(antes, agora), ['0xPedacoQueFalhou']);
});
