import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Transaction,keccak256,Wallet,id,type TransactionResponse} from 'ethers';
import {ExecutorMegazord,instalarEncerramentoMegazord,conferirIdentidadeMegazord,creditoGasComprovado,usdcEmWethWeiConservador,
 type RedeMegazord,type PoliticaMegazord} from './megazordExecutor';
const key='0x'+'11'.repeat(32); // Offline fixture only, never funded.
const target='0x'+'22'.repeat(20);
function fixture(override:Partial<PoliticaMegazord>={},quotes?:()=>Promise<readonly [string,string]>){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'megazord-test-'));
 let nonce=0,timeout=false,preflightFails=false;
 const sent:number[]=[];
 const receipts=new Map<string,{status:number;blockNumber:number;logs?:{address:string;topics:string[];data:string}[]}>();
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
 const build=()=>new ExecutorMegazord(key,provider,provider,policy,async()=>1n,quotes);
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

test('only WETH paid by executor to authorized treasury credits self-funded gas',async()=>{
 const WETH='0x4200000000000000000000000000000000000006';
 const treasury='0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
 const topic=(address:string)=>'0x'+address.toLowerCase().slice(2).padStart(64,'0');
 const log={address:WETH,topics:[id('Transfer(address,address,uint256)'),
   topic(target),topic(treasury)],data:'0x'+(50000n).toString(16).padStart(64,'0')};
 const p={hash:'0x'+'55'.repeat(32),nonce:0,strategy:'liquidacao',day:'2026-10-23',
   reservedWei:'21002',to:target};
 const r={status:1,blockNumber:1234,logs:[log]};
 assert.equal(creditoGasComprovado(p,r,r),21002n);
 assert.equal(creditoGasComprovado(p,r,null),0n);
 assert.equal(creditoGasComprovado(p,{...r,status:0},r),0n);
 assert.equal(creditoGasComprovado(p,r,{...r,blockNumber:1235}),0n);
 assert.equal(creditoGasComprovado(p,{...r,logs:[{...log,data:'0x'+(10000n).toString(16).padStart(64,'0')}]},r),0n);
 assert.equal(creditoGasComprovado(p,{...r,logs:[{...log,address:target}]},r),0n);
 assert.equal(creditoGasComprovado(p,{...r,logs:[{...log,topics:[log.topics[0],topic(target),topic(target)]}]},r),0n);
});
test('onchain WETH transfer proof renews uncovered budget but never daily tx count',async()=>{
 const f=fixture({maxDailyWei:40000n,maxDailyTx:2});try{
   await f.e.run('liquidacao',async()=>{
     const tx=await f.e.broadcast(await f.raw(0));await tx.wait();
   });
   const [hash]=f.receipts.keys();
   const rec=f.receipts.get(hash)!;
   const topic=(address:string)=>'0x'+address.toLowerCase().slice(2).padStart(64,'0');
   rec.logs=[{address:'0x4200000000000000000000000000000000000006',
     topics:[id('Transfer(address,address,uint256)'),topic(target),
       topic('0x3dffA934170bdD491724747Be2c4F56E3f1512A7')],
     data:'0x'+(50000n).toString(16).padStart(64,'0')}];
   await f.e.reconcile();
   await f.e.run('liquidacao',async()=>{
     const tx=await f.e.broadcast(await f.raw(1));await tx.wait();
   });
   assert.deepEqual(f.sent,[0,1]);
   const journal=JSON.parse(fs.readFileSync(f.policy.journal,'utf8'));
   const today=new Date().toISOString().slice(0,10);
   assert.equal(journal.days[today].creditedWei,'21002');
   assert.equal(journal.days[today].attempts,2);
   await assert.rejects(f.e.run('liquidacao',async()=>f.e.broadcast(await f.raw(2))),
     /orcamento global/);
 }finally{f.cleanup();}
});

