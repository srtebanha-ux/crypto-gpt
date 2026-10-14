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
 *
 * ERA 0.5, E ERA PALPITE — este comentario dizia "na duvida, menos" e o numero
 * escolhido errava para MAIS, que e o lado que o proprio comentario proibia.
 *
 * MEDIDO em 2026-10-06 nos eventos `AnswerUpdated` dos agregadores da Base, 7
 * dias, cobertura 92,9% (ETH) e 90,9% (cbBTC) — entao as contagens sao piso, nao
 * teto:
 *
 *     ETH/USD    agregador 0xd772f6d9…   121,7 escritas/dia
 *                salto por escrita: p50 0,1603%  p90 0,2216%  max 1,3600%
 *                limiar aparente: 0,151%
 *     cbBTC/USD  agregador 0x13723399…   167,7 escritas/dia
 *                salto por escrita: p50 0,1143%  p90 0,1663%  max 0,4663%
 *                limiar aparente: 0,103%
 *
 * O limiar verdadeiro e de 3,3 a 4,9 vezes MENOR que o palpite. A consequencia
 * nao era teorica: `posturaPorMargem` arma 'atento' em `desvio x 0.6` = 0,30%,
 * e o desvio antes de uma escrita chega a 0,22% no p90. Ou seja, a postura
 * 'atento' — a que le a corrente mais rapido nos segundos que decidem — NUNCA
 * armava. O log dela de 2026-10-06 mostra o efeito: `0.0193% abaixo do oraculo
 * (dormindo)`, tres dias seguidos.
 *
 * 0,10 e o menor dos dois limiares medidos, que e o lado certo de errar.
 *
 * E O QUE ISTO NAO RESOLVE, para a proxima sessao nao se enganar: o oraculo
 * persegue o mercado dentro de 0,10–0,15%, entao o mercado NUNCA corre 1% na
 * frente do oraculo. Antecipar compra ~0,15% de dianteira, nao 1%. Um alvo a
 * 0,99% nao e alcancavel por antecipacao — ele cruza exatamente na escrita, e a
 * autopsia de 2026-09-28 mediu que os valiosos morrem nesse mesmo bloco.
 */
export const DESVIO_TIPICO_PCT = new Decimal(0.10);

/**
 * QUANTO UMA ESCRITA DO ORACULO ANDA, em pontos percentuais.
 *
 * Medidos na mesma varredura de 2026-10-06 (ETH/USD, 7 dias, cobertura 92,9%)
 * e registrados ate hoje APENAS no comentario acima — o que os tornava
 * inutilizaveis pelo codigo. Sao eles que dizem quanto da distancia de um alvo
 * uma escrita e capaz de fechar, e e essa a aposta de `atirarNaEscritaIminente`.
 *
 * O p90 e o numero de trabalho: errar para MAIS aqui faz atirar em alvo que a
 * escrita nao alcanca (gas perdido), errar para MENOS faz deixar passar o alvo.
 */
export const SALTO_P50_PCT = new Decimal(0.1603);
export const SALTO_P90_PCT = new Decimal(0.2216);
export const SALTO_MAX_PCT = new Decimal(1.36);

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

/**
 * A postura, decidida por PORCENTAGEM de queda — que e o que se sabe de fato.
 *
 * Corrige um erro do desenho anterior. Eu tinha escrito que uma queda de 0,1%
 * no mercado ja derruba quem esta a 0,04% de cair. Nao derruba: se o feed so
 * escreve na blockchain quando o desvio passa do limiar, uma queda de 0,1%
 * NAO move o preco on-chain, e sem o preco on-chain mover ninguem fica
 * liquidavel. O bot correria a 200ms para nada, e pagaria por isso.
 *
 * Sao duas condicoes, e as duas precisam valer:
 *
 *   1. o mercado caiu o bastante para o feed ESCREVER  (>= desvioDeEscrita)
 *   2. essa queda derruba alguem                        (>= menorMargem)
 *
 * A primeira condicao tambem e o que segura o custo: enquanto o desvio nao
 * chega no limiar, correr nao adianta; quando chega, o feed escreve em
 * segundos e a corrida acaba sozinha. O estado caro se limita sozinho.
 */
export function posturaPorMargem(
    quedaDoMercadoPct: Decimal,
    menorMargemPct: Decimal | null,
    desvioDeEscrita: Decimal = DESVIO_TIPICO_PCT,
): Postura {
    if (
        menorMargemPct !== null &&
        quedaDoMercadoPct.greaterThanOrEqualTo(desvioDeEscrita) &&
        quedaDoMercadoPct.greaterThanOrEqualTo(menorMargemPct)
    ) {
        return 'dedo no gatilho';
    }
    // Chegando perto do limiar: vale apertar o passo sem ainda gastar o caro.
    if (quedaDoMercadoPct.greaterThanOrEqualTo(desvioDeEscrita.mul(0.6))) return 'atento';
    return 'dormindo';
}

