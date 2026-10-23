import test from 'node:test';
import assert from 'node:assert/strict';
import {conferirModoMegazord,iniciarMegazord,manterLiquidanteMegazord,alinharMaxEnviosMegazord} from './megazord';
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
