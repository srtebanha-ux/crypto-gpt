import {test} from 'node:test';
import assert from 'node:assert/strict';
import {explorarTriangulos,avaliarTetoTriangulo,capacidadePrimeiroPool,tamanhosTriangulo,sondasTriangulo,rotaExecutavelTriangulo} from './titanTriangulos';
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

test('rotas triangulares aceitam 3 pernas conforme o contrato ja implantado',()=>{
    const rs=explorarTriangulos([pool(10,1,2),pool(11,2,3,'aerodrome'),pool(12,3,1)],adr(1));
    for(const t of rs){
        assert.equal(t.pernas.length,3);
        const rota=rotaExecutavelTriangulo(t,100n);
        assert.equal(rota.length,3);
        assert.equal(rota[0]!.tokenEntra,adr(1));
        assert.equal(rota[1]!.tokenEntra,t.tokens[1]);
        assert.equal(rota[2]!.tokenEntra,t.tokens[2]);
        if(t.venues[0]==='aerodrome')assert.equal(rota[0]!.pagamento,100n);
        else assert.equal(rota[0]!.pagamento,0n);
        assert.equal(rota[1]!.pagamento,0n);
    }
});
test('tamanho de cada triangulo vem apenas da liquidez da primeira pool real',()=>{
    const rs=explorarTriangulos([pool(10,1,2),pool(11,2,3),pool(12,3,1)],adr(1));
    const t=rs.find(x=>x.pools[0]===adr(10))!;
    const l={sqrtPorPoolV3:new Map<string,bigint|null>(),token0PorPool:new Map<string,string>(),
        reservasAerodrome:new Map<string,{r0:bigint;r1:bigint}|null>(),bloco:1,
        saldoDaBaseNoV3:new Map([[adr(10),1_000_000n]]),liquidezDoV3:new Map<string,bigint|null>()};
    assert.equal(capacidadePrimeiroPool(t,l),1_000_000n);
    assert.deepEqual(tamanhosTriangulo(capacidadePrimeiroPool(t,l)),[1000n,3333n,10000n]);
    assert.deepEqual(tamanhosTriangulo(null),[]);
});
test('filtro marginal de 3 pernas nunca rejeita com leitura desconhecida',()=>{
    const t=explorarTriangulos([pool(10,1,2),pool(11,2,3),pool(12,3,1)],adr(1))[0]!;
    const maps={sqrtPorPoolV3:new Map<string,bigint|null>(),
        token0PorPool:new Map<string,string>(),reservasAerodrome:new Map<string,{r0:bigint;r1:bigint}|null>(),
        bloco:1,saldoDaBaseNoV3:new Map<string,bigint|null>(),liquidezDoV3:new Map<string,bigint|null>()};
    assert.equal(avaliarTetoTriangulo(t,maps).estado,'dados-insuficientes');
    for(const p of t.pools){maps.sqrtPorPoolV3.set(p,2n**96n);maps.liquidezDoV3.set(p,1000n);}
    assert.equal(avaliarTetoTriangulo(t,maps).estado,'sem-spread');
});

test('sondas triangulares percorrem as tres fracoes de liquidez sem repetir ou extrapolar', () => {
    const t = tamanhosTriangulo(1_000_000n);
    assert.deepEqual(sondasTriangulo(t,0),[1000n,3333n,10000n]);
    assert.deepEqual(sondasTriangulo(t,1),[3333n,10000n,1000n]);
    assert.deepEqual(sondasTriangulo(t,2,2),[10000n,1000n]);
    assert.deepEqual(sondasTriangulo(t,2,100),[10000n,1000n,3333n]);
});
test('sondas nao inventam capital em pool sem liquidez nem permitem entradas invalidas', () => {
    assert.deepEqual(sondasTriangulo([],0),[]);
    assert.deepEqual(sondasTriangulo([0n,-3n,100n,100n],0),[100n]);
    assert.deepEqual(sondasTriangulo([100n],-1),[]);
    assert.deepEqual(sondasTriangulo([100n],0,0),[]);
});
