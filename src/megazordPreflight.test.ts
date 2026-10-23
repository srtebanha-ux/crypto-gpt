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
