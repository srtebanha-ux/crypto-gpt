// Arquivo: src/prontidao.ts
//
// Estar pronto ANTES da hora.
//
// Entre ver alguem cair e enviar a transacao, o cacador fazia tres idas a rede:
// `estimateGas`, `getFeeData` e o nonce. Sao centenas de milissegundos jogados
// fora no unico instante em que eles custam a liquidacao — e nenhuma das tres
// precisa acontecer ali.
//
// O nonce ja era local. O limite de gas nao precisa ser estimado: gas nao
// gasto e devolvido, entao um teto generoso e de graca e um teto apertado so
// serve para a transacao morrer sem gas. E o preco base do bloco vem de
// carona no multicall que o ciclo ja faz, por zero requisicao a mais.
import { Decimal } from 'decimal.js';

/** `getBasefee()` do Multicall3 — o preco base do bloco, de graca no ciclo. */
export const SELETOR_BASEFEE = '0x3e64a696';

/**
 * O teto de gas que se manda, sem estimar.
 *
 * "Gas nao usado volta, entao um teto generoso nao custa nada" — era o que eu
 * achava, e esta ERRADO quando a carteira e pequena. O no congela
 * `gasLimit × maxFeePerGas` ADIANTADO, pelo teto e nao pelo consumo. Com 2M
 * de teto e US$14 de saldo, o maior lance possivel cai para 2,41 gwei: dois
 * tercos do poder de lance ficam presos garantindo gas que nunca sera usado.
 *
 * O ensaio da cadeia inteira mostrou isso — numa liquidacao de US$150 mil ela
 * ofereceria 2,41 gwei querendo oferecer 50. Nenhum teste de funcao pegaria,
 * porque cada peca estava certa sozinha.
 *
 * 1,2M da 71% de folga sobre os ~700k que uma cacada usa, e quase DOBRA o
 * lance possivel. Apertado demais seria pior: morrer sem gas custa a
 * transacao inteira, depois de pagar.
 *
 * ATUALIZADO 2026-09-29, a pedido dela: 700k. REVERTIDO EM 2026-09-30, a pedido
 * dela tambem, e os dois pedidos sao coerentes — o segundo tem a medicao que o
 * primeiro nao tinha.
 *
 * Com 700k a folga sobre os ~700k que a cacada usa ia a ZERO: uma cacada que
 * usasse UMA unidade a mais morria sem gas e pagava a transacao inteira. Dois
 * testes deste arquivo gritaram na hora (`o limite de gas e folgado, mas nao a
 * ponto de estrangular o lance` e `o teto de gas nao pode estrangular o lance`)
 * e ficaram vermelhos por um dia.
 *
 * E o medo que motivou os 700k — "teto grande prende o poder de lance" — foi
 * MEDIDO em 2026-09-30 e nao se sustenta neste saldo:
 *
 *     gasLimit    maxFee que o saldo adianta   custo all-in
 *       700.000              21,1103 gwei         US$ 39,79
 *     1.200.000              12,3143 gwei         US$ 23,21
 *     2.000.000               7,3886 gwei         US$ 13,93
 *     3.000.000               4,9257 gwei         US$  9,29
 *
 * A maior gorjeta que QUALQUER concorrente pagou nas 19 liquidacoes medidas foi
 * 0,4002 gwei. Mesmo com 3M de teto o lance possivel e 12x isso. A folga de gas
 * e o poder de lance nao competem de verdade aqui: dava para ter os dois.
 *
 * ESTE NUMERO NAO E O DO TIRO. Desde 2026-09-30 o tiro usa `eth_estimateGas` no
 * instante do disparo (ver `limiteDeGasDoTiro`), porque so ali o alvo e
 * liquidavel e a estimativa existe — antes do cruzamento a chamada REVERTE,
 * conferido na rede. Este valor sobra para o que precisa de um numero sem rede:
 * o orcamento de CUs, a `faixaQueAtira` do log e o `gorjetaQueCabeNoSaldo` do
 * planejamento.
 */
export const LIMITE_DE_GAS = BigInt(process.env.CACA_LIMITE_GAS ?? '1200000');

/**
 * A FOLGA sobre a estimativa da rede, em fracao.
 *
 * 1.0 = o dobro do estimado. Nao e chute confortavel: e a unica variancia de
 * consumo que este projeto tem medida. O lider da faixa (`0xd12810b1`, 9 de 19
 * liquidacoes em 9,5 dias) gastou, nas nove:
 *
 *     1.202.608  1.245.205  1.268.533  1.333.274  1.500.956
 *     1.665.347  2.293.968  4.086.320  4.142.116
 *
 * Mediana 1.500.956, maximo 4.142.116 — **2,76x a mediana**, no MESMO contrato
 * e no mesmo par de mercado. Uma folga de 50% nao cobriria aquilo; 100% cobre
 * quase tudo e o resto e barrado pelo teto de baixo.
 *
 * O contrato dele faz mais que o nosso, entao 2,76x e limite superior e nao
 * previsao. Isto e escolha limitada pelo dado que existe, e nao derivacao — e
 * esta escrito assim de proposito.
 */
export const FOLGA_DO_GAS = Number(process.env.CACA_FOLGA_GAS ?? '1.0');

/** O menor teto que faz sentido mandar: abaixo disto a cacada nao cabe. */
export const PISO_DO_LIMITE_DE_GAS = 900_000n;
/**
 * O teto a mandar quando `eth_estimateGas` nao responde a tempo.
 *
 * ACIMA do maximo MEDIDO, e isso nao e folga arbitraria. A unica variancia de
 * consumo que este projeto mediu: o lider da faixa (`0xd12810b1`, 9 de 19
 * liquidacoes em 9,5 dias) gastou entre 1.202.608 e 4.142.116 no MESMO
 * contrato — 2,76x a mediana de 1.500.956.
 *
 * A primeira versao disto foi 2.800.000 ("4x o gas tipico"), que e MENOR que o
 * maximo ja observado. Teria produzido exatamente o fracasso que ela temia:
 * morrer sem gas no meio, pagando o lance e nao liquidando. O teste vizinho —
 * que guarda essa medicao — pegou.
 *
 * 5.000.000 cobre o maximo medido com 21%% de margem. Nao ha risco de sobra: o
 * no congela `gasLimit x maxFee` e DEVOLVE o que nao foi consumido. O preco e
 * lance mais apertado, e `tetoDeGasQueNaoEstrangulaOLance` ja corta pelo que o
 * saldo comporta. Medido com o saldo dela: mesmo a 3M o lance sai a 4,93 gwei,
 * doze vezes o maior lance da concorrencia.
 */
export const TETO_SEM_ESTIMATIVA = 5_000_000n;

/**
 * O maior teto que ainda deixa a gorjeta ganhar o leilao.
 *
 * O no congela `gasLimit × maxFeePerGas`, entao teto grande come lance. Mas
 * "quanto e grande" nao e opiniao: e o ponto em que o lance possivel deixa de
 * bater o campo com margem. Campo medido: 0,4002 gwei foi a MAIOR gorjeta das
 * 19 liquidacoes. Com 10x de margem o alvo e 4 gwei, e o teto de gas que ainda
 * permite 4 gwei sai do saldo — muda quando ela deposita, entao e calculado e
 * nao cravado.
 */
export const GORJETA_QUE_GANHA_O_LEILAO_WEI = 4_000_000_000n; // 10x os 0,4002 gwei medidos

export function tetoDeGasQueNaoEstrangulaOLance(
    saldoWei: bigint,
    baseFeeWei: bigint,
    gorjetaAlvoWei = GORJETA_QUE_GANHA_O_LEILAO_WEI,
): bigint {
    const porUnidade = baseFeeWei + gorjetaAlvoWei;
    if (porUnidade <= 0n) return PISO_DO_LIMITE_DE_GAS;
    const cabe = saldoWei / porUnidade;
    return cabe < PISO_DO_LIMITE_DE_GAS ? PISO_DO_LIMITE_DE_GAS : cabe;
}

/**
 * O LIMITE DE GAS DO TIRO, da estimativa da rede — nunca de um numero cravado.
 *
 * Pedido dela em 2026-09-30: "NUNCA um limite cravado (hardcoded) de 700k ou
 * qualquer outro numero fixo". E o motivo dela esta certo: se o saldo inteiro
 * vai para a gorjeta e a cacada usa 720k contra um teto de 700k, a transacao
 * reverte sem gas e o dinheiro vai embora sem liquidacao nenhuma.
 *
 * `estimado` e `null` quando `eth_estimateGas` nao respondeu. Nesse caso a
 * resposta e NAO ATIRAR, e nao "usa o padrao": chutar o teto com o saldo todo na
 * gorjeta e exatamente o risco que ela mandou eliminar. O log diz que nao
 * estimou, em vez de o bot atirar no escuro.
 *
 * Conferido na rede em 2026-09-30: `eth_estimateGas` sobre `cacar()` num alvo
 * que AINDA NAO cruzou devolve `execution reverted`. Logo esta funcao so pode
 * ser chamada no instante do disparo, onde o alvo ja e liquidavel — e e la que
 * o cacador ja faz a medicao por `eth_call`.
 */
