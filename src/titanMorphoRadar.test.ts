import {test} from 'node:test';
import assert from 'node:assert/strict';
import {examinarSaudeMorpho,WAD_MORPHO,ORACLE_SCALE_MORPHO} from './titanMorphoRadar';
const base={
 borrowShares:1_000_000_000n,collateral:1000n,
 totalBorrowAssets:1000n,totalBorrowShares:1_000_000_000n,
 // 1.2 loan raw units per collateral raw unit, at Morpho's oracle scale
 precoOracle:ORACLE_SCALE_MORPHO*12n/10n,
 lltvWad:WAD_MORPHO*8n/10n,
};
test('exact LLTV equality and positive sub-bp buffer remain healthy',()=>{
 const x={...base,borrowShares:100_000_000_000n,
   totalBorrowAssets:100_000n,totalBorrowShares:100_000_000_000n,
   collateral:125_000n,precoOracle:ORACLE_SCALE_MORPHO};
 assert.equal(examinarSaudeMorpho(x).dividaCrua,100_000n);
 assert.equal(examinarSaudeMorpho(x).distanciaBps,0n);
 assert.equal(examinarSaudeMorpho(x).situacao,'proxima');
 const buffer=examinarSaudeMorpho({...x,collateral:125_002n});
 assert.equal(buffer.distanciaBps,0n);
 assert.equal(buffer.situacao,'proxima');
 assert.equal(examinarSaudeMorpho({...x,collateral:124_999n}).situacao,'cruzou-estimado');
});
test('oracle conversion rounds down before LLTV multiplication as in Morpho',()=>{
 const x={...base,borrowShares:1_000_000n,totalBorrowAssets:1n,
   totalBorrowShares:1_000_000n,collateral:3n,
   precoOracle:ORACLE_SCALE_MORPHO/2n};
 // floor(3 * 0.5) = 1; floor(1 * 0.8) = 0 < debt 1.
 // Multiplying first would incorrectly produce a safe limit of 1.2.
 const r=examinarSaudeMorpho(x);
 assert.equal(r.dividaCrua,1n);
 assert.equal(r.situacao,'cruzou-estimado');
 assert.equal(r.distanciaBps,-10000n);
});
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
 assert.equal(r.dividaCrua,1n);
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
  totalBorrowShares:1000n*10n**12n,borrowShares:1000n*10n**12n,
  precoOracle:1200n*10n**24n};
 const r=examinarSaudeMorpho(usdLoan);
 assert.equal(r.situacao,'cruzou-estimado');
 assert.equal(r.distanciaBps,-400n); // 960 USDC borrowing limit versus 1000
});

test('Morpho official virtual shares prevent false debt estimate in tiny markets',()=>{
 const r=examinarSaudeMorpho({...base,borrowShares:1_000_000n,
  totalBorrowShares:1_000_000n,totalBorrowAssets:1000n});
 assert.equal(r.dividaCrua,501n); // ceil(1e6*(1000+1)/(1e6+1e6))
});