/**
 * Dormir de olho aberto.
 *
 * Conserta um gargalo que anulava boa parte da vantagem de olhar o mercado: a
 * checagem acontecia uma vez por ciclo, e o ciclo dorme 8 segundos quando o
 * mercado esta calmo. Ou seja, o preco podia cair, o feed escrever, a
 * liquidacao aparecer e sumir — tudo antes do bot piscar.
 *
 * E e um desperdicio gritante, porque olhar o mercado custa ZERO: nao passa
 * pela blockchain. O que precisa ser raro e ler a BLOCKCHAIN; olhar o preco
 * pode ser o tempo todo.
 *
 * Entao o sono vira fatias, e entre uma fatia e outra o bot olha. Se o mercado
 * mudar de postura no meio, ele acorda na hora em vez de esperar o resto.
 *
 * Devolve `true` se acordou cedo (algo mudou), `false` se dormiu tudo.
 */
export async function dormirDeOlho(
    totalMs: number,
    fatiaMs: number,
    olhar: () => Promise<boolean>,
    dormir: (ms: number) => Promise<void>,
): Promise<boolean> {
    if (totalMs <= 0) return false;
    // Fatia maior que o sono inteiro nao justifica olhar: dorme e pronto.
    if (fatiaMs <= 0 || fatiaMs >= totalMs) {
        await dormir(totalMs);
        return false;
    }
    let restante = totalMs;
    while (restante > 0) {
        const agora = Math.min(fatiaMs, restante);
        await dormir(agora);
        restante -= agora;
        if (restante <= 0) break;
        if (await olhar()) return true;
    }
    return false;
}

/**
 * Quem armar enquanto o oraculo ainda nao escreveu.
 *
 * A regra da Aave nao deixa liquidar antes de o preco on-chain mudar: a
 * posicao continua saudavel pela conta dela, e a transacao reverte. Ver antes
 * nao adianta para ARREMATAR antes.
 *
 * Mas adianta para CHEGAR PRONTO. Montar o alvo (qual garantia, qual divida,
 * quanto cobrir) custa uma ida a rede, e essa ida pode acontecer enquanto o
 * mercado ainda esta caindo. Quando o bloco chega, so resta assinar e mandar.
 *
 * Arma-se poucos, e os mais frageis: a lista esta ordenada por fragilidade, e
 * quem cai quando o oraculo escreve sao os primeiros dela. Armar duzentos
 * gastaria leitura a toa toda vez que o mercado balancasse.
 */
export function quemArmar(brasaOrdenada: string[], quantos: number): string[] {
    if (quantos <= 0) return [];
    return brasaOrdenada.slice(0, quantos);
}

/**
 * Se vale a pena armar agora.
 *
 * Armar custa uma leitura. Fazer isso a cada balanco do mercado gastaria mais
 * do que economiza, entao so se arma quando o feed esta perto de escrever — e
 * so se o que ja esta armado nao serve mais.
 */
/**
 * A postura que a CHEGADA POR JURO pede, independente do mercado.
 *
 * Existe por um buraco que so ficou visivel com os dois numeros lado a lado no
 * log de 2026-09-27 10:31:
 *
 *     margemDoAlvo: "precisa cair 1.1562% para virar alvo"
 *     mercado:      "0.1007% abaixo do oráculo (dormindo)"
 *
 * O alvo mais perto tem garantia USDC contra divida USDC. O preco CANCELA na
 * conta da saude dele: ele NAO precisa do mercado para cair, ele cai por juro.
 * E toda a prontidao do bot estava amarrada no mercado — `valeArmar` recusa
 * armar quando a postura e 'dormindo', e `ritmoDaPostura` devolve os 8
 * segundos cheios. Ou seja: o alvo mais proximo que existe ia chegar com o bot
 * dormindo, desarmado, e ate 8 segundos atrasado. Quatro blocos da Base.
 *
 * Os limiares sao generosos de proposito, e a conta justifica: chegada por juro
 * e RARA (meses de distancia) e PREVISTA, entao uma hora de ritmo de 1s mais
 * dez minutos de 200ms custam uns 170 mil CUs por chegada, contra um teto de
 * 38 milhoes por mes. Apertar isso economizaria nada e poderia custar a
 * liquidacao.
 *
 * A precisao tambem melhora sozinha perto do fim: a taxa de juros da Aave anda
 * com a utilizacao, entao uma previsao de 283 dias e mole — mas uma de dez
 * minutos exigiria que a taxa mudasse drasticamente dentro desses dez minutos
 * para errar. E a projecao e refeita a cada varredura.
 */
