/**
 * TITAN — executor opcional de rotas CacadorV3 na Base.
 * Sem efeitos ao importar. Nenhuma transacao sem TODOS os portoes explicitos.
 * ETH real pode ser perdido em gas mesmo com a reversao atomica.
 */
import { Interface, JsonRpcProvider, Transaction, Wallet, getAddress } from 'ethers';
import { ORACULO_DE_GAS_L1 } from './custoDaBase';
import type { PernaMista } from './rotasMistas';

export const ABI_TITAN = new Interface([
    'function dono() view returns (address)',
    'function cofre() view returns (address)',
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota,uint256 quantia,uint256 lucroMinimo) returns (uint256 lucro)',
]);
const ABI_ORACULO = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
const REDE_BASE = 8453n;

export interface PlanoTitan {
    rota: PernaMista[];
    quantia: bigint;
    bloco: number;
    /** Cotacao no mesmo estado, antes da confirmacao por eth_call do executor. */
    brutoEstimado: bigint;
    liquidoEstimado: bigint;
    /** A releitura de todos os pools confirmou o estado da cotacao. */
    estadoConsistente: boolean;
}
export interface ResultadoTitan {
    estado: 'desligado' | 'recusado' | 'enviado' | 'confirmado' | 'revertido' | 'desconhecido';
    motivo: string;
    hash?: string;
    gasUsado?: string;
    lucroSimuladoWei?: string;
}

/** Este teste e puro: nao precisa de chave, internet ou contrato. */
export function motivoDaRecusaTitan(p: PlanoTitan, ambiente: NodeJS.ProcessEnv): string | null {
    if (!p.estadoConsistente) return 'estado dos pools nao confirmado';
    if (!Number.isInteger(p.bloco) || p.bloco <= 0) return 'bloco ausente';
    if (p.rota.length < 2 || p.rota.length > 4) return 'o contrato aceita apenas 2 a 4 pernas';
    if (p.quantia <= 0n || p.brutoEstimado <= 0n || p.liquidoEstimado <= 0n) {
        return 'cotacao sem lucro liquido positivo';
    }
    for (const perna of p.rota) {
        if (perna.tipo !== 0 && perna.tipo !== 1) return 'protocolo nao executavel neste contrato';
        if (!/^0x[0-9a-fA-F]{40}$/.test(perna.pool)
            || !/^0x[0-9a-fA-F]{40}$/.test(perna.tokenEntra)) {
            return 'endereco de pool ou token invalido';
        }
        if (perna.pagamento < 0n) return 'pagamento negativo';
    }
    if (ambiente.TITAN_ENVIAR !== '1'
        || ambiente.TITAN_CONFIRMAR !== 'OPERAR_BASE_REAL') {
        return 'envio real desligado (TITAN_ENVIAR e TITAN_CONFIRMAR)';
    }
    if (ambiente.TITAN_NONCE_EXCLUSIVO !== '1') {
        return 'sem confirmacao de nonce exclusivo: outro bot pode usar a mesma carteira';
    }
    if (!ambiente.TITAN_CONTRATO || !ambiente.TITAN_CHAVE_PRIVADA || !ambiente.TITAN_COFRE) {
        return 'contrato, chave privada ou cofre nao configurado';
    }
    const piso = ambiente.TITAN_MIN_LUCRO_WEI;
    const orcamento = ambiente.TITAN_ORCAMENTO_GAS_WEI;
    if (!piso || !/^\d+$/.test(piso) || BigInt(piso) <= 0n) return 'piso de lucro em wei nao configurado';
    if (!orcamento || !/^\d+$/.test(orcamento) || BigInt(orcamento) <= 0n) {
        return 'teto financeiro de gas em wei nao configurado';
    }
    return null;
}

function hexDeResultado(data: string, fn: Interface, nome: string): bigint {
    const retorno = fn.decodeFunctionResult(nome, data);
    return retorno[0] as bigint;
}

/**
 * Uma tentativa por chamada; a integracao no cacador usa bloqueio de sessao.
 * Revalida o mesmo calldata no contrato IMPLANTADO, nao no endereco de override.
 * O envio usa nonce pendente explicito; ainda exige exclusividade entre servicos.
 */
