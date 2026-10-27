import test from 'node:test';
import assert from 'node:assert/strict';
import {ambientePreflightMorpho} from './titanMorphoPreflight';
import {bloqueioRotaMorphoV3} from './titanMorphoDiretorDeRota';
const env={CACA_MORPHO_V3_CONTRATO:'0x'+'11'.repeat(20),
 MEGAZORD_ENDERECO_PUBLICO:'0x'+'22'.repeat(20),CACA_MORPHO_V3_CODEHASH:'0x'+'33'.repeat(32),
 TITAN_PREFLIGHT_MERCADO:'0x'+'44'.repeat(32),TITAN_PREFLIGHT_USUARIO:'0x'+'55'.repeat(20),
 MEGAZORD_RPC_URL:'http://localhost:8545'};
test('preflight removes signing credentials and send/deploy permissions without mutating service env',()=>{
 const live={...env,CACA_CHAVE_PRIVADA:'secret',CACA_MORPHO_V3_ENVIAR:'1',MEGAZORD_AUTO_DEPLOY:'1'};
 const safe=ambientePreflightMorpho(live);
 assert.equal(safe.CACA_CHAVE_PRIVADA,undefined);assert.equal(safe.CACA_MORPHO_V3_ENVIAR,'0');
 assert.equal(safe.MEGAZORD_AUTO_DEPLOY,'0');assert.equal(live.CACA_MORPHO_V3_ENVIAR,'1');
});
test('configuration names the exact missing V3 setting instead of blaming pools',()=>{
 assert.match(bloqueioRotaMorphoV3({})!,/CONTRATO ausente/);
 assert.match(bloqueioRotaMorphoV3({...env,CACA_MORPHO_V3_AVALIAR:'0'})!,/AVALIAR=0/);
 assert.equal(bloqueioRotaMorphoV3(env),null);
 for(const key of ['CACA_MORPHO_V3_CONTRATO','CACA_MORPHO_V3_CODEHASH','TITAN_PREFLIGHT_MERCADO','TITAN_PREFLIGHT_USUARIO'])
   assert.throws(()=>ambientePreflightMorpho({...env,[key]:undefined}));
});