export function posturaPorChegada(
    msAteChegar: number | null,
    pertoMs = 3_600_000,
    muitoPertoMs = 600_000,
): Postura {
    if (msAteChegar === null || !Number.isFinite(msAteChegar) || msAteChegar < 0) return 'dormindo';
    if (msAteChegar <= muitoPertoMs) return 'dedo no gatilho';
    if (msAteChegar <= pertoMs) return 'atento';
    return 'dormindo';
}

/** Da mais urgente para a menos. A ordem e explicita para nao depender do enum. */
const URGENCIA: Record<Postura, number> = { 'dedo no gatilho': 2, atento: 1, dormindo: 0 };

/**
 * A mais urgente das duas posturas.
 *
 * Duas coisas independentes podem exigir pressa — o mercado caindo e um juro
 * chegando — e a resposta certa e a mais exigente das duas, nunca a ultima
 * calculada. Sobrescrever uma com a outra apagaria metade dos motivos de correr.
 */
export function posturaMaisForte(a: Postura, b: Postura): Postura {
    return URGENCIA[a] >= URGENCIA[b] ? a : b;
}

/**
 * Se vale armar, considerando que juro chegando tambem e motivo.
 *
 * `valeArmar` recusa quando a postura e 'dormindo', e isso esta certo para o
 * mercado. Mas a postura combinada ja carrega a chegada por juro, entao passar
 * a combinada aqui e o que fecha o buraco.
 */
export function valeArmar(
    postura: Postura,
    armadoHaMs: number,
    validadeMs: number,
): boolean {
    if (postura === 'dormindo') return false;
    return armadoHaMs >= validadeMs;
}

/**
 * ATIRAR ANTES DO CRUZAMENTO — a unica forma de ganhar uma liquidacao de juro.
 *
 * Isto existe por uma medicao de 2026-09-28, e e a resposta para "por que o bot
 * nunca atira".
 *
 * A posicao `0x4015e52c` (divida US$ 112, lucro US$ 2,17 — dentro da faixa dela)
 * foi lida na Base, bloco por bloco, antes de ser liquidada:
 *
 *     -60 blocos (120s): saude 1.000000023644295459
 *     -30 blocos  (60s): saude 1.000000011592022699
 *     -10 blocos  (20s): saude 1.000000003629135045
 *      -2 blocos   (4s): saude 1.000000000403336371
 *      bloco 0:          LIQUIDADA por outro
 *
 * Ela ficou a dois milionesimos de por cento de liquidar, por mais de dois
 * minutos, descendo sozinha por juro a 4,0e-10 por bloco — taxa constante,
 * conferida em 60 segundos e em 4 segundos com 1% de diferenca.
 *
 * O bot le o estado DEPOIS do bloco minerado. O bloco em que a saude cruza 1 e o
 * MESMO bloco em que a transacao do vencedor executa. Entao no instante em que o
 * bot le "liquidavel", a posicao ja foi. Isso nao e lentidao: reagir nao alcanca,
 * porque a informacao nao existe antes do evento.
 *
 * Das 51 liquidacoes de 9,5 dias, 32 foram assim. As 11 que ficaram disponiveis
 * por um bloco ou mais eram poeira de US$ 0,20 a US$ 0,31: quem espera para
 * reagir so pega o que ninguem quis.
 *
 * O que ALCANCA: mandar a transacao antes, mirando o bloco do cruzamento. Para
 * alvos de juro isso e aritmetica, nao adivinhacao de preco — a taxa e constante e
 * medivel em quatro segundos.
 *
 * O PRECO, dito em voz alta: se o tiro chegar antes do cruzamento, a Aave recusa e
 * o gas e perdido. E por isso que isto so vale no modo prova, que tem trava de
 * nonce — UM tiro — e so quando ela ligou `CACA_ACEITA_PREJUIZO`. Ela pediu
 * assim, em palavras: "eu quero que ele atire o mais rapido possivel a qualquer
 * custo".
 */
