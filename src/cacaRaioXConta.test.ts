import test from 'node:test';
import assert from 'node:assert/strict';
import {id} from 'ethers';
import {calldataDaConta,lerPalavraDeConta,lerEModeUsuario,resumirReservas,
  SELETOR_CONFIG_USUARIO,SELETOR_EMODE_USUARIO} from './cacaRaioXConta';

const user='0x03d0a5c9e1843986fb2f9335f7eb936754f7eaf0';
const w=(n:bigint)=>'0x'+n.toString(16).padStart(64,'0');
test('selectors validos, endereco na calldata',()=>{
 assert.equal(SELETOR_EMODE_USUARIO,id('getUserEMode(address)').slice(0,10));
 assert.equal(SELETOR_CONFIG_USUARIO,id('getUserConfiguration(address)').slice(0,10));
 const d=calldataDaConta(SELETOR_EMODE_USUARIO,user);
 assert.equal(d.length,74);assert.equal(d.slice(-40),user.slice(2));
 assert.throws(()=>calldataDaConta('0x123',user));
});
test('E-Mode 0,1,255 conhecidos; ausencia/desvio falha fechada',()=>{
 assert.equal(lerEModeUsuario(w(0n)),0);
 assert.equal(lerEModeUsuario(w(1n)),1);
 assert.equal(lerEModeUsuario(w(255n)),255);
 assert.equal(lerEModeUsuario(w(256n)),null);
 assert.equal(lerEModeUsuario('0x1234'),null);
 assert.equal(lerEModeUsuario('0x'+'z'.repeat(64)),null);
 assert.equal(lerPalavraDeConta(w(33n)),33n);
});
test('collateral ligado e saldo >0 sao necessarios; depositos sem permissao separados',()=>{
 const rows=[
  {token:'0xAAAA',saldoDeAToken:2n,dividaVariavel:0n,garantiaHabilitada:true},
  {token:'0xBBBB',saldoDeAToken:3n,dividaVariavel:0n,garantiaHabilitada:false},
  {token:'0xCCCC',saldoDeAToken:0n,dividaVariavel:9n,garantiaHabilitada:false},
  {token:'0xDDDD',saldoDeAToken:0n,dividaVariavel:0n,garantiaHabilitada:true},
 ];
 const r=resumirReservas(rows);
 assert.deepEqual(r.garantias,['0xaaaa']);
 assert.deepEqual(r.depositadosSemGarantia,['0xbbbb']);
 assert.deepEqual(r.devedores,['0xcccc']);
});
