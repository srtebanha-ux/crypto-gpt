import test from 'node:test';
import assert from 'node:assert/strict';
import {selecionarRotasComGasComparavel} from './titanSelecaoGas';
const weth='0x4200000000000000000000000000000000000006';
const usdc='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
test('tokens sem preco nunca ocupam vagas de rotas em WETH',()=>{
  const amostra=[
    {U:usdc,sobra:999999999999999999999999n},
    {U:weth.toUpperCase().replace('0X','0x'),sobra:100n},
    {U:weth,sobra:90n},
    {U:usdc,sobra:99999n},
  ];
  const r=selecionarRotasComGasComparavel(amostra,weth,1);
  assert.equal(r.comConversao,2);
  assert.equal(r.semConversao,2);
  assert.deepEqual(r.selecionados.map(x=>x.sobra),[100n]);
});
test('nenhuma rota comparavel nao cria lucro economico imaginario',()=>{
  const r=selecionarRotasComGasComparavel([{U:usdc}],weth,10);
  assert.deepEqual(r.selecionados,[]);
  assert.equal(r.semConversao,1);
  assert.throws(()=>selecionarRotasComGasComparavel([],weth,0),/invalido/);
});
