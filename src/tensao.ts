// Arquivo: src/tensao.ts
//
// A pergunta que este arquivo responde é a que separava uma queda que volta
// de uma queda que continua — e que nenhum indicador de preço responde:
//
//   Esta queda é gente VENDENDO, ou gente SENDO VENDIDA?
//
// São fenômenos opostos com o mesmo gráfico. Venda voluntária é opinião: quem
// vende acha que vai cair mais, e frequentemente está certo. Liquidação
// forçada é mecânica: o preço tocou uma linha e um motor despejou a posição no
// livro sem olhar preço. A primeira não tem por que reverter. A segunda tem —
// a pressão vendedora acaba exatamente quando as posições acabam, e o preço
// volta para onde estava antes do vácuo.
//
// A impressão digital que separa as duas é o OPEN INTEREST, o número de
// contratos abertos:
//
//   preço CAI + OI CAI   -> posições estão SUMINDO. Alguém foi fechado à
//                            força (ou tomou lucro). É a assinatura da cascata.
//   preço CAI + OI SOBE  -> posições estão NASCENDO. Vendedores novos estão
//                            entrando com convicção. Não é vácuo, é fluxo —
//                            e comprar o repique aqui é comprar contra gente
//                            que acabou de decidir vender.
//
// Nenhuma das duas aparece no candle. As duas aparecem no OI.
//
// O que este arquivo NÃO faz, porque não é possível: calcular onde estão as
// liquidações ANTES de elas acontecerem. A Binance não publica preço de
// liquidação de ninguém, e num livro contínuo com participantes adaptativos
// não existe a tabela combinatória que se explora numa loteria. O que existe
// é observar a cascata ENQUANTO ela acontece — pelo OI e pelo fluxo real de
// liquidações — e agir na confirmação, nunca na antecipação.
import { Decimal } from 'decimal.js';

/** Leitura de tensão do mercado num instante. */
export interface AmostraDeTensao {
    emMs: number;
    preco: Decimal;
    /** Contratos em aberto (valor nocional ou quantidade — só a variação importa). */
    openInterest: Decimal;
    /** Funding rate corrente (0.0001 = 0,01% por período). */
    funding: Decimal;
}

export type RegimeDaQueda =
    | 'cascata'            // preço cai, OI cai: posições sendo fechadas à força
    | 'distribuicao'       // preço cai, OI sobe: vendedores novos entrando
    | 'realizacao'         // preço sobe, OI cai: compradores saindo
    | 'acumulacao'         // preço sobe, OI sobe
    | 'indefinido';        // variação pequena demais para classificar

export interface Classificacao {
    regime: RegimeDaQueda;
    variacaoDePreco: Decimal;
    variacaoDeOi: Decimal;
    /**
     * Quanto do movimento foi acompanhado por destruição de posição.
     * 1 significa que o OI caiu proporcionalmente tanto quanto o preço —
     * cascata pura. Perto de 0, o preço andou sozinho.
     */
    intensidade: Decimal;
}

/**
 * Classifica o regime entre duas amostras.
 *
 * `minimoDeMovimento` existe para não classificar ruído: com o preço parado,
 * o sinal do OI é aleatório, e um regime inventado é pior que "indefinido"
 * porque ele entra na estatística como se fosse informação.
 */
export function classificarRegime(params: {
    antes: AmostraDeTensao;
    agora: AmostraDeTensao;
    minimoDeMovimento?: Decimal;
}): Classificacao {
    const minimo = params.minimoDeMovimento ?? new Decimal('0.005');

    if (params.antes.preco.lessThanOrEqualTo(0) || params.antes.openInterest.lessThanOrEqualTo(0)) {
        return {
            regime: 'indefinido',
            variacaoDePreco: new Decimal(0),
            variacaoDeOi: new Decimal(0),
            intensidade: new Decimal(0),
        };
    }

    const dP = params.agora.preco.minus(params.antes.preco).dividedBy(params.antes.preco);
    const dOi = params.agora.openInterest.minus(params.antes.openInterest).dividedBy(params.antes.openInterest);

    if (dP.abs().lessThan(minimo)) {
        return { regime: 'indefinido', variacaoDePreco: dP, variacaoDeOi: dOi, intensidade: new Decimal(0) };
    }

    const intensidade = dOi.isNegative() ? dOi.abs().dividedBy(dP.abs()) : new Decimal(0);

    if (dP.isNegative()) {
        return {
            regime: dOi.isNegative() ? 'cascata' : 'distribuicao',
            variacaoDePreco: dP,
            variacaoDeOi: dOi,
            intensidade,
        };
    }
    return {
        regime: dOi.isNegative() ? 'realizacao' : 'acumulacao',
        variacaoDePreco: dP,
        variacaoDeOi: dOi,
        intensidade,
    };
}

