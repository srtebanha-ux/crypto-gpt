import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatosRpcSecundario,selecionarRpcSecundarioMegazord,selecionarParRpcMegazord}
 from './megazordRpcFailover';

test('tries separate RPC providers in order, never accepts the primary twice',async()=>{
 const env:NodeJS.ProcessEnv={MEGAZORD_RPC_URL:'https://mainnet.base.org',
  MEGAZORD_RPC_SECUNDARIO:'https://mainnet.base.org/'};
 assert.deepEqual(candidatosRpcSecundario(env),
   ['https://base.llamarpc.com','https://1rpc.io/base',
    'https://base-rpc.publicnode.com','https://base.drpc.org']);
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
 assert.equal(calls,4);
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

test('JSON-RPC error response retries without accepting invalid results or weakening nonce',async()=>{
 const env:NodeJS.ProcessEnv={
  MEGAZORD_RPC_URL:'https://mainnet.base.org',
  MEGAZORD_RPC_SECUNDARIO:'https://base-rpc.publicnode.com',
 };
 let attempts=0;
 const result=await selecionarRpcSecundarioMegazord(env,async current=>{
  assert.equal(current.MEGAZORD_RPC_SECUNDARIO,'https://base-rpc.publicnode.com');
  attempts++;
  if(attempts<3)throw Error('resposta RPC invalida');
  return {verified:true};
 },async()=>{});
 assert.equal(attempts,3);
 assert.deepEqual(result,{verified:true});
});
test('persistent invalid JSON-RPC replies fail closed without signer authorization',async()=>{
 const env:NodeJS.ProcessEnv={
  MEGAZORD_RPC_URL:'https://mainnet.base.org',
  MEGAZORD_RPC_SECUNDARIO:'https://base-rpc.publicnode.com',
 };
 let attempts=0;
 await assert.rejects(selecionarRpcSecundarioMegazord(env,async()=>{
  attempts++;throw Error('resposta RPC invalida');
 },async()=>{}),/sem fallback inseguro ao principal/);
 assert.equal(attempts,12);
});

test('aliases on one host cannot serve as independent witness; configured alternatives precede public ones',()=>{
 assert.deepEqual(candidatosRpcSecundario({MEGAZORD_RPC_URL:'https://private.example/key1',
  MEGAZORD_RPC_SECUNDARIO:'https://private.example/key2',
  MEGAZORD_RPC_ALTERNATIVOS:'https://independent.example/key,https://independent.example/other'}).slice(0,2),
  ['https://independent.example/key','https://mainnet.base.org']);
});
test('real boot read gate attributes a persistent primary failure once, not to four secondaries',async()=>{
 const {criarRpcPreflight}=await import('./megazordRpcLeitura');
 const {conferirRedeMegazord}=await import('./megazordPreflight');
 let calls=0;
 const rpc=criarRpcPreflight({esperar:async()=>{},fetcher:(async(_u,i)=>{
  calls++;return new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(String(i?.body)).id,
   error:{code:-32005,message:'https://secret.invalid/KEY'}}));
 }) as typeof fetch});
 await assert.rejects(selecionarRpcSecundarioMegazord({MEGAZORD_RPC_URL:'https://p.example/private',
  MEGAZORD_RPC_SECUNDARIO:'https://s.example/private',MEGAZORD_ENDERECO_PUBLICO:'0x'+'11'.repeat(20),
  MEGAZORD_CONTRATOS:'0x'+'22'.repeat(20)},e=>conferirRedeMegazord(e,rpc),async()=>{}),
  e=>e instanceof Error&&e.message.includes('principal')&&e.message.includes('eth_chainId;jsonrpc_-32005')
   &&!e.message.includes('private')&&!e.message.includes('KEY'));
 assert.equal(calls,3,'no outer 3x4 retry amplification on the broken primary');
});


test('failed primary block read promotes a healthy independent pair, never self-witness',async()=>{
 const {FalhaLeituraRede}=await import('./megazordPreflight');
 const {FalhaRpcLeitura}=await import('./megazordRpcLeitura');
 const env:NodeJS.ProcessEnv={
  MEGAZORD_RPC_URL:'https://broken.example/private',
  MEGAZORD_RPC_SECUNDARIO:'https://healthy.example/private',
  MEGAZORD_RPC_ALTERNATIVOS:'https://witness.example/secret',
 };
 const pairs:string[]=[];
 const result=await selecionarParRpcMegazord(env,async e=>{
  pairs.push(e.MEGAZORD_RPC_URL+' '+e.MEGAZORD_RPC_SECUNDARIO);
  if(e.MEGAZORD_RPC_URL?.includes('broken.example'))
    throw new FalhaLeituraRede(0,new FalhaRpcLeitura('no block','eth_getBlockByNumber','body_invalido',3));
  assert.equal(e.MEGAZORD_RPC_URL,'https://healthy.example/private');
  assert.equal(e.MEGAZORD_RPC_SECUNDARIO,'https://witness.example/secret');
  return {checks:[{rpc:0},{rpc:1}],scope:'verified'};
 },async()=>{});
 assert.deepEqual(result,{checks:[{rpc:0},{rpc:1}],scope:'verified'});
 assert.equal(pairs.length,2,'never retry a rejected primary against every witness');
 assert.equal(env.MEGAZORD_RPC_URL,'https://healthy.example/private');
 assert.equal(env.MEGAZORD_RPC_SECUNDARIO,'https://witness.example/secret');
});

test('primary failover cannot bypass financial nonce disagreement',async()=>{
 const env:NodeJS.ProcessEnv={MEGAZORD_RPC_URL:'https://broken.example/key',
  MEGAZORD_RPC_SECUNDARIO:'https://good.example/key'};
 let calls=0;
 await assert.rejects(selecionarParRpcMegazord(env,async()=>{
  calls++;throw Error('RPCs discordam sobre nonce/bloco');
 },async()=>{}),/invariante financeira divergente/);
 assert.equal(calls,1);
 assert.equal(env.MEGAZORD_RPC_URL,'https://broken.example/key');
});

test('eight-primary fallback reaches publicnode + dRPC only after full independent preflight',async()=>{
 const {FalhaLeituraRede}=await import('./megazordPreflight');
 const {FalhaRpcLeitura}=await import('./megazordRpcLeitura');
 const env:NodeJS.ProcessEnv={
   MEGAZORD_RPC_URL:'https://broken1.example/secret',
   MEGAZORD_RPC_SECUNDARIO:'https://broken2.example/secret',
   MEGAZORD_RPC_ALTERNATIVOS:'https://broken3.example/secret,https://broken4.example/secret',
 };
 let attempted=0;
 const response=await selecionarParRpcMegazord(env,async e=>{
   attempted++;
   if(e.MEGAZORD_RPC_URL!=='https://base-rpc.publicnode.com')
     throw new FalhaLeituraRede(0,
       new FalhaRpcLeitura('private upstream body','eth_getBlockByNumber','body_invalido',3));
   if(e.MEGAZORD_RPC_SECUNDARIO!=='https://base.drpc.org')
     throw Error('preflight semantic failure');
   return {ready:true,independent:true};
 },async()=>{});
 assert.deepEqual(response,{ready:true,independent:true});
 assert.ok(attempted>=7);
 assert.equal(env.MEGAZORD_RPC_URL,'https://base-rpc.publicnode.com');
 assert.equal(env.MEGAZORD_RPC_SECUNDARIO,'https://base.drpc.org');
});
