// Arquivo: src/decisao.ts
//
// Vale a pena tentar esta liquidação? — a conta que decide se o gás sai.
//
// Ela existe separada do vigia e do contrato de propósito. O vigia ACHA a
// posição, o contrato EXECUTA, e nenhum dos dois deve decidir: achar é
// observação e executar é mecânica, mas decidir é onde o dinheiro é ganho ou
// queimado, e é a parte que precisa ser lida, discutida e testada sozinha.
//
// O ERRO QUE ESTA CONTA EVITA:
// O ágio parece lucro. Numa dívida de US$20.000 a 5%, "mil dólares" salta aos
// olhos. Mas dali sai o prêmio do empréstimo, a taxa e o deslizamento da venda
// da garantia, e o gás — e o gás é cobrado mesmo quando se perde a corrida.
// Confundir ágio com lucro é o mesmo erro de confundir dívida com prêmio, que
// este projeto já cometeu uma vez hoje.
import { Decimal } from 'decimal.js';
import { poolNecessarioPara } from './venda';

export interface Oportunidade {
    /** Quanto da dívida será coberto, em dólares. */
    dividaCobertaUsd: Decimal;
    /** Ágio da liquidação como fração: 0,05 para 5%. Lido do contrato, não chutado. */
    bonus: Decimal;
    /** Prêmio do flash loan como fração. Na Aave, 0,0005. */
    premioFlashLoan: Decimal;
    /**
     * Fração perdida ao vender a garantia (taxa do pool + deslizamento).
     *
     * Zero quando garantia e dívida são o mesmo token e não há venda. Nos
     * testes do contrato, vender 1.050.000 num pool fundo custou 3.152 — uns
     * 0,3%. Num pool raso o mesmo ágio virou prejuízo de 313 mil, e é por isso
     * que este número não pode ser presumido: ele vem de olhar o pool.
     */
    perdaNaTroca: Decimal;
    /** Unidades de gás estimadas para a transação inteira. */
    gasEstimado: Decimal;
    /** Preço do gás em wei naquele instante. */
    precoDoGasWei: Decimal;
    /** Preço da moeda que paga o gás, em dólares. */
    precoNativoUsd: Decimal;
}

export interface Veredicto {
    lucroBrutoUsd: Decimal;
    custoEmprestimoUsd: Decimal;
    custoTrocaUsd: Decimal;
    custoGasUsd: Decimal;
    lucroLiquidoUsd: Decimal;
    /** Quantas vezes o lucro líquido cobre o gás. Null quando o gás é zero. */
    vezesOGas: Decimal | null;
    vale: boolean;
    leitura: string;
}

/**
 * Quantas vezes o lucro precisa cobrir o gás para valer a tentativa.
 *
 * NÃO é margem de conforto: é a conta da taxa de acerto. Tentativa perdida
 * gasta gás e devolve nada. Se ela ganha uma em cada três corridas, cada
 * vitória precisa pagar o gás de três tentativas só para empatar — e a partir
 * daí é que começa o lucro.
 *
 * Três é chute provisório, e está marcado como tal. O número certo é
 * 1/(taxa de acerto), e a taxa de acerto é justamente o que nenhuma medição
 * deste projeto conseguiu ainda. Quando as primeiras tentativas reais
 * existirem, este número deixa de ser opinião e vira medida.
 */
export const VEZES_O_GAS_EXIGIDAS = new Decimal(3);

export function avaliar(o: Oportunidade, vezesExigidas = VEZES_O_GAS_EXIGIDAS): Veredicto {
    const lucroBrutoUsd = o.dividaCobertaUsd.mul(o.bonus);
    const custoEmprestimoUsd = o.dividaCobertaUsd.mul(o.premioFlashLoan);
    // A perda da troca incide sobre a GARANTIA recebida, que é a dívida mais o
    // ágio — não sobre a dívida. Calcular sobre a dívida subestimaria o custo
    // justamente nas liquidações de ágio alto, que são as que mais interessam.
    const garantiaRecebidaUsd = o.dividaCobertaUsd.mul(new Decimal(1).plus(o.bonus));
    const custoTrocaUsd = garantiaRecebidaUsd.mul(o.perdaNaTroca);
    const custoGasUsd = o.gasEstimado
        .mul(o.precoDoGasWei)
        .dividedBy(new Decimal('1e18'))
        .mul(o.precoNativoUsd);

    const lucroLiquidoUsd = lucroBrutoUsd
        .minus(custoEmprestimoUsd)
        .minus(custoTrocaUsd)
        .minus(custoGasUsd);

    const vezesOGas = custoGasUsd.greaterThan(0) ? lucroLiquidoUsd.dividedBy(custoGasUsd) : null;
    const vale =
        lucroLiquidoUsd.greaterThan(0) &&
        (vezesOGas === null || vezesOGas.greaterThanOrEqualTo(vezesExigidas));

    let leitura: string;
    if (lucroLiquidoUsd.lessThanOrEqualTo(0)) {
        leitura =
            `NÃO VALE: depois de tudo sobra ${lucroLiquidoUsd.toFixed(2)} dólares. ` +
            `O ágio de $${lucroBrutoUsd.toFixed(2)} não cobre empréstimo ($${custoEmprestimoUsd.toFixed(2)}) ` +
            `+ troca ($${custoTrocaUsd.toFixed(2)}) + gás ($${custoGasUsd.toFixed(2)}).`;
    } else if (!vale) {
        leitura =
            `APERTADO DEMAIS: sobra $${lucroLiquidoUsd.toFixed(2)}, que é ${vezesOGas?.toFixed(1)}x o gás. ` +
            `Exijo ${vezesExigidas.toFixed(0)}x porque tentativa perdida também paga gás.`;
    } else {
        leitura =
            `VALE: sobra $${lucroLiquidoUsd.toFixed(2)}, que é ${vezesOGas === null ? '∞' : vezesOGas.toFixed(1)}x o gás.`;
    }

    return {
        lucroBrutoUsd,
        custoEmprestimoUsd,
        custoTrocaUsd,
        custoGasUsd,
        lucroLiquidoUsd,
        vezesOGas,
        vale,
        leitura,
    };
}

