/**
 * Implantacao unica do CacadorV3 na Base. NAO roda no boot do titan.
 * Usar somente em comando explicito, com teto financeiro e confirmacao.
 * A operacao GASTA ETH REAL em gas mesmo se o deploy falhar.
 */
import fs from 'node:fs';
import { ContractFactory, Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { ORACULO_DE_GAS_L1 } from './custoDaBase';

const oracle = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
const caminhoArtefato = '.tmp/artifacts/contracts/CacadorV3.sol/CacadorV3.json';

async function principal(): Promise<void> {
    if (process.env.TITAN_IMPLANTAR !== '1'
        || process.env.TITAN_CONFIRMAR_IMPLANTACAO !== 'IMPLANTAR_BASE_REAL') {
        throw new Error('implantacao desligada; exige TITAN_IMPLANTAR=1 e confirmacao explicita');
    }
    if (process.env.TITAN_NONCE_EXCLUSIVO !== '1') {
        throw new Error('nonce compartilhado sem coordenacao: nao implanto');
    }
    const chave = process.env.TITAN_CHAVE_PRIVADA;
    const rpcUrl = process.env.ARB_RPC_URL;
    const cofre = process.env.TITAN_COFRE;
    const teto = process.env.TITAN_ORCAMENTO_DEPLOY_WEI;
    if (!chave || !rpcUrl || !cofre || !teto || !/^\d+$/.test(teto) || BigInt(teto) <= 0n) {
        throw new Error('faltam chave, RPC, cofre ou teto de gas do deploy');
    }
    const artefato = JSON.parse(fs.readFileSync(caminhoArtefato, 'utf8')) as {
        abi: ConstructorParameters<typeof ContractFactory>[0]; bytecode: string;
    };
    if (!artefato.bytecode.startsWith('0x') || artefato.bytecode.length < 200) {
        throw new Error('bytecode invalido do CacadorV3');
    }
    const wallet = new Wallet(chave);
    const cofreFinal = getAddress(cofre);
    const rpc = new JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
    let hash: string | undefined;
    try {
        if (BigInt(await rpc.send('eth_chainId', [])) !== 8453n) {
            throw new Error('RPC nao aponta para Base');
        }
        const bloco = await rpc.getBlock('latest');
        if (!bloco || bloco.baseFeePerGas === null || bloco.baseFeePerGas <= 0n) {
            throw new Error('baseFee nao disponivel');
        }
        const gorjeta = BigInt(process.env.TITAN_GORJETA_WEI ?? '20000000');
        const maxFeePerGas = bloco.baseFeePerGas * 2n + gorjeta;
        const fabrica = new ContractFactory(artefato.abi, artefato.bytecode, wallet.connect(rpc));
        const deploy = await fabrica.getDeployTransaction(cofreFinal);
        const gasEstimado = await rpc.estimateGas({ ...deploy, from: wallet.address });
        const gasLimit = gasEstimado + gasEstimado / 5n;
        if (gasLimit > BigInt(process.env.TITAN_DEPLOY_GAS_MAX ?? '3500000')) {
            throw new Error('gas do deploy excede o teto de unidades');
        }
        const nonce = await rpc.getTransactionCount(wallet.address, 'pending');
        const unsigned = { ...deploy, chainId: 8453, type: 2 as const, nonce,
            gasLimit, maxFeePerGas, maxPriorityFeePerGas: gorjeta };
        // O predeploy calcula custo de dados sobre bytes da tx assinada.
        const assinada = await wallet.signTransaction(unsigned);
        const retorno = await rpc.call({ to: ORACULO_DE_GAS_L1,
            data: oracle.encodeFunctionData('getL1Fee', [assinada]) });
        const l1 = oracle.decodeFunctionResult('getL1Fee', retorno)[0] as bigint;
        const custoMax = gasLimit * maxFeePerGas + l1 * 2n;
        if (custoMax > BigInt(teto)) throw new Error('deploy excede o orcamento em wei');
        if ((await rpc.getTransactionCount(wallet.address, 'pending')) !== nonce) {
            throw new Error('nonce mudou antes de enviar o deploy');
        }
        const resposta = await wallet.connect(rpc).sendTransaction(unsigned);
        hash = resposta.hash;
        console.log('[TITAN/DEPLOY] Hash transmitido:', hash);
        const recibo = await resposta.wait(1, 60000);
        if (!recibo) {
            console.log('[TITAN/DEPLOY] Sem recibo. Conferir hash; NAO repetir automaticamente.');
            process.exitCode = 1;
            return;
        }
        if (recibo.status !== 1 || !recibo.contractAddress) {
            throw new Error('implantacao revertida. Gasto de gas real; conferir hash, NAO repetir');
        }
        console.log('[TITAN/DEPLOY] CONTRATO:', recibo.contractAddress);
        console.log('[TITAN/DEPLOY] COFRE:', cofreFinal);
        console.log('[TITAN/DEPLOY] GAS USADO:', recibo.gasUsed.toString());
        console.log('[TITAN/DEPLOY] Configure TITAN_CONTRATO com o endereco acima.');
    } catch (e) {
        if (hash) console.log('[TITAN/DEPLOY] Possivelmente enviado, hash:', hash,
            '— consultar recibo, NAO repetir automaticamente');
        throw e;
    } finally {
        rpc.destroy();
    }
}
if (require.main === module) {
    void principal().catch((e: unknown) => {
        console.error('[TITAN/DEPLOY]', e instanceof Error ? e.message : 'falha desconhecida');
        process.exitCode = 1;
    });
}
