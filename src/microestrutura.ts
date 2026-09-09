// Arquivo: src/microestrutura.ts
//
// Microestrutura: a matemática do livro de ofertas, sem gráfico e sem
// indicador. Aqui não existe RSI, ATR nem vela — existe preço de compra,
// preço de venda, quantidade em cada nível, e o custo de atravessar.
//
// A EQUAÇÃO CENTRAL, E POR QUE ELA DECIDE TUDO
//
// Quem ATRAVESSA o spread (ordem a mercado) compra na melhor venda e vende na
// melhor compra. Ida e volta, isso custa UM SPREAD INTEIRO, mais as taxas:
//
//     custo de ida e volta = spread + 2 × taxa
//
// Logo, uma estratégia que atravessa nas duas pontas só lucra se o movimento
// capturado for MAIOR que o spread. "Lucrar com a variação microscópica de
// casas decimais" atravessando o spread é aritmeticamente impossível: a
// variação microscópica é, por construção, menor que o spread que a produz.
//
// Quem COLOCA a oferta (maker) está do outro lado da mesma conta: ele RECEBE
// o spread quando as duas pontas preenchem.
//
//     lucro do maker = spread − 2 × taxa_maker − seleção adversa
//
// Por isso as duas estratégias pedem desenhos opostos, e por isso o tamanho
// do tique — que define o menor spread possível — favorece uma e mata a outra.
import { Decimal } from 'decimal.js';

export interface NivelDoLivro {
    preco: Decimal;
    quantidade: Decimal;
}

export interface AnaliseDeSpread {
    /** Meio do book: (melhor compra + melhor venda) / 2. */
    precoMedio: Decimal;
    spreadAbsoluto: Decimal;
    /** Spread como fração do preço médio. 0.001 = 0,1%. */
    spreadFracao: Decimal;
    /** Quantos tiques de largura tem o spread. 1 = o mínimo possível. */
    spreadEmTiques: Decimal;
    /**
     * O tique como fração do preço — o PISO de qualquer spread neste par.
     *
     * É o número que separa um par operável de um par que já nasce caro: num
     * ativo de preço baixo o tique pode valer 0,08% do preço, e aí o menor
     * spread que pode existir já custa mais que a taxa da corretora.
     */
    tiqueFracao: Decimal;
}

/** Recusa em vez de devolver número inventado: book cruzado ou vazio não tem spread. */
export function analisarSpread(params: {
    melhorCompra: Decimal;
    melhorVenda: Decimal;
    tickSize: Decimal;
}): AnaliseDeSpread | null {
    const { melhorCompra, melhorVenda, tickSize } = params;
    if (melhorCompra.lessThanOrEqualTo(0) || melhorVenda.lessThanOrEqualTo(0)) return null;
    if (tickSize.lessThanOrEqualTo(0)) return null;
    // Cruzado (venda <= compra) é dado corrompido ou book em transição. Seguir
    // produziria spread negativo, e um spread negativo passa em qualquer
    // filtro de "vale a pena" — o pior tipo de erro silencioso.
    if (melhorVenda.lessThanOrEqualTo(melhorCompra)) return null;

    const spreadAbsoluto = melhorVenda.minus(melhorCompra);
    const precoMedio = melhorCompra.plus(melhorVenda).dividedBy(2);
    return {
        precoMedio,
        spreadAbsoluto,
        spreadFracao: spreadAbsoluto.dividedBy(precoMedio),
        spreadEmTiques: spreadAbsoluto.dividedBy(tickSize),
        tiqueFracao: tickSize.dividedBy(precoMedio),
    };
}

/**
 * DESEQUILÍBRIO DO LIVRO — o sinal de microestrutura de verdade.
 *
 *     I = (volume de compras − volume de vendas) / (volume total)
 *
 * Varia de −1 (só vendedores) a +1 (só compradores). É a leitura de PRESSÃO:
 * com muito mais volume parado do lado da compra, quem quiser vender precisa
 * descer para encontrar comprador, e o preço tende a subir no curtíssimo prazo.
 *
 * `profundidade` limita quantos níveis entram. Poucos níveis leem a intenção
 * imediata; muitos níveis leem ordens que estão longe demais para importar e
 * que somem no instante em que o preço se aproxima delas.
 */
