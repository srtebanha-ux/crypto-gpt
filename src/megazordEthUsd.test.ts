import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {usdParaWethWei,tickMedio,ethUsdNoTick,consultarEthUsdBase,
 atualizarPisoUsdMegazord,type LeitorPrecoV3} from './megazordEthUsd';
import {FABRICA_V3_BASE,POOLS_V3_BASE_CACA} from './titanPonteMultiHop';
const WETH='0x4200000000000000000000000000000000000006';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const pool=POOLS_V3_BASE_CACA[0]!.endereco;
const abi=new Interface(['function token0() view returns(address)',
 'function token1() view returns(address)','function factory() view returns(address)',
 'function fee() view returns(uint24)','function liquidity() view returns(uint128)',
 'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)',
 'function observe(uint32[]) view returns(int56[],uint160[])']);
const fab=new Interface(['function getPool(address,address,uint24) view returns(address)']);
function mock(spotTick=-200000,twapTick=-200000):LeitorPrecoV3{
 return {
  getCode:async()=>'0x6000',
  call:async({to,data})=>{
   if(to.toLowerCase()===FABRICA_V3_BASE.toLowerCase())
     return fab.encodeFunctionResult('getPool',[pool]);
   const method=abi.parseTransaction({data})!.name;
   const ret:Record<string,unknown[]>={
    token0:[WETH],token1:[USDC],factory:[FABRICA_V3_BASE],fee:[500],
    liquidity:[1000000000000000000n],
    slot0:[1n,spotTick,0,2,2,0,true],
    observe:[[-BigInt(twapTick)*1800n,0n],[0n,0n]],
   };
   return abi.encodeFunctionResult(method,ret[method]!);
  },
 };
}
test('USD to WETH floors ceil instead of rounding down a cent',()=>{
 assert.equal(usdParaWethWei('0.35','3500'),100000000000000n);
 assert.equal(usdParaWethWei('0.35','2000'),175000000000000n);
 assert.equal(usdParaWethWei('0.35','3000'),116666666666667n);
 assert.throws(()=>usdParaWethWei('0.3501','3000'),/ate 2 casas/);
 assert.throws(()=>usdParaWethWei('0.35','0'),/fora do intervalo/);
});
test('Uniswap mean tick rounds negative toward minus infinity',()=>{
 assert.equal(tickMedio(0n,-1800000n),-1000);
 assert.equal(tickMedio(0n,-1800001n),-1001);
 assert.equal(tickMedio(0n,1800001n),1000);
 assert.ok(Number(ethUsdNoTick(-200000))>1000);
});
test('onchain oracle verifies factory/pool and 30m TWAP, never a spot-only quote',async()=>{
 const price=await consultarEthUsdBase(mock());
 assert.ok(Number(price)>1000&&Number(price)<5000);
 await assert.rejects(consultarEthUsdBase(mock(-198000,-200000)),/diverge mais de 3%/);
});
test('Megazord USD default refresh is conservative and never lowers an explicit WETH floor',async()=>{
 const env:NodeJS.ProcessEnv={MEGAZORD_MODO:'execucao'};
 const first=await atualizarPisoUsdMegazord(env,mock());
 assert.ok(BigInt(first.minimoWei)>0n);
 assert.ok(Number(env.MEGAZORD_COTACAO_ATUALIZADA_EM_MS)>0);
 const env2:NodeJS.ProcessEnv={CACA_MORPHO_V3_LUCRO_MIN_WETH_WEI:'999999999999999'};
 const r=await atualizarPisoUsdMegazord(env2,mock());
 assert.equal(r.minimoWei,'999999999999999');
});
test('failed oracle refresh resets readiness before rejecting',async()=>{
 const env:NodeJS.ProcessEnv={MEGAZORD_COTACAO_ATUALIZADA_EM_MS:String(Date.now())};
 await assert.rejects(atualizarPisoUsdMegazord(env,mock(-198000,-200000)),/diverge/);
 assert.equal(env.MEGAZORD_COTACAO_ATUALIZADA_EM_MS,'0');
});
