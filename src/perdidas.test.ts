import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { comparaPremio,
    lucroEstimado, emDolar, ondeEuEstava, montarPlacar, oQueIssoQuerDizer,
    type Perdida, type Cobertura,
    ehPoeira,
} from './perdidas';

const D = (n: number | string) => new Decimal(n);
const perdida = (p: Partial<Perdida> & { lucroUsd: Decimal | null; cobertura: Cobertura }): Perdida => ({
    devedor: '0xaa', bloco: 1, liquidante: '0xbb', dividaUsd: null, ...p,
});

test('liquidação de US$4.000 NÃO rende US$4.000', () => {
    // O erro que já apareceu duas vezes nesta conversa, sempre otimista:
    // confundir o tamanho da dívida com o lucro. Cobre-se metade, ganha-se o
    // ágio sobre essa metade, e ainda se paga para vender a garantia.
    const lucro = lucroEstimado(D(4000));
    assert.ok(lucro.greaterThan(80), `deu ${lucro.toFixed(2)}`);
    assert.ok(lucro.lessThan(95), `deu ${lucro.toFixed(2)}`);
});

test('o lucro cresce junto com a dívida, mas em outra escala', () => {
    // 5% sobre metade = 2,5% da dívida, menos custos. Nunca perto de 100%.
    for (const divida of [1000, 10_000, 100_000]) {
        const l = lucroEstimado(D(divida));
        assert.ok(l.lessThan(divida * 0.025), `${divida} rendeu ${l.toFixed(2)}`);
    }
});

test('dívida pequena demais dá lucro NEGATIVO por causa do gás', () => {
    assert.ok(lucroEstimado(D(10)).lessThan(0));
});

test('sem preço ou sem casas decimais, o valor é null — nunca um palpite', () => {
    // Assumir 18 casas para um token de 6 erraria por um trilhão. Já
    // aconteceu neste projeto.
    assert.equal(emDolar(1000000n, undefined, D(1e8)), null);
    assert.equal(emDolar(1000000n, 6, undefined), null);
});

test('converte unidades cruas para dólar usando as casas do token', () => {
    // 4.000 USDC: 6 casas, oráculo a US$1,00 (1e8).
    const usd = emDolar(4_000_000_000n, 6, D(1e8));
    assert.equal(usd!.toFixed(2), '4000.00');
    // 1 WETH: 18 casas, oráculo a US$2.646,93.
    const eth = emDolar(10n ** 18n, 18, D(264693000000));
    assert.equal(eth!.toFixed(2), '2646.93');
});

test('ondeEuEstava separa os quatro casos', () => {
    const brasa = new Set(['0xa']);
    const quentes = new Set(['0xb']);
    const todos = new Set(['0xa', '0xb', '0xc']);
    assert.equal(ondeEuEstava('0xA', brasa, quentes, todos), 'brasa');
    assert.equal(ondeEuEstava('0xB', brasa, quentes, todos), 'quente');
    assert.equal(ondeEuEstava('0xC', brasa, quentes, todos), 'na lista');
    assert.equal(ondeEuEstava('0xZ', brasa, quentes, todos), 'nem sabia');
});

test('a comparação ignora maiúsculas do checksum', () => {
    const brasa = new Set(['0xabcdef']);
    assert.equal(ondeEuEstava('0xABCDEF', brasa, new Set(), new Set()), 'brasa');
});

test('o placar ignora as que não pagam nem o gás', () => {
    const p = montarPlacar([
        perdida({ lucroUsd: D(2), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(88), cobertura: 'brasa' }),
    ]);
    assert.equal(p.total, 2);
    assert.equal(p.comCotacao, 2);
    assert.equal(p.valiam.length, 1);
    assert.equal(p.somaDoLucroPerdido.toNumber(), 88);
});

test('liquidação sem cotação não conta como zero nem some do total', () => {
    // "Sem preço" tem que continuar visível: contá-la como US$0 diria que
    // nada valia, e escondê-la do total diria que nada aconteceu.
    const p = montarPlacar([perdida({ lucroUsd: null, cobertura: 'brasa' })]);
    assert.equal(p.total, 1);
    assert.equal(p.comCotacao, 0);
    assert.equal(p.valiam.length, 0);
});

