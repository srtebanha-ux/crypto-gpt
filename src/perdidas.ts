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
import { POOLS } from './contratos';

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
 * A profundidade do pool onde a garantia e realmente vendida.
 *
 * Nao e constante de projeto: e a medicao de 2026-09-19 no pool da Aerodrome
 * que o contrato usa, guardada em `contratos.ts` com endereco e data. Importar
 * daqui em vez de repetir o numero e o que impede as duas coisas divergirem.
 */
export const PROFUNDIDADE_DA_VENDA = POOLS.aerodrome!.profundidadeUsd;

/**
 * Quanto ESTA liquidacao teria dado de lucro, se fosse sua.
 *
 * O lucro nao e a divida: e o agio sobre a METADE da divida, menos o custo de
 * vender a garantia. Uma liquidacao de US$4.000 rende uns US$87, e nao
 * US$4.000.
 *
 * E o custo de vender NAO E UMA CONSTANTE. Foi tratado como constante aqui, e
 * em 2026-09-27 isso produziu uma linha de log dizendo que uma queda de 10% do
 * mercado poria US$ 2.161.328 na mesa. O numero verdadeiro e da ordem de
 * US$ 2.000 — mil vezes menor — porque as posicoes que faziam aquele total
 * somam US$ 95 milhoes de divida, e vender US$ 50 milhoes de garantia num pool
 * de US$ 4,4 milhoes nao custa 0,59%: custa o pool inteiro.
 *
 * `src/venda.ts` existe desde antes disso, e o cabecalho dele avisa deste
 * exato erro ("e o motivo de o relatorio dizer que uma liquidacao de $42
 * milhoes renderia $978 mil"). O defeito foi calcular de novo em vez de usar o
 * que ja estava medido.
 *
 * A formula: `escorregamento = venda / (reserva + venda)`, exata para produto
 * constante. `CUSTO_DA_VENDA` continua respondendo pela taxa do pool e pelo
 * premio do flash loan, que nao dependem do tamanho; o escorregamento e a
 * parte que depende, e e ela que mata a baleia.
 *
 * Duas derivacoes independentes concordam com o resultado: esta formula da
 * lucro maximo de US$ 1.986 numa divida de US$ 182 mil, e a medicao de
 * `contratos.ts` registrou US$ 2.103 de lucro maximo com teto de US$ 390 mil.
 */
export function lucroDaCobertura(
    coberturaUsd: Decimal,
    profundidadeUsd: Decimal = PROFUNDIDADE_DA_VENDA,
): Decimal {
    if (coberturaUsd.lessThanOrEqualTo(0)) return GAS_USD.negated();
    // Vende-se a GARANTIA recebida, que e a cobertura mais o agio.
    const venda = coberturaUsd.mul(new Decimal(1).plus(AGIO));
    const escorregamento = profundidadeUsd.lessThanOrEqualTo(0)
        ? new Decimal(1)
        : venda.dividedBy(profundidadeUsd.plus(venda));
    return coberturaUsd
        .mul(AGIO)
        .minus(coberturaUsd.mul(CUSTO_DA_VENDA))
        .minus(venda.mul(escorregamento))
        .minus(GAS_USD);
}

const otimaPorProfundidade = new Map<string, Decimal>();

/**
 * A fatia da divida que rende MAIS neste pool.
 *
 * Aqui esta a correcao de uma conclusao minha que estava errada. Eu tinha
 * escrito que uma posicao de US$ 95 milhoes "da prejuizo de US$ 44 milhoes", e
 * isso so e verdade se a gente insistir em cobrir METADE dela. A Aave nao
 * obriga: `debtToCover` pode ser qualquer valor ate o limite do close factor.
 * Cobrir menos e sempre permitido.
 *
 * Entao divida grande nao e prejuizo — e premio COM TETO. Cobre-se a fatia
 * otima e leva-se o maximo que o pool aguenta, e o resto da divida fica lá.
 *
 * `quantoPedirEmprestado` pedia metade sempre, com um comentario dizendo que
 * "pedir menos e deixar agio na mesa". Verdade para posicao pequena, falso para
 * baleia: lá, pedir metade e deixar o agio inteiro dentro do escorregamento.
 *
 * Varredura em vez de forma fechada: a derivada zera numa cubica, e cubica em
 * decisao de dinheiro e um lugar otimo para esconder um erro de sinal. O
 * resultado e memorizado porque a profundidade nao muda em memoria e isto e
 * chamado uma vez por posicao medida — milhares por varredura.
 */
export function coberturaOtima(
    profundidadeUsd: Decimal = PROFUNDIDADE_DA_VENDA,
    passos = 2000,
): Decimal {
    const chave = `${profundidadeUsd.toString()}|${passos}`;
    const guardada = otimaPorProfundidade.get(chave);
    if (guardada !== undefined) return guardada;
    let melhorC = new Decimal(0);
    let melhorL = GAS_USD.negated();
    for (let i = 1; i <= passos; i++) {
        const c = profundidadeUsd.mul(i).dividedBy(passos);
        const l = lucroDaCobertura(c, profundidadeUsd);
        if (l.greaterThan(melhorL)) { melhorL = l; melhorC = c; }
    }
    otimaPorProfundidade.set(chave, melhorC);
    return melhorC;
}

/** O maximo que uma cacada pode render neste pool, por melhor que seja o alvo. */
export function lucroMaximo(profundidadeUsd: Decimal = PROFUNDIDADE_DA_VENDA): Decimal {
    return lucroDaCobertura(coberturaOtima(profundidadeUsd), profundidadeUsd);
}

