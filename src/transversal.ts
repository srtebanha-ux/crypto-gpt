// Arquivo: src/transversal.ts
//
// Sinal TRANSVERSAL: não olha uma moeda, olha a POSIÇÃO RELATIVA dela entre as
// outras. A cada rodada ordena o universo pelo retorno da última hora e marca
// os extremos.
//
// Por que trocar de família depois de ~700 operações reprovadas: o pico de
// volume é um EVENTO PÚBLICO e INSTANTÂNEO. Milhares de robôs veem a mesma
// vela no mesmo segundo, e este motor lê preço por REST de dez em dez
// segundos — chega por último numa corrida de velocidade. Três amostras
// independentes deram abaixo do acaso, o que é consistente com "a vantagem
// existe e já foi arbitrada antes de a gente ver".
//
// Aqui não há evento nem corrida. A pergunta é "esta moeda subiu MAIS que as
// outras?", que é uma comparação: ela continua verdadeira dez segundos depois,
// e sessenta também. Latência deixa de ser desvantagem.
//
// CONVENÇÃO DE DIREÇÃO — importante, e escolhida ANTES de ver qualquer dado:
// a direção do sinal é a do MOMENTO (quem subiu mais recebe 'alta'). Logo, a
// coluna `contra` da grade — que é a que o relatório de hipótese pré-registrada
// lê — corresponde à REVERSÃO: vender quem subiu demais, comprar quem caiu
// demais. É essa a hipótese registrada. Deixar isto escrito no código, e não
// na memória de alguém, é o que impede trocar de lado depois de ver o
// resultado e chamar isso de descoberta.
import { Decimal } from 'decimal.js';
import { Vela1m } from './volumeSpike';

export interface RetornoDoSimbolo {
    symbol: string;
    retorno: Decimal;
    preco: Decimal;
}

export interface SinalTransversal {
    symbol: string;
    direcao: 'alta' | 'baixa';
    retorno: Decimal;
    preco: Decimal;
}

/**
 * Retorno fechado a fechado ao longo de `minutos`.
 *
 * Devolve null em vez de zero quando faltam velas. Zero seria um retorno
 * VÁLIDO — colocaria a moeda no meio do ranking em vez de fora dele — e uma
 * moeda recém-entrada no universo entraria na conta como se fosse a mais
 * estável de todas, que é o oposto da verdade.
 */
export function retornoDaJanela(velas: Vela1m[], minutos: number): Decimal | null {
    if (minutos < 1) return null;
    if (velas.length < minutos + 1) return null;
    const recorte = velas.slice(-(minutos + 1));
    const inicio = recorte[0].fechamento;
    const fim = recorte[recorte.length - 1].fechamento;
    if (inicio.lessThanOrEqualTo(0)) return null;
    return fim.dividedBy(inicio).minus(1);
}

/**
 * Os `quantos` melhores e os `quantos` piores do universo.
 *
 * Três recusas, e cada uma existe por um motivo que já custou caro neste
 * projeto:
 *
 *  - universo pequeno demais: ordenar cinco moedas não produz "extremo",
 *    produz ruído com nome de ranking;
 *  - topo e fundo sobrepostos: com seis moedas e quantos=3, a mesma moeda
 *    seria comprada e vendida ao mesmo tempo;
 *  - separação mínima: se as quinze moedas andaram todas quase igual, o
 *    primeiro e o último colocados são indistinguíveis, e o "sinal" é a
 *    ordenação de um empate. É a mesma doença da regra do empate na grade —
 *    medir a convenção em vez do mercado.
 */
export function extremosTransversais(params: {
    retornos: RetornoDoSimbolo[];
    quantos: number;
    minimoDeSimbolos: number;
    /** Distância mínima entre o pior do topo e o melhor do fundo. */
    separacaoMinima?: Decimal;
}): SinalTransversal[] {
    const { retornos, quantos, minimoDeSimbolos } = params;
    if (quantos < 1) return [];
    if (retornos.length < minimoDeSimbolos) return [];
    if (quantos * 2 > retornos.length) return [];

    const ordenado = [...retornos].sort((a, b) => b.retorno.comparedTo(a.retorno));
    const topo = ordenado.slice(0, quantos);
    const fundo = ordenado.slice(retornos.length - quantos);

    const sep = params.separacaoMinima;
    if (sep !== undefined) {
        const piorDoTopo = topo[topo.length - 1].retorno;
        const melhorDoFundo = fundo[0].retorno;
        if (piorDoTopo.minus(melhorDoFundo).lessThan(sep)) return [];
    }

    return [
        ...topo.map((r) => ({ symbol: r.symbol, direcao: 'alta' as const, retorno: r.retorno, preco: r.preco })),
        ...fundo.map((r) => ({ symbol: r.symbol, direcao: 'baixa' as const, retorno: r.retorno, preco: r.preco })),
    ];
}