/**
 * ATIRAR NA ESCRITA IMINENTE — a unica rota que pode ganhar um alvo que vale.
 *
 * POR QUE ELA EXISTE, e e a conclusao de um mes de medicoes deste projeto.
 *
 * `atirarAntesDoCruzamento`, logo abaixo, decide por `blocosAteCruzar`, que vem
 * de `deriva.ts` — a projecao por JURO. O log de producao imprime
 * `chegandoPorJuro: "nenhuma projetavel"` em TODA linha, e o CLAUDE.md ja mediu
 * que o juro e 9.000x pequeno demais para derrubar uma posicao. Ou seja: a
 * maquina de antecipacao estava ligada na unica das tres causas que nunca
 * produz alvo valioso, e por isso o bot nunca atirou uma vez em um mes.
 *
 * As tres causas, medidas: PRECO (quase todas), JURO (lento, projetavel),
 * DONO (sem aviso). As valiosas acontecem por PRECO, e a autopsia de
 * 2026-10-07 mediu o mecanismo com os numeros crus:
 *
 *     bloco 52289906   HF 1.00184180   falta cair 0,1838%
 *     bloco 52289907   LIQUIDADA, transacao 6 de 537
 *     o preco do oraculo caiu 0,1857% DENTRO do bloco 52289907
 *
 * O premio era US$ 49,33 e o bot cobriria a mesma fatia (US$ 1.081,95). Nao
 * perdeu por lentidao, por gorjeta nem por portao: perdeu porque le o estado
 * DEPOIS do bloco minerado, e nao existiu bloco em que o alvo estivesse
 * liquidavel e disponivel.
 *
 * A APOSTA, e e por isso que ela e defensavel: **nao se preve o mercado, se
 * preve o oraculo correr atras de um movimento que JA ACONTECEU.** Quando o
 * log diz `mercado 0,3899% abaixo do oraculo`, essa distancia e fato medido, e
 * o oraculo escreve quando ela passa de ~0,151%. A escrita vai fechar parte
 * dela — `SALTO_P90_PCT` diz quanta. Se o que falta ao alvo cabe nesse salto,
 * a transacao mandada AGORA chega no bloco da escrita.
 *
 * O que se paga quando erra: o gas de uma reversao. O que se ganha quando
 * acerta: o alvo inteiro, que por este desenho era inalcancavel.
 */
/**
 * O PREMIO MINIMO PARA VALER A APOSTA, em dolares.
 *
 * MEDIDO em 2026-10-07, depois de 7 apostas e 0 acertos (US$ 2,10 gastos):
 *
 *     o oraculo do ETH escreve 121,7 vezes/dia (7 dias, cobertura 92,9%)
 *     a Base faz 43.200 blocos/dia
 *     -> uma escrita a cada 355 blocos, ou 11,8 minutos
 *
 * A transacao especulativa vale por UM bloco: entra no proximo e, se a posicao
 * nao estiver liquidavel ali, reverte. Entao a chance CEGA de coincidir com uma
 * escrita e 1/355 = **0,282%**.
 *
 * E o custo medido de uma errada e US$ 0,30 (0,000813 ETH em 7 tiros, a 0,3
 * gwei). Para empatar num premio P, a taxa de acerto tem de ser
 * `0,30 / (P + 0,30)`:
 *
 *     premio US$   1,80  ->  precisa 14,3%  (51x o acaso cego)
 *     premio US$  20,00  ->  precisa  1,5%  ( 5x o acaso cego)
 *     premio US$  49,33  ->  precisa  0,6%  ( 2x o acaso cego)
 *     premio US$ 106,00  ->  precisa 0,28%  (= o acaso cego: paga sozinho)
 *
 * **Este piso e ESCOLHA, nao medicao** — a taxa de acerto real nao esta medida
 * (0 de 7 nao a limita: pela regra de tres o teto de confianca ainda e ~43%).
 *
 * E ELE JA FOI US$ 20, POR UM DIA, E ESTAVA ALTO DEMAIS. Medido em 2026-10-08
 * com 18,7 horas de placar: aconteceram TRES liquidacoes na Aave da Base e
 * exatamente UMA valia a pena — `0xbd34e36b…`, divida US$ 539,88, **premio
 * US$ 11,59**, faltando 0,1683% (dentro do salto p90 de 0,2216%). Era o caso
 * exato para o qual esta regra existe, e o piso de US$ 20 a RECUSOU.
 *
 * Um piso que barra a unica oportunidade do dia nao protege nada: desliga a
 * estrategia com outro nome.
 *
 * US$ 10 cobre o que de fato aparece. A US$ 11,59 a aposta empata com 2,52% de
 * acerto, 9x a chance cega de 0,282%. Continua hipotese — mas o custo dela e
 * limitado e CONHECIDO: a trava de 4 tentativas por alvo por hora deixa o gasto
 * maximo em 4 x US$ 0,30 = **US$ 1,20 por hora** em que haja alvo ao alcance.
 * Contra um premio de US$ 11,59 esse bilhete vale comprar — e e a unica forma
 * de medir a taxa de acerto, que nada mais produz.
 *
 * `CACA_APOSTA_MINIMA_USD` muda. Zero libera qualquer premio, como estava.
 */
