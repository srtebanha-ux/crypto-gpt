import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatosRpcSecundario,selecionarRpcSecundarioMegazord}
 from './megazordRpcFailover';

test('tries separate RPC providers in order, never accepts the primary twice',async()=>{
 const env:NodeJS.ProcessEnv={MEGAZORD_RPC_URL:'https://mainnet.base.org',
  MEGAZORD_RPC_SECUNDARIO:'https://mainnet.base.org/'};
 assert.deepEqual(candidatosRpcSecundario(env),
   ['https://base.llamarpc.com','https://1rpc.io/base']);
 const seen:string[]=[];
 const response=await selecionarRpcSecundarioMegazord(env,async e=>{
   seen.push(e.MEGAZORD_RPC_SECUNDARIO!);
   if(e.MEGAZORD_RPC_SECUNDARIO==='https://base.llamarpc.com')
     throw Error('RPC HTTP 429');
   return {passed:true};
 },async()=>{});
 assert.deepEqual(response,{passed:true});
 assert.deepEqual(seen,['https://base.llamarpc.com','https://base.llamarpc.com','https://base.llamarpc.com','https://1rpc.io/base']);
 assert.equal(env.MEGAZORD_RPC_SECUNDARIO,'https://1rpc.io/base');
});
test('preflight disagreement cannot be bypassed by using primary as secondary',async()=>{
 const env:NodeJS.ProcessEnv={MEGAZORD_RPC_URL:'https://mainnet.base.org'};
 let calls=0;
 await assert.rejects(selecionarRpcSecundarioMegazord(env,async()=>{
   calls++;throw Error('nonce divergence or rate limit');
 }),/sem fallback inseguro ao principal/);
 assert.equal(calls,2);
 assert.equal(env.MEGAZORD_RPC_SECUNDARIO,undefined);
});
test('explicit secure secondary takes priority and never sends raw RPC URL in failure',async()=>{
 const env:NodeJS.ProcessEnv={
  MEGAZORD_RPC_URL:'https://owner.example/rpc-secret',
  MEGAZORD_RPC_SECUNDARIO:'https://other.example/secret',
 };
 assert.equal(candidatosRpcSecundario(env)[0],'https://other.example/secret');
 await assert.rejects(selecionarRpcSecundarioMegazord(env,async()=>{throw Error('TOKEN_PRIVATE');}),
   err=>err instanceof Error&&!err.message.includes('TOKEN_PRIVATE'));
});

test('transient RPC failure is retried without changing chain/nonce quorum policy',async()=>{
 const e:NodeJS.ProcessEnv={MEGAZORD_RPC_URL:'https://mainnet.base.org',
  MEGAZORD_RPC_SECUNDARIO:'https://base-rpc.publicnode.com'};
 let calls=0;
 const response=await selecionarRpcSecundarioMegazord(e,async env=>{
  assert.equal(env.MEGAZORD_RPC_SECUNDARIO,'https://base-rpc.publicnode.com');
  if(++calls<3)throw Error('RPC HTTP 525');
  return {ready:true};
 },async()=>{});
 assert.equal(calls,3);
 assert.deepEqual(response,{ready:true});
});

test('sanitized diagnostic retains HTTP class but not any private provider URL',async()=>{
 const e:NodeJS.ProcessEnv={MEGAZORD_RPC_URL:'https://owner.example/rpc-secret',
  MEGAZORD_RPC_SECUNDARIO:'https://other.example/secret'};
 await assert.rejects(selecionarRpcSecundarioMegazord(e,async()=>{
  throw Error('RPC HTTP 525 https://other.example/secret');
 },async()=>{}),err=>err instanceof Error&&!err.message.includes('https://')
  &&err.message.includes('outra_rejeicao'));
});
