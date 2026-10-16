import {test} from 'node:test';
import assert from 'node:assert/strict';
import {escolherSplitTitan} from './titanSplitRoute';
test('seleciona split por duas curvas reais cotadas, nao 65/35 arbitrario',()=>{
    // Duas pools com impacto quadratico diferente medido por cotador.
    const a=(x:bigint)=>10_000n*x - (x*x*20n);
    const b=(x:bigint)=>10_000n*x - (x*x*40n);
    const r=escolherSplitTitan(100n,a,b,100n,100);
    assert.ok(r);
    assert.equal(r.partePrimeira+r.parteSegunda,100n);
    assert.ok(r.partePrimeira>r.parteSegunda);
    assert.ok(r.saidaAposGasExtra > a(100n));
});
test('custo de fazer dois swaps pode tornar VENDA unica melhor',()=>{
    const a=(x:bigint)=>x*100n;
    const b=(x:bigint)=>x*100n;
    const r=escolherSplitTitan(10n,a,b,10n,10)!;
    assert.ok(r.partePrimeira===0n||r.parteSegunda===0n);
});
test('nao otimiza sem custo de gas convertido no token de saida',()=>{
    assert.equal(escolherSplitTitan(100n,(n)=>n,(n)=>n,null),null);
});
test('quotes faltantes nao sao tratados como zero nem lucro',()=>{
    const a=(n:bigint)=>n;
    const b=(_:bigint)=>null;
    const r=escolherSplitTitan(100n,a,b,0n,10)!;
    assert.equal(r.partePrimeira,100n);
});
test('quantias invalidas nao entram no otimizador',()=>{
    assert.throws(()=>escolherSplitTitan(0n,()=>0n,()=>0n,0n));
    assert.throws(()=>escolherSplitTitan(10n,()=>0n,()=>0n,0n,1));
});