export const APOSTA_MINIMA_USD = new Decimal(10);

/**
 * BLOCOS DA BASE POR ESCRITA DO ORACULO — o denominador da chance cega.
 *
 * MEDIDO nos eventos `AnswerUpdated` do ETH/USD, 7 dias, cobertura 92,9%:
 * 121,7 escritas/dia contra 43.200 blocos/dia da Base. Era um numero que vivia
 * so em comentario; medicao que nao e constante de codigo nao trabalha.
 */
export const BLOCOS_POR_ESCRITA = 355;

/**
 * O PREMIO EM QUE A APOSTA SE PAGA SEM ACREDITAR NA PREVISAO.
 *
 * A transacao especulativa vale por UM bloco, entao a chance CEGA de ela cair
 * no bloco de uma escrita e `1 / BLOCOS_POR_ESCRITA` = 0,282%. Acima deste
 * premio, apostar as cegas ja tem valor esperado positivo — a previsao deixa de
 * ser premissa e passa a ser so vantagem.
 *
 * ESTA FUNCAO EXISTE PORQUE O PISO NAO DEVIA SER MINHA ESCOLHA. Em 07/10 eu
 * cravei US$ 20 e ele barrou a unica oportunidade do dia (US$ 11,59); em 08/10
 * baixei para US$ 10 e o bot gastou US$ 13,83 em 31 apostas enquanto
 * US$ 753,48 passavam. Os dois numeros eram meus. Este sai do custo que o bot
 * MEDE e da cadencia que o censo MEDE, e remede quando qualquer um dos dois
 * mudar.
 *
 * MEDIDO no log de 2026-10-08 19:20: 0,005467 ETH em 31 tiros = US$ 0,446 por
 * errada, o que poe o piso que se paga em **US$ 158,35**. Para comparar, as
 * quatro oportunidades daquelas 4,6 horas tinham media de US$ 188,37 — ou seja,
 * ELAS pagavam sozinhas, e o piso de US$ 10 liberava apostas que exigiam
 * acertar 15,8x mais que o acaso.
 *
 * Ela decide o piso. Esta funcao so impede que a decisao seja tomada no escuro.
 *
 * ====================================================================
 * 2026-10-09: EU ERREI O DIAGNOSTICO. OS PREMIOS NAO ERAM MIGALHA.
 * ====================================================================
 *
 * Tudo que este bloco diz sobre "as 31 apostas num premio de US$ 10,40" vale
 * para OITO das 39, nao para 31. As 39 transacoes foram reconstruidas pelo
 * nonce (6..44, cobertura 100%) e o `input` de cada uma decodificado; para cada
 * alvo foi lida a divida no bloco ANTERIOR ao tiro, que e a informacao que o
 * bot tinha:
 *
 *     alvo        tiros   divida US$    premio US$   falta cair
 *     0x9e70b090      8        95,26          1,80     0,1169%   <- a migalha
 *     0x616abe14      5       485,47         10,39     0,1609%
 *     0x33a7ec10      4     5.596,48        121,15     0,1990%
 *     0x12f16a0a      3     7.826,04        168,44     0,1513%
 *     0x07a145db      5    14.015,95        296,49     0,1464%
 *     0xda0d95c6      4    20.462,48        424,79     0,1900%
 *     0x16b00db7      5    60.913,50      1.112,56     0,2077%
 *     0x66bb6c29      5   151.916,73      1.932,39     0,0615%
 *
 * E AI A CONTA SE INVERTE. Somando premio x chance CEGA (1/355) contra o custo
 * pago, as 39 apostas tinham VALOR ESPERADO POSITIVO:
 *
 *     premio esperado no acaso cego ... US$ 54,82
 *     custo pago (recibos) ............ US$ 11,77
 *     valor esperado .................. +US$ 43,05
 *     acertos esperados em 39 tiros ... 0,110
 *
 * Perdemos US$ 11,86 porque 0 de 0,110 acerto esperado caiu. Isso e VARIANCIA,
 * nao regra errada. A unica aposta de valor esperado negativo foram as 8 da
 * migalha de US$ 1,80 (EV -US$ 2,36), e e essa que o piso barra.
 *
 * O "US$ 10,40" que eu citei como se fosse a populacao era UMA linha do log —
 * o alvo `0x616abe14`, um de oito. Extrapolei de uma linha, que e a regra 4
 * deste projeto, na auditoria que existia para achar erro meu.
 *
 * O premio aqui e `lucroEstimado`, com AGIO de 5% SUPOSTO (o bonus realizado
 * medido no unico alvo real foi 4,56%) e GAS_USD de 0,3 — entao a coluna e
 * estimativa, uns 9% otimista. Nao muda a ordem de grandeza nem a conclusao.
 */
