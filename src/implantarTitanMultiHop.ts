/**
 * Deploy isolado CacadorAaveMultiHopMorpho na Base.
 * NUNCA chamado por import, build, nem no bootstrap do CACA.
 * Exige confirmacao e orcamento novos; nao reutiliza o deploy do CacadorV3.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ContractFactory, Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { ORACULO_DE_GAS_L1 } from './custoDaBase';
import { MORPHO_FLASH_BASE, ABI_MULTI } from './titanPonteMultiHop';
import { COFRE_ESPERADO } from './caca';
import { REDES } from './liquidacoes';
const oracle = new Interface(['function getL1Fee(bytes) view returns(uint256)']);
const artefato = '.tmp/artifacts/contracts/CacadorAaveMultiHopMorpho.sol/CacadorAaveMultiHopMorpho.json';
const MAX_DEPLOY_WEI=1_000_000_000_000_000n;
export async function implantarMultiHop(env: NodeJS.ProcessEnv = process.env):Promise<string>{
    if (env.TITAN_MULTI_DEPLOY!=='1'
        || env.TITAN_MULTI_CONFIRMAR_DEPLOY!=='IMPLANTAR_MULTIHOP_BASE_REAL')
        throw new Error('deploy desativado: duas confirmacoes exclusivas exigidas');
    if (env.TITAN_NONCE_EXCLUSIVO!=='1') throw new Error('nonce nao exclusivo');
    const marcador=env.TITAN_MULTI_DEPLOY_MARCADOR;
    const tetoTexto=env.TITAN_MULTI_DEPLOY_TETO_WEI;
    if (!marcador || !marcador.startsWith('/app/data/') || marcador.includes('..')
        || !tetoTexto || !/^\\d+$/.test(tetoTexto)
        || BigInt(tetoTexto)<=0n || BigInt(tetoTexto)>MAX_DEPLOY_WEI)
        throw new Error('marcador em volume e orcamento de deploy <= 0.001 ETH exigidos');
    if (fs.existsSync(marcador)) throw new Error('deploy ja tentado; conferir hash antes de qualquer repeticao');
    if (!env.TITAN_CHAVE_PRIVADA || !env.ARB_RPC_URL || !env.TITAN_COFRE
        || !env.TITAN_MULTI_AAVE || !env.TITAN_MULTI_FACTORY)
        throw new Error('faltam chave, RPC e imutaveis');
    const carteira=new Wallet(env.TITAN_CHAVE_PRIVADA);
    const cofre=getAddress(env.TITAN_COFRE);
    const aave=getAddress(env.TITAN_MULTI_AAVE);
    const fabrica=getAddress(env.TITAN_MULTI_FACTORY);
    if (cofre===carteira.address || cofre!==getAddress(COFRE_ESPERADO))
        throw new Error('cofre nao corresponde ao destino imutavel conhecido');
    if (aave!==getAddress(REDES.base.pool))
        throw new Error('pool Aave diverge do pool Base do cacador');
    const artifact=JSON.parse(fs.readFileSync(artefato,'utf8')) as {abi:ConstructorParameters<typeof ContractFactory>[0];bytecode:string};
    if (!artifact.bytecode.startsWith('0x') || artifact.bytecode.length<200)
        throw new Error('artefato multi-hop sem bytecode');
    const rpc=new JsonRpcProvider(env.ARB_RPC_URL,8453,{staticNetwork:true});
    let hash:string|undefined;
    try {
        if (BigInt(await rpc.send('eth_chainId',[]))!==8453n)
            throw new Error('RPC diferente de Base 8453');
        const bloco=await rpc.getBlock('latest');
        if (!bloco || !bloco.baseFeePerGas || bloco.baseFeePerGas<=0n)
            throw new Error('base fee nao disponivel');
        const nonce=await rpc.getTransactionCount(carteira.address,'pending');
        if (nonce!==(await rpc.getTransactionCount(carteira.address,'latest')))
            throw new Error('ha transacao pendente');
        const gorjeta=BigInt(env.TITAN_MULTI_DEPLOY_TIP_WEI??'20000000');
        if (gorjeta<=0n) throw new Error('gorjeta invalida');
        const maxFee=bloco.baseFeePerGas*2n+gorjeta;
        const factory=new ContractFactory(artifact.abi,artifact.bytecode,carteira.connect(rpc));
        const tx=await factory.getDeployTransaction(cofre,aave,MORPHO_FLASH_BASE,fabrica);
        const estimado=await rpc.estimateGas({...tx,from:carteira.address});
        const gasLimit=estimado+estimado/5n;
        if (gasLimit>BigInt(env.TITAN_MULTI_DEPLOY_GAS_MAX??'4000000'))
            throw new Error('gas do deploy excede o teto');
        const pedido={...tx,chainId:8453,type:2 as const,nonce,
            maxFeePerGas:maxFee,maxPriorityFeePerGas:gorjeta,gasLimit};
        const assinado=await carteira.signTransaction(pedido);
        const retorno=await rpc.call({to:ORACULO_DE_GAS_L1,
            data:oracle.encodeFunctionData('getL1Fee',[assinado])});
        const l1=oracle.decodeFunctionResult('getL1Fee',retorno)[0] as bigint;
        if (gasLimit*maxFee+2n*l1>BigInt(tetoTexto))
            throw new Error('deploy excede orcamento total L1+L2');
        if ((await rpc.getTransactionCount(carteira.address,'pending'))!==nonce)
            throw new Error('nonce mudou durante preflight');
        fs.mkdirSync(path.dirname(marcador),{recursive:true});
        const fd=fs.openSync(marcador,'wx',0o600);
        try {
            fs.writeFileSync(fd,JSON.stringify({estado:'preflight_ok',
                carteira:carteira.address,cofre,aave,fabrica,rede:8453,nonce,
                em:new Date().toISOString()}));
            fs.fsyncSync(fd);
        }finally{fs.closeSync(fd);}
        const resposta=await carteira.connect(rpc).sendTransaction(pedido);
        hash=resposta.hash;
        fs.writeFileSync(marcador,JSON.stringify({estado:'enviado',hash,nonce}),{mode:0o600});
        const recibo=await resposta.wait(1,90_000);
        if (!recibo || recibo.status!==1 || !recibo.contractAddress)
            throw new Error('recibo ausente ou deploy revertido; NAO repetir automaticamente');
        const contrato=recibo.contractAddress;
        for (const [fn,esperado] of Object.entries({dono:carteira.address,cofre,
            aave,morpho:MORPHO_FLASH_BASE,fabricaV3:fabrica})) {
            const dados=await rpc.call({to:contrato,data:ABI_MULTI.encodeFunctionData(fn)});
            const lido=ABI_MULTI.decodeFunctionResult(fn,dados)[0] as string;
            if (getAddress(lido)!==getAddress(esperado))
                throw new Error('deploy confirmado com imutavel divergente: '+fn);
        }
        fs.writeFileSync(marcador,JSON.stringify({estado:'confirmado',hash,contrato,
            cofre,gasUsado:recibo.gasUsed.toString()}),{mode:0o600});
        return contrato;
    }catch(e){
        if (hash) console.error('DEPLOY MULTI-HOP possivelmente transmitido:',hash,
            'CONSULTE A BASE ANTES DE REPETIR');
        throw e;
    }finally{rpc.destroy();}
}
if (require.main===module) {
    void implantarMultiHop().then(c=>console.log('[MULTIHOP DEPLOY OK]',c))
        .catch(e=>{console.error('[MULTIHOP DEPLOY]',e instanceof Error?e.message:e);
            process.exitCode=1;});
}
