import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {identidadeDeProvaV2} from './titanV2Identidade';

const publicOwner='0x1111111111111111111111111111111111111111';
const key='0x'+'11'.repeat(32);

test('read-only probe can use public wallet with no signer',()=>{
 assert.equal(identidadeDeProvaV2({MEGAZORD_ENDERECO_PUBLICO:publicOwner}),publicOwner);
 assert.equal(identidadeDeProvaV2({CACA_ENDERECO_PUBLICO:publicOwner}),publicOwner);
 assert.equal(identidadeDeProvaV2({TITAN_ENDERECO_PUBLICO:publicOwner}),publicOwner);
});
test('probe without public or private identity is blocked',()=>{
 assert.equal(identidadeDeProvaV2({}),null);
});
test('identity preserves legacy private key fallback only for existing flows',()=>{
 assert.equal(identidadeDeProvaV2({TITAN_CHAVE_PRIVADA:key}),new Wallet(key).address);
});
test('public and private mismatched identities fail closed',()=>{
 assert.throws(()=>identidadeDeProvaV2({MEGAZORD_ENDERECO_PUBLICO:publicOwner,TITAN_CHAVE_PRIVADA:key}),/nao corresponde/);
});
test('wrong public address rejects instead of silently replacing it',()=>{
 assert.throws(()=>identidadeDeProvaV2({MEGAZORD_ENDERECO_PUBLICO:'0xwrong'}));
});