test('as que valiam saem ordenadas por LUCRO, não pela ordem que chegaram', () => {
    const p = montarPlacar([
        perdida({ lucroUsd: D(50), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(900), cobertura: 'quente' }),
        perdida({ lucroUsd: D(120), cobertura: 'brasa' }),
    ]);
    assert.deepEqual(p.valiam.map((x) => x.lucroUsd!.toNumber()), [900, 120, 50]);
});

test('o diagnóstico aponta o balde maior, e cada balde pede conserto diferente', () => {
    const naBrasa = montarPlacar([
        perdida({ lucroUsd: D(88), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(88), cobertura: 'brasa' }),
        perdida({ lucroUsd: D(88), cobertura: 'nem sabia' }),
    ]);
    assert.ok(oQueIssoQuerDizer(naBrasa).includes('velocidade'));

    const foraDaLista = montarPlacar([
        perdida({ lucroUsd: D(88), cobertura: 'nem sabia' }),
        perdida({ lucroUsd: D(88), cobertura: 'nem sabia' }),
    ]);
    assert.ok(oQueIssoQuerDizer(foraDaLista).includes('cobertura'));
});

test('zero liquidações na faixa NÃO vira acusação de lentidão', () => {
    // A diferença entre "não teve" e "teve e você perdeu" é a coisa toda que
    // este placar existe para separar.
    const vazio = montarPlacar([perdida({ lucroUsd: D(1), cobertura: 'brasa' })]);
    assert.ok(oQueIssoQuerDizer(vazio).includes('não teve'));
});

// ---------------------------------------------------------------------------
// O piso do placar tem de ser o piso DO BOT.
//
// Estava fixo em US$ 20 e ficou desatualizado em silêncio. Com o modo prova o
// bot atira em qualquer lucro acima de zero, e o placar imprimiria "Nenhuma
// liquidação na sua faixa de lucro. Não teve." sobre exatamente a liquidação
// que ela está esperando para provar que o bot funciona.
//
// O placar existe para responder "passou algo que eu queria?". Com o piso
// errado ele responde a pergunta de outro bot.
// ---------------------------------------------------------------------------

const perdidaDe = (lucroUsd: number, cobertura: Cobertura = 'brasa'): Perdida => ({
    devedor: `0x${'11'.repeat(20)}`,
    liquidante: `0x${'22'.repeat(20)}`,
    bloco: 1,
    dividaUsd: new Decimal(lucroUsd * 50),
    lucroUsd: new Decimal(lucroUsd),
    cobertura,
});

test('o defeito: uma liquidação de US$ 5 desaparecia atrás do piso de US$ 20', () => {
    const passou = [perdidaDe(5)];
    const comPisoAntigo = montarPlacar(passou, new Decimal(20));
    assert.equal(comPisoAntigo.valiam.length, 0, 'era isso que o log dizia');
    assert.match(oQueIssoQuerDizer(comPisoAntigo), /não teve/i);

    // Com o piso do modo prova ela aparece, que é o certo.
    const comPisoDaProva = montarPlacar(passou, new Decimal(0));
    assert.equal(comPisoDaProva.valiam.length, 1);
    assert.equal(comPisoDaProva.somaDoLucroPerdido.toFixed(2), '5.00');
});

test('a frase de "não teve" carrega o piso, senão não dá para conferir', () => {
    const vazio = montarPlacar([], new Decimal(20));
    assert.match(oQueIssoQuerDizer(vazio, new Decimal(20)), /piso: US\$ 20\.00/);
    assert.match(oQueIssoQuerDizer(vazio, null), /qualquer lucro acima de zero/);
    // Sem informação de piso, a frase fica como era — não inventa um número.
    assert.equal(oQueIssoQuerDizer(vazio).includes('piso'), false);
});

