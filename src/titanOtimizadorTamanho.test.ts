import {test} from 'node:test';
import assert from 'node:assert/strict';
import {otimizarTamanhoTitan} from './titanOtimizadorTamanho';
test('analytic seed is never trusted without complete real economic quote',()=>{
 const called:bigint[]=[];
 const result=otimizarTamanhoTitan(1000n,10n,(q)=>{
  called.push(q);
  // The 'theoretical' optimum at 500 is a bad real route (token tax).
  if(q===500n)return null;
  return q===600n?200n:-20n;
 },32,[500n,600n]);
 assert.ok(called.includes(500n)&&called.includes(600n));
 assert.equal(result?.quantia,600n);
 assert.equal(result?.lucroLiquido,200n);
});
test('no theoretical seed can bypass failing actual quotes',()=>{
 const result=otimizarTamanhoTitan(1000n,10n,()=>null,32,[500n,600n]);
 assert.equal(result,null);
});
test('seeds are deduplicated, bounded and do not exceed quote budget',()=>{
 let calls=0;
 const result=otimizarTamanhoTitan(1000n,10n,()=>{calls++;return -1n},
  8,[1000n,1000n,10000000n,100n,200n,300n]);
 assert.equal(result,null);
 assert.ok(calls<=8);
});
