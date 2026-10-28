// Morpho V3 real-contract deployment COST ONLY against public Base RPC.
// No signer, private key, transaction broadcast, or state mutation.
const fs=require('node:fs');
const {ContractFactory,Interface,getCreateAddress,formatEther}=require('ethers');
const owner='0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const morpho='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const router='0x2626664c2603336E57B271c5C0b26F421741e481';
const fabrica='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const cofre='0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const cap=2000000000000000n;
const art=JSON.parse(fs.readFileSync('.tmp/artifacts/contracts/TitanCacadorMorphoV3.sol/TitanCacadorMorphoV3.json','utf8'));
let request=0;
async function rpc(url,method,params){
 const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:++request,method,params}),signal:AbortSignal.timeout(25000)});
 if(!res.ok)throw Error('rpc_'+res.status);
 const body=await res.json();
 if(body.error||body.result===undefined)throw Error('rpc_method_'+method);
 return body.result;
}
async function inspect(url){
 if(BigInt(await rpc(url,'eth_chainId',[]))!==8453n)throw Error('wrong_chain');
 const nonceLatest=BigInt(await rpc(url,'eth_getTransactionCount',[owner,'latest']));
 const noncePending=BigInt(await rpc(url,'eth_getTransactionCount',[owner,'pending']));
 const balance=BigInt(await rpc(url,'eth_getBalance',[owner,'latest']));
 const block=await rpc(url,'eth_getBlockByNumber',['latest',false]);
 if(!block?.baseFeePerGas)throw Error('base_fee_unavailable');
 for(const address of [morpho,router,fabrica]){
  if(await rpc(url,'eth_getCode',[address,'latest'])==='0x')throw Error('canonical_contract_missing');
 }
 const bytecode=(await new ContractFactory(art.abi,art.bytecode).getDeployTransaction(morpho,router,fabrica,cofre)).data;
 if(!bytecode||bytecode.length<500)throw Error('missing_creation_bytecode');
 const estimatedGas=BigInt(await rpc(url,'eth_estimateGas',[{from:owner,data:bytecode},'latest']));
 const gasLimit=estimatedGas+estimatedGas/5n;
 const baseFee=BigInt(block.baseFeePerGas);
 const priorityFee=20000000n;
 const maxFeePerGas=baseFee*2n+priorityFee;
 // Same Base predeploy L1 fee heuristic as the current paid deployment path,
 // but this cannot guarantee the L1 charge for a later transaction.
 const proxy=new Interface(['function getL1Fee(bytes) view returns(uint256)']);
 const conservativePayload='0x'+'ff'.repeat(Math.ceil((art.bytecode.length-2)/2)+500);
 let l1Fee=null;
 try{
  const r=await rpc(url,'eth_call',[{to:'0x420000000000000000000000000000000000000F',
   data:proxy.encodeFunctionData('getL1Fee',[conservativePayload])},'latest']);
  l1Fee=proxy.decodeFunctionResult('getL1Fee',r)[0];
 }catch{/* public RPC may omit fee predeploy functions */}
 const upper=gasLimit*maxFeePerGas+(l1Fee!==null?2n*l1Fee:0n);
 return {chainId:8453,onlyRead:true,owner,nonceLatest:nonceLatest.toString(),
  noncePending:noncePending.toString(),nonceClear:nonceLatest===noncePending,
  balanceWei:balance.toString(),balanceEth:formatEther(balance),baseFeeWei:baseFee.toString(),
  predictedAddressIfDeployedNext:getCreateAddress({from:owner,nonce:noncePending}),
  estimatedGas:estimatedGas.toString(),paddedGasLimit:gasLimit.toString(),
  maxFeePerGasWei:maxFeePerGas.toString(),
  l1FeeProbeWei:l1Fee?.toString()??null,
  indicativeWorstWei:l1Fee!==null?upper.toString():null,
  indicativeWorstEth:l1Fee!==null?formatEther(upper):null,
  currentCapWei:cap.toString(),
  withinExistingCap:l1Fee!==null&&upper<=cap,
  balanceCouldCover:l1Fee!==null&&balance>=upper,
  deployAllowed:false,txHash:null,
  caveat:'Indicative public read only. Fee, nonce, marker, lock and current balance must be revalidated by the existing guarded deployer. No sending or guarantee of liquidation profitability.'};
}
(async()=>{
 let found=null;
 for(const url of ['https://mainnet.base.org','https://base-rpc.publicnode.com']){
  try{found=await inspect(url);break;}catch{/* never leak endpoint diagnostics */}
 }
 console.log(JSON.stringify(found??{onlyRead:true,owner,status:'RPC_READ_INCONCLUSIVE',
  deployAllowed:false,txHash:null},null,2));
})();
