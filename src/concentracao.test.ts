import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { montarPlacar } from './perdidas';
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
    //
    // A de 0.05 ETH: 9 entre 4, maior levou 4 (44%). Esta também não decide, e o
    // motivo é o mais importante de todos: com 9 liquidações entre 4 endereços, até
    // um endereço levando METADE teria 19,6% de chance pelo acaso. A amostra não
    // responde à pergunta. Mesmo assim o log das 10:44 publicou "fatia sem dono: o
    // gás compra oportunidade de verdade" — empurrando dinheiro com base em nada.
    const nove = quemTemDono(contarPorEndereco(
        ['0xA', '0xA', '0xA', '0xA', '0xB', '0xB', '0xC', '0xC', '0xD'],
    ));
    assert.equal(nove.veredicto, 'não dá para dizer');
    assert.match(nove.porque, /levando METADE teria 19\.6% de chance/);
    assert.match(nove.porque, /não distingue domínio de sorte/);
});

test('a faixa DELA com 45% em 11 liquidações: não dá para dizer, nem "sem dono"', () => {
    // O log das 10:44 de 2026-09-28: `naSuaFaixa: 11 entre 6 endereços; o maior
    // levou 5 de 11 (45%)` e o veredicto saiu SEM DONO. Errado: 45,5% não chega à
    // metade (domínio) nem fica abaixo de um terço com dez endereços (aberto). O
    // fallback antigo devolvia "sem dono" sem olhar a fração nenhuma.
    const d = quemTemDono(contarPorEndereco(
        ['0xA', '0xA', '0xA', '0xA', '0xA', '0xB', '0xB', '0xC', '0xD', '0xE', '0xF'],
    ));
    assert.equal(d.veredicto, 'não dá para dizer');
    assert.match(d.porque, /Não chega a metade/);
    assert.match(d.porque, /45\.5%/);
});

