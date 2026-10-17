/**
 * TITAN — capitalizacao 100% do lucro WETH confirmado para ETH nativo.
 *
 * O contrato envia WETH ao COFRE IMUTAVEL, nao a carteira executora.
 * So podemos fazer unwrap sem uma segunda chave se cofre === carteira.
 * Nunca tenta mover ativos de outro cofre e nunca converte saldo preexistente:
 * usa exatamente a quantidade do evento Cacou confirmado.
 *
 * O unwrap gasta uma segunda transacao na Base. Um marcador persistente por
 * hash original impede repeticoes; o acumulado diario limita a despesa.
 */
import { Interface, JsonRpcProvider, Wallet, getAddress, keccak256 } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { ORACULO_DE_GAS_L1 } from './custoDaBase';
import { conferirJanelaDeNonce } from './janelaDeNonce';

const BASE_CHAIN_ID = 8453n;
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const WETH_ABI = new Interface([
    'function balanceOf(address) view returns (uint256)',
    'function withdraw(uint256)',
]);
const ORACULO_ABI = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
export interface ReinvestimentoTitan {
    estado: 'desligado' | 'incompativel' | 'sem_margem' | 'enviado' | 'confirmado' | 'revertido' | 'desconhecido';
    motivo: string;
    hash?: string;
    wethConvertidoWei?: string;
    custoMaximoWei?: string;
}

/** Planejamento puro: taxa de unwrap jamais pode consumir o proprio lucro. */
export function autorizarUnwrapSnowball(
    lucroWethWei: bigint, saldoEthWei: bigint,
    custoMaximoWei: bigint, tetoDiarioWei: bigint,
): boolean {
    return lucroWethWei > 0n
        && saldoEthWei > 0n
        && custoMaximoWei > 0n
        && tetoDiarioWei > 0n
        && custoMaximoWei <= tetoDiarioWei
        && custoMaximoWei * 4n <= lucroWethWei
        && custoMaximoWei * 20n <= saldoEthWei;
}

