/** Verify Aave Multi-Hop identity before granting any paid send gate. */
import {JsonRpcProvider,getAddress,Wallet} from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
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
/** Deploy receipt and cache always live on the same durable Railway volume
 * as the nonce journal. Unknown markers block retries on restart.
 */
type AaveCache={version:1;owner:string;contrato:string};
export type AaveBootDeps={
 verificar:(env:NodeJS.ProcessEnv)=>Promise<string|null>;
 implantar:(env:NodeJS.ProcessEnv)=>Promise<string>;
};
const aaveDeps:AaveBootDeps={
 verificar:confirmarMultiHopAave,
 implantar:async env=>(await import('./implantarTitanMultiHop')).implantarMultiHop(env),
};
export async function prepararAaveMultiHopMegazord(
 env:NodeJS.ProcessEnv,deps:AaveBootDeps=aaveDeps,
):Promise<string|null>{
 if(env.CACA_MULTIHOP_AVALIAR!=='1')return null;
 const key=env.MEGAZORD_CHAVE_PRIVADA;
 const owner=env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO;
 const diary=env.MEGAZORD_DIARIO;
 if(!key||!owner||new Wallet(key).address.toLowerCase()!==owner.toLowerCase())
   throw Error('Aave Multi-Hop: carteira existente nao corresponde');
 if(!diary||!path.isAbsolute(diary)||!path.resolve(diary).startsWith('/app/data/'))
   throw Error('Aave Multi-Hop: diario persistente exigido');
 const cache=diary+'.aave-multihop.json';
 const marker=env.TITAN_MULTI_DEPLOY_MARCADOR??'/app/data/titanMultiHopDeploy.json';
 if(!path.isAbsolute(marker)||!path.resolve(marker).startsWith('/app/data/'))
   throw Error('Aave Multi-Hop: marcador fora do volume persistente');
 const existing=env.CACA_MULTIHOP_CONTRATO;
 let cached:string|undefined;
 if(fs.existsSync(cache)){
   let data:AaveCache;
   try{data=JSON.parse(fs.readFileSync(cache,'utf8')) as AaveCache;}
   catch{throw Error('Aave Multi-Hop: cache ilegiveI; sem redeploy');}
   if(data.version!==1||data.owner.toLowerCase()!==owner.toLowerCase()
      ||!/^0x[0-9a-f]{40}$/i.test(data.contrato))
     throw Error('Aave Multi-Hop: cache da carteira invalido');
   cached=data.contrato;
 }
 let marked:string|undefined;
 if(fs.existsSync(marker)){
   let data:{estado?:string;contrato?:string;carteira?:string};
   try{data=JSON.parse(fs.readFileSync(marker,'utf8')) as typeof data;}
   catch{throw Error('Aave Multi-Hop: marcador ilegivel, nao refazer deploy');}
   if(data.estado!=='confirmado'||!data.contrato
      ||!/^0x[0-9a-f]{40}$/i.test(data.contrato))
     throw Error('Aave Multi-Hop: deploy anterior incerto; nao repetir');
   marked=data.contrato;
 }
 const legacy=env.TITAN_MULTI_CONTRATO;
 const options=[existing,cached,marked,legacy].filter((x):x is string=>!!x);
 if(options.length&&options.some(x=>getAddress(x)!==getAddress(options[0]!)))
   throw Error('Aave Multi-Hop: enderecos do cache, diario e variaveis divergem');
 let contract=options[0];
 if(!contract){
   if(env.MEGAZORD_AUTO_DEPLOY!=='1')return null;
   if(env.MEGAZORD_EXCLUSIVO!=='1'||env.CACA_ENVIAR==='1')
     throw Error('Aave Multi-Hop: exclusividade de carteira ausente');
   const max=env.TITAN_MULTI_DEPLOY_TETO_WEI;
   if(!max||!/^\\d+$/.test(max)||BigInt(max)<=0n||BigInt(max)>1000000000000000n)
     throw Error('Aave Multi-Hop: teto dedicado de deploy <=0.001 ETH exigido');
   // Reuse the current wallet and existing guarded deployer. This script
   // reserves the durable marker BEFORE broadcast and never auto-retries.
   contract=await deps.implantar({...env,
     TITAN_MULTI_DEPLOY:'1',
     TITAN_MULTI_CONFIRMAR_DEPLOY:'IMPLANTAR_MULTIHOP_BASE_REAL',
     TITAN_NONCE_EXCLUSIVO:'1',
     CACA_CHAVE_PRIVADA:key,CACA_ENDERECO_PUBLICO:owner,
     CACA_RPC_URL:env.MEGAZORD_RPC_URL,
     TITAN_MULTI_DEPLOY_MARCADOR:marker,
   });
 }
 const probe={...env,CACA_MULTIHOP_CONTRATO:getAddress(contract)};
 const verified=await deps.verificar(probe);
 if(!verified)throw Error('Aave Multi-Hop: contrato nao validado onchain');
 const authorized=getAddress(verified);
 if(authorized!==getAddress(contract))throw Error('Aave Multi-Hop: resultado de verificacao divergente');
 // Durable cache updated after chain verification. Separate pending marker
 // protects a crash between paid deploy and this write.
 fs.mkdirSync(path.dirname(cache),{recursive:true});
 const tmp=cache+'.'+process.pid+'.tmp';
 const fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify({version:1,owner,contrato:authorized}));
   fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,cache);
 const dir=fs.openSync(path.dirname(cache),'r');
 try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
 env.CACA_MULTIHOP_CONTRATO=authorized;
 return authorized;
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
