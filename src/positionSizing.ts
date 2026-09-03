// Arquivo: src/positionSizing.ts
//
// Controle de risco de uma estratégia DIRECIONAL (comprar esperando alta), que
// é coisa diferente da arbitragem delta-neutra do resto do projeto: aqui a
// posição fica exposta ao preço, e pode dar prejuízo sem que nada tenha
// falhado tecnicamente.
//
// Este módulo é a resposta à pergunta "como errar pouco correndo mais risco?".
// A resposta honesta é que existem dois tipos de erro e só um é eliminável:
//
//   - Erro de EXECUÇÃO: posição grande demais, entrar sem stop, dobrar aposta
//     perdendo, arredondar quantidade para cima e estourar o saldo. Esses são
//     bugs, e vão a zero. É disto que este arquivo trata.
//   - RISCO DE MERCADO: comprou e o preço caiu. Irredutível — é o risco que se
//     escolheu correr.
//
// A regra central é dimensionar pela PERDA MÁXIMA ACEITA, não pelo capital
// disponível. "Comprar com tudo que tenho" transforma um movimento adverso
// normal em ruína; "arriscar 2% por operação" transforma o mesmo movimento em
// um custo previsto, e permite errar muitas vezes seguidas continuando vivo.
//
// Sem I/O: funções puras, testáveis sem rede.
import { Decimal } from 'decimal.js';

export interface RiskParams {
    /** Capital total disponível. */
    capital: Decimal;
    /** Fração do capital que se aceita perder SE o stop for atingido (ex.: 0.02 = 2%). */
    riskFraction: Decimal;
    /** Preço de entrada pretendido. */
    entryPrice: Decimal;
    /** Preço do stop loss. Precisa ser ABAIXO da entrada numa posição comprada. */
    stopPrice: Decimal;
    /** Notional mínimo da corretora (Binance rejeita ordens abaixo disso). */
    minNotional?: Decimal;
    /** Passo de quantidade do símbolo (LOT_SIZE). A quantidade é truncada a ele. */
    stepSize?: Decimal;
}

export interface PositionPlan {
    /** Quantidade a comprar. Zero significa "não operar" — ver `reason`. */
    quantity: Decimal;
    /** Valor da posição (quantity × entryPrice). */
    notional: Decimal;
    /** Perda em dinheiro se o stop for atingido exatamente. */
    riskAmount: Decimal;
    /** Preenchido quando quantity é zero: por que a operação foi recusada. */
    reason?: string;
}

/**
 * Trunca a quantidade ao passo do símbolo.
 *
 * SEMPRE para baixo, nunca para cima: arredondar para cima produz uma ordem
 * ligeiramente maior que a planejada, o que fura o limite de risco e, no
 * limite do saldo, faz a corretora rejeitar a ordem por fundos insuficientes.
 */
export function truncateToStep(quantity: Decimal, stepSize?: Decimal): Decimal {
    if (!stepSize || stepSize.lessThanOrEqualTo(0)) return quantity;
    return quantity.dividedBy(stepSize).floor().mul(stepSize);
}

/**
 * Calcula o tamanho da posição a partir da perda máxima aceita.
 *
 * A conta é:  quantidade = (capital × risco) / (entrada − stop)
 *
 * Ou seja, o tamanho é ditado pela DISTÂNCIA ATÉ O STOP, não pelo capital.
 * Stop distante => posição pequena; stop próximo => posição maior. Isso
 * mantém a perda por operação constante independentemente da volatilidade do
 * ativo, que é o que permite errar várias vezes seguidas sem quebrar.
 *
 * Devolve quantidade zero — com motivo — em vez de operar em situação
 * inválida. Nunca lança: recusar-se a operar é uma resposta legítima e
 * frequente, não uma exceção.
 */
