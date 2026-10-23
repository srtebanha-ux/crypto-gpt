/** Verify Aave Multi-Hop identity before granting any paid send gate. */
import {JsonRpcProvider,getAddress} from 'ethers';
import {ABI_MULTI,FABRICA_V3_BASE,MORPHO_FLASH_BASE,
 FABRICA_SLIPSTREAM_BASE} from './titanPonteMultiHop';
import {COFRE_ESPERADO} from './caca';
import {REDES} from './liquidacoes';
export type MultiBootLeitor={
 getCode(address:string):Promise<string>;
 call(request:{to:string;data:string}):Promise<string>;
 getNetwork():Promise<{chainId:bigint}>;
};
export async function confirmarMultiHopAave(
 env:NodeJS.ProcessEnv,
 makeReader?:(url:string)=>MultiBootLeitor,
):Promise<string|null>{
 if(env.CACA_MULTIHOP_AVALIAR!=='1')return null;
 const contrato=env.CACA_MULTIHOP_CONTRATO;
 if(!contrato)return null; // Missing Aave executor must not invent an address.
 if(!/^0x[0-9a-f]{40}$/i.test(contrato))throw Error('Aave Multi-Hop: endereco invalido');
 const owner=env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO;
 const rpc=env.MEGAZORD_RPC_URL;
 if(!owner||!rpc)throw Error('Aave Multi-Hop: carteira publica/RPC ausente');
 const provider=makeReader?makeReader(rpc):new JsonRpcProvider(rpc,8453,{staticNetwork:true});
 try {
  if((await provider.getNetwork()).chainId!==8453n
     ||await provider.getCode(contrato)==='0x')
    throw Error('Aave Multi-Hop: rede/bytecode invalido');
  const expected:{[field:string]:string}={
    dono:owner,cofre:COFRE_ESPERADO,aave:REDES.base.pool,
    morpho:MORPHO_FLASH_BASE,fabricaV3:FABRICA_V3_BASE,
  };
  if(env.CACA_MULTIHOP_SLIPSTREAM==='1')
    expected.slipstreamFactory=FABRICA_SLIPSTREAM_BASE;
  for(const [method,address] of Object.entries(expected)){
    const result=await provider.call({to:contrato,data:ABI_MULTI.encodeFunctionData(method)});
    const onchain=ABI_MULTI.decodeFunctionResult(method,result)[0] as string;
    if(getAddress(onchain)!==getAddress(address))
      throw Error('Aave Multi-Hop: imutavel '+method+' divergente');
  }
  return getAddress(contrato);
 }finally{
  if(provider instanceof JsonRpcProvider)provider.destroy();
 }
}
export function habilitarAaveMultiHopMegazord(env:NodeJS.ProcessEnv,contrato:string|null):void{
 if(!contrato)return;
 if(env.MEGAZORD_MODO!=='execucao'||env.MEGAZORD_CONFIRMAR!=='OPERAR_BASE_REAL'
    ||env.MEGAZORD_EXCLUSIVO!=='1'||env.CACA_MULTIHOP_AVALIAR!=='1')
    throw Error('Aave Multi-Hop: sem preflight/autorizacao do Megazord');
 env.CACA_MULTIHOP_CONTRATO=contrato;
 // CACA's paid transmission gate additionally requires its own flag. Avoid
 // authorizing the legacy V1/V2 by enforcing the existing MH-only guard.
 env.CACA_ENVIAR='1';
 env.CACA_SOMENTE_MULTIHOP='1';
 env.CACA_MULTIHOP_ENVIAR='1';
 env.CACA_MULTIHOP_CONFIRMAR='OPERAR_BASE_REAL';
 env.CACA_MULTIHOP_CANARY_UM_TIRO='1';
}
