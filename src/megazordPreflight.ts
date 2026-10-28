/** Read-only deployment checks. Never imports a signer or broadcasts. */
import {isAddress} from 'ethers';
import {criarRpcPreflight,FalhaRpcLeitura} from './megazordRpcLeitura';
type Rpc=(url:string,method:string,params:unknown[])=>Promise<unknown>;
const call:Rpc=criarRpcPreflight();
export class FalhaLeituraRede extends Error {
 constructor(readonly rpcIndex:number,readonly detalhe:FalhaRpcLeitura){
  super('RPC '+rpcIndex+' ['+detalhe.method+';'+detalhe.categoria+';tentativas='+detalhe.tentativas+']');
 }
}

function quantity(value:unknown):bigint{
 if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))throw Error('quantidade RPC invalida');
 return BigInt(value);
}
export async function conferirRedeMegazord(env:NodeJS.ProcessEnv,rpc:Rpc=call){
 const urls=[env.MEGAZORD_RPC_URL,env.MEGAZORD_RPC_SECUNDARIO];
 const address=env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO;
 const contracts=(env.MEGAZORD_CONTRATOS??'').split(',').map(x=>x.trim()).filter(Boolean);
 if(!urls[0]||!urls[1]||urls[0]===urls[1]||!address||!isAddress(address)
   ||!contracts.length||contracts.some(x=>!isAddress(x)))throw Error('configuracao publica incompleta');
 // Public RPCs can share egress quotas. Validate one independent witness at
 // a time instead of bursting both simultaneously, without skipping any check.
 const results=[] as Array<{rpc:number;block:number;nonce:string;balanceWei:string;contractsWithCode:number}>;
 for(const [index,url] of urls.entries()){
   const read=async(method:string,params:unknown[])=>{
     try{return await rpc(url!,method,params);}
     catch(e){if(e instanceof FalhaRpcLeitura)throw new FalhaLeituraRede(index,e);throw e;}
   };
   // Public Base RPC gateways rate-limit bursts even from one client.
   // Preflight is infrequent: serialize each method per provider, preserving
   // every invariant and each provider's independent nonce/block witness.
   const chain=await read('eth_chainId',[]);
   const block=await read('eth_getBlockByNumber',['latest',false]);
   const latest=await read('eth_getTransactionCount',[address,'latest']);
   const pending=await read('eth_getTransactionCount',[address,'pending']);
   const balance=await read('eth_getBalance',[address,'latest']);
   const codes:string[]=[];
   for(const contract of contracts)
     codes.push(await read('eth_getCode',[contract,'latest']) as string);
   if(quantity(chain)!==8453n)throw Error('RPC '+index+': rede diferente da Base');
   const b=block as {number?:unknown;timestamp?:unknown}|null;
   if(!b||Math.abs(Date.now()/1000-Number(quantity(b.timestamp)))>20)
     throw Error('RPC '+index+': bloco ausente ou antigo');
   if(quantity(latest)!==quantity(pending))throw Error('RPC '+index+': nonce pendente');
   if(codes.some(c=>typeof c!=='string'||!/^0x[0-9a-f]+$/i.test(c)||c==='0x0'))
     throw Error('RPC '+index+': destino sem bytecode valido');
   if(quantity(balance)===0n)throw Error('RPC '+index+': saldo de gas zerado');
   results.push({rpc:index,block:Number(quantity(b.number)),nonce:quantity(latest).toString(),
     balanceWei:quantity(balance).toString(),contractsWithCode:codes.length});
 }
 if(results[0].nonce!==results[1].nonce||Math.abs(results[0].block-results[1].block)>3)
   throw Error('RPCs discordam sobre nonce/bloco');
 return {readOnly:true,address,checks:results,
   scope:'Rede, nonce, saldo e presenca de bytecode; nao comprova identidade do contrato, lucro ou prontidao dos protocolos.'};
}
if(require.main===module){
 void conferirRedeMegazord(process.env).then(r=>console.log(JSON.stringify(r))).catch(()=>{
   // Upstream errors can embed credential-bearing URLs. Keep console output generic.
   console.error('Preflight de rede falhou; confira configuracao publica e disponibilidade dos RPCs.');
   process.exitCode=1;
 });
}
