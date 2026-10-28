/** Read-only deployment checks. Never imports a signer or broadcasts. */
import {isAddress} from 'ethers';
import {criarRpcPreflight} from './megazordRpcLeitura';
type Rpc=(url:string,method:string,params:unknown[])=>Promise<unknown>;
const call:Rpc=criarRpcPreflight();
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
   const [chain,block,latest,pending,balance,...codes]=await Promise.all([
     rpc(url!,'eth_chainId',[]),rpc(url!,'eth_getBlockByNumber',['latest',false]),
     rpc(url!,'eth_getTransactionCount',[address,'latest']),
     rpc(url!,'eth_getTransactionCount',[address,'pending']),
     rpc(url!,'eth_getBalance',[address,'latest']),
     ...contracts.map(a=>rpc(url!,'eth_getCode',[a,'latest'])),
   ]);
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
