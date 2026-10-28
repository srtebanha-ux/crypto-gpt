/**
 * Public, read-only Morpho Aerodrome runtime audit:
 * 1. A confirmed persistent marker identifies an already-deployed executor.
 * 2. Both Base RPCs agree on the same block and EXACT live code.
 * 3. The runtime equals our reproducibly compiled Solidity bytecode after
 *    replacing ONLY the immutable reference slots supplied by solc.
 * 4. Each immutable getter and the Morpho route version agree onchain.
 * Never signs, never sends, never auto-approves a codehash or writes secrets.
 */
import fs from 'node:fs';
import {Interface,getAddress,keccak256} from 'ethers';
import {ProviderMorphoRpc} from './morphoProvider';
import {COFRE_ESPERADO} from './caca';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';

const markerFile='/app/data/titanMorphoAeroDeploy.json';
const manifestFile='.tmp/artifacts/AeroRuntimeAudit.json';
const AERO_ROUTER='0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const AERO_FACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const abi=new Interface([
 'function dono() view returns(address)','function cofre() view returns(address)',
 'function morpho() view returns(address)',
 'function aerodromeRouter() view returns(address)',
 'function aerodromeFactory() view returns(address)',
 'function versaoRotas() view returns(uint256)',
]);
export type AeroManifest={version:string;runtime:string;
 immutableReferences:Record<string,Array<{start:number;length:number}>>};
export function checarBytecodeAero(
 live:string,manifest:AeroManifest,immutables:readonly string[],
):{ok:boolean;reason:string}{
 if(!/^0x[0-9a-f]+$/i.test(live)||!/^0x[0-9a-f]+$/i.test(manifest.runtime)
    ||live.length!==manifest.runtime.length
    ||manifest.version!=='0.8.26')
   return{ok:false,reason:'bytecode-ou-versao-divergente'};
 let compiled=manifest.runtime.slice(2).toLowerCase();
 const actual=live.slice(2).toLowerCase();
 const allowed=new Set(immutables.map(a=>getAddress(a).slice(2).toLowerCase().padStart(64,'0')));
 let patched=0;
 const seen=new Set<number>();
 for(const refs of Object.values(manifest.immutableReferences??{})){
   for(const {start,length} of refs){
     if(!Number.isSafeInteger(start)||start<0||length!==32
       ||seen.has(start)||start*2+64>compiled.length)
       return{ok:false,reason:'immutable-offset-invalido'};
     seen.add(start);
     const slot=actual.slice(start*2,start*2+64);
     if(!allowed.has(slot))return{ok:false,reason:'immutable-inesperado'};
     if(!/^0{64}$/.test(compiled.slice(start*2,start*2+64)))
       return{ok:false,reason:'referencia-nao-nula-no-template'};
     compiled=compiled.slice(0,start*2)+slot+compiled.slice(start*2+64);
     patched++;
   }
 }
 if(patched<5)return{ok:false,reason:'immutables-incompletas'};
 return compiled===actual?{ok:true,reason:'compilacao-e-immutables-conferidos'}
   :{ok:false,reason:'bytecode-fora-das-referencias-diverge'};
}
export async function auditarAeroImplantadoSomenteLeitura(env:NodeJS.ProcessEnv):Promise<{
 somenteLeitura:true;endereco:string;codehash:string;solc:string;
 bloco:string;hashBloco:string;rpcConcordantes:2;deployPago:false;
}>{
 const parsed=JSON.parse(fs.readFileSync(markerFile,'utf8')) as {
   status?:unknown;contract?:unknown;hash?:unknown;nonce?:unknown;
 };
 if(parsed.status!=='confirmed'
   ||typeof parsed.contract!=='string'
   ||typeof parsed.hash!=='string'
   ||!/^0x[0-9a-f]{64}$/i.test(parsed.hash))
   throw Error('marcador-de-deploy-nao-confirmado');
 const contract=getAddress(parsed.contract);
 const owner=getAddress(env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO??'');
 const urls=[env.MEGAZORD_RPC_URL,env.MEGAZORD_RPC_SECUNDARIO];
 if(!urls[0]||!urls[1]||urls[0]===urls[1])
   throw Error('dois-rpcs-independentes-exigidos');
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')) as AeroManifest;
 const immutables=[owner,COFRE_ESPERADO,MORPHO_FLASH_BASE,AERO_ROUTER,AERO_FACTORY];
 const p1=new ProviderMorphoRpc(urls[0]),p2=new ProviderMorphoRpc(urls[1]);
 try{
   const block=await p1.send('eth_getBlockByNumber',['latest',false]) as
     {number:string;hash:string}|null;
   if(!block?.number||!/^0x[0-9a-f]{64}$/i.test(block.hash))
     throw Error('bloco-invalido');
   const codehashes:string[]=[];
   for(const p of [p1,p2]){
     const network=BigInt(await p.send('eth_chainId',[]));
     if(network!==8453n)throw Error('rpc-fora-da-base');
     const same=await p.send('eth_getBlockByNumber',[block.number,false]) as
       {hash?:string}|null;
     if(same?.hash?.toLowerCase()!==block.hash.toLowerCase())
       throw Error('rpcs-divergem-no-bloco');
     const receipt=await p.send('eth_getTransactionReceipt',[parsed.hash]) as
       {status?:string;contractAddress?:string;from?:string;nonce?:string}|null;
     if(receipt?.status!=='0x1'||!receipt.contractAddress
       ||getAddress(receipt.contractAddress)!==contract
       ||!receipt.from||getAddress(receipt.from)!==owner)
       throw Error('deploy-sem-recibo-conciliado-com-proprietario');
     const code=await p.send('eth_getCode',[contract,block.number]) as string;
     const template=checarBytecodeAero(code,manifest,immutables);
     if(!template.ok)throw Error(template.reason);
     for(const [method,expected] of Object.entries({
       dono:owner,cofre:COFRE_ESPERADO,morpho:MORPHO_FLASH_BASE,
       aerodromeRouter:AERO_ROUTER,aerodromeFactory:AERO_FACTORY,
     })){
       const data=await p.send('eth_call',[{
         to:contract,data:abi.encodeFunctionData(method),
       },block.number]) as string;
       const found=getAddress(abi.decodeFunctionResult(method,data)[0] as string);
       if(found!==getAddress(expected))throw Error('imutavel-'+method+'-divergente');
     }
     const version=abi.decodeFunctionResult('versaoRotas',await p.send('eth_call',[{
       to:contract,data:abi.encodeFunctionData('versaoRotas'),
     },block.number]) as string)[0] as bigint;
     if(version!==2n)throw Error('executor-multihop-invalido');
     codehashes.push(keccak256(code));
   }
   if(codehashes[0]!==codehashes[1])throw Error('rpcs-divergem-no-codehash');
   return{somenteLeitura:true,endereco:contract,codehash:codehashes[0]!,
     solc:manifest.version,bloco:block.number,hashBloco:block.hash,
     rpcConcordantes:2,deployPago:false};
 }finally{p1.destroy();p2.destroy();}
}