export function premioQueSePagaNoAcaso(
    custoPorErradaUsd: Decimal,
    blocosPorEscrita: number = BLOCOS_POR_ESCRITA,
): Decimal {
    if (!custoPorErradaUsd.isFinite() || custoPorErradaUsd.lessThanOrEqualTo(0)) return new Decimal(0);
    if (!Number.isFinite(blocosPorEscrita) || blocosPorEscrita <= 0) return new Decimal(0);
    return custoPorErradaUsd.mul(blocosPorEscrita);
}

/**
 * O PISO QUE DE FATO VALE: o `env` so pode ENDURECER.
 *
 * Vive aqui, exportada e pura, porque a dona do bot exigiu — com razao — que a
 * prova nao fosse "existe um `Decimal.max` no codigo" e sim o COMPORTAMENTO
 * inteiro: configuracao carregada -> conta economica -> decisao de enviar.
 * Regra que mora dentro de uma closure nao se testa de ponta a ponta.
 *
 * POR QUE O `env` NAO PODE AFROUXAR. MEDIDO em 2026-10-08: 31 apostas,
 * US$ 15,45 (0,006280 ETH), ZERO acertos, com `CACA_APOSTA_MINIMA_USD=10`
 * liberando alvos que exigiam acertar 15,8x mais que o acaso. A causa raiz nao
 * foi bug nem azar: foi a regra de decisao, e a regra era minha.
 *
 * E NAO EXISTE ESCAPE. Eu havia criado `CACA_ACEITA_APOSTA_NEGATIVA=1`
 * argumentando que seria "a decisao dela, declarada". Ela mandou remover: eu
 * nao tinha autorizacao, tinha racionalizacao. Uma variavel que autoriza perder
 * dinheiro na media e um numero esperando para ser esquecido num painel.
 *
 * `escolhidoUsd === null` quer dizer "nenhuma variavel escrita" — e aí vale o
 * equilibrio. NAO confundir com zero: zero escrito tambem resulta no
 * equilibrio, mas pela regra do maximo, nao por ausencia.
 *
 * E CUSTO QUE NAO SE MEDE DEVOLVE PISO INFINITO, ou seja: nao aposta.
 *
 * Isto nao e zelo — e o conserto de um defeito que EU acabei de introduzir ao
 * extrair esta funcao. `custoPorErradaUsd` no cacador devolve ZERO quando
 * `precoDoEth()` e `null` (o mapa de precos do oraculo da Aave ainda nao
 * encheu), e o premio da aposta NAO depende desse preco: ele vem de
 * `lucroEstimado(dividaBase)`, que a Aave devolve em dolar. Com equilibrio zero
 * e nenhuma variavel escrita, o piso virava ZERO e **qualquer premio passava** —
 * exatamente o caso US$ 10,40 que custou as 31 apostas, agora liberado por um
 * mapa de precos vazio em vez de por uma variavel.
 *
 * Ausencia virando zero e o zero autorizando gasto: a assinatura deste projeto,
 * dentro do conserto dela. O lado seguro aqui e o que o caminho quente ja usa
 * para a mesma falta (`precoDoEth === null` -> "o piso de lucro barraria tudo"):
 * sem conta nao se gasta.
 */
export function pisoEfetivoDaAposta(
    escolhidoUsd: Decimal | null,
    custoPorErradaUsd: Decimal,
    blocosPorEscrita: number = BLOCOS_POR_ESCRITA,
): Decimal {
    const equilibrio = premioQueSePagaNoAcaso(custoPorErradaUsd, blocosPorEscrita);
    // Equilibrio zero nao e "de graca": e "nao consegui medir o custo". O custo
    // de uma errada nunca e zero de verdade — gas e preco sao os dois positivos.
    if (equilibrio.lessThanOrEqualTo(0)) return new Decimal(Infinity);
    if (escolhidoUsd === null) return equilibrio;
    if (!escolhidoUsd.isFinite() || escolhidoUsd.isNegative()) return equilibrio;
    return Decimal.max(escolhidoUsd, equilibrio);
}

/**
 * Quantas vezes melhor que o acaso a previsao precisa ser, para este premio.
 *
 * `1` ou menos quer dizer "paga sozinho". E o numero que responde "vale
 * apostar nisto?" sem precisar de fe na previsao.
 */
export function quantasVezesOAcaso(
    premioUsd: Decimal,
    custoPorErradaUsd: Decimal,
    blocosPorEscrita: number = BLOCOS_POR_ESCRITA,
): Decimal | null {
    if (!premioUsd.isFinite() || premioUsd.lessThanOrEqualTo(0)) return null;
    const piso = premioQueSePagaNoAcaso(custoPorErradaUsd, blocosPorEscrita);
    if (piso.lessThanOrEqualTo(0)) return null;
    return piso.dividedBy(premioUsd);
}

