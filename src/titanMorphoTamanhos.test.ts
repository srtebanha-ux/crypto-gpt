import test from 'node:test';
import assert from 'node:assert/strict';
import {tamanhosDeLiquidacaoMorpho} from './titanMorphoTamanhos';
const basic={
  borrowShares:276866893263507n,
  collateral:2288517006804982611n,
  estimatedDebtAssets:276866893263507n,
  oraclePrice:1n*10n**36n,
  lltvWad:860000000000000000n,
};
test('liquidation full 100% never probed; tries incremental smaller shares first',()=>{
 const candidates=tamanhosDeLiquidacaoMorpho(basic);
 assert.ok(candidates.length>=4);
 assert.ok(candidates.every((s,i)=>s>0n&&s<basic.borrowShares&&
   (i===0||s>candidates[i-1]!)));
 assert.ok(candidates[0]!<basic.borrowShares/20n);
 assert.ok(candidates.at(-1)!<basic.borrowShares);
});
test('seized collateral shortage caps repayment further',()=>{
 const extra=tamanhosDeLiquidacaoMorpho({...basic,collateral:basic.collateral/10n});
 const original=tamanhosDeLiquidacaoMorpho(basic);
 assert.ok(extra.at(-1)!<original.at(-1)!);
 assert.ok(extra.at(-1)!<=original.at(-1)!/2n);
});
test('empty markets and malformed oracle/lltv never authorize probes',()=>{
 assert.deepEqual(tamanhosDeLiquidacaoMorpho({...basic,borrowShares:0n}),[]);
 assert.deepEqual(tamanhosDeLiquidacaoMorpho({...basic,oraclePrice:0n}),[]);
 assert.deepEqual(tamanhosDeLiquidacaoMorpho({...basic,lltvWad:10n**18n}),[]);
 assert.deepEqual(tamanhosDeLiquidacaoMorpho({...basic,collateral:0n}),[]);
});
test('ceil and virtual share approximations leave safety margin for small loans',()=>{
 const small=tamanhosDeLiquidacaoMorpho({borrowShares:9n,collateral:80n,
    estimatedDebtAssets:9n,oraclePrice:10n**36n,lltvWad:860000000000000000n});
 assert.ok(small.every(n=>n>0n&&n<=8n));
 assert.equal(new Set(small.map(n=>n.toString())).size,small.length);
});
