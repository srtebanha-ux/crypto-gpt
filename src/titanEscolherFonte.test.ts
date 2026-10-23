import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avaliarFonte, melhorFonte, type CotacaoFonte } from './titanEscolherFonte';
const caso=(fonte:CotacaoFonte['fonte'],feeBps:bigint,gas:bigint,bruto:bigint):
    CotacaoFonte=>({
        fonte,principalWei:1_000_000n,gasTotalConservadorWei:gas,
        lucroBrutoSimuladoWei:bruto,premioBps:feeBps,capitalDisponivel:true,
    });
test('Aave 5bps cobra fee SOBRE PRINCIPAL, nao gas',()=>{
    const a=avaliarFonte(caso('aave-v3',5n,200n,800n));
    assert.equal(a.taxaEmprestimoWei,500n);
    assert.equal(a.custoTotalWei,700n);
    assert.equal(a.lucroLiquidoWei,100n);
    assert.equal(a.validada,true);
});
test('Morpho zero fee pode PERDER para flashswap, se gas adicional for maior',()=>{
    const f=caso('flashswap-v3',0n,200n,500n);
    const m=caso('morpho-blue',0n,450n,500n);
    assert.equal(melhorFonte([m,f])?.fonte,'flashswap-v3');
});
test('Morpho ganha se seu proprio ensaio ja provar ganho liquido maior',()=>{
    const f=caso('flashswap-v3',0n,700n,800n);
    const m=caso('morpho-blue',0n,300n,800n);
    assert.equal(melhorFonte([f,m])?.fonte,'morpho-blue');
});
test('sem ensaio, ou sem premio medido, fonte nunca e selecionada',()=>{
    const f=caso('balancer',0n,100n,300n);
    f.premioBps=null;
    assert.equal(avaliarFonte(f).validada,false);
    assert.equal(melhorFonte([f]),null);
});
test('zero taxa no contrato nao prova lucro; taxa de swaps esta no bruto',()=>{
    assert.equal(avaliarFonte(caso('morpho-blue',0n,300n,300n)).validada,false);
    assert.equal(avaliarFonte(caso('morpho-blue',0n,300n,315n)).validada,true);
});
test('nao inventar custo ou spread entre fontes',()=>{
    const f=caso('flashswap-v3',0n,100n,200n);
    f.lucroBrutoSimuladoWei=null;
    assert.equal(melhorFonte([f]),null);
});
