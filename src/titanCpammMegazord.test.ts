import {test} from 'node:test';
import assert from 'node:assert/strict';
import {avaliarEExecutarCpammMegazord} from './titanCpammMegazord';
import type {Candidato} from './cacarArbitragem';
import type {OfertaCpammAtomica} from './titanCpammAtomico';
const address='0x'+'1'.repeat(40);
const env={TITAN_CPAMM_ATOMICO:'1',TITAN_V2_ENVIAR:'1',TITAN_ENVIAR:'1',
 TITAN_V2_CONFIRMAR:'OPERAR_BASE_REAL',TITAN_AUTORIZACAO_CONTINUA:'1',
 TITAN_NONCE_EXCLUSIVO:'1',TITAN_VALIDAR_AO_VIVO:'1',TITAN_V2_CONTRATO:address,
 TITAN_CHAVE_PRIVADA:'offline-placeholder',TITAN_ORCAMENTO_GAS_WEI:'100'};
const candidato={quantia:10n} as Candidato;
const oferta={contrato:address,emprestadoWei:99n} as OfertaCpammAtomica;
function fixture(){
 const calls:string[]=[];let inQueue=false;
 const d={ativo:()=>true,fila:async<T>(_name:string,work:()=>Promise<T>)=>{
  calls.push('fila');inQueue=true;try{return await work();}finally{inQueue=false;}},
 preparar:async()=>{assert.ok(inQueue);calls.push('prova');return oferta;},
 executar:async(c:{quantia:bigint})=>{assert.ok(inQueue);assert.equal(c.quantia,99n);calls.push('executor');
  return{status:'confirmado' as const,motivo:'fixture offline'};}};
 return{calls,d};
}
test('CPAMM adquire fila, refaz prova e encaminha quantia ao executor oficial',async()=>{
 const {calls,d}=fixture();const r=await avaliarEExecutarCpammMegazord(candidato,'offline',env,d);
 assert.equal(r.status,'confirmado');assert.deepEqual(calls,['fila','prova','executor']);
});
test('sem autorizacao nao transmite; sem emissor unico nao usa carteira alternativa',async()=>{
 const f=fixture();assert.equal((await avaliarEExecutarCpammMegazord(candidato,'offline',
  {...env,TITAN_ENVIAR:'0'},f.d)).status,'simulada');assert.ok(!f.calls.includes('executor'));
 const g=fixture();g.d.ativo=()=>false;
 assert.equal((await avaliarEExecutarCpammMegazord(candidato,'offline',env,g.d)).status,'recusado');
 assert.equal(g.calls.length,0);
});
test('prova falha ou executor divergente nunca chega ao emissor',async()=>{
 for(const result of [null,{...oferta,contrato:'0x'+'2'.repeat(40)}]){
  const f=fixture();const r=await avaliarEExecutarCpammMegazord(candidato,'offline',env,
   {...f.d,preparar:async()=>result});
  assert.equal(r.status,'recusado');assert.ok(!f.calls.includes('executor'));
 }
});

test('falha depois de encaminhar ao emissor é desconhecida, não uma recusa repetível',async()=>{
 const f=fixture();const r=await avaliarEExecutarCpammMegazord(candidato,'offline',env,
  {...f.d,executar:async()=>{throw Error('timeout after acceptance');}});
 assert.equal(r.status,'desconhecido');assert.match(r.motivo,/nao repetir/);
});
