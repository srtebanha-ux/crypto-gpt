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
