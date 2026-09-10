// Arquivo: src/volumeSpike.ts
//
// Gatilho de pico de volume em velas de 1 minuto.
//
// A DECISÃO QUE DEFINE ESTE MÓDULO: VELA FECHADA OU VELA EM FORMAÇÃO?
//
// Esperar a vela de 1 minuto fechar é agir até 60 segundos depois do evento —
// numa estratégia que busca 0,3% a 0,8%, o movimento já aconteceu. Mas usar a
// vela em formação tem uma armadilha silenciosa: aos 10 segundos, o volume
// dela é naturalmente ~1/6 do de uma vela cheia. Comparar esse pedaço com a
// média de velas COMPLETAS faz o gatilho quase nunca disparar cedo, e disparar
// quase sempre nos últimos segundos — que é justamente quando já é tarde.
//
// Por isso a comparação aqui é por TAXA, não por total:
//
//     volume por segundo da vela em formação  vs  volume por segundo da média
//
// Assim um pico de verdade nos primeiros 5 segundos é detectado como pico, e
// não confundido com "vela ainda vazia". O preço dessa escolha é que os
// primeiros segundos têm pouca amostra e a taxa fica ruidosa — daí o mínimo de
// segundos decorridos antes de qualquer disparo.
//
// A SEGUNDA REGRA: VOLUME SOZINHO NÃO É SINAL.
//
// Volume alto acontece nos dois lados de uma briga: comprador agressivo contra
// vendedor agressivo, preço parado no meio. Sem confirmação direcional, o
// gatilho entra exatamente nas vezes em que o mercado está indeciso — que são
// as piores para um scalp com stop apertado.
import { Decimal } from 'decimal.js';

export interface Vela1m {
    aberturaMs: number;
    abertura: Decimal;
    maxima: Decimal;
    minima: Decimal;
    fechamento: Decimal;
    volume: Decimal;
}

export interface SinalDePico {
    direcao: 'alta' | 'baixa';
    /** Quantas vezes a taxa de volume está acima da média. */
    multiploDoVolume: Decimal;
    /** Variação do preço na vela em formação, como fração. */
    variacao: Decimal;
    preco: Decimal;
}

/**
 * Há pico de volume COM direção?
 *
 * `velasFechadas` são a referência (as N anteriores, completas).
 * `emFormacao` é a vela atual, parcial.
 */
export function detectarPicoDeVolume(params: {
    velasFechadas: Vela1m[];
    emFormacao: Vela1m;
    /** Segundos já decorridos dentro da vela em formação. */
    segundosDecorridos: number;
    /** Quantas vezes acima da média a taxa precisa estar. */
    multiplicador: Decimal;
    /** Movimento mínimo do preço na vela, para confirmar direção. */
    variacaoMinima: Decimal;
    /** Mínimo de segundos antes de qualquer disparo — a taxa é ruidosa no começo. */
    segundosMinimos?: number;
    /** Quantas velas fechadas são exigidas para a média valer. */
    minimoDeVelas?: number;
}): SinalDePico | null {
    const minVelas = params.minimoDeVelas ?? 10;
    const segMin = params.segundosMinimos ?? 5;

    // Amostra insuficiente devolve null, não "sem sinal": são coisas
    // diferentes, e tratar "não sei" como "não" faz o motor operar no boot com
    // uma média de duas velas.
    if (params.velasFechadas.length < minVelas) return null;
    if (params.segundosDecorridos < segMin) return null;

    const referencia = params.velasFechadas.slice(-minVelas);
    const volumeMedio = referencia
        .reduce((acc, v) => acc.plus(v.volume), new Decimal(0))
        .dividedBy(referencia.length);
    if (volumeMedio.lessThanOrEqualTo(0)) return null;

    // Taxa contra taxa: a vela de referência tem 60 segundos, a em formação
    // tem `segundosDecorridos`. Comparar totais compararia coisas de duração
    // diferente e enviesaria o gatilho para o fim da vela.
    const taxaMedia = volumeMedio.dividedBy(60);
    const taxaAtual = params.emFormacao.volume.dividedBy(params.segundosDecorridos);
    const multiplo = taxaAtual.dividedBy(taxaMedia);
    if (multiplo.lessThan(params.multiplicador)) return null;

    // Confirmação direcional. Volume alto com preço parado é briga equilibrada,
    // e é onde um scalp de stop apertado mais apanha.
    const variacao = params.emFormacao.fechamento
        .minus(params.emFormacao.abertura)
        .dividedBy(params.emFormacao.abertura);
    if (variacao.abs().lessThan(params.variacaoMinima)) return null;

    return {
        direcao: variacao.greaterThan(0) ? 'alta' : 'baixa',
        multiploDoVolume: multiplo,
        variacao,
        preco: params.emFormacao.fechamento,
    };
}

/**
 * Preços de saída para uma posição, em ordem de segurança.
 *
 * Devolve os dois juntos de propósito: um alvo sem stop é uma posição sem
 * limite de perda, e num scalp alavancado essa é a única falha que não tem
 * conserto. Quem chama recebe os dois ou nenhum.
 */
export function precosDeSaida(params: {
    entrada: Decimal;
    direcao: 'alta' | 'baixa';
    alvo: Decimal;
    stop: Decimal;
}): { alvo: Decimal; stop: Decimal } {
    const sinal = params.direcao === 'alta' ? 1 : -1;
    return {
        alvo: params.entrada.mul(new Decimal(1).plus(params.alvo.mul(sinal))),
        stop: params.entrada.mul(new Decimal(1).minus(params.stop.mul(sinal))),
    };
}
