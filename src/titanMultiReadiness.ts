/**
 * TITAN Multi-Hop Readiness: observador SOMENTE LEITURA da Base.
 * Sem Wallet, sem assinatura, sem broadcast, sem deploy, sem chaves privadas.
 */
import { JsonRpcProvider, Interface, getAddress } from 'ethers';
import { MORPHO_FLASH_BASE, ABI_MULTI } from './titanPonteMultiHop';
import { REDES } from './liquidacoes';
import { COFRE_ESPERADO } from './caca';

const FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const WETH='0x4200000000000000000000000000000000000006';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDBC='0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
const ABI_POOL=new Interface(['function ADDRESSES_PROVIDER() view returns(address)']);
const ABI_PROVIDER=new Interface(['function getPool() view returns(address)']);
const ABI_FACTORY=new Interface(['function getPool(address,address,uint24) view returns(address)']);
const ENDERECO=/^0x[0-9a-fA-F]{40}$/;

export async function diagnosticarMultiReadOnly(rpcUrl:string,
    contratado?:string):Promise<Record<string,string|boolean|number>>{
    const rpc=new JsonRpcProvider(rpcUrl,8453,{staticNetwork:true});
    try {
        const chainId=BigInt(await rpc.send('eth_chainId',[]));
        if(chainId!==8453n)throw new Error('RPC nao e Base');
        const bloco=await rpc.getBlockNumber();
        const contratos=[REDES.base.pool,MORPHO_FLASH_BASE,FACTORY,USDC,WETH,USDBC];
        for(const a of contratos){
            if((await rpc.getCode(a))==='0x')throw new Error('contrato essencial sem bytecode: '+a);
        }
        const provider=ABI_POOL.decodeFunctionResult('ADDRESSES_PROVIDER',
            await rpc.call({to:REDES.base.pool,data:ABI_POOL.encodeFunctionData('ADDRESSES_PROVIDER')}))[0] as string;
        const aaveAtual=ABI_PROVIDER.decodeFunctionResult('getPool',
            await rpc.call({to:provider,data:ABI_PROVIDER.encodeFunctionData('getPool')}))[0] as string;
        if(getAddress(aaveAtual)!==getAddress(REDES.base.pool))
            throw new Error('Aave mudou proxy Pool; revisar enderecos antes de operar');
        const getPool=async(a:string,b:string,fee:number):Promise<string>=>{
            const p=ABI_FACTORY.decodeFunctionResult('getPool',
                await rpc.call({to:FACTORY,data:ABI_FACTORY.encodeFunctionData('getPool',[a,b,fee])}))[0] as string;
            if(p==='0x0000000000000000000000000000000000000000'
                || await rpc.getCode(p)==='0x')throw new Error('pool V3 nao encontrado: '+fee);
            return p;
        };
        const direto=await getPool(WETH,USDC,500);
        const primeiro=await getPool(WETH,USDBC,500);
        const segundo=await getPool(USDBC,USDC,100);
        let statusExecutor='nao configurado (sem deploy verificado)';
        if(contratado){
            if(!ENDERECO.test(contratado)||await rpc.getCode(contratado)==='0x')
                throw new Error('endereco do Multi-Hop informado nao contem contrato');
            const getter=async(nome:string):Promise<string>=>{
                const bytes=await rpc.call({to:contratado,data:ABI_MULTI.encodeFunctionData(nome)});
                return ABI_MULTI.decodeFunctionResult(nome,bytes)[0] as string;
            };
            const conferencias:Record<string,string>={
                cofre:COFRE_ESPERADO,aave:REDES.base.pool,morpho:MORPHO_FLASH_BASE,
                fabricaV3:FACTORY,
            };
            for(const [nome,esperado] of Object.entries(conferencias)){
                if(getAddress(await getter(nome))!==getAddress(esperado))
                    throw new Error('executor implantado tem '+nome+' divergente');
            }
            statusExecutor='imutaveis do contrato checadas (dono depende do assinador)';
        }
        return {online:true,chainId:8453,bloco,aave:aaveAtual,morpho:MORPHO_FLASH_BASE,
            factory:FACTORY,poolDireta:direto,poolHop1:primeiro,poolHop2:segundo,
            executor:statusExecutor,carteira:'NENHUMA (observador sem assinatura)',
            envio:'INEXISTENTE'};
    }finally{rpc.destroy();}
}
if(require.main===module){
    const url=process.env.TITAN_MULTI_READONLY_RPC_URL??'https://mainnet.base.org';
    const consulta=async()=>{
        try{
            const status=await diagnosticarMultiReadOnly(url,process.env.CACA_MULTIHOP_CONTRATO);
            console.log('[TITAN/READONLY] '+JSON.stringify(status));
        }catch(e){
            console.error('[TITAN/READONLY/ALERTA] '+(e instanceof Error?e.message:String(e)));
        }
    };
    void consulta();
    setInterval(()=>void consulta(),300_000).unref?.();
    // Worker de leitura: NENHUMA referencia a chave, assinatura ou sendTransaction.
    process.stdin.resume();
}
