import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    contarPorEndereco, chanceDoAcaso, chanceDeCampoMaior, quemTemDono, comoLerAContagem,
    repartirPorFaixa, CHANCE_QUE_CONVENCE,
} from './concentracao';

test('a chance do acaso bate com o cálculo exato nos casos reais de 2026-09-27', () => {
    // Conferido contra inclusão-exclusão exata. O limite da união é sempre >= o
    // exato, então ele erra para o lado de "não dá para afirmar".
    // 10 eventos, 5 endereços, maior levou 5 — a faixa DELA no log das 22:12.
    assert.equal((chanceDoAcaso(10, 5, 5) * 100).toFixed(2), '16.40');   // exato: 16.37
    // 57 eventos, 17 endereços, maior levou 11 — o mercado todo.
    assert.equal((chanceDoAcaso(57, 17, 11) * 100).toFixed(2), '0.73');  // exato: 0.73
    // 20 eventos, 5 endereços, maior levou 10 — os MESMOS 50% da faixa dela.
    assert.equal((chanceDoAcaso(20, 5, 10) * 100).toFixed(2), '1.30');   // exato: 1.30
    // A fração sozinha não distingue os dois: 50% e 50%. A chance distingue 12x.
    assert.ok(chanceDoAcaso(10, 5, 5) > chanceDoAcaso(20, 5, 10) * 10);
});

test('a soma não estoura por baixo com muitos eventos', () => {
    // `q^total` vira zero em ponto flutuante e a cauda somada a partir de zero
    // devolveria 0% — "impossível pelo acaso" para qualquer coisa.
    const c = chanceDoAcaso(4000, 2, 2100);
    assert.ok(Number.isFinite(c) && c > 0 && c < 1, `chance implausível: ${c}`);
    // Metade exata de muitos eventos entre dois: o acaso dá isso o tempo todo.
    assert.ok(chanceDoAcaso(4000, 2, 2000) > 0.5);
});

test('SEIS liquidações entre DOIS endereços não têm dono — tinham, no log antigo', () => {
    // Esta é a linha que sustentava "todas as fatias que o gás abre têm dono", e
    // com ela a decisão de não colocar dinheiro. A regra antiga era
    // `total >= 5 && fatiaDoMaior >= 0.5`: 3 de 6 passa, e o acaso dá 100%.
    const seis = contarPorEndereco(['0xA', '0xA', '0xA', '0xB', '0xB', '0xB']);
    assert.equal(seis.total, 6);
    assert.equal(seis.doMaior, 3);
    assert.equal(seis.fatiaDoMaior, 0.5, 'a fração que a regra antiga olhava');
    const d = quemTemDono(seis);
    assert.equal(d.veredicto, 'não dá para dizer');
    // E o motivo é o campo estreito, não a fração: ninguém domina, mas dois
    // dividindo igualmente não é mercado aberto. Dizer "sem dono" aqui seria
    // outra afirmação falsa, só para o outro lado.
    assert.match(d.porque, /não é mercado aberto/);

    // A de 0.05 ETH: 9 entre 4, maior levou 4. Aqui há campo e a amostra teria
    // força para ver domínio total, então "sem dono" é honesto — e a frase carrega
    // a chance para ela poder julgar sozinha.
    const nove = quemTemDono(contarPorEndereco(
        ['0xA', '0xA', '0xA', '0xA', '0xB', '0xB', '0xC', '0xC', '0xD'],
    ));
    assert.equal(nove.veredicto, 'sem dono');
    assert.ok(nove.chance > 0.5, 'e a chance sai escrita: 66% de acaso não é prova de nada');
    assert.match(nove.porque, /não é domínio/);
});

test('a faixa DELA não tem dono comprovado — o log das 22:12 afirmou que tinha', () => {
    // 10 liquidações, 5 endereços, o maior levou 5. O log publicou "a SUA faixa
    // tem dono: entrar é briga", que é o oposto da decisão registrada no
    // CLAUDE.md. O acaso dá essa concentração em 16% das vezes.
    const dela = contarPorEndereco(['0xA', '0xA', '0xA', '0xA', '0xA', '0xB', '0xB', '0xC', '0xD', '0xE']);
    assert.equal(dela.total, 10);
    assert.equal(dela.doMaior, 5);
    const d = quemTemDono(dela);
    assert.notEqual(d.veredicto, 'tem dono', 'não se afirma domínio com 16% de chance de acaso');
    assert.ok(d.chance > CHANCE_QUE_CONVENCE);

    // Os MESMOS 50%, com o dobro dos eventos, JÁ afirmam.
    const dobro = contarPorEndereco([
        ...Array(10).fill('0xA'), ...Array(4).fill('0xB'), ...Array(3).fill('0xC'), '0xD', '0xE', '0xF',
    ]);
    assert.equal(dobro.doMaior / dobro.total, 0.5, 'mesma fração');
    assert.equal(quemTemDono(dobro).veredicto, 'tem dono');
});

test('domínio de verdade continua sendo chamado de domínio', () => {
    // 25 de 30 entre 3 endereços. Se a conta nova não afirmasse nem isso, ela
    // seria inútil de outra maneira.
    const d = quemTemDono(contarPorEndereco([
        ...Array(25).fill('0xA'), ...Array(3).fill('0xB'), ...Array(2).fill('0xC'),
    ]));
    assert.equal(d.veredicto, 'tem dono');
    assert.ok(d.chance < 0.0001);
});