export async function executarTitan(
    plano: PlanoTitan, rpcUrl: string, ambiente: NodeJS.ProcessEnv = process.env,
): Promise<ResultadoTitan> {
    const recusa = motivoDaRecusaTitan(plano, ambiente);
    if (recusa) return { estado: ambiente.TITAN_ENVIAR === '1' ? 'recusado' : 'desligado', motivo: recusa };

    let contrato: string;
    let cofre: string;
    let carteira: Wallet;
    try {
        contrato = getAddress(ambiente.TITAN_CONTRATO!);
        cofre = getAddress(ambiente.TITAN_COFRE!);
        carteira = new Wallet(ambiente.TITAN_CHAVE_PRIVADA!);
    } catch {
        return { estado: 'recusado', motivo: 'chave, contrato ou cofre invalidos' };
    }
    const rpc = new JsonRpcProvider(rpcUrl, Number(REDE_BASE), { staticNetwork: true });
    let hash: string | undefined;
    try {
        const rede = await rpc.getNetwork();
        if (rede.chainId !== REDE_BASE) throw new Error('RPC nao aponta para Base chainId 8453');
        if ((await rpc.getCode(contrato)) === '0x') throw new Error('contrato nao implantado');
        const donoHex = ABI_TITAN.decodeFunctionResult('dono',
            await rpc.call({ to: contrato, data: ABI_TITAN.encodeFunctionData('dono') }))[0] as string;
        const cofreHex = ABI_TITAN.decodeFunctionResult('cofre',
            await rpc.call({ to: contrato, data: ABI_TITAN.encodeFunctionData('cofre') }))[0] as string;
        if (getAddress(donoHex) !== carteira.address) throw new Error('carteira nao e dona do executor');
        if (getAddress(cofreHex) !== cofre) throw new Error('cofre imutavel do contrato diverge');

        const ultimo = await rpc.getBlock('latest');
        if (!ultimo || ultimo.baseFeePerGas === null || ultimo.baseFeePerGas <= 0n) {
            throw new Error('baseFee da rede desconhecido');
        }
        if (ultimo.number - plano.bloco > 1) throw new Error('cotacao de bloco antigo');
        const gorjeta = BigInt(ambiente.TITAN_GORJETA_WEI ?? '20000000');
        if (gorjeta <= 0n) throw new Error('gorjeta invalida');
        const maxFeePerGas = 2n * ultimo.baseFeePerGas + gorjeta;
        const nonce = await rpc.getTransactionCount(carteira.address, 'pending');
        const semPiso = ABI_TITAN.encodeFunctionData('executarRota', [
            plano.rota, plano.quantia, 0n,
        ]);
        const respostaSimulada = await rpc.call({
            from: carteira.address, to: contrato, data: semPiso,
        });
        const brutoReal = hexDeResultado(respostaSimulada, ABI_TITAN, 'executarRota');
        if (brutoReal <= 0n) return { estado: 'recusado', motivo: 'ensaio completo sem sobra positiva' };

        const gasEstimado = await rpc.estimateGas({
            from: carteira.address, to: contrato, data: semPiso,
        });
        const tetoGas = BigInt(ambiente.TITAN_GAS_MAX ?? '650000');
        if (gasEstimado <= 0n || gasEstimado > tetoGas) {
            throw new Error('estimativa de gas maior que teto permitido');
        }
        const limite = gasEstimado + gasEstimado / 5n;
        if (limite > tetoGas) throw new Error('margem de gas ultrapassou o teto');

        // Oracle OP Stack: envia a transacao SERIALIZADA, nao so o calldata.
        const simuladaAssinada = await carteira.signTransaction({
            chainId: Number(REDE_BASE), type: 2, nonce, to: contrato,
            data: semPiso, value: 0n, gasLimit: limite, maxFeePerGas,
            maxPriorityFeePerGas: gorjeta,
        });
        const dataOraculo = ABI_ORACULO.encodeFunctionData('getL1Fee', [simuladaAssinada]);
        const feeL1 = hexDeResultado(
            await rpc.call({ to: ORACULO_DE_GAS_L1, data: dataOraculo }),
            ABI_ORACULO, 'getL1Fee',
        );
        // O lucro minimo cobre o PIOR preco L2 permitido, L1 conservador e piso adicional.
        const custoMaximo = limite * maxFeePerGas + feeL1 * 2n;
        if (custoMaximo > BigInt(ambiente.TITAN_ORCAMENTO_GAS_WEI!)) {
            return { estado: 'recusado', motivo: 'custo maximo excede orcamento por transacao' };
        }
        const piso = custoMaximo + BigInt(ambiente.TITAN_MIN_LUCRO_WEI!);
        if (brutoReal <= piso) {
            return { estado: 'recusado', motivo: 'lucro simulado insuficiente depois do custo conservador',
                lucroSimuladoWei: brutoReal.toString() };
        }
        const dados = ABI_TITAN.encodeFunctionData('executarRota', [
            plano.rota, plano.quantia, piso,
        ]);
        // Segundo ensaio, agora com o piso REAL no contrato. Sem sucesso, nao envia.
        const confirmado = hexDeResultado(await rpc.call({
            from: carteira.address, to: contrato, data: dados,
        }), ABI_TITAN, 'executarRota');
        if (confirmado < piso) throw new Error('o ensaio final nao alcancou o piso');
        // Verificacao uma ultima vez do nonce antes de assinar: nao e lock entre bots.
        if ((await rpc.getTransactionCount(carteira.address, 'pending')) !== nonce) {
            throw new Error('nonce foi usado por outro processo; envio cancelado');
        }
        const assinante = carteira.connect(rpc);
        const tx = await assinante.sendTransaction({
            chainId: Number(REDE_BASE), type: 2, nonce, to: contrato,
            data: dados, gasLimit: limite, maxFeePerGas, maxPriorityFeePerGas: gorjeta,
            value: 0n,
        });
        hash = tx.hash;
        const recibo = await tx.wait(1, 60000);
        if (!recibo) return { estado: 'enviado', hash, motivo: 'transacao enviada; recibo nao chegou' };
        return {
            estado: recibo.status === 1 ? 'confirmado' : 'revertido', hash,
            gasUsado: recibo.gasUsed.toString(),
            lucroSimuladoWei: confirmado.toString(),
            motivo: recibo.status === 1 ? 'incluida; conferir evento Cacou e delta no cofre'
                : 'transacao reverteu; gas real foi consumido',
        };
    } catch (e) {
        return { estado: hash ? 'desconhecido' : 'recusado', hash,
            motivo: hash ? 'hash transmitido; consultar recibo, NAO reenviar'
                : (e instanceof Error ? e.message.slice(0, 240) : 'erro desconhecido') };
    } finally {
        rpc.destroy();
    }
}
