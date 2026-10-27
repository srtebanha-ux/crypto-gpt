const test=require('node:test');
const assert=require('node:assert/strict');
const {AbiCoder}=require('ethers');
const {classeRevertPublica,classificarRevert}=require('./titanCandidato53169975.cjs');

function reasonError(reason){
 return '0x08c379a0'+AbiCoder.defaultAbiCoder().encode(['string'],[reason]).slice(2);
}
test('canonical healthy revert is identified without exposing raw RPC errors',()=>{
 const e={info:{error:{data:reasonError('position is healthy')}}};
 assert.equal(classificarRevert(e),'saudavel_no_liquidate');
 assert.deepEqual(classeRevertPublica(e),{
  tipo:'saudavel_no_liquidate',selector:'0x08c379a0',razaoPublica:'position is healthy'});
});
test('repayment revert is recorded but never asserted to prove liquidation',()=>{
 const e={error:{error:{data:reasonError('ERC20: insufficient allowance')}}};
 assert.equal(classificarRevert(e),'inconclusiva');
 assert.deepEqual(classeRevertPublica(e),{
  tipo:'revert_com_mensagem',selector:'0x08c379a0',razaoPublica:'ERC20: insufficient allowance'});
});
test('custom error selector and missing revert data cannot claim eligibility',()=>{
 assert.equal(classificarRevert({data:'0x12345678'}),'inconclusiva');
 assert.equal(classeRevertPublica({data:'0x12345678'}).selector,'0x12345678');
 assert.equal(classificarRevert({message:'https://secret.example/key'}),'inconclusiva');
 assert.equal(classeRevertPublica({message:'https://secret.example/key'}).selector,null);
});
