import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getCreateAddress} from 'ethers';
import {conferirReciboMorpho,aguardarReciboMorpho,rpcsReciboMorpho,type RpcRecibo} from './morphoDeployReceipt';
import {markerConfirmado} from './megazordMorphoBoot';
const owner='0x'+'11'.repeat(20),hash='0x'+'22'.repeat(32),blockHash='0x'+'33'.repeat(32);
const urls:[string,string]=['https://one.invalid','https://two.invalid'];
const address=getCreateAddress({from:owner,nonce:51});
const receipt={transactionHash:hash,from:owner,to:null,status:'0x1',contractAddress:address,
 blockNumber:'0x64',blockHash};
const tx={hash,from:owner,to:null,nonce:'0x33',chainId:'0x2105',blockHash,blockNumber:'0x64'};
function reader(patch:(url:string,method:string,value:any)=>any=(_u,_m,v)=>v,
 seen:string[]=[]):RpcRecibo{
 return async(url,method,params)=>{
  seen.push(method);
  const value=method==='eth_chainId'?'0x2105':method==='eth_blockNumber'?'0x65'
   :method==='eth_getTransactionReceipt'?{...receipt}:method==='eth_getTransactionByHash'?{...tx}:undefined;
  assert.notEqual(value,undefined,'unexpected RPC method, including historical state or broadcast');
  if(method.includes('Transaction'))assert.deepEqual(params,[hash]);
  return patch(url,method,value);
 };
}
test('confirms deployment from two receipts with no archive-state query or broadcast',async()=>{
 const seen:string[]=[];
 assert.deepEqual(await conferirReciboMorpho(hash,owner,51,urls,reader(undefined,seen)),
  {hash,contractAddress:address,blockNumber:100,blockHash});
 assert.equal(seen.length,8);
 assert.equal(seen.some(x=>x==='eth_call'||x==='eth_getBlockByNumber'||x==='eth_sendRawTransaction'),false);
});
test('missing witness remains uncertain instead of authorizing another deployment',async()=>{
 assert.equal(await conferirReciboMorpho(hash,owner,51,urls,reader((url,m,v)=>
  url===urls[1]&&m==='eth_getTransactionReceipt'?null:v)),null);
});
test('wrong chain, nonce, sender, failed transaction, create address and block hash are rejected',async()=>{
 for(const patch of [
  (m:string,v:any)=>m==='eth_chainId'?'0x1':v,
  (m:string,v:any)=>m==='eth_getTransactionByHash'?{...v,nonce:'0x34'}:v,
  (m:string,v:any)=>m==='eth_getTransactionByHash'?{...v,from:'0x'+'44'.repeat(20)}:v,
  (m:string,v:any)=>m==='eth_getTransactionReceipt'?{...v,status:'0x0'}:v,
  (m:string,v:any)=>m==='eth_getTransactionReceipt'?{...v,contractAddress:owner}:v,
  (m:string,v:any)=>m==='eth_getTransactionReceipt'?{...v,blockHash:'0x'+'44'.repeat(32)}:v,
 ])await assert.rejects(conferirReciboMorpho(hash,owner,51,urls,reader((_u,m,v)=>patch(m,v))));
});
test('same host cannot act as two independent receipt witnesses',()=>{
 assert.throws(()=>rpcsReciboMorpho('https://same.invalid/a','https://same.invalid/b'),/independentes/);
});
test('conflicting mined blocks between independent RPCs cannot confirm a marker',async()=>{
 await assert.rejects(conferirReciboMorpho(hash,owner,51,urls,reader((url,m,v)=>
  url===urls[1]&&(m==='eth_getTransactionReceipt'||m==='eth_getTransactionByHash')
   ?{...v,blockNumber:'0x63'}:v)),/discordam/);
});
test('transient confirmation failure can recover by hash without resubmitting',async()=>{
 let failed=false;let sleeps=0;const valid=reader();
 const read:RpcRecibo=async(...args)=>{
  if(!failed){failed=true;throw Error('RPC indisponivel na confirmacao do deploy; marcador preservado');}
  return valid(...args);
 };
 assert.equal((await aguardarReciboMorpho(hash,owner,51,urls,read,async()=>{sleeps++;})).contractAddress,address);
 assert.equal(sleeps,1);
});
test('reserved marker is reconciled only after two receipts and contract identity checks',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'morpho-recovery-'));
 const file=path.join(dir,'titanMorphoV3Deploy.json');
 const reserved={status:'reserved',hash,nonce:51};
 const env={MEGAZORD_ENDERECO_PUBLICO:owner,MEGAZORD_RPC_URL:urls[0],MEGAZORD_RPC_SECUNDARIO:urls[1]};
 try{
  fs.writeFileSync(file,JSON.stringify(reserved));
  await assert.rejects(markerConfirmado(file,env,reader(),async()=>{throw Error('immutable mismatch');}),/immutable/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),reserved);
  let checked=false;
  assert.equal(await markerConfirmado(file,env,reader(),async(kind,at,who)=>{
   assert.equal(kind,'v3');assert.equal(at,address);assert.equal(who,owner);checked=true;
  }),address);
  assert.equal(checked,true);
  const recovered=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(recovered.status,'confirmed');assert.equal(recovered.reconciled,true);
  assert.equal(recovered.hash,hash);assert.equal(recovered.nonce,51);
  assert.equal(await markerConfirmado(file,env,async()=>{throw Error('must not query again');}),address);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