export function limiteDeGasDoTiro(entrada: {
    estimadoGas: bigint | null;
    saldoWei: bigint;
    baseFeeWei: bigint;
    folga?: number;
    gorjetaAlvoWei?: bigint;
}): { limite: bigint; porque: string } | { limite: null; porque: string } {
    if (entrada.estimadoGas === null || entrada.estimadoGas <= 0n) {
        // NÃO ATIRAR ERA A RESPOSTA ERRADA, e ela disse por que em 2026-10-06:
        // "eu só quero que ele atire na hora certa e pegue o alvo de primeira".
        //
        // O medo que justificava abortar era morrer SEM GÁS — gastar o lance e
        // não liquidar. Mas isso só acontece com limite BAIXO demais. Um limite
        // ALTO não tem esse risco: o nó congela `gasLimit × maxFee` e DEVOLVE o
        // que não foi usado. O preço de um teto generoso é lance menor, não
        // dinheiro perdido.
        //
        // Então o certo não é escolher entre "atirar no escuro" e "não atirar":
        // é mandar um teto que a caçada não consegue estourar. `TETO_SEM_ESTIMATIVA`
        // é 4x o gás típico medido de uma caçada — e `tetoDeGasQueNaoEstrangulaOLance`
        // continua cortando pelo que o saldo comporta, então nunca vira
        // `insufficient funds`.
        //
        // Perder a liquidação por um `eth_estimateGas` lento é perda certa.
        // Lance apertado é só desvantagem.
        // AQUI O GAS GANHA DA GORJETA, e e uma escolha, nao um descuido.
        //
        // `tetoDeGasQueNaoEstrangulaOLance` reserva 4 gwei para o lance, e com o
        // saldo dela (0,0164 ETH) isso limita o gas a 4.099.653 — ABAIXO do
        // maximo medido de 4.142.116. Ou seja: os dois nao cabem juntos.
        //
        // Sem estimativa, quem decide e o risco: morrer sem gas e perda CERTA
        // (paga o lance, nao liquida); lance apertado e so desvantagem. Entao o
        // teto aqui reserva apenas o PISO da gorjeta, e o lance fica com o que
        // sobrar — medido, uns 3,3 gwei, oito vezes o maior lance que a
        // concorrencia da faixa pagou.
        const cabeNoSaldo = entrada.saldoWei / (entrada.baseFeeWei + PISO_DA_GORJETA_WEI);
        const alvo = TETO_SEM_ESTIMATIVA < cabeNoSaldo ? TETO_SEM_ESTIMATIVA : cabeNoSaldo;
        if (alvo < PISO_DO_LIMITE_DE_GAS) {
            return {
                limite: null,
                porque: `eth_estimateGas não respondeu E o saldo só comporta ${alvo} de gás, abaixo do piso `
                    + `de ${PISO_DO_LIMITE_DE_GAS}. Atirar aqui é morrer sem gás de verdade`,
            };
        }
        return {
            limite: alvo,
            porque: `eth_estimateGas não respondeu — mando ${alvo}, que é teto generoso e a caçada não `
                + 'estoura. O que sobra o nó devolve; o custo é lance mais apertado, não gás perdido',
        };
    }
    const folga = Number.isFinite(entrada.folga) ? Math.max(0, entrada.folga!) : FOLGA_DO_GAS;
    // Em milesimos para nao passar por `Number` e perder precisao no bigint.
    const comFolga = entrada.estimadoGas * BigInt(Math.round((1 + folga) * 1000)) / 1000n;
    const piso = comFolga < PISO_DO_LIMITE_DE_GAS ? PISO_DO_LIMITE_DE_GAS : comFolga;
    const teto = tetoDeGasQueNaoEstrangulaOLance(entrada.saldoWei, entrada.baseFeeWei, entrada.gorjetaAlvoWei);
    if (piso <= teto) {
        return {
            limite: piso,
            porque: `estimou ${entrada.estimadoGas} + ${(folga * 100).toFixed(0)}% de folga = ${piso}`
                + (comFolga < PISO_DO_LIMITE_DE_GAS ? ` (subiu para o piso de ${PISO_DO_LIMITE_DE_GAS})` : ''),
        };
    }
    // A folga que a carteira paga e menor que a que a cacada pede. Mandar o teto
    // pedido esvazia o lance; mandar o teto que cabe arrisca morrer sem gas.
    // Manda o PEDIDO — morrer sem gas e certeza de perda, lance fraco e so
    // desvantagem — e o log diz que o lance vai apertado.
    return {
        limite: piso,
        porque: `estimou ${entrada.estimadoGas} + ${(folga * 100).toFixed(0)}% = ${piso}, ACIMA do teto `
            + `de ${teto} que o saldo comporta com gorjeta cheia. Mando o pedido e o lance vai apertado: `
            + 'morrer sem gás é perda certa, lance fraco é só desvantagem',
    };
}

/**
 * O gas que uma cacada REALMENTE usa.
 *
 * Diferente do teto. A gorjeta e dividida por este numero, nao pelo limite:
 * dividir pelo teto de 2M quando a transacao usa ~700k faz o lance efetivo
 * virar 14% do lucro quando o log diz 40% — o bot pagaria menos do que decidiu
 * pagar, e perderia leiloes achando que estava competindo.
 */
export const GAS_TIPICO_DE_UMA_CACADA = 700_000n;

/**
 * Nunca ofereca menos que isso, ou a transacao pode nem ser considerada.
 *
 * ATUALIZADO 2026-09-29, a pedido dela: 0,25 gwei. Medido em 2026-09-29 nas 19
 * liquidacoes da faixa US$ 0,50–224,64 dos ultimos 9,5 dias: a gorjeta MEDIA
 * do lider (`0xd12810b1`, 9 de 19) foi 0,1529 gwei e a maior de todas as 19
 * foi 0,4002 gwei. 0,25 cobre a media de todos os concorrentes, nao o topo.
 */
export const PISO_DA_GORJETA_WEI = 250_000_000n; // 0,25 gwei
/** Nem mais que isso, ou um lucro mal medido vira um gasto absurdo. */
export const TETO_DA_GORJETA_WEI = 50_000_000_000n; // 50 gwei

/** Quanto do lucro vira gorjeta para furar a fila. */
export const FRACAO_DO_LUCRO = 0.4;

/**
 * Quanto oferecer de gorjeta, por unidade de gas.
 *
 * Conserta um defeito que estava no caminho quente. A conta antiga era
 * `lucroCru * 40% / limiteGas`, com `lucroCru` nas unidades CRUAS do ativo da
 * divida. Isso mistura unidades: o mesmo lucro de US$88 vira 35.200.000 se a
 * divida for USDC (6 casas) e 1,3e16 se for WETH (18 casas) — uma diferenca de
 * dez ordens de grandeza para o MESMO dinheiro.
 *
 * Na pratica o bot oferecia sempre o piso quando a divida era USDC, e uns 6,6
 * gwei quando era WETH. Ou seja: competia de verdade em algumas liquidacoes e
 * nao competia em outras, sem nenhuma razao economica — so pelo numero de
 * casas decimais do token.
 *
 * Aqui a conta passa por dolar, que e a unica unidade em que os dois lucros
 * sao comparaveis.
 */
export function gorjetaPorGas(entrada: {
    lucroUsd: Decimal;
    precoDoEthUsd: Decimal;
    /** O gas que a cacada USA — nao o teto que se manda. */
    limiteGas?: bigint;
    fracaoDoLucro?: number;
    pisoWei?: bigint;
    tetoWei?: bigint;
}): bigint {
    const limite = entrada.limiteGas ?? GAS_TIPICO_DE_UMA_CACADA;
    const piso = entrada.pisoWei ?? PISO_DA_GORJETA_WEI;
    const teto = entrada.tetoWei ?? TETO_DA_GORJETA_WEI;
    if (entrada.precoDoEthUsd.lessThanOrEqualTo(0) || limite <= 0n) return piso;

    const lucroEmEth = entrada.lucroUsd.dividedBy(entrada.precoDoEthUsd);
    const gorjetaWei = lucroEmEth
        .mul(entrada.fracaoDoLucro ?? FRACAO_DO_LUCRO)
        .mul(new Decimal(10).pow(18));
    if (!gorjetaWei.isFinite() || gorjetaWei.lessThanOrEqualTo(0)) return piso;

    let porGas: bigint;
    try {
        porGas = BigInt(gorjetaWei.dividedBy(limite.toString()).toFixed(0));
    } catch {
        return piso;
    }
    if (porGas < piso) return piso;
    if (porGas > teto) return teto;
    return porGas;
}

/**
 * O teto total por unidade de gas: o que o bloco cobra mais a gorjeta.
 *
 * O preco base sobe entre blocos, entao vai uma folga em cima dele. Pagar de
 * menos aqui faz a transacao ficar parada justamente quando a pressa importa.
 */
export function tetoPorGas(baseFeeWei: bigint, gorjetaWei: bigint, folga = 2n): bigint {
    return baseFeeWei * folga + gorjetaWei;
}

/** Le o `getBasefee()` do multicall. `null` quando nao veio — nunca um chute. */
export function lerBasefee(hex: string | null): bigint | null {
    if (!hex || hex === '0x') return null;
    try {
        const v = BigInt(hex);
        return v > 0n ? v : null;
    } catch {
        return null;
    }
}

/**
 * Quanto do lucro virar gorjeta, depois de perder seguidas vezes.
 *
 * Existe porque numa corrida onde todos chegam no mesmo bloco, quem ganha nao
 * e o mais rapido: e quem paga mais. A transacao com mais gorjeta entra
 * primeiro, e a segunda reverte porque a posicao ja nao esta liquidavel.
 *
 * Entao perder repetidamente nao pede codigo mais rapido — pede lance maior. E
 * ganhar de volta nao pede lance alto para sempre: quando comeca a acertar, o
 * bot desce de novo e guarda a diferenca.
 *
 * O teto e o que separa disputar de se entregar. Acima dele, ganhar a
 * liquidacao custa quase tudo que ela rende, e o certo e deixar passar.
 */
export const TETO_DA_FRACAO = 0.8;
export const PASSO_DA_FRACAO = 0.1;

export function fracaoAdaptativa(entrada: {
    base?: number;
    perdasSeguidas: number;
    teto?: number;
    passo?: number;
}): number {
    const base = entrada.base ?? FRACAO_DO_LUCRO;
    const teto = entrada.teto ?? TETO_DA_FRACAO;
    const passo = entrada.passo ?? PASSO_DA_FRACAO;
    if (entrada.perdasSeguidas <= 0) return base;
    return Math.min(teto, base + entrada.perdasSeguidas * passo);
}

/**
 * O que sobra para voce depois de pagar a gorjeta, em dolar.
 *
 * Serve para a decisao nao virar "quanto eu aguento pagar" e sim "quanto eu
 * ainda ganho se pagar". Ganhar 100% de um lucro de US$17 e melhor que ganhar
 * 0% de um lucro de US$88 — mas so ate o ponto em que sobra alguma coisa.
 */
export function sobraDepoisDaGorjeta(lucroUsd: Decimal, fracao: number): Decimal {
    return lucroUsd.mul(1 - fracao);
}

/**
 * Quanto gas uma liquidacao consome quando REVERTE.
 *
 * Eram 150.000, e estava errado por 4,7 vezes — no sentido perigoso.
 *
 * Existem duas reversoes, e a cara e a comum. A Aave recusando cedo (posicao
 * saudavel) custa ~150k. Mas o contrato tambem reverte com `LucroInsuficiente`
 * DEPOIS do emprestimo, da liquidacao e da venda — ou seja gastando a cacada
 * inteira, ~700k. E esse e o caminho COMUM, porque o bot manda
 * `lucroMinimo = 80% do lucro medido`: basta alguem mexer no pool no mesmo
 * bloco.
 *
 * Com 150k o freio de sobrevivencia dizia "aguento mais 6 derrotas" quando a
 * verdade era 1, e liberava um tiro que leva metade da carteira. Freio que
 * erra tem que errar para o lado seguro.
 */
export const GAS_DE_UMA_REVERSAO = GAS_TIPICO_DE_UMA_CACADA;

/**
 * O que UMA derrota custa, em wei.
 *
 * Gorjeta e cobrada mesmo perdendo: prioridade se paga pelo gas consumido,
 * tenha a transacao dado certo ou nao. Foi isso que quase passou batido — o
 * lance adaptativo sobe ate 80% do lucro, e com lucro de US$300 isso vira uma
 * derrota de US$18 numa carteira que tem US$14.
 */
export function custoDeUmaDerrota(
    gorjetaPorGasWei: bigint,
    baseFeeWei: bigint,
    gasDaReversao: bigint = GAS_DE_UMA_REVERSAO,
): bigint {
    return (gorjetaPorGasWei + baseFeeWei) * gasDaReversao;
}

/**
 * A maior gorjeta que cabe no saldo, sem apostar a carteira numa tacada.
 *
 * Existe porque o limite do lance nao pode ser so economico ("quanto do lucro
 * vale pagar"), tem que ser tambem de sobrevivencia ("quanto eu aguento
 * perder"). Um bot sem gas nao perde uma liquidacao: perde TODAS as seguintes,
 * e em silencio, porque parar de conseguir enviar nao levanta erro nenhum.
 */
