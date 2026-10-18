'use strict';
/** Auditoria SOMENTE LEITURA de contratos liquidadores públicos da Base. */
const {id}=require('ethers');
const targets=[
  '0xd12810b19b596347a3afac206d3ca65d08594b3f',
  '0xb949a57ac64be7a9dbe535e14f859e4c56a0cf03',
];
const rpcUrls=['https://base-rpc.publicnode.com','https://mainnet.base.org'];
async function rpc(method,params){
 let err;
 for(const url of rpcUrls){
  try{
   const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),15000);
   let r;try{r=await fetch(url,{method:'POST',signal:ac.signal,
     headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})}
   finally{clearTimeout(timer)}
   if(!r.ok)throw Error('HTTP '+r.status);
   const x=await r.json();if(x.error)throw Error(JSON.stringify(x.error).slice(0,140));
   return x.result;
  }catch(e){err=e}
 }
 throw err;
}
const implSlot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
async function blockscout(addr){
 try{
  const ac=new AbortController(),t=setTimeout(()=>ac.abort(),12000);
  let r;try{r=await fetch('https://base.blockscout.com/api/v2/smart-contracts/'+addr,{signal:ac.signal,headers:{accept:'application/json'}})}
  finally{clearTimeout(t)}
  if(!r.ok)return{status:r.status};
  const j=await r.json();
  const abi=Array.isArray(j.abi)?j.abi:[];
  return{verified:j.is_verified??!!j.source_code,name:j.name??null,compiler:j.compiler_version??null,
   isProxy:j.is_proxy??null,implementation:j.implementation_address_hash??null,
   functions:abi.filter(x=>x.type==='function').map(x=>x.name).filter(Boolean).slice(0,90),
   sourceBytes:typeof j.source_code==='string'?j.source_code.length:0};
 }catch(e){return{error:String(e.message).slice(0,150)}}
}
async function sourcify(addr) {
 try {
  const ac=new AbortController(),t=setTimeout(()=>ac.abort(),10000);
  let response;try{
   response=await fetch('https://sourcify.dev/server/v2/contract/8453/'+addr+'?fields=all',{signal:ac.signal});
  }finally{clearTimeout(t)}
  if(!response.ok)return {status:response.status};
  const data=await response.json();
  const abi=Array.isArray(data.abi)?data.abi:[];
  return {found:true,match:data.match??null,verifiedAt:data.verifiedAt??null,
   contractName:data.metadata?.settings?.compilationTarget??null,
   sourceFiles:Object.keys(data.sources??{}).slice(0,25),
   methodNames:abi.filter(x=>x.type==='function').map(x=>x.name).filter(Boolean).slice(0,110),
   events:abi.filter(x=>x.type==='event').map(x=>x.name).filter(Boolean).slice(0,45)};
 }catch(e){return{error:String(e.message).slice(0,140)}}
}
function publicSelectors(code){
 // EVM PUSH4 bytecode candidates, not proof of public function dispatch.
 const found=new Set();
 let bytes=Buffer.from(code.slice(2),'hex');
 for(let i=0;i<bytes.length;i++){
   const op=bytes[i];
   if(op===0x63&&i+4<bytes.length)found.add('0x'+bytes.subarray(i+1,i+5).toString('hex'));
   if(op>=0x60&&op<=0x7f)i+=op-0x5f;
 }
 const known=['executeOperation(address,uint256,uint256,address,bytes)',
  'onMorphoLiquidate(uint256,bytes)','uniswapV3SwapCallback(int256,int256,bytes)',
  'pancakeV3SwapCallback(int256,int256,bytes)','liquidate(address,address,uint256,bool)',
  'liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)',
  'atlasSolverCall(address,address,uint256,uint256,bytes,bytes)',
  'withdraw(address,uint256)','sweep(address,address,uint256)'];
 return {candidateCount:found.size,examples:[...found].slice(0,95),
  matchesKnown:known.filter(fn=>found.has(id(fn).slice(0,10)))};
}
async function inspect(addr){
 const details={address:addr,explorer:'https://basescan.org/address/'+addr+'#code'};
 try{
  const [code,storage]=await Promise.all([
   rpc('eth_getCode',[addr,'latest']),rpc('eth_getStorageAt',[addr,implSlot,'latest'])
  ]);
  details.codeBytes=(code.length-2)/2;
  if(details.codeBytes<=500)details.proxyRuntimeHex=code;
  details.selectorAnalysis=publicSelectors(code);
  details.eip1967RawStorage=storage;
  if(storage&&/^0x[0-9a-fA-F]{64}$/.test(storage)&&BigInt(storage)>0n)
   details.eip1967Implementation='0x'+storage.slice(-40);
  for(const selector of ['0x5c60da1b','0xaaf10f42']){
   try{
    const reply=await rpc('eth_call',[{to:addr,data:selector},'latest']);
    if(/^0x[0-9a-fA-F]{64}$/.test(reply)&&BigInt(reply)>0n){
      (details.readFunctions??={})[selector]='0x'+reply.slice(-40);
    }
   }catch(_e){}
  }
 }catch(e){details.rpcError=String(e.message).slice(0,150)}
 details.verifiedSource=await blockscout(addr);
 details.sourcify=await sourcify(addr);
 if(details.eip1967Implementation){
  const impl=details.eip1967Implementation;
  details.implementationExplorer='https://basescan.org/address/'+impl+'#code';
  details.implementationSource=await blockscout(impl);
  details.implementationSourcify=await sourcify(impl);
  try{let code=await rpc('eth_getCode',[impl,'latest']);details.implBytes=(code.length-2)/2;details.implSelectors=publicSelectors(code)}
  catch(e){details.implError=String(e.message).slice(0,140)}
 }
 return details;
}
(async()=>{
 const all=await Promise.all(targets.map(inspect));
 console.log('=== INSPECAO DE PROXY/ABI DOS LIQUIDADORES ===');
 console.log(JSON.stringify(all,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
