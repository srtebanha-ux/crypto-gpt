// Arquivo: src/caca.ts
import { Interface } from 'ethers';

// Interface do Contrato V1 (usa o endereço da pool de venda diretamente)
const cacadorV1Interface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)'
]);

// Interface do Contrato V2 (usa o booleano de pool estável/volátil)
const cacadorV2Interface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, bool isStablePool, uint256 minProfit)'
]);

export const PISO_IMPOSSIVEL = 99999999999999999999999999999999999999999999n;
export const COBRIR_O_MAXIMO = PISO_IMPOSSIVEL; 

export function codificarCacaV1(alvo: {
    garantia: string;
    divida: string;
    devedor: string;
    quantoCobrir: bigint;
    poolDeVenda: string;
    lucroMinimo: bigint;
}): string {
    return cacadorV1Interface.encodeFunctionData('cacar', [
        alvo.garantia,
        alvo.divida,
        alvo.devedor,
        alvo.quantoCobrir,
        alvo.poolDeVenda,
        alvo.lucroMinimo,
    ]);
}

export function codificarCacaV2(alvo: {
    garantia: string;
    divida: string;
    devedor: string;
    quantoCobrir: bigint;
    isStablePool: boolean;
    lucroMinimo: bigint;
}): string {
    return cacadorV2Interface.encodeFunctionData('cacar', [
        alvo.garantia,
        alvo.divida,
        alvo.devedor,
        alvo.quantoCobrir,
        alvo.isStablePool,
        alvo.lucroMinimo,
    ]);
}

export function lerRespostaDaCaca(r: { ok: boolean; dados: string; mensagem?: string }): {
    desfecho: 'mediu' | 'revertido' | 'falhaDeRede';
    lucroCru?: bigint;
    erro?: string;
} {
    if (!r.ok) {
        if (r.dados && r.dados !== ' పాత్ర') {
            try {
                if (r.dados.startsWith('0x08c379a0')) {
                    const decoded = '0x' + r.dados.substring(138);
                    const motivo = Buffer.from(decoded.replace(/^0x/, ''), 'hex').toString('utf8').replace(/\0/g, '').trim();
                    return { desfecho: 'revertido', erro: motivo || 'revertido sem mensagem' };
                }
            } catch {}
            return { desfecho: 'revertido', erro: r.mensagem ?? 'revertido' };
        }
        return { desfecho: 'falhaDeRede', erro: r.mensagem ?? 'erro de rede' };
    }

    try {
        if (r.dados === '0x' || r.dados.length < 130) {
            return { desfecho: 'mediu', lucroCru: 0n };
        }
        const valor = BigInt('0x' + r.dados.slice(2));
        return { desfecho: 'mediu', lucroCru: valor };
    } catch {
        return { desfecho: 'mediu', lucroCru: 0n };
    }
}

export function isDevedorIgnorado(devedor: string): boolean {
    const ignorados = new Set<string>([
        // adicione aqui se houver algum devedor irrelevante conhecido
    ]);
    return ignorados.has(devedor.toLowerCase());
}