export function gorjetaQueCabeNoSaldo(entrada: {
    gorjetaDesejadaWei: bigint;
    saldoWei: bigint;
    baseFeeWei: bigint;
    fracaoMaximaDoSaldo?: number;
    gasDaReversao?: bigint;
}): bigint {
    const fracao = entrada.fracaoMaximaDoSaldo ?? 0.25;
    const gas = entrada.gasDaReversao ?? GAS_DE_UMA_REVERSAO;
    if (entrada.saldoWei <= 0n) return 0n;
    const tetoDoRisco = (entrada.saldoWei * BigInt(Math.round(fracao * 10_000))) / 10_000n;
    const porGasQueCabe = tetoDoRisco / gas;
    const semOBase = porGasQueCabe > entrada.baseFeeWei ? porGasQueCabe - entrada.baseFeeWei : 0n;
    return entrada.gorjetaDesejadaWei < semOBase ? entrada.gorjetaDesejadaWei : semOBase;
}

/** Quantas derrotas seguidas o saldo aguenta neste lance. */
export function derrotasQueAguenta(saldoWei: bigint, custoDaDerrotaWei: bigint): number {
    if (custoDaDerrotaWei <= 0n) return Infinity;
    return Number(saldoWei / custoDaDerrotaWei);
}

/**
 * Quanto do saldo vale arriscar, dado o tamanho do premio.
 *
 * A regra anterior era uma fracao fixa: nunca mais de 25% do saldo por tiro,
 * fosse o premio de US$12 ou de US$2.103. Isso nao e cautela, e uma regra que
 * nao olha para o que esta em jogo — e ela fazia o bot recusar uma aposta de
 * 590 para 1 com a mesma cara com que recusava uma de 3 para 1.
 *
 * Aqui o risco sobe junto com o retorno. Arriscar US$3,55 para ganhar US$12 e
 * um negocio medio; arriscar US$7 para ganhar US$2.103 e obvio. O que NAO pode
 * acontecer e o bot ficar sem bala: por isso existe a reserva, que garante um
 * numero minimo de tiros seguintes mesmo depois de uma derrota.
 *
 * Entao sao dois limites, e o menor vence:
 *   - o quanto o premio justifica arriscar
 *   - o quanto ainda deixa `tirosDeReserva` tentativas pela frente
 */
export function fracaoDoSaldoQueValeArriscar(entrada: {
    lucroUsd: Decimal;
    saldoUsd: Decimal;
    /** Abaixo disto o premio nao justifica arriscar mais que o basico. */
    fracaoBase?: number;
    fracaoMaxima?: number;
}): number {
    const base = entrada.fracaoBase ?? 0.25;
    const maxima = entrada.fracaoMaxima ?? 0.6;
    if (entrada.saldoUsd.lessThanOrEqualTo(0)) return 0;
    // Quantas vezes o premio cabe no que se arriscaria. Premio pequeno perto
    // do saldo nao justifica exposicao; premio muito maior justifica.
    const vezes = entrada.lucroUsd.dividedBy(entrada.saldoUsd);
    if (vezes.lessThanOrEqualTo(1)) return base;
    if (vezes.greaterThanOrEqualTo(10)) return maxima;
    // Entre 1x e 10x o saldo, sobe suavemente da base ate o maximo.
    const t = vezes.minus(1).dividedBy(9).toNumber();
    return base + (maxima - base) * t;
}

/**
 * O que o NO exige adiantado para aceitar a transacao.
 *
 * Nao e o que ela vai custar: e `gasLimit × maxFeePerGas`, cobrado no ato e
 * devolvido depois. Ignorar isso foi o defeito mais caro desta revisao — com o
 * teto de 2M e uma gorjeta boa, o adiantado passava de tres vezes o saldo
 * inteiro, e toda caçada morria em `insufficient funds` com o log culpando a
 * rede. O bot pareceria sem alvo, tendo alvo e tendo gas.
 */
export function adiantadoExigido(limiteGas: bigint, maxFeeWei: bigint): bigint {
    return limiteGas * maxFeeWei;
}

/**
 * O maior `maxFeePerGas` que o saldo aceita adiantar, deixando uma folga.
 *
 * Devolve 0 quando nem o basico cabe — e 0 aqui significa "nao da para atirar",
 * nao "atire de graca".
 */
export function maxFeeQueOSaldoAdianta(
    saldoWei: bigint,
    limiteGas: bigint,
    folga = 0.9,
): bigint {
    if (saldoWei <= 0n || limiteGas <= 0n) return 0n;
    return ((saldoWei * BigInt(Math.round(folga * 10_000))) / 10_000n) / limiteGas;
}

/**
 * Quanto o saldo AMORDACOU o lance, e de quanto saldo precisaria para soltar.
 *
 * Existe por um silencio. O caminho do tiro corta o lance quando o gas
 * adiantado nao cabe — `if (maxFee > adiantavel) maxFee = adiantavel` — e isso
 * esta certo, e salvou a cacada de morrer em `insufficient funds`. Mas o corte
 * nao dizia nada.
 *
 * Medido com o saldo real de 2026-09-27 (0,003341 ETH, US$ 8,99): num premio de
 * US$ 1.986 o bot quer dar 50 gwei e consegue 2,49. Corte de 95%. E o log
 * imprimiria um tiro de aparencia normal, com 2,49 gwei, e depois uma reversao
 * — e nada ligaria as duas coisas. Ela veria "reverteu" e pensaria que o bot
 * falhou, quando na verdade ele foi coberto por nao ter como cobrir.
 *
 * Perder a corrida por falta de gas e um resultado legitimo. Perder sem que o
 * log diga que foi por isso e o defeito que este projeto persegue desde o
 * primeiro dia: ausencia com cara de resposta.
 */
export interface LanceAmordacado {
    /** Fracao do lance desejado que o saldo cortou, de 0 a 1. */
    cortado: number;
    /** O saldo que deixaria dar o lance inteiro, em wei. */
    saldoQuePrecisaria: bigint;
    /** True quando o corte passou do limiar e merece log. */
    amordacado: boolean;
}

export function lanceAmordacado(entrada: {
    desejadaWei: bigint;
    conseguidaWei: bigint;
    limiteGas: bigint;
    baseFeeWei: bigint;
    folga?: number;
    /** Abaixo disto o corte e ruido de arredondamento e nao merece alarme. */
    limiar?: number;
}): LanceAmordacado {
    const folga = entrada.folga ?? 0.9;
    const limiar = entrada.limiar ?? 0.2;
    // Divisao para CIMA, e nao e detalhe: `maxFeeQueOSaldoAdianta` trunca duas
    // vezes, entao um saldo arredondado para baixo devolve um teto um wei
    // abaixo do necessario — e a resposta "coloque este tanto" nao soltaria o
    // lance. Um numero que erra por um wei para o lado errado e pior que
    // nenhum, porque ela poe o dinheiro e continua amordaçada.
    const folgaEmMilesimos = BigInt(Math.round(folga * 10_000));
    const exigido = adiantadoExigido(entrada.limiteGas, tetoPorGas(entrada.baseFeeWei, entrada.desejadaWei));
    const precisaria = entrada.limiteGas <= 0n || folgaEmMilesimos <= 0n
        ? 0n
        : (exigido * 10_000n + folgaEmMilesimos - 1n) / folgaEmMilesimos;
    if (entrada.desejadaWei <= 0n || entrada.conseguidaWei >= entrada.desejadaWei) {
        return { cortado: 0, saldoQuePrecisaria: precisaria, amordacado: false };
    }
    const cortado = 1 - Number(entrada.conseguidaWei) / Number(entrada.desejadaWei);
    // A comparacao com o limiar e feita em INTEIROS. Em ponto flutuante
    // `1 - 80/100` da 0,19999999999999996, que e menor que 0,2 — e um corte de
    // exatamente 20% nao alarmaria. Fronteira decidida por erro de arredondamento
    // e o tipo de coisa que passa em producao meses sem ninguem ver.
    const faltou = entrada.desejadaWei - entrada.conseguidaWei;
    const limiarEmMilesimos = BigInt(Math.round(limiar * 1_000_000));
    const amordacado = faltou * 1_000_000n >= limiarEmMilesimos * entrada.desejadaWei;
    return { cortado, saldoQuePrecisaria: precisaria, amordacado };
}

/**
 * O TIRO EM BRANCO: uma transacao de verdade, que vai reverter de proposito.
 *
 * Existe por uma pressa legitima: "preciso que ele de um tiro logo, porque
 * estamos perdendo tempo pra descobrir que nunca funciona". E o tiro de prova
 * nao resolve isso, porque ele espera o mercado — e o mercado nao esta dando
 * liquidacao nenhuma.
 *
 * A saida e separar duas perguntas que estavam grudadas:
 *
 *   A) A Aave aceita a liquidacao e o contrato consegue vender a garantia?
 *      -> so um alvo liquidavel de verdade responde. Tem de esperar.
 *
 *   B) O bot consegue ASSINAR, MANDAR, ser minerado, ler o recibo e contar o
 *      resultado?
 *      -> qualquer transacao responde. Nao precisa esperar nada.
 *
 * (B) nunca rodou: `nonce: 4` ha cinco dias. E (B) da para provar HOJE, de
 * proposito, por uns cinco centavos: manda-se a cacada num alvo que NAO esta
 * liquidavel, com piso de lucro impossivel. A Aave recusa cedo, a transacao e
 * minerada como falha, e o recibo volta. Gasta-se o gas de uma recusa —
 * 150 mil de gas a 0,12 gwei na Base, US$ 0,048.
 *
 * O que isso prova: a chave do Railway assina, o nonce esta certo, o no aceita
 * o gas adiantado com o saldo que ela tem de verdade, a transacao entra num
 * bloco da Base, `lerRecibo` classifica como 'reverteu', e o placar conta.
 *
 * O que isso NAO prova, e precisa estar escrito em letra grande: nada sobre a
 * Aave aceitar uma liquidacao nem sobre a venda na Aerodrome. Essas duas so um
 * alvo liquidavel responde — e um "tiro em branco" que fosse vendido como
 * "funciona" seria pior que nao ter atirado.
 *
 * A trava e a mesma do tiro de prova, no nonce, e por isso ATENCAO: o branco
 * queima o nonce 4. Se os dois estiverem armados no mesmo numero, o branco
 * desarma o de prova. Os limites tem de ser diferentes — o log diz isso depois
 * de atirar.
 */
export function tiroEmBrancoArmado(entrada: {
    ligado: boolean;
    nonceAtual: number;
    ateNonce: number;
    /** O alvo TEM de ter revertido na medicao. Se nao reverteu, algo mudou. */
    medicaoReverteu: boolean;
}): { armado: boolean; porque: string } {
    if (!entrada.ligado) return { armado: false, porque: 'CACA_TIRO_EM_BRANCO não está ligado' };
    if (!entrada.medicaoReverteu) {
        // Se o alvo do ensaio ficou liquidavel, um tiro em branco seria jogar
        // dinheiro fora numa hora em que cabia um tiro de verdade.
        return { armado: false, porque: 'a medição NÃO reverteu — o alvo pode estar liquidável, e aí cabe tiro de verdade' };
    }
    if (!Number.isInteger(entrada.nonceAtual) || entrada.nonceAtual < 0) {
        return { armado: false, porque: `nonce inválido (${entrada.nonceAtual}) — não mando nada sem saber` };
    }
    if (!Number.isInteger(entrada.ateNonce) || entrada.ateNonce < 0) {
        return { armado: false, porque: 'CACA_TIRO_EM_BRANCO_ATE_NONCE não foi definido — sem trava eu não mando' };
    }
    if (entrada.nonceAtual > entrada.ateNonce) {
        return { armado: false, porque: `já foi: nonce ${entrada.nonceAtual} passou de ${entrada.ateNonce}` };
    }
    return {
        armado: true,
        porque: `ARMADO: nonce ${entrada.nonceAtual} ainda não passou de ${entrada.ateNonce}. ` +
            'Vai reverter DE PROPÓSITO, e prova o caminho de envio — não a liquidação',
    };
}

