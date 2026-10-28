import test from 'node:test';
import assert from 'node:assert/strict';
import {conferirModoMegazord,iniciarMegazord,manterLiquidanteMegazord,alinharMaxEnviosMegazord,
 type DependenciasBootMegazord} from './megazord';
import {Wallet} from 'ethers';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
test('refuses inherited financial authorization before engine loading',async()=>{
 for(const key of ['CACA_ENVIAR','TITAN_ENVIAR','TITAN_V2_ENVIAR',
   'CACA_MORPHO_V3_ENVIAR','CACA_MULTIHOP_ENVIAR','ARB_ENVIAR']){
   let loaded=false;
   await assert.rejects(iniciarMegazord({MEGAZORD_MODO:'observacao',[key]:'1'},async()=>{
     loaded=true;return{liquidacoes:async()=>{},arbitragem:async()=>{}};
   }),/recusa envio/);
   assert.equal(loaded,false);
 }
 assert.throws(()=>conferirModoMegazord({MEGAZORD_MODO:'real'}),/observacao/);
});

function bootFixture(){
 const events:string[]=[];
 const raw='11'.repeat(32);
 const env:NodeJS.ProcessEnv={MEGAZORD_MODO:'execucao',
   MEGAZORD_CONFIRMAR:'OPERAR_BASE_REAL',MEGAZORD_EXCLUSIVO:'1',
   CACA_CHAVE_PRIVADA:raw,CACA_ENDERECO_PUBLICO:new Wallet(raw).address,
   MEGAZORD_DIARIO:'/app/data/fixture.json',MEGAZORD_RPC_URL:'rpc-a',
   MEGAZORD_RPC_SECUNDARIO:'rpc-b',MEGAZORD_MAX_TX_DIA:'1',
   MEGAZORD_GAS_MAX_TX_WEI:'100',MEGAZORD_GAS_MAX_DIA_WEI:'200'};
 let checks=0;
 const deps:DependenciasBootMegazord={
   identidades:async()=>{events.push('identidades');},
   rede:async e=>{
     events.push('rede');checks++;
     assert.notEqual(e.CACA_MORPHO_V3_ENVIAR,'1');
     if(checks===1)assert.equal(e.MEGAZORD_CONTRATOS,MORPHO_FLASH_BASE);
     else assert.notEqual(e.MEGAZORD_CONTRATOS,MORPHO_FLASH_BASE);
     return {readOnly:true,address:e.CACA_ENDERECO_PUBLICO!,checks:[
       {rpc:0,block:1,nonce:'0',balanceWei:'10000',contractsWithCode:1},
       {rpc:1,block:1,nonce:'0',balanceWei:'10000',contractsWithCode:1},
     ],scope:'fixture'};
   },
   preco:async()=>{events.push('preco');return {ethUsd:'2000',minimoWei:'1'};},
   morpho:async e=>{
     events.push('deploy-morpho');
     assert.equal(e.MEGAZORD_CHAVE_PRIVADA,'0x'+raw);
     e.MEGAZORD_CONTRATOS='0x'+'22'.repeat(20);
     return {v3:'0x'+'22'.repeat(20),aero:'0x'+'33'.repeat(20),novos:2};
   },
   aave:async()=>{events.push('aave');return null;},
   atualizar:()=>{events.push('atualizacao');return ()=>{};},
 };
 const load=async()=>{
   events.push('engines');
   assert.equal(env.CACA_MORPHO_V3_ENVIAR,'1');
   return {liquidacoes:async()=> 'parar' as const,arbitragem:()=>new Promise<void>(()=>{})};
 };
 return {env,deps,events,load};
}
test('invalid budgets abort before network reads, deployment and engine imports',async()=>{
 const f=bootFixture();delete f.env.MEGAZORD_GAS_MAX_TX_WEI;
 await assert.rejects(iniciarMegazord(f.env,f.load,f.deps),/orcamento Megazord invalido/);
 assert.deepEqual(f.events,[]);
});
test('network and price failures happen before any paid contract preparation',async()=>{
 for(const stage of ['rede','preco'] as const){
   const f=bootFixture();
   f.deps[stage]=async()=>{f.events.push(stage);throw Error(stage+' unavailable');};
   await assert.rejects(iniciarMegazord(f.env,f.load,f.deps),/unavailable/);
   assert.ok(!f.events.includes('deploy-morpho'));
   assert.ok(!f.events.includes('engines'));
   assert.notEqual(f.env.CACA_MORPHO_V3_ENVIAR,'1');
 }
});
test('pre-deploy readiness is repeated for actual executors and price before arming',async()=>{
 const f=bootFixture();
 await assert.rejects(iniciarMegazord(f.env,f.load,f.deps),/liquidacoes encerrou/);
 assert.deepEqual(f.events,['rede','preco','deploy-morpho','aave','rede','identidades','preco','atualizacao','engines']);
 assert.equal(f.env.CACA_MAX_ENVIOS,'1');
 assert.equal(f.env.CACA_CHAVE_PRIVADA,f.env.MEGAZORD_CHAVE_PRIVADA);
});
test('failed final readiness never arms strategies even after contract preparation',async()=>{
 const f=bootFixture();let n=0;
 f.deps.preco=async()=>{if(++n===2)throw Error('quote expired');return {ethUsd:'2000',minimoWei:'1'};};
 await assert.rejects(iniciarMegazord(f.env,f.load,f.deps),/quote expired/);
 assert.notEqual(f.env.CACA_MORPHO_V3_ENVIAR,'1');
 assert.ok(!f.events.includes('engines'));
});
test('starts both engines concurrently and reports configuration stop',async()=>{
 const started:string[]=[];
 let finish!:(value:'parar')=>void;
 const liquidacoes=new Promise<'parar'>(r=>{finish=r;});
 const execution=iniciarMegazord({MEGAZORD_MODO:'observacao'},async()=>({
   liquidacoes:()=>{started.push('liquidacoes');return liquidacoes;},
   arbitragem:()=>{started.push('arbitragem');return new Promise<void>(()=>{});},
 }));
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(started,['liquidacoes','arbitragem']);
 finish('parar');await assert.rejects(execution,/liquidacoes encerrou: configuracao invalida/);
});
test('propagates engine error instead of reporting both healthy',async()=>{
 await assert.rejects(iniciarMegazord({MEGAZORD_MODO:'observacao'},async()=>({
   liquidacoes:()=>new Promise<void>(()=>{}),
   arbitragem:async()=>{throw Error('rpc offline');},
 })),/rpc offline/);
});

