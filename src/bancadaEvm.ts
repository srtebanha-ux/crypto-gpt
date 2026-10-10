// Arquivo: src/bancadaEvm.ts
//
// Uma EVM de verdade para rodar contratos antes de qualquer deploy.
//
// Existia dentro de um arquivo de teste e passou a morar aqui porque um
// segundo contrato precisou dela. A licao que o comentario de `subir` guarda
// vale para os dois, e duplicar codigo duplicaria a chance de ela se perder.
import assert from 'node:assert/strict';
import { AbiCoder } from 'ethers';
import type { ContratoCompilado } from './compilarContrato';

const coder = AbiCoder.defaultAbiCoder();

/** Quem sobe e chama por padrao: vira o `dono` dos contratos. */
export const DONO_PADRAO = `0x${'aa'.repeat(20)}`;

export interface Bancada {
    dono: string;
    subir: (nome: string, tipos: string[], args: unknown[]) => Promise<string>;
    chamar: (para: string, dados: string, de?: string) => Promise<{ reverteu: boolean; retorno: string }>;
    exigir: (para: string, dados: string, de?: string) => Promise<string>;
}

export async function montarBancadaEvm(
    compilados: Record<string, ContratoCompilado>,
    dono = DONO_PADRAO,
): Promise<Bancada> {
    const { EVM } = await import('@ethereumjs/evm');
    const { hexToBytes, bytesToHex, Address } = await import('@ethereumjs/util');
    const evm = await EVM.create();

    const subir = async (nome: string, tipos: string[], args: unknown[]): Promise<string> => {
        const c = compilados[nome];
        assert.ok(c, `contrato ${nome} nao compilou`);
        const argsHex = tipos.length > 0 ? coder.encode(tipos, args).slice(2) : '';
        const r = await evm.runCall({
            data: hexToBytes(`0x${c.evm.bytecode.object}${argsHex}`),
            caller: new Address(hexToBytes(dono)),
            origin: new Address(hexToBytes(dono)),
            gasLimit: 30_000_000n,
        });
        assert.equal(r.execResult.exceptionError, undefined, `${nome} nao subiu`);
        // USAR O ENDERECO QUE A EVM CRIOU, e nao copiar o codigo para um
        // endereco escolhido.
        //
        // A primeira versao fazia a copia, e o ciclo inteiro passou a rodar sem
        // mover um centavo — sem reverter, sem erro, emitindo o evento de
        // sucesso com lucro zero. A causa: o construtor roda no endereco que a
        // EVM criou e escreve a MEMORIA la; copiar so o codigo deixa a memoria
        // para tras.
        //
        // O cacador nao sofreu porque `pool` e `cofre` sao `immutable`, e
        // imutavel mora dentro do codigo. Os dubles usam variaveis normais, e
        // chegaram do outro lado com agio zero e premio zero — um pool que
        // empresta de graca e nao paga bonus. Tudo batia, e nada acontecia.
        assert.ok(r.createdAddress, `${nome} nao devolveu endereco`);
        return r.createdAddress.toString();
    };

    const chamar = async (para: string, dados: string, de = dono) => {
        const r = await evm.runCall({
            to: new Address(hexToBytes(para)),
            caller: new Address(hexToBytes(de)),
            origin: new Address(hexToBytes(de)),
            data: hexToBytes(dados),
            gasLimit: 30_000_000n,
        });
        return {
            reverteu: r.execResult.exceptionError !== undefined,
            retorno: bytesToHex(r.execResult.returnValue),
        };
    };

    const exigir = async (para: string, dados: string, de = dono) => {
        const r = await chamar(para, dados, de);
        assert.equal(r.reverteu, false, `chamada reverteu: ${r.retorno}`);
        return r.retorno;
    };

    return { dono, subir, chamar, exigir };
}
