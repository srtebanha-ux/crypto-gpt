// Arquivo: src/feeViability.ts
//
// A operação vale a taxa que vai custar?
//
// Esta é a pergunta que a medição deste projeto já tinha respondido sem que
// ninguém a tivesse feito explicitamente. Ao medir o gráfico de 15 minutos nas
// três famílias, a perda POR OPERAÇÃO bateu com o custo de uma ida e volta:
// breakout 0,94x a taxa, momentum 1,05x. Uma coincidência dessas não é
// coincidência — é a assinatura de uma estratégia que acerta a direção com
// frequência de moeda honesta e entrega todo o resultado ao pedágio.
//
// A conclusão prática: o problema não estava na regra de entrada, estava em
// ONDE ela era aplicada. Comprar um ativo cuja vela típica anda 0,2% pagando
// 0,15% de ida e volta é impossível de ganhar no longo prazo, por melhor que
// seja o sinal. Três quartos do movimento capturável já pertencem à corretora
// antes de a posição abrir.
//
// O filtro aqui mede isso ANTES de entrar: exige que a amplitude típica do
// ativo (ATR) seja um múltiplo do custo de ida e volta. Não prevê o futuro —
// só recusa a mesa onde a aposta não pode pagar.
import { Decimal } from 'decimal.js';

export type VeredictoDeTaxa =
    | { vale: true; atrEmTaxas: Decimal }
    | { vale: false; motivo: string; atrEmTaxas: Decimal };

/**
 * O movimento típico deste ativo comporta o custo de operá-lo?
 *
 * `minimoEmTaxas` é o quanto a amplitude precisa valer em múltiplos do custo
 * de IDA E VOLTA. Com 4, a vela típica precisa andar quatro vezes o pedágio —
 * ou seja, a taxa pode consumir no máximo 25% do movimento disponível.
 *
 * A escolha de ATR como medida de "movimento disponível" é deliberada: ele é a
 * amplitude REAL das últimas velas, não uma previsão. Um ativo que não se
 * mexeu nas últimas 14 velas pode explodir na próxima, e este filtro vai
 * perder essa. É um custo aceito de propósito — o alternativo é operar todas
 * as mesas mortas na esperança de uma delas acordar, e a medição já mostrou
 * quanto isso custa.
 */
export function operacaoValeATaxa(params: {
    /** ATR corrente do ativo, na moeda do preço. */
    atr: Decimal;
    /** Preço de entrada, para transformar o ATR em fração. */
    preco: Decimal;
    /** Taxa por perna, em fração (0.00075 = 0,075%). */
    taxaPorPerna: Decimal;
    /** Múltiplos do custo de ida e volta exigidos. Zero ou negativo desliga. */
    minimoEmTaxas: Decimal;
}): VeredictoDeTaxa {
    const custoDeIdaEVolta = params.taxaPorPerna.mul(2);
    // Sem custo não há o que exigir — e dividir por zero adiante daria um
    // número infinito que passaria em qualquer teste, silenciosamente.
    if (custoDeIdaEVolta.lessThanOrEqualTo(0) || params.preco.lessThanOrEqualTo(0)) {
        return { vale: true, atrEmTaxas: new Decimal(0) };
    }

    const atrEmFracao = params.atr.dividedBy(params.preco);
    const atrEmTaxas = atrEmFracao.dividedBy(custoDeIdaEVolta);

    if (params.minimoEmTaxas.lessThanOrEqualTo(0)) return { vale: true, atrEmTaxas };
    if (atrEmTaxas.greaterThanOrEqualTo(params.minimoEmTaxas)) return { vale: true, atrEmTaxas };

    return {
        vale: false,
        atrEmTaxas,
        motivo:
            `movimento típico de ${atrEmFracao.mul(100).toFixed(3)}% vale só ${atrEmTaxas.toFixed(2)}x o custo de ` +
            `ida e volta (${custoDeIdaEVolta.mul(100).toFixed(3)}%), abaixo do mínimo de ` +
            `${params.minimoEmTaxas.toFixed(2)}x. A taxa comeria ` +
            `${new Decimal(100).dividedBy(atrEmTaxas).toFixed(0)}% do movimento disponível.`,
    };
}
