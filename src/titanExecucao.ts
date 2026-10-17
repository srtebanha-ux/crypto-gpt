/**
 * TITAN — executor opcional de rotas CacadorV3 na Base.
 * Sem efeitos ao importar. Nenhuma transacao sem TODOS os portoes explicitos.
 * ETH real pode ser perdido em gas mesmo com a reversao atomica.
 */
import { Interface, JsonRpcProvider, Wallet, getAddress, keccak256 } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { ORACULO_DE_GAS_L1, codificarTetoDeL1 } from './custoDaBase';
import { conferirJanelaDeNonce } from './janelaDeNonce';
import { decidirGasSnowball } from './titanGasSnowball';
import { reinvestirLucroTitan, type ReinvestimentoTitan } from './titanReinvestimento';
import { diagnosticarReversaoTitan } from './titanTaticas';
import {
    impedimentoTitanContinuo, parametrosTitanContinuo,
    reservarTitanContinuo, fecharTitanContinuo,
} from './titanAutorizacaoContinua';
import type { PernaMista } from './rotasMistas';

export const ABI_TITAN = new Interface([
    'function dono() view returns (address)',
    'function cofre() view returns (address)',
    'function morpho() view returns (address)',
    'event Cacou(address indexed poolA,address indexed poolB,uint256 lucro)',
    'event CacouMorpho(address indexed poolA,address indexed poolB,uint256 lucro)',
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota,uint256 quantia,uint256 lucroMinimo) returns (uint256 lucro)',
]);
const ABI_ORACULO = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
const REDE_BASE = 8453n;
// Endereco confirmado pela governanca Morpho para Base.
// Um contrato com outro endereco NAO fica habilitado automaticamente.
export const MORPHO_BASE_OFICIAL = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
export const WETH_BASE_TITAN = '0x4200000000000000000000000000000000000006';

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
    reinvestimento?: ReinvestimentoTitan;
}

