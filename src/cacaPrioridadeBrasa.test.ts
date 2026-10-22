import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {reservarAlvosNaBrasa,acordarPorBlocoSeAlvoCritico} from './cacaPrioridadeBrasa';

const a='0x03d0a5c9e1843986fb2f9335f7eb936754f7eaf0';
const b='0xeb3885780e0ca097e46b516533948e6980a5741a';
const c='0x1111111111111111111111111111111111111111';
const d='0x2222222222222222222222222222222222222222';
const m=(devedor:string,queda:string,usd:number,via='long')=>({
    devedor,queda:new Decimal(queda),dividaUsd:new Decimal(usd),via,
});
test('two targets remain in 233 calls and first eight pre-arm slots even after displaced by rivals',()=>{
    const original=Array.from({length:233},(_,i)=>'0x'+(i+1).toString(16).padStart(40,'0'));
    const items=[...original.map(x=>m(x,'0.1',1000)),m(a,'1.91',1891),m(b,'1.92',175)];
    const r=reservarAlvosNaBrasa({brasa:original,quentes:[a,b],
        medidos:items,prioritarios:new Set([a,b]),vagas:233,pisoUsd:new Decimal(32.8)});
    assert.deepEqual(r.brasa.slice(0,2),[a,b]);
    assert.equal(r.brasa.length,233);
    assert.equal(new Set(r.brasa).size,233);
    assert.ok(r.quentes.includes(original[231]));
    assert.ok(r.quentes.includes(original[232]));
    assert.ok(!r.quentes.includes(a));
    assert.equal(r.movidos.length,2);
});
test('no market eligibility shortcut: missing data, price immune and tiny debt cannot force reservation',()=>{
    const r=reservarAlvosNaBrasa({brasa:[c],quentes:[a,b],
        medidos:[m(a,'2',5),m(b,'2',200,'imune'),m(c,'0.1',1000)],
        prioritarios:new Set([a,b]),vagas:1,pisoUsd:new Decimal(32.8)});
    assert.deepEqual(r.brasa,[c]);
    assert.deepEqual(r.semMedicao,[a,b]);
});
test('already selected targets are moved to first slots without duplicates or extra capacity',()=>{
    const r=reservarAlvosNaBrasa({brasa:[c,a,d,b],quentes:[c,d],
        medidos:[m(a,'2',1000),m(b,'2',200),m(c,'0.1',1000),m(d,'0.2',1000)],
        prioritarios:new Set([a,b]),vagas:4,pisoUsd:new Decimal(10)});
    assert.deepEqual(r.brasa,[a,b,c,d]);
    assert.equal(r.movidos.length,0);
    assert.equal(r.quentes.length,0);
});
test('no forced watch on a stale zero debt or on a target farther than 5%',()=>{
    const r=reservarAlvosNaBrasa({brasa:[c],quentes:[a,b],
        medidos:[m(a,'0',0),m(b,'6.3',175),m(c,'2',500)],
        prioritarios:new Set([a,b]),vagas:1,pisoUsd:new Decimal(30)});
    assert.deepEqual(r.brasa,[c]);
    assert.deepEqual(r.semMedicao,[a,b]);
});
test('zero slots never silently expand the multicall',()=>{
    const r=reservarAlvosNaBrasa({brasa:[],quentes:[a],
        medidos:[m(a,'1',1891)],prioritarios:new Set([a]),vagas:0,pisoUsd:null});
    assert.deepEqual(r.brasa,[]);
    assert.deepEqual(r.movidos,[]);
});

test('per-block only within critical zone, not on missing or corrupt readings',()=>{
    for(const pct of ['0','0.1','0.7499','0.75']){
        assert.equal(acordarPorBlocoSeAlvoCritico(new Decimal(pct)),true,pct);
    }
    for(const pct of ['0.7501','1.9','-0.01','NaN','Infinity']){
        assert.equal(acordarPorBlocoSeAlvoCritico(new Decimal(pct)),false,pct);
    }
    assert.equal(acordarPorBlocoSeAlvoCritico(null),false);
});
