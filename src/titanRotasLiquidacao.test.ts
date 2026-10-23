import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    gerarRotasLiquidacao,selecionarMelhorRotaLiquidacao,type PoolLiquidacao,
} from './titanRotasLiquidacao';
const A='0x0000000000000000000000000000000000000011';
const B='0x0000000000000000000000000000000000000022';
const C='0x0000000000000000000000000000000000000033';
const D='0x0000000000000000000000000000000000000044';
const E='0x0000000000000000000000000000000000000055';
const id=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const pool=(n:number,a:string,b:string,
    protocolo:'v3'|'aerodrome'='v3',permitida=true):PoolLiquidacao=>({
    endereco:id(n),token0:a,token1:b,protocolo,
    taxa:protocolo==='v3'?500:null,permitida,
});
test('gera rota direta e rota alternativa de tres saltos',()=>{
    const ps=[pool(101,A,B),pool(102,A,C),pool(103,C,D,'aerodrome'),pool(104,D,B)];
    const out=gerarRotasLiquidacao(ps,A,B,4);
    assert.equal(out.length,2);
    assert.deepEqual(out.map(x=>x.pernas.length),[1,3]);
    assert.equal(out[1]!.pernas[1]!.tipo,1);
    assert.equal(out[1]!.pernas[1]!.fee,0);
});
test('pool nao autorizada e token repetido nao entram no contrato',()=>{
    const ps=[pool(101,A,C),pool(102,C,A),pool(103,C,B,'aerodrome',false)];
    assert.deepEqual(gerarRotasLiquidacao(ps,A,B),[]);
});
test('respeita cap de 4 saltos e limite de rotas',()=>{
    const ps=[pool(101,A,C),pool(102,C,D),pool(103,D,E),pool(104,E,B)];
    assert.equal(gerarRotasLiquidacao(ps,A,B,3).length,0);
    assert.equal(gerarRotasLiquidacao(ps,A,B,4).length,1);
});
test('escolhe retorno liquido por QUOTE e nao por numero de hops',()=>{
    const ps=[pool(101,A,B),pool(102,A,C),pool(103,C,B)];
    const rotas=gerarRotasLiquidacao(ps,A,B);
    assert.equal(rotas.length,2);
    const r=selecionarMelhorRotaLiquidacao([
        {rota:rotas[0]!,recebidoDivida:1010n,
            principalMorpho:1000n,gasConvertidoEmDivida:20n,lucroMinimoDivida:1n},
        {rota:rotas[1]!,recebidoDivida:1150n,
            principalMorpho:1000n,gasConvertidoEmDivida:80n,lucroMinimoDivida:1n},
    ]);
    assert.equal(r?.rota.pernas.length,2);
    assert.equal(r?.lucroLiquido,70n);
});
test('nenhuma rota sem margem comprovada vira alvo',()=>{
    const r=gerarRotasLiquidacao([pool(101,A,B)],A,B)[0]!;
    assert.equal(selecionarMelhorRotaLiquidacao([{
        rota:r,recebidoDivida:1005n,principalMorpho:1000n,
        gasConvertidoEmDivida:10n,lucroMinimoDivida:1n,
    }]),null);
});
