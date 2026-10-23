import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {normalizarChaveMegazord,resolverChaveMegazord,normalizarCredenciaisMegazord}
 from './megazordCredenciais';
import {conferirIdentidadeMegazord,carteiraMegazord} from './megazordExecutor';
const hex='11'.repeat(32); // Unfunded offline fixture.
const key='0x'+hex;
test('prefixed and unprefixed wallet inputs resolve to the same existing owner',()=>{
 for(const input of [hex,key,'  '+hex+'\n','0X'+hex]){
   assert.equal(normalizarChaveMegazord(input),key);
   assert.equal(carteiraMegazord(input).address,new Wallet(key).address);
   const env:NodeJS.ProcessEnv={CACA_CHAVE_PRIVADA:input,
     CACA_ENDERECO_PUBLICO:new Wallet(key).address,MEGAZORD_DIARIO:'/app/data/test.json'};
   assert.equal(conferirIdentidadeMegazord(env).address,new Wallet(key).address);
   normalizarCredenciaisMegazord(env);
   for(const alias of ['CACA_CHAVE_PRIVADA','TITAN_CHAVE_PRIVADA','MEGAZORD_CHAVE_PRIVADA'])
     assert.equal(env[alias],key);
 }
});
test('invalid scalar and contradictory aliases fail without exposing any credential',()=>{
 for(const secret of ['invalid-secret','00'.repeat(32),'ff'.repeat(32),'11'.repeat(31),'']){
   assert.throws(()=>normalizarChaveMegazord(secret),e=>
     e instanceof Error&&e.message==='credencial Megazord invalida');
 }
 assert.throws(()=>resolverChaveMegazord({CACA_CHAVE_PRIVADA:key,
   TITAN_CHAVE_PRIVADA:'0x'+'22'.repeat(32)}),/mesma carteira/);
 // A malformed explicitly configured alias must not silently fall back.
 assert.throws(()=>resolverChaveMegazord({MEGAZORD_CHAVE_PRIVADA:'broken',
   CACA_CHAVE_PRIVADA:key}),/credencial Megazord invalida/);
});
