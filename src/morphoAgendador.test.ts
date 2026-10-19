import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agendarDescobertaMorpho,type RelogioMorpho} from './morphoAgendador';

test('discovery starts immediately, rejects overlap and repeats after completion',async()=>{
 let start=0,finish:()=>void=()=>{},cb:()=>void=()=>{},clear=false;
 const clock:RelogioMorpho={
  agendar:(fn,ms)=>{assert.equal(ms,3600000);cb=fn;return{unref:()=>{}};},
  cancelar:()=>{clear=true},
 };
 const scheduler=agendarDescobertaMorpho(
  async()=>{start++;await new Promise<void>(r=>{finish=r})},
  3600000,()=>{},clock,
 );
 assert.equal(start,1);
 cb(); // second scheduler invocation during first pending promise
 assert.equal(start,1,'no duplicate HTTP/RPC fetch is allowed');
 assert.equal(scheduler.estado().puladasPorSobreposicao,1);
 finish();await new Promise<void>(r=>setImmediate(r));
 assert.equal(scheduler.estado().concluidas,1);
 const p=scheduler.rodarAgora();assert.equal(start,2);finish();await p;
 assert.equal(scheduler.estado().concluidas,2);
 scheduler.parar();assert.equal(clear,true);
 assert.equal(await scheduler.rodarAgora(),false);
});
test('failure does not kill next periodic discovery',async()=>{
 let n=0,err=0;const clock:RelogioMorpho={
  agendar:()=>({}),cancelar:()=>{},
 };
 const s=agendarDescobertaMorpho(async()=>{if(++n===1)throw Error('RPC limit')},
  900000,()=>{err++},clock);
 await new Promise<void>(r=>setImmediate(r));
 assert.equal(s.estado().falhas,1);
 assert.equal(err,1);
 assert.equal(await s.rodarAgora(),true);
 assert.equal(s.estado().concluidas,1);s.parar();
});
test('refuse unbounded/overly-frequent scans',()=>{
 const clock:RelogioMorpho={agendar:()=>({}),cancelar:()=>{}};
 for(const ms of [0,-1,30000,899999,86400001,Infinity,NaN,3600000.5]){
  assert.throws(()=>agendarDescobertaMorpho(async()=>{},ms,()=>{},clock));
 }
});
