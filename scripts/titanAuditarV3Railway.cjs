// Exact read-only onchain identity for the Morpho V3 contract recorded in Railway.
// Only public addresses, no keys, no eth_send* method. Mismatches fail closed.
const {Interface,keccak256,getAddress}=require('ethers');
const target='0x4628b37Ad534cB382ed56bC5d8801D12f86A7dCb';
const expected={
 dono:'0x3D310384d674532f5D41cF2D43B03001F3515AE8',
 cofre:'0x3dffA934170bdD491724747Be2c4F56E3f1512A7',
 morpho:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
 routerV3:'0x2626664c2603336E57B271c5C0b26F421741e481',
 fabricaV3:'0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
};
const abi=new Interface([...Object.keys(expected).map(k=>'function '+k+'() view returns(address)'),'function versaoRotas() view returns(uint256)']);
let rid=0;
async function rpc(url,method,params=[]){
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({id:++rid,jsonrpc:'2.0',method,params}),signal:AbortSignal.timeout(13000)});
 if(!response.ok)throw Error('rpc_unavailable');
 const data=await response.json();
 if(data.error||data.result===undefined)throw Error('rpc_unavailable');
 return data.result;
}
async function audit(primary,secondary){
 if(BigInt(await rpc(primary,'eth_chainId'))!==8453n||BigInt(await rpc(secondary,'eth_chainId'))!==8453n)
  throw Error('wrong_chain');
 const block=await rpc(primary,'eth_getBlockByNumber',['latest',false]);
 const other=await rpc(secondary,'eth_getBlockByNumber',[block.number,false]);
 if(!block?.hash||other?.hash!==block.hash)throw Error('rpc_block_disagreement');
 const checks=[];
 for(const u of [primary,secondary]){
  const code=await rpc(u,'eth_getCode',[target,block.number]);
  if(code==='0x')throw Error('contract_not_deployed');
  const values={};
  for(const name of [...Object.keys(expected),'versaoRotas']){
   try{
    const ret=await rpc(u,'eth_call',[{to:target,data:abi.encodeFunctionData(name)},block.number]);
    const v=abi.decodeFunctionResult(name,ret)[0];
    values[name]=typeof v==='bigint'?v.toString():getAddress(v);
   }catch{values[name]=null}
  }
  checks.push({hash:keccak256(code),sizeBytes:(code.length-2)/2,values});
 }
 const equalHashes=checks[0].hash===checks[1].hash;
 const compatible=equalHashes&&checks.every(x=>x.values.versaoRotas==='2'&&
  Object.entries(expected).every(([k,v])=>x.values[k]?.toLowerCase()===v.toLowerCase()));
 return {chainId:8453,contract:target,block:Number(BigInt(block.number)),blockHash:block.hash,
  codehash:checks[0].hash,twoIndependentRpcCodesAgree:equalHashes,
  version:checks[0].values.versaoRotas,
  checks:Object.fromEntries(Object.keys(expected).map(k=>[k,{expected:expected[k],actual:checks[0].values[k],
   matches:checks.every(x=>x.values[k]?.toLowerCase()===expected[k].toLowerCase())}])),
  compatibleWithCurrentMegazordRoute:compatible,
  insufficientToAuthorizePaidTx:true,
  note:'Mesmo que os imutaveis coincidam, comparar bytecode com artefato auditado, diario e assinador antes do envio.'};
}
(async()=>{
 let result=null;
 for(const pair of [['https://mainnet.base.org','https://base-rpc.publicnode.com'],
  ['https://base-rpc.publicnode.com','https://mainnet.base.org']]){
  try{result=await audit(...pair);break}catch{}
 }
 console.log(JSON.stringify(result??{contract:target,status:'public_rpc_unavailable',
  compatibleWithCurrentMegazordRoute:false},null,2));
})();
