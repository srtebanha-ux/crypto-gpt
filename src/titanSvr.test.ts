import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {
 BASE_CHAIN_ID,decodificarNotificacaoSvr,DedupLeiloesSvr,
 planejarLanceSvr,codificarLoteSvr,TITAN_ATLAS_BATCH_ABI
} from './titanSvr';

const h='0x'+'1'.repeat(64),atlas='0x'+'2'.repeat(40),control='0x'+'3'.repeat(40);
function aviso(id:string,hash=h){
 return{jsonrpc:'2.0',method:'solver_subscription',params:{
  subscription:'x',
  result:{auction_id:id,partial_user_operation:{
   chainId:'0x2105',userOpHash:hash,to:atlas,control,
   gas:'0x4e20',maxFeePerGas:'0x4c4b40',deadline:'0x123456'
  }}
 }};
}
const id1='1bc9a4ce-4fcf-4eb1-8632-959e2273953e',id2='2bc9a4ce-4fcf-4eb1-8632-959e2273953e';
test('notification Base is strictly validated, never accepts another chain',()=>{
 const v=decodificarNotificacaoSvr(aviso(id1));
 assert.equal(BASE_CHAIN_ID,8453);assert.equal(v?.id,id1);
 assert.equal(v?.maxFeePerGas,5000000n);assert.equal(v?.atlas,atlas);
 assert.equal(decodificarNotificacaoSvr({
  ...aviso(id1),params:{result:{...aviso(id1).params.result,
    partial_user_operation:{...aviso(id1).params.result.partial_user_operation,chainId:'0x1'}}}
 }),null);
 assert.equal(decodificarNotificacaoSvr({method:'solver_subscription',params:{result:{
  ...aviso(id1).params.result,partial_user_operation:{chainId:'0x2105'}}}}),null);
});
test('two independent auctions for same price update must both be checked',()=>{
 const d=new DedupLeiloesSvr();
 const a=decodificarNotificacaoSvr(aviso(id1))!,b=decodificarNotificacaoSvr(aviso(id2))!;
 assert.equal(a.hash,b.hash);
 assert.equal(d.recebe(a,100),true);
 assert.equal(d.recebe(a,101),false);
 assert.equal(d.recebe(b,101),true);
 assert.equal(d.recebe(a,200001),true);
});
test('bid only if gross beats oracle fees, slippage, swap, min net and safety',()=>{
 const base={
  lucroBrutoEsperadoWei:1000n,custoSwapWei:40n,riscoSlippageWei:100n,
  custoGasEAtualizacaoOracleWei:80n,margemSegurancaWei:60n,
  minimoLiquidoWei:100n,lanceCompetidorWei:200n
 };
 const r=planejarLanceSvr(base);
 assert.equal(r.permitido,true);
 if(r.permitido){
  assert.equal(r.lanceWei,201n);
  assert.equal(r.lucroLiquidoPrevistoWei,519n);
 }
 assert.equal(planejarLanceSvr({...base,lanceCompetidorWei:650n}).permitido,false);
 assert.equal(planejarLanceSvr({...base,custoGasEAtualizacaoOracleWei:780n}).permitido,false);
 const semRival=planejarLanceSvr({...base,lanceCompetidorWei:undefined});
 assert.equal(semRival.permitido,true);
 if(semRival.permitido) {
  // gross 1000 - costs 280 - min-net 100 = 620;
  // ceiling 80% of 620 = 496; fallback 75% of ceiling = 372
  assert.equal(semRival.lanceWei,372n);
  assert.equal(semRival.lucroLiquidoPrevistoWei,348n);
  assert.equal(semRival.origemLance,'proprio');
 }
 assert.equal(planejarLanceSvr({...base,lanceCompetidorWei:undefined,
   fracaoTetoSemRivalBps:10001}).permitido,false);
 assert.equal(planejarLanceSvr({...base,lanceCompetidorWei:undefined,
   lucroBrutoEsperadoWei:381n}).permitido,false);
 assert.equal(planejarLanceSvr({...base,lucroBrutoEsperadoWei:-5n}).permitido,false);
 assert.equal(planejarLanceSvr({...base,limiteOfertaBps:10000}).permitido,false);
});
test('batch calldata is deterministic and refuses mixed seized/repaid and empty batch',()=>{
 const market={loanToken:atlas,collateralToken:control,oracle:atlas,irm:control,lltv:860000000000000000n};
 const one={market,devedor:control,seizedAssets:100n,repaidShares:0n,poolEstavel:false,lucroMinimoWeth:5n};
 const data=codificarLoteSvr([one,one],7n);
 const decoded=new Interface(TITAN_ATLAS_BATCH_ABI).decodeFunctionData('executarLote',data);
 assert.equal(decoded.alvos.length,2);assert.equal(decoded.minimoLiquidoWeth,7n);
 assert.throws(()=>codificarLoteSvr([],7n));
 assert.throws(()=>codificarLoteSvr([{...one,repaidShares:1n}],7n));
 assert.throws(()=>codificarLoteSvr([one],0n));
});
