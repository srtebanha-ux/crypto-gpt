import {test} from 'node:test';
import assert from 'node:assert/strict';
import {atualizarTitan,eventoTitan,progressoTitan,lerEstadoTitan,iniciarPainelTitan} from './titanPainel';

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
