import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reservarGasCompartilhado,conciliarGasCompartilhado,pontuacaoDeLiquidez} from './cacaDuasRotas';
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'caca-orc-'));
const d=(file:string,when:Date,cost=300n)=>({file,when,tipo:'V1' as const,
    alvo:'0x123',maxCostWei:cost,maxPerTxWei:500n,maxDailyWei:750n,maxTxDia:2});
test('V1 e MH dividem mesmo diario e nunca ocupam nonce simultaneamente',()=>{
    const dir=root(),f=path.join(dir,'d.jsonl'),now=new Date('2026-10-16T12:00:00Z');
    const a=reservarGasCompartilhado(d(f,now));assert.ok(a.id,a.reason);
    const b=reservarGasCompartilhado({...d(f,now),tipo:'MH'});assert.equal(b.id,null);
    assert.match(b.reason,/pendente/);
    assert.equal(conciliarGasCompartilhado(a.id!,'acertou','0x1',f),true);
    const c=reservarGasCompartilhado({...d(f,now),tipo:'MH'});assert.ok(c.id,c.reason);
    assert.equal(conciliarGasCompartilhado(c.id!,'acertou','0x2',f),true);
    assert.equal(reservarGasCompartilhado(d(f,now)).id,null);
});
test('revert de um executor interrompe AMBOS por dia UTC',()=>{
    const dir=root(),f=path.join(dir,'d.jsonl'),when=new Date('2026-10-16T12:00:00Z');
    const first=reservarGasCompartilhado(d(f,when));assert.ok(first.id);
    assert.equal(conciliarGasCompartilhado(first.id!,'reverteu','0x123',f),true);
    assert.match(reservarGasCompartilhado({...d(f,when),tipo:'MH'}).reason,/revert/);
    assert.ok(reservarGasCompartilhado({...d(f,new Date('2026-10-17T00:00:00Z')),tipo:'MH'}).id);
});
test('sumiu bloqueia novos tiros mesmo em outro dia; diario corrompido bloqueia',()=>{
    const dir=root(),f=path.join(dir,'d.jsonl'),now=new Date('2026-10-16T12:00:00Z');
    const a=reservarGasCompartilhado(d(f,now));assert.ok(a.id);
    assert.equal(conciliarGasCompartilhado(a.id!,'sumiu',undefined,f),true);
    assert.equal(reservarGasCompartilhado(d(f,new Date('2026-10-17T12:00:00Z'))).id,null);
    const bad=path.join(dir,'bad.jsonl');fs.writeFileSync(bad,'{\"kind\":');
    assert.equal(reservarGasCompartilhado(d(bad,now)).id,null);
});
test('sem lucro liquido nenhuma rota ganha; legado comparado ao Multi-Hop ja liquido',()=>{
    assert.equal(pontuacaoDeLiquidez('V1',100n,120n),0n);
    assert.equal(pontuacaoDeLiquidez('V2',300n,120n),180n);
    assert.equal(pontuacaoDeLiquidez('MH',250n,120n),250n);
});
test('nunca exceder orcamento',()=>{
    const file=path.join(root(),'d.jsonl');
    assert.equal(reservarGasCompartilhado(d(file,new Date(),600n)).id,null);
});
