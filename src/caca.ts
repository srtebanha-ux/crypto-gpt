// Arquivo: src/caca.ts
import { Interface, id } from 'ethers';

// Interface do Contrato V1 (usa o endereço da pool de venda diretamente)
const cacadorV1Interface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)'
]);

// Interface do Contrato V2 (usa o booleano de pool estável/volátil)
const cacadorV2Interface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, bool isStablePool, uint256 minProfit)'
]);

/** keccak('LucroInsuficiente(uint256,uint256)') nos 4 primeiros bytes. */
export const SELETOR_LUCRO_INSUFICIENTE = id('LucroInsuficiente(uint256,uint256)').slice(0, 10);

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
        if (r.dados && r.dados !== '0x') {
            // A reversao do piso NAO e uma falha: e a medicao.
            //
            // `cacar` reverte com `LucroInsuficiente(obtido, exigido)`, e esse
            // erro CARREGA o lucro que teria saido. Mandar piso impossivel de
            // proposito faz o contrato executar a caçada inteira contra a Aave
            // de verdade e o pool de verdade, e devolver quanto renderia — sem
            // gas, sem transacao, com numero da rede.
            //
            // Sem decodificar isto, toda medicao cai em "revertido" com uma
            // mensagem generica, e o unico jeito de saber quanto uma caçada
            // rende passa a ser enviar dinheiro de verdade.
            if (r.dados.startsWith(SELETOR_LUCRO_INSUFICIENTE) && r.dados.length >= 10 + 128) {
                try {
                    const obtido = BigInt('0x' + r.dados.slice(10, 74));
                    return { desfecho: 'mediu', lucroCru: obtido };
                } catch {}
            }
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
        // Lista de devedores "zumbis" ou com posições poeira impossíveis de liquidar
        '0xf20e421cf0b314d61177466d3c9c0cb5e1342ecb',
    ]);
    return ignorados.has(devedor.toLowerCase());
}

// ---------------------------------------------------------------------------
// Conferir o cofre de um caçador ANTES de mandar ele caçar.
// ---------------------------------------------------------------------------

export const SELETOR_COFRE = id('cofre()').slice(0, 10);
export const SELETOR_DONO = id('dono()').slice(0, 10);

/**
 * Para onde o lucro TEM que ir.
 *
 * Imutável no contrato: não existe função para trocar. É o que faz uma chave
 * roubada do Railway poder queimar gás, mas nunca redirecionar dinheiro.
 */
export const COFRE_ESPERADO = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';

export type VeredictoDoCofre = 'aprovado' | 'reprovado' | 'inconclusivo';

export interface LaudoDoCofre {
    veredicto: VeredictoDoCofre;
    /** Em português, o que foi encontrado. Vai para o log e para o humano. */
    porque: string;
}

/**
 * Julga um caçador publicado pelo que ELE responde, não pelo que a gente acha.
 *
 * Existe porque conferir isso na mão, uma vez, numa tela, não é conferir: é
 * lembrar. O contrato 0xd87AeE… rodou dias mandando lucro para o dono — a
 * carteira quente cuja chave mora no Railway — e ninguém viu, porque ele nunca
 * ganhou nada. A checagem só vale se acontecer sozinha, todo boot.
 *
 * `null` nunca vira aprovação. Chamada que falhou, endereço sem código, e
 * resposta que não é endereço: tudo isso e INCONCLUSIVO, e inconclusivo não
 * caça com dinheiro real. Aprovar no escuro e o defeito que este projeto mais
 * encontrou.
 */
export function julgarCofre(
    lido: { cofre: string | null; dono: string | null },
    cofreEsperado: string = COFRE_ESPERADO,
): LaudoDoCofre {
    if (lido.cofre === null) {
        return { veredicto: 'inconclusivo', porque: 'não consegui ler cofre() — pode não ser um contrato, ou a rede falhou' };
    }
    const cofre = lido.cofre.toLowerCase();
    const esperado = cofreEsperado.toLowerCase();
    if (lido.dono !== null && cofre === lido.dono.toLowerCase()) {
        return { veredicto: 'reprovado', porque: `o cofre é o PRÓPRIO DONO (${lido.dono}) — o lucro cairia na carteira quente` };
    }
    if (cofre !== esperado) {
        return { veredicto: 'reprovado', porque: `cofre() devolveu ${lido.cofre}, e o esperado é ${cofreEsperado}` };
    }
    return { veredicto: 'aprovado', porque: `cofre() = ${cofreEsperado}` };
}

/** Só 'aprovado' pode gastar dinheiro. Inconclusivo NÃO é permissão. */
export function podeCacarComDinheiroReal(laudo: LaudoDoCofre): boolean {
    return laudo.veredicto === 'aprovado';
}
