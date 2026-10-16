// Arquivo: src/decisaoDaAposta.test.ts
//
// A DECISAO DA APOSTA, DE PONTA A PONTA — ambiente -> conta economica -> tiro.
//
// POR QUE ESTE ARQUIVO EXISTE, nas palavras dela: *"Prove que a correcao
// controla a decisao real. Nao basta testar que existe Decimal.max no codigo.
// Demonstre o comportamento completo: configuracao carregada, calculo
// economico, decisao de enviar e resultado esperado."*
//
// Entao aqui nada e imitado: a configuracao sai de `politicaDaAposta`, o custo
// de `custoDeUmaErradaUsd` (que usa `custoDeUmaDerrota` e
// `GAS_MEDIDO_DE_UMA_REVERSAO`), o piso de `pisoEfetivoDaAposta` e a decisao de
// `atirarNaEscritaIminente` — as MESMAS funcoes que o caminho quente chama em
// `cacarAoVivo.ts`. Uma copia provaria a copia.
//
// OS NUMEROS SAO MEDIDOS, e de onde:
//   baseFee 0,020 gwei .......... log de producao de 2026-10-08 19:20
//   gorjeta 0,020 gwei .......... `GORJETA_DA_FRENTE_GWEI`, remedido em 09/10:
//                                 a gorjeta NAO compra posicao na Base
//                                 (Spearman posicao x gorjeta = +0,300 em 33
//                                 blocos, cobertura 100%)
//   gas da reversao 372.202 ..... MEDIA do `gasUsed` dos 39 recibos reais
//   ETH US$ 2.534 ............... o preco que fecha com o log
//   => custo por errada US$ 0,0377 e piso de equilibrio US$ 13,39
//
// OS NUMEROS MUDARAM EM 09/10, e nao por eu ter escolhido melhor: por medicao.
// Com a gorjeta de 0,300 gwei e o gas derivado de 550.000, o piso era US$ 158,32
// e barrava os dois unicos alvos reais que este projeto mediu. Com a gorjeta
// que a corrente justifica, ele cai para US$ 13,39 e o alvo de US$ 47,12 passa
// a se pagar as CEGAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { politicaDaAposta, custoDeUmaErradaUsd } from './prontidao';
import {
    pisoEfetivoDaAposta, atirarNaEscritaIminente, quantasVezesOAcaso,
    BLOCOS_POR_ESCRITA,
} from './adiantar';

const BASE_FEE = 20_000_000n;      // 0,020 gwei, do log
const ETH = new Decimal(2534);     // o preco que fecha com os recibos
const PISO = '13.39';              // o equilibrio com os numeros medidos
const MERCADO = new Decimal('0.3899'); // o desvio real do log de 07/10
const ALVO = new Decimal('0.061721');  // a distancia real do alvo daquele dia

/** O caminho inteiro, exatamente na ordem em que a producao o percorre. */
function decidir(env: Record<string, string | undefined>, premioUsd: Decimal | null, opcoes: {
    precoDoEth?: Decimal | null;
    alvoPct?: Decimal;
    mercadoPct?: Decimal | null;
} = {}) {
    const politica = politicaDaAposta(env);
    const custo = custoDeUmaErradaUsd(
        politica.tetoDaGorjetaGwei, BASE_FEE,
        opcoes.precoDoEth === undefined ? ETH : opcoes.precoDoEth,
    );
    const piso = pisoEfetivoDaAposta(politica.minimaEscolhidaUsd, custo);
    const decisao = atirarNaEscritaIminente({
        mercadoCaiuPct: opcoes.mercadoPct === undefined ? MERCADO : opcoes.mercadoPct,
        quedaDoAlvoPct: opcoes.alvoPct ?? ALVO,
        premioUsd,
        premioMinimoUsd: piso,
        ligada: politica.ligada,
    });
    return { custo, piso, ...decisao };
}

test('o custo e o piso saem das MEDICOES, e batem com os 39 recibos', () => {
    // A 0,300 gwei, que foi o que a producao PAGOU: os recibos somaram
    // 0,004680 ETH em 39 erradas = 0,00011999 ETH cada.
    const comoFoi = custoDeUmaErradaUsd(0.3, BASE_FEE, ETH);
    assert.equal(comoFoi.dividedBy(ETH).toFixed(8), '0.00011910');
    // E a 0,020 gwei, que e o que a medicao de ordem do bloco justifica:
    const custo = custoDeUmaErradaUsd(0.02, BASE_FEE, ETH);
    assert.equal(custo.toFixed(4), '0.0377');
    assert.ok(comoFoi.dividedBy(custo).greaterThan(7), 'a errada fica 8x mais barata');
    // E o piso e esse custo vezes os 355 blocos entre escritas do oraculo.
    const piso = pisoEfetivoDaAposta(null, custo);
    assert.equal(piso.toFixed(2), PISO);
    assert.equal(piso.dividedBy(custo).toNumber(), BLOCOS_POR_ESCRITA);
});

