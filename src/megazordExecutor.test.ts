import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Transaction,keccak256,Wallet,type TransactionResponse} from 'ethers';
import {ExecutorMegazord,conferirIdentidadeMegazord,
 type RedeMegazord,type PoliticaMegazord} from './megazordExecutor';
const key='0x'+'11'.repeat(32); // Offline fixture only, never funded.
const target='0x'+'22'.repeat(20);
function fixture(override:Partial<PoliticaMegazord>={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'megazord-test-'));
 let nonce=0,timeout=false,preflightFails=false;
 const sent:number[]=[];
 const receipts=new Map<string,{status:number;blockNumber:number}>();
 const provider:RedeMegazord={
   getNetwork:async()=>({chainId:8453n}),
   getBlock:async()=>({number:100,timestamp:Math.floor(Date.now()/1000)}),
   getTransactionCount:async()=>nonce,
   getTransactionReceipt:async hash=>receipts.get(hash)??null,
   call:async()=>{if(preflightFails)throw Error('preflight reverted');return '0x';},
   broadcastTransaction:async raw=>{
     const t=Transaction.from(raw);sent.push(t.nonce);
     if(timeout)throw Error('timeout after RPC acceptance');
     const hash=keccak256(raw);
     return {hash,wait:async()=>{
       await new Promise(r=>setTimeout(r,5));
       const receipt={status:1,blockNumber:101};receipts.set(hash,receipt);nonce++;
       return receipt;
     }} as unknown as TransactionResponse;
   },
 };
 const policy={journal:path.join(dir,'journal.json'),maxDailyWei:100000n,
   maxPerTxWei:30000n,maxDailyTx:4,contracts:[target],...override};
 const build=()=>new ExecutorMegazord(key,provider,provider,policy,async()=>1n);
 const e=build();
 const raw=(n:number)=>e.sign({chainId:8453,type:2,nonce:n,to:target,data:'0x1234',
   value:0n,gasLimit:21000n,maxFeePerGas:1n,maxPriorityFeePerGas:1n});
 const cleanup=()=>{e.close();fs.rmSync(dir,{recursive:true,force:true});};
 return {e,raw,dir,policy,provider,sent,receipts,build,cleanup,
   timeout:()=>{timeout=true;},failPreflight:()=>{preflightFails=true;}};
}
test('both strategies serialize through receipt and receive distinct nonces',async()=>{
 const f=fixture();try{
   const order:string[]=[];
   const submit=(name:string,n:number)=>f.e.run(name,async()=>{
     order.push(name);const raw=await f.raw(n);const tx=await f.e.broadcast(raw);await tx.wait();
   });
   await Promise.all([submit('arbitragem',0),submit('liquidacao',1)]);
   await f.e.reconcile();
   assert.deepEqual(order,['arbitragem','liquidacao']);assert.deepEqual(f.sent,[0,1]);
   const journal=JSON.parse(fs.readFileSync(f.policy.journal,'utf8'));
   assert.equal(journal.pending,null);assert.equal(journal.receipts.length,2);
   assert.equal(journal.receipts[0].strategy,'arbitragem');
   assert.equal(journal.receipts[1].strategy,'liquidacao');
 }finally{f.cleanup();}
});
test('timeout preserves hash and blocks another strategy, including after restart',async()=>{
 const f=fixture();try{
   f.timeout();let hash='';
   await assert.rejects(f.e.run('arbitragem',async()=>{
     const raw=await f.raw(0);hash=keccak256(raw);await f.e.broadcast(raw);
   }),/timeout/);
   assert.equal(JSON.parse(fs.readFileSync(f.policy.journal,'utf8')).pending.hash,hash);
   await assert.rejects(f.e.run('liquidacao',async()=>{}),/resultado pendente/);
   f.e.close();const recovered=f.build();
   try{
     await assert.rejects(recovered.run('liquidacao',async()=>{}),/resultado pendente/);
     f.receipts.set(hash,{status:0,blockNumber:102});
     await assert.rejects(recovered.run('liquidacao',async()=>{}),/circuit breaker Megazord/);
     const journal=JSON.parse(fs.readFileSync(f.policy.journal,'utf8'));
     assert.equal(journal.pending,null);assert.equal(journal.receipts[0].status,0);
     assert.equal(f.sent.length,1,'unknown transaction was never sent again');
     // Revert recorded durably must also block the NEXT request.
     await assert.rejects(recovered.run('arbitragem',async()=>{}),/circuit breaker Megazord/);
   }finally{recovered.close();}
 }finally{f.cleanup();}
});
test('global budget is shared across strategies and reserved before broadcast',async()=>{
 const f=fixture({maxDailyWei:40000n});try{
   await f.e.run('arbitragem',async()=>{const tx=await f.e.broadcast(await f.raw(0));await tx.wait();});
   await assert.rejects(f.e.run('liquidacao',async()=>f.e.broadcast(await f.raw(1))),/orcamento global/);
   assert.equal(f.sent.length,1);
 }finally{f.cleanup();}
});
test('lock rejects a second owner and wrong key, chain, nonce or contract never broadcasts',async()=>{
 const f=fixture();try{
   assert.throws(f.build,/executor ja reservado/);
   assert.throws(()=>f.e.wallet('0x'+'33'.repeat(32)),/mesma carteira/);
   await assert.rejects(f.e.sign({}),/fora da fila/);
   await assert.rejects(f.e.run('x',async()=>f.e.broadcast(await f.raw(2))),/nonce envelheceu/);
   for(const tx of [{chainId:1,to:target},{chainId:8453,to:'0x'+'44'.repeat(20)}]){
     await assert.rejects(f.e.run('x',async()=>f.e.broadcast(await f.e.sign({
       ...tx,type:2,nonce:0,data:'0x1234',gasLimit:21000n,maxFeePerGas:1n,maxPriorityFeePerGas:1n,
     }))),/fora da politica/);
   }
   assert.equal(f.sent.length,0);
 }finally{f.cleanup();}
});
test('failed preflight leaves no reservation or broadcast',async()=>{
 const f=fixture();try{
   f.failPreflight();await assert.rejects(f.e.run('x',async()=>f.e.broadcast(await f.raw(0))),/preflight reverted/);
   assert.equal(f.sent.length,0);assert.equal(fs.existsSync(f.policy.journal),false);
 }finally{f.cleanup();}
});
test('work escaping its callback cannot retain signing authorization',async()=>{
 const f=fixture();try{
   let later!:Promise<string>;
   await f.e.run('x',async()=>{
     later=new Promise(resolve=>setTimeout(()=>{
       f.raw(0).then(()=>resolve('unexpected signature'),e=>resolve(e.message));
     },10));
   });
   assert.match(await later,/fora da fila/);assert.equal(f.sent.length,0);
 }finally{f.cleanup();}
});
test('corrupted journal is rejected before execution',()=>{
 const f=fixture();try{
   f.e.close();fs.writeFileSync(f.policy.journal,'{"version":999}');
   assert.throws(f.build,/diario Megazord invalido/);
 }finally{f.cleanup();}
});

