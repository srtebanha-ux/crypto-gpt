// Arquivo: src/leverage.ts
//
// Aritmética de alavancagem, isolada do resto e sem nenhuma chamada de rede.
//
// Está separada porque alavancagem introduz um modo de falha que NÃO EXISTE no
// spot: a LIQUIDAÇÃO. No spot, uma posição que anda contra você vira prejuízo e
// o stop fecha. Alavancado, a corretora fecha a posição sozinha quando a perda
// come a margem — e se isso acontecer ANTES do stop, o "risco por operação" que
// o dimensionamento calculou é uma mentira: você perde a margem inteira, não o
// que planejou perder.
//
// É um erro silencioso da pior espécie. Nada lança, nada fica vermelho no log:
// o motor simplesmente para de respeitar o próprio limite de risco, e só se
// descobre quando a conta zera.
import { Decimal } from 'decimal.js';

/**
 * Taxa de margem de manutenção padrão da Binance para posições pequenas.
 *
 * A Binance usa faixas por tamanho de posição; nas faixas mais baixas (que é
 * onde $20 a 10x vive, com nocional de $200) fica em 0,4%-0,5%. Usamos o valor
 * MAIS ALTO da faixa de propósito: superestimar a manutenção aproxima a
 * liquidação estimada, e errar para o lado conservador aqui custa uma operação
 * recusada; errar para o outro custa a conta.
 */
export const MARGEM_DE_MANUTENCAO_PADRAO = new Decimal('0.005');

/**
 * A que distância do preço de entrada a posição é liquidada, como fração.
 *
 * Aproximação de margem isolada: a margem cobre 1/alavancagem do nocional, e a
 * corretora liquida quando o que sobra encosta na margem de manutenção. A 10x
 * com manutenção de 0,5%, dá 9,5% — não 10%.
 *
 * É aproximação, e deliberadamente pessimista: a conta real da Binance inclui
 * taxas de abertura e fechamento, que só aproximam mais a liquidação. Nunca
 * usar este número como se fosse exato.
 */
export function distanciaAteLiquidacao(
    alavancagem: Decimal,
    margemDeManutencao: Decimal = MARGEM_DE_MANUTENCAO_PADRAO,
): Decimal {
    if (alavancagem.lessThanOrEqualTo(0)) {
        throw new Error(`Alavancagem inválida: ${alavancagem.toString()}`);
    }
    // Sem alavancagem não existe liquidação: no spot o preço pode ir a zero e
    // ninguém fecha nada. Devolver 1 (100%) expressa exatamente isso.
    if (alavancagem.lessThanOrEqualTo(1)) return new Decimal(1);
    const distancia = new Decimal(1).dividedBy(alavancagem).minus(margemDeManutencao);
    return distancia.greaterThan(0) ? distancia : new Decimal(0);
}

export type VeredictoDoStop =
    | { seguro: true }
    | { seguro: false; motivo: string; distanciaDoStop: Decimal; distanciaDaLiquidacao: Decimal };

/**
 * O stop dispara ANTES da liquidação?
 *
 * Esta é a pergunta que separa "arriscar 2% do capital" de "arriscar tudo". Se
 * a liquidação vier primeiro, o stop nunca é exercido e a perda real não é a
 * calculada — é a margem inteira.
 *
 * Exemplo do porquê isso morde na prática: stop a 2x ATR, numa alt em pump com
 * ATR de 5% no gráfico de 15m, fica a 10% do preço. A 10x a liquidação está a
 * 9,5%. O stop está DEPOIS da liquidação, e a operação que parecia arriscar 2%
 * arrisca 100%.
 *
 * `folga` exige que o stop fique com margem de sobra em vez de encostar: 0,8
 * significa "o stop precisa caber em 80% da distância até a liquidação". A
 * distância até a liquidação é uma estimativa, e encostar nela é confiar demais
 * numa aproximação.
 */