export async function reinvestirLucroTitan(
    rpc: JsonRpcProvider,
    carteira: Wallet,
    cofre: string,
    lucroConfirmadoWei: bigint,
    hashArbitragem: string,
    ambiente: NodeJS.ProcessEnv,
): Promise<ReinvestimentoTitan> {
    if (ambiente.TITAN_GAS_SNOWBALL !== '1'
        || ambiente.TITAN_SNOWBALL_REINVESTIR !== '1') {
        return { estado: 'desligado', motivo: 'reinvestimento automatico nao habilitado' };
    }
    if (getAddress(cofre) !== carteira.address) {
        return { estado: 'incompativel',
            motivo: 'cofre imutavel diferente da carteira: lucro e WETH de outra conta, sem autorizacao para movimentar' };
    }
    if (lucroConfirmadoWei <= 0n) {
        return { estado: 'sem_margem', motivo: 'recibo nao comprovou lucro WETH' };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(hashArbitragem)) {
        return { estado: 'incompativel', motivo: 'hash do recibo de arbitragem invalido' };
    }
    const diaUtc = new Date().toISOString().slice(0, 10);
    const prefixo = 'titan-snowball-unwrap-' + diaUtc + '-';
    const marcador = '/app/data/' + prefixo + hashArbitragem.slice(2).toLowerCase() + '.json';
    // Sem volume persistente, fail closed: crash nao pode desencadear segundo unwrap.
    if (!fs.existsSync('/app/data')) {
        return { estado: 'incompativel', motivo: 'volume persistente /app/data ausente' };
    }
    if (fs.existsSync(marcador)) {
        return { estado: 'sem_margem', motivo: 'unwrap desta arbitragem ja reservado; nao reenviar' };
    }
    let hash: string | undefined;
    try {
        if (BigInt(await rpc.send('eth_chainId', [])) !== BASE_CHAIN_ID) {
            throw new Error('RPC nao e Base 8453');
        }
        const saldoWeth = WETH_ABI.decodeFunctionResult('balanceOf', await rpc.call({
            to: WETH_BASE, data: WETH_ABI.encodeFunctionData('balanceOf', [carteira.address]),
        }))[0] as bigint;
        if (saldoWeth < lucroConfirmadoWei) {
            return { estado: 'incompativel', motivo: 'lucro confirmado nao aparece como WETH no cofre' };
        }
        const janela = await conferirJanelaDeNonce(rpc, carteira.address,
            ambiente.TITAN_SOLO_24H === '1' ? 'TITAN_SOLO' : 'TITAN');
        if (!janela.pode) {
            return { estado: 'incompativel', motivo: 'janela exclusiva de nonce indisponivel' };
        }
        const nonce = await rpc.getTransactionCount(carteira.address, 'pending');
        const ultimoNonce = await rpc.getTransactionCount(carteira.address, 'latest');
        if (nonce !== ultimoNonce || janela.nonce !== nonce) {
            return { estado: 'incompativel', motivo: 'carteira tem nonce pendente ou compartilhado' };
        }
        const bloco = await rpc.getBlock('latest');
        if (!bloco || !bloco.baseFeePerGas || bloco.baseFeePerGas <= 0n) {
            return { estado: 'incompativel', motivo: 'base fee desconhecida' };
        }
        const dados = WETH_ABI.encodeFunctionData('withdraw', [lucroConfirmadoWei]);
        const estimado = await rpc.estimateGas({
            from: carteira.address, to: WETH_BASE, data: dados,
        });
        const gasLimit = estimado + (estimado + 4n) / 5n;
        const prioridade = BigInt(ambiente.TITAN_GORJETA_WEI ?? '20000000');
        const maxFee = 2n * bloco.baseFeePerGas + prioridade;
        const assinada = await carteira.signTransaction({
            chainId: Number(BASE_CHAIN_ID), type: 2, nonce, to: WETH_BASE,
            data: dados, gasLimit, maxFeePerGas: maxFee,
            maxPriorityFeePerGas: prioridade, value: 0n,
        });
        const feeL1 = ORACULO_ABI.decodeFunctionResult('getL1Fee', await rpc.call({
            to: ORACULO_DE_GAS_L1,
            data: ORACULO_ABI.encodeFunctionData('getL1Fee', [assinada]),
        }))[0] as bigint;
        const custoMaximo = gasLimit * maxFee + 2n * feeL1;
        const saldoEth = await rpc.getBalance(carteira.address);
        const tetoDiario = BigInt(ambiente.TITAN_GAS_DIA_WEI ?? '0') / 10n;
        // O teto vale para TODOS os unwraps do dia, inclusive os pendentes.
        // Registro corrompido => nao ha autorizacao para gastar mais ETH.
        let jaReservado = 0n;
        for (const nome of fs.readdirSync('/app/data')) {
            if (!nome.startsWith(prefixo) || !nome.endsWith('.json')) continue;
            const registro = JSON.parse(fs.readFileSync('/app/data/' + nome, 'utf8')) as {
                tetoGasWei?: string;
            };
            if (!registro.tetoGasWei || !/^\\d+$/.test(registro.tetoGasWei)) {
                throw new Error('diario de unwrap corrompido; interrompido por seguranca');
            }
            jaReservado += BigInt(registro.tetoGasWei);
        }
        if (!autorizarUnwrapSnowball(
            lucroConfirmadoWei, saldoEth, custoMaximo,
            tetoDiario > jaReservado ? tetoDiario - jaReservado : 0n,
        )) {
            return { estado: 'sem_margem',
                motivo: 'lucro, saldo ETH ou limite de gas nao justificam unwrap',
                custoMaximoWei: custoMaximo.toString() };
        }
        const segundaJanela = await conferirJanelaDeNonce(rpc, carteira.address,
            ambiente.TITAN_SOLO_24H === '1' ? 'TITAN_SOLO' : 'TITAN');
        if (!segundaJanela.pode || segundaJanela.nonce !== nonce
            || (await rpc.getTransactionCount(carteira.address, 'pending')) !== nonce) {
            return { estado: 'incompativel', motivo: 'nonce mudou antes do unwrap' };
        }
        hash = keccak256(assinada);
        fs.mkdirSync(path.dirname(marcador), { recursive: true });
        const fd = fs.openSync(marcador, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify({
                estado: 'reservado', hash, nonce, diaUtc,
                quantidadeWei: lucroConfirmadoWei.toString(),
                tetoGasWei: custoMaximo.toString(),
            }));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        // O hash e persistido ANTES do broadcast: nunca retransmitir em timeout.
        const tx = await rpc.broadcastTransaction(assinada);
        if (tx.hash.toLowerCase() !== hash.toLowerCase()) {
            return { estado: 'desconhecido', hash,
                motivo: 'RPC devolveu hash diferente; consultar manualmente' };
        }
        const recibo = await tx.wait(1, 60_000);
        if (!recibo) return { estado: 'enviado', hash,
            motivo: 'unwrap submetido; aguardando recibo, sem reenvio' };
        const estado = recibo.status === 1 ? 'confirmado' : 'revertido';
        fs.writeFileSync(marcador, JSON.stringify({
            estado, hash, diaUtc,
            quantidadeWei: lucroConfirmadoWei.toString(),
            tetoGasWei: custoMaximo.toString(),
            gasL2Wei: (recibo.gasUsed * recibo.gasPrice).toString(),
        }), { mode: 0o600 });
        return { estado, hash, wethConvertidoWei: recibo.status === 1
            ? lucroConfirmadoWei.toString() : undefined,
            custoMaximoWei: custoMaximo.toString(),
            motivo: recibo.status === 1
                ? 'lucro WETH convertido em ETH nativo na propria carteira executora'
                : 'unwrap reverteu; gas consumido e marcador impede repetir' };
    } catch (e) {
        return { estado: hash ? 'desconhecido' : 'incompativel', hash,
            motivo: hash ? 'hash persistido; consultar antes de nova tentativa'
                : (e instanceof Error ? e.message.slice(0, 200) : 'falha desconhecida') };
    }
}
