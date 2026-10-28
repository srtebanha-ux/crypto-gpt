import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {lerResumoPersistente,auditarPersistenciaMegazord} from './megazordAuditoriaPersistencia';

test('read-only durable audit reports pending hash but never exposes arbitrary fields',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'titan-audit-'));
 try{
   const file=path.join(dir,'diario.json');
   const hash='0x'+'ab'.repeat(32);
   fs.writeFileSync(file,JSON.stringify({version:1,address:'0x'+'11'.repeat(20),
     pending:{hash,nonce:4,secret:'NO-LOG-THIS'},days:{'2026-10-28':{}},
     receipts:[{hash:'SECRET-RECEIPT'}],privateKey:'NO-LOG-THIS'}));
   const result=lerResumoPersistente(file,'diario');
   assert.equal(result.estado,'legivel');
   assert.equal(result.hashPendente,hash);
   assert.equal(result.noncePendente,4);
   assert.equal(result.recibos,1);
   assert.equal(result.dias,1);
   assert.doesNotMatch(JSON.stringify(result),/NO-LOG-THIS|SECRET-RECEIPT/);
   assert.equal(lerResumoPersistente(file+'.missing','diario').estado,'ausente');
   fs.writeFileSync(file,'{garbled');
   assert.equal(lerResumoPersistente(file,'diario').estado,'invalido');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing or invalid journal path never emits path, key or signed wallet',()=>{
 const summary=auditarPersistenciaMegazord({
   MEGAZORD_DIARIO:'/tmp/PRIVATE_SECRET.json',
   MEGAZORD_CHAVE_PRIVADA:'MY-SECRET-KEY',
 });
 assert.equal(summary.somenteLeitura,true);
 assert.equal(summary.arquivos.diario.estado,'invalido');
 assert.doesNotMatch(JSON.stringify(summary),/PRIVATE_SECRET|MY-SECRET-KEY/);
});
