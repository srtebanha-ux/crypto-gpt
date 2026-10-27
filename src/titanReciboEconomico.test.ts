import {test} from 'node:test';
import assert from 'node:assert/strict';
import {id} from 'ethers';
import {lucroWethDoRecibo} from './titanReciboEconomico';
const e='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40);
const topic=(s:string)=>'0x'+s.slice(2).padStart(64,'0');
const transfer=(from:string,to:string,n:bigint)=>({address:'0x4200000000000000000000000000000000000006',
 topics:[id('Transfer(address,address,uint256)'),topic(from),topic(to)],data:'0x'+n.toString(16).padStart(64,'0')});
test('lucro é delta dos logs desta transacao menos gas L1/L2, não saldo posterior',()=>{
 assert.deepEqual(lucroWethDoRecibo(e,1,[transfer(other,e,150n),transfer(e,other,100n)],10n,5n),
  {brutoWei:50n,liquidoWei:35n});
});
test('status 1 sem taxa L1 real ou prova de transferencia não vira lucro realizado',()=>{
 assert.equal(lucroWethDoRecibo(e,1,[transfer(other,e,150n)],10n,null).liquidoWei,null);
 assert.equal(lucroWethDoRecibo(e,1,[],10n,5n).liquidoWei,null);
});
test('reversão e operações deficitárias registram perda, nunca truncam para lucro zero',()=>{
 assert.equal(lucroWethDoRecibo(e,0,[],10n,5n).liquidoWei,-15n);
 assert.equal(lucroWethDoRecibo(e,1,[transfer(e,other,1n)],10n,5n).liquidoWei,-16n);
});
