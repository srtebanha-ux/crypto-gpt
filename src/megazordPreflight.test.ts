import test from 'node:test';
import assert from 'node:assert/strict';
import {conferirRedeMegazord} from './megazordPreflight';
const env={MEGAZORD_RPC_URL:'rpc-a',MEGAZORD_RPC_SECUNDARIO:'rpc-b',
 MEGAZORD_ENDERECO_PUBLICO:'0x'+'11'.repeat(20),MEGAZORD_CONTRATOS:'0x'+'22'.repeat(20)};
const rpc=async(_u:string,m:string):Promise<unknown>=>{
 switch(m){
 case 'eth_chainId':return '0x2105';
 case 'eth_getBlockByNumber':return {number:'0x64',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
 case 'eth_getTransactionCount':return '0x0';
 case 'eth_getBalance':return '0x1';
 case 'eth_getCode':return '0x6000';
 default:throw Error('unexpected method '+m);
 }
};
test('public preflight uses only read methods and reports both endpoints',async()=>{
 const r=await conferirRedeMegazord(env,rpc);assert.equal(r.readOnly,true);assert.equal(r.checks.length,2);
});
test('public preflight rejects wrong chain, missing code and zero gas',async()=>{
 for(const [method,result] of [['eth_chainId','0x1'],['eth_getCode','0x'],['eth_getBalance','0x0']]){
  await assert.rejects(conferirRedeMegazord(env,async(u,m)=>m===method?result:rpc(u,m)));
 }
});
test('public preflight rejects nonce disagreement and missing public settings',async()=>{
 await assert.rejects(conferirRedeMegazord(env,async(u,m)=>u==='rpc-b'&&m==='eth_getTransactionCount'?'0x1':rpc(u,m)),/discordam/);
 await assert.rejects(conferirRedeMegazord({},rpc),/configuracao/);
});
test('old blocks and pending nonces never become readiness approvals',async()=>{
 await assert.rejects(conferirRedeMegazord(env,async(u,m,p)=>
   m==='eth_getTransactionCount'&&p[1]==='pending'?'0x1':rpc(u,m)),/nonce pendente/);
 await assert.rejects(conferirRedeMegazord(env,async(u,m)=>
   m==='eth_getBlockByNumber'?{number:'0x64',timestamp:'0x1'}:rpc(u,m)),/bloco ausente ou antigo/);
});

test('two RPC witnesses are checked sequentially to avoid shared rate-limit bursts',async()=>{
 const seen:string[]=[];
 const result=await conferirRedeMegazord(env,async(u,m,p)=>{
  seen.push(u);
  return rpc(u,m);
 });
 assert.equal(result.checks.length,2);
 assert.ok(seen.length>=12);
 const firstOther=seen.indexOf('rpc-b');
 assert.ok(firstOther>0);
 assert.ok(seen.slice(0,firstOther).every(x=>x==='rpc-a'));
 assert.ok(seen.slice(firstOther).every(x=>x==='rpc-b'));
});

test('readiness never overlaps calls to a rate-limited Base provider',async()=>{
 let active=0,maximum=0;
 await conferirRedeMegazord(env,async(u,m,p)=>{
  active++;maximum=Math.max(maximum,active);
  await Promise.resolve();
  try{return await rpc(u,m);}finally{active--;}
 });
 assert.equal(maximum,1);
});


test('null latest block must recover only through a valid numbered block on each independent RPC',async()=>{
 const {FalhaLeituraRede}=await import('./megazordPreflight');
 const {FalhaRpcLeitura}=await import('./megazordRpcLeitura');
 const calls:string[]=[];
 const result=await conferirRedeMegazord(env,async(u,m,p)=>{
   calls.push(u+':'+m+':'+String(p?.[0]??''));
   if(m==='eth_getBlockByNumber'&&p[0]==='latest')
     throw new FalhaLeituraRede(u==='rpc-a'?0:1,
       new FalhaRpcLeitura('null latest','eth_getBlockByNumber','body_invalido',3));
   if(m==='eth_blockNumber')return '0x66';
   if(m==='eth_getBlockByNumber'){
     assert.equal(p[0],'0x65');
     return {number:'0x65',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
   }
   return rpc(u,m);
 });
 assert.equal(result.checks[0].block,101);
 assert.equal(result.checks[1].block,101);
 assert.equal(calls.filter(x=>x.includes(':eth_blockNumber:')).length,2);
});
test('numbered block fallback cannot legalize an old block or a failed RPC',async()=>{
 const {FalhaLeituraRede}=await import('./megazordPreflight');
 const {FalhaRpcLeitura}=await import('./megazordRpcLeitura');
 await assert.rejects(conferirRedeMegazord(env,async(u,m,p)=>{
   if(m==='eth_getBlockByNumber'&&p[0]==='latest')
     throw new FalhaLeituraRede(u==='rpc-a'?0:1,
       new FalhaRpcLeitura('null','eth_getBlockByNumber','resultado_ausente',3));
   if(m==='eth_blockNumber')return '0x66';
   if(m==='eth_getBlockByNumber')return {number:'0x65',timestamp:'0x1'};
   return rpc(u,m);
 }),/bloco ausente ou antigo/);
});