export function desequilibrioDoLivro(params: {
    compras: NivelDoLivro[];
    vendas: NivelDoLivro[];
    profundidade?: number;
}): Decimal | null {
    const n = Math.max(1, Math.trunc(params.profundidade ?? 5));
    const somar = (niveis: NivelDoLivro[]) =>
        niveis.slice(0, n).reduce((acc, nivel) => acc.plus(nivel.quantidade), new Decimal(0));

    const vComprado = somar(params.compras);
    const vVendido = somar(params.vendas);
    const total = vComprado.plus(vVendido);
    // Livro vazio não é equilíbrio: é ausência de informação. Devolver zero
    // faria o motor tratar "não sei" como "neutro", e neutro passa em filtros.
    if (total.lessThanOrEqualTo(0)) return null;
    return vComprado.minus(vVendido).dividedBy(total);
}

/**
 * Desequilíbrio PONDERADO pela distância até o meio do book.
 *
 * Uma ordem colada no preço vale muito mais que uma dez tiques abaixo: a
 * primeira vai ser executada, a segunda provavelmente é cancelada antes de o
 * preço chegar nela. Robôs enchem os níveis distantes justamente para simular
 * pressão que não existe, e o desequilíbrio simples cai nessa armadilha.
 *
 * O peso é 1/(1 + distância em tiques): cola no preço = peso 1, dez tiques
 * longe = peso 1/11.
 */
export function desequilibrioPonderado(params: {
    compras: NivelDoLivro[];
    vendas: NivelDoLivro[];
    precoMedio: Decimal;
    tickSize: Decimal;
    profundidade?: number;
}): Decimal | null {
    const { precoMedio, tickSize } = params;
    if (precoMedio.lessThanOrEqualTo(0) || tickSize.lessThanOrEqualTo(0)) return null;
    const n = Math.max(1, Math.trunc(params.profundidade ?? 10));

    const pesar = (niveis: NivelDoLivro[]) =>
        niveis.slice(0, n).reduce((acc, nivel) => {
            const distanciaEmTiques = nivel.preco.minus(precoMedio).abs().dividedBy(tickSize);
            const peso = new Decimal(1).dividedBy(distanciaEmTiques.plus(1));
            return acc.plus(nivel.quantidade.mul(peso));
        }, new Decimal(0));

    const pComprado = pesar(params.compras);
    const pVendido = pesar(params.vendas);
    const total = pComprado.plus(pVendido);
    if (total.lessThanOrEqualTo(0)) return null;
    return pComprado.minus(pVendido).dividedBy(total);
}

export type VeredictoDeMicroestrutura =
    | { operavel: true; movimentoMinimo: Decimal; motivo: string }
    | { operavel: false; motivo: string };

/**
 * ATRAVESSANDO O SPREAD (taker nas duas pontas): quanto o preço precisa andar?
 *
 * Esta é a função que responde "dá para fazer scalping neste par?" — e ela
 * quase sempre responde não, pelo motivo que a aritmética impõe:
 *
 *     movimento necessário > spread + 2 × taxa
 *
 * Com taxa ZERO a conta não desaparece: sobra o spread. E o spread mínimo é um
 * tique, então num par onde o tique vale 0,08% do preço, o menor movimento
 * lucrativo possível é 0,08% — mesmo sem taxa nenhuma.
 *
 * É por isso que "lucrar com a variação microscópica de casas decimais"
 * atravessando o spread não existe: a variação de UMA casa decimal É o tique,
 * e o custo mínimo de ida e volta também é o tique. Empate, na melhor hipótese.
 */
export function movimentoParaLucrarAtravessando(params: {
    spread: AnaliseDeSpread;
    taxaPorPerna: Decimal;
    /** Margem exigida acima do empate. 1.5 = precisa render 50% além do custo. */
    folga?: Decimal;
}): VeredictoDeMicroestrutura {
    const folga = params.folga ?? new Decimal('1.5');
    const custo = params.spread.spreadFracao.plus(params.taxaPorPerna.mul(2));
    if (custo.lessThanOrEqualTo(0)) {
        return { operavel: false, motivo: 'Custo calculado como zero ou negativo — dado do book inválido.' };
    }
    const movimentoMinimo = custo.mul(folga);
    return {
        operavel: true,
        movimentoMinimo,
        motivo:
            `Atravessando as duas pontas o custo é ${custo.mul(100).toFixed(4)}% ` +
            `(spread ${params.spread.spreadFracao.mul(100).toFixed(4)}% + taxa ` +
            `${params.taxaPorPerna.mul(200).toFixed(4)}%). O preço precisa andar pelo menos ` +
            `${movimentoMinimo.mul(100).toFixed(4)}% para valer.`,
    };
}

