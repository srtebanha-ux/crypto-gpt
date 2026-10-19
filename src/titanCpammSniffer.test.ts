import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Decimal} from 'decimal.js';
import {avaliarCicloComSementeCpamm} from './titanCpammSniffer';
import {hopsForCycle,type PoolInfo,type Cycle} from './dexGraph';
import type {FlashLoanCosts} from './ammMath';
const WETH='0x4200000000000000000000000000000000000006';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const dec=new Map([[WETH,18],[USDC,6]]);
const costs:FlashLoanCosts={flashLoanFeeFraction:new Decimal(0),
 gasCostInToken:new Decimal('0.001')};
function pool(address:string,r0:string,r1:string,fee='0.003'):PoolInfo{
 return {address,token0:WETH,token1:USDC,
  reserve0:new Decimal(r0),reserve1:new Decimal(r1),
  feeFraction:new Decimal(fee)};
}
function cycle():Cycle{return{
 startToken:WETH,path:[WETH,USDC,WETH],
 pools:[pool('0x'+'1'.repeat(40),'100','300000'),
        pool('0x'+'2'.repeat(40),'110','300000')]
}}
test('TITAN bridges oriented 18/6 token decimals, never treats analytic result as onchain profit',()=>{
 const c=cycle(),h=hopsForCycle(c);
 const r=avaliarCicloComSementeCpamm(c,h,new Decimal('8'),costs,dec);
 assert.ok(r.evaluation.amountIn.gte(0));
 assert.ok(r.evaluation.amountIn.lte(8));
 if(r.origem==='semente-cpamm-bigint'){
  assert.ok(r.sementeCrua!==null);
  assert.equal(r.sementeCrua!%1000000000000n,0n);
 }
 // No result here includes RPC call, proof of real transfer or receipt.
 assert.ok(['busca-decimal','semente-cpamm-bigint'].includes(r.origem));
});
test('three-hop cycle does not use two-pool closed-form shortcut',()=>{
 const c=cycle(),p=c.pools[0];
 const bigger={...c,path:[WETH,USDC,WETH,WETH],pools:[...c.pools,p]};
 const r=avaliarCicloComSementeCpamm(bigger,hopsForCycle(c),new Decimal(8),costs,dec);
 assert.equal(r.origem,'busca-decimal');
 assert.match(r.razaoRejeicao!,/Somente ciclos/);
});
test('missing token decimals never used as 18 by default',()=>{
 const c=cycle(),h=hopsForCycle(c);
 const r=avaliarCicloComSementeCpamm(c,h,new Decimal(8),costs,new Map([[WETH,18]]));
 assert.equal(r.origem,'busca-decimal');
 assert.match(r.razaoRejeicao!,/Decimais/);
});
test('unrepresentable fee decimals reject integer seed without guessing',()=>{
 const c=cycle();
 c.pools[0].feeFraction=new Decimal('0.0030000000001');
 const r=avaliarCicloComSementeCpamm(c,hopsForCycle(c),new Decimal(8),costs,dec);
 assert.equal(r.origem,'busca-decimal');
 assert.match(r.razaoRejeicao!,/inteiras/);
});
test('no-profit balanced route stays unprofitable',()=>{
 const c=cycle();
 c.pools[1].reserve0=new Decimal('100');
 const r=avaliarCicloComSementeCpamm(c,hopsForCycle(c),new Decimal(8),costs,dec);
 assert.equal(r.evaluation.profitable,false);
});
