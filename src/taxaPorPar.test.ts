// Arquivo: src/taxaPorPar.test.ts
//
// O que estes testes protegem é a diferença entre "arbitragem triangular está
// morta" e "arbitragem triangular está viva". A conclusão anterior deste
// projeto — 232 mil avaliações, melhor desalinhamento 0,124% contra custo de
// 0,225% — dependia inteiramente de assumir a MESMA taxa nas três pernas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    brutoNecessario,
    custoDoTriangulo,
    montarTabelaDeTaxas,
    pernasIsentas,
    retencaoDoTriangulo,
    taxaDoPar,
} from './taxaPorPar';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const TAXA_CHEIA = new Decimal('0.00075');
const tabela = montarTabelaDeTaxas({
    padrao: TAXA_CHEIA,
    isentos: ['BTCFDUSD', 'ETHFDUSD', 'FDUSDUSDT'],
});

test('o ciclo com duas pernas isentas custa UMA taxa, não três', () => {
    // O número que reabre o projeto. Com taxa global o motor calcula 0,225% e
    // descarta o ciclo viável junto com os inviáveis — sem reclamar, porque a
    // rejeição é indistinguível da rejeição correta.
    const pernas: [string, string, string] = ['BTCUSDT', 'BTCFDUSD', 'FDUSDUSDT'];
    const custo = custoDoTriangulo(pernas, tabela);
    assert.equal(custo.mul(100).toFixed(4), '0.0750', 'só a perna USDT paga');

    const antigo = new Decimal(1).minus(new Decimal(1).minus(TAXA_CHEIA).pow(3));
    assert.equal(antigo.mul(100).toFixed(4), '0.2248', 'o modelo antigo cobrava as três');
});

test('a oportunidade medida de 0,124% passa a caber dentro do custo novo', () => {
    // A medição real deste projeto: melhor desalinhamento de 232 mil
    // avaliações. Contra 0,225% era descartada; contra 0,075% sobra 1,65x.
    const desalinhamentoMedido = new Decimal('0.00124');
    const custoNovo = custoDoTriangulo(['BTCUSDT', 'BTCFDUSD', 'FDUSDUSDT'], tabela);
    assert.ok(desalinhamentoMedido.greaterThan(custoNovo));
    assert.equal(desalinhamentoMedido.dividedBy(custoNovo).toFixed(2), '1.65');
});

test('par DESCONHECIDO paga a taxa cheia — nunca o contrário', () => {
    // Errar para a taxa alta custa uma oportunidade perdida. Errar para a taxa
    // zero manda dinheiro real perseguir lucro que não existe, e o erro só
    // aparece no extrato.
    assert.equal(taxaDoPar('SOLUSDT', tabela).toString(), TAXA_CHEIA.toString());
    assert.equal(taxaDoPar('PARINVENTADO', tabela).toString(), TAXA_CHEIA.toString());
    assert.equal(taxaDoPar('BTCFDUSD', tabela).toString(), '0');
});

test('a normalização impede que "btcfdusd" minúsculo vire par taxado em silêncio', () => {
    const comMinusculas = montarTabelaDeTaxas({
        padrao: TAXA_CHEIA,
        isentos: [' btcfdusd ', 'EthFdusd'],
    });
    assert.equal(taxaDoPar('BTCFDUSD', comMinusculas).toString(), '0');
    assert.equal(taxaDoPar('ETHFDUSD', comMinusculas).toString(), '0');
});

test('entradas vazias na lista não viram par isento', () => {
    // Uma variável de ambiente como "BTCFDUSD,,ETHFDUSD" tem um campo vazio no
    // meio. Sem o filtro, a string vazia entraria no conjunto — inofensiva por
    // acaso, mas é o tipo de coisa que vira bug quando o formato muda.
    const comVazios = montarTabelaDeTaxas({ padrao: TAXA_CHEIA, isentos: ['BTCFDUSD', '', '   '] });
    assert.equal(comVazios.isentos.size, 1);
});

test('as três pernas isentas zeram o custo por completo', () => {
    const todasIsentas = montarTabelaDeTaxas({
        padrao: TAXA_CHEIA,
        isentos: ['AAAFDUSD', 'BBBFDUSD', 'CCCFDUSD'],
    });
    const custo = custoDoTriangulo(['AAAFDUSD', 'BBBFDUSD', 'CCCFDUSD'], todasIsentas);
    assert.equal(custo.toString(), '0');
    assert.equal(retencaoDoTriangulo(['AAAFDUSD', 'BBBFDUSD', 'CCCFDUSD'], todasIsentas).toString(), '1');
});

test('a retenção é MULTIPLICATIVA, não somada', () => {
    // Cada perna incide sobre o que sobrou da anterior. A diferença é ínfima
    // com taxas pequenas — e a margem inteira deste ciclo cabe dentro de
    // "ínfimo", então somar seria errado exatamente onde importa.
    const semIsencao = montarTabelaDeTaxas({ padrao: new Decimal('0.1'), isentos: [] });
    const retencao = retencaoDoTriangulo(['A', 'B', 'C'], semIsencao);
    assert.equal(retencao.toFixed(3), '0.729', '0,9³ = 0,729, não 1 − 0,3 = 0,700');
});

test('o bruto necessário cai quando as pernas são isentas', () => {
    const alvo = new Decimal('0.001');
    const comIsencao = brutoNecessario({
        pernas: ['BTCUSDT', 'BTCFDUSD', 'FDUSDUSDT'],
        tabela,
        lucroAlvo: alvo,
    });
    const semIsencao = brutoNecessario({
        pernas: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        tabela,
        lucroAlvo: alvo,
    });
    assert.ok(comIsencao.lessThan(semIsencao));
    assert.equal(comIsencao.toFixed(6), '1.001751');
    assert.equal(semIsencao.toFixed(6), '1.003255');
});

test('taxa somando 100% falha em vez de devolver número utilizável', () => {
    const absurda = montarTabelaDeTaxas({ padrao: new Decimal(1), isentos: [] });
    assert.throws(
        () => brutoNecessario({ pernas: ['A', 'B', 'C'], tabela: absurda, lucroAlvo: new Decimal('0.001') }),
        /Retenção inválida/,
    );
});

test('pernasIsentas explica POR QUE o triângulo ficou barato', () => {
    const isentas = pernasIsentas(['BTCUSDT', 'BTCFDUSD', 'FDUSDUSDT'], tabela);
    assert.deepEqual(isentas, ['BTCFDUSD', 'FDUSDUSDT']);
});
