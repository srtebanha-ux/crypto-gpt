import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import {remetenteDaSondaTitan} from './titanIdentidadeSonda';
const dono='0x1111111111111111111111111111111111111111';
const diferente='0x2222222222222222222222222222222222222222';
const key='0x'+'11'.repeat(32);

test('observacao sem chave tem remetente explicito, sem solicitar assinatura',()=>{
 const r=remetenteDaSondaTitan(dono,{MEGAZORD_MODO:'observacao'});
 assert.deepEqual(r,{from:dono,identidade:'dono-onchain-somente-leitura'});
});
test('observacao com endereco publico existente usa exatamente o mesmo dono',()=>{
 assert.deepEqual(remetenteDaSondaTitan(dono,{MEGAZORD_ENDERECO_PUBLICO:dono}),{
    from:dono,identidade:'endereco-publico-conferido',
 });
 assert.equal(remetenteDaSondaTitan(dono,{TITAN_ENDERECO_PUBLICO:dono,
    MEGAZORD_ENDERECO_PUBLICO:dono,CACA_ENDERECO_PUBLICO:dono}).from,dono);
});
test('aliases publicos inconsistentes bloqueiam a prova',()=>{
 for(const campo of ['TITAN_ENDERECO_PUBLICO','MEGAZORD_ENDERECO_PUBLICO',
   'CACA_ENDERECO_PUBLICO']){
   assert.throws(()=>remetenteDaSondaTitan(dono,{[campo]:diferente}),/nao corresponde/);
 }
 assert.throws(()=>remetenteDaSondaTitan(dono,{MEGAZORD_ENDERECO_PUBLICO:'xxx'}));
});
test('chave privada existente so pode simular para seu proprio dono',()=>{
 const carteira=new Wallet(key);
 assert.deepEqual(remetenteDaSondaTitan(carteira.address,{TITAN_CHAVE_PRIVADA:key}),{
    from:carteira.address,identidade:'chave-conferida',
 });
 assert.throws(()=>remetenteDaSondaTitan(dono,{TITAN_CHAVE_PRIVADA:key}),
   /nao corresponde/);
 assert.throws(()=>remetenteDaSondaTitan(carteira.address,{
    TITAN_CHAVE_PRIVADA:key,MEGAZORD_ENDERECO_PUBLICO:dono,
 }),/nao corresponde/);
});
