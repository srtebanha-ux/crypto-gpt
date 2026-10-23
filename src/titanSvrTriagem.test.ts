import test from 'node:test';
import assert from 'node:assert/strict';
import {triarLeilaoSvr} from './titanSvrTriagem';
import {BASE_ATLAS,BASE_CONTROL} from './titanSvrOperacao';
import type {LeilaoSvr} from './titanSvr';
const id='1bc9a4ce-4fcf-4eb1-8632-959e2273953e';
const base:LeilaoSvr={
 id,hash:'0x'+'1'.repeat(64),atlas:BASE_ATLAS,control:BASE_CONTROL,
 deadline:99999999n,maxFeePerGas:10n,gasDaOracle:20000n,
 dapp:'0x'+'2'.repeat(40),
 precoPrevisto:{aggregador:'0x'+'3'.repeat(40),medianPrice:100000000n},
};
test('missing price hints never become profitable opportunity',()=>{
 const r=triarLeilaoSvr({...base,precoPrevisto:undefined});
 assert.equal(r.prontoParaEnviar,false);
 assert.ok(r.bloqueios.some(x=>x.includes('Sem aggregator')));
});
test('mapped future aggregator and hypothetical deployed solver do not bypass real simulation',()=>{
 const r=triarLeilaoSvr(base,{
  TITAN_SVR_FEEDS:base.precoPrevisto!.aggregador,
  TITAN_SVR_SOLVER_ADDRESS:'0x'+'4'.repeat(40),
 });
 assert.equal(r.prontoParaEnviar,false);
 assert.ok(r.bloqueios.some(x=>x.includes('PRECO FUTURO')));
 assert.ok(!r.bloqueios.some(x=>x.includes('Feed nao habilitado')));
});
test('wrong Atlas and missing mapping fail closed',()=>{
 const r=triarLeilaoSvr({...base,atlas:'0x'+'0'.repeat(40)},{});
 assert.ok(r.bloqueios.some(x=>x.includes('Atlas/DAppControl')));
 assert.ok(r.bloqueios.some(x=>x.includes('Feed nao habilitado')));
 assert.ok(r.bloqueios.some(x=>x.includes('Executor SVR')));
});
