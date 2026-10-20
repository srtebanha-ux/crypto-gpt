import {test} from 'node:test';
import assert from 'node:assert/strict';
import {examinarSaudeMorpho,WAD_MORPHO,ORACLE_SCALE_MORPHO} from './titanMorphoRadar';
const base={
 borrowShares:1000n,collateral:1000n,
 totalBorrowAssets:1000n,totalBorrowShares:1000n,
 // 1.2 loan raw units per collateral raw unit, at Morpho's oracle scale
 precoOracle:ORACLE_SCALE_MORPHO*12n/10n,
 lltvWad:WAD_MORPHO*8n/10n,
};
test('detects mathematically crossed LLTV but never returns execution approval',()=>{
 const r=examinarSaudeMorpho(base);
 assert.equal(r.situacao,'cruzou-estimado');
 assert.equal(r.dividaCrua,1000n);
 assert.ok(r.distanciaBps!==null&&r.distanciaBps<0n);
 assert.match(r.motivo,/exige eth_call/);
 assert.ok(!Object.prototype.hasOwnProperty.call(r,'podeEnviar'));
});
test('returns near/healthy from current oracle price, not GraphQL borrow numbers',()=>{
 const safe=examinarSaudeMorpho({...base,precoOracle:ORACLE_SCALE_MORPHO*13n/10n});
 assert.equal(safe.situacao,'proxima');
 assert.equal(safe.distanciaBps,400n);
 const other=examinarSaudeMorpho({...base,precoOracle:ORACLE_SCALE_MORPHO*2n});
 assert.equal(other.situacao,'segura');
});
test('debt shares round up; do not round risk away',()=>{
 const r=examinarSaudeMorpho({...base,totalBorrowAssets:1001n,totalBorrowShares:2000n,borrowShares:2n});
 assert.equal(r.dividaCrua,2n);
});
test('missing market or invalid oracle is UNKNOWN rather than healthy or unsafe',()=>{
 assert.equal(examinarSaudeMorpho({...base,totalBorrowShares:0n}).situacao,'desconhecida');
 assert.equal(examinarSaudeMorpho({...base,precoOracle:0n}).situacao,'desconhecida');
 assert.equal(examinarSaudeMorpho({...base,lltvWad:WAD_MORPHO}).situacao,'desconhecida');
 assert.equal(examinarSaudeMorpho({...base,collateral:0n}).situacao,'sem-garantia');
 assert.equal(examinarSaudeMorpho({...base,borrowShares:0n}).situacao,'sem-divida');
});
test('price decimal scaling is invariant for different token decimals already priced by oracle',()=>{
 const usdLoan={...base,collateral:10n**18n,totalBorrowAssets:1000n*10n**6n,
  totalBorrowShares:1000n*10n**6n,borrowShares:1000n*10n**6n,
  precoOracle:1200n*10n**24n};
 const r=examinarSaudeMorpho(usdLoan);
 assert.equal(r.situacao,'cruzou-estimado');
 assert.equal(r.distanciaBps,-400n); // 960 USDC borrowing limit versus 1000
});
