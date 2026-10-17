import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {coberturaPrioritariaPequena,enderecosPrioritarios,FOLGA_JUROS_BPS} from './cacaFechamentoPequenos';

const a='0x03d0a5c9e1843986fb2f9335f7eb936754f7eaf0';
const b='0xeb3885780e0ca097e46b516533948e6980a5741a';
const outros='0x1111111111111111111111111111111111111111';
const lista=enderecosPrioritarios(a+','+b);
const base=(endereco:string, usd:number, amount:number)=>({
 endereco,dividaCrua:BigInt(amount)*1_000_000n,
 dividaUsd:new Decimal(usd),tamanhoBase:BigInt(amount)*500_000n,
 enderecos:lista
});
test('somente enderecos exatos recebem tamanho especial, de forma case-insensitive',()=>{
 assert.equal(lista.size,2);
 assert.equal(coberturaPrioritariaPequena(base(outros,1800,1800)),900_000_000n);
 assert.ok(coberturaPrioritariaPequena(base(a.toUpperCase().replace('0X','0x'),1800,1800))>1_800_000_000n);
});
test('as duas dividas registradas recebem fechamento total com pequena folga de juros',()=>{
 const x=coberturaPrioritariaPequena(base(a,1891.59,1891));
 const y=coberturaPrioritariaPequena(base(b,175.80,175));
 assert.ok(x>1_891_000_000n&&x<=1_893_000_000n);
 assert.ok(y>175_000_000n&&y<=176_000_000n);
 assert.equal(FOLGA_JUROS_BPS,10n);
});
test('divida de 2000 ou mais nao usa regime de fechamento',()=>{
 assert.equal(coberturaPrioritariaPequena(base(a,2000,2000)),1_000_000_000n);
 assert.equal(coberturaPrioritariaPequena(base(a,2500,2500)),1_250_000_000n);
});
test('faltando leitura segura nao aumenta emprestimo',()=>{
 const x=base(a,1891,1891);
 assert.equal(coberturaPrioritariaPequena({...x,dividaUsd:undefined}),x.tamanhoBase);
 assert.equal(coberturaPrioritariaPequena({...x,dividaUsd:new Decimal('NaN')}),x.tamanhoBase);
 assert.equal(coberturaPrioritariaPequena({...x,dividaCrua:0n}),x.tamanhoBase);
});
test('enderecos malformados sao ignorados',()=>{
 assert.deepEqual([...enderecosPrioritarios('abc,0x123, '+a+', 0xgggg')],[a]);
});