export function atirarNaEscritaIminente(entrada: {
    /**
     * Quanto o mercado esta ABAIXO do oraculo, em pontos percentuais. Fato
     * medido (`quedaDoMercado`), nao projecao. `null` e "a Binance nao
     * respondeu", e isso NAO autoriza tiro: ausencia nao e oportunidade.
     */
    mercadoCaiuPct: Decimal | null;
    /** Quanto o oraculo precisa cair para ESTE alvo cruzar (`quedaAteLiquidar`). */
    quedaDoAlvoPct: Decimal;
    /** O alvo e imune a preco? Par de mesma moeda/familia nao cruza por preco. */
    precoCancela?: boolean;
    /** Desligada por `CACA_ATIRAR_NA_ESCRITA=0`: ela gasta gas quando erra. */
    ligada: boolean;
    /**
     * O que este alvo renderia, em dolares. A aposta paga a gorjeta mesmo
     * errando, entao premio pequeno perde dinheiro por aritmetica — ver
     * `APOSTA_MINIMA_USD`. `undefined` nao libera: sem saber o premio nao se
     * aposta, porque ausencia nao e autorizacao.
     */
    premioUsd?: Decimal | null;
    /** O piso do premio. Padrao: `APOSTA_MINIMA_USD`. */
    premioMinimoUsd?: Decimal;
    /** O salto que uma escrita fecha. Padrao: o p90 medido. */
    saltoDaEscrita?: Decimal;
    /** O desvio a partir do qual o oraculo escreve. Padrao: o medido. */
    desvioDeEscrita?: Decimal;
}): { atira: boolean; porque: string } {
    if (!entrada.ligada) {
        return { atira: false, porque: 'CACA_ATIRAR_NA_ESCRITA=0: não atiro na escrita iminente' };
    }
    if (entrada.precoCancela === true) {
        // O par se cancela: nenhuma escrita de preco derruba esta posicao, por
        // grande que seja. Atirar aqui e gas perdido com certeza, nao aposta.
        return { atira: false, porque: 'imune a preço (par de mesma moeda ou família): escrita nenhuma o derruba' };
    }
    const mercado = entrada.mercadoCaiuPct;
    if (mercado === null) {
        return { atira: false, porque: 'sem cotação de mercado — e "não sei" não é "o oráculo vai escrever"' };
    }
    if (!mercado.isFinite() || mercado.isNegative()) {
        return { atira: false, porque: `desvio de mercado inválido (${mercado.toString()})` };
    }
    // O PISO DO PREMIO, e e aritmetica, nao cautela.
    //
    // Medido: 7 apostas, 0 acertos, US$ 0,30 por errada, premio US$ 1,80. Para
    // empatar nesse premio a aposta teria de acertar 14,3% das vezes — 51x a
    // chance cega de 0,282% (uma escrita de oraculo a cada 355 blocos). Premio
    // pequeno perde dinheiro por desenho, por boa que seja a previsao.
    const piso = entrada.premioMinimoUsd ?? APOSTA_MINIMA_USD;
    // PISO QUE NAO E NUMERO quer dizer "nao consegui medir o custo de uma
    // errada" (ver `pisoEfetivoDaAposta`). Sem o custo nao existe a aritmetica
    // que autoriza a aposta, e a frase tem de DIZER isso em vez de publicar
    // "a aposta se paga a partir de US$ Infinity".
    if (!piso.isFinite()) {
        return {
            atira: false,
            porque: 'não consegui medir o custo de uma errada (sem preço do ETH), e sem ele não há '
                + 'a conta que autoriza apostar. Ausência não é autorização',
        };
    }
    if (piso.greaterThan(0)) {
        const premio = entrada.premioUsd;
        if (premio === null || premio === undefined || !premio.isFinite()) {
            return {
                atira: false,
                porque: 'não sei quanto este alvo rende, e sem o prêmio não dá para dizer se a aposta '
                    + 'se paga. Ausência não é autorização',
            };
        }
        if (premio.lessThan(piso)) {
            return {
                atira: false,
                porque: `o alvo rende US$ ${premio.toFixed(2)} e a aposta só se paga a partir de `
                    + `US$ ${piso.toFixed(2)}: cada errada custa ~US$ 0,30 e o oráculo escreve uma vez a `
                    + `cada 355 blocos, então prêmio pequeno perde por aritmética `
                    + '(CACA_APOSTA_MINIMA_USD muda isto)',
            };
        }
    }
    const alvo = entrada.quedaDoAlvoPct;
    if (!alvo.isFinite() || alvo.isNegative()) {
        return { atira: false, porque: `distância do alvo inválida (${alvo.toString()})` };
    }
    const limiar = entrada.desvioDeEscrita ?? DESVIO_TIPICO_PCT;
    const saltoTipico = entrada.saltoDaEscrita ?? SALTO_P90_PCT;
    if (mercado.lessThan(limiar)) {
        return {
            atira: false,
            porque: `o mercado está ${mercado.toFixed(4)}% abaixo e o oráculo só escreve a partir de `
                + `${limiar.toFixed(4)}%: não há escrita iminente para pegar carona`,
        };
    }
    // A ESCRITA NAO PODE PASSAR DO MERCADO: ela persegue, nao ultrapassa. Entao
    // o que ela e capaz de fechar e o MENOR entre o salto tipico e a distancia
    // que de fato existe. Usar so o salto tipico mandaria tiro num alvo a
    // 0,20% com o mercado 0,12% abaixo — a escrita nao tem de onde tirar.
    const fecha = Decimal.min(saltoTipico, mercado);
    if (alvo.greaterThan(fecha)) {
        return {
            atira: false,
            porque: `o alvo precisa de ${alvo.toFixed(4)}% e a escrita iminente fecha no máximo `
                + `${fecha.toFixed(4)}% (salto p90 ${saltoTipico.toFixed(4)}%, mercado ${mercado.toFixed(4)}%)`,
        };
    }
    return {
        atira: true,
        porque: `o mercado já caiu ${mercado.toFixed(4)}% e o oráculo escreve a partir de ${limiar.toFixed(4)}%: `
            + `a escrita é iminente e fecha até ${fecha.toFixed(4)}%, que cobre os ${alvo.toFixed(4)}% que faltam. `
            + 'Mando AGORA para chegar NO bloco da escrita — é o único jeito de ganhar um alvo que vale. '
            + 'Se a escrita vier menor, a Aave recusa e o gás é perdido: é o preço da aposta',
    };
}