test('liquidator transient boot returns and RPC errors retry without restarting arbitrage',async()=>{
 let calls=0,waits=0;
 const result=await manterLiquidanteMegazord(async()=>{
   calls++;
   if(calls===1)return;
   if(calls===2)throw Error('temporary RPC outage');
   return 'parar';
 },async()=>{waits++;});
 assert.equal(result,'parar');assert.equal(calls,3);assert.equal(waits,2);
});

test('financial mode rejects missing identity before importing scanner engines',async()=>{
 let loaded=false;
 await assert.rejects(iniciarMegazord({
   MEGAZORD_MODO:'execucao',
   MEGAZORD_CONFIRMAR:'OPERAR_BASE_REAL',
   MEGAZORD_EXCLUSIVO:'1',
 },async()=>{
   loaded=true;return{liquidacoes:async()=>{},arbitragem:async()=>{}};
 }),/carteira publica e credencial/);
 assert.equal(loaded,false,'no scanners or signer may start without identity');
});

test('Megazord entrypoint aligns CACA window to global 250 daily cap before CACA import',()=>{
 const env:NodeJS.ProcessEnv={MEGAZORD_MODO:'execucao',MEGAZORD_MAX_TX_DIA:'250'};
 alinharMaxEnviosMegazord(env);
 assert.equal(env.CACA_MAX_ENVIOS,'250');
 const smaller:NodeJS.ProcessEnv={...env,CACA_MAX_ENVIOS:'15'};
 alinharMaxEnviosMegazord(smaller);
 assert.equal(smaller.CACA_MAX_ENVIOS,'15','operator quota must be preserved');
 assert.throws(()=>alinharMaxEnviosMegazord({
   ...env,CACA_MAX_ENVIOS:'251'}),/CACA_MAX_ENVIOS/);
 assert.throws(()=>alinharMaxEnviosMegazord({
   ...env,MEGAZORD_MAX_TX_DIA:'251'}),/MEGAZORD_MAX_TX_DIA/);
 const observer:NodeJS.ProcessEnv={MEGAZORD_MODO:'observacao',MEGAZORD_MAX_TX_DIA:'250'};
 alinharMaxEnviosMegazord(observer);
 assert.equal(observer.CACA_MAX_ENVIOS,undefined,'observation has no live defaults');
});

 test('codehash audit failure stops boot before arming or loading engines',async()=>{
 const f=bootFixture();f.deps.identidades=async()=>{throw Error('bytecode diverge');};
 await assert.rejects(iniciarMegazord(f.env,f.load,f.deps),/bytecode diverge/);
 assert.notEqual(f.env.CACA_MORPHO_V3_ENVIAR,'1');assert.ok(!f.events.includes('engines'));
});

test('full boot can pass preliminary read gate but fail the executor read; reports exact phase without arming',async()=>{
 const {criarRpcPreflight}=await import('./megazordRpcLeitura');
 const {conferirRedeMegazord}=await import('./megazordPreflight');
 const {selecionarRpcSecundarioMegazord}=await import('./megazordRpcFailover');
 const f=bootFixture();
 f.env.MEGAZORD_RPC_URL='https://primary.example/secret';f.env.MEGAZORD_RPC_SECUNDARIO='https://secondary.example/secret';
 let witnessReads=0,executorReads=0;
 const rpc=criarRpcPreflight({esperar:async()=>{},fetcher:(async(_u,init)=>{
  const {id,method,params}=JSON.parse(String(init?.body));let result:unknown;
  if(method==='eth_chainId')result='0x2105';
  else if(method==='eth_getBlockByNumber')result={number:'0x64',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
  else if(method==='eth_getTransactionCount')result='0x0';
  else if(method==='eth_getBalance')result='0x1';
  else if(method==='eth_getCode'){
   if(params[0]!==MORPHO_FLASH_BASE){executorReads++;return new Response(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32602,message:'secret'}}));}
   witnessReads++;result='0x6000';
  }else throw Error('unexpected method');
  return new Response(JSON.stringify({jsonrpc:'2.0',id,result}));
 }) as typeof fetch});
 f.deps.rede=async e=>await selecionarRpcSecundarioMegazord(e,x=>conferirRedeMegazord(x,rpc),async()=>{}) as Awaited<ReturnType<typeof conferirRedeMegazord>>;
 await assert.rejects(iniciarMegazord(f.env,f.load,f.deps),e=>e instanceof Error
  &&e.message.includes('fase=rede_pos_contratos')&&e.message.includes('preflight requisicao RPC invalida: sem envio')
  &&!e.message.includes('secret'));
 assert.equal(witnessReads,2);assert.equal(executorReads,1);
 assert.notEqual(f.env.CACA_MORPHO_V3_ENVIAR,'1');assert.ok(!f.events.includes('engines'));
 assert.equal(f.env.MEGAZORD_RPC_URL,'https://primary.example/secret','credential normalization must not mutate URL');
});
