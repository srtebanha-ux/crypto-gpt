import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {confirmarMultiHopAave,habilitarAaveMultiHopMegazord,
 type MultiBootLeitor} from './megazordAaveMultiBoot';
import {ABI_MULTI,FABRICA_V3_BASE,MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {COFRE_ESPERADO} from './caca';
import {REDES} from './liquidacoes';
const owner='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20);
function fixture(override:Record<string,string>={}):MultiBootLeitor{
 const data:Record<string,string>={
   dono:owner,cofre:COFRE_ESPERADO,aave:REDES.base.pool,
   morpho:MORPHO_FLASH_BASE,fabricaV3:FABRICA_V3_BASE,...override,
 };
 return {
  getNetwork:async()=>({chainId:8453n}),
  getCode:async()=>('0x6000'),
  call:async(req)=>{
    const method=ABI_MULTI.parseTransaction({data:req.data})!.name;
    return ABI_MULTI.encodeFunctionResult(method,[data[method]]);
  },
 };
}
test('Aave multi-hop only authorized after immutable owner+protocol verification',async()=>{
 const e:NodeJS.ProcessEnv={CACA_MULTIHOP_AVALIAR:'1',CACA_MULTIHOP_CONTRATO:contract,
  MEGAZORD_RPC_URL:'rpc-fixture',MEGAZORD_ENDERECO_PUBLICO:owner};
 assert.equal(await confirmarMultiHopAave(e,()=>fixture()),contract);
 assert.equal(e.CACA_ENVIAR,undefined);
 const live:NodeJS.ProcessEnv={...e,MEGAZORD_MODO:'execucao',
   MEGAZORD_CONFIRMAR:'OPERAR_BASE_REAL',MEGAZORD_EXCLUSIVO:'1'};
 habilitarAaveMultiHopMegazord(live,contract);
 assert.equal(live.CACA_ENVIAR,'1');
 assert.equal(live.CACA_SOMENTE_MULTIHOP,'1');
 assert.equal(live.CACA_MULTIHOP_ENVIAR,'1');
 assert.equal(live.CACA_MULTIHOP_CANARY_UM_TIRO,'1');
});
test('missing Aave executor leaves route disarmed and wrong immutable aborts',async()=>{
 const env={CACA_MULTIHOP_AVALIAR:'1',MEGAZORD_RPC_URL:'rpc-fixture',
  MEGAZORD_ENDERECO_PUBLICO:owner};
 assert.equal(await confirmarMultiHopAave(env,()=>fixture()),null);
 await assert.rejects(confirmarMultiHopAave({...env,CACA_MULTIHOP_CONTRATO:contract},
   ()=>fixture({dono:'0x'+'33'.repeat(20)})),/dono divergente/);
 assert.throws(()=>habilitarAaveMultiHopMegazord(env,contract),/sem preflight/);
});
