'use strict';
/** Public, read-only reverse engineering of confirmed Base Morpho liquidation transactions. */
const {id,Interface}=require('ethers');
const fs=require('node:fs'),path=require('node:path');
const RPCS=['https://base.gateway.tenderly.co','https://base.drpc.org'];
let counter=0;
async function rpc(method,params){
 let error;
 for(const url of RPCS){
  try{
   const ac=new AbortController(),timeout=setTimeout(()=>ac.abort(),12000);
   let res;try{res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},signal:ac.signal,
     body:JSON.stringify({jsonrpc:'2.0',id:++counter,method,params})})}finally{clearTimeout(timeout)}
   if(!res.ok)throw Error('HTTP '+res.status);
   const x=await res.json();if(x.error)throw Error(JSON.stringify(x.error));
   return x.result;
  }catch(e){error=e}
 }
 throw error;
}
const SOLVER='0x583dcfef0d240dc80753f0f0b26513fee27d9b77';
const TOP=id('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)');
const iface=new Interface(['event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)']);
const events={
  swapV2:id('Swap(address,uint256,uint256,uint256,uint256,address)').toLowerCase(),
  swapV3:id('Swap(address,address,int256,int256,uint160,uint128,int24)').toLowerCase(),
  transfer:id('Transfer(address,address,uint256)').toLowerCase(),
};
const txs=[
 '0x22982ae30e036921c78ace99a2034f939e4c20f4a549ec1bb1a19c0e8f12459a',
 '0xc0a51904f3bd704512b5c502e3812e7568cbbe6191c8110b4aa110899c26c1f9',
 '0x350f36f5d4a812ba0bc45bb940848d87fba1a154cc96abdaaaafef9f7ead3cac',
];
const countBy=arr=>[...arr.reduce((m,x)=>(m.set(x,(m.get(x)||0)+1),m),new Map()).entries()].sort((a,b)=>b[1]-a[1]).slice(0,15);
async function inspect(hash){
 const [tx,rec]=await Promise.all([
  rpc('eth_getTransactionByHash',[hash]),
  rpc('eth_getTransactionReceipt',[hash]),
 ]);
 if(!tx||!rec)throw Error('missing chain data for '+hash);
 const log=rec.logs||[];
 const morpho=log.filter(x=>x.address?.toLowerCase()==='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
   &&x.topics?.[0]?.toLowerCase()===TOP.toLowerCase());
 const groups=new Map(),markets=new Set(),borrowers=new Set();
 for(const ev of morpho) {
  let parsed=iface.parseLog(ev);const who=parsed.args.caller.toLowerCase();
  groups.set(who,(groups.get(who)||0)+1);
  markets.add(String(parsed.args.id).toLowerCase());
  borrowers.add(parsed.args.borrower.toLowerCase());
 }
 const swaps=log.filter(x=>Object.values(events).slice(0,2).includes(x.topics?.[0]?.toLowerCase()));
 const tokenTransfers=log.filter(x=>x.topics?.[0]?.toLowerCase()===events.transfer);
 const val={
  hash,blockNumber:parseInt(rec.blockNumber,16),status:parseInt(rec.status||'0x0',16),
  from:tx.from,to:tx.to,recipientIsSharedExecutor:tx.to?.toLowerCase()===SOLVER,
  inputSelector:tx.input?.slice(0,10),inputBytes:(tx.input?.length-2)/2,
  nonce:parseInt(tx.nonce,16),txValueWei:BigInt(tx.value||'0x0').toString(),
  gasUsed:Number(BigInt(rec.gasUsed||'0x0')),effectiveGasPriceWei:BigInt(rec.effectiveGasPrice||'0x0').toString(),
  l2GasFeeWei:(BigInt(rec.gasUsed||'0x0')*BigInt(rec.effectiveGasPrice||'0x0')).toString(),
  morphoEvents:morpho.length,borrowers:borrowers.size,markets:markets.size,
  liquidators:[...groups.entries()].map(([address,events])=>({address,events})),
  totalLogs:log.length,swapEvents:swaps.length,transferEvents:tokenTransfers.length,
  swapPools:countBy(swaps.map(x=>x.address.toLowerCase())),
  eventEmitters:countBy(log.map(x=>x.address.toLowerCase())),
  links:{tx:'https://basescan.org/tx/'+hash,executor:tx.to?'https://basescan.org/address/'+tx.to:null}
 };
 return val;
}
(async()=>{
 const results=[];
 for(const hash of txs) {
  try{results.push(await inspect(hash))}
  catch(e){results.push({hash,error:String(e.message).slice(0,300)})}
 }
 fs.mkdirSync('.tmp',{recursive:true});
 fs.writeFileSync('.tmp/liderMorphoBase.json',JSON.stringify(results,null,2));
 console.log('=== OPERADOR COMPETITIVO CONFIRMADO NA BASE ===');
 console.log(JSON.stringify(results,null,2));
 if(results.some(x=>x.error))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
