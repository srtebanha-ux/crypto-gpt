/**
 * TITAN Gas Snowball — nenhum aporte adicional.
 *
 * Calcula um teto por operacao a partir do ETH NATIVO que a carteira JA TEM.
 * Nunca trata WETH no cofre como ETH disponivel para gas. Nunca dispensa
 * estimativa de gas, custo L1 ou verificacao de lucro on-chain.
 */
const BPS = 10_000n;
export interface EntradaSnowball {
    saldoWei: bigint;
    gasLimit: bigint;
    baseFeeWei: bigint;
    prioridadeDesejadaWei: bigint;
    feeL1Wei: bigint;
    lucroBrutoWei: bigint;
    tetoPorTransacaoWei: bigint;
    /** Por padrao, preserva 30% do ETH que ja existe. */
    reservaBps?: bigint;
    /** Por padrao, arrisca no maximo 20% por tentativa. */
    riscoPorTentativaBps?: bigint;
    /** No maximo 50% do lucro potencial restante vai para prioridade. */
    gorjetaDoLucroBps?: bigint;
}
export type DecisaoSnowball =
    | { aprovado: false; motivo: string; custoMaximoWei: bigint; tetoRiscoWei: bigint }
    | { aprovado: true; motivo: string; custoMaximoWei: bigint; tetoRiscoWei: bigint;
        prioridadeWei: bigint; maxFeePerGasWei: bigint; reservaWei: bigint };

function validarBps(bps: bigint, nome: string): void {
    if (bps < 0n || bps > BPS) throw new Error(nome + ' deve estar entre 0 e 10000');
}
function minimo(...valores: bigint[]): bigint {
    return valores.reduce((menor, v) => v < menor ? v : menor);
}
/**
 * O maxFee e conservador: 2x baseFee + prioridade, L1 em dobro.
 * Limita a taxa de prioridade pelo saldo *e* pelo resultado do negocio.
 * Valores sao BigInt: nao ha arredondamento por float ou conversao para BRL.
 */
export function decidirGasSnowball(e: EntradaSnowball): DecisaoSnowball {
    const reservaBps = e.reservaBps ?? 3_000n;
    const riscoBps = e.riscoPorTentativaBps ?? 2_000n;
    const gorjetaBps = e.gorjetaDoLucroBps ?? 5_000n;
    validarBps(reservaBps, 'reservaBps');
    validarBps(riscoBps, 'riscoPorTentativaBps');
    validarBps(gorjetaBps, 'gorjetaDoLucroBps');
    const vazio = { aprovado: false as const, custoMaximoWei: 0n, tetoRiscoWei: 0n };
    if (e.saldoWei <= 0n || e.gasLimit <= 0n || e.baseFeeWei <= 0n
        || e.feeL1Wei < 0n || e.prioridadeDesejadaWei <= 0n
        || e.lucroBrutoWei <= 0n || e.tetoPorTransacaoWei <= 0n) {
        return { ...vazio, motivo: 'entrada financeira ou saldo ETH invalido' };
    }
    const reservaWei = e.saldoWei * reservaBps / BPS;
    const disponivelWei = e.saldoWei - reservaWei;
    const tetoRiscoWei = minimo(disponivelWei,
        e.saldoWei * riscoBps / BPS, e.tetoPorTransacaoWei);
    const custoFixo = (2n * e.baseFeeWei * e.gasLimit) + (2n * e.feeL1Wei);
    const insuficiente = (motivo: string): DecisaoSnowball => ({
        aprovado: false, motivo, custoMaximoWei: custoFixo, tetoRiscoWei,
    });
    if (custoFixo >= tetoRiscoWei) {
        return insuficiente('custo base e L1 nao cabem no risco da carteira');
    }
    if (e.lucroBrutoWei <= custoFixo) {
        return insuficiente('lucro bruto nao cobre nem o pior custo base e L1');
    }
    const tetoTipCarteira = (tetoRiscoWei - custoFixo) / e.gasLimit;
    const ganhoAposCustoFixo = e.lucroBrutoWei - custoFixo;
    const tetoTipLucro = (ganhoAposCustoFixo * gorjetaBps / BPS) / e.gasLimit;
    // O lance cresce SOMENTE quando existe premio simulado suficiente,
    // e nunca mais de 10x a prioridade base configurada. O alvo adicional
    // consome no maximo 10% do ganho apos custo fixo; 50% e teto absoluto,
    // nao objetivo de gasto. Carteira pequena continua limitando o lance.
    const alvoPorPremio = (ganhoAposCustoFixo / 10n) / e.gasLimit;
    const alvoAutomatico = alvoPorPremio > e.prioridadeDesejadaWei
        ? minimo(alvoPorPremio, e.prioridadeDesejadaWei * 10n)
        : e.prioridadeDesejadaWei;
    const prioridadeWei = minimo(alvoAutomatico,
        tetoTipCarteira, tetoTipLucro);
    if (prioridadeWei <= 0n) {
        return insuficiente('nao ha ETH ou margem para nenhuma prioridade');
    }
    const maxFeePerGasWei = 2n * e.baseFeeWei + prioridadeWei;
    const custoMaximoWei = e.gasLimit * maxFeePerGasWei + 2n * e.feeL1Wei;
    if (custoMaximoWei > tetoRiscoWei || custoMaximoWei > e.saldoWei - reservaWei) {
        return insuficiente('lance ultrapassa o limite de risco');
    }
    return {
        aprovado: true, motivo: 'ETH atual suporta custo, reserva e margem de gorjeta',
        custoMaximoWei, tetoRiscoWei, prioridadeWei, maxFeePerGasWei, reservaWei,
    };
}