export function stopDisparaAntesDaLiquidacao(params: {
    /** Distância entrada→stop como FRAÇÃO do preço de entrada (0.02 = 2%). */
    distanciaDoStop: Decimal;
    alavancagem: Decimal;
    margemDeManutencao?: Decimal;
    folga?: Decimal;
}): VeredictoDoStop {
    const distanciaDaLiquidacao = distanciaAteLiquidacao(
        params.alavancagem,
        params.margemDeManutencao ?? MARGEM_DE_MANUTENCAO_PADRAO,
    );
    const folga = params.folga ?? new Decimal('0.8');
    const limite = distanciaDaLiquidacao.mul(folga);

    if (params.distanciaDoStop.lessThanOrEqualTo(0)) {
        return {
            seguro: false,
            motivo: 'Distância do stop é zero ou negativa — não há stop a respeitar.',
            distanciaDoStop: params.distanciaDoStop,
            distanciaDaLiquidacao,
        };
    }
    if (params.distanciaDoStop.greaterThan(limite)) {
        return {
            seguro: false,
            motivo:
                `Stop a ${params.distanciaDoStop.mul(100).toFixed(2)}% do preço, mas a ${params.alavancagem}x a ` +
                `liquidação chega em ${distanciaDaLiquidacao.mul(100).toFixed(2)}% (limite de segurança: ` +
                `${limite.mul(100).toFixed(2)}%). A posição seria liquidada ANTES do stop, e a perda seria a ` +
                'margem inteira, não o risco calculado. Reduza a alavancagem ou aperte o stop.',
            distanciaDoStop: params.distanciaDoStop,
            distanciaDaLiquidacao,
        };
    }
    return { seguro: true };
}

/**
 * A alavancagem que vale AGORA, dado o patrimônio e o alvo.
 *
 * O pedido foi "alavanca até chegar em 5 mil". Desalavancar ao atingir o alvo é
 * o que transforma um ganho em dinheiro guardado: mantida a alavancagem, a
 * mesma volatilidade que levou até lá continua podendo trazer de volta, e o
 * alvo vira um número pelo qual a conta passou, não um lugar onde ela ficou.
 *
 * A transição é por PATRIMÔNIO corrente, avaliada a cada ciclo — não uma vez no
 * boot. Decidir no boot deixaria a conta alavancada por horas depois de já ter
 * passado do alvo.
 */
export function alavancagemEfetiva(params: {
    patrimonio: Decimal;
    /** Alvo em que a alavancagem volta para 1x. Zero ou ausente desliga a regra. */
    alvo: Decimal;
    alavancagemMaxima: Decimal;
}): Decimal {
    if (params.alavancagemMaxima.lessThanOrEqualTo(1)) return new Decimal(1);
    if (params.alvo.lessThanOrEqualTo(0)) return params.alavancagemMaxima;
    return params.patrimonio.greaterThanOrEqualTo(params.alvo) ? new Decimal(1) : params.alavancagemMaxima;
}

/**
 * Custo de ida e volta como FRAÇÃO DO CAPITAL, não do nocional.
 *
 * A distinção é o ponto. A taxa incide sobre a posição alavancada, mas quem
 * paga é o capital: a 10x, 0,05% por perna vira 1% do capital por operação
 * completa. Olhar "0,05%" e concluir que é barato é o erro que faz uma
 * estratégia lucrativa no papel sangrar até zerar — cem operações e a conta
 * acabou só de pedágio, sem ter perdido nenhuma.
 */
export function custoDeIdaEVoltaSobreCapital(alavancagem: Decimal, taxaPorPerna: Decimal): Decimal {
    return taxaPorPerna.mul(2).mul(alavancagem);
}

/**
 * Quanto do patrimônio o motor pode DE FATO arriscar.
 *
 * A ideia é a escada: alcançado um degrau, o excedente para de trabalhar e
 * vira lucro guardado, mesmo antes de sair da corretora. Sem isso, uma conta
 * que vai de $20 a $5.000 continua arriscando os $5.000 inteiros — e a mesma
 * volatilidade que a levou até lá a traz de volta. O degrau vira um número
 * pelo qual a conta passou, não um lugar onde ela ficou.
 *
 * Fica separado do saque de verdade de propósito: a chave de API não tem (nem
 * deve ter) permissão de saque. O motor congela o excedente; tirar do câmbio
 * continua sendo ato humano.
 */
export function capitalDeTrabalho(params: { patrimonio: Decimal; teto: Decimal }): Decimal {
    if (params.teto.lessThanOrEqualTo(0)) return params.patrimonio;
    return Decimal.min(params.patrimonio, params.teto);
}

/** O que já passou do teto e não deve mais ser arriscado. */
export function lucroCongelado(params: { patrimonio: Decimal; teto: Decimal }): Decimal {
    if (params.teto.lessThanOrEqualTo(0)) return new Decimal(0);
    const excedente = params.patrimonio.minus(params.teto);
    return excedente.greaterThan(0) ? excedente : new Decimal(0);
}
