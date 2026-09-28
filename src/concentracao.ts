// Arquivo: src/concentracao.ts
//
// "Esta faixa tem dono?" — a pergunta que decide se vale entrar numa faixa de
// liquidacao, medida contra o ACASO em vez de contra um limiar inventado.
//
// Este arquivo existe por causa do erro que o CLAUDE.md registra como o pior de
// todos, cometido duas vezes:
//
//   1. A primeira regra foi `liquidantes < liquidacoes/2`. Arbitraria, e nao
//      mede concentracao nenhuma: com 17 liquidantes e o maior levando 20% ela
//      imprimiu "CONCENTRADO", o que empurraria a dona do bot a desistir de um
//      mercado ABERTO.
//   2. A segunda foi `total >= 5 && (fatiaDoMaior >= 0.5 || ...)`. Parecia
//      sobria, e em 2026-09-27 ela imprimiu `>>> ESSA FATIA TEM DONO` para
//      SEIS liquidacoes repartidas 3 e 3 entre DOIS enderecos — e essa era a
//      base do argumento "todas as fatias que o gas abre tem dono", que e a
//      espinha da decisao de nao colocar dinheiro.
//
// A conta do acaso, feita em 2026-09-27, mostra o tamanho do problema. Se os
// enderecos observados fossem igualmente bons e as liquidacoes caissem entre
// eles por sorteio, a chance de ver aquela concentracao, ou pior, seria:
//
//     6 eventos, 2 enderecos, maior levou 3   ->  100%    (ou seja: nada)
//     9 eventos, 4 enderecos, maior levou 4   ->   63%
//    10 eventos, 5 enderecos, maior levou 5   ->   16%    (a faixa dela)
//    57 eventos, 17 enderecos, maior levou 11 ->  0,73%
//    20 eventos, 5 enderecos, maior levou 10  ->   1,3%   (os MESMOS 50%)
//
// As duas primeiras linhas eram "TEM DONO" no log. Nao tem dono: tem amostra
// pequena. E as duas ultimas mostram por que a fracao sozinha nao serve: 50% de
// 10 e sorte comum, 50% de 20 e estrutura.
//
// Entao aqui o veredicto sai da chance, nao da fracao, e quando a amostra nao
// permite afirmar o veredicto DIZ isso em vez de escolher um lado.
import { Decimal } from 'decimal.js';

/** Quantos eventos, quantos jogadores, e quanto levou o maior. */
export interface Contagem {
    total: number;
    jogadores: number;
    /** Eventos do maior, em CONTAGEM. "5 de 10" e "50 de 100" nao sao a mesma prova. */
    doMaior: number;
    doTop3: number;
    fatiaDoMaior: number;
    fatiaDoTop3: number;
}

/** Conta por endereco. Uma so implementacao, para as duas perguntas do censo. */
export function contarPorEndereco(enderecos: string[]): Contagem {
    const por = new Map<string, number>();
    for (const e of enderecos) {
        const k = e.toLowerCase();
        por.set(k, (por.get(k) ?? 0) + 1);
    }
    const ordenado = [...por.values()].sort((a, b) => b - a);
    const total = enderecos.length;
    const doMaior = ordenado[0] ?? 0;
    const doTop3 = ordenado.slice(0, 3).reduce((a, b) => a + b, 0);
    return {
        total,
        jogadores: por.size,
        doMaior,
        doTop3,
        fatiaDoMaior: total === 0 ? 0 : doMaior / total,
        fatiaDoTop3: total === 0 ? 0 : doTop3 / total,
    };
}

