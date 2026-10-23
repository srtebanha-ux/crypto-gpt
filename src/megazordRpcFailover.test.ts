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
 });
 assert.deepEqual(response,{passed:true});
 assert.deepEqual(seen,['https://base.llamarpc.com','https://1rpc.io/base']);
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
