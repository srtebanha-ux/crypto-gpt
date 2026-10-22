import test from 'node:test';
import assert from 'node:assert/strict';
import {conferirModoMegazord,iniciarMegazord} from './megazord';
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