export function atirarAntesDoCruzamento(entrada: {
    /** De `blocosAteCruzar`. `null` quer dizer "nao sei", e nao "longe". */
    blocosAteCruzar: number | null;
    /** So no modo prova: e ele que tem a trava de nonce. */
    modoProva: boolean;
    /** E so quando ela aceitou pagar por um tiro que pode reverter. */
    aceitaPrejuizo: boolean;
    /** Quantos blocos antes do cruzamento vale mandar. */
    janelaDeBlocos?: number;
}): { atira: boolean; porque: string } {
    // `?? 2` NAO substitui NaN, e `NaN <= 0` e falso, e `43200 > NaN` tambem e
    // falso — entao com `CACA_JANELA_DE_BLOCOS='2,5'` o controle caia direto no
    // `return { atira: true }` e o bot mandava uma transacao real para uma posicao
    // que cruza em 24 HORAS, garantida a reverter com o gas pago. O CLAUDE.md
    // registra esta armadilha; ela me pegou outra vez no mesmo dia.
    const janela = Number.isFinite(entrada.janelaDeBlocos) ? entrada.janelaDeBlocos! : 2;
    if (!entrada.modoProva) {
        return { atira: false, porque: 'só no modo prova: é ele que tem a trava de nonce de um tiro só' };
    }
    if (!entrada.aceitaPrejuizo) {
        return {
            atira: false,
            porque: 'CACA_ACEITA_PREJUIZO não está ligado, e um tiro antes do cruzamento pode reverter',
        };
    }
    if (entrada.blocosAteCruzar === null) {
        return { atira: false, porque: 'não sei quando esta posição cruza — e "não sei" não é "está perto"' };
    }
    if (!Number.isFinite(entrada.blocosAteCruzar) || entrada.blocosAteCruzar < 0) {
        return { atira: false, porque: `projeção inválida (${entrada.blocosAteCruzar} blocos)` };
    }
    if (janela <= 0) return { atira: false, porque: `janela de ${janela} blocos não deixa atirar nunca` };
    if (entrada.blocosAteCruzar > janela) {
        return {
            atira: false,
            porque: `cruza em ${entrada.blocosAteCruzar.toFixed(1)} blocos, e eu mando com ${janela} de antecedência`,
        };
    }
    return {
        atira: true,
        porque: `cruza em ${entrada.blocosAteCruzar.toFixed(1)} blocos (${
            (entrada.blocosAteCruzar * 2).toFixed(0)}s): mando AGORA para chegar no bloco do cruzamento. `
            + 'Se eu chegar antes, a Aave recusa e o gás é perdido — é o preço combinado',
    };
}