export function planPosition(params: RiskParams): PositionPlan {
    const { capital, riskFraction, entryPrice, stopPrice } = params;
    const zero = (reason: string): PositionPlan => ({
        quantity: new Decimal(0),
        notional: new Decimal(0),
        riskAmount: new Decimal(0),
        reason,
    });

    if (capital.lessThanOrEqualTo(0)) return zero('Capital não positivo.');
    if (riskFraction.lessThanOrEqualTo(0)) return zero('riskFraction não positivo — nenhuma perda aceita, nenhuma posição possível.');
    if (riskFraction.greaterThan(1)) return zero('riskFraction acima de 100% do capital.');
    if (entryPrice.lessThanOrEqualTo(0)) return zero('Preço de entrada não positivo.');
    if (stopPrice.lessThanOrEqualTo(0)) return zero('Preço de stop não positivo.');

    // Sem esta guarda, um stop acima da entrada daria distância negativa e
    // quantidade negativa — que viraria uma ordem de venda a descoberto sem
    // ninguém ter pedido isso.
    if (stopPrice.greaterThanOrEqualTo(entryPrice)) {
        return zero('Stop precisa ficar ABAIXO da entrada numa posição comprada.');
    }

    const riskBudget = capital.mul(riskFraction);
    const riskPerUnit = entryPrice.minus(stopPrice);
    const rawQuantity = riskBudget.dividedBy(riskPerUnit);

    // O capital é um teto independente do orçamento de risco: com stop muito
    // próximo, a fórmula pediria uma posição maior que o dinheiro disponível.
    const maxAffordable = capital.dividedBy(entryPrice);
    const capped = Decimal.min(rawQuantity, maxAffordable);
    const quantity = truncateToStep(capped, params.stepSize);

    if (quantity.lessThanOrEqualTo(0)) {
        return zero('Quantidade truncada a zero pelo passo do símbolo (capital pequeno demais para este preço).');
    }

    const notional = quantity.mul(entryPrice);
    if (params.minNotional && notional.lessThan(params.minNotional)) {
        return zero(
            `Notional ${notional.toFixed(2)} abaixo do mínimo da corretora (${params.minNotional.toFixed(2)}). ` +
                `Aumentar a posição para atingir o mínimo violaria o limite de risco — melhor não operar.`,
        );
    }

    return { quantity, notional, riskAmount: quantity.mul(riskPerUnit) };
}

/**
 * Stop móvel (trailing): sobe conforme o preço sobe, nunca desce.
 *
 * Nunca descer é a propriedade essencial. Um stop que afrouxa quando o preço
 * cai é a versão automatizada de "vou dar mais uma chance" — o comportamento
 * que transforma uma perda pequena e planejada em uma perda grande.
 */
export function updateTrailingStop(currentStop: Decimal, highestPrice: Decimal, trailFraction: Decimal): Decimal {
    if (trailFraction.lessThanOrEqualTo(0) || trailFraction.greaterThanOrEqualTo(1)) return currentStop;
    const candidate = highestPrice.mul(new Decimal(1).minus(trailFraction));
    return candidate.greaterThan(currentStop) ? candidate : currentStop;
}

/**
 * Retorno esperado da estratégia por operação, dado taxa de acerto e a razão
 * entre ganho médio e perda média.
 *
 * Existe para tornar explícito o que decide a lucratividade de uma estratégia
 * direcional: NÃO é acertar muito. Uma estratégia que acerta 40% com ganho 3x
 * maior que a perda é lucrativa; uma que acerta 90% com perdas 10x maiores que
 * os ganhos quebra a conta. Perseguir "taxa de erro mínima" sem olhar esta
 * conta leva justamente ao segundo caso.
 */
export function expectancyPerTrade(winRate: Decimal, avgWin: Decimal, avgLoss: Decimal): Decimal {
    const lossRate = new Decimal(1).minus(winRate);
    return winRate.mul(avgWin).minus(lossRate.mul(avgLoss));
}

/**
 * Quantas perdas seguidas o capital aguenta antes de cair abaixo de uma
 * fração de sobrevivência.
 *
 * Serve para dimensionar `riskFraction` com honestidade: sequências de 8-10
 * perdas seguidas acontecem em qualquer estratégia direcional, e o parâmetro
 * de risco precisa ser escolhido para sobreviver a elas, não para maximizar o
 * ganho da próxima operação.
 */
export function consecutiveLossesSurvivable(riskFraction: Decimal, ruinFraction = new Decimal('0.5')): number {
    if (riskFraction.lessThanOrEqualTo(0) || riskFraction.greaterThanOrEqualTo(1)) return 0;
    // (1 - risco)^n >= ruinFraction  =>  n <= ln(ruinFraction) / ln(1 - risco)
    const survival = Math.log(ruinFraction.toNumber()) / Math.log(new Decimal(1).minus(riskFraction).toNumber());
    return Math.floor(survival);
}