/**
 * COLOCANDO AS OFERTAS (maker nas duas pontas): quanto sobra por giro?
 *
 * Aqui o spread é RECEITA, não custo — é o lado oposto da mesma moeda. Com
 * taxa zero, o lucro bruto por giro completo é o spread inteiro.
 *
 * `selecaoAdversaEstimada` é o que separa a conta de papel da realidade, e é
 * a razão de a maioria dos market makers amadores perder dinheiro com o
 * spread a favor: sua compra parada preenche PREFERENCIALMENTE quando o preço
 * está caindo, e sua venda quando está subindo. Você acumula estoque sempre
 * do lado errado. Sem estimar isso, a função devolveria lucro garantido em
 * qualquer par com spread — o que é falso e caro.
 */
export function lucroPorGiroColocandoOferta(params: {
    spread: AnaliseDeSpread;
    taxaMakerPorPerna: Decimal;
    /** Perda média por seleção adversa, como fração do preço. */
    selecaoAdversaEstimada: Decimal;
}): { lucroFracao: Decimal; positivo: boolean; motivo: string } {
    const receita = params.spread.spreadFracao;
    const custo = params.taxaMakerPorPerna.mul(2).plus(params.selecaoAdversaEstimada);
    const lucroFracao = receita.minus(custo);
    return {
        lucroFracao,
        positivo: lucroFracao.greaterThan(0),
        motivo:
            `Recebe o spread de ${receita.mul(100).toFixed(4)}% e paga ` +
            `${custo.mul(100).toFixed(4)}% (taxa ${params.taxaMakerPorPerna.mul(200).toFixed(4)}% + ` +
            `seleção adversa ${params.selecaoAdversaEstimada.mul(100).toFixed(4)}%). ` +
            `Sobram ${lucroFracao.mul(100).toFixed(4)}% por giro completo.`,
    };
}

/**
 * O sinal de entrada por desequilíbrio, com as duas guardas que importam.
 *
 * Desequilíbrio forte prevê pressão de curtíssimo prazo — mas prever direção
 * não basta: o movimento previsto precisa ser MAIOR que o custo de atravessar.
 * Um sinal perfeito num par de spread largo perde dinheiro em todas as
 * entradas, e nada no resultado diz que a culpa foi do spread.
 */
export function sinalPorDesequilibrio(params: {
    desequilibrio: Decimal;
    /** Limiar de |I| para considerar pressão real. 0.6 = 4:1 de um lado. */
    limiar: Decimal;
    spread: AnaliseDeSpread;
    taxaPorPerna: Decimal;
    /** Movimento típico observado após desequilíbrios deste tamanho. */
    movimentoEsperado: Decimal;
}): { acao: 'comprar' | 'vender' | 'nada'; motivo: string } {
    const custo = params.spread.spreadFracao.plus(params.taxaPorPerna.mul(2));
    if (params.movimentoEsperado.lessThanOrEqualTo(custo)) {
        return {
            acao: 'nada',
            motivo:
                `Movimento esperado (${params.movimentoEsperado.mul(100).toFixed(4)}%) não cobre o custo de ` +
                `atravessar (${custo.mul(100).toFixed(4)}%). O sinal pode estar certo e a operação ainda perder.`,
        };
    }
    if (params.desequilibrio.greaterThanOrEqualTo(params.limiar)) {
        return { acao: 'comprar', motivo: `Pressão compradora ${params.desequilibrio.toFixed(3)}.` };
    }
    if (params.desequilibrio.lessThanOrEqualTo(params.limiar.negated())) {
        return { acao: 'vender', motivo: `Pressão vendedora ${params.desequilibrio.toFixed(3)}.` };
    }
    return { acao: 'nada', motivo: `Desequilíbrio ${params.desequilibrio.toFixed(3)} abaixo do limiar.` };
}
