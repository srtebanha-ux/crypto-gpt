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
const implSlot='0x360894a13ba1a3210667c828492db98dca3e2076cc373a920a3ca505d382bbc';
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
async function inspect(addr){
 const details={address:addr,explorer:'https://basescan.org/address/'+addr+'#code'};
 try{
  const [code,storage]=await Promise.all([
   rpc('eth_getCode',[addr,'latest']),rpc('eth_getStorageAt',[addr,implSlot,'latest'])
  ]);
  details.codeBytes=(code.length-2)/2;
  if(storage&&/^0x[0-9a-fA-F]{64}$/.test(storage)&&BigInt(storage)>0n)
   details.eip1967Implementation='0x'+storage.slice(-40);
 }catch(e){details.rpcError=String(e.message).slice(0,150)}
 details.verifiedSource=await blockscout(addr);
 if(details.eip1967Implementation){
  const impl=details.eip1967Implementation;
  details.implementationExplorer='https://basescan.org/address/'+impl+'#code';
  details.implementationSource=await blockscout(impl);
  try{let code=await rpc('eth_getCode',[impl,'latest']);details.implBytes=(code.length-2)/2}
  catch(e){details.implError=String(e.message).slice(0,140)}
 }
 return details;
}
(async()=>{
 const all=await Promise.all(targets.map(inspect));
 console.log('=== INSPECAO DE PROXY/ABI DOS LIQUIDADORES ===');
 console.log(JSON.stringify(all,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