/**
 * A chance de o ACASO produzir esta concentracao, ou pior.
 *
 * Hipotese nula: os `jogadores` enderecos que apareceram eram igualmente bons, e
 * cada uma das `total` liquidacoes foi para um deles por sorteio. A pergunta e a
 * probabilidade de ALGUM deles levar `doMaior` ou mais.
 *
 * O calculo e o limite da uniao — `jogadores` vezes a cauda de uma binomial com
 * probabilidade 1/jogadores — preso em 1. Ele e SEMPRE maior ou igual a
 * probabilidade exata, o que significa que errar aqui erra para o lado de "nao
 * da para afirmar". Esse e o lado seguro: o defeito que este arquivo conserta foi
 * afirmar demais.
 *
 * Conferido contra o calculo exato por inclusao-exclusao em 2026-09-27: para os
 * casos reais do log ele da 16,40% contra 16,37% exatos, 0,73% contra 0,73%, e
 * 1,30% contra 1,30%. A maior diferenca medida foi 66,29% contra 62,83% — e nessa
 * faixa a resposta e "nao da para dizer" com qualquer um dos dois.
 *
 * A soma e feita em logaritmo para nao estourar por baixo: `q^total` com muitos
 * eventos vira zero em ponto flutuante, e uma cauda somada a partir de zero
 * devolveria 0% — "impossivel pelo acaso" para qualquer coisa, que e ausencia
 * com cara de resposta outra vez.
 *
 * LIMITE HONESTO desta conta: `jogadores` e quem a gente VIU, nao quem existe.
 * Se dois bots disputam e um deles nunca ganhou, ele nao aparece na contagem e a
 * conta o ignora. Ela responde "entre os que apareceram, um esta dominando ou
 * eles estao se alternando?", que e a pergunta util, nao "quantos bots existem".
 */
export function chanceDoAcaso(total: number, jogadores: number, doMaior: number): number {
    if (total <= 0 || jogadores <= 0) return 1;
    if (doMaior > total) return 0;
    if (doMaior <= 0) return 1;
    // Um jogador so: o sorteio nao tem alternativa, entao ele leva tudo com
    // certeza. A conta nao sabe distinguir "dono" de "unico que apareceu" — quem
    // decide isso e `quemTemDono`, olhando o tamanho da amostra.
    if (jogadores === 1) return 1;
    const p = 1 / jogadores;
    const lnP = Math.log(p);
    const lnQ = Math.log(1 - p);
    // lnPmf(0) = total * ln(q); depois lnPmf(i+1) = lnPmf(i) + ln((n-i)/(i+1)) + ln(p/q)
    let lnPmf = total * lnQ;
    let cauda = 0;
    for (let i = 0; i <= total; i++) {
        if (i >= doMaior) cauda += Math.exp(lnPmf);
        if (i < total) lnPmf += Math.log((total - i) / (i + 1)) + lnP - lnQ;
    }
    return Math.min(1, jogadores * cauda);
}

/**
 * A chance de um concorrente A MAIS existir e nao ter aparecido NENHUMA vez.
 *
 * Responde a pergunta que a contagem de dominio nao responde: o campo e estreito
 * de verdade, ou so parece estreito porque a amostra e curta? Se havia
 * `jogadores + 1` enderecos igualmente bons disputando, qual a probabilidade de
 * pelo menos um deles ficar de fora de `total` sorteios?
 *
 * Inclusao-exclusao exata sobre "o endereco i esta ausente".
 *
 * Isto substitui um `total >= 10` que eu ia escrever a mao. Medido em
 * 2026-09-27: com 2 enderecos vistos, o campo estreito so fica estabelecido a
 * partir de ~12 liquidacoes (10 dao 5,2%, logo acima do limiar; 12 dao 2,3%). O
 * numero saiu da conta, nao de mim — que e o erro nº 9 do CLAUDE.md.
 */
export function chanceDeCampoMaior(total: number, jogadores: number): number {
    if (total <= 0 || jogadores <= 0) return 1;
    const k = jogadores + 1;
    let soma = 0;
    for (let i = 1; i <= k; i++) {
        // C(k,i) calculado incrementalmente para nao depender de fatorial grande.
        let c = 1;
        for (let t = 0; t < i; t++) c = (c * (k - t)) / (t + 1);
        soma += (i % 2 === 1 ? 1 : -1) * c * Math.pow((k - i) / k, total);
    }
    return Math.min(1, Math.max(0, soma));
}

export type Veredicto = 'tem dono' | 'sem dono' | 'não dá para dizer';

export interface Dono {
    veredicto: Veredicto;
    /** A chance do acaso, entre 0 e 1. */
    chance: number;
    porque: string;
}