/**
 * O TIRO DE PROVA: um tiro, de proposito no prejuizo, para saber se funciona.
 *
 * A decisao e dela, e e boa: "mesmo que a gente gaste todo o gas pra pouco
 * lucro, mas ai saberemos que funciona". Codigo que nunca rodou nao e codigo
 * que funciona, e ate agora o caminho inteiro do tiro nunca saiu de verdade —
 * `nonce: 4` ha dias, nenhuma transacao enviada. O ensaio em seco prova tudo
 * MENOS as duas coisas que so a rede responde: a Aave aceita a liquidacao, e o
 * contrato consegue vender a garantia e mandar o lucro para o cofre.
 *
 * O que este modo faz: derruba a exigencia de lucro (de "2x o custo" para
 * "qualquer lucro acima de zero"), o que abre a faixa de baixo — de US$ 0,45
 * para centavos. E ai o alvo mais barato do mundo serve, e a prova custa o gas
 * de um tiro minimo, uns US$ 0,25, em vez dos US$ 4,71 de um tiro grande.
 *
 * O que este modo NAO faz, de proposito: nao desliga a protecao contra baleia
 * amordaçada. A prova que ela quer e de uma migalha; gastar o gas todo numa
 * baleia que provavelmente perde a corrida nao prova nada e acaba com o
 * dinheiro da prova.
 *
 * A TRAVA, que e a parte que importa: um tiro significa UM. O container do
 * Railway reinicia varias vezes por dia e uma trava em memoria voltaria armada
 * a cada reinicio — tres reinicios e o gas acaba. Entao a trava mora na
 * blockchain: o nonce da carteira. Ele so sobe quando uma transacao sai, nunca
 * volta, e e lido no boot de graca. `ateNonce` e o nonce de hoje; assim que o
 * tiro de prova sair, o nonce passa dele e o modo se desarma sozinho, para
 * sempre, em qualquer container.
 */
export function tiroDeProvaArmado(entrada: {
    ligado: boolean;
    nonceAtual: number;
    /** O nonce de HOJE. O tiro de prova vale enquanto o nonce nao passar disto. */
    ateNonce: number;
}): { armado: boolean; porque: string } {
    if (!entrada.ligado) return { armado: false, porque: 'CACA_TIRO_DE_PROVA não está ligado' };
    if (!Number.isInteger(entrada.nonceAtual) || entrada.nonceAtual < 0) {
        return { armado: false, porque: `nonce inválido (${entrada.nonceAtual}) — não arrisco sem saber` };
    }
    if (!Number.isInteger(entrada.ateNonce) || entrada.ateNonce < 0) {
        return { armado: false, porque: 'CACA_TIRO_DE_PROVA_ATE_NONCE não foi definido — sem trava eu não armo' };
    }
    if (entrada.nonceAtual > entrada.ateNonce) {
        return {
            armado: false,
            porque: `já saiu tiro: nonce ${entrada.nonceAtual} passou de ${entrada.ateNonce}. A prova foi feita`,
        };
    }
    return {
        armado: true,
        porque: `ARMADO: nonce ${entrada.nonceAtual} ainda não passou de ${entrada.ateNonce}. ` +
            'Este tiro é para PROVAR, não para lucrar',
    };
}

/**
 * A REGRA DO TIRO, num lugar so.
 *
 * Existe por uma mentira no log. O ensaio em seco imprimia "Se alguem cair, o
 * tiro sai" depois de conferir os freios com um lucro de exemplo de US$ 88 — e
 * ele conferia so tres deles, porque tinha sua PROPRIA copia da conta do lance.
 * Quando entrou o freio que protege a caca de migalhas, o ensaio nao soube:
 * passou a dizer que o tiro sai num premio de US$ 88 que o caminho de verdade
 * RECUSA.
 *
 * Duas copias da mesma regra e o defeito que esta sessao inteira perseguiu, em
 * seis lugares diferentes. Aqui ele estava no pior lugar possivel: no unico
 * teste que existe para dizer se o bot atira.
 *
 * Entao a regra passa a morar aqui, e os dois — o ensaio e o caminho quente —
 * chamam a mesma funcao. A ordem dos freios e a do caminho quente, de proposito,
 * inclusive onde ela e levemente conservadora: o piso de lucro e avaliado com a
 * gorjeta ANTES do corte do adiantado, entao o custo considerado e o maior.
 */
export interface DecisaoDoTiro {
    atira: boolean;
    porque: string;
    /** A gorjeta final, depois de todos os cortes. */
    prioridadeWei: bigint;
    maxFeeWei: bigint;
    /** O que a gorjeta queria ser antes do saldo cortar. */
    desejadaWei: bigint;
    amordaca: LanceAmordacado;
    /** Fracao do saldo que este premio justifica arriscar. */
    risco: number;
    fracaoDoLucro: number;
    custoUsd: Decimal | null;
    custoSePerderWei: bigint;
    aguentaDerrotas: number;
    /** True quando este tiro so passou porque o modo prova baixou a exigencia. */
    soPassouPorSerProva: boolean;
    adiantadoWei: bigint;
    adiantavelWei: bigint;
}

/**
 * Os sete botoes de POLITICA do tiro, lidos do ambiente num lugar so.
 *
 * Existe porque a mesma regra estava em CINCO lugares — quatro montagens deste
 * objeto dentro do cacador e uma no `olharAgora`, que le a Base de fora. Em
 * 2026-09-27 a de fora passava cinco campos dos nove e publicou "faixa do bot:
 * ate US$ 66,78" enquanto o bot dizia US$ 45,80: 46% de diferenca, e com ela a
 * ferramenta anunciou como "o melhor que ele atira hoje" um alvo de US$ 66,42
 * que o bot RECUSA. Um numero que o proprio algoritmo inventou, publicado como
 * se fosse medicao do bot.
 *
 * O botao que faltava era `CACA_RISCO_MAXIMO`, e ele anda ao contrario do que
 * parece: permitir gorjeta maior encarece cada tiro, entao a mordida de uma
 * derrota chega a 50% do saldo num premio MENOR. Medido com o saldo dela:
 * 0.8 -> teto US$ 45,80; 0.6 -> teto US$ 66,84.
 *
 * Quem le a Base de fora nao ve o ambiente do Railway. Entao a funcao aceita o
 * ambiente como argumento: assim o de fora acerta quando os valores batem, e
 * `comoLerAPolitica` deixa ver na hora quando nao batem.
 */
/**
 * Le um numero do ambiente, ou MORRE dizendo qual variavel esta torta.
 *
 * `Number('0,5')` — virgula decimal, que e o natural para quem escreve em
 * portugues — devolve `NaN` em silencio. E `NaN` aqui nao para o bot: ele
 * atravessa a conta inteira e sai do outro lado como decisao errada. Medido:
 * `CACA_MORDIDA_MAXIMA='0,5'` faz `mataACacaDeMigalhas` chamar
 * `BigInt(Math.round(NaN * 1e6))` e estourar `RangeError`, que o laco do cacador
 * engole como "tropeço rápido na rede" — o bot nunca mais atira e o log culpa a
 * rede. E `CACA_FRACAO_GORJETA='15%'` faz a gorjeta cair no piso para qualquer
 * premio, o que apaga a mordaça e libera tiros que a politica correta recusa.
 *
 * Entao a variavel torta para o boot, com o nome dela na mensagem. Um bot que
 * nao sobe e um problema de dez segundos; um bot que decide errado em silencio
 * custou dois dias.
 */
export function numeroDoAmbiente(nome: string, valor: string | undefined, padrao: number): number {
    if (valor === undefined || valor.trim() === '') return padrao;
    const n = Number(valor);
    if (!Number.isFinite(n)) {
        throw new Error(
            `${nome}="${valor}" não é um número que eu consiga usar. `
            + 'Use ponto decimal, não vírgula (0.5, não 0,5), e sem "%" nem espaço.',
        );
    }
    return n;
}

export function politicaDoTiro(env: Record<string, string | undefined> = process.env) {
    const n = (nome: string, padrao: number) => numeroDoAmbiente(nome, env[nome], padrao);
    return {
        limiteGas: env.CACA_LIMITE_GAS ? BigInt(env.CACA_LIMITE_GAS) : LIMITE_DE_GAS,
        fracaoBaseDoLucro: n('CACA_FRACAO_GORJETA', 0.4),
        fracaoBaseDoSaldo: n('CACA_RISCO_POR_TIRO', 0.25),
        fracaoMaximaDoSaldo: n('CACA_RISCO_MAXIMO', 0.6),
        margemMinima: n('CACA_MARGEM_MINIMA', 2),
        tetoDaMordida: n('CACA_MORDIDA_MAXIMA', 0.5),
        atirarAmordacado: env.CACA_ATIRAR_AMORDACADO === '1',
        // Prejuizo conhecido aceito de proposito. So vale junto com o modo prova,
        // que tem trava de nonce: UM tiro, uma vez, e desarma sozinho.
        aceitaPrejuizo: env.CACA_ACEITA_PREJUIZO === '1',
        // A FAIXA DE NEGOCIO, pedida por ela em 2026-09-28: lucro liquido entre
        // US$ 0,50 e US$ 500. Abaixo e poeira que nao paga o proprio gas; acima
        // e tubarao, onde o pool da Aerodrome satura o premio em US$ 1.986
        // (`coberturaOtima`) e quem usa agregador cobre mais da mesma divida e
        // tem mais incentivo para pagar gorjeta alta. O oceano azul e no meio.
        //
        // Diferente de tudo o mais deste objeto, este par vale TAMBEM no modo
        // prova: e regra de negocio, nao protecao de banca.
        lucroMinimoUsd: n('CACA_LUCRO_MINIMO_USD', 0.5),
        // TETO ARRANCADO EM 2026-09-30, a pedido dela: "eu quero o alvo de
        // US$ 1.986". Era 500, e o padrao agora e SEM TETO.
        //
        // O que ela ganha: o alvo grande deixa de ser recusado com "tubarao,
        // deixo passar". A auditoria de hoje provou que era ESTE portao — e nao
        // latencia — que recusava US$ 1.986.
        //
        // O que ela aceita, e esta medido: o premio de uma posicao grande SATURA
        // em US$ 1.986, porque e o que o pool da Aerodrome vende sem o
        // escorregamento comer o lucro (`coberturaOtima`). Uma divida de
        // US$ 95M rende os mesmos US$ 1.986 de uma de US$ 240 mil. E quem usa
        // agregador cobre mais da mesma divida e tem mais incentivo para pagar
        // gorjeta alta — era esse o argumento do teto.
        //
        // `Infinity` e o padrao, e nao um numero grande: um numero grande seria
        // um teto disfarcado, e `dentroDaFaixaDeNegocio` ja trata infinito.
        // Para voltar a ter teto: `CACA_LUCRO_MAXIMO_USD=500`.
        lucroMaximoUsd: n('CACA_LUCRO_MAXIMO_USD', Number.POSITIVE_INFINITY),
        // ACIMA DESTE PREMIO a gorjeta vira TUDO O QUE A CARTEIRA ADIANTA.
        //
        // Pedido dela em 2026-09-30: "se eu tiver que queimar os 0.016 ETH
        // inteiros para garantir a vitoria no alvo de US$ 1.986, eu aceito".
        //
        // Medido no mesmo dia, saldo 0,016419 ETH, baseFee 0,005 gwei, gas 700k:
        //
        //     teto da carteira ............ 21,1103 gwei  (custo US$ 39,79)
        //     amordacada (risco 0,6) ...... 14,0685 gwei
        //     concorrentes, 19 liquidacoes .. 0,0129 a 0,4002 gwei
        //
        // Ou seja: mesmo AMORDACADA a gorjeta ja era 35x a maior que qualquer
        // concorrente pagou. O kamikaze compra 50% a mais de gorjeta contra um
        // campo que nunca passou de 0,4 — nao era a mordaca que custava o alvo.
        // Vai ligado porque ela pediu e porque US$ 39,79 contra US$ 1.986 e
        // barato, nao porque a medicao dizia que era necessario.
        //
        // O limiar e 500 de proposito: e a fronteira que ELA desenhou para o
        // teto, agora reaproveitada de "recuso" para "vou com tudo". Numero que
        // ela escolheu, nao numero que eu inventei.
        // `0` = sem piso extra: quem decide e a regra derivada acima.
        gorjetaTotalAcimaDeUsd: n('CACA_GORJETA_TOTAL_ACIMA_DE_USD', 0),
    };
}