test('O CASO REAL DE 08/10: a regra antiga autorizava, a nova BLOQUEIA', () => {
    // Isto nao e cenario inventado: e o log de 2026-10-08 19:20. Com
    // CACA_APOSTA_MINIMA_USD=10 o bot mandou 31 apostas num premio de
    // US$ 10,40, gastou US$ 13,83 e acertou ZERO.
    const premio = new Decimal('10.40');

    // A REGRA ANTIGA — a variavel mandava sozinha — dizia ATIRA.
    const antiga = atirarNaEscritaIminente({
        mercadoCaiuPct: MERCADO,
        quedaDoAlvoPct: ALVO,
        premioUsd: premio,
        premioMinimoUsd: new Decimal(10), // o piso escrito, sem o equilibrio
        ligada: true,
    });
    assert.equal(antiga.atira, true, 'a regra antiga de fato autorizava este tiro');

    // A REGRA DE AGORA, com a MESMA variavel no ambiente, recusa.
    const agora = decidir({ CACA_APOSTA_MINIMA_USD: '10' }, premio);
    assert.equal(agora.atira, false);
    assert.equal(agora.piso.toFixed(2), PISO);
    assert.match(agora.porque, /só se paga a partir de US\$ 13\.39/);

    // E a conta que condena a aposta, publicada junto. Com a gorjeta medida ela
    // deixou de exigir 15,2x o acaso e passa a exigir 1,3x — ainda acima de 1,
    // ainda recusada, e agora por pouco: o piso ficou 12x mais baixo e este
    // alvo CONTINUA de fora.
    const vezes = quantasVezesOAcaso(premio, agora.custo)!;
    assert.ok(vezes.greaterThan(1) && vezes.lessThan(1.4), vezes.toFixed(2));
});

test('O CASO VIAVEL continua passando: premio que se paga sozinho ATIRA', () => {
    // As quatro oportunidades das 4,6 horas do mesmo log tinham media de
    // US$ 188,37 — elas pagavam sozinhas. O piso nao pode barra-las, senao ele
    // nao protege: desliga a estrategia com outro nome (foi o que US$ 20 fez em
    // 07/10, barrando a unica oportunidade do dia).
    const premio = new Decimal('188.37');
    const d = decidir({}, premio);
    assert.equal(d.atira, true, d.porque);
    assert.ok(quantasVezesOAcaso(premio, d.custo)!.lessThan(1), 'paga sozinho');

    // E com a variavel escrita no valor que ela usou, tambem passa: o piso
    // efetivo e o MAIOR dos dois, e 158,33 > 10.
    assert.equal(decidir({ CACA_APOSTA_MINIMA_USD: '10' }, premio).atira, true);
});

test('o alvo real de US$ 47,12 VOLTOU a ser apostavel, e o de US$ 11,59 nao', () => {
    // Em 08/10, com a gorjeta de 0,300 gwei, o piso de US$ 158,32 barrava os
    // DOIS unicos alvos reais que este projeto mediu. Com a gorjeta que a
    // corrente justifica, o de 07/10 passa a se pagar as CEGAS — 0,28x o acaso.
    const quarenta = decidir({}, new Decimal('47.12'));
    assert.equal(quarenta.atira, true, quarenta.porque);
    assert.ok(quantasVezesOAcaso(new Decimal('47.12'), quarenta.custo)!.lessThan(1),
        'paga sozinho, sem precisar acreditar na previsao');

    // E o custo da regra, que continua declarado: o de US$ 11,59 fica de fora
    // por pouco (1,16x o acaso). Nao escondo isso.
    const onze = decidir({}, new Decimal('11.59'));
    assert.equal(onze.atira, false);
    const vezes = quantasVezesOAcaso(new Decimal('11.59'), onze.custo)!;
    assert.ok(vezes.greaterThan(1) && vezes.lessThan(1.3), vezes.toFixed(2));
});

