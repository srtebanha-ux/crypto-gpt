'use strict';
/** Read-only Base SVR contract ABI/health snapshot: no account or keys. */
const fs=require('node:fs');
const {Interface}=require('ethers');
const ATLAS='0x583dcFef0D240DC80753F0F0B26513feE27D9B77';
const CONTROL='0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83';
const abi=new Interface([
 'function VERIFICATION() view returns(address)',
 'function getSolverGasLimit() view returns(uint256)',
]);
async function rpc(method,params){
 let errors=[];
 for(const url of ['https://base-rpc.publicnode.com','https://mainnet.base.org']){
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
  try{
   const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:ctrl.signal});
   if(!r.ok)throw Error('HTTP '+r.status);
   const result=await r.json();
   if(result.error||result.result===undefined)throw Error(result.error?.message||'empty');
   return result.result;
  }catch(e){errors.push(String(e.message).slice(0,130))}finally{clearTimeout(timer)}
 }
 throw Error(errors.join(' / '));
}
async function view(target,fn){
 const answer=await rpc('eth_call',[{to:target,data:abi.encodeFunctionData(fn)},'latest']);
 return abi.decodeFunctionResult(fn,answer)[0];
}
(async()=>{
 const data={atlas:ATLAS,control:CONTROL,checkedAt:new Date().toISOString(),checks:[],errors:[]};
 try{
  let chain=BigInt(await rpc('eth_chainId',[]));
  if(chain!==8453n)throw Error('Wrong chain '+chain);
  let bytecode=await rpc('eth_getCode',[ATLAS,'latest']);
  if(bytecode==='0x')throw Error('Atlas contract missing');
  data.checks.push('Atlas deployed on Base');
  data.verification=await view(ATLAS,'VERIFICATION');
  data.checks.push('Verified EIP712 contract from Atlas.VERIFICATION()');
  data.solverGasLimit=(await view(CONTROL,'getSolverGasLimit')).toString();
  data.checks.push('Verified live Chainlink SolverGasLimit');
 }catch(e){data.errors.push(String(e.message).slice(0,400))}
 fs.mkdirSync('.tmp',{recursive:true});
 fs.writeFileSync('.tmp/atlas-abi-health.json',JSON.stringify(data,null,2));
 console.log('ATLAS_ABI_HEALTH',JSON.stringify(data));
 if(data.errors.length)process.exitCode=2;
})().catch(e=>{console.error(e);process.exitCode=1});