/** O lucro esta na faixa de negocio? Fora dela nao se atira, nem na prova. */
export function dentroDaFaixaDeNegocio(
    lucroUsd: Decimal | null,
    pisoUsd: number,
    tetoUsd: number,
): { dentro: boolean; porque: string } {
    if (lucroUsd === null) {
        return { dentro: false, porque: 'sem cotação: não sei o lucro, então não sei se está na faixa' };
    }
    if (lucroUsd.lessThan(pisoUsd)) {
        return { dentro: false, porque: `US$ ${lucroUsd.toFixed(2)} está ABAIXO do piso de US$ ${pisoUsd.toFixed(2)}: poeira` };
    }
    if (lucroUsd.greaterThan(tetoUsd)) {
        return { dentro: false, porque: `US$ ${lucroUsd.toFixed(2)} está ACIMA do teto de US$ ${tetoUsd.toFixed(2)}: tubarão, deixo passar` };
    }
    return { dentro: true, porque: `US$ ${lucroUsd.toFixed(2)} está na faixa (US$ ${pisoUsd.toFixed(2)}–${tetoUsd.toFixed(2)})` };
}

/**
 * A politica em uma linha, para quem le de fora poder CONFERIR com o log.
 *
 * Sem isto, uma faixa calculada aqui com outros botoes que os do Railway parece
 * a faixa do bot e nao ha como notar. Foi assim que "ate US$ 66,78" passou por
 * medicao.
 */
export function comoLerAPolitica(p: ReturnType<typeof politicaDoTiro>): string {
    // Esta linha imprimia SETE dos oito botoes, e o que faltava era justamente o
    // que decide se o bot atira. Ela existe para permitir conferir os valores
    // daqui contra os do Railway; um botao que nao aparece nao pode ser conferido.
    return `gás ${p.limiteGas} | gorjeta ${p.fracaoBaseDoLucro} do lucro | risco ${p.fracaoBaseDoSaldo}`
        + `→${p.fracaoMaximaDoSaldo} do saldo | margem ${p.margemMinima}x | mordida máx ${p.tetoDaMordida}`
        + ` | amordaçado ${p.atirarAmordacado ? 'sim' : 'não'}`
        + ` | aceita prejuízo ${p.aceitaPrejuizo ? 'SIM' : 'não'}`
        + ` | faixa de negócio US$ ${p.lucroMinimoUsd}–${
            Number.isFinite(p.lucroMaximoUsd) ? p.lucroMaximoUsd : 'SEM TETO'}`
        + ` | gorjeta TOTAL acima de US$ ${p.gorjetaTotalAcimaDeUsd}`;
}

/**
 * A DECISAO, e o kamikaze por premio alto e um RESGATE — nunca um upgrade.
 *
 * A primeira versao de 2026-09-30 ligava o all-in sempre que a mordaca mordia,
 * o que mudava a gorjeta de TODO premio acima de ~US$ 80: um alvo de US$ 223
 * passava a pagar US$ 39,79 de gas onde pagava US$ 18,00, contra um campo que
 * (medido, 19 liquidacoes) nunca passou de 0,4002 gwei. E quebrou 13 testes de
 * uma vez, porque invertia a forma da faixa que este projeto construiu medindo.
 *
 * Mudanca demais para o que ela pediu, que foi "nao perder o alvo grande".
 *
 * Entao a regra e estritamente ADITIVA: decide normal; se o normal RECUSA e a
 * recusa vem da mordaca, tenta outra vez com a carteira inteira. Nenhum tiro
 * que ja saia muda de gorjeta; so os que nao saiam passam a sair.
 *
 *     premio US$   2 -> 0,4246 gwei  (igual a antes)
 *     premio US$  66 -> 6,3093 gwei  (igual a antes)
 *     premio US$ 223 -> 9,5486 gwei  (igual a antes)
 *     premio US$ 329 -> RECUSAVA     -> agora 21,1053 gwei, custo US$ 39,79
 *     premio US$1986 -> RECUSAVA     -> agora 21,1053 gwei, custo US$ 39,79
 */
export function decidirTiro(e: Parameters<typeof decidirTiroUmaVez>[0]): DecisaoDoTiro {
    const normal = decidirTiroUmaVez(e);
    if (normal.atira) return normal;
    // Ja e kamikaze por ser prova, ou o resgate esta desligado: nada a tentar.
    if ((e.tiroDeProva ?? false) && (e.gorjetaKamikaze ?? true)) return normal;
    if (e.gorjetaTotalAcimaDeUsd === undefined) return normal;
    const resgate = decidirTiroUmaVez({ ...e, forcarKamikaze: true });
    // So vale se o resgate REALMENTE atira. Devolver o resgate que tambem
    // recusa trocaria o motivo da recusa por outro, e o motivo e o que ela le.
    return resgate.atira ? resgate : normal;
}

