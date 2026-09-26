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
 */
export const LIMITE_DE_GAS = BigInt(process.env.CACA_LIMITE_GAS ?? '1200000');

/**
 * O gas que uma cacada REALMENTE usa.
 *
 * Diferente do teto. A gorjeta e dividida por este numero, nao pelo limite:
 * dividir pelo teto de 2M quando a transacao usa ~700k faz o lance efetivo
 * virar 14% do lucro quando o log diz 40% — o bot pagaria menos do que decidiu
 * pagar, e perderia leiloes achando que estava competindo.
 */
export const GAS_TIPICO_DE_UMA_CACADA = 700_000n;

/** Nunca ofereca menos que isso, ou a transacao pode nem ser considerada. */
export const PISO_DA_GORJETA_WEI = 100_000_000n; // 0,1 gwei
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
 * A Aave recusa cedo, mas nao de graca: o emprestimo relampago abre, a
 * verificacao de saude falha e tudo desfaz — e o gas gasto ate ali e cobrado.
 * Estimativa conservadora; errar para mais aqui so deixa o freio mais seguro.
 */
export const GAS_DE_UMA_REVERSAO = 150_000n;

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
 * O que ESTE tiro custa se der certo, em dolar.
 *
 * Diferente de `custoDeUmaDerrota`: aqui a cacada roda inteira, entao o gas
 * consumido e o da caçada, nao o da recusa.
 */
export function custoDoTiroUsd(
    prioridadeWei: bigint,
    baseFeeWei: bigint,
    precoDoEthUsd: Decimal,
    gasUsado: bigint = GAS_TIPICO_DE_UMA_CACADA,
): Decimal {
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
    custoUsd: Decimal,
    margem = 2,
): { vale: boolean; porque: string } {
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
