import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {ordenarCaidosPorPremio} from './cacaOrdenarCaidos';

const a='0x03d0a5c9e1843986fb2f9335f7eb936754f7eaf0'; // perto, US$ 41
const b='0xeb3885780e0ca097e46b516533948e6980a5741a'; // poeira, US$ 3.57
const c='0x1b9f859e0c9d14f516273552d8de48b77388603c'; // US$ 266
const d='0x16ef04260ca959c75bd8d4247874517c9cf74d12'; // US$ 601
const e='0xd1a992417a0abffa632cbde4da9f5dcf85caa858'; // US$ 1985
const outro='0x1111111111111111111111111111111111111111';
const prios=new Set([a,b,c,d,e]);
const map=new Map([[a,new Decimal('41.18')],[b,new Decimal('3.57')],
 [c,new Decimal('266.74')],[d,new Decimal('601.25')],[e,new Decimal('1985.95')]]);
test('cinco caindo juntos: maior oportunidade vem antes da poeira, sem consumir nonce',()=>{
    const got=ordenarCaidosPorPremio({caidos:[a,b,c,d,e],prioritarios:prios,premiosUsd:map});
    assert.deepEqual(got,[e,d,c,a,b]);
});
test('somente quando varios caem: nao antecipa devedor saudavel',()=>{
    assert.deepEqual(ordenarCaidosPorPremio({caidos:[b,a],prioritarios:prios,premiosUsd:map}),[a,b]);
    assert.deepEqual(ordenarCaidosPorPremio({caidos:[b],prioritarios:prios,premiosUsd:map}),[b]);
    assert.deepEqual(ordenarCaidosPorPremio({caidos:[],prioritarios:prios,premiosUsd:map}),[]);
});
test('quem nao esta na selecao continua processado, sem duplicacao',()=>{
    const got=ordenarCaidosPorPremio({caidos:[outro,b,a],prioritarios:prios,premiosUsd:map});
    assert.deepEqual(got,[a,b,outro]);
});
test('sem leitura ou com premio inválido nao ganha prioridade por suposicao',()=>{
    const got=ordenarCaidosPorPremio({caidos:[outro,b,a],prioritarios:prios,
      premiosUsd:new Map([[b,new Decimal('NaN')],[a,new Decimal('41.18')]])});
    assert.deepEqual(got,[a,outro,b]);
});
test('empate conserva ordem original, prioridade nao aumenta gasto de gas',()=>{
    const got=ordenarCaidosPorPremio({caidos:[d,c,a],prioritarios:prios,premiosUsd:
       new Map([[d,new Decimal(5)],[c,new Decimal(5)],[a,new Decimal(4)]])});
    assert.deepEqual(got,[d,c,a]);
});
