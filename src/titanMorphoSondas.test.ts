import test from 'node:test';
import assert from 'node:assert/strict';
import {sondarMorphoEmLotes} from './titanMorphoSondas';

test('probes overlap, never exceed four, retain every candidate in input order',async()=>{
 let active=0,max=0;
 const seen:number[]=[];
 const result=await sondarMorphoEmLotes([0,1,2,3,4,5,6,7,8],async n=>{
   active++;max=Math.max(max,active);seen.push(n);
   await new Promise<void>(resolve=>setImmediate(resolve));
   active--;
   return n*2;
 });
 assert.equal(max,4);
 assert.equal(active,0);
 assert.deepEqual(seen,[0,1,2,3,4,5,6,7,8]);
 assert.deepEqual(result.map(r=>r.status==='fulfilled'?r.value:null),[0,2,4,6,8,10,12,14,16]);
});
test('a failed or synchronously throwing probe does not abandon other routes',async()=>{
 const seen:number[]=[];
 const result=await sondarMorphoEmLotes([0,1,2,3,4],n=>{
   seen.push(n);
   if(n===1)throw Error('bad route');
   if(n===3)return Promise.reject(Error('RPC failure'));
   return Promise.resolve(n);
 });
 assert.deepEqual(seen,[0,1,2,3,4]);
 assert.deepEqual(result.map(r=>r.status),['fulfilled','rejected','fulfilled','rejected','fulfilled']);
});
test('an empty probe set makes no calls',async()=>{
 let calls=0;
 assert.deepEqual(await sondarMorphoEmLotes([],async()=>++calls),[]);
 assert.equal(calls,0);
});
