/** Read-only deployment confirmation. Never requests historical block state. */
import {getAddress,getCreateAddress} from 'ethers';
export type RpcRecibo=(url:string,method:string,params:unknown[])=>Promise<any>;
const methods=new Set(['eth_chainId','eth_blockNumber','eth_getTransactionReceipt','eth_getTransactionByHash']);
const rpc:RpcRecibo=async(url,method,params)=>{
 if(!methods.has(method))throw Error('metodo fora da confirmacao somente leitura');
 try{
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
  const body=await response.json() as any;
  if(!response.ok||body.error||body.id!==1||!Object.prototype.hasOwnProperty.call(body,'result'))throw Error();
  return body.result;
 }catch{throw Error('RPC indisponivel na confirmacao do deploy; marcador preservado');}
};
export function rpcsReciboMorpho(primary:string,secondary?:string):[string,string]{
 const a=primary.replace(/\/+$/,'');
 const b=(secondary??(a==='https://mainnet.base.org'
  ?'https://base-rpc.publicnode.com':'https://mainnet.base.org')).replace(/\/+$/,'');
 if(!a.startsWith('https://')||!b.startsWith('https://')||new URL(a).host===new URL(b).host)
  throw Error('confirmacao de deploy exige dois RPCs HTTPS independentes');
 return [a,b];
}
function qty(value:unknown):bigint{
 if(typeof value!=='string'||!/^0x[0-9a-f]+$/i.test(value))throw Error('quantidade de recibo invalida');
 return BigInt(value);
}
export type ReciboDeployMorpho={hash:string;contractAddress:string;blockNumber:number;blockHash:string};
export async function conferirReciboMorpho(
 hash:string,owner:string,nonce:number,urls:[string,string],read:RpcRecibo=rpc,
):Promise<ReciboDeployMorpho|null>{
 if(!/^0x[0-9a-f]{64}$/i.test(hash)||!Number.isSafeInteger(nonce)||nonce<0)
  throw Error('identidade do deploy invalida');
 rpcsReciboMorpho(...urls);
 const expected=getCreateAddress({from:owner,nonce});
 const results=await Promise.all(urls.map(async url=>{
  if(qty(await read(url,'eth_chainId',[]))!==8453n)throw Error('recibo fora da Base');
  const receipt=await read(url,'eth_getTransactionReceipt',[hash]);
  if(!receipt)return null;
  const tx=await read(url,'eth_getTransactionByHash',[hash]);
  const head=qty(await read(url,'eth_blockNumber',[]));
  if(!tx||tx.hash?.toLowerCase()!==hash.toLowerCase()
   ||receipt.transactionHash?.toLowerCase()!==hash.toLowerCase()
   ||getAddress(tx.from)!==getAddress(owner)||getAddress(receipt.from)!==getAddress(owner)
   ||tx.to!==null||receipt.to!==null||qty(tx.nonce)!==BigInt(nonce)
   ||qty(tx.chainId)!==8453n||qty(receipt.status)!==1n
   ||getAddress(receipt.contractAddress)!==expected
   ||!/^0x[0-9a-f]{64}$/i.test(receipt.blockHash)
   ||tx.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase()
   ||qty(tx.blockNumber)!==qty(receipt.blockNumber)||head<qty(receipt.blockNumber))
   throw Error('recibo/identidade do deploy divergente; nao reenviar');
  const blockNumber=Number(qty(receipt.blockNumber));
  if(!Number.isSafeInteger(blockNumber))throw Error('bloco do deploy invalido');
  return {hash,contractAddress:expected,blockNumber,blockHash:receipt.blockHash.toLowerCase()};
 }));
 if(!results[0]||!results[1])return null;
 if(JSON.stringify(results[0])!==JSON.stringify(results[1]))
  throw Error('RPCs discordam do recibo de deploy; nao reenviar');
 return results[0];
}
export async function aguardarReciboMorpho(hash:string,owner:string,nonce:number,
 urls:[string,string],read:RpcRecibo=rpc,
 wait:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms)),
):Promise<ReciboDeployMorpho>{
 const deadline=Date.now()+120000;
 for(let attempt=0;attempt<60&&Date.now()<deadline;attempt++){
  try{const receipt=await conferirReciboMorpho(hash,owner,nonce,urls,read);if(receipt)return receipt;}
  catch(e){if(!(e instanceof Error)||!e.message.startsWith('RPC indisponivel'))throw e;}
  if(attempt<59&&Date.now()<deadline)await wait(Math.min(2000,deadline-Date.now()));
 }
 throw Error('deploy sem recibo duplo confirmado; marcador preservado, nao reenviar');
}