test('83% entre três endereços É domínio — o portão de força não pode barrar isso', () => {
    // 25 de 30 entre 3 endereços. Um teste meu pegou a inversão: o portão que
    // impede afirmar AUSÊNCIA com amostra fraca estava barrando uma constatação
    // POSITIVA que a própria amostra mostrava. Com três jogadores a fatia justa é
    // 33%, então "metade" não seria distinguível — mas 83% é.
    const d = quemTemDono(contarPorEndereco([
        ...Array(25).fill('0xA'), ...Array(3).fill('0xB'), ...Array(2).fill('0xC'),
    ]));
    assert.equal(d.veredicto, 'tem dono');
    assert.match(d.porque, /Metade ou mais é domínio/);
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

test('17 endereços com o maior levando 22% é mercado ABERTO — eu errei isto três vezes', () => {
    // Medido POR FORA em 2026-09-28: varredura própria da Base, 205 janelas,
    // cobertura 100%, 9,5 dias. 51 liquidações entre 17 endereços, distribuição
    // real 11/8/7/4/4/4/2/2 e nove com uma.
    //
    // O CLAUDE.md registra este exato caso como o erro nº 9: "17 jogadores,
    // nenhum acima de 20%, e um mercado ABERTO. O maior tem 3,3x a fatia média,
    // não 30x." A primeira regra chamou de concentrado, a segunda também, e a
    // minha — o teste de chance do acaso — chamou de TEM DONO, porque com 51
    // eventos um desvio de 3,7x é estatisticamente real.
    //
    // Real e dono não são a mesma coisa. Este teste existe para a quarta versão
    // desta regra não repetir a terceira.
    const dist = [11, 8, 7, 4, 4, 4, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const lista: string[] = [];
    dist.forEach((n, i) => { for (let j = 0; j < n; j++) lista.push(`0x${i}`); });
    assert.equal(lista.length, 51);

    const c = contarPorEndereco(lista);
    assert.equal(c.jogadores, 17);
    assert.equal(c.doMaior, 11);

    // O desvio É real: o acaso daria isso em 0,26% das vezes.
    const d = quemTemDono(c);
    assert.ok(d.chance < 0.01, `a chance devia ser pequena, veio ${d.chance}`);
    // E mesmo assim NÃO é dono.
    assert.equal(d.veredicto, 'sem dono');
    assert.match(d.porque, /mercado aberto, não domínio/);
    // A frase carrega as duas coisas: o desvio é real E a fatia é pequena.
    assert.match(d.porque, /3\.7x a fatia justa/);
});

test('metade continua sendo domínio, com desvio real', () => {
    // O padrão de força vem do CLAUDE.md: metade ou mais é domínio. Se a conta
    // nova não afirmasse nem isso, ela seria inútil na outra direção.
    const lista = [
        ...Array(20).fill('0xA'), ...Array(5).fill('0xB'), ...Array(5).fill('0xC'),
        ...Array(4).fill('0xD'), ...Array(3).fill('0xE'), ...Array(3).fill('0xF'),
    ];
    const d = quemTemDono(contarPorEndereco(lista));
    assert.equal(d.veredicto, 'tem dono');
    assert.match(d.porque, /Metade ou mais é domínio/);
});

test('entre um terço e metade eu não escolho um lado', () => {
    // 40% com desvio real não é nem "aberto" nem "domínio". Dizer qualquer um
    // dos dois seria inventar de novo.
    const lista = [
        ...Array(16).fill('0xA'), ...Array(6).fill('0xB'), ...Array(6).fill('0xC'),
        ...Array(4).fill('0xD'), ...Array(4).fill('0xE'), ...Array(2).fill('0xF'),
        '0xG', '0xH', '0xI', '0xJ', '0xK',
    ];
    const c = contarPorEndereco(lista);
    assert.ok(c.fatiaDoMaior > 1 / 3 && c.fatiaDoMaior < 0.5, `fatia ${c.fatiaDoMaior}`);
    const d = quemTemDono(c);
    assert.equal(d.veredicto, 'não dá para dizer');
    assert.match(d.porque, /Não chega a metade/);
});

test('lucro exatamente ZERO concorda com o placar, e o piso null não é piso zero', () => {
    // Zero é o valor que `lerRespostaDaCaca` devolve de propósito. A primeira
    // versão deste conserto usava `lessThanOrEqualTo` quando o piso era zero, e aí
    // um lucro de zero era "inviável" para o censo e "valia a pena" para o placar,
    // na MESMA linha de log. Uma regra em dois lugares tem de dar a mesma resposta.
    const d = (x: string) => new Decimal(x);
    const zero = repartirPorFaixa([{ nome: 'zero', lucroUsd: d('0') }], { de: d('0'), ate: d('100') });
    assert.deepEqual(zero.dentro.map((a) => a.nome), ['zero']);
    assert.equal(zero.abaixoDoPiso.length, 0);
    assert.equal(montarPlacar([{
        devedor: '0x', bloco: 1, liquidante: '0x',
        dividaUsd: d('0'), lucroUsd: d('0'), cobertura: 'brasa' as const,
    }], d('0')).valiam.length, 1, 'o placar conta o zero; o censo tem de concordar');

    // E piso DESCONHECIDO não é piso zero: com teto mas sem piso, prejuízo fica
    // abaixo do piso, não dentro.
    const semPiso = repartirPorFaixa([{ nome: 'perda', lucroUsd: d('-0.29') }], { de: null, ate: d('45') });
    assert.deepEqual(semPiso.abaixoDoPiso.map((a) => a.nome), ['perda']);
    assert.equal(semPiso.dentro.length, 0);
});

test('não existe regra de cartel, e isso é deliberado', () => {
    // Eu perdi o critério dos três maiores ao reescrever, tentei devolvê-lo no
    // mesmo dia, e a versão nova estava errada nos DOIS sentidos: chamava de
    // "tem dono" uma divisão PERFEITAMENTE justa de 20/20/20 entre três, e mesmo
    // assim não consertava o caso que a motivou (12/10/8). Três erros numa
    // tentativa. Então: "não dá para dizer", que é verdade.
    const fazer = (dist: number[]) => {
        const l: string[] = [];
        dist.forEach((n, i) => { for (let j = 0; j < n; j++) l.push(`0x${i}`); });
        return quemTemDono(contarPorEndereco(l));
    };
    // A divisão mais justa possível entre três NÃO pode sair como domínio.
    assert.notEqual(fazer([20, 20, 20]).veredicto, 'tem dono');
    // E o caso que motivava o critério perdido sai como "não sei" — honesto.
    assert.equal(fazer([12, 10, 8]).veredicto, 'não dá para dizer');
    // Domínio de um só continua sendo detectado, que é o que não pode se perder.
    assert.equal(fazer([25, 3, 2]).veredicto, 'tem dono');
});