test('um endereço sozinho: com poucas não se afirma, com muitas sim', () => {
    // A conta do acaso não enxerga este caso (sem alternativa, o sorteio é certo),
    // então quem decide é a amostra.
    assert.equal(quemTemDono(contarPorEndereco(Array(4).fill('0xA'))).veredicto, 'não dá para dizer');
    const muitas = quemTemDono(contarPorEndereco(Array(12).fill('0xA')));
    assert.equal(muitas.veredicto, 'tem dono');
    assert.match(muitas.porque, /mais ninguém apareceu/);
});

test('a frase mostra a CONTAGEM do maior, não só a fração', () => {
    // "o maior levou 50%" saía igual para 5 de 10 e 50 de 100.
    assert.match(comoLerAContagem(contarPorEndereco(
        ['0xA', '0xA', '0xA', '0xA', '0xA', '0xB', '0xB', '0xC', '0xD', '0xE'],
    )), /10 entre 5 endereços; o maior levou 5 de 10 \(50%\)/);
    assert.equal(comoLerAContagem(contarPorEndereco([])), 'nenhuma');
});

test('repartirPorFaixa: a poeira NÃO vira "acima da faixa" — era o defeito', () => {
    // O log das 22:12 disse `acimaDaSuaFaixa: 47 entre 15 endereços; o maior 17%`.
    // Esse grupo era `!dentroDaFaixa.includes(a)`, e continha as 38 liquidações de
    // POEIRA abaixo do piso. Daí saiu "a de cima é aberta", que não media a faixa
    // de cima nenhuma.
    const d = (x: string) => new Decimal(x);
    const lista = [
        { nome: 'poeira', lucroUsd: d('0.01') },
        { nome: 'poeira2', lucroUsd: d('0.44') },
        { nome: 'migalha', lucroUsd: d('0.45') },   // exatamente no piso: dentro
        { nome: 'migalha2', lucroUsd: d('23.11') },
        { nome: 'borda', lucroUsd: d('45.48') },    // exatamente no teto: dentro
        { nome: 'grande', lucroUsd: d('573.18') },
        { nome: 'muda', lucroUsd: null },
    ];
    const r = repartirPorFaixa(lista, { de: d('0.45'), ate: d('45.48') });
    assert.deepEqual(r.abaixoDoPiso.map((a) => a.nome), ['poeira', 'poeira2']);
    assert.deepEqual(r.dentro.map((a) => a.nome), ['migalha', 'migalha2', 'borda']);
    assert.deepEqual(r.acimaDoTeto.map((a) => a.nome), ['grande']);
    assert.deepEqual(r.semCotacao.map((a) => a.nome), ['muda']);

    // A asserção que impede a próxima negação de filtro de mentir: a soma fecha.
    assert.equal(
        r.abaixoDoPiso.length + r.dentro.length + r.acimaDoTeto.length + r.semCotacao.length,
        lista.length,
    );
});

test('repartirPorFaixa sem faixa: nada é declarado acima nem abaixo por invenção', () => {
    const d = (x: string) => new Decimal(x);
    const r = repartirPorFaixa([
        { nome: 'boa', lucroUsd: d('10') },
        { nome: 'zero', lucroUsd: d('0') },
        { nome: 'perda', lucroUsd: d('-0.3') },
        { nome: 'muda', lucroUsd: null },
    ], null);
    assert.equal(r.acimaDoTeto.length, 0, 'sem teto conhecido, ninguém está acima dele');
    assert.deepEqual(r.dentro.map((a) => a.nome), ['boa']);
    // Lucro não-positivo abaixo de qualquer piso não é chute: é aritmética.
    assert.deepEqual(r.abaixoDoPiso.map((a) => a.nome), ['zero', 'perda']);
});

test('o campo estreito: 12 liquidações estabelecem, 10 ainda não', () => {
    // Este era um `total >= 10` que eu ia escrever a mão. O número sai da conta:
    // se houvesse um terceiro endereço igualmente bom, qual a chance de ele não
    // ter ganhado nenhuma? Medido em 2026-09-27.
    assert.equal((chanceDeCampoMaior(10, 2) * 100).toFixed(1), '5.2', 'logo ACIMA do limiar de 5%');
    assert.equal((chanceDeCampoMaior(12, 2) * 100).toFixed(1), '2.3', 'já abaixo');
    assert.ok(chanceDeCampoMaior(10, 2) > CHANCE_QUE_CONVENCE);
    assert.ok(chanceDeCampoMaior(12, 2) <= CHANCE_QUE_CONVENCE);
    // Quanto mais gente já vista, mais amostra é preciso para dizer "não tem mais".
    assert.ok(chanceDeCampoMaior(12, 5) > chanceDeCampoMaior(12, 2));
    // Nenhuma liquidação não estabelece nada.
    assert.equal(chanceDeCampoMaior(0, 3), 1);
});

test('duopólio comprovado é dono, duopólio de amostra curta não é', () => {
    const doisEnderecos = (n: number) => contarPorEndereco(
        Array.from({ length: n }, (_, i) => (i % 2 === 0 ? '0xA' : '0xB')),
    );
    // 6 eventos: a fatia real que 0.01 ETH abria. Não decide.
    assert.equal(quemTemDono(doisEnderecos(6)).veredicto, 'não dá para dizer');
    // 40 eventos, sempre os mesmos dois, nenhum terceiro nunca: é duopólio.
    const muitos = quemTemDono(doisEnderecos(40));
    assert.equal(muitos.veredicto, 'tem dono');
    assert.match(muitos.porque, /duopólio de verdade/);
});