function decidirTiroUmaVez(e: {
    lucroUsd: Decimal | null;
    precoDoEthUsd: Decimal | null;
    saldoWei: bigint;
    baseFeeWei: bigint;
    limiteGas?: bigint;
    perdasSeguidas?: number;
    fracaoBaseDoLucro?: number;
    fracaoBaseDoSaldo?: number;
    fracaoMaximaDoSaldo?: number;
    margemMinima?: number;
    tetoDaMordida?: number;
    atirarAmordacado?: boolean;
    /**
     * Modo prova: aceita qualquer lucro acima de zero em vez de exigir 2x o
     * custo, e solta o teto que protege a caca de migalhas.
     */
    tiroDeProva?: boolean;
    /**
     * Aceitar PREJUIZO: atirar sabendo que a conta fecha negativa.
     *
     * CORRECAO de 2026-09-28, achada por revisao horas depois de eu mandar a dona
     * do bot ligar a chave: eu escrevi aqui que sem ela "o bot nunca atira", e
     * isso estava ERRADO. O lucro que chega em `decidirTiro` pelo caminho quente
     * vem do contrato, decodificado com `BigInt('0x'+...)` em
     * `lerRespostaDaCaca` — e um inteiro SEM SINAL, entao nunca e negativo. A
     * porta que eu disse que estava trancada nunca teve como ser usada.
     *
     * O que esta chave faz DE VERDADE, e um teste me corrigiu de novo aqui: o modo
     * prova JA aceitava prejuizo. Com margem zero, `valeATentativa` so exige lucro
     * ACIMA de zero — entao um lucro bruto de US$ 0,01 contra um gas de US$ 0,22
     * ja passava, sem chave nenhuma.
     *
     * Esta chave muda o comportamento em UM caso: lucro bruto exatamente ZERO, que
     * e o que `lerRespostaDaCaca` devolve de proposito quando a resposta vem vazia
     * ou curta. So isso. Nao e ela que faz o bot atirar.
     *
     * (E ela so passou a alcancar o caso do zero junto com outro conserto do mesmo
     * dia: `leitura.lucroCru` era testado por veracidade, e `0n` e falso em
     * JavaScript, entao uma medicao de lucro exatamente zero era descartada antes
     * de chegar aqui.)
     *
     * Por que isso importa, medido no mesmo dia: das 51 liquidacoes de 9,5 dias na
     * Aave da Base, 32 foram levadas no MESMO bloco em que ficaram liquidaveis, e
     * as 11 com janela de leitura eram todas poeira — dividas de US$ 0,20 a
     * US$ 0,31, que o gas de US$ 0,22 nao deixa lucrar. O alvo que este bot
     * consegue ler e um que nao paga o proprio gas.
     *
     * A dona do bot pediu isso em palavras, duas vezes: "custe o que custar mesmo
     * que isso va todo nosso gas" e "eu quero que ele atire o mais rapido possivel
     * a qualquer custo". O prejuizo e o preco da informacao, e a escolha e dela.
     *
     * So tem efeito junto com `tiroDeProva`, que e onde mora a trava: UM tiro, e o
     * modo se desarma sozinho pelo nonce.
     */
    aceitaPrejuizo?: boolean;
    /**
     * No modo prova, NAO amordacar a gorjeta pelo tamanho do premio.
     *
     * Ligado por padrao junto com `tiroDeProva`: o modo prova existe para ver a
     * liquidacao acontecer, e uma gorjeta proporcional a uma migalha perde a
     * corrida por desenho. Desligar so faz sentido para medir o comportamento
     * normal com a prova armada.
     */
    gorjetaKamikaze?: boolean;
    /** Piso da faixa de NEGOCIO, em dolares de lucro liquido. */
    lucroMinimoUsd?: number;
    /** Teto da faixa de NEGOCIO. Acima disto e tubarao e se deixa passar. */
    lucroMaximoUsd?: number;
    /**
     * Acima deste premio a gorjeta vira o teto da carteira. `undefined` = so o
     * tiro de prova entra no kamikaze, que era o comportamento antigo.
     */
    gorjetaTotalAcimaDeUsd?: number;
    /** Uso interno do resgate acima. Nao vem do ambiente. */
    forcarKamikaze?: boolean;
}): DecisaoDoTiro {
    const limiteGas = e.limiteGas ?? LIMITE_DE_GAS;
    const fracaoDoLucro = fracaoAdaptativa({
        base: e.fracaoBaseDoLucro ?? FRACAO_DO_LUCRO,
        perdasSeguidas: e.perdasSeguidas ?? 0,
    });
    // MODO KAMIKAZE, e ela pediu com todas as letras: "nem que eu gaste todo o
    // meu saldo de gas de bribe num alvo que de US$ 0,05 de premio bruto".
    //
    // Fora do modo prova a gorjeta e uma FRACAO DO PREMIO, e tem de ser: pagar
    // US$ 9 de gorjeta por US$ 0,05 de premio e queimar a banca. Mas no modo
    // prova o premio nao e o ponto — o ponto e GANHAR a corrida uma vez, para
    // ver a liquidacao acontecer de ponta a ponta. Ai a gorjeta proporcional e
    // exatamente o que faz perder: o log mediu `gorjeta 2.49 gwei (AMORDACADA
    // — queria 7.02)` num premio de migalha.
    //
    // Entao no modo prova a desejada e o TETO DA CARTEIRA, e quem corta passa a
    // ser so `gorjetaQueCabeNoSaldo` com a fracao de risco. UM tiro, e o modo
    // se desarma sozinho pelo nonce.
    //
    // E DESDE 2026-09-30 tambem por PREMIO ALTO, pedido dela: "se eu tiver que
    // queimar os 0.016 ETH inteiros para garantir a vitoria no alvo de
    // US$ 1.986, eu aceito". A mesma mecanica, dois gatilhos — e nao duas
    // implementacoes, que e a regra 3 deste projeto.
    const desejadaProporcionalWei = gorjetaPorGas({
        lucroUsd: e.lucroUsd ?? new Decimal(0),
        precoDoEthUsd: e.precoDoEthUsd ?? new Decimal(0),
        limiteGas: GAS_TIPICO_DE_UMA_CACADA,
        fracaoDoLucro,
    });
    const saldoUsd = e.precoDoEthUsd === null
        ? null
        : new Decimal(e.saldoWei.toString()).dividedBy(1e18).mul(e.precoDoEthUsd);
    // Sem cotacao o risco NAO vira zero: zero cairia em "sem gas para atirar" e
    // o bot recusaria culpando o gas, tendo gas.
    const fracaoBaseDoSaldo = e.fracaoBaseDoSaldo ?? 0.25;
    const risco = saldoUsd === null || e.lucroUsd === null
        ? fracaoBaseDoSaldo
        : fracaoDoSaldoQueValeArriscar({
            lucroUsd: e.lucroUsd,
            saldoUsd,
            fracaoBase: fracaoBaseDoSaldo,
            fracaoMaxima: e.fracaoMaximaDoSaldo ?? 0.6,
        });
    // O limiar NAO e um numero cravado, e a primeira versao disto era — eu pus
    // 500 e criei uma FAIXA MORTA: medido, a mordaca comeca a recusar em
    // US$ 329 (o `ate` de `faixaQueAtira` com o saldo dela), entao US$ 499
    // recusava por estar acima da mordaca e abaixo do meu limiar. Um buraco de
    // US$ 170 de premio, criado pelo conserto.
    //
    // E 329 nao serve de constante: ele SAI do saldo, e muda quando ela
    // deposita. A regra derivada, que se ajusta sozinha:
    //
    //   vai com tudo quando (a) a mordaca REALMENTE morde — a proporcional nao
    //   cabe no saldo, logo quem limita e a carteira e nao a politica — e
    //   (b) o premio cobre a margem exigida sobre o custo do tiro all-in.
    //
    // (b) impede o caso idiota: com o teto da carteira a US$ 39,79 de gas, um
    // premio de US$ 40 queimaria a carteira para empatar. `margemMinima` (2x) e
    // a mesma regua que o resto da decisao usa, entao o piso efetivo e
    // ~US$ 79,58 e ele acompanha o saldo e o gas sem eu escolher nada.
    //
    // `CACA_GORJETA_TOTAL_ACIMA_DE_USD` fica como piso OPCIONAL por cima disso,
    // para ela poder dizer "so acima de US$ X" sem mexer em codigo.
    const premioUsd = e.lucroUsd ?? new Decimal(0);
    const tetoDaCarteiraWei = maxFeeQueOSaldoAdianta(e.saldoWei, limiteGas);
    const custoAllInUsd = e.precoDoEthUsd === null
        ? null
        : custoDoTiroUsd(tetoDaCarteiraWei, e.baseFeeWei, e.precoDoEthUsd);
    const mordacaMorde = desejadaProporcionalWei > tetoDaCarteiraWei
        || gorjetaQueCabeNoSaldo({
            gorjetaDesejadaWei: desejadaProporcionalWei,
            saldoWei: e.saldoWei,
            baseFeeWei: e.baseFeeWei,
            fracaoMaximaDoSaldo: risco,
        }) < desejadaProporcionalWei;
    const pagaAMargem = custoAllInUsd !== null
        && custoAllInUsd.greaterThan(0)
        && premioUsd.greaterThanOrEqualTo(custoAllInUsd.mul(e.margemMinima ?? 2));
    const pisoOpcional = e.gorjetaTotalAcimaDeUsd === undefined
        || !Number.isFinite(e.gorjetaTotalAcimaDeUsd)
        || premioUsd.greaterThanOrEqualTo(e.gorjetaTotalAcimaDeUsd);
    const premioJustifica = (e.forcarKamikaze ?? false) && mordacaMorde && pagaAMargem && pisoOpcional;
    const kamikaze = ((e.tiroDeProva ?? false) && (e.gorjetaKamikaze ?? true)) || premioJustifica;
    const desejadaWei = kamikaze
        ? tetoDaCarteiraWei
        : desejadaProporcionalWei;
    // NO KAMIKAZE A FRACAO DE RISCO SAI INTEIRA.
    //
    // `fracaoDoSaldoQueValeArriscar` escala pelo LUCRO: premio pequeno fica na
    // fracao BASE. Medido em 2026-09-28 com o saldo dela (US$ 8,99) e o risco
    // maximo 0.8 do Railway:
    //
    //     premio US$ 0,50 -> fracao 0,2500 -> gorjeta 1,173 gwei de 2,506
    //     premio US$ 2    -> fracao 0,2500 -> gorjeta 1,173 gwei de 2,506
    //     premio US$ 34   -> fracao 0,4199 -> gorjeta 1,984 gwei
    //     premio US$ 66   -> fracao 0,6373 -> gorjeta 2,486 gwei (inteira)
    //
    // Ou seja: o alvo de US$ 2 — que e o formato da MAIORIA das liquidacoes da
    // Base, 31 das 52 do censo abaixo do piso de gas — ia para a rede com menos
    // da METADE da gorjeta, no unico tiro que precisa ser ganho. Subir a fracao
    // MAXIMA nao resolvia: ela nem era alcancada.
    //
    // A escala existe e esta certa em operacao normal: arriscar banca grande por
    // premio pequeno e como se perde a banca. Mas o modo prova nao esta atras de
    // premio, e ela pediu com todas as letras "nem que eu gaste todo o meu saldo
    // de gas num alvo que de US$ 0,05".
    //
    // O que NAO sai, porque e aritmetica: `aguentaDerrotas` continua tendo de
    // ser pelo menos 1 e o gas adiantado continua tendo de caber. Medido com a
    // fracao em 1.0: todo premio de US$ 0,50 para cima recebe 2,486 gwei
    // inteiros e `aguentaDerrotas` fica em 1 — um tiro, pago.
    const riscoDoTiro = kamikaze ? 1 : risco;
    let prioridadeWei = gorjetaQueCabeNoSaldo({
        gorjetaDesejadaWei: desejadaWei,
        saldoWei: e.saldoWei,
        baseFeeWei: e.baseFeeWei,
        fracaoMaximaDoSaldo: riscoDoTiro,
    });

    const custoUsd = custoDoTiroUsd(prioridadeWei, e.baseFeeWei, e.precoDoEthUsd);
    // No modo prova a margem cai para zero: qualquer lucro acima de zero passa.
    // Nao e descuido, e o preco da informacao — e ela escolheu pagar.
    //
    // E com `aceitaPrejuizo` o portao do lucro sai inteiro: o tiro sai sabendo
    // que a conta fecha negativa, porque a medicao de 2026-09-28 mostrou que o
    // unico alvo legivel a tempo e um que da prejuizo. Sem isto o bot nunca
    // atira, nem quando o alvo aparece.
    //
    // O que NAO sai, nem aqui: atirar sem cotacao. Sem saber o preco do ETH nao
    // se dimensiona a gorjeta, e sem saber o lucro nao se sabe em QUE se atirou —
    // e um tiro que nao ensina nada nao vale nem o prejuizo.
    const aceitaPrejuizo = (e.tiroDeProva ?? false) && (e.aceitaPrejuizo ?? false);
    const veredicto = !aceitaPrejuizo
        ? valeATentativa(e.lucroUsd, custoUsd, e.tiroDeProva ? 0 : (e.margemMinima ?? 2))
        : custoUsd === null || e.lucroUsd === null
            ? valeATentativa(e.lucroUsd, custoUsd, 0)
            : {
                vale: true,
                porque: `PREJUÍZO ACEITO DE PROPÓSITO: lucro de US$ ${e.lucroUsd.toFixed(2)} contra custo de `
                    + `US$ ${custoUsd.toFixed(2)}. Isto NÃO é um acerto — é comprar a informação de que o `
                    + 'caminho funciona, e ela pediu assim',
            };

    let maxFeeWei = tetoPorGas(e.baseFeeWei, prioridadeWei);
    const adiantavelWei = maxFeeQueOSaldoAdianta(e.saldoWei, limiteGas);
    if (maxFeeWei > adiantavelWei) {
        maxFeeWei = adiantavelWei;
        if (prioridadeWei > maxFeeWei - e.baseFeeWei) {
            prioridadeWei = maxFeeWei > e.baseFeeWei ? maxFeeWei - e.baseFeeWei : 0n;
        }
    }
    const amordaca = lanceAmordacado({
        desejadaWei,
        conseguidaWei: prioridadeWei,
        limiteGas,
        baseFeeWei: e.baseFeeWei,
    });
    const custoSePerderWei = custoDeUmaDerrota(prioridadeWei, e.baseFeeWei);
    const aguentaDerrotas = derrotasQueAguenta(e.saldoWei, custoSePerderWei);
    const mata = mataACacaDeMigalhas({
        amordacado: amordaca.amordacado,
        custoDaDerrotaWei: custoSePerderWei,
        saldoWei: e.saldoWei,
        tetoDaMordida: e.tetoDaMordida,
        atirarAmordacado: e.atirarAmordacado,
    });

    // Se o tiro passa NA PROVA mas nao passaria na regra normal, a pessoa tem
    // de ver isso escrito: senao o primeiro acerto vira "ele funciona e da
    // lucro" quando foi "ele funciona e deu prejuizo de proposito".
    // A REGRA NORMAL tem de ser avaliada com a GORJETA NORMAL.
    //
    // Com o kamikaze ligado, `custoUsd` e `mata` ja sao do tiro de prova — uma
    // gorjeta de carteira inteira. Perguntar "passaria na regra normal?" com
    // esses numeros compara coisas diferentes: em 2026-09-28 isso fez o premio
    // de US$ 1.986 aparecer como "passaria normal" (1986 > 2 x 4,76) enquanto a
    // regra normal, com a gorjeta dela, recusava. O rotulo que existe para
    // impedir o primeiro acerto de parecer lucro legitimo apagava-se sozinho.
    //
    // Entao a pergunta e feita inteira, com os numeros do tiro normal.
    const prioridadeNormalWei = kamikaze
        ? gorjetaQueCabeNoSaldo({
            gorjetaDesejadaWei: desejadaProporcionalWei,
            saldoWei: e.saldoWei,
            baseFeeWei: e.baseFeeWei,
            fracaoMaximaDoSaldo: risco,
        })
        : prioridadeWei;
    const custoNormalUsd = kamikaze
        ? custoDoTiroUsd(prioridadeNormalWei, e.baseFeeWei, e.precoDoEthUsd)
        : custoUsd;
    const mataNormal = kamikaze
        ? mataACacaDeMigalhas({
            amordacado: lanceAmordacado({
                desejadaWei: desejadaProporcionalWei,
                conseguidaWei: prioridadeNormalWei,
                limiteGas,
                baseFeeWei: e.baseFeeWei,
            }).amordacado,
            custoDaDerrotaWei: custoDeUmaDerrota(prioridadeNormalWei, e.baseFeeWei),
            saldoWei: e.saldoWei,
            tetoDaMordida: e.tetoDaMordida,
            atirarAmordacado: e.atirarAmordacado,
        })
        : mata;
    const passariaNormal = valeATentativa(e.lucroUsd, custoNormalUsd, e.margemMinima ?? 2).vale
        && !mataNormal.pula;
    const comum = {
        // `risco` publicado e o que FOI USADO no tiro, nao o que a regra normal
        // teria escolhido — senao o log explica a gorjeta com um numero que nao
        // a produziu.
        prioridadeWei, maxFeeWei, desejadaWei, amordaca, risco: riscoDoTiro, fracaoDoLucro,
        custoUsd, custoSePerderWei, aguentaDerrotas,
        // "So passou por ser prova" vale para as DUAS pontas: o piso de lucro e
        // o teto que protege a caca. Cobrir so o piso deixaria o primeiro tiro
        // grande aparecer como tiro normal.
        soPassouPorSerProva: (e.tiroDeProva ?? false) && veredicto.vale && !passariaNormal,
        adiantadoWei: adiantadoExigido(limiteGas, maxFeeWei),
        adiantavelWei,
    };
    // A ordem e a do caminho quente. O primeiro freio que barra e o que explica.
    //
    // A FAIXA DE NEGOCIO vem primeiro, e vale ATE no modo prova: ela nao protege
    // a banca, ela escolhe em que mercado a gente joga. Abaixo do piso e poeira
    // que nao paga o gas; acima do teto e tubarao, onde o premio satura no pool
    // e quem usa agregador tem mais incentivo para pagar gorjeta alta.
    // Sem faixa PEDIDA, sem faixa aplicada: o padrao e nao filtrar. Quem impoe
    // e `politicaDoTiro`, que le `CACA_LUCRO_MINIMO_USD`/`CACA_LUCRO_MAXIMO_USD`
    // e e o que producao usa. Por um instante eu pus 0,5/500 como default aqui, e
    // seis testes que nao pedem faixa nenhuma passaram a ser filtrados por ela —
    // a regra vazando para quem nao a escolheu.
    if (e.lucroMinimoUsd !== undefined || e.lucroMaximoUsd !== undefined) {
        const faixa = dentroDaFaixaDeNegocio(
            e.lucroUsd,
            e.lucroMinimoUsd ?? 0,
            e.lucroMaximoUsd ?? Number.POSITIVE_INFINITY,
        );
        if (!faixa.dentro) return { ...comum, atira: false, porque: faixa.porque };
    }
    if (!veredicto.vale) return { ...comum, atira: false, porque: veredicto.porque };
    if (adiantavelWei <= e.baseFeeWei) {
        return { ...comum, atira: false, porque: 'o gás adiantado não cabe no saldo' };
    }
    if (prioridadeWei === 0n || aguentaDerrotas < 1) {
        return {
            ...comum,
            atira: false,
            porque: e.saldoWei === 0n
                ? 'sem gás nenhum'
                : `não aguento nem uma derrota (ela custa ${new Decimal(custoSePerderWei.toString()).dividedBy(1e18).toFixed(6)} ETH)`,
        };
    }
    // O modo prova NAO tem caca de migalhas para proteger. Ele existe para
    // comprar UMA informacao — "o caminho funciona de verdade" — e a dona do bot
    // escolheu pagar por ela com o gas inteiro se for preciso, explicitamente e
    // mais de uma vez.
    //
    // Soltar o piso de lucro e manter este teto era abrir uma porta e trancar a
    // gemea: o mesmo defeito que o CLAUDE.md registra do dia em que o modo prova
    // soltou o portao do TIRO e nao soltou o filtro da SELECAO. Medido em
    // 2026-09-27: com o saldo dela e `CACA_RISCO_MAXIMO=0.8`, o teto ficava em
    // US$ 45,80 e RECUSAVA o melhor alvo visivel, de US$ 66,42 a 1,44% de cair —
    // o modo prova recusando exatamente o alvo que ele existe para atirar.
    //
    // O que NAO se solta, porque nao e politica e sim aritmetica: o gas adiantado
    // tem de caber no saldo, e uma derrota tem de ser pagavel. Sem isso o no nem
    // aceita a transacao.
    if (mata.pula && !e.tiroDeProva) return { ...comum, atira: false, porque: mata.porque };
    return {
        ...comum,
        atira: true,
        // A frase segue o ROTULO, e nao um dos motivos dele. Antes ela só saía
        // quando `mata.pula`, então um tiro marcado `soPassouPorSerProva` podia
        // ser publicado com a frase de um tiro normal — a etiqueta e o texto
        // discordando sobre o mesmo tiro.
        porque: comum.soPassouPorSerProva
            ? `${veredicto.porque} — E SÓ SAI PORQUE É PROVA: ${
                mataNormal.pula ? mataNormal.porque
                : aceitaPrejuizo ? 'a regra normal recusa prejuízo'
                : `na regra normal o custo seria US$ ${custoNormalUsd?.toFixed(2) ?? '?'} e a margem exigida não fecha`}`
            : veredicto.porque,
    };
}

