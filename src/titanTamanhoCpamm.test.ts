import {test} from 'node:test';
import assert from 'node:assert/strict';
import {raizQuadradaInteira,saidaCpamm,estimarTamanhoCicloCpamm} from './titanTamanhoCpamm';

test('integer sqrt is exact over huge values and near-boundaries',()=>{
 for(const n of [0n,1n,2n,3n,4n,15n,16n,17n,10n**42n,2n**255n]){
  const s=raizQuadradaInteira(n);
  assert.ok(s*s<=n&&(s+1n)*(s+1n)>n);
 }
 assert.throws(()=>raizQuadradaInteira(-1n));
});
test('no arbitrage if two exact inverse pools with fees',()=>{
 const x={reservaEntrada:1000000n,reservaSaida:2000000n,
   taxaNumerador:997n,taxaDenominador:1000n};
 const y={reservaEntrada:2000000n,reservaSaida:1000000n,
   taxaNumerador:997n,taxaDenominador:1000n};
 assert.equal(estimarTamanhoCicloCpamm(x,y,300000n),null);
 assert.equal(saidaCpamm(x,10000n),19743n);
});
test('profitable CPAMM imbalance proposes positive bounded size but does not certify transaction',()=>{
 const x={reservaEntrada:1000000n,reservaSaida:2200000n,taxaNumerador:997n,taxaDenominador:1000n};
 const y={reservaEntrada:2000000n,reservaSaida:1100000n,taxaNumerador:997n,taxaDenominador:1000n};
 const r=estimarTamanhoCicloCpamm(x,y,500000n,10n);
 assert.ok(r);assert.ok(r!.lucroTeoricoAntesGas>0n);
 assert.ok(r!.tamanhoSugerido<=500000n);
 assert.equal(r!.tamanhoSugerido%10n,0n);
 assert.equal(r!.modelo,'cpamm-2-pools-nao-verificado');
 // Validate suggested theoretical profit against integer swap math.
 const amount=r!.tamanhoSugerido;
 assert.equal(r!.lucroTeoricoAntesGas,saidaCpamm(y,saidaCpamm(x,amount))-amount);
 // Fee changes borrowing economics; never assume always-free flash loan.
 const charged=estimarTamanhoCicloCpamm(x,y,500000n,10n,5n,10000n);
 assert.ok(!charged||charged.lucroTeoricoAntesGas<=r!.lucroTeoricoAntesGas);
});
test('reject invalid reserves, zero fee denominators, excessive granularity',()=>{
 const x={reservaEntrada:1n,reservaSaida:100n,taxaNumerador:997n,taxaDenominador:1000n};
 assert.equal(estimarTamanhoCicloCpamm({...x,reservaEntrada:0n},x,50n),null);
 assert.equal(estimarTamanhoCicloCpamm(x,x,50n,0n),null);
 assert.equal(estimarTamanhoCicloCpamm(x,x,50n,51n),null);
 assert.equal(estimarTamanhoCicloCpamm(x,x,50n,1n,-1n),null);
});
