import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {dadosGetPoolAerodrome,lerPoolAerodrome,classificarRota} from './cacaRotaAerodrome';
const a='0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';
const b='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const pool='0x1111111111111111111111111111111111111111';
const abi=new Interface(['function getPool(address,address,bool) view returns (address)']);
test('consultas ao factory distinguem mercado estavel do volatil',()=>{
 const sim=abi.decodeFunctionData('getPool',dadosGetPoolAerodrome(a,b,true));
 const nao=abi.decodeFunctionData('getPool',dadosGetPoolAerodrome(a,b,false));
 assert.equal(sim[2],true);assert.equal(nao[2],false);
 assert.equal(sim[0].toLowerCase(),a);assert.equal(sim[1].toLowerCase(),b);
});
test('ausencia e dados quebrados nao sao liquidez provada',()=>{
 assert.equal(lerPoolAerodrome(abi.encodeFunctionResult('getPool',[pool])),pool);
 assert.equal(lerPoolAerodrome(abi.encodeFunctionResult('getPool',['0x0000000000000000000000000000000000000000'])),null);
 assert.equal(lerPoolAerodrome('0x1234'),null);
 assert.equal(classificarRota(null,null),'nenhuma');
 assert.equal(classificarRota(pool,null),'apenas-estavel');
 assert.equal(classificarRota(null,pool),'apenas-volatil');
 assert.equal(classificarRota(pool,pool),'ambas');
});
