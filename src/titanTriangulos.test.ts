import {test} from 'node:test';
import assert from 'node:assert/strict';
import {explorarTriangulos} from './titanTriangulos';
import type {PoolMisto} from './rotasMistas';
const adr=(x:number)=>'0x'+x.toString(16).padStart(40,'0');
const pool=(id:number,a:number,b:number,venue:'v3'|'aerodrome'='v3'):PoolMisto=>({
    endereco:adr(id),token0:adr(a),token1:adr(b),venue,taxa:500,estavel:false,
});
test('descobre o ciclo base-A-B-base nas duas direcoes sem repeticao de pool',()=>{
    const rs=explorarTriangulos([pool(10,1,2),pool(11,2,3,'aerodrome'),
        pool(12,3,1)],adr(1));
    assert.equal(rs.length,2);
    for(const x of rs){
        assert.equal(x.tokens[0],adr(1));
        assert.equal(x.tokens[3],adr(1));
        assert.equal(new Set(x.pools).size,3);
        assert.equal(x.prova,'descoberto-sem-cotacao');
    }
});
test('nao gera falso triangulo com mesmo pool nem caminho aberto',()=>{
    assert.equal(explorarTriangulos([pool(10,1,2),pool(11,2,3)],adr(1)).length,0);
    assert.equal(explorarTriangulos([pool(10,1,2),pool(11,2,3),
        pool(12,3,1)],adr(1),1).length,1);
});
test('ignora enderecos corrompidos e nunca autoriza arbitrar so por encontrar rota',()=>{
    const pools=[pool(10,1,2),pool(11,2,3),pool(12,3,1),{...pool(13,1,4),endereco:'falho'}];
    const rs=explorarTriangulos(pools,adr(1));
    assert.equal(rs.length,2);
    assert.ok(rs.every(x=>x.prova==='descoberto-sem-cotacao'));
});
