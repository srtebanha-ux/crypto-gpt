import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {Interface} from 'ethers';
import {quantiaParaCotacaoUsd,encodeQuoteAerodrome,decodeQuoteAerodrome,usdDoToken} from './cacaQuoteAerodrome';
const EURC='0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const F='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const abi=new Interface([
 'function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns(uint256[] amounts)',
]);
test('oraculo Aave 8 casas, EURO 6 casas: monta lote USD equivalente',()=>{
 const q=quantiaParaCotacaoUsd(new Decimal(1000),new Decimal(120_000_000),6);
 assert.equal(q,833333333n);
 assert.ok(usdDoToken(q!,new Decimal(120_000_000),6)!.lessThan(1000));
 assert.ok(usdDoToken(q!,new Decimal(120_000_000),6)!.greaterThan(999.99));
 assert.equal(quantiaParaCotacaoUsd(new Decimal(1_000),new Decimal(10_000_000_000_000),8),1_000_000n);
});
test('preco ausente, negativos e quantum zero falham fechados',()=>{
 assert.equal(quantiaParaCotacaoUsd(new Decimal(1000),undefined,6),null);
 assert.equal(quantiaParaCotacaoUsd(new Decimal(1000),new Decimal(0),6),null);
 assert.equal(quantiaParaCotacaoUsd(new Decimal(-1),new Decimal(100_000_000),6),null);
 assert.equal(quantiaParaCotacaoUsd(new Decimal(1),new Decimal('99999999999999999999'),6),null);
 assert.equal(usdDoToken(1n,undefined,6),null);
});
test('calldata e roundtrip do Router Aerodrome diferenciam estavel e volatil',()=>{
 const q=123450000n;
 for(const stable of [true,false]){
  const data=encodeQuoteAerodrome(q,EURC,USDC,F,stable);
  const [amount,routes]=abi.decodeFunctionData('getAmountsOut',data);
  assert.equal(amount,q);
  assert.equal(routes[0].stable,stable);
  assert.equal(routes[0].factory.toLowerCase(),F.toLowerCase());
  const raw=abi.encodeFunctionResult('getAmountsOut',[[q,987654n]]);
  assert.equal(decodeQuoteAerodrome(raw,q),987654n);
  assert.equal(decodeQuoteAerodrome(raw,1n),null);
  assert.equal(decodeQuoteAerodrome('0x',q),null);
  assert.equal(decodeQuoteAerodrome(abi.encodeFunctionResult('getAmountsOut',[[q,0n]]),q),null);
 }
});
