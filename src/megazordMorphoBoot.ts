/**
 * Boot-only Morpho executor preparation. Never signs or deploys on import.
 * Paid deployments require the EXISTING wallet, explicit caps, persistent
 * receipt marker, no pending nonce and a separately opted-in auto-deploy flag.
 */
import fs from 'node:fs';
import path from 'node:path';
import {Interface,JsonRpcProvider,Wallet,getAddress} from 'ethers';
import {COFRE_ESPERADO} from './caca';
import {FABRICA_V3_BASE,MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {conferirReciboMorpho,rpcsReciboMorpho,type RpcRecibo} from './morphoDeployReceipt';

const V3_ROUTER='0x2626664c2603336E57B271c5C0b26F421741e481';
const AERO_ROUTER='0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const AERO_FACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const abi=new Interface([
 'function versaoRotas() view returns(uint256)',
 'function dono() view returns(address)',
 'function cofre() view returns(address)',
 'function morpho() view returns(address)',
 'function routerV3() view returns(address)',
 'function fabricaV3() view returns(address)',
 'function aerodromeRouter() view returns(address)',
 'function aerodromeFactory() view returns(address)',
]);
type Tipo='v3'|'aero';
export function rotasSelecionadasMegazord(env:NodeJS.ProcessEnv):Tipo[]{
 const names=(env.MEGAZORD_MORPHO_ROTAS??'v3,aero').split(',').map(x=>x.trim());
 if(!names.length||names.some(x=>x!=='v3'&&x!=='aero')||new Set(names).size!==names.length)
   throw Error('MEGAZORD_MORPHO_ROTAS deve selecionar v3, aero ou v3,aero');
 return names as Tipo[];
}
type CacheContratos={version:1;owner:string;v3?:string;aero?:string};
function arquivoCache(env:NodeJS.ProcessEnv):string|undefined{
 const diary=env.MEGAZORD_DIARIO;
 if(!diary)return undefined;
 if(!path.isAbsolute(diary)
   ||(env.MEGAZORD_MODO==='execucao'&&!path.resolve(diary).startsWith('/app/data/')))
   throw Error('cache de contratos requer MEGAZORD_DIARIO em volume persistente');
 return diary+'.contratos.json';
}
function lerCache(env:NodeJS.ProcessEnv,owner:string):CacheContratos{
 const file=arquivoCache(env);
 if(!file||!fs.existsSync(file))return {version:1,owner};
 let cached:CacheContratos;
 try{cached=JSON.parse(fs.readFileSync(file,'utf8')) as CacheContratos;}
 catch{throw Error('cache de contratos ilegivel, nao repetir deploy');}
 if(cached.version!==1||cached.owner.toLowerCase()!==owner.toLowerCase()
   ||['v3','aero'].some(x=>{const a=cached[x as Tipo];return a!==undefined
     &&!/^0x[0-9a-f]{40}$/i.test(a);}))
   throw Error('cache de contratos invalido ou carteira divergente');
 return cached;
}
function guardarCache(env:NodeJS.ProcessEnv,cached:CacheContratos):void{
 const file=arquivoCache(env);
 if(!file)return;
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const tmp=file+'.'+process.pid+'.tmp';
 const fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(cached));fs.fsyncSync(fd);}
 finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);
 const dir=fs.openSync(path.dirname(file),'r');
 try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
