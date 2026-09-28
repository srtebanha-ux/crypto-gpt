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
 * E o limiar de FORCA, que e uma pergunta diferente da de ruido — e esquecer
 * isso me fez cometer o mesmo erro tres vezes neste projeto.
 *
 * A primeira versao usou `liquidantes < liquidacoes/2`: inventada.
 * A segunda usou `fatiaDoMaior >= 0.5 && total >= 5`: inventada tambem, e
 * chamou de dono seis liquidacoes repartidas 3 e 3 entre dois enderecos.
 * A terceira — minha, em 2026-09-28 — trocou as duas por um teste de chance do
 * acaso, e ai chamou de dono 51 liquidacoes entre 17 enderecos com o maior
 * levando 22%. Medido: a chance do acaso ali e 0,26%, entao o desvio E real. E
 * mesmo assim NAO e dono.
 *
 * Porque as duas perguntas nao sao a mesma:
 *   - "o desvio e maior que o acaso?"   -> `chanceDoAcaso`. Com muitos eventos,
 *     qualquer desequilibrio minimo passa a ser detectavel.
 *   - "alguem esta levando a maior parte?" -> a FRACAO. E essa que decide se vale
 *     entrar, porque e ela que diz quanto sobra.
 *
 * O padrao de forca ja estava medido neste projeto e escrito no CLAUDE.md, do
 * caso real de 17 liquidantes: "fatia do maior perto de 50% e dominio; com dez
 * ou mais enderecos e ninguem acima de um terco, e mercado aberto. O maior tem
 * 3,3x a fatia media, nao 30x." Entao nao se inventa de novo: usa-se esse.
 */
export const FATIA_QUE_E_DOMINIO = 0.5;
export const FATIA_QUE_E_ABERTO = 1 / 3;
export const CAMPO_QUE_E_ABERTO = 10;

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
    const emPct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
    const vezesAJusta = c.fatiaDoMaior * c.jogadores;
    const quanto = `o maior levou ${c.doMaior} de ${c.total} (${emPct(c.fatiaDoMaior)}) entre ${c.jogadores} `
        + `endereços — ${vezesAJusta.toFixed(1)}x a fatia justa`;
    // "Campo estabelecido": se houvesse um concorrente a mais, ele provavelmente
    // teria aparecido. O limiar e o MESMO 5% — um padrao so, nao dois.
    const campoEstabelecido = chanceDeCampoMaior(c.total, c.jogadores) <= limiar;

    // A ordem abaixo e explicita de proposito. A versao anterior tinha os casos
    // espalhados e foi assim que dois defeitos entraram de uma vez.

    // 1) Um endereco sozinho. A conta do acaso nao enxerga este caso (sem
    //    alternativa, o sorteio e certo), entao quem decide e o campo.
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

    // 2) Campo de dois. "Ninguem domina" NAO e "aberta": dois bots dividindo
    //    igualmente e duopolio, e entrar ali e virar o terceiro numa corrida de
    //    dois. Um teste pegou isto.
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

    // 3) EVIDENCIA POSITIVA primeiro: metade ou mais, e nao por acaso. Isto vem
    //    antes do portao de forca de proposito. Um teste meu pegou a inversao: 25
    //    de 30 liquidacoes entre TRES enderecos — 83%, domínio obvio — saia como
    //    "nao da para dizer", porque com tres jogadores a fatia justa e 33% e o
    //    portao julgava que metade nao seria distinguivel. O portao existe para
    //    impedir afirmar AUSENCIA com amostra fraca, nao para barrar uma
    //    constatacao que a propria amostra ja mostrou.
    if (c.fatiaDoMaior >= FATIA_QUE_E_DOMINIO && chance <= limiar) {
        return {
            veredicto: 'tem dono',
            chance,
            porque: `${quanto}. Metade ou mais é domínio, e o acaso daria isso em no máximo ${emPct(chance)}`,
        };
    }

    // 4) A amostra tem FORCA para dizer que NAO tem dono?
    //
    // O limiar que importa nao e o extremo ("um levando TODAS"), e METADE, que e
    // onde comeca o dominio. Medido em 2026-09-28, na fatia que 0.05 ETH abre: 9
    // liquidacoes entre 4 enderecos. Um levando TODAS seria detectavel (0,0015%),
    // mas um levando METADE teria 19,57% de chance pelo acaso. Aquela amostra nao
    // distingue dominio de sorte — e mesmo assim o log publicou "fatia sem dono: o
    // gas compra oportunidade de verdade", empurrando dinheiro com base em nada.
    const metade = Math.ceil(c.total * FATIA_QUE_E_DOMINIO);
    const poder = chanceDoAcaso(c.total, c.jogadores, metade);
    if (poder > limiar) {
        return {
            veredicto: 'não dá para dizer',
            chance,
            porque: `${quanto}. Mas com ${c.total} liquidações entre ${c.jogadores} endereços, até um endereço `
                + `levando METADE teria ${emPct(poder)} de chance pelo acaso: esta amostra não distingue `
                + 'domínio de sorte, em nenhuma direção',
        };
    }

    // 5) Nao tem dono: fatia abaixo de um terco com campo largo. O padrao esta
    //    medido no CLAUDE.md, do caso de 17 liquidantes.
    if (c.fatiaDoMaior < FATIA_QUE_E_ABERTO && c.jogadores >= CAMPO_QUE_E_ABERTO) {
        return {
            veredicto: 'sem dono',
            chance,
            porque: `${quanto}. ${chance <= limiar
                ? `O desequilíbrio é real (o acaso daria em ${emPct(chance)}), mas ` : ''}`
                + `ninguém está acima de um terço com ${c.jogadores} endereços na mesa: `
                + 'é mercado aberto, não domínio',
        };
    }
    // Entre um terco e metade, ou com campo pequeno: nao se escolhe um lado. Esta
    // era a saida que faltava. O fallback antigo dizia "sem dono" sem olhar a
    // fracao, e por isso chamou de "sem dono" um maior com 45,5% em 11
    // liquidacoes — a faixa dela no log das 10:44 de 2026-09-28.
    return {
        veredicto: 'não dá para dizer',
        chance,
        porque: `${quanto}. Não chega a metade (domínio) nem fica abaixo de um terço com dez endereços `
            + `(aberto), e o acaso daria isso em ${emPct(chance)}: com este campo eu não escolho um lado`,
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
