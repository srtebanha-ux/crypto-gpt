import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Interface,parseEther} from 'ethers';
import {BASE_ATLAS,BASE_CONTROL} from './titanSvrOperacao';
import {diagnosticarSvr,type LeitorAtlas} from './titanSvrDiagnostico';

const signer='0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const executor='0x'+'7'.repeat(40);
const I_ATLAS=new Interface(['function VERIFICATION() view returns(address)',
 'function balanceOfBonded(address) view returns(uint256)']);
const I_CTRL=new Interface(['function getSolverGasLimit() view returns(uint256)']);
const verifier='0x6e1886aEca75160BAa5610B7c1D3a895198C61cf';
function fake(
 bond:bigint,codeExecutor='0x60016000',validVerification=true
):LeitorAtlas{
 return {
  async getCode(to:string){
   return to.toLowerCase()===executor.toLowerCase()?codeExecutor:'0x6000';
  },
  async call(req){
   if(req.to.toLowerCase()===BASE_CONTROL.toLowerCase())
    return I_CTRL.encodeFunctionResult('getSolverGasLimit',[6000000n]);
   const selector=req.data.slice(0,10);
   if(selector===I_ATLAS.getFunction('VERIFICATION')!.selector)
    return I_ATLAS.encodeFunctionResult('VERIFICATION',[
      validVerification?verifier:signer
    ]);
   if(selector===I_ATLAS.getFunction('balanceOfBonded')!.selector)
    return I_ATLAS.encodeFunctionResult('balanceOfBonded',[bond]);
   throw Error('unmocked method');
  }
 }
}
test('zero bonded ETH blocks live solver eligibility even with deployed bytecode',async()=>{
 const d=await diagnosticarSvr(fake(0n),signer,executor);
 assert.equal(d.prontoParaAnaliseFinanceira,false);
 assert.equal(d.garantiaEth,'0.0');
 assert.ok(d.impeditivos.some(z=>z.includes('0 ETH bonded')));
 assert.equal(d.gasMaximoSolver,'6000000');
});
test('correct Atlas verification and positive bond plus deployed solver passes *basic* eligibility',async()=>{
 const d=await diagnosticarSvr(fake(parseEther('0.1')),signer,executor);
 assert.equal(d.prontoParaAnaliseFinanceira,true);
 assert.equal(d.garantiaEth,'0.1');
 assert.equal(d.impeditivos.length,0);
});
test('missing solver contract and mismatch verifier are not silently accepted',async()=>{
 const d=await diagnosticarSvr(fake(parseEther('0.1'),'0x6000',false),signer,null);
 assert.equal(d.prontoParaAnaliseFinanceira,false);
 assert.ok(d.impeditivos.some(z=>z.includes('divergente')));
 assert.ok(d.impeditivos.some(z=>z.includes('nao implantado')));
 const e=await diagnosticarSvr(fake(parseEther('0.1'),'0x'),signer,executor);
 assert.ok(e.impeditivos.some(z=>z.includes('Nao ha bytecode')));
});
test('RPC failure is unknown, not zero ETH and not ready',async()=>{
 const d=await diagnosticarSvr({
  call:async()=>{throw Error('RPC timeout')},
  getCode:async()=>{throw Error('RPC timeout')}
 },signer,executor);
 assert.equal(d.prontoParaAnaliseFinanceira,false);
 assert.equal(d.garantiaEth,null);
 assert.ok(d.impeditivos.some(z=>z.includes('Falha ao ler bond')));
});