/**
 * Quanto ESTA liquidacao renderia, cobrindo a melhor fatia possivel.
 *
 * O lucro nao e a divida: e o agio sobre o que se COBRE, menos a taxa do pool,
 * menos o escorregamento da venda, menos o gas. Uma liquidacao de US$ 4.000
 * rende US$ 87.
 *
 * O custo de vender NAO E CONSTANTE, e tratar como constante produziu, em
 * 2026-09-27, uma linha de log prometendo US$ 2.161.328 numa queda de 10%. E
 * insistir em cobrir metade produziu, na correcao seguinte, um "prejuizo de
 * US$ 44 milhoes" igualmente falso. As duas respostas erradas tinham a mesma
 * raiz: tratar como fixo algo que e escolha nossa.
 *
 * O resultado satura: acima da fatia otima o lucro para de crescer e NAO cai,
 * porque a gente simplesmente nao cobre mais que isso.
 */
export function lucroEstimado(
    dividaUsd: Decimal,
    profundidadeUsd: Decimal = PROFUNDIDADE_DA_VENDA,
    coberturaMaximaUsd?: Decimal,
): Decimal {
    const teto = coberturaMaximaUsd ?? coberturaOtima(profundidadeUsd);
    const coberto = Decimal.min(dividaUsd.dividedBy(FATIA_COBRIVEL), teto);
    return lucroDaCobertura(coberto, profundidadeUsd);
}

/**
 * A menor divida que ainda paga o proprio tiro. Inverte `lucroDaCobertura`.
 *
 * Existe por uma medicao concreta: a brasa — as vagas mais rapidas que o bot
 * tem — vinha sendo preenchida por ordem de fragilidade PURA, e o mais fragil
 * de todos na Base era uma posicao de US$ 0,65. O tiro em seco mirou nela.
 *
 * A margem default e 1, nao 2, e isso e deliberado: este e um filtro de
 * SELECAO, e o portao do tiro (`valeATentativa`, margem 2) vem depois com o
 * lucro MEDIDO em vez do estimado. Excluir aqui alguem que o portao aceitaria
 * e o erro caro — uma liquidacao perdida.
 *
 * A inversao ignora o escorregamento de proposito: no tamanho do piso a venda
 * e de dezenas de dolares num pool de milhoes, e o escorregamento vale frações
 * de centavo. Inverter a curva inteira para ganhar isso seria precisao falsa, e
 * o erro que sobra empurra o piso para BAIXO — o lado seguro aqui.
 *
 * Devolve `null` quando nao se sabe o custo do tiro. Nesse caso nao se filtra
 * nada: um piso inventado e pior que nenhum piso.
 */
export function dividaMinimaQueVale(custoDoTiroUsd: Decimal | null, margem = 1): Decimal | null {
    if (custoDoTiroUsd === null || !custoDoTiroUsd.isFinite() || custoDoTiroUsd.lessThan(0)) return null;
    const ganhoPorDolarCoberto = AGIO.minus(CUSTO_DA_VENDA);
    if (ganhoPorDolarCoberto.lessThanOrEqualTo(0)) return null;
    const lucroNecessario = custoDoTiroUsd.mul(margem).plus(GAS_USD);
    return lucroNecessario.mul(FATIA_COBRIVEL).dividedBy(ganhoPorDolarCoberto);
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
 *
 * MAS o piso tem de ser o do BOT, nao um numero escolhido aqui. O default de
 * US$20 ficou desatualizado sem ninguem notar: o bot passou a atirar em
 * qualquer lucro acima de zero (modo prova) e o placar continuou medindo contra
 * US$20. Uma liquidacao de US$5 — justamente a que ela esta esperando para
 * provar que funciona — aconteceria, o bot a quereria, e o placar imprimiria
 * "Nenhuma liquidacao na sua faixa de lucro. Nao teve."
 *
 * O placar existe para responder "passou algo que eu queria?". Com o piso
 * errado ele responde a pergunta de outro bot. Quem chama passa o piso de
 * verdade, tirado da faixa que o bot atira hoje.
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
export function oQueIssoQuerDizer(placar: PlacarDasPerdidas, pisoUsado?: Decimal | null): string {
    if (placar.valiam.length === 0) {
        // O piso entra na frase porque "na sua faixa de lucro" e a parte que
        // pode estar errada, e sem o numero ninguem consegue conferir.
        const piso = pisoUsado === undefined
            ? ''
            : pisoUsado === null
                ? ' (piso: qualquer lucro acima de zero)'
                : ` (piso: US$ ${pisoUsado.toFixed(2)})`;
        return `Nenhuma liquidação na sua faixa de lucro${piso}. Não foi velocidade nem cobertura: não teve.`;
    }
    const c = placar.porCobertura;
    const ordenados = (Object.keys(c) as Cobertura[]).filter((k) => c[k] > 0).sort((a, b) => c[b] - c[a]);
    // Empate nao pode eleger um balde: com pouquissimas liquidacoes por hora o
    // empate e o caso COMUM, e o desempate alfabetico caia sempre em 'brasa',
    // que aponta para o conserto mais caro (encurtar o ciclo). Dizer "nao da
    // para saber ainda" e a resposta honesta.
    if (ordenados.length > 1 && c[ordenados[0]] === c[ordenados[1]]) {
        return `Empate entre ${ordenados.filter((k) => c[k] === c[ordenados[0]]).join(' e ')}: poucos dados para dizer o que consertar.`;
    }
    const maior = ordenados[0];
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
