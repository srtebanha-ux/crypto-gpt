import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,TypedDataEncoder,verifyTypedData} from 'ethers';
import {
 BASE_ATLAS,BASE_CONTROL,ETH_ZERO,ATLAS_SOLVER_TYPES,
 validarEPlanejarOperacao,dominioAtlas,hashOperacaoAtlas,
 assinarOperacaoAtlasSomentePreparacao,envelopeJsonRpcDeEnvio
} from './titanSvrOperacao';
import type {LeilaoSvr} from './titanSvr';

const wallet=new Wallet('0x'+'42'.repeat(32)); // test fixture ONLY, not funded
const auc:LeilaoSvr={
 id:'1bc9a4ce-4fcf-4eb1-8632-959e2273953e',
 hash:'0x'+'44'.repeat(32),atlas:BASE_ATLAS.toLowerCase(),control:BASE_CONTROL.toLowerCase(),
 deadline:52800000n,maxFeePerGas:31603486n,gasDaOracle:20000n
};
const ctx={
 signer:wallet.address,solverContract:'0x'+'66'.repeat(20),
 verificationContract:'0x'+'77'.repeat(20),
 atlasVersion:'1.6.4',currentBlock:52799000n,maxSolverGas:1500000n,
 bondedWei:100000000000000000n,estimatedTotalGasWei:3000000000000000n
};
const build=(overrides:Partial<typeof ctx>={},bid=100000000000000n,gas=400000n)=>
 validarEPlanejarOperacao(auc,{...ctx,...overrides},bid,gas,'0x12345678');
test('Atlas EIP712 exact domain and raw solver operation; not signMessage EIP191',()=>{
 const op=build();
 assert.equal(op.gas,400000n);assert.equal(op.maxFeePerGas,auc.maxFeePerGas);
 assert.equal(op.bidToken,ETH_ZERO);
 const hashed=hashOperacaoAtlas(op,ctx);
 assert.equal(hashed,TypedDataEncoder.hash(dominioAtlas(ctx),ATLAS_SOLVER_TYPES as any,op));
 const signed=assinarOperacaoAtlasSomentePreparacao(auc,ctx,op,wallet);
 assert.equal(signed.auction_id,auc.id);
 assert.equal(signed.auction_solution.signature.length,132);
 assert.equal(signed.auction_solution.gas,'0x61a80');
 assert.equal(signed.auction_solution.maxFeePerGas,'0x1e23b1e');
 const recovered=verifyTypedData(dominioAtlas(ctx),ATLAS_SOLVER_TYPES as any,op,signed.auction_solution.signature);
 assert.equal(recovered,wallet.address);
 const rpc=envelopeJsonRpcDeEnvio(signed);
 assert.equal(rpc.method,'solver_submitSolverOperation');
 assert.equal(rpc.params[0].auction_solution.solver,ctx.solverContract);
});
test('must reject missing bonds, stale auctions, wrong Atlas, excess gas and unknown version',()=>{
 assert.throws(()=>build({bondedWei:0n}),/Bond Atlas/);
 assert.throws(()=>build({currentBlock:auc.deadline}),/expirado/);
 assert.throws(()=>build({atlasVersion:'1.7'}),/Versao Atlas/);
 assert.throws(()=>build({},1n,1500001n),/limites/);
 assert.throws(()=>build({solverContract:ETH_ZERO}),/nao implantado/);
 const wrong={...auc,control:ETH_ZERO};
 assert.throws(()=>validarEPlanejarOperacao(wrong,ctx,100n,400000n,'0x12345678'),/control/);
});
test('signer account must be the owner of Atlas-enabled solver',()=>{
 const other=new Wallet('0x'+'43'.repeat(32));
 assert.throws(()=>assinarOperacaoAtlasSomentePreparacao(auc,ctx,build(),other),/Signer/);
 assert.throws(()=>envelopeJsonRpcDeEnvio({auction_id:'',auction_solution:{} as any},0),/request id/);
});
