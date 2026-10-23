import test from 'node:test';
import assert from 'node:assert/strict';
import {politicaMorphoV3,candidatoElegivelV3,custoConservadorMorphoV3,pisoEconomicoMorphoV3} from './titanMorphoV3Gate';
test('Morpho V3 cannot sign when Aave CACA is allowed to sign same wallet',()=>{
 const env={CACA_MORPHO_V3_ENVIAR:'1',CACA_MORPHO_V3_CONFIRMAR:'OPERAR_MORPHO_BASE',
 CACA_MORPHO_V3_NONCE_EXCLUSIVO:'1',CACA_ENVIAR:'1'};
 assert.equal(politicaMorphoV3(env).armed,false);
 assert.equal(politicaMorphoV3({...env,CACA_ENVIAR:'0'}).armed,true);
 assert.equal(politicaMorphoV3({...env,CACA_ENVIAR:'0',CACA_MORPHO_V3_CONFIRMAR:'NO'}).armed,false);
});
test('Morpho probe admission accepts near confirmed positions; economic/send gates remain separate',()=>{
 assert.equal(candidatoElegivelV3('proxima',true),true);
 assert.equal(candidatoElegivelV3('cruzou-estimado',false),false);
 assert.equal(candidatoElegivelV3('cruzou-estimado',true),true);
 assert.equal(candidatoElegivelV3('segura',true),false);
 assert.equal(candidatoElegivelV3('proxima',false),false);
});
test('gas includes Base L1, worst-case L2, margin and hard ceiling',()=>{
 const p=politicaMorphoV3({});
 const r=custoConservadorMorphoV3(600000n,30000000n,20000000n,100000000000n,p);
 assert.equal(r.gasLimit,720000n);
 assert.equal(r.maxFee,80000000n);
 assert.equal(r.custo,57800000000000n);
 assert.throws(()=>custoConservadorMorphoV3(1200000n,30000000n,20000000n,100000000000n,p),/gas exceeds/);
 assert.throws(()=>custoConservadorMorphoV3(600000n,3000000000n,20000000n,100000000000n,p),/cost exceeds/);
});
test('minimum enforceable profit must cover costs after onchain conversion',()=>{
 const p=politicaMorphoV3({});
 assert.equal(pisoEconomicoMorphoV3(10000000n,150n,100n,p).aprovado,true);
 assert.equal(pisoEconomicoMorphoV3(10000000n,100n,100n,p).aprovado,false);
 assert.equal(pisoEconomicoMorphoV3(10000000n,0n,100n,p).aprovado,false);
 assert.equal(pisoEconomicoMorphoV3(0n,200n,100n,p).aprovado,false);
});

test('Aero uses independent explicit send gates without inheriting V3 arming',async()=>{
 const {politicaMorphoAero}=await import('./titanMorphoV3Gate');
 const v3={CACA_MORPHO_V3_ENVIAR:'1',CACA_MORPHO_V3_CONFIRMAR:'OPERAR_MORPHO_BASE',CACA_MORPHO_V3_NONCE_EXCLUSIVO:'1'};
 assert.equal(politicaMorphoV3(v3).armed,true);assert.equal(politicaMorphoAero(v3).armed,false);
 const aero={CACA_MORPHO_V3_AVALIAR:'0',CACA_MORPHO_AERO_ENVIAR:'1',
  CACA_MORPHO_AERO_CONFIRMAR:'OPERAR_MORPHO_BASE',CACA_MORPHO_AERO_NONCE_EXCLUSIVO:'1'};
 assert.equal(politicaMorphoAero(aero).armed,true);assert.equal(politicaMorphoV3(aero).armed,false);
 assert.equal(politicaMorphoAero({...aero,CACA_ENVIAR:'1'}).armed,false);
});

test('Megazord paid Morpho gates reject stale USD oracle and accept recent signed quote',()=>{
 const flags={MEGAZORD_MODO:'execucao',CACA_MORPHO_V3_ENVIAR:'1',
  CACA_MORPHO_V3_CONFIRMAR:'OPERAR_MORPHO_BASE',
  CACA_MORPHO_V3_NONCE_EXCLUSIVO:'1',
  CACA_MORPHO_V3_RETORNO_BPS:'10005',
  CACA_MORPHO_V3_LUCRO_MIN_WETH_WEI:'350'};
 assert.equal(politicaMorphoV3(flags).armed,false);
 const recent={...flags,MEGAZORD_COTACAO_ATUALIZADA_EM_MS:String(Date.now())};
 assert.equal(politicaMorphoV3(recent).armed,true);
 assert.equal(politicaMorphoV3({...recent,
  MEGAZORD_COTACAO_ATUALIZADA_EM_MS:String(Date.now()-120000)}).armed,false);
 const p=politicaMorphoV3(recent);
 assert.equal(p.minReturnBps,10005n);
 assert.equal(pisoEconomicoMorphoV3(100000n,450n,100n,p).aprovado,true);
 assert.equal(pisoEconomicoMorphoV3(100000n,449n,100n,p).aprovado,false);
});
