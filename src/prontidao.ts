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
 * Gas nao usado volta para a carteira: um teto generoso nao custa nada. Um
 * teto apertado custa a transacao inteira, que morre sem gas depois de pagar.
 * Entao estimar aqui e trocar dinheiro nenhum por uma ida a rede no pior
 * momento possivel.
 */
export const LIMITE_DE_GAS = 2_000_000n;

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
    limiteGas?: bigint;
    fracaoDoLucro?: number;
    pisoWei?: bigint;
    tetoWei?: bigint;
}): bigint {
    const limite = entrada.limiteGas ?? LIMITE_DE_GAS;
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
