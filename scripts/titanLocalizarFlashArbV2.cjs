// Strict public identity check of EXISTING Base FlashArb V2 CREATE contracts.
// No signer, no secrets, no transactions, no deployments. Does not authorize execution.
const fs=require('node:fs');
const {Interface,AbiCoder,keccak256,getAddress}=require('ethers');
const {correspondeFlashArb}=require('../dist/titanV2Prova');
const owner='0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const candidates=[
 '0xd87AeEcCb5969BA28C49581736cD2c0b58B117A8',
 '0xee41dfd2B294194A623827d91F57c6978a011E30',
 '0x577C93B2ac8339A0c6d1E7d683896D7B02b54195',
];
const artifact=JSON.parse(fs.readFileSync('.tmp/artifacts/FlashArbProva.json','utf8'));
const rpcUrls=['https://mainnet.base.org','https://base-rpc.publicnode.com'];
let rid=0;
async function rpc(url,method,params=[]){
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({id:++rid,jsonrpc:'2.0',method,params}),signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw Error('public-rpc-unavailable');
 const data=await r.json();
 if(data.error||typeof data.result==='undefined')throw Error('public-rpc-unavailable');
 return data.result;
}
async function query(){
 const chains=await Promise.all(rpcUrls.map(x=>rpc(x,'eth_chainId')));
 if(chains.some(x=>BigInt(x)!==8453n))throw Error('wrong-chain');
 const tag=await rpc(rpcUrls[0],'eth_blockNumber',[]);
 const blocks=await Promise.all(rpcUrls.map(x=>rpc(x,'eth_getBlockByNumber',[tag,false])));
 if(blocks.some(x=>!x||x.hash!==blocks[0].hash))throw Error('public-rpcs-disagree');
 const abi=new Interface(['function owner() view returns(address)']);
 const result=[];
 for(const address of candidates){
  const codes=await Promise.all(rpcUrls.map(url=>rpc(url,'eth_getCode',[address,tag])));
  const hashes=codes.map(code=>code==='0x'?null:keccak256(code));
  let contractOwner=null;
  try{
   const raw=await rpc(rpcUrls[0],'eth_call',[{to:address,
    data:abi.encodeFunctionData('owner')},tag]);
   contractOwner=getAddress(abi.decodeFunctionResult('owner',raw)[0]);
  }catch{}
  const bytecodeEqual=Boolean(hashes[0]&&hashes[0]===hashes[1]);
  const artifactMatches=bytecodeEqual&&contractOwner?.toLowerCase()===owner.toLowerCase()
   &&correspondeFlashArb(codes[0],artifact,owner);
  result.push({address,codehash:hashes[0],owner:contractOwner,
   bytecodeEqualTwoRpcs:bytecodeEqual,
   matchesCurrentFlashArbArtifact:Boolean(artifactMatches),
   allowedForExecution:false});
 }
 const validated=result.filter(x=>x.matchesCurrentFlashArbArtifact);
 return {chainId:8453,owner,block:tag,blockHash:blocks[0].hash,results:result,
  uniqueValidatedContract:validated.length===1?validated[0].address:null,
  readyForExecution:false,
  caveat:'Public artifact identity only. Requires Railway allowlist, journal and nonce, signer exclusivity, fresh quote/callback simulation, and explicit spending authorization.'};
}
void query().then(r=>console.log(JSON.stringify(r,null,2)))
.catch(()=>console.log(JSON.stringify({owner,status:'RPC_PUBLIC_INCONCLUSIVE',
  readyForExecution:false},null,2)));