/**
 * A FAIXA de premio pela qual este saldo atira: de quanto ate quanto.
 *
 * Eu escrevi isto primeiro como "o maior premio que atira", com busca binaria a
 * partir de um centavo, e o proprio teste derrubou: devolveu `null` para um
 * saldo que atira bem. O erro era de raciocinio, nao de codigo — a decisao NAO
 * e monotona no premio. Ela e falsa, depois verdadeira, depois falsa outra vez:
 *
 *   - premio pequeno demais nao paga o proprio gas (piso de lucro)
 *   - no meio, atira
 *   - premio grande demais amordaça o lance e uma derrota mata a caca
 *
 * Ou seja e um INTERVALO, e chamar de "teto" escondia metade da verdade. Com o
 * saldo de 2026-09-27 a faixa e de uns US$ 0,46 a uns US$ 11,70 — e a ponta de
 * baixo importa tanto quanto a de cima, porque e ela que diz que as migalhas
 * miudas tambem nao servem.
 *
 * A varredura para achar o ancora e geometrica porque a faixa pode ser estreita
 * e estar em qualquer escala; as duas buscas binarias depois disso sao exatas
 * ate a precisao pedida.
 */
export interface FaixaDeTiro {
    /**
     * Abaixo disto o premio nao paga o proprio gas. `null` quando NAO HA piso —
     * o que acontece no modo prova, onde qualquer lucro acima de zero passa.
     *
     * Era um numero sempre, e no modo prova ele devolvia 0,0001: o chao da
     * propria busca, nao uma medicao. O log imprimiu "US$ 0.00 a US$ 45.68.
     * Abaixo nao paga o gas" — um piso inventado pelo algoritmo, com uma frase
     * que o contradiz. `null` diz a verdade: nao existe piso.
     */
    de: Decimal | null;
    /**
     * Acima disto uma derrota comeria mais gas do que a caca aguenta. `null`
     * quando NAO HA teto dentro do que se procurou.
     *
     * Era um numero sempre, e com gas de sobra devolvia `tetoDaBusca` — o chao
     * da propria varredura, publicado como medicao. O log imprimiu "teto
     * US$ 1000000", que nao e um teto: e "nao achei teto ate um milhao". Eu
     * tinha consertado exatamente isso na ponta de BAIXO e deixei o mesmo
     * defeito na de cima.
     */
    ate: Decimal | null;
    /**
     * Ate onde o lance sai INTEIRO. Entre este e `ate` o bot atira amordaçado:
     * ainda vale, mas com desvantagem no leilao.
     *
     * Existe porque eu mesma confundi os dois e informei o numero errado: disse
     * que o bot parava de atirar em US$ 11,69 quando ele para de atirar em
     * US$ 66,80 e para de atirar COM FORCA em US$ 11,69. Sao perguntas
     * diferentes e a resposta de uma nao serve para a outra.
     */
    inteiroAte: Decimal | null;
    /**
     * A PARTIR de onde o lance sai inteiro — a ponta oposta de `inteiroAte`.
     *
     * Existe porque o MODO KAMIKAZE inverteu a mordaça, e isso foi medido em
     * 2026-09-28 com o saldo real (0,003341 ETH, baseFee 0,02 gwei):
     *
     *     prêmio    desejada  conseguida  amordaçado?
     *     US$ 0,01    2,506      1,173       sim
     *     US$ 20      2,506      1,399       sim
     *     US$ 66      2,506      2,347       NÃO
     *     US$ 1986    2,506      2,486       NÃO
     *
     * Fora do modo prova a gorjeta desejada CRESCE com o prêmio e o teto do
     * saldo para de crescer: uma vez amordaçado, amordaçado para sempre, e
     * `inteiroAte` responde tudo. No kamikaze a desejada é CONSTANTE (o teto da
     * carteira) e quem cresce é a conseguida, pela fração de risco — então a
     * região inteira é [X, infinito), e não [chão, Y].
     *
     * Sem isto, `faixaQueAtira` testava o chão, via mordaça e desistia,
     * publicando `lanceInteiroAte: "nenhum prêmio com lance inteiro"` na MESMA
     * tela em que `numDeUS$88` dizia `gorjeta 2.49 gwei (inteira)`.
     */
    inteiroDe: Decimal | null;
    /**
     * A regiao do lance inteiro NAO e contigua?
     *
     * Descoberto em 2026-09-30 consertando o resgate all-in. Com ele a forma
     * passou a ter TRES regioes, e nao duas:
     *
     *     premio pequeno .... a proporcional cabe no saldo  -> INTEIRO
     *     premio medio ...... a proporcional nao cabe       -> amordacado
     *     premio grande ..... o resgate paga a carteira toda -> INTEIRO
     *
     * `inteiroDe` e `inteiroAte` sao DOIS campos e descrevem uma fronteira. Com
     * tres regioes, qualquer um dos dois que eu publicasse seria uma fronteira
     * que nao existe — a etiqueta que nao descreve o conjunto, que e o defeito
     * que este projeto persegue desde o primeiro dia.
     *
     * Entao quando ha buraco as duas pontas saem `null` e ESTE campo fica
     * `true`, e o log diz que ha buraco em vez de inventar um numero.
     */
    inteiroTemBuraco: boolean;
}

