/**
 * TITAN — executor opcional de rotas CacadorV3 na Base.
 * Sem efeitos ao importar. Nenhuma transacao sem TODOS os portoes explicitos.
 * ETH real pode ser perdido em gas mesmo com a reversao atomica.
 */
import { Interface, JsonRpcProvider, Wallet, getAddress, keccak256 } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { ORACULO_DE_GAS_L1 } from './custoDaBase';
import type { PernaMista } from './rotasMistas';

export const ABI_TITAN = new Interface([
    'function dono() view returns (address)',
    'function cofre() view returns (address)',
    'event Cacou(address indexed poolA,address indexed poolB,uint256 lucro)',
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
    lucroRealizadoWei?: string;
    custoGasL2Wei?: string;
    custoMaximoEstimadoWei?: string;
    margemMinimaWei?: string;
    lucroMinimoBrutoWei?: string;
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
    // Janela autorizada para UMA operacao, nao uma permissao permanente.
    const validade = ambiente.TITAN_OPERAR_ATE_UTC;
    const fim = validade ? Date.parse(validade) : NaN;
    if (!Number.isFinite(fim) || fim <= Date.now() || fim > Date.now() + 24 * 60 * 60 * 1000) {
        return 'janela de autorizacao expirada ou inexistente';
    }
    const marcador = ambiente.TITAN_MARCADOR_ENVIO;
    if (!marcador || !marcador.startsWith('/app/data/') || marcador.includes('..')) {
        return 'trava de envio persistente em volume nao configurada';
    }
    if (fs.existsSync(marcador)) return 'ja houve tentativa de envio para esta autorizacao';
    if (ambiente.TITAN_NONCE_EXCLUSIVO !== '1') {
        return 'sem confirmacao de nonce exclusivo: outro bot pode usar a mesma carteira';
    }
    if (!ambiente.TITAN_CONTRATO || !ambiente.TITAN_CHAVE_PRIVADA || !ambiente.TITAN_COFRE) {
        return 'contrato, chave privada ou cofre nao configurado';
    }
    const orcamento = ambiente.TITAN_ORCAMENTO_GAS_WEI;
    try {
        // Confere a politica de lucro ainda sem rede e sem chave privada.
        calcularPisoTitan(10_000n, ambiente);
    } catch {
        return 'politica de lucro invalida: TITAN_LUCRO_GAS_BPS ou TITAN_MIN_LUCRO_WEI';
    }
    if (!orcamento || !/^\d+$/.test(orcamento) || BigInt(orcamento) <= 0n) {
        return 'teto financeiro de gas em wei nao configurado';
    }
    return null;
}

/**
 * Margem minima liquida em relacao ao custo TOTAL conservador (gas L2 e L1).
 * 500 bps = 5% do gas. arredondamento para cima nunca vira zero wei.
 * Se configurada, a percentagem SUBSTITUI o piso fixo anterior.
 */
export function calcularPisoTitan(
    custoMaximoWei: bigint, ambiente: NodeJS.ProcessEnv,
): { margemWei: bigint; lucroBrutoMinimoWei: bigint; margemBps: bigint | null } {
    if (custoMaximoWei <= 0n) throw new Error('custo total de gas invalido');
    const percentual = ambiente.TITAN_LUCRO_GAS_BPS;
    if (percentual !== undefined) {
        if (!/^\d+$/.test(percentual)) throw new Error('lucro percentual invalido');
        const bps = BigInt(percentual);
        if (bps < 1n || bps > 10_000n) throw new Error('lucro percentual fora de 1 a 10000 bps');
        const margemWei = (custoMaximoWei * bps + 9_999n) / 10_000n;
        return {
            margemWei,
            lucroBrutoMinimoWei: custoMaximoWei + margemWei,
            margemBps: bps,
        };
    }
    // Compatibilidade com servicos antigos que ainda dependem de piso absoluto.
    const fixo = ambiente.TITAN_MIN_LUCRO_WEI;
    if (!fixo || !/^\d+$/.test(fixo) || BigInt(fixo) <= 0n) {
        throw new Error('piso de lucro em wei nao configurado');
    }
    return {
        margemWei: BigInt(fixo),
        lucroBrutoMinimoWei: custoMaximoWei + BigInt(fixo),
        margemBps: null,
    };
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
        const chainIdReal = BigInt(await rpc.send('eth_chainId', []));
        if (chainIdReal !== REDE_BASE) throw new Error('RPC nao aponta para Base chainId 8453');
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
        // A triagem pode ter custado varios blocos. Isto NAO autoriza enviar
        // com cotacao velha: as proximas duas eth_call simulam novamente a
        // rota completa no estado latest do contrato IMPLANTADO.
        // O limite de 60 blocos impede gatilhos obsoletos de horas atras.
        const defasagem = ultimo.number - plano.bloco;
        if (defasagem < 0 || defasagem > 60) {
            throw new Error('sinal de bloco muito antigo ou no futuro');
        }
        const gorjeta = BigInt(ambiente.TITAN_GORJETA_WEI ?? '20000000');
        if (gorjeta <= 0n) throw new Error('gorjeta invalida');
        const maxFeePerGas = 2n * ultimo.baseFeePerGas + gorjeta;
        const nonce = await rpc.getTransactionCount(carteira.address, 'pending');
        const nonceConfirmado = await rpc.getTransactionCount(carteira.address, 'latest');
        if (nonce !== nonceConfirmado) throw new Error('existe transacao pendente nesta carteira');
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
        if ((await rpc.getBalance(carteira.address)) < custoMaximo) {
            return { estado: 'recusado', motivo: 'ETH insuficiente para cobrir o teto total de gas' };
        }
        if (custoMaximo > BigInt(ambiente.TITAN_ORCAMENTO_GAS_WEI!)) {
            return { estado: 'recusado', motivo: 'custo maximo excede orcamento por transacao' };
        }
        const politica = calcularPisoTitan(custoMaximo, ambiente);
        const piso = politica.lucroBrutoMinimoWei;
        if (brutoReal < piso) {
            return { estado: 'recusado', motivo: 'lucro simulado insuficiente depois do custo conservador e margem minima',
                lucroSimuladoWei: brutoReal.toString(),
                custoMaximoEstimadoWei: custoMaximo.toString(),
                margemMinimaWei: politica.margemWei.toString(),
                lucroMinimoBrutoWei: piso.toString() };
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
        // Validade tambem e conferida imediatamente ANTES da assinatura.
        // Um preflight muito demorado nao amplia a autorizacao.
        const ateUtc = Date.parse(ambiente.TITAN_OPERAR_ATE_UTC ?? '');
        if (!Number.isFinite(ateUtc) || Date.now() >= ateUtc) {
            return { estado: 'recusado', motivo: 'autorizacao expirou durante o preflight' };
        }
        // Assina UMA transacao concreta e grava seu hash DETERMINISTICO
        // ANTES de transmitir. Se o RPC receber e der timeout/403 depois,
        // o hash continua recuperavel sem reenviar e sem adivinhar nonce.
        const assinadaFinal = await carteira.signTransaction({
            chainId: Number(REDE_BASE), type: 2, nonce, to: contrato,
            data: dados, gasLimit: limite, maxFeePerGas, maxPriorityFeePerGas: gorjeta,
            value: 0n,
        });
        const hashAssinado = keccak256(assinadaFinal);
        const marcador = ambiente.TITAN_MARCADOR_ENVIO!;
        fs.mkdirSync(path.dirname(marcador), { recursive: true });
        const fd = fs.openSync(marcador, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify({ estado: 'pronta_para_envio',
                hash: hashAssinado, autorizacaoAte: ambiente.TITAN_OPERAR_ATE_UTC,
                carteira: carteira.address, nonce,
                tetoGasWei: ambiente.TITAN_ORCAMENTO_GAS_WEI,
                criadoEm: new Date().toISOString() }));
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        hash = hashAssinado;
        const tx = await rpc.broadcastTransaction(assinadaFinal);
        if (tx.hash.toLowerCase() !== hash.toLowerCase()) {
            throw new Error('RPC devolveu hash diferente da transacao assinada');
        }
        fs.writeFileSync(marcador, JSON.stringify({
            estado: 'enviado', hash, nonce, enviadoEm: new Date().toISOString(),
        }), { mode: 0o600 });
        const recibo = await tx.wait(1, 60000);
        if (!recibo) return { estado: 'enviado', hash, motivo: 'transacao enviada; recibo nao chegou' };
        const evento = recibo.logs.filter((x) => getAddress(x.address) === contrato)
            .map((x) => { try { return ABI_TITAN.parseLog(x); } catch { return null; } })
            .find((x) => x?.name === 'Cacou');
        const lucroRealizado = recibo.status === 1 && evento
            ? (evento.args[2] as bigint).toString() : undefined;
        fs.writeFileSync(ambiente.TITAN_MARCADOR_ENVIO!, JSON.stringify({
            estado: recibo.status === 1 ? 'confirmado' : 'revertido', hash,
            gasUsado: recibo.gasUsed.toString(),
            lucroRealizadoWei: lucroRealizado ?? null,
            confirmadoEm: new Date().toISOString(),
        }), { mode: 0o600 });
        return {
            estado: recibo.status === 1 ? 'confirmado' : 'revertido', hash,
            gasUsado: recibo.gasUsed.toString(),
            custoGasL2Wei: (recibo.gasUsed * recibo.gasPrice).toString(),
            lucroRealizadoWei: lucroRealizado,
            lucroSimuladoWei: confirmado.toString(),
            custoMaximoEstimadoWei: custoMaximo.toString(),
            margemMinimaWei: politica.margemWei.toString(),
            lucroMinimoBrutoWei: piso.toString(),
            motivo: recibo.status === 1
                ? 'incluida; lucro observado no evento Cacou, custo L1 verificar no recibo'
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