/**
 * O mercado está TENSO — sobrealavancado num lado só?
 *
 * Funding é aluguel: quando é muito positivo, comprados estão pagando caro
 * para manter posição, o que só acontece quando há comprados demais. Esse é o
 * combustível da cascata — não a causa dela, mas a razão de ela ser grande
 * quando começa.
 *
 * O sinal é do funding, não o seu valor absoluto: funding muito NEGATIVO é a
 * mesma tensão do outro lado, e a cascata correspondente é de alta. Por isso
 * a função devolve também para que lado o mercado está torto.
 */
export interface Tensao {
    tenso: boolean;
    /** 'comprados' = excesso de posições compradas; a cascata provável é de queda. */
    ladoLotado: 'comprados' | 'vendidos' | 'nenhum';
    fundingAnualizado: Decimal;
}

export function medirTensao(params: {
    funding: Decimal;
    /** Acima deste funding anualizado (em fração) o mercado é considerado tenso. */
    limiteAnualizado?: Decimal;
    /** Períodos de funding por dia na Binance: 3 (a cada 8h). */
    periodosPorDia?: number;
}): Tensao {
    const limite = params.limiteAnualizado ?? new Decimal('0.30'); // 30% ao ano
    const periodos = params.periodosPorDia ?? 3;
    const anualizado = params.funding.mul(periodos).mul(365);

    if (anualizado.abs().lessThan(limite)) {
        return { tenso: false, ladoLotado: 'nenhum', fundingAnualizado: anualizado };
    }
    return {
        tenso: true,
        ladoLotado: anualizado.isPositive() ? 'comprados' : 'vendidos',
        fundingAnualizado: anualizado,
    };
}

/**
 * A queda merece ser operada como ricochete?
 *
 * Junta as duas leituras. Tensão sozinha não basta — um mercado tenso pode
 * ficar tenso por semanas. Cascata sozinha também não: uma cascata pequena num
 * mercado equilibrado não tem de onde tirar o repique. O que interessa é a
 * cascata acontecendo NUM mercado que estava torto para o lado que apanhou.
 */
export function quedaOperavel(params: {
    classificacao: Classificacao;
    tensao: Tensao;
    intensidadeMinima?: Decimal;
}): { operavel: boolean; motivo: string } {
    const minima = params.intensidadeMinima ?? new Decimal('0.3');

    if (params.classificacao.regime !== 'cascata') {
        return {
            operavel: false,
            motivo:
                `Regime '${params.classificacao.regime}': o OI ${params.classificacao.variacaoDeOi.isNegative() ? 'caiu' : 'subiu'} ` +
                `${params.classificacao.variacaoDeOi.mul(100).toFixed(2)}%. Só 'cascata' (preço e OI caindo juntos) tem repique mecânico.`,
        };
    }

    if (params.classificacao.intensidade.lessThan(minima)) {
        return {
            operavel: false,
            motivo:
                `Cascata fraca: OI caiu só ${params.classificacao.intensidade.toFixed(2)}x o movimento do preço ` +
                `(mínimo ${minima.toFixed(2)}). Pouca posição destruída, pouco vácuo para preencher.`,
        };
    }

    if (!params.tensao.tenso) {
        return {
            operavel: false,
            motivo:
                `Cascata real, mas o mercado não estava torto (funding anualizado ` +
                `${params.tensao.fundingAnualizado.mul(100).toFixed(1)}%). Sem excesso de um lado, o repique é fraco.`,
        };
    }

    if (params.tensao.ladoLotado !== 'comprados') {
        return {
            operavel: false,
            motivo:
                'O lado lotado era o dos vendidos — uma cascata de QUEDA aqui está liquidando quem já era minoria. ' +
                'O combustível está do outro lado.',
        };
    }

    return {
        operavel: true,
        motivo:
            `Cascata com intensidade ${params.classificacao.intensidade.toFixed(2)}x num mercado com funding ` +
            `anualizado de ${params.tensao.fundingAnualizado.mul(100).toFixed(1)}% (comprados lotados).`,
    };
}