test('USDC to WETH uses TWO validated on-chain ETH/USDC prices and conservative haircut',()=>{
 const same:['2000.000000000000','2000.000000000000']=['2000.000000000000','2000.000000000000'];
 assert.equal(usdcEmWethWeiConservador(2000000n,same),950000000000000n);
 assert.equal(usdcEmWethWeiConservador(2000000n,
   ['2000.000000000000','2010.000000000000']),945273631840796n);
 assert.throws(()=>usdcEmWethWeiConservador(2000000n,
   ['2000.000000000000','2050.000000000000']),/oraculos divergem/);
 assert.throws(()=>usdcEmWethWeiConservador(2000000n,
   ['0.000000000000','2000.000000000000']),/TWAP invalido|faixa/);
});
test('USDC treasury receipts on both RPCs credit budget, other stables not assumed pegged',()=>{
 const usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
 const topic=(address:string)=>'0x'+address.toLowerCase().slice(2).padStart(64,'0');
 const log={address:usdc,topics:[id('Transfer(address,address,uint256)'),
   topic(target),topic('0x3dffA934170bdD491724747Be2c4F56E3f1512A7')],
   data:'0x'+(2000000n).toString(16).padStart(64,'0')};
 const p={hash:'0x'+'44'.repeat(32),nonce:3,strategy:'morpho',day:'2026-10-23',
   reservedWei:'400000000000000',to:target};
 const r={status:1,blockNumber:9001,logs:[log]};
 const quote:['2000.000000000000','2010.000000000000']=[
   '2000.000000000000','2010.000000000000'];
 assert.equal(creditoGasComprovado(p,r,r),0n,'WETH-only proof not enough for USDC');
 assert.equal(creditoGasComprovado(p,r,r,quote),400000000000000n);
 assert.equal(creditoGasComprovado(p,r,{...r,blockNumber:9000},quote),0n);
 assert.equal(creditoGasComprovado(p,r,{...r,
   logs:[{...log,data:'0x'+(1900000n).toString(16).padStart(64,'0')}]},quote),0n);
 assert.equal(creditoGasComprovado(p,r,r,
   ['2000.000000000000','2050.000000000000']),0n);
 assert.equal(creditoGasComprovado(p,{...r,
   logs:[{...log,address:'0xd9AAeC86B65D86f6A7B5B1b0c42FFA531710b6CA'}]},r,quote),0n);
 const small={...r,logs:[{...log,data:'0x'+(100000n).toString(16).padStart(64,'0')}]};
 assert.equal(creditoGasComprovado(p,small,small,quote),0n);
});
test('USDC credit works during reconcile, but never without a two-RPC oracle result',async()=>{
 const prices:()=>Promise<readonly [string,string]>=async()=>[
   '2000.000000000000','2000.000000000000'];
 const f=fixture({maxDailyWei:40000n,maxDailyTx:2},prices);
 try{
   await f.e.run('morpho',async()=>{const tx=await f.e.broadcast(await f.raw(0));await tx.wait();});
   const [hash]=f.receipts.keys();
   const rec=f.receipts.get(hash)!;
   const topic=(address:string)=>'0x'+address.toLowerCase().slice(2).padStart(64,'0');
   rec.logs=[{address:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
     topics:[id('Transfer(address,address,uint256)'),topic(target),
       topic('0x3dffA934170bdD491724747Be2c4F56E3f1512A7')],
     data:'0x'+(2000000n).toString(16).padStart(64,'0')}];
   await f.e.reconcile();
   const journal=JSON.parse(fs.readFileSync(f.policy.journal,'utf8'));
   const day=new Date().toISOString().slice(0,10);
   assert.equal(journal.days[day].creditedWei,'21002');
   await f.e.run('morpho',async()=>{const tx=await f.e.broadcast(await f.raw(1));await tx.wait();});
   assert.equal(f.sent.length,2);
 }finally{f.cleanup();}
});

test('SIGTERM Railway libera lock exclusivamente quando executor esta ocioso',()=>{
 const {EventEmitter}=require('node:events') as typeof import('node:events');
 const proc=new EventEmitter();
 let exits=0;
 const falso={
  once:(evento:string,listener:()=>void)=>{proc.once(evento,listener);return falso;},
  exit:(_:number)=>{exits++;proc.emit('exit');return undefined as never;},
 } as unknown as Pick<NodeJS.Process,'once'|'exit'>;
 const f=fixture();
 try{
  const lock=f.policy.journal+'.lock';
  assert.equal(fs.existsSync(lock),true);
  instalarEncerramentoMegazord(f.e,falso);
  proc.emit('SIGTERM');
  assert.equal(exits,1);
  assert.equal(fs.existsSync(lock),false);
  const novo=f.build();
  novo.close();
  proc.emit('exit');
  assert.equal(exits,1);
 }finally{f.cleanup();}
});

test('SIGINT fecha executor somente uma vez e remove lock sem trabalho pendente',()=>{
 const {EventEmitter}=require('node:events') as typeof import('node:events');
 const proc=new EventEmitter();
 let fechamentos=0,exits=0;
 const falso={
  once:(evento:string,listener:()=>void)=>{proc.once(evento,listener);return falso;},
  exit:(_:number)=>{exits++;return undefined as never;},
 } as unknown as Pick<NodeJS.Process,'once'|'exit'>;
 instalarEncerramentoMegazord({close:()=>{fechamentos++;}},falso);
 proc.emit('SIGINT');
 proc.emit('exit');
 assert.equal(fechamentos,1);
 assert.equal(exits,1);
});
