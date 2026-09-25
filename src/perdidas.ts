// Arquivo: src/perdidas.ts
//
// O placar das que passaram: quantas liquidacoes aconteceram na Base, quantas
// eram suas, e — a pergunta que decide tudo — se voce estava ou nao olhando
// para a pessoa certa quando aconteceu.
//
// Existe porque `alvosCaidos: 0` nao distingue duas coisas muito diferentes:
// "nao teve liquidacao nenhuma" e "teve varias e voce nao viu". As duas dao
// zero no log, e a resposta certa para cada uma e oposta.
import { Decimal } from 'decimal.js';
import type { Liquidacao } from './liquidacoes';

/**
 * O agio que a Aave paga a quem liquida. 5% e o valor tipico na Base; varia
 * por ativo, entao isto e estimativa rotulada como estimativa.
 */
export const AGIO = new Decimal(0.05);

/**
 * Quanto se perde vendendo a garantia, em fracao do que foi coberto.
 *
 * Sai da medicao do pool da Aerodrome: premio do flash loan (0,05%) mais a
 * taxa do pool mais o escorregamento numa venda pequena dentro de US$4,4
 * milhoes. Para dividas grandes o escorregamento cresce e este numero fica
 * otimista — por isso `lucroEstimado` e estimativa, nao promessa.
 */
export const CUSTO_DA_VENDA = new Decimal(0.0059);

/** Gas de uma cacada na Base, em dolares. Centavos, mas nao zero. */
export const GAS_USD = new Decimal(0.3);

/**
 * A Aave so deixa cobrir metade da divida enquanto a saude esta entre 0,95 e 1.
 * O mesmo motivo de `quantoPedirEmprestado` existir.
 */
export const FATIA_COBRIVEL = new Decimal(2);

/**
 * Quanto ESTA liquidacao teria dado de lucro, se fosse sua.
 *
 * Note que o lucro nao e a divida: e o agio sobre a METADE da divida, menos o
 * custo de vender a garantia. Uma liquidacao de US$4.000 rende uns US$88, e
 * nao US$4.000 — confundir os dois e o erro que ja apareceu duas vezes neste
 * projeto, sempre no mesmo sentido: otimista.
 */
export function lucroEstimado(dividaUsd: Decimal): Decimal {
    const coberto = dividaUsd.dividedBy(FATIA_COBRIVEL);
    return coberto.mul(AGIO).minus(coberto.mul(CUSTO_DA_VENDA)).minus(GAS_USD);
}

/** Converte um valor cru para dolares. `null` quando falta preco ou casas. */
export function emDolar(
    cru: bigint | Decimal,
    casas: number | undefined,
    precoDoOraculo: Decimal | undefined,
): Decimal | null {
    if (casas === undefined || precoDoOraculo === undefined) return null;
    const bruto = cru instanceof Decimal ? cru : new Decimal(cru.toString());
    // O oraculo da Aave responde em 8 casas.
    return bruto.dividedBy(new Decimal(10).pow(casas)).mul(precoDoOraculo).dividedBy(1e8);
}

/**
 * Onde o devedor estava, do ponto de vista do bot, quando foi liquidado.
 *
 * Esta e a resposta que decide o que fazer a seguir, e por isso ela existe:
 *
 *   'brasa'     — o bot olhava essa pessoa a cada 8 segundos e perdeu mesmo
 *                 assim. Problema de VELOCIDADE: outro chegou antes.
 *   'quente'    — so seria relido se o preco andasse. Problema de GATILHO.
 *   'na lista'  — conhecido, mas so visto na varredura de hora em hora.
 *   'nem sabia' — nao estava nem na lista de devedores. Problema de COBERTURA:
 *                 a janela de 30 dias nao o alcancou.
 *
 * Conselho generico ("seja mais rapido") nao serve para nada. Saber em qual
 * dos quatro baldes as perdas caem serve.
 */
export type Cobertura = 'brasa' | 'quente' | 'na lista' | 'nem sabia';

export function ondeEuEstava(
    devedor: string,
    brasa: Set<string>,
    quentes: Set<string>,
    todos: Set<string>,
): Cobertura {
    const d = devedor.toLowerCase();
    if (brasa.has(d)) return 'brasa';
    if (quentes.has(d)) return 'quente';
    if (todos.has(d)) return 'na lista';
    return 'nem sabia';
}

export interface Perdida {
    devedor: string;
    bloco: number;
    liquidante: string;
    dividaUsd: Decimal | null;
    lucroUsd: Decimal | null;
    cobertura: Cobertura;
}

export interface PlacarDasPerdidas {
    total: number;
    /** Quantas tinham valor conhecido. O resto entra como "sem cotacao". */
    comCotacao: number;
    /** As que teriam dado lucro acima do piso. */
    valiam: Perdida[];
    somaDoLucroPerdido: Decimal;
    /** Quantas caíram em cada balde, entre as que valiam. */
    porCobertura: Record<Cobertura, number>;
}

/**
 * Monta o placar, contando TODAS e destacando as que valiam.
 *
 * O piso existe porque liquidacao de US$50 de divida rende US$1 e nao paga o
 * gas; conta-la como "perdida" inflaria o numero e esconderia o que importa.
 */
export function montarPlacar(perdidas: Perdida[], pisoDeLucroUsd = new Decimal(20)): PlacarDasPerdidas {
    const porCobertura: Record<Cobertura, number> = { brasa: 0, quente: 0, 'na lista': 0, 'nem sabia': 0 };
    const valiam: Perdida[] = [];
    let soma = new Decimal(0);
    let comCotacao = 0;
    for (const p of perdidas) {
        if (p.lucroUsd === null) continue;
        comCotacao += 1;
        if (p.lucroUsd.lessThan(pisoDeLucroUsd)) continue;
        valiam.push(p);
        soma = soma.plus(p.lucroUsd);
        porCobertura[p.cobertura] += 1;
    }
    // Maior lucro primeiro. Ordenar por outra coisa e fatiar viraria amostra
    // com cara de ranking — o defeito mais repetido deste projeto.
    valiam.sort((a, b) => b.lucroUsd!.comparedTo(a.lucroUsd!));
    return { total: perdidas.length, comCotacao, valiam, somaDoLucroPerdido: soma, porCobertura };
}

/**
 * O diagnostico em uma frase, a partir de onde as perdas caíram.
 *
 * Existe para o placar nao virar uma tabela que ninguem sabe ler. O balde
 * maior diz o que consertar, e cada um pede um conserto diferente.
 */
export function oQueIssoQuerDizer(placar: PlacarDasPerdidas): string {
    if (placar.valiam.length === 0) {
        return 'Nenhuma liquidação na sua faixa de lucro. Não foi velocidade nem cobertura: não teve.';
    }
    const c = placar.porCobertura;
    const maior = (Object.keys(c) as Cobertura[]).reduce((a, b) => (c[b] > c[a] ? b : a));
    switch (maior) {
        case 'brasa':
            return 'O bot ESTAVA olhando essas pessoas a cada ciclo e perdeu assim mesmo. É velocidade: outro chegou antes. Encurtar o ciclo é o que mudaria.';
        case 'quente':
            return 'Essas só seriam relidas se o preço andasse o bastante. É o gatilho: caíram por juros ou empréstimo novo, que não aparecem no oráculo.';
        case 'na lista':
            return 'Conhecidas, mas só vistas na varredura de hora em hora. Aumentar a brasa ou varrer mais vezes é o que mudaria.';
        case 'nem sabia':
            return 'Nem estavam na lista de devedores. É cobertura: a janela de 30 dias não alcançou essas pessoas.';
    }
}
