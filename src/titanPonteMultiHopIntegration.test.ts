import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import type { JsonRpcProvider } from 'ethers';
import {
    ABI_MULTI, MORPHO_FLASH_BASE, prepararOfertaMulti, revalidarOfertaMulti,
    type EntradaPonte,
} from './titanPonteMultiHop';
const a=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const A=a(1),B=a(2),C=a(3);
const e:EntradaPonte={
    usuario:a(4),garantia:A,divida:B,dividaCrua:1_000_000_000n,
    creditoMaximo:500_000_000n,dividaUsd:new Decimal(1000),
    ethUsd:new Decimal(2000),dono:a(9),contrato:a(10),cofre:a(11),
    aave:a(12),fabricaV3:a(13),maxFeePerGas:1_000_000_000n,
    reservaL1Wei:10_000_000_000_000n,gasMax:1_500_000n,
    maxCotacoes:32,
    pools:[
        {endereco:a(21),token0:A,token1:B,protocolo:'v3',taxa:500,permitida:true},
        {endereco:a(22),token0:A,token1:C,protocolo:'v3',taxa:500,permitida:true},
        {endereco:a(23),token0:C,token1:B,protocolo:'v3',taxa:500,permitida:true},
    ],
};
const getters:Record<string,string>={dono:e.dono,cofre:e.cofre,aave:e.aave,
    morpho:MORPHO_FLASH_BASE,fabricaV3:e.fabricaV3};
function provider(opts:{ownerCorrompido?:boolean;bloco?:number}={}):JsonRpcProvider {
    return {
        getNetwork:async()=>({chainId:8453n}),
        getCode:async()=> '0x60016000',
        getBlockNumber:async()=>opts.bloco??1000,
        estimateGas:async()=> 330_000n,
        call:async(t:{data:string})=>{
            for(const nome of Object.keys(getters)){
                if(t.data===ABI_MULTI.encodeFunctionData(nome)){
                    const valor=nome==='dono'&&opts.ownerCorrompido?a(99):getters[nome];
                    return ABI_MULTI.encodeFunctionResult(nome,[valor]);
                }
            }
            const decoded=ABI_MULTI.decodeFunctionData('liquidar',t.data);
            const quantidade=decoded[3] as bigint;
            const piso=decoded[4] as bigint;
            const saltos=(decoded[5] as unknown[]).length;
            const lucro=quantidade*BigInt(saltos===2?5:2)/100n;
            if(lucro<piso) throw new Error('SemLucro: contrato reverteria');
            return ABI_MULTI.encodeFunctionResult('liquidar',[lucro]);
        },
    } as unknown as JsonRpcProvider;
}
test('o planejador chama ABI real no mesmo bloco e prefere multi-hop lucrativo',async()=>{
    const p=provider();
    const plano=await prepararOfertaMulti(p,e);
    assert.ok(plano,'quote onchain esperado');
    assert.equal(plano.rota.pernas.length,2);
    assert.ok(plano.piso>0n);
    assert.ok(plano.lucroCru>plano.piso);
    assert.ok(plano.liquidoCru>0n);
    assert.equal(await revalidarOfertaMulti(p,plano,e.dono),true);
    assert.equal(await revalidarOfertaMulti(provider({bloco:1004}),plano,e.dono),false);
});
test('executor com dono diferente e recusado ANTES de simular swaps',async()=>{
    await assert.rejects(()=>prepararOfertaMulti(provider({ownerCorrompido:true}),e),
        /executor Multi-Hop divergente em dono/);
});
