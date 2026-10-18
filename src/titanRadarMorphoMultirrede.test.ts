import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analisarEventosMorpho,REDES_MORPHO_RADAR} from './titanRadarMorphoMultirrede';
const h=(v:string)=>'0x'+v.repeat(64);
const addr=(v:string)=>'0x'+v.repeat(40);
test('Base and Arbitrum are first; other supported Morpho networks remain read-only',()=>{
 assert.equal(REDES_MORPHO_RADAR[0].chainId,8453);
 assert.equal(REDES_MORPHO_RADAR[1].chainId,42161);
 assert.equal(REDES_MORPHO_RADAR.length,6);
});
test('count liquidation events separately from distinct transactions and borrowers',()=>{
 const body={data:{marketTransactions:{items:[
   {txHash:h('a'),data:{liquidator:addr('1')}},
   {txHash:h('a'),data:{liquidator:addr('1')}},
   {txHash:h('b'),data:{liquidator:addr('2')}},
 ]}}};
 const r=analisarEventosMorpho('Base',8453,body);
 assert.equal(r.eventos,3);assert.equal(r.transacoesUnicas,2);
 assert.equal(r.lideres[0].eventos,2);assert.equal(r.lideres[0].transacoesUnicas,1);
});
test('missing indexer data is not silently counted as no liquidation',()=>{
 assert.throws(()=>analisarEventosMorpho('Base',8453,{errors:[{message:'unauthorized'}]}),/Indexer/);
 assert.throws(()=>analisarEventosMorpho('Arbitrum',42161,{}),/Missing/);
});
