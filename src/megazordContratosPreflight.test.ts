import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {auditarContratosMegazord} from './megazordContratosPreflight';
const owner='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20),code='0x60006000';
const abi=new Interface(['function owner() view returns(address)']);
const env={MEGAZORD_ENDERECO_PUBLICO:owner,TITAN_V2_CONTRATO:contract,FLASH_ARB_CODEHASH:keccak256(code)};
const rpc=async(method:string):Promise<unknown>=>{
 if(method==='eth_chainId')return '0x2105';
 if(method==='eth_getBlockByNumber')return {number:'0x1',hash:'0x'+'aa'.repeat(32)};
 if(method==='eth_getCode')return code;
 if(method==='eth_call')return abi.encodeFunctionResult('owner',[owner]);
 throw Error('unexpected '+method);
};
test('audits runtime hash and owner at identical block on both public readers',async()=>{
 const r=await auditarContratosMegazord(env,[rpc,rpc]);
 assert.equal(r.contracts[0].invariants.owner,owner);assert.equal(r.contracts[0].codehash,keccak256(code));
});
test('wrong code, owner, chain or canonical block never approve readiness',async()=>{
 for(const [method,bad] of [['eth_getCode','0x6001'],['eth_chainId','0x1'],
  ['eth_call',abi.encodeFunctionResult('owner',[contract])],
  ['eth_getBlockByNumber',{number:'0x1',hash:'0x'+'bb'.repeat(32)}]] as const){
  await assert.rejects(auditarContratosMegazord(env,[rpc,async m=>m===method?bad:rpc(m)]));
 }
 await assert.rejects(auditarContratosMegazord({...env,FLASH_ARB_CODEHASH:undefined},[rpc,rpc]),/CODEHASH/);
});