/**
 * O piso de lucro a mandar para o contrato, em unidades cruas do token.
 *
 * Fica ABAIXO do lucro esperado de propósito, por uma fração. O contrato
 * confere o piso depois de tudo executado, e entre a decisão aqui e a execução
 * lá o preço do pool se move — exigir exatamente o esperado faria a transação
 * reverter por um centavo de diferença, queimando o gás de uma caçada que era
 * boa.
 *
 * Mas o piso nunca desce abaixo do custo do gás: reverter por falta de margem
 * custa gás, e completar uma caçada que não paga o próprio gás custa gás
 * TAMBÉM, só que com a aparência de sucesso.
 */
export function pisoParaOContrato(params: {
    lucroLiquidoUsd: Decimal;
    custoGasUsd: Decimal;
    folga?: Decimal;
    precoDoTokenUsd: Decimal;
    decimaisDoToken: number;
}): Decimal {
    const folga = params.folga ?? new Decimal('0.2');
    const comFolga = params.lucroLiquidoUsd.mul(new Decimal(1).minus(folga));
    const pisoUsd = Decimal.max(comFolga, params.custoGasUsd);
    if (params.precoDoTokenUsd.lessThanOrEqualTo(0)) return new Decimal(0);
    return pisoUsd
        .dividedBy(params.precoDoTokenUsd)
        .mul(new Decimal(10).pow(params.decimaisDoToken))
        .floor();
}

// --------------------------------------------------------------------------
// Resumir muitas avaliações numa linha de log — sem deixar a escolha do que
// mostrar decidir o que foi medido.
//
// O vigia media `naMira.slice(0, 10)`: dez quaisquer, na ordem em que os
// devedores tinham sido descobertos, que não é nem a ordem de quem cai
// primeiro nem a de quem vale mais. O log saía completo, plausível, sem erro
// nenhum à vista — e publicava `somaSeGanhasseTodas` como se fosse uma soma,
// sendo a soma de uma amostra arbitrária.
//
// O preço disso apareceu numa ronda de verdade: a posição mais valiosa da
// borda, $1.875.733 a 2,12% de queda, ficou de fora do relatório por estar
// fora dos dez primeiros da lista de descoberta. O número que mais importava
// era exatamente o que não estava lá.
//
// A separação que conserta é esta: MEDIR tudo, MOSTRAR pouco. Avaliar custa
// aritmética e nada mais — nenhuma chamada de rede — então não há motivo para
// amostrar. O corte em dez existe só porque log gigante ninguém lê, e passa a
// cair sobre as que mais pagam.

export interface ItemAvaliado {
    /** Como a linha identifica esta posição no log. */
    chave: string;
    /** Quanto o mercado precisa cair para liquidar, em %. Null = não deu para ler. */
    queda: number | null;
    dividaUsd: Decimal;
    veredicto: Veredicto;
    /**
     * Quanto de garantia essa caçada teria de VENDER. Opcional porque nem todo
     * chamador sabe — mas quem sabe ganha a coluna que desmente o resto: o
     * tamanho de pool que a venda exigiria. Uma dívida de $42 milhões produz
     * um lucro previsto lindo e pede um pool de dois bilhões numa moeda só.
     * Sem essa coluna, o log mostra só o lado bonito da conta.
     */
    vendaUsd?: Decimal;
}

export interface ResumoDeAvaliacoes {
    /** Quantas valeriam o gás — de quantas foram avaliadas, não de quantas foram mostradas. */
    quantasValem: number;
    quantasAvaliadas: number;
    somaLiquidaUsd: Decimal;
    /** Posições na mira cuja dívida leu zero: medição a conferir, não oportunidade. */
    semDivida: number;
    linhas: string[];
}

export const LINHAS_NO_LOG = 10;

/** Quanto de empurrão no preço se aceita ao vender. 1% é o teto do relatório. */
export const EMPURRAO_TOLERADO = new Decimal('0.01');

export function resumirAvaliacoes(itens: ItemAvaliado[], quantasLinhas = LINHAS_NO_LOG): ResumoDeAvaliacoes {
    const valem = itens.filter((i) => i.veredicto.vale);
    const somaLiquidaUsd = valem.reduce((s, i) => s.plus(i.veredicto.lucroLiquidoUsd), new Decimal(0));

    const linhas = [...valem]
        .sort((a, b) => b.veredicto.lucroLiquidoUsd.comparedTo(a.veredicto.lucroLiquidoUsd))
        .slice(0, quantasLinhas)
        .map((i) => {
            const base =
                `${i.chave} a ${i.queda === null ? '?' : i.queda.toFixed(2)}%: ` +
                `dívida $${i.dividaUsd.toFixed(0)} -> VALERIA $${i.veredicto.lucroLiquidoUsd.toFixed(2)}`;
            if (!i.vendaUsd) return base;
            const pool = poolNecessarioPara(i.vendaUsd, EMPURRAO_TOLERADO);
            return `${base} (venderia $${i.vendaUsd.toFixed(0)}, pede pool de $${pool.toFixed(0)})`;
        });

    return {
        quantasValem: valem.length,
        quantasAvaliadas: itens.length,
        somaLiquidaUsd,
        semDivida: itens.filter((i) => i.dividaUsd.isZero()).length,
        linhas,
    };
}
