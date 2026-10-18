'use strict';
/** Base Morpho liquidation forensic: public blockchain reads, no wallet or signing. */
const {Interface,id}=require('ethers');
const rpcUrls=(process.env.FORENSIC_RPCS||'https://base-rpc.publicnode.com,https://mainnet.base.org').split(',');
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const HUNTER='0xd12810b19b596347a3afac206d3ca65d08594b3f';
const targets=[
 ['2026-01-31T18:17:15Z','0x76ac3dfc9185'],
 ['2026-02-03T18:45:45Z','0x50ad3cf5d403'],
 ['2026-02-05T20:49:27Z','0x0541fa6d21c8'],
];
const liq=new Interface(['event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)']);
const transfer=new Interface(['event Transfer(address indexed from,address indexed to,uint256 amount)']);
const morpho=new Interface(['function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)']);
const erc20=new Interface(['function symbol() view returns (string)','function decimals() view returns (uint8)']);
const topicLiq=id('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)');
const topicV2=id('Swap(address,uint256,uint256,uint256,uint256,address)').toLowerCase();
const topicV3=id('Swap(address,address,int256,int256,uint160,uint128,int24)').toLowerCase();
const topicTransfer=id('Transfer(address,address,uint256)').toLowerCase();
const hex=x=>'0x'+BigInt(x).toString(16);
let serial=0;const cache=new Map();let failures=0;
async function rpc(method,params=[],tries=1){
 let err;
 for(let attempt=0;attempt<tries;attempt++){
  for(let k=0;k<rpcUrls.length;k++){
   const url=rpcUrls[(k+attempt)%rpcUrls.length].trim();
   try{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),14000);
    let r;try{
      r=await fetch(url,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:++serial,method,params})});
    }finally{clearTimeout(timer)}
    if(!r.ok)throw Error('HTTP '+r.status);
    let b=await r.json();if(b.error)throw Error(JSON.stringify(b.error).slice(0,170));
    if(b.result===undefined)throw Error('empty result');
    return b.result;
   }catch(e){err=e}
  }
 }
 failures++;
 throw Error(method+': '+String(err?.message||err));
}
async function block(n){
 if(cache.has(n))return cache.get(n);
 const b=await rpc('eth_getBlockByNumber',[hex(n),false],2);
 if(!b?.timestamp)throw Error('missing block '+n);
 const o={n,t:Number(BigInt(b.timestamp))};
 cache.set(n,o);return o;
}
async function findBlock(timestamp){
 let top=Number(BigInt(await rpc('eth_blockNumber',[],2)));
 let lo=1,hi=top;
 for(let i=0;i<27&&lo+1<hi;i++){
  const mid=Math.floor((lo+hi)/2);const x=await block(mid);
  if(x.t<timestamp)lo=mid;else hi=mid;
 }
 return hi;
}
async function findEvent(rangeFrom,rangeTo){
 const topicCaller='0x'+HUNTER.toLowerCase().slice(2).padStart(64,'0');
 const params={address:MORPHO,topics:[topicLiq,null,topicCaller],
   fromBlock:hex(rangeFrom),toBlock:hex(rangeTo)};
 try{return await rpc('eth_getLogs',[params],2)}
 catch(e){ console.log('eth_getLogs failed on '+rangeFrom+'-'+rangeTo+': '+e.message);
  const m=Math.floor((rangeFrom+rangeTo)/2);
  if(m<=rangeFrom) return[];
  const a=await findEvent(rangeFrom,m),b=await findEvent(m+1,rangeTo);
  return a.concat(b);
 }
}
async function tokenMetadata(token){
 try{
  const a=await rpc('eth_call',[{to:token,data:erc20.encodeFunctionData('symbol')},'latest']);
  const b=await rpc('eth_call',[{to:token,data:erc20.encodeFunctionData('decimals')},'latest']);
  return{symbol:erc20.decodeFunctionResult('symbol',a)[0],decimals:Number(erc20.decodeFunctionResult('decimals',b)[0])}
 }catch{return{symbol:'unknown',decimals:null}}
}
async function analyze(txHash){
 const [tx,r]=await Promise.all([
   rpc('eth_getTransactionByHash',[txHash],2),
   rpc('eth_getTransactionReceipt',[txHash],2),
 ]);
 if(!r||!tx)return{hash:txHash,error:'Missing tx/receipt'};
 const swaps=[],transfers=[],morphoEvents=[];
 let ids=new Set();
 for(const l of r.logs||[]){
  const topic=l.topics?.[0]?.toLowerCase()||'';
  if(topic===topicLiq.toLowerCase()&&l.address.toLowerCase()===MORPHO.toLowerCase()){
   try{
    const parsed=liq.parseLog(l);ids.add(parsed.args.id.toLowerCase());
    morphoEvents.push({market:parsed.args.id,liquidator:parsed.args.caller,borrower:parsed.args.borrower,
     repaidAssets:parsed.args.repaidAssets.toString(),repaidShares:parsed.args.repaidShares.toString(),
     seizedAssets:parsed.args.seizedAssets.toString(),badDebtAssets:parsed.args.badDebtAssets.toString()});
   }catch{}
  }
  if(topic===topicV2||topic===topicV3)swaps.push({venue:l.address,style:topic===topicV2?'v2':'v3'});
  if(topic===topicTransfer){
   try{let z=transfer.parseLog(l);if([HUNTER.toLowerCase(),MORPHO.toLowerCase()].includes(z.args.from.toLowerCase())
       ||[HUNTER.toLowerCase(),MORPHO.toLowerCase()].includes(z.args.to.toLowerCase()))
     transfers.push({token:l.address,from:z.args.from,to:z.args.to,rawAmount:z.args.amount.toString()})
   }catch{}
  }
 }
 let markets=[];
 for(let market of ids){
  try{
   let data=await rpc('eth_call',[{to:MORPHO,data:morpho.encodeFunctionData('idToMarketParams',[market])},'latest']);
   let m=morpho.decodeFunctionResult('idToMarketParams',data);
   let tokens=await Promise.all([tokenMetadata(m[0]),tokenMetadata(m[1])]);
   markets.push({id:market,loan:m[0],loanSymbol:tokens[0].symbol,loanDecimals:tokens[0].decimals,
     collateral:m[1],collateralSymbol:tokens[1].symbol,collateralDecimals:tokens[1].decimals,lltv:m[4].toString()});
  }catch(e){markets.push({id:market,error:String(e.message).slice(0,150)})}
 }
 const gasUsed=BigInt(r.gasUsed||'0'),price=BigInt(r.effectiveGasPrice||'0');
 return{hash:txHash,blockNumber:Number(BigInt(r.blockNumber)),from:tx.from,to:tx.to,
   inputSelector:tx.input?.slice(0,10),status:r.status,gasUsed:gasUsed.toString(),
   l2FeeWei:(gasUsed*price).toString(),l1FeeWei:r.l1Fee?BigInt(r.l1Fee).toString():null,
   morphoEvents,markets,swaps:swaps.slice(0,30),swapCount:swaps.length,
   transfers:transfers.slice(0,45),transferCount:transfers.length,
   callbackFlow:'Internal call sequence requires transaction trace, not inferred from log alone'};
}
async function main(){
 console.log('READ-ONLY forensic Base. Looking for sample liquidations with exact UTC timestamps and tx prefixes.');
 const report=[];
 for(const [iso,prefix] of targets){
  const wanted=Math.floor(Date.parse(iso)/1000);
  console.log('FIND BLOCK',iso);
  try{
   const b=await findBlock(wanted);
   let logs=await findEvent(Math.max(1,b-40),b+40);
   const txs=[...new Set(logs.map(x=>x.transactionHash))];
   console.log('MATCH',iso,'block',b,'logs',logs.length,'unique-tx',txs.length,'prefix',prefix);
   let tx=txs.find(z=>z.toLowerCase().startsWith(prefix.toLowerCase()));
   if(!tx){report.push({timestamp:iso,block:b,foundEvents:logs.length,
      exampleHashes:txs.slice(0,8),warning:'No matching expected prefix'});continue}
   const result=await analyze(tx);
   report.push({timestamp:iso,...result});
   console.log('TRACE-DATA',JSON.stringify({date:iso, ...result}));
  }catch(e){report.push({timestamp:iso,error:String(e.message)});console.log('FAILED',iso,String(e.message).slice(0,250))}
 }
 console.log('FINAL-FORENSIC',JSON.stringify({entries:report,failedRpcCalls:failures,complete:report.length===targets.length},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
