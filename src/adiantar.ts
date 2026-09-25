// Arquivo: src/adiantar.ts
//
// Saber quem VAI cair, antes de cair.
//
// O caçador de hoje lê o preço do oráculo e pergunta quem já caiu. Isso chega
// tarde por construção: quando o oráculo mudou, quem estava na disputa já agiu
// sobre a causa da mudança, um bloco antes. Encurtar o intervalo não conserta
// isso — sai de "quatro blocos atrasada" para "um bloco atrasada".
//
// A saída não é ler mais rápido, e sim ler OUTRA COISA. O preço da Aave vem de
// um feed Chainlink, e um feed Chainlink e uma copia atrasada do preco real:
// ele so escreve na blockchain quando o mercado se afasta de um limiar (na
// ordem de 0,5%) ou quando estoura o tempo maximo.
//
// Entao o preco da Binance, que custa zero e chega em milissegundos, diz com
// antecedencia o que o oraculo vai dizer. Quem souber ler isso sabe quem vai
// cair antes de cair — e pode estar com a transacao pronta.
import { Decimal } from 'decimal.js';

/**
 * O desvio que costuma fazer um feed Chainlink escrever na blockchain.
 *
 * Varia por feed e pode mudar sem aviso, por isso e parametro com um padrao
 * conservador, e nao uma constante escondida no meio do codigo. Errar para
 * MENOS aqui faz acordar cedo demais (gasta um pouco de CU a toa); errar para
 * MAIS faz perder a janela inteira. Na duvida, menos.
 */
export const DESVIO_TIPICO_PCT = new Decimal(0.5);

/**
 * A que preço da garantia esta posição vira liquidável.
 *
 * `quedaAteLiquidar` ja diz de quantos por cento e a queda. Aqui isso vira um
 * PRECO, que e o que dá para comparar com o mercado em tempo real.
 *
 * Cuidado honesto: a conta supõe que a queda inteira vem da garantia que se
 * está olhando. Numa posição com garantia misturada — metade ETH, metade
 * stablecoin — a saúde cai mais devagar que isso, e o preço de queda real fica
 * ABAIXO do que esta função devolve. O erro é de propósito nesse sentido: uma
 * lista de vigilância que acorda cedo demais gasta CU; uma que acorda tarde
 * demais perde a liquidação.
 */
export function precoDeQueda(precoAtual: Decimal, quedaPct: Decimal): Decimal {
    if (quedaPct.lessThanOrEqualTo(0)) return precoAtual;
    return precoAtual.mul(new Decimal(100).minus(quedaPct)).dividedBy(100);
}

export interface Gatilho {
    devedor: string;
    /** De quantos % o preço precisa cair, como o oráculo vê hoje. */
    quedaPct: Decimal;
    /** O preço da garantia que derruba esta posição. */
    precoAlvo: Decimal;
}

/**
 * A fila de quem cai primeiro, do mais próximo para o mais distante.
 *
 * Ordena por PREÇO ALVO, decrescente: quem precisa da menor queda tem o preço
 * alvo mais alto, e é o primeiro a cair. Ordenar por outra coisa e fatiar daria
 * uma amostra com cara de fila — o defeito mais repetido deste projeto.
 */
export function quemCaiPrimeiro(
    posicoes: Array<{ devedor: string; quedaPct: Decimal }>,
    precoAtual: Decimal,
): Gatilho[] {
    return posicoes
        .filter((p) => p.quedaPct.greaterThan(0))
        .map((p) => ({ devedor: p.devedor, quedaPct: p.quedaPct, precoAlvo: precoDeQueda(precoAtual, p.quedaPct) }))
        .sort((a, b) => b.precoAlvo.comparedTo(a.precoAlvo));
}

/**
 * Quem o MERCADO já derrubou, mesmo que o oráculo ainda não saiba.
 *
 * Esta é a lista que interessa nos segundos que decidem: são as posições que
 * vão estar liquidáveis assim que o feed escrever na blockchain. Quem só olha
 * o oráculo descobre isso depois; quem olha o mercado descobre antes.
 */
export function jaCairamNoMercado(fila: Gatilho[], precoDeMercado: Decimal): Gatilho[] {
    return fila.filter((g) => precoDeMercado.lessThanOrEqualTo(g.precoAlvo));
}

/** O quanto o mercado já andou em relação ao que está escrito na blockchain. */
export function desvioDoOraculo(precoDeMercado: Decimal, precoDoOraculo: Decimal): Decimal {
    if (precoDoOraculo.lessThanOrEqualTo(0)) return new Decimal(0);
    return precoDoOraculo.minus(precoDeMercado).dividedBy(precoDoOraculo).mul(100);
}

export type Postura = 'dormindo' | 'atento' | 'dedo no gatilho';

/**
 * Em que postura o bot deve estar AGORA.
 *
 * Esta é a ideia inteira em uma função. Três estados, e o caro só acontece no
 * terceiro:
 *
 *   'dormindo'         — o mercado não ameaça ninguém. Ciclo normal de 8s.
 *   'atento'           — o mercado já andou o bastante para o feed escrever a
 *                        qualquer momento, mas ninguém cairia com isso.
 *   'dedo no gatilho'  — o mercado JÁ derrubou alguém e o oráculo ainda não
 *                        sabe. São os segundos que decidem: é aqui, e só aqui,
 *                        que vale ler a blockchain várias vezes por segundo.
 *
 * O desenho existe para o custo não explodir. Ler rápido o tempo todo custaria
 * mais que o teto da conta inteira; ler rápido só nesses segundos custa quase
 * nada, porque eles são raros.
 */
export function qualPostura(
    precoDeMercado: Decimal,
    precoDoOraculo: Decimal,
    fila: Gatilho[],
    desvioDeEscrita: Decimal = DESVIO_TIPICO_PCT,
): Postura {
    if (jaCairamNoMercado(fila, precoDeMercado).length > 0) return 'dedo no gatilho';
    if (desvioDoOraculo(precoDeMercado, precoDoOraculo).greaterThanOrEqualTo(desvioDeEscrita)) return 'atento';
    return 'dormindo';
}

/**
 * Quanto esperar entre duas leituras da blockchain, dada a postura.
 *
 * Dormindo é o ritmo que cabe no orçamento. Dedo no gatilho é o ritmo que ganha
 * a corrida — e só é pagável porque dura segundos.
 */
export function ritmoDaPostura(postura: Postura, intervaloNormalMs: number): number {
    switch (postura) {
        case 'dedo no gatilho': return 200;
        case 'atento': return 1000;
        case 'dormindo': return intervaloNormalMs;
    }
}

/**
 * Quanto custaria, em CUs por mês, viver assim.
 *
 * Existe pela mesma razão de `custoMensalEmCUs`: "acho que cabe" já nos custou
 * dois dias de orçamento, e desenho novo sem conta nova é como o antigo virou
 * problema.
 */
export function custoDaVigiliaEmCUs(entrada: {
    cuPorLeitura: number;
    minutosAtentoPorDia: number;
    minutosNoGatilhoPorDia: number;
}): number {
    const porDia =
        (entrada.minutosAtentoPorDia * 60) * 1 * entrada.cuPorLeitura +
        (entrada.minutosNoGatilhoPorDia * 60) * 5 * entrada.cuPorLeitura;
    return Math.round(porDia * 30);
}
