'use strict';
/** Decode public Atlas V1.6.4 Base Morpho liquidation auction results. Read-only. */
const {Interface,formatEther}=require('ethers');
const atlas='0x583dcfef0d240dc80753f0f0b26513fee27d9b77';
const target='0xd12810b19b596347a3afac206d3ca65d08594b3f';
const hashes=[
 '0x7802fcdbf5759506bdebfa2b82a43d6d46cab5f47c675ed022d0cff32fe8fed7',
 '0x90850fe22bde38d649ca2c04f4b4050bf790c55b4b4537de059882fa0714e36e',
 '0x2c3266f04cd1e6b902005e03ce68311d92157a143eb672c7806bc832108b26e5',
 '0xa26111f3a1160c5e7c4998f9960eb829c4edb67041a91a4e8041bf568717507c',
 '0x75dfa94a8db019468fe9d02316add47974e9fc56d47e077297f93c4041d952e1',
];
const i=new Interface([
 'function metacall((address from,address to,uint256 value,uint256 gas,uint256 maxFeePerGas,uint256 nonce,uint256 deadline,address dapp,address control,uint32 callConfig,uint32 dappGasLimit,uint32 solverGasLimit,uint24 bundlerSurchargeRate,address sessionKey,bytes data,bytes signature) userOp,(address from,address to,uint256 value,uint256 gas,uint256 maxFeePerGas,uint256 deadline,address solver,address control,bytes32 userOpHash,address bidToken,uint256 bidAmount,bytes data,bytes signature)[] solverOps,(address from,address to,uint256 nonce,uint256 deadline,address control,address bundler,bytes32 userOpHash,bytes32 callChainHash,bytes signature) dAppOp,address gasRefundBeneficiary) returns(bool auctionWon)',
 'event SolverTxResult(address indexed solverTo,address indexed solverFrom,address indexed dAppControl,address bidToken,uint256 bidAmount,bool executed,bool success,uint256 result)',
 'event MetacallResult(address indexed bundler,address indexed user,bool solverSuccessful,uint256 ethPaidToBundler,uint256 netGasSurcharge)',
]);
console.log('Atlas selector derived from V1.6.4 ABI:',i.getFunction('metacall').selector);
const urls=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.g.alchemy.com/v2/docs-demo'];
let n=0;
async function rpc(method,params){
 let errors=[];
 for(const url of urls){
  const ac=new AbortController();const clock=setTimeout(()=>ac.abort(),12000);
  try{
   let r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},signal:ac.signal,
    body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})});
   if(!r.ok)throw Error('HTTP '+r.status);
   let j=await r.json();
   if(j.error||j.result==null)throw Error(j.error?.message||'null result');
   return j.result;
  }catch(e){errors.push(url+':'+e.message)}finally{clearTimeout(clock)}
 }
 throw Error(method+' unavailable '+JSON.stringify(errors).slice(0,500))
}
const N=x=>x===undefined||x===null?null:BigInt(x);
const out=[];
(async()=>{
 if(i.getFunction('metacall').selector!=='0x4317ca01')throw Error('Atlas ABI selector mismatch; do not decode!');
 for(const hash of hashes){
  const [tx,receipt]=await Promise.all([
   rpc('eth_getTransactionByHash',[hash]),rpc('eth_getTransactionReceipt',[hash])
  ]);
  let args;
  try{args=i.decodeFunctionData('metacall',tx.input)}
  catch(e){throw Error('Atlas metacall decode failed '+hash+' '+String(e.message).slice(0,220))}
  let solverOps=args.solverOps.map(s=>({
   from:s.from,solver:s.solver,control:s.control,bidToken:s.bidToken,
   bidWei:s.bidAmount.toString(),bidEther:s.bidToken==='0x0000000000000000000000000000000000000000'?formatEther(s.bidAmount):null,
   requestedGas:s.gas.toString(),solverCalldataBytes:(s.data.length-2)/2,
   solverCalldataSelector:s.data.slice(0,10),
  }));
  let events=[];
  for(const z of receipt.logs||[]){
   if(z.address.toLowerCase()!==atlas)continue;
   try{
    const parsed=i.parseLog(z);
    if(parsed?.name==='SolverTxResult')events.push({
     name:parsed.name,solverTo:parsed.args.solverTo,solverFrom:parsed.args.solverFrom,
     dAppControl:parsed.args.dAppControl,bidToken:parsed.args.bidToken,
     bidWei:parsed.args.bidAmount.toString(),bidETH:formatEther(parsed.args.bidAmount),
     executed:parsed.args.executed,success:parsed.args.success,
     result:parsed.args.result.toString()
    });
    if(parsed?.name==='MetacallResult')events.push({
     name:parsed.name,bundler:parsed.args.bundler,user:parsed.args.user,
     solverSuccessful:parsed.args.solverSuccessful,
     ethPaidToBundler:parsed.args.ethPaidToBundler.toString(),
     netGasSurcharge:parsed.args.netGasSurcharge.toString(),
    });
   }catch{}
  }
  const liqEvents=(receipt.logs||[]).filter(z=>z.topics?.[0]?.toLowerCase()==='0xf80fede8ad4940d1a9970c3c1c14d80183a4bc2d6b5c11e1602a842fa8b1c773').length;
  const gas=BigInt(receipt.gasUsed||0)*BigInt(receipt.effectiveGasPrice||0);
  const result={hash,block:Number(N(receipt.blockNumber)),from:tx.from,to:tx.to,
   userOperation:{from:args.userOp.from,dapp:args.userOp.dapp,control:args.userOp.control,
    dataBytes:(args.userOp.data.length-2)/2,calldataSelector:args.userOp.data.slice(0,10)},
   dAppOperation:{from:args.dAppOp.from,control:args.dAppOp.control,bundler:args.dAppOp.bundler},
   solverOpsCount:solverOps.length,solverOps,atlasEvents:events,
   winner:events.find(e=>e.name==='SolverTxResult'&&e.executed&&e.success)?.solverTo??null,
   gasL2ETH:formatEther(gas),gasL1ETH:receipt.l1Fee?formatEther(BigInt(receipt.l1Fee)):null,
   transactionSuccess:receipt.status==='0x1'};
  console.log('ATLAS_AUCTION',JSON.stringify(result));
  out.push(result);
 }
 const fs=require('node:fs');fs.mkdirSync('.tmp',{recursive:true});
 fs.writeFileSync('.tmp/atlasMorphoLeiloes.json',JSON.stringify(out,null,2));
})().catch(e=>{console.error('ATLAS_DECODE_ERROR',String(e.stack||e));process.exitCode=1});
