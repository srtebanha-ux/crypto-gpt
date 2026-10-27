// Exact read-only onchain identity for the Morpho V3 contract recorded in Railway.
// Only public addresses, no keys, no eth_send* method. Mismatches fail closed.
const {Interface,keccak256,getAddress}=require('ethers');
const target='0x8F5268D7cBb4597321EB886c4Ef0CE75a6C8C317';
const expected={
 dono:'0x3D310384d674532f5D41cF2D43B03001F3515AE8',
 cofre:'0x3dffA934170bdD491724747Be2c4F56E3f1512A7',
 morpho:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
 routerV3:'0x2626664c2603336E57B271c5C0b26F421741e481',
 fabricaV3:'0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
};
const abi=new Interface([...Object.keys(expected).map(k=>'function '+k+'() view returns(address)'),'function versaoRotas() view returns(uint256)']);
const fs=require('node:fs');
const solc=require('solc');
function executorCompiladoIgual(codigo,diagnostico){
 diagnostico.compiler=solc.version();
 try{
  const source=fs.readFileSync('contracts/TitanCacadorMorphoV3.sol','utf8');
  const input={language:'Solidity',sources:{'TitanCacadorMorphoV3.sol':{content:source}},
   settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':[
    'evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}}};
  const output=JSON.parse(solc.compile(JSON.stringify(input)));
  if(output.errors?.some(x=>x.severity==='error'))return false;
  const obj=output.contracts['TitanCacadorMorphoV3.sol'].TitanCacadorMorphoV3.evm.deployedBytecode;
  const refs=Object.values(obj.immutableReferences).flat();
  diagnostico.references=refs.length;
  if(refs.length<5||refs.some(x=>!Number.isSafeInteger(x.start)||x.length!==32)){diagnostico.error='bad_immutables';return false;}
  function executable(code){
   if(!/^(?:[0-9a-f]{2})+$/i.test(code))return null;
   const length=parseInt(code.slice(-4),16),cut=code.length-(length+2)*2;
   if(length<8||length>1024||cut<0||!/^a[0-9a-f]/i.test(code.slice(cut,cut+2)))return null;
   return code.slice(0,cut).toLowerCase();
  }
  const original=executable(obj.object),actual=executable(codigo.slice(2));
  diagnostico.compiledExecutableBytes=original?.length/2??null;
  diagnostico.onchainExecutableBytes=actual?.length/2??null;
  if(!original||!actual||original.length!==actual.length){diagnostico.error='length_or_metadata';return false;}
  const mask=(hex)=>{let x=hex;for(const ref of refs){
    if((ref.start+ref.length)*2>x.length)return null;
    x=x.slice(0,ref.start*2)+'0'.repeat(ref.length*2)+x.slice((ref.start+ref.length)*2);
   }return x;};
  const cleanCompiled=mask(original),cleanChain=mask(actual);
  if(cleanCompiled!==null&&cleanChain!==null){
   diagnostico.firstDifferenceByte=Array.from({length:cleanCompiled.length/2},(_,i)=>i)
    .find(i=>cleanCompiled.slice(i*2,i*2+2)!==cleanChain.slice(i*2,i*2+2))??null;
   diagnostico.differenceCount=Array.from({length:cleanCompiled.length/2},(_,i)=>i)
    .filter(i=>cleanCompiled.slice(i*2,i*2+2)!==cleanChain.slice(i*2,i*2+2)).length;
  }
  return cleanCompiled!==null&&cleanCompiled===cleanChain;
 }catch{return false;}
}

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
  checks.push({hash:keccak256(code),sizeBytes:(code.length-2)/2,code,values});
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
  compiledExecutableMatchesOnchain:artifactMatch,compiledExecutableComparison:diagnosticoBytecode,
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