export function faixaQueAtira(
    e: Omit<Parameters<typeof decidirTiro>[0], 'lucroUsd'>,
    tetoDaBusca = new Decimal(1_000_000),
    passos = 60,
): FaixaDeTiro | null {
    const atira = (usd: Decimal) => decidirTiro({ ...e, lucroUsd: usd }).atira;

    // 1) Achar QUALQUER premio que atire, subindo em escala geometrica.
    let ancora: Decimal | null = null;
    for (let x = new Decimal('0.01'); x.lessThanOrEqualTo(tetoDaBusca); x = x.mul('1.2')) {
        if (atira(x)) { ancora = x; break; }
    }
    if (ancora === null) return null;

    // 2) Ponta de baixo: o menor premio que ainda atira, ou `null` se nao ha.
    const PROBE = new Decimal('0.000001');
    let de: Decimal | null = null;
    if (!atira(PROBE)) {
        let fora = PROBE;
        let dentro = ancora;
        for (let i = 0; i < passos; i++) {
            const meio = fora.plus(dentro).dividedBy(2);
            if (atira(meio)) dentro = meio; else fora = meio;
        }
        de = dentro;
    }

    // 3) Ponta de cima: o maior premio que ainda atira, ou `null` se nao ha.
    let ate: Decimal | null = null;
    if (!atira(tetoDaBusca)) {
        let dentro = ancora;
        let fora = tetoDaBusca;
        for (let i = 0; i < passos; i++) {
            const meio = dentro.plus(fora).dividedBy(2);
            if (atira(meio)) dentro = meio; else fora = meio;
        }
        ate = dentro;
    }

    // Onde o lance sai INTEIRO — e a busca NAO supoe a direcao.
    //
    // A versao anterior supunha: "a gorjeta desejada cresce com o premio e o
    // teto do saldo para de crescer, entao uma vez amordaçado, amordaçado para
    // sempre". Isso vale fora do modo prova. O MODO KAMIKAZE inverte: a
    // desejada vira o teto da carteira (constante) e quem cresce e a
    // conseguida, pela fracao de risco. Ver `inteiroDe`.
    const inteiro = (usd: Decimal) => {
        const d = decidirTiro({ ...e, lucroUsd: usd });
        return d.atira && !d.amordaca.amordacado;
    };
    const chao = de ?? PROBE;
    const teto = ate ?? tetoDaBusca;
    /** A fronteira entre `a` e `b`, onde `inteiro` muda de resposta. */
    const fronteira = (dentro: Decimal, fora: Decimal): Decimal => {
        let d = dentro, f = fora;
        for (let i = 0; i < passos; i++) {
            const meio = d.plus(f).dividedBy(2);
            if (inteiro(meio)) d = meio; else f = meio;
        }
        return d;
    };
    let inteiroAte: Decimal | null = null;
    let inteiroDe: Decimal | null = null;
    const noChao = inteiro(chao);
    const noTeto = inteiro(teto);
    /**
     * Ha BURACO no meio? Amostra em escala geometrica entre o chao e o teto.
     *
     * Geometrica e nao linear porque a faixa cobre cinco ordens de grandeza: uma
     * grade linear de 24 pontos entre US$ 1 e US$ 1.000.000 nao olharia NENHUM
     * premio abaixo de US$ 40.000, que e onde a regiao muda de forma.
     */
    const temBuraco = (() => {
        if (!noChao || !noTeto) return false;
        const razao = teto.dividedBy(chao);
        if (!razao.isFinite() || razao.lessThanOrEqualTo(1)) return false;
        const PASSOS = 40;
        const fator = razao.pow(1 / PASSOS);
        let x = chao;
        for (let i = 0; i < PASSOS; i++) {
            x = x.mul(fator);
            if (x.greaterThanOrEqualTo(teto)) break;
            if (!inteiro(x)) return true;
        }
        return false;
    })();
    if (temBuraco) {
        // As duas pontas ficam `null` e quem fala e `inteiroTemBuraco`.
    } else if (noChao && noTeto) {
        // INTEIRO EM TODA A FAIXA. A versao anterior publicava
        // `inteiroAte = teto`, e `teto` e o TETO DA BUSCA (US$ 1.000.000) —
        // um numero que a busca nunca mediu, saindo no log como se fosse
        // fronteira. Com a gorjeta all-in de 2026-09-30 esse caso passou a ser
        // o normal para premio alto, e o log imprimiu `inteiroAte 1000000.00`:
        // teto de busca virando medicao, que e o defeito deste projeto.
        //
        // A forma certa da regiao e [chao, INFINITO), e as duas pontas dizem
        // isso sem inventar numero: `inteiroDe` no chao, `inteiroAte` nulo.
        // Assim `inteiroDe != null && inteiroAte == null` = inteiro dali para
        // cima, e as DUAS nulas = nunca inteiro. Distinguivel, que era o ponto.
        inteiroDe = chao;
    } else if (noChao) {
        // Cresce e perde a forca: o caso normal, fora do modo prova.
        inteiroAte = fronteira(chao, teto);
    } else if (noTeto) {
        // GANHA forca com o premio: o caso do kamikaze. A fronteira e onde ele
        // PASSA a sair inteiro, entao a busca anda do teto para baixo.
        inteiroDe = fronteira(teto, chao);
        inteiroAte = teto;
    }
    return { de, ate, inteiroAte, inteiroDe, inteiroTemBuraco: temBuraco };
}

/**
 * Este tiro amordacado mataria a caca de migalhas?
 *
 * Existe porque a dona do bot decidiu — e repetiu — que a estrategia e ficar
 * nas migalhas, e o codigo nao sabia disso. Ele atirava em qualquer premio que
 * passasse o piso de lucro, inclusive nos que o saldo amordaca a 5% do lance
 * pretendido. E ai esta a assimetria que importa:
 *
 *   - Na faixa das migalhas (ate US$ 11,69 com o saldo de 2026-09-27) o lance
 *     sai INTEIRO. O bot compete de igual para igual.
 *   - Num premio grande o lance sai a 2,49 gwei quando queria 50. A chance de
 *     ganhar e pequena, e UMA derrota custa US$ 4,71 — metade do gas.
 *
 * Ou seja: perseguir o premio grande com a mao amarrada arrisca a estrategia
 * que FUNCIONA em troca de uma que provavelmente nao ganha. Depois de uma
 * derrota dessas nao ha mais gas para as migalhas.
 *
 * Isto NAO e prudencia generica — o bot continua atirando com lance inteiro em
 * tudo que couber, e continua aceitando derrotas na faixa onde elas cabem. E
 * uma regra especifica: nao troco a caca que funciona por uma loteria em que
 * estou lancando 5% do que deveria.
 *
 * `atirarAmordacado` solta a trava inteira, e e assim que se muda de plano
 * quando houver gas para o lance grande. A decisao fica no ambiente, nao
 * escondida numa constante.
 */
export function mataACacaDeMigalhas(entrada: {
    amordacado: boolean;
    custoDaDerrotaWei: bigint;
    saldoWei: bigint;
    /** Fracao do saldo que uma derrota pode comer. Acima disso, a caca morre. */
    tetoDaMordida?: number;
    atirarAmordacado?: boolean;
}): { pula: boolean; porque: string } {
    if (entrada.atirarAmordacado) {
        return { pula: false, porque: 'trava solta: CACA_ATIRAR_AMORDACADO está ligado' };
    }
    if (!entrada.amordacado) {
        return { pula: false, porque: 'lance inteiro — esta é a faixa onde o saldo compete' };
    }
    if (entrada.saldoWei <= 0n) {
        return { pula: true, porque: 'sem saldo nenhum' };
    }
    const teto = entrada.tetoDaMordida ?? 0.5;
    // Comparacao em inteiros: `mordida > teto` em ponto flutuante decide
    // fronteira por arredondamento, e este arquivo ja levou esse defeito uma vez.
    const tetoEmMilionesimos = BigInt(Math.round(teto * 1_000_000));
    const mordeDemais = entrada.custoDaDerrotaWei * 1_000_000n > tetoEmMilionesimos * entrada.saldoWei;
    if (!mordeDemais) {
        return { pula: false, porque: 'amordaçado, mas uma derrota aqui não mata a caça' };
    }
    const pct = (Number(entrada.custoDaDerrotaWei) / Number(entrada.saldoWei) * 100).toFixed(0);
    return {
        pula: true,
        porque: `lance amordaçado E uma derrota comeria ${pct}% do gás (teto ${(teto * 100).toFixed(0)}%). ` +
            'Perder isto acaba com a caça de migalhas, que é a estratégia escolhida',
    };
}

/**
 * O que ESTE tiro custa se der certo, em dolar.
 *
 * Diferente de `custoDeUmaDerrota`: aqui a cacada roda inteira, entao o gas
 * consumido e o da caçada, nao o da recusa.
 */
export function custoDoTiroUsd(
    prioridadeWei: bigint,
    baseFeeWei: bigint,
    precoDoEthUsd: Decimal | null,
    gasUsado: bigint = GAS_TIPICO_DE_UMA_CACADA,
): Decimal | null {
    // Sem preco do ETH nao da para dizer quanto custa, e ZERO nao e a
    // resposta: zero desarmava o piso inteiro, e o bot atirava num lucro de
    // cinco centavos escrevendo "ACERTOU" enquanto a carteira encolhia.
    if (precoDoEthUsd === null || precoDoEthUsd.lessThanOrEqualTo(0)) return null;
    const wei = (prioridadeWei + baseFeeWei) * gasUsado;
    return new Decimal(wei.toString()).dividedBy(1e18).mul(precoDoEthUsd);
}

/**
 * Se vale a pena atirar.
 *
 * O bot nao tinha piso nenhum: a unica condicao era `lucro > 0`. Num lucro de
 * US$1 ele atiraria, pagaria mais que isso de gas e gorjeta, e o log diria
 * "ACERTOU" enquanto a carteira encolhia. Acerto que perde dinheiro e pior que
 * derrota, porque ninguem vai atras.
 *
 * A margem existe porque o lucro medido e estimativa: o preco pode andar entre
 * a medicao e a execucao, e sair no zero a zero nao paga o risco.
 */
export function valeATentativa(
    lucroUsd: Decimal | null,
    custoUsd: Decimal | null,
    margem = 2,
): { vale: boolean; porque: string } {
    if (custoUsd === null) {
        return { vale: false, porque: 'sem cotação do ETH: não dá para saber quanto o tiro custa' };
    }
    if (lucroUsd === null) {
        // Sem cotacao nao da para comparar. Atirar as cegas num alvo que pode
        // ser de US$1 e gastar para descobrir.
        return { vale: false, porque: 'sem cotação do lucro: não dá para saber se paga o gás' };
    }
    const precisa = custoUsd.mul(margem);
    if (lucroUsd.lessThanOrEqualTo(precisa)) {
        return {
            vale: false,
            porque: `lucro de US$ ${lucroUsd.toFixed(2)} não cobre ${margem}x o custo do tiro (US$ ${custoUsd.toFixed(2)})`,
        };
    }
    return { vale: true, porque: `lucro de US$ ${lucroUsd.toFixed(2)} contra custo de US$ ${custoUsd.toFixed(2)}` };
}
