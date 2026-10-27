import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lerRiscoEconomico,margemLiquidaDinamica} from './titanRiscoEconomico';
import {politicaMorphoV3,pisoEconomicoMorphoV3} from './titanMorphoV3Gate';
import {calcularPisoTitan} from './titanExecucao';
const env={MEGAZORD_PISO_DINAMICO:'1',MEGAZORD_FALHA_MAX_BPS:'2000',MEGAZORD_MARGEM_RISCO_BPS:'500'};
test('sucessos cobrem o custo esperado das falhas e margem adicional',()=>{
 const r=lerRiscoEconomico(env)!;
 assert.equal(margemLiquidaDinamica(100n,r),30n); // 20/80*100 + 5
 assert.equal(margemLiquidaDinamica(1n,r),2n);
 assert.ok((130n-100n)*8000n-100n*2000n>0n);
 assert.equal(calcularPisoTitan(100n,env).lucroBrutoMinimoWei,130n);
});
test('lucro pequeno passa, lucro esperado negativo não; piso explícito é preservado',()=>{
 const p=politicaMorphoV3(env);
 assert.equal(pisoEconomicoMorphoV3(1000n,130n,100n,p).aprovado,true);
 assert.equal(pisoEconomicoMorphoV3(1000n,110n,100n,p).aprovado,false);
 assert.equal(calcularPisoTitan(100n,{...env,TITAN_MIN_LUCRO_WEI:'50'}).lucroBrutoMinimoWei,150n);
});
test('risco ausente, impossível ou margem zero não habilitam modo dinâmico',()=>{
 assert.equal(lerRiscoEconomico({}),null);
 for(const patch of [{MEGAZORD_FALHA_MAX_BPS:undefined},{MEGAZORD_FALHA_MAX_BPS:'10000'},
  {MEGAZORD_MARGEM_RISCO_BPS:'0'},{MEGAZORD_FALHA_MAX_BPS:'NaN'}])
  assert.throws(()=>lerRiscoEconomico({...env,...patch}));
});