/**
 * O limiar: abaixo de 5% de chance a gente afirma, acima nao.
 *
 * E uma convencao, e esta escrita aqui em vez de espalhada para poder ser
 * discutida num lugar so. O que NAO e convencao e a direcao do erro: com o
 * limite da uniao, 5% aqui garante no maximo 5% de chance de chamar de "dono"
 * uma faixa que e sorteio — e nunca o contrario, que e o erro caro.
 */
export const CHANCE_QUE_CONVENCE = 0.05;

/**
 * Tem dono, nao tem, ou nao da para dizer.
 *
 * As tres respostas existem de proposito. O log antigo tinha duas, e por isso
 * tinha de escolher um lado para SEIS liquidacoes entre DOIS enderecos. "Nao da
 * para dizer" e a resposta verdadeira ali, e e a que faz a dona do bot esperar
 * mais dados em vez de decidir com barulho.
 */
export function quemTemDono(c: Contagem, limiar = CHANCE_QUE_CONVENCE): Dono {
    if (c.total === 0) return { veredicto: 'não dá para dizer', chance: 1, porque: 'nenhuma liquidação aqui' };
    const chance = chanceDoAcaso(c.total, c.jogadores, c.doMaior);
    // Um endereco sozinho em toda a faixa: ninguem mais apareceu para disputar.
    // A conta do acaso nao enxerga isso (sem alternativa, o sorteio e certo),
    // entao quem decide e a amostra: com poucos eventos pode ser coincidencia de
    // quem estava online; com muitos, e a faixa dele.
    // "Campo estabelecido" quer dizer: se houvesse um concorrente a mais, ele
    // provavelmente teria aparecido. A conta esta em `chanceDeCampoMaior`, e o
    // limiar e o MESMO 5% do dominio — um padrao so, nao dois.
    const campoEstabelecido = chanceDeCampoMaior(c.total, c.jogadores) <= limiar;
    if (c.jogadores === 1) {
        return campoEstabelecido
            ? {
                veredicto: 'tem dono',
                chance,
                porque: `um endereço levou TODAS as ${c.total} e mais ninguém apareceu — se houvesse um segundo, `
                    + 'já teria ganhado alguma',
            }
            : {
                veredicto: 'não dá para dizer',
                chance,
                porque: `só ${c.total} liquidações, todas do mesmo endereço: pode ser quem estava online`,
            };
    }
    const emPct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
    if (chance <= limiar) {
        return {
            veredicto: 'tem dono',
            chance,
            porque: `o maior levou ${c.doMaior} de ${c.total} entre ${c.jogadores} endereços, `
                + `e o acaso daria isso em no máximo ${emPct(chance)} das vezes`,
        };
    }
    // Acima do limiar nao ha prova de dominio. Mas "sem dominador" NAO e a mesma
    // coisa que "aberta", e a diferenca custou um teste para aparecer: SEIS
    // liquidacoes repartidas 3 e 3 entre DOIS enderecos nao tem dominador nenhum
    // — e sao dois bots dividindo a fatia igualmente. Entrar ali nao e entrar num
    // mercado aberto, e virar o terceiro numa corrida de dois.
    //
    // Entao "sem dono" exige que exista campo: com um ou dois enderecos vistos, a
    // resposta honesta e que nao se sabe se o campo e estreito por natureza ou por
    // falta de amostra.
    if (c.jogadores <= 2) {
        return campoEstabelecido
            ? {
                veredicto: 'tem dono',
                chance,
                porque: `só ${c.jogadores} endereços em ${c.total} liquidações, e nenhum terceiro apareceu: `
                    + 'é um duopólio de verdade, não falta de amostra. Ninguém domina os dois, '
                    + 'mas entrar é virar o terceiro numa corrida de dois',
            }
            : {
                veredicto: 'não dá para dizer',
                chance,
                porque: `só ${c.jogadores} endereços apareceram em ${c.total} liquidações: ninguém domina, mas dois `
                    + 'dividindo igualmente também não é mercado aberto — e esta amostra não separa '
                    + 'duopólio de coincidência',
            };
    }
    // E a amostra tem de ter FORCA: se mesmo um endereco levando TODAS seria comum
    // por acaso, ela nao poderia ter detectado dominio nem se existisse, e dizer
    // "sem dono" seria confundir "nao vi" com "nao tem".
    const piorPossivel = chanceDoAcaso(c.total, c.jogadores, c.total);
    if (piorPossivel > limiar) {
        return {
            veredicto: 'não dá para dizer',
            chance,
            porque: `só ${c.total} liquidações entre ${c.jogadores} endereços: mesmo um endereço levando TODAS `
                + `seria comum por acaso (${emPct(piorPossivel)}), então esta amostra não decide nada`,
        };
    }
    return {
        veredicto: 'sem dono',
        chance,
        porque: `o maior levou ${c.doMaior} de ${c.total} entre ${c.jogadores} endereços, `
            + `e o acaso daria isso em ${emPct(chance)} das vezes — não é domínio`,
    };
}

