'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {analyze}=require('./rankearMorphoIndexado.cjs');
const base={chain:{id:8453},type:'Liquidation',timestamp:1792353457,
 txHash:'0x'+'1'.repeat(64),logIndex:1,user:{address:'0x'+'2'.repeat(40)},
 market:{marketId:'0x'+'3'.repeat(64)},data:{liquidator:'0x'+'4'.repeat(40),repaidAssets:1}};
test('32 liquidacoes em uma tx contam 32 eventos mas uma unica transacao',()=>{
 const arr=Array.from({length:32},(_,i)=>({...base,logIndex:i+1,user:{address:'0x'+(i+1).toString(16).padStart(40,'0')}}));
 const r=analyze(arr);
 assert.equal(r.validEvents,32);assert.equal(r.ranked[0].liquidations,32);
 assert.equal(r.ranked[0].transactions,1);
 assert.equal(r.ranked[0].borrowers,32);
});
test('nunca mistura arbitrum nem duplica o mesmo evento',()=>{
 const x=analyze([base,base,{...base,chain:{id:42161},logIndex:2}]);
 assert.equal(x.validEvents,1);assert.equal(x.duplicate,1);assert.equal(x.malformed,1);
});
