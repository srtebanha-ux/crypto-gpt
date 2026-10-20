import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import type {MercadoDaApi} from './morphoApi';
import {registrarQuenteMorpho,resumoQuentesMorpho,
  montarLoteMorphoHot,limparQuentesMorpho} from './titanMorphoHot';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
const block=1_801_000_000_000;
const marketId='0x'+'99'.repeat(32);
const oracle='0x'+'55'.repeat(20);
const user1='0x'+'11'.repeat(20),user2='0x'+'22'.repeat(20);
function mercado(confirmado:boolean,id=marketId):MercadoDaApi{
  return {
    id,loanToken:'0x'+'33'.repeat(20),collateralToken:'0x'+'44'.repeat(20),
    oracle,irm:'0x'+'66'.repeat(20),lltv:new Decimal('0.77'),
    bonusPct:new Decimal('7.4'),blocoDaCriacao:0,
    chainId:8453,confirmadoNaCorrente:confirmado,blocoIndexado:null,
  };
}
test('HOT refuses API-only, invalid user, and healthy positions',()=>{
  assert.equal(registrarQuenteMorpho(mercado(false),user1,10n,block),false);
  assert.equal(registrarQuenteMorpho(mercado(true),'garbage',10n,block),false);
  assert.equal(registrarQuenteMorpho(mercado(true),user1,501n,block),false);
});
test('HOT upserts market/user and builds one market + oracle per group',()=>{
  const m=mercado(true);
  assert.equal(registrarQuenteMorpho(m,user1,70n,block),true);
  assert.equal(registrarQuenteMorpho(m,user2,135n,block),true);
  assert.equal(registrarQuenteMorpho(m,user1,40n,block),true);
  const state=resumoQuentesMorpho(block+5);
  assert.equal(state.posicoes,2);
  assert.equal(state.maisProximaBps,'40');
  const records=[
    {mercado:m,usuario:user1,distanciaBps:40n,atualizadoEm:block},
    {mercado:m,usuario:user2,distanciaBps:135n,atualizadoEm:block},
  ];
  const b=montarLoteMorphoHot(records);
  assert.equal(b.calls.length,4); // market,oracle,2 positions; one eth_call
  assert.equal(b.calls[0]?.target,MORPHO_FLASH_BASE);
  assert.equal(b.calls[1]?.target,oracle);
  assert.equal(b.calls[2]?.target,MORPHO_FLASH_BASE);
  assert.equal(b.indices.size,2);
  assert.equal(b.indices.get(m.id.toLowerCase()+'|'+user2.toLowerCase())?.position,3);
  assert.ok(b.calls.every(c=>c.allowFailure));
});
test('HOT forgets old debtors rather than treating stale API as an actionable target',()=>{
  assert.equal(limparQuentesMorpho(block+26*60_000),0);
});
