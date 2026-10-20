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
test('Morpho V3 gate requires confirmed market AND threshold already crossed',()=>{
 assert.equal(candidatoElegivelV3('proxima',true),false);
 assert.equal(candidatoElegivelV3('cruzou-estimado',false),false);
 assert.equal(candidatoElegivelV3('cruzou-estimado',true),true);
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
