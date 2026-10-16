import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planejarLiquidacaoTitan,type SimulacaoLiquidacao} from './titanPlanejadorLiquidacao';
const A='0x0000000000000000000000000000000000000011';
const B='0x0000000000000000000000000000000000000022';
const C='0x0000000000000000000000000000000000000033';
const id=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const pools=[
    {endereco:id(101),token0:A,token1:B,protocolo:'v3' as const,taxa:500,permitida:true},
    {endereco:id(102),token0:A,token1:C,protocolo:'v3' as const,taxa:500,permitida:true},
    {endereco:id(103),token0:C,token1:B,protocolo:'v3' as const,taxa:500,permitida:true},
];
test('escolhe multi-hop se ganho apos L1 L2 excede rota direta',()=>{
    let chamadas=0;
    const s=(rota:{pernas:unknown[]},q:bigint):SimulacaoLiquidacao=>{
        chamadas++;
        const extra=rota.pernas.length===2?70n:25n;
        return {recebidoDividaWei:q+extra,gasEmDividaWei:20n,
            premioEmprestimoWei:0n,bloco:123,completa:true};
    };
    const r=planejarLiquidacaoTitan(pools,A,B,1000n,10n,s,10,28);
    assert.ok(r);
    assert.equal(r.rota.pernas.length,2);
    assert.equal(r.liquidoWei,50n);
    assert.ok(chamadas<=28);
});
test('falha fechada quando quote nao tem recibo de simulacao completa',()=>{
    const r=planejarLiquidacaoTitan(pools,A,B,1000n,10n,
        ()=>({recebidoDividaWei:1200n,gasEmDividaWei:1n,
            premioEmprestimoWei:0n,bloco:123,completa:false}),10,24);
    assert.equal(r,null);
});
test('custo acima do spread nunca gera plano',()=>{
    const r=planejarLiquidacaoTitan(pools,A,B,1000n,10n,
        (_,q)=>({recebidoDividaWei:q+10n,gasEmDividaWei:15n,
            premioEmprestimoWei:1n,bloco:123,completa:true}),10,24);
    assert.equal(r,null);
});
test('blocos divergentes entre quotes nao viram mesmo snapshot',()=>{
    let seq=0;
    const r=planejarLiquidacaoTitan(pools,A,B,1000n,10n,
        (_,q)=>({recebidoDividaWei:q+100n,gasEmDividaWei:5n,
            premioEmprestimoWei:0n,bloco:123+(seq++===0?0:1),completa:true}),10,24);
    // Toda chamada de quote final deve conferir o mesmo bloco.
    assert.equal(r,null);
});
