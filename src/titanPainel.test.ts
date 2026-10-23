import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atualizarTitan,eventoTitan,progressoTitan,lerEstadoTitan,iniciarPainelTitan,validarCacaPainel} from './titanPainel';

test('telemetry is real in-memory, typed, and bounded; no fake profit',()=>{
 const before=lerEstadoTitan();
 assert.equal(before.journal,null);
 atualizarTitan({cycles:3,block:52530000,routes:400,positives:2,
   contractReady:true,pools:240,mixed:99,quotes:16,queue:81,
   phase:'Analisando'} as const);
 progressoTitan(3,150);
 eventoTitan('ciclo','Bloco analisado','150 rotas monitoradas');
 const after=lerEstadoTitan();
 assert.equal(after.block,52530000);
 assert.equal(after.cycles,3);
 assert.equal(after.contractReady,true);
 assert.equal(after.quotes,16);
 assert.equal(after.journal,null);
 assert.equal(after.chart.at(-1)?.routes,150);
 assert.equal(after.events[0]?.title,'Bloco analisado');
 for(let k=0;k<100;k++)progressoTitan(k,k);
 assert.equal(lerEstadoTitan().chart.length,40);
});
test('no HTTP listener unless explicitly enabled and strong credentials',()=>{
 assert.equal(iniciarPainelTitan({TITAN_PAINEL_ATIVO:'0'}),null);
 assert.throws(()=>iniciarPainelTitan({
   TITAN_PAINEL_ATIVO:'1',TITAN_PAINEL_USUARIO:'user',
   TITAN_PAINEL_SENHA:'short',
 }),/senha forte/);
});

test('o radar valida cinco alvos reais sem fabricar HF e rejeita payloads antigos',()=>{
 const now=new Date().toISOString();
 const ids=Array.from({length:5},(_,i)=>'0x'+String(i+1).repeat(40));
 const raw={observadoEm:now,bloco:52778258,vigiados:232,podemAtirar:0,
  envioAutorizado:true,alvos:ids.map(id=>({id,hf:null,faltaPct:null,
   bloco:null,lidoEm:null}))};
 const x=validarCacaPainel(raw);
 assert.ok(x);
 assert.equal(x?.alvos.length,5);
 assert.equal(x?.vigiados,232);
 assert.equal(x?.alvos[0]?.hf,null);
 assert.equal(validarCacaPainel({...raw,observadoEm:'2020-01-01T00:00:00Z'}),null);
 assert.equal(validarCacaPainel({...raw,podemAtirar:'50'}),null);
 assert.equal(validarCacaPainel({...raw,alvos:[raw.alvos[0],raw.alvos[0]]}),null);
});