/** Este teste e puro: nao precisa de chave, internet ou contrato. */
export function motivoDaRecusaTitan(p: PlanoTitan, ambiente: NodeJS.ProcessEnv): string | null {
    if (!p.estadoConsistente) return 'estado dos pools nao confirmado';
    if (!Number.isInteger(p.bloco) || p.bloco <= 0) return 'bloco ausente';
    if (ambiente.TITAN_GAS_SNOWBALL === '1'
        && p.rota[0]?.tokenEntra.toLowerCase() !== WETH_BASE_TITAN.toLowerCase()) {
        return 'snowball exige lucro em WETH; nao comparar token arbitrario com gas em ETH';
    }
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
    const continuo = ambiente.TITAN_AUTORIZACAO_CONTINUA === '1';
    if (continuo) {
        try {
            parametrosTitanContinuo(ambiente);
            const bloqueio = impedimentoTitanContinuo(ambiente, 0n);
            if (bloqueio) return bloqueio;
        } catch (e) {
            return 'controle duravel da autorizacao continua indisponivel: '
                + (e instanceof Error ? e.message.slice(0, 120) : 'falha');
        }
    } else {
        // Compatibilidade com a unica operacao autorizada temporariamente.
        const validade = ambiente.TITAN_OPERAR_ATE_UTC;
        const fim = validade ? Date.parse(validade) : NaN;
        if (!Number.isFinite(fim) || fim <= Date.now()
            || fim > Date.now() + 24 * 60 * 60 * 1000) {
            return 'janela de autorizacao expirada ou inexistente';
        }
        const marcador = ambiente.TITAN_MARCADOR_ENVIO;
        if (!marcador || !marcador.startsWith('/app/data/')
            || marcador.includes('..')) {
            return 'trava de envio persistente em volume nao configurada';
        }
        if (fs.existsSync(marcador)) return 'ja houve tentativa de envio para esta autorizacao';
    }
    // Operador unico: remove somente a restricao de horario.
    // Nonce pendente, saude de RPC e propriedade do contrato seguem obrigatorios.
    const somenteTitan = ambiente.TITAN_SOLO_24H === '1';
    if (!somenteTitan && ambiente.TITAN_JANELAS_EXCLUSIVAS !== '1') {
        return 'TITAN exige janela exclusiva Base compartilhada com CACA';
    }
    if (ambiente.TITAN_NONCE_EXCLUSIVO !== '1') {
        return 'sem confirmacao de nonce exclusivo: outro bot pode usar a mesma carteira';
    }
    const fonte = ambiente.TITAN_FONTE_CREDITO ?? 'flashswap';
    if (fonte !== 'flashswap' && fonte !== 'morpho') {
        return 'fonte de credito nao reconhecida';
    }
    if (fonte === 'morpho') {
        if (!ambiente.TITAN_CONTRATO_MORPHO) return 'contrato Morpho da arbitragem nao implantado';
        if (p.rota[0]?.tokenEntra.toLowerCase() !== WETH_BASE_TITAN.toLowerCase()) {
            return 'emprestimo Morpho requer base WETH para contabilizar gas';
        }
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
        contrato = getAddress(ambiente.TITAN_FONTE_CREDITO === 'morpho'
            ? ambiente.TITAN_CONTRATO_MORPHO!
            : ambiente.TITAN_CONTRATO!);
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
        if (ambiente.TITAN_FONTE_CREDITO === 'morpho') {
            const morpho = ABI_TITAN.decodeFunctionResult('morpho',
                await rpc.call({ to: contrato, data: ABI_TITAN.encodeFunctionData('morpho') }))[0] as string;
            if (getAddress(morpho) !== getAddress(MORPHO_BASE_OFICIAL)) {
                throw new Error('fonte Morpho nao corresponde ao singleton Base verificado');
            }
        }

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
        let gorjeta = BigInt(ambiente.TITAN_GORJETA_WEI ?? '20000000');
        if (gorjeta <= 0n) throw new Error('gorjeta invalida');
        let maxFeePerGas = 2n * ultimo.baseFeePerGas + gorjeta;
        const janelaPreflight=await conferirJanelaDeNonce(rpc,carteira.address,ambiente.TITAN_SOLO_24H === '1' ? 'TITAN_SOLO' : 'TITAN');
        if(!janelaPreflight.pode)
            return{estado:'recusado',motivo:'janela TITAN fechada: '+janelaPreflight.motivo};
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
        let custoMaximo = limite * maxFeePerGas + feeL1 * 2n;
        if (ambiente.TITAN_GAS_SNOWBALL === '1') {
            const saldoAtual = await rpc.getBalance(carteira.address);
            const snowball = decidirGasSnowball({
                saldoWei: saldoAtual,
                gasLimit: limite,
                baseFeeWei: ultimo.baseFeePerGas,
                prioridadeDesejadaWei: gorjeta,
                feeL1Wei: feeL1,
                lucroBrutoWei: brutoReal,
                tetoPorTransacaoWei: BigInt(ambiente.TITAN_ORCAMENTO_GAS_WEI!),
                reservaBps: BigInt(ambiente.TITAN_SNOWBALL_RESERVA_BPS ?? '3000'),
                riscoPorTentativaBps: BigInt(ambiente.TITAN_SNOWBALL_RISCO_BPS ?? '2000'),
                gorjetaDoLucroBps: BigInt(ambiente.TITAN_SNOWBALL_GORJETA_LUCRO_BPS ?? '5000'),
            });
            if (!snowball.aprovado) {
                return { estado: 'recusado', motivo: '[SNOWBALL] ' + snowball.motivo,
                    custoMaximoEstimadoWei: snowball.custoMaximoWei.toString() };
            }
            // O teto de taxa sai do saldo ETH REAL, nao do lucro ainda em WETH.
            gorjeta = snowball.prioridadeWei;
            maxFeePerGas = snowball.maxFeePerGasWei;
            custoMaximo = snowball.custoMaximoWei;
        }
        if ((await rpc.getBalance(carteira.address)) < custoMaximo) {
            return { estado: 'recusado', motivo: 'ETH insuficiente para cobrir o teto total de gas' };
        }
        if (custoMaximo > BigInt(ambiente.TITAN_ORCAMENTO_GAS_WEI!)) {
            return { estado: 'recusado', motivo: 'custo maximo excede orcamento por transacao' };
        }
        if (ambiente.TITAN_AUTORIZACAO_CONTINUA === '1') {
            // A reserva so ocorre depois do segundo ensaio e de assinar a tx,
            // mas ja recusamos cedo quando o orcamento de hoje nao suporta.
            const limite = impedimentoTitanContinuo(ambiente, custoMaximo);
            if (limite) return { estado: 'recusado', motivo: limite };
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
        // Ultima janela de mercado: se um bloco novo aparecer DURANTE
        // o ensaio final, o sinal pode ter mudado. Nao arrisca gastar gas.
        const instanteFinal = Date.now();
        const blocoDoEnsaio = await rpc.getBlockNumber();
        const confirmado = hexDeResultado(await rpc.call({
            from: carteira.address, to: contrato, data: dados,
        }), ABI_TITAN, 'executarRota');
        if (confirmado < piso) throw new Error('o ensaio final nao alcancou o piso');
        const blocoDepoisDoEnsaio = await rpc.getBlockNumber();
        if (blocoDepoisDoEnsaio !== blocoDoEnsaio
            || Date.now() - instanteFinal > 1_800) {
            return { estado: 'recusado',
                motivo: 'ensaio final envelheceu: bloco mudou ou consulta demorou demais',
                lucroSimuladoWei: confirmado.toString() };
        }
        // Verificacao uma ultima vez do nonce antes de assinar: nao e lock entre bots.
        if ((await rpc.getTransactionCount(carteira.address, 'pending')) !== nonce) {
            throw new Error('nonce foi usado por outro processo; envio cancelado');
        }
        // No modo temporario o prazo tambem e verificado antes do envio.
        // No continuo NAO existe expiracao; existe limite de gas DIARIO.
        const continuo = ambiente.TITAN_AUTORIZACAO_CONTINUA === '1';
        if (!continuo) {
            const ateUtc = Date.parse(ambiente.TITAN_OPERAR_ATE_UTC ?? '');
            if (!Number.isFinite(ateUtc) || Date.now() >= ateUtc) {
                return { estado: 'recusado', motivo: 'autorizacao expirou durante o preflight' };
            }
        }
        // A simulacao pode atravessar a janela; conferir de novo ANTES da
        // reserva duravel/assinatura para nunca concorrer com o CACA.
        const janelaNoEnvio=await conferirJanelaDeNonce(rpc,carteira.address,ambiente.TITAN_SOLO_24H === '1' ? 'TITAN_SOLO' : 'TITAN');
        if(!janelaNoEnvio.pode || janelaNoEnvio.nonce!==nonce)
            return{estado:'recusado',motivo:'exclusividade/nonce mudou no pre-broadcast: '+
                janelaNoEnvio.motivo};
        // Assina UMA transacao concreta e grava seu hash DETERMINISTICO
        // ANTES de transmitir. Se o RPC receber e der timeout/403 depois,
        // o hash continua recuperavel sem reenviar e sem adivinhar nonce.
        const assinadaFinal = await carteira.signTransaction({
            chainId: Number(REDE_BASE), type: 2, nonce, to: contrato,
            data: dados, gasLimit: limite, maxFeePerGas, maxPriorityFeePerGas: gorjeta,
            value: 0n,
        });
        const hashAssinado = keccak256(assinadaFinal);
        if (continuo) {
            // Uma reserva do diario somente por hash, em volume persistente.
            // Falha/crash antes do recibo bloqueia TODOS os envios seguintes.
            reservarTitanContinuo(ambiente, hashAssinado, custoMaximo);
        } else {
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
        }
        hash = hashAssinado;
        const tx = await rpc.broadcastTransaction(assinadaFinal);
        if (tx.hash.toLowerCase() !== hash.toLowerCase()) {
            throw new Error('RPC devolveu hash diferente da transacao assinada');
        }
        if (!continuo) {
            fs.writeFileSync(ambiente.TITAN_MARCADOR_ENVIO!, JSON.stringify({
                estado: 'enviado', hash, nonce, enviadoEm: new Date().toISOString(),
            }), { mode: 0o600 });
        }
        const recibo = await tx.wait(1, 60000);
        if (!recibo) return { estado: 'enviado', hash, motivo: 'transacao enviada; recibo nao chegou' };
        const evento = recibo.logs.filter((x) => getAddress(x.address) === contrato)
            .map((x) => { try { return ABI_TITAN.parseLog(x); } catch { return null; } })
            .find((x) => x?.name === (ambiente.TITAN_FONTE_CREDITO === 'morpho'
                ? 'CacouMorpho' : 'Cacou'));
        const lucroRealizado = recibo.status === 1 && evento
            ? (evento.args[2] as bigint).toString() : undefined;
        if (continuo) {
            fecharTitanContinuo(ambiente, hash, recibo.status === 1
                ? 'confirmado' : 'revertido', recibo.gasUsed * recibo.gasPrice,
            lucroRealizado === undefined ? undefined : BigInt(lucroRealizado));
        } else {
            fs.writeFileSync(ambiente.TITAN_MARCADOR_ENVIO!, JSON.stringify({
                estado: recibo.status === 1 ? 'confirmado' : 'revertido', hash,
                gasUsado: recibo.gasUsed.toString(),
                lucroRealizadoWei: lucroRealizado ?? null,
                confirmadoEm: new Date().toISOString(),
            }), { mode: 0o600 });
        }
        // Reinvestir somente o lucro PROVADO no evento; WETH de outro cofre
        // jamais e movimentado. Falha de unwrap nao muda o status da arbitragem.
        const reinvestimento = recibo.status === 1 && lucroRealizado !== undefined
            ? await reinvestirLucroTitan(rpc, carteira, cofre,
                BigInt(lucroRealizado), hash!, ambiente)
            : undefined;
        return {
            estado: recibo.status === 1 ? 'confirmado' : 'revertido', hash,
            reinvestimento,
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

/**
 * Valida o EXECUTOR REAL da Base sem assinar nem transmitir.
 * Diferente de uma cotacao de rotas, o eth_call executa TODAS as pernas,
 * o flash loan/callback e o pagamento final na EVM atual.
 * Nenhuma oportunidade e marcada como lucro realizado aqui.
 */
export type EnsaioAtomicoTitan = {
    situacao:'executavel'|'inviavel'|'desconhecido';
    motivo:string; bloco:number|null; brutoWei?:string; custoMaximoWei?:string;
    margemMinimaWei?:string; liquidoConservadorWei?:string;
    gasEstimado?:string; gasLimite?:string; contrato?:string;
    erroContrato?:'pagamento-curto'|'lucro-insuficiente';
    deficitUnidades?:string; deficitBps?:string;
};

export function avaliarEnsaioTitan(
    bruto:bigint,gasEstimado:bigint,baseFee:bigint,gorjeta:bigint,
    l1Upper:bigint,gasMax:bigint,orcamento:bigint,ambiente:NodeJS.ProcessEnv,
):Omit<EnsaioAtomicoTitan,'bloco'|'contrato'>{
    if(bruto<=0n || gasEstimado<=0n || baseFee<=0n || gorjeta<=0n
        || l1Upper<=0n || gasMax<=0n || orcamento<=0n)
        return {situacao:'desconhecido',motivo:'gas/preco/custo L1 ou retorno desconhecidos'};
    const limite=gasEstimado+gasEstimado/5n;
    if(limite>gasMax)return {situacao:'inviavel',motivo:'gas + 20% excede teto do contrato',
        brutoWei:bruto.toString(),gasEstimado:gasEstimado.toString(),gasLimite:limite.toString()};
    const custo=limite*(2n*baseFee+gorjeta)+2n*l1Upper;
    if(custo>orcamento)return {situacao:'inviavel',
        motivo:'custo maximo da operacao excede orcamento por transacao',
        brutoWei:bruto.toString(),custoMaximoWei:custo.toString(),
        gasEstimado:gasEstimado.toString(),gasLimite:limite.toString()};
    let piso:{margemWei:bigint;lucroBrutoMinimoWei:bigint};
    try{piso=calcularPisoTitan(custo,ambiente);}catch{
        return {situacao:'desconhecido',motivo:'politica de lucro nao configurada'};
    }
    const dados={brutoWei:bruto.toString(),custoMaximoWei:custo.toString(),
        margemMinimaWei:piso.margemWei.toString(),
        liquidoConservadorWei:(bruto-custo).toString(),
        gasEstimado:gasEstimado.toString(),gasLimite:limite.toString()};
    return bruto>=piso.lucroBrutoMinimoWei
        ? {situacao:'executavel',motivo:'simulacao integral do executor passou com margem minima',...dados}
        : {situacao:'inviavel',motivo:'lucro bruto simulado menor que gas total e margem',...dados};
}

export async function simularTitanAoVivo(
    plano:PlanoTitan,rpcUrl:string,ambiente:NodeJS.ProcessEnv=process.env
):Promise<EnsaioAtomicoTitan>{
    if(!plano.estadoConsistente||!Number.isInteger(plano.bloco)
        ||plano.rota.length<2||plano.rota.length>4
        ||plano.quantia<=0n)
        return{situacao:'desconhecido',motivo:'rota nao validada pelo observador',bloco:null};
    if(!ambiente.TITAN_CONTRATO || !ambiente.TITAN_COFRE)
        return{situacao:'desconhecido',motivo:'executor/cofre da arbitragem nao configurado',bloco:null};
    if(plano.rota[0]?.tokenEntra.toLowerCase()!==WETH_BASE_TITAN.toLowerCase())
        return{situacao:'desconhecido',motivo:'lucro e custo precisam da mesma unidade WETH',bloco:null};
    let contrato:string,cofre:string,from:string|undefined;
    try{
        contrato=getAddress(ambiente.TITAN_CONTRATO);
        cofre=getAddress(ambiente.TITAN_COFRE);
        from=ambiente.TITAN_CHAVE_PRIVADA
            ? new Wallet(ambiente.TITAN_CHAVE_PRIVADA).address
            : undefined;
    }catch{return{situacao:'desconhecido',motivo:'enderecos/identidade da carteira invalidos',bloco:null};}
    const rpc=new JsonRpcProvider(rpcUrl,Number(REDE_BASE),{staticNetwork:true});
    let bloco:number|null=null;
    try{
        if(BigInt(await rpc.send('eth_chainId',[]))!==REDE_BASE)
            throw Error('RPC nao e Base 8453');
        if(await rpc.getCode(contrato)==='0x')throw Error('executor sem bytecode na Base');
        const get=async(nome:'dono'|'cofre')=>{
            const x=await rpc.call({to:contrato,data:ABI_TITAN.encodeFunctionData(nome)});
            return getAddress(ABI_TITAN.decodeFunctionResult(nome,x)[0] as string);
        };
        if((await get('cofre'))!==cofre)throw Error('cofre do executor diverge');
        if(from && (await get('dono'))!==from)throw Error('carteira nao e proprietaria do executor');
        const block=await rpc.getBlock('latest');
        if(!block?.baseFeePerGas || block.baseFeePerGas<=0n)throw Error('baseFee indisponivel');
        bloco=block.number;
        if(bloco-plano.bloco>3 || bloco<plano.bloco)
            return{situacao:'desconhecido',motivo:'cotacao anterior a 3 blocos; nao simular stale',bloco};
        const data=ABI_TITAN.encodeFunctionData('executarRota',[
            plano.rota,plano.quantia,0n
        ]);
        const tx={...(from?{from}:{}),to:contrato,data};
        // Dois metodos distintos: retorno integral e gas do caminho real.
        const [resultado,gasEstimado,l1Retorno]=await Promise.all([
            rpc.call(tx),
            rpc.estimateGas(tx),
            rpc.call({to:ORACULO_DE_GAS_L1,data:codificarTetoDeL1(
                Math.ceil((data.length-2)/2)+140
            )}),
        ]);
        const bruto=hexDeResultado(resultado,ABI_TITAN,'executarRota');
        const gorjeta=BigInt(ambiente.TITAN_GORJETA_WEI??'20000000');
        const gasMax=BigInt(ambiente.TITAN_GAS_MAX??'650000');
        const orcamento=BigInt(ambiente.TITAN_ORCAMENTO_GAS_WEI??'0');
        const avaliacao=avaliarEnsaioTitan(bruto,gasEstimado,block.baseFeePerGas,
            gorjeta,BigInt(l1Retorno),gasMax,orcamento,ambiente);
        // Quote envelhecida nao vira execucao atestada.
        const atual=await rpc.getBlockNumber();
        if(atual-bloco>2)return{situacao:'desconhecido',
            motivo:'bloco mudou durante a simulacao integral',bloco,contrato};
        return{...avaliacao,bloco,contrato};
    }catch(e){
        const causa=diagnosticarReversaoTitan(e);
        if(causa?.tipo==='pagamento-curto')return{
            situacao:'inviavel',bloco,contrato,erroContrato:'pagamento-curto',
            motivo:'PagamentoCurto: ciclo nao fecha, sem gasto onchain na simulacao',
            deficitUnidades:causa.deficit.toString(),
            deficitBps:causa.deficitBps.toString(),
        };
        if(causa?.tipo==='lucro-insuficiente')return{
            situacao:'inviavel',bloco,contrato,erroContrato:'lucro-insuficiente',
            motivo:'LucroInsuficiente: pagamento fecha, sobra inferior ao minimo',
            deficitUnidades:causa.deficit.toString(),
        };
        return{situacao:'desconhecido',bloco,contrato,
            motivo:(e instanceof Error?e.message:'falha na simulacao').slice(0,240)};
    }
    finally{rpc.destroy();}
}