test('execution reuses only the authorized wallet and mounted journal',()=>{
 const valid={MEGAZORD_CHAVE_PRIVADA:key,
   MEGAZORD_ENDERECO_PUBLICO:new Wallet(key).address,
   MEGAZORD_DIARIO:'/app/data/megazord-diario.json'};
 const verified=conferirIdentidadeMegazord(valid);
 assert.equal(verified.address.toLowerCase(),valid.MEGAZORD_ENDERECO_PUBLICO.toLowerCase());
 assert.equal(verified.journal,valid.MEGAZORD_DIARIO);
 assert.throws(()=>conferirIdentidadeMegazord({...valid,MEGAZORD_ENDERECO_PUBLICO:target}),/carteira existente/);
 assert.throws(()=>conferirIdentidadeMegazord({...valid,MEGAZORD_DIARIO:'/tmp/megazord.json'}),/volume persistente/);
 assert.throws(()=>conferirIdentidadeMegazord({...valid,MEGAZORD_DIARIO:'/app/data/../tmp/megazord.json'}),/volume persistente/);
 assert.throws(()=>conferirIdentidadeMegazord({...valid,MEGAZORD_DIARIO:'/app/data/megazord'}),/volume persistente/);
 assert.throws(()=>conferirIdentidadeMegazord({...valid,MEGAZORD_CHAVE_PRIVADA:'not-a-key'}),/credencial Megazord invalida/);
});
