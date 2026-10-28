const test=require('node:test'),assert=require('node:assert/strict');
const {Interface}=require('ethers');
const {audit,executorCompiladoIgual,expected}=require('./titanAuditarV3Railway.cjs');
const artifact=require('../.tmp/artifacts/contracts/TitanCacadorMorphoV3.sol/TitanCacadorMorphoV3.json');
const abi=new Interface(artifact.abi);
test('audit compiler reproduces Hardhat Paris runtime, rejects changed instructions',()=>{
 const d={};assert.equal(executorCompiladoIgual(artifact.deployedBytecode,d),true,JSON.stringify(d));
 assert.equal(d.evmVersion,'paris');
 const changed='0x'+(artifact.deployedBytecode.slice(2,4)==='60'?'61':'60')+artifact.deployedBytecode.slice(4);
 assert.equal(executorCompiladoIgual(changed,{}),false);
});
test('two-RPC audit completes comparison instead of hiding ReferenceError as unavailable RPC',async()=>{
 const rpc=async(_url,method,params)=>{
  if(method==='eth_chainId')return '0x2105';
  if(method==='eth_getBlockByNumber')return {number:'0x64',hash:'0x'+'11'.repeat(32)};
  if(method==='eth_getCode')return artifact.deployedBytecode;
  if(method==='eth_call'){
   const name=abi.parseTransaction({data:params[0].data}).name;
   return abi.encodeFunctionResult(name,[name==='versaoRotas'?2n:expected[name]]);
  }
  throw Error('unexpected method');
 };
 const r=await audit('https://primary.example','https://secondary.example',rpc);
 assert.equal(r.compiledExecutableMatchesOnchain,true);
 assert.equal(r.compatibleWithCurrentMegazordRoute,true);
 assert.equal(r.insufficientToAuthorizePaidTx,true);
});

test('same RPC host with different credentials is not a second witness',async()=>{
 await assert.rejects(audit('https://same.example/a','https://same.example/b',async()=>{throw Error('must not read');}),/independent_rpc_required/);
});
