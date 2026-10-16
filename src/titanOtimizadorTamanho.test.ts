import {test} from 'node:test';
import assert from 'node:assert/strict';
import {otimizarTamanhoTitan,variacoesDePrecisao} from './titanOtimizadorTamanho';
test('lucro liquido otimizado considera grade inteira e nao volume maximo',()=>{
    const sim=(x:bigint)=>1000n-(x-35n)*(x-35n);
    const resultado=otimizarTamanhoTitan(100n,1n,sim,32);
    assert.ok(resultado);
    assert.ok(resultado.quantia>=30n && resultado.quantia<=40n);
    assert.ok(resultado.lucroLiquido>900n);
    assert.ok(resultado.cotacoes<=32);
});
test('respeita unidades inteiras e limite de credito',()=>{
    const v=otimizarTamanhoTitan(1000n,10n,(x)=>x*2n,32);
    assert.ok(v);
    assert.equal(v.quantia%10n,0n);
    assert.ok(v.quantia<=1000n);
});
test('cotacao ausente nunca vira zero ou lucro inventado',()=>{
    assert.equal(otimizarTamanhoTitan(100n,1n,()=>null),null);
    assert.equal(otimizarTamanhoTitan(100n,1n,()=>-10n),null);
});
test('micro mudancas discretas mantem 1 wei e nao superam credito',()=>{
    const a=variacoesDePrecisao(100n,110n,1n);
    assert.ok(a.includes(99n)&&a.includes(100n)&&a.includes(101n));
    assert.ok(a.every(x=>x>0n&&x<=110n));
    assert.deepEqual(variacoesDePrecisao(0n,100n),[]);
});
test('evita overflow Number: trabalha somente com bigint',()=>{
    const m=10n**25n;
    const r=otimizarTamanhoTitan(m,10n**18n,(x)=>x/10n,16);
    assert.ok(r);
    assert.ok(r.quantia>BigInt(Number.MAX_SAFE_INTEGER));
});

test('aceita orcamento impar de cotacoes sem RangeError',()=>{
    const v=otimizarTamanhoTitan(1000n,1n,(x)=>x,9);
    assert.ok(v);
    assert.ok(v.cotacoes<=9);
});