type ContratoConfig={env:string;marker:string;cap:string;invariants:Record<string,string>};
function config(tipo:Tipo,owner:string):ContratoConfig {
 const common={dono:owner,cofre:COFRE_ESPERADO,morpho:MORPHO_FLASH_BASE};
 return tipo==='v3'
 ?{env:'CACA_MORPHO_V3_CONTRATO',marker:'/app/data/titanMorphoV3Deploy.json',
   cap:'TITAN_MORPHO_V3_DEPLOY_WEI',
   invariants:{...common,routerV3:V3_ROUTER,fabricaV3:FABRICA_V3_BASE}}
 :{env:'CACA_MORPHO_AERO_CONTRATO',marker:'/app/data/titanMorphoAeroDeploy.json',
   cap:'TITAN_MORPHO_AERO_DEPLOY_WEI',
   invariants:{...common,aerodromeRouter:AERO_ROUTER,aerodromeFactory:AERO_FACTORY}};
}
export async function markerConfirmado(file:string,env:NodeJS.ProcessEnv,
 read?:RpcRecibo,verify=verificarContrato):Promise<string|undefined> {
 if(!fs.existsSync(file))return;
 // A reserved/uncertain deployment is never retried or guessed to have succeeded.
 let data:unknown;
 try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('marcador Morpho ilegivel: abortar boot');}
 const m=data as {status?:unknown;contract?:unknown;hash?:unknown;nonce?:unknown};
 if(m.status==='reserved'){
   const owner=env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO;
   if(!owner||!env.MEGAZORD_RPC_URL||typeof m.hash!=='string'||typeof m.nonce!=='number')
     throw Error('marcador reservado sem identidade; nao reenviar');
   const receipt=await conferirReciboMorpho(m.hash,owner,m.nonce,
     rpcsReciboMorpho(env.MEGAZORD_RPC_URL,env.MEGAZORD_RPC_SECUNDARIO),read);
   if(!receipt)throw Error('deploy Morpho pendente/incerto: recibo duplo ausente; nao reenviar');
   const tipo=file.endsWith('titanMorphoV3Deploy.json')?'v3'
     :file.endsWith('titanMorphoAeroDeploy.json')?'aero':undefined;
   if(!tipo)throw Error('marcador Morpho desconhecido');
   await verify(tipo,receipt.contractAddress,owner,env.MEGAZORD_RPC_URL);
   const confirmed={...m,status:'confirmed',contract:receipt.contractAddress,
     block:receipt.blockNumber,blockHash:receipt.blockHash,reconciled:true};
   const temp=file+'.'+process.pid+'.reconciled';
   const fd=fs.openSync(temp,'wx',0o600);
   try{fs.writeFileSync(fd,JSON.stringify(confirmed));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(temp,file);
   const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
   return receipt.contractAddress;
 }
 if(m.status!=='confirmed'||typeof m.contract!=='string'
   ||!/^0x[0-9a-f]{40}$/i.test(m.contract)
   ||typeof m.hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(m.hash))
   throw Error('deploy Morpho pendente/incerto: reconciliacao externa obrigatoria');
 return getAddress(m.contract);
}
export type DependenciasMorphoBoot={
 verificar:(tipo:Tipo,address:string,owner:string,rpc:string)=>Promise<void>;
 implantar:(tipo:Tipo,env:NodeJS.ProcessEnv)=>Promise<string>;
 recuperar:(file:string,env:NodeJS.ProcessEnv)=>string|undefined|Promise<string|undefined>;
};
async function verificarContrato(tipo:Tipo,address:string,owner:string,rpcUrl:string):Promise<void>{
 const p=new JsonRpcProvider(rpcUrl,8453,{staticNetwork:true});
 try{
   if(BigInt(await p.send('eth_chainId',[]))!==8453n)throw Error('RPC nao e Base');
   if(await p.getCode(address)==='0x')throw Error('contrato Morpho sem bytecode');
   const v=abi.decodeFunctionResult('versaoRotas',await p.call({
     to:address,data:abi.encodeFunctionData('versaoRotas')}))[0] as bigint;
   if(v!==2n)throw Error('executor Morpho sem suporte multihop v2');
   for(const [method,expected] of Object.entries(config(tipo,owner).invariants)){
     const raw=await p.call({to:address,data:abi.encodeFunctionData(method)});
     const found=abi.decodeFunctionResult(method,raw)[0] as string;
     if(getAddress(found)!==getAddress(expected))
       throw Error('identidade do contrato Morpho divergente: '+method);
   }
 }finally{p.destroy();}
}
const dependencias:DependenciasMorphoBoot={
 verificar:verificarContrato,
 implantar:async(tipo,env)=>tipo==='v3'
   ?(await import('./implantarTitanMorphoV3')).implantarTitanMorphoV3(env)
   :(await import('./implantarTitanMorphoAero')).implantarTitanMorphoAero(env),
 recuperar:markerConfirmado,
};
export async function prepararMorphoMegazord(
 env:NodeJS.ProcessEnv,
 deps:DependenciasMorphoBoot=dependencias,
):Promise<{v3:string;aero:string;novos:number}>{
 const key=env.MEGAZORD_CHAVE_PRIVADA;
 const owner=env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO;
 const rpc=env.MEGAZORD_RPC_URL;
 if(!key||!owner||!rpc)throw Error('Megazord requer identidade e RPC para preparar contratos');
 if(new Wallet(key).address.toLowerCase()!==owner.toLowerCase())
   throw Error('Megazord: carteira diverge na preparacao de contratos');
 if(env.CACA_ENVIAR==='1'&&env.MEGAZORD_AUTO_DEPLOY==='1')
   throw Error('auto-deploy nao pode coexistir com CACA_ENVIAR');
 const selecionadas=rotasSelecionadasMegazord(env);
 const found:Record<Tipo,string>={v3:'',aero:''};
 const cached=lerCache(env,owner);
 const planned:Partial<Record<Tipo,string>>={};
 let novos=0;
 // Resolve all SELECTED markers/caches and validate existing executors/caps
 // before any deployment. Unselected engines cannot block or trigger a deploy.
 for(const tipo of selecionadas){
   const c=config(tipo,owner);
   const fromEnv=env[c.env];
   const fromMarker=await deps.recuperar(c.marker,env);
   const fromCache=cached[tipo];
   if([fromEnv,fromMarker,fromCache].filter(Boolean).some(
     addr=>getAddress(addr!)!==getAddress(fromEnv??fromMarker??fromCache!)))
     throw Error('endereco do contrato diverge do marcador/cache persistente: '+tipo);
   const address=fromEnv??fromMarker??fromCache;
   if(!address){
     if(env.MEGAZORD_AUTO_DEPLOY!=='1')
       throw Error('executor Morpho '+tipo+' ausente: auto-deploy nao autorizado');
     // Cost is intentionally NOT implicit. The existing deploy script enforces
     // an additional hard cap of 0.002 ETH, onchain preflight and nonce checks.
     const cap=env[c.cap];
     if(!cap||!/^[0-9]+$/.test(cap)||BigInt(cap)<=0n||BigInt(cap)>2000000000000000n)
       throw Error('limite de gas para deploy ausente/invalido: '+tipo);
   }else{
     if(!/^0x[0-9a-f]{40}$/i.test(address))
       throw Error('endereco Morpho nao e EVM valido: '+tipo);
     await deps.verificar(tipo,address,owner,rpc);
     planned[tipo]=getAddress(address);
   }
 }
 for(const tipo of selecionadas){
   let address=planned[tipo];
   if(!address){
     const local:NodeJS.ProcessEnv={...env,
       CACA_CHAVE_PRIVADA:key,TITAN_CHAVE_PRIVADA:key,
       CACA_ENDERECO_PUBLICO:owner,
       TITAN_EXECUTOR_RPC_URL:rpc,TITAN_NONCE_EXCLUSIVO:env.MEGAZORD_EXCLUSIVO,
       TITAN_DEPLOY_RPC_SECUNDARIO:env.MEGAZORD_RPC_SECUNDARIO,
       ...(tipo==='v3'
         ?{TITAN_MORPHO_V3_DEPLOY:'1',TITAN_MORPHO_V3_CONFIRMAR:'IMPLANTAR_MORPHO_BASE'}
         :{TITAN_MORPHO_AERO_DEPLOY:'1',TITAN_MORPHO_AERO_CONFIRMAR:'IMPLANTAR_MORPHO_BASE'}),
     };
     address=await deps.implantar(tipo,local);
     novos++;
     if(!/^0x[0-9a-f]{40}$/i.test(address))
       throw Error('endereco Morpho nao e EVM valido: '+tipo);
     await deps.verificar(tipo,address,owner,rpc);
   }
   found[tipo]=getAddress(address);
   // Persist immediately after each verified deploy, not only when BOTH finish.
   // A crash between V3 and Aero may retry Aero, but never pays twice for V3.
   cached[tipo]=found[tipo];
   guardarCache(env,cached);
 }
 // Expose runtime addresses only after all selected executors passed checks.
 env.CACA_MORPHO_V3_CONTRATO=found.v3;
 env.CACA_MORPHO_AERO_CONTRATO=found.aero;
 const whitelist=new Set((env.MEGAZORD_CONTRATOS??'').split(',').map(x=>x.trim()).filter(Boolean));
 for(const tipo of selecionadas)whitelist.add(found[tipo]);
 env.MEGAZORD_CONTRATOS=[...whitelist].join(',');
 return {v3:found.v3,aero:found.aero,novos};
}
