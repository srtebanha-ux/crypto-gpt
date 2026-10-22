import test from 'node:test';
import assert from 'node:assert/strict';
import {Decimal} from 'decimal.js';
import {evaluateCycle, getAmountOut, type Hop} from './ammMath';
import {custosDoFlashSwapV2} from './flashSwapCosts';

const hops:Hop[]=[
 {reserveIn:new Decimal('100'),reserveOut:new Decimal('300000'),feeFraction:new Decimal('0.003')},
 {reserveIn:new Decimal('300000'),reserveOut:new Decimal('105'),feeFraction:new Decimal('0.003')}
];

test('FlashArb native pool funding has no separate Aave loan fee',()=>{
 const gas=new Decimal('0.0001');
 const costs=custosDoFlashSwapV2(gas);
 assert.equal(costs.flashLoanFeeFraction.toString(),'0');
 assert.equal(costs.gasCostInToken.toString(),gas.toString());
 const e=evaluateCycle(hops,new Decimal('2'),costs);
 assert.equal(e.flashLoanFee.toString(),'0');
 assert.equal(e.netProfit.toString(),e.grossProfit.minus(gas).toString());
});

test('both pool hop fees remain in the V2 trade math',()=>{
 const amount=new Decimal(1);
 const noFee:Hop={...hops[0],feeFraction:new Decimal(0)};
 assert.ok(getAmountOut(amount,hops[0]).lt(getAmountOut(amount,noFee)));
 const actual=evaluateCycle(hops,new Decimal('2'),custosDoFlashSwapV2(new Decimal(0)));
 const withoutPoolFees=evaluateCycle(hops.map(h=>({...h,feeFraction:new Decimal(0)})),
   new Decimal('2'),custosDoFlashSwapV2(new Decimal(0)));
 assert.ok(actual.grossProfit.lt(withoutPoolFees.grossProfit));
});

test('gas input is validated instead of inventing zero cost',()=>{
 assert.throws(()=>custosDoFlashSwapV2(new Decimal(-1)),/Gas/);
 assert.throws(()=>custosDoFlashSwapV2(new Decimal('NaN')),/Gas/);
});
