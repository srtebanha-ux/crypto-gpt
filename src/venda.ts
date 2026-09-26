// Arquivo: src/venda.ts
//
// Quanto se perde ao vender a garantia — medido no pool, não chutado.
//
// `avaliar()` usa hoje `perdaNaTroca: 0.003` com um comentário honesto dizendo
// que é suposição de pool fundo. Essa suposição decide se uma caçada vale, e
// decide errado nos dois sentidos: num pool raso ela promete lucro que não
// existe, e num pool fundo ela recusa caçada boa.
//
// Pior: ela é o motivo de o relatório dizer que uma liquidação de $42 milhões
// renderia $978 mil. Vender $21 milhões numa única transação não perde 0,3% —
// perde o que este arquivo calcula, que pode ser mais que o ágio inteiro.
//
// O que muda aqui é a categoria da resposta. A perda não é uma constante do
// projeto, é uma função do TAMANHO contra as reservas daquele pool naquele
// momento. Um pool que engole $2.000 sem sentir é o mesmo que devolve migalha
// por $2 milhões. Por isso a saída principal não é um número e sim uma curva,
// mais a pergunta que realmente se faz na hora: até quanto dá para vender
// aqui sem passar de tanto?
import { Decimal } from 'decimal.js';
import { getAmountOut, type Hop } from './ammMath';

export interface PerdaNaVenda {
    /** A taxa do pool. Não depende do tamanho: é pedágio, não escorregamento. */
    taxa: Decimal;
    /**
     * O empurrão no preço causado pelo próprio tamanho da venda.
     *
     * Sai exato da fórmula do produto constante sem taxa: dx / (x + dx).
     * É a parte que cresce com o tamanho, e a única que a gente controla
     * escolhendo quanto vender de cada vez.
     */
    escorregamento: Decimal;
    /** O que realmente falta para receber o preço de tela. Taxa e empurrão juntos. */
    total: Decimal;
}

/**
 * Compara o que o pool devolve com o que o preço de tela prometia.
 *
 * O "preço de tela" é a razão das reservas — o preço de uma venda
 * infinitamente pequena. Nenhuma venda real recebe isso; a diferença é
 * exatamente o que este projeto vinha chutando.
 */
export function perdaNaVenda(entrada: Decimal, hop: Hop): PerdaNaVenda {
    const zero = { taxa: hop.feeFraction, escorregamento: new Decimal(0), total: hop.feeFraction };
    if (entrada.lessThanOrEqualTo(0)) return zero;
    if (hop.reserveIn.lessThanOrEqualTo(0) || hop.reserveOut.lessThanOrEqualTo(0)) {
        return { taxa: hop.feeFraction, escorregamento: new Decimal(1), total: new Decimal(1) };
    }

    const precoDeTela = hop.reserveOut.dividedBy(hop.reserveIn);
    const prometido = entrada.mul(precoDeTela);
    const recebido = getAmountOut(entrada, hop);

    return {
        taxa: hop.feeFraction,
        escorregamento: entrada.dividedBy(hop.reserveIn.plus(entrada)),
        total: new Decimal(1).minus(recebido.dividedBy(prometido)),
    };
}

export interface PontoDaCurva {
    entrada: Decimal;
    perda: PerdaNaVenda;
}

/** A perda em vários tamanhos — porque um número só esconde que é uma curva. */
export function curvaDePerda(hop: Hop, tamanhos: Decimal[]): PontoDaCurva[] {
    return tamanhos.map((entrada) => ({ entrada, perda: perdaNaVenda(entrada, hop) }));
}

/**
 * Até quanto dá para vender aqui sem o empurrão passar do teto.
 *
 * Esta é a pergunta que se faz de verdade, e a resposta tem forma fechada —
 * de `e/(x+e) = t` sai `e = x·t/(1-t)`. Busca binária seria aproximação onde
 * existe conta exata, e aproximação em decisão de dinheiro é dívida futura.
 *
 * O teto é sobre o ESCORREGAMENTO, não sobre a perda total: a taxa do pool é
 * a mesma para qualquer tamanho, então incluí-la faria um teto abaixo da taxa
 * devolver zero e parecer que o pool não serve para nada.
 */
export function maiorVendaAte(escorregamentoMaximo: Decimal, hop: Hop): Decimal {
    if (escorregamentoMaximo.lessThanOrEqualTo(0)) return new Decimal(0);
    if (escorregamentoMaximo.greaterThanOrEqualTo(1)) return new Decimal(Infinity);
    if (hop.reserveIn.lessThanOrEqualTo(0)) return new Decimal(0);
    return hop.reserveIn.mul(escorregamentoMaximo).dividedBy(new Decimal(1).minus(escorregamentoMaximo));
}

export interface VeredictoDoPool {
    cabe: boolean;
    perda: PerdaNaVenda;
    maiorQueCabe: Decimal;
    leitura: string;
}

/**
 * Este pool aguenta esta venda?
 *
 * Responde com o teto junto, sempre — inclusive quando a resposta é não. Saber
 * que não cabe sem saber o que caberia obriga a adivinhar o próximo palpite, e
 * adivinhar é o que este arquivo existe para acabar.
 */
export function cabeNestePool(entrada: Decimal, hop: Hop, escorregamentoMaximo: Decimal): VeredictoDoPool {
    const perda = perdaNaVenda(entrada, hop);
    const maiorQueCabe = maiorVendaAte(escorregamentoMaximo, hop);
    const cabe = perda.escorregamento.lessThanOrEqualTo(escorregamentoMaximo);
    const pct = (d: Decimal) => d.mul(100).toFixed(2);
    return {
        cabe,
        perda,
        maiorQueCabe,
        leitura: cabe
            ? `cabe: empurra o preço ${pct(perda.escorregamento)}% e custa ${pct(perda.total)}% no total; ` +
              `este pool aguenta até ${maiorQueCabe.toFixed(0)} de uma vez`
            : `NÃO cabe: empurraria o preço ${pct(perda.escorregamento)}%, acima do teto de ` +
              `${pct(escorregamentoMaximo)}%. O máximo aqui é ${maiorQueCabe.toFixed(0)} por vez`,
    };
}

/**
 * De que tamanho o pool precisa ser para engolir esta venda dentro do teto.
 *
 * É o inverso de `maiorVendaAte`, e existe para virar a pergunta do lado
 * certo. Perguntar "quanto cabe neste pool?" exige já ter escolhido um pool.
 * Perguntar "de que tamanho teria que ser?" responde antes de procurar — e
 * às vezes responde que não adianta procurar.
 *
 * Foi assim que a posição de $42 milhões deixou de ser dúvida: vendê-la
 * pedia um pool de mais de dois bilhões de dólares em UMA moeda. Não é que
 * não achamos o pool; é que ele não existe na Base.
 */
export function poolNecessarioPara(venda: Decimal, escorregamentoMaximo: Decimal): Decimal {
    if (escorregamentoMaximo.lessThanOrEqualTo(0)) return new Decimal(Infinity);
    if (escorregamentoMaximo.greaterThanOrEqualTo(1)) return new Decimal(0);
    return venda.mul(new Decimal(1).minus(escorregamentoMaximo)).dividedBy(escorregamentoMaximo);
}