/**
 * A contagem em uma frase, com a CONTAGEM do maior e nao so a fracao.
 *
 * "o maior levou 50%" saia igual para 5 de 10 e para 50 de 100, e as duas coisas
 * nao sao a mesma prova. Ver "5 de 10" ao lado de "50%" e o que impede a leitura
 * errada antes mesmo do veredicto.
 */
export function comoLerAContagem(c: Contagem): string {
    if (c.total === 0) return 'nenhuma';
    const pct = (n: number) => `${Math.round((n / c.total) * 100)}%`;
    return `${c.total} entre ${c.jogadores} endereços; o maior levou ${c.doMaior} de ${c.total} (${pct(c.doMaior)})`
        + `, os três maiores ${c.doTop3} de ${c.total} (${pct(c.doTop3)})`;
}

/** As tres partes em que uma faixa de tiro reparte uma lista de liquidacoes. */
export interface PorFaixa<T> {
    /** Lucro abaixo do piso: nao paga o proprio gas. Nao e "pequena", e inviavel. */
    abaixoDoPiso: T[];
    dentro: T[];
    acimaDoTeto: T[];
    /** Sem cotacao da moeda: nao se sabe onde cai, e inventar seria pior. */
    semCotacao: T[];
}

/**
 * Reparte liquidacoes nas tres partes da faixa — e e UMA implementacao.
 *
 * Existe porque o censo tinha o filtro `dentroDaFaixa` num lugar e a NEGACAO
 * dele (`!dentroDaFaixa.includes(a)`) em outro, chamada de `acimaDaSuaFaixa`.
 * Enquanto o piso era zero as duas coisas coincidiam por acaso. Quando o piso
 * virou US$ 0,45 — o lucro minimo que paga o proprio gas — a negacao passou a
 * conter as 38 liquidacoes de POEIRA que ficam ABAIXO da faixa, e elas
 * dominaram a contagem: o log de 2026-09-27 22:12 publicou
 * `acimaDaSuaFaixa: 47 entre 15 endereços; o maior levou 17%` e dai saiu o
 * veredicto "a de cima e aberta", que nao mede a faixa de cima nenhuma.
 *
 * Numero certo, etiqueta que mente. Com tres grupos nomeados e uma soma que tem
 * de fechar, a proxima negacao de filtro nao tem onde se esconder.
 */
export function repartirPorFaixa<T extends { lucroUsd: Decimal | null }>(
    lista: T[],
    faixa: { de: Decimal | null; ate: Decimal | null } | null,
): PorFaixa<T> {
    const r: PorFaixa<T> = { abaixoDoPiso: [], dentro: [], acimaDoTeto: [], semCotacao: [] };
    for (const a of lista) {
        if (a.lucroUsd === null) { r.semCotacao.push(a); continue; }
        if (faixa === null) {
            // Sem faixa (sem cotacao do ETH, sem saldo) nao se sabe o piso. O que
            // se sabe e que lucro nao-positivo nao serve, e isso nao e chute.
            (a.lucroUsd.greaterThan(0) ? r.dentro : r.abaixoDoPiso).push(a);
            continue;
        }
        if (faixa.de !== null && a.lucroUsd.lessThan(faixa.de)) { r.abaixoDoPiso.push(a); continue; }
        if (faixa.ate !== null && a.lucroUsd.greaterThan(faixa.ate)) { r.acimaDoTeto.push(a); continue; }
        r.dentro.push(a);
    }
    return r;
}