test('o piso continua servindo ao que foi feito para: não inflar com poeira', () => {
    // Com piso de US$ 1, uma liquidação de 2 centavos não entra como "perdida".
    const placar = montarPlacar([perdidaDe(0.02), perdidaDe(5)], new Decimal(1));
    assert.equal(placar.valiam.length, 1);
    assert.equal(placar.total, 2, 'mas as duas continuam CONTADAS: aconteceram');
});

test('piso zero conta tudo que tem cotação, e nada do que não tem', () => {
    const semCotacao: Perdida = { ...perdidaDe(5), lucroUsd: null, dividaUsd: null };
    const placar = montarPlacar([perdidaDe(0.01), semCotacao], new Decimal(0));
    assert.equal(placar.valiam.length, 1, 'a de um centavo entra com piso zero');
    assert.equal(placar.comCotacao, 1, 'a sem cotação não vira zero: fica de fora da conta');
    assert.equal(placar.total, 2);
});

test('comparaPremio: lucro manda, e o empate vai para quem cai primeiro', () => {
    const p = (lucro: string, queda: string) => ({ lucroUsd: new Decimal(lucro), quedaPct: new Decimal(queda) });
    // Lucro maior vem antes, mesmo estando mais longe.
    assert.ok(comparaPremio(p('1986', '9.48'), p('66.42', '1.44')) < 0);
    // Empate exato: vence o mais perto de cair, porque é UM alvo por vez.
    assert.ok(comparaPremio(p('1985.95441843', '2.12'), p('1985.95441843', '4.04')) < 0);
    assert.ok(comparaPremio(p('1985.95441843', '4.04'), p('1985.95441843', '2.12')) > 0);
    // Empate nos dois campos é 0, senão `sort` fica instável de novo.
    assert.equal(comparaPremio(p('1986', '2.12'), p('1986', '2.12')), 0);
});

// ===========================================================================
// POEIRA LIQUIDAVEL — uma regra, um lugar. REGRA 3, quinta vez.
// ===========================================================================

test('ehPoeira barra os DOIS casos reais de 2026-10-07', () => {
    // Medidos na rede, com horas de diferença:
    //   12:15  0x12314a83…  saúde 0,96540468  dívida US$ 0,00  garantia US$ 0,01
    //   17:04  0x8c095dd7…  saúde 0,998653    dívida US$ 0,00  garantia US$ 0,00
    // Liquidáveis para sempre e impossíveis para sempre.
    assert.equal(ehPoeira(new Decimal(0)), true);
    assert.equal(ehPoeira(new Decimal('0.01')), true);
    assert.equal(ehPoeira(new Decimal(10)), true, 'US$ 10 de dívida rende -US$ 0,08');
});

test('ehPoeira NAO barra o alvo que vale — o de US$ 49,33', () => {
    // Dívida US$ 2.163,90, bônus bruto realizado US$ 49,33, estimativa US$ 47,12.
    assert.equal(ehPoeira(new Decimal('2163.90')), false);
});

test('dívida negativa ou não-finita conta como poeira, nunca como alvo', () => {
    // Ausência e lixo não podem virar autorização de gasto.
    assert.equal(ehPoeira(new Decimal(-5)), true);
    assert.equal(ehPoeira(new Decimal(Number.NaN)), true);
    assert.equal(ehPoeira(new Decimal(Number.POSITIVE_INFINITY)), true);
});

test('ehPoeira e lucroEstimado concordam sempre — senao sao duas regras', () => {
    // O defeito que este teste guarda: eu escrevi o critério como `if` dentro
    // do laço da brasa e a varredura completa ficou com o seu próprio
    // `caidos.push`, sem filtro. Em 2026-10-07 às 17:04 entraram OITO poeiras
    // de uma vez pelo caminho que eu não consertei. REGRA 3, quinta vez.
    for (const d of ['0', '0.5', '5', '18', '18.5', '19', '25', '100', '5000']) {
        const divida = new Decimal(d);
        assert.equal(
            ehPoeira(divida),
            lucroEstimado(divida).lessThanOrEqualTo(0),
            `divergiram em US$ ${d}: são duas regras onde devia ser uma`,
        );
    }
});