test('o ambiente so pode ENDURECER, nunca afrouxar', () => {
    const premio = new Decimal('188.37');
    // Mais exigente: manda, e barra um premio que o equilibrio deixaria passar.
    const duro = decidir({ CACA_APOSTA_MINIMA_USD: '500' }, premio);
    assert.equal(duro.piso.toFixed(0), '500');
    assert.equal(duro.atira, false);

    // Mais frouxo, em todas as formas de escrever "frouxo": o equilibrio manda.
    for (const frouxo of ['0', '10', '1', '13.3']) {
        const d = decidir({ CACA_APOSTA_MINIMA_USD: frouxo }, new Decimal('10.40'));
        assert.equal(d.piso.toFixed(2), PISO, `CACA_APOSTA_MINIMA_USD=${frouxo}`);
        assert.equal(d.atira, false);
    }

    // E NAO EXISTE ESCAPE: nenhuma variavel autoriza aposta de valor esperado
    // negativo. Eu havia criado `CACA_ACEITA_APOSTA_NEGATIVA=1` e ela mandou
    // remover; se alguma sessao futura reintroduzir uma, este caso reprova.
    const comEscape = decidir({
        CACA_APOSTA_MINIMA_USD: '0',
        CACA_ACEITA_APOSTA_NEGATIVA: '1',
        CACA_APOSTA_SEM_PISO: '1',
    }, new Decimal('10.40'));
    assert.equal(comEscape.atira, false, 'nenhuma chave de ambiente libera aposta negativa');
});

test('SEM PRECO DO ETH nao se aposta — e este era um defeito meu, de hoje', () => {
    // O defeito: `custoDeUmaErradaUsd` devolve zero sem preco, e o premio da
    // aposta NAO depende desse preco (vem de `lucroEstimado` sobre a divida que
    // a Aave devolve em dolar). Com equilibrio zero e nenhuma variavel escrita,
    // o piso virava ZERO e QUALQUER premio passava — o caso US$ 10,40 de volta,
    // agora liberado por um mapa de precos vazio.
    const d = decidir({}, new Decimal('10.40'), { precoDoEth: null });
    assert.equal(d.custo.toNumber(), 0, 'sem preco o custo nao se mede');
    assert.equal(d.piso.isFinite(), false, 'piso infinito: nao autoriza nada');
    assert.equal(d.atira, false);
    assert.match(d.porque, /não consegui medir o custo de uma errada/);
    // Nem um premio grande passa: sem a conta nao existe a autorizacao.
    assert.equal(decidir({}, new Decimal('5000'), { precoDoEth: null }).atira, false);
    // E com a variavel escrita tambem nao: ela endurece, nao substitui a conta.
    assert.equal(
        decidir({ CACA_APOSTA_MINIMA_USD: '10' }, new Decimal('5000'), { precoDoEth: null }).atira,
        false,
    );
});

test('os outros portoes do caminho continuam valendo, com o piso certo', () => {
    const premio = new Decimal('188.37');
    // Desligada por ambiente.
    assert.equal(decidir({ CACA_ATIRAR_NA_ESCRITA: '0' }, premio).atira, false);
    // Sem cotacao de mercado: ausencia nao e "o oraculo vai escrever".
    assert.equal(decidir({}, premio, { mercadoPct: null }).atira, false);
    // Premio desconhecido nao libera, nem com o mercado andado.
    assert.equal(decidir({}, null, {}).atira, false);
    // Alvo longe demais para a escrita fechar.
    assert.equal(decidir({}, premio, { alvoPct: new Decimal('0.99') }).atira, false);
});

test('numero torto no ambiente MORRE no boot, nao vira NaN em silencio', () => {
    // Virgula decimal e o natural para quem escreve em portugues, e este
    // projeto perdeu um bot inteiro para `Number('0,5') === NaN`.
    assert.throws(() => politicaDaAposta({ CACA_APOSTA_MINIMA_USD: '158,33' }),
        /CACA_APOSTA_MINIMA_USD/);
    assert.throws(() => politicaDaAposta({ CACA_GORJETA_ESPECULATIVA_GWEI: '0,3' }),
        /CACA_GORJETA_ESPECULATIVA_GWEI/);
    // E ausencia e ausencia: `null`, que e diferente de zero escrito.
    assert.equal(politicaDaAposta({}).minimaEscolhidaUsd, null);
    assert.equal(politicaDaAposta({ CACA_APOSTA_MINIMA_USD: '0' })!.minimaEscolhidaUsd!.toNumber(), 0);
});

test('a gorjeta mais alta sobe o piso, porque cada errada custa mais', () => {
    // O piso ANDA com os botoes: nenhuma sessao futura precisa re-escolher.
    const caro = decidir({ CACA_GORJETA_ESPECULATIVA_GWEI: '2.84' }, new Decimal('188.37'));
    assert.ok(caro.piso.greaterThan(900), caro.piso.toFixed(2));
    assert.equal(caro.atira, false, 'a 2,84 gwei nem US$ 188 se paga no acaso');
    // E o caminho inverso: a 0,300 gwei o piso volta a barrar o alvo de US$ 47,12.
    const comoEra = decidir({ CACA_GORJETA_ESPECULATIVA_GWEI: '0.3' }, new Decimal('47.12'));
    assert.equal(comoEra.atira, false, 'era isto que a gorjeta de 08/10 fazia');
});
