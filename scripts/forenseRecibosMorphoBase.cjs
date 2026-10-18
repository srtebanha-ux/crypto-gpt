'use strict';
/**
 * Confirmed Morpho liquidations -> full hashes via public Morpho API ->
 * raw transaction and receipt via Base RPC. No signing, no wallet.
 */
const {id,Interface}=require('ethers');
const fs=require('node:fs');
const AP='https://api.morpho.org/graphql';
const CONTRACT='0xd12810b19b596347a3afac206d3ca65d08594b3f';
const COMPETITOR='0xb949a57ac64be7a9dbe535e14f859e4c56a0cf03';
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const SAMPLES=[
 '0x90850fe22bde38d649ca2c04f4b4050bf790c55b4b4537de059882fa0714e36e',
 '0x2c3266f04cd1e6b902005e03ce68311d92157a143eb672c7806bc832108b26e5',
 '0xe4104d7555a51534384418614f6a12af2364e152d48a2764feb86c5f9b906bfc',
];
const RT=['https://base-rpc.publicnode.com','https://mainnet.base.org',
 'https://base-mainnet.g.alchemy.com/v2/docs-demo',
 'https://base.drpc.org'];
let rpcCount=0;
async function req(url,init={}){
 const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(),12000);
 try{return await fetch(url,{...init,signal:ctl.signal})}finally{clearTimeout(timeout)}
}
async function graphql(query,variables={}){
 const x=await req(AP,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({query,variables})});
 if(!x.ok)throw Error('Morpho API HTTP '+x.status);
 const data=await x.json();
 if(data.errors?.length)throw Error('Morpho GraphQL '+JSON.stringify(data.errors).slice(0,300));
 return data.data;
}
async function rpc(method,params){
 let errors=[];
 for(const url of RT){
  try{
   const r=await req(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:++rpcCount,method,params})});
   if(!r.ok)throw Error('HTTP '+r.status);
   const z=await r.json();
   if(z.error)throw Error('RPC '+String(z.error.message).slice(0,140));
   if(z.result===undefined||z.result===null)throw Error('null result');
   return{value:z.result,provider:new URL(url).hostname};
  }catch(e){errors.push(new URL(url).hostname+':'+String(e.message).slice(0,100))}
 }
 return{value:null,errors};
}
const hex=n=>n===undefined||n===null?null:BigInt(n);
const tTransfer=id('Transfer(address,address,uint256)').toLowerCase();
const tSwapV2=id('Swap(address,uint256,uint256,uint256,uint256,address)').toLowerCase();
const tSwapV3=id('Swap(address,address,int256,int256,uint160,uint128,int24)').toLowerCase();
const tLiq=id('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)').toLowerCase();
const iTransfer=new Interface(['event Transfer(address indexed from,address indexed to,uint256 amount)']);
const iLiq=new Interface(['event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)']);
async function recent(limit=100){
 const query='query($address:String!,$first:Int!){marketTransactions(first:$first,orderBy:Timestamp,orderDirection:Desc,where:{chainId_in:[8453],type_in:[Liquidation],liquidatorAddress_in:[$address]}){items{blockNumber txHash logIndex user{address} market{marketId} data{... on MarketTransactionLiquidationData{liquidator repaidAssets seizedAssets badDebtAssets}}}}}';
 const r=await graphql(query,{address:CONTRACT,first:limit});
 return r?.marketTransactions?.items??[];
}
function parseReceipt(hash,tx,rec,apiEvents){
 const receipts=[];
 let swaps=[], transfers=[], liquidations=[],venues=new Map();
 for(const z of rec.logs||[]){
  const topic=String(z.topics?.[0]||'').toLowerCase();
  if(topic===tLiq&&z.address.toLowerCase()===MORPHO.toLowerCase()){
   try{
    const p=iLiq.parseLog(z);
    if(p.args.caller.toLowerCase()===CONTRACT)liquidations.push({
      borrower:p.args.borrower,marketId:p.args.id, repaidAssets:p.args.repaidAssets.toString(),
      seizedAssets:p.args.seizedAssets.toString(),badDebt:p.args.badDebtAssets.toString(),
    });
   }catch{}
  }
  if(topic===tSwapV2||topic===tSwapV3){
    const pool=z.address.toLowerCase(),style=topic===tSwapV2?'UniswapV2-family':'UniswapV3-family';
    swaps.push({pool,style});venues.set(pool,style);
  }
  if(topic===tTransfer){
    try{
      const x=iTransfer.parseLog(z),from=x.args.from.toLowerCase(),to=x.args.to.toLowerCase();
      if([CONTRACT,tx.from?.toLowerCase(),tx.to?.toLowerCase(),MORPHO.toLowerCase()].includes(from)
       ||[CONTRACT,tx.from?.toLowerCase(),tx.to?.toLowerCase(),MORPHO.toLowerCase()].includes(to))
       transfers.push({token:z.address,from,to,rawAmount:x.args.amount.toString()});
    }catch{}
  }
 }
 const price=hex(rec.effectiveGasPrice)||0n,used=hex(rec.gasUsed)||0n;
 const gasL2=price*used;const gasL1=hex(rec.l1Fee);
 const byToken=new Map();
 for(const x of transfers){
   const key=x.token.toLowerCase(),row=byToken.get(key)||{token:key,in:'0',out:'0'};
   if(x.to===CONTRACT)row.in=(BigInt(row.in)+BigInt(x.rawAmount)).toString();
   if(x.from===CONTRACT)row.out=(BigInt(row.out)+BigInt(x.rawAmount)).toString();
   byToken.set(key,row);
 }
 return{hash,receiptSuccess:rec.status==='0x1',block:Number(hex(rec.blockNumber)),
  txFrom:tx.from,txTo:tx.to,nonce:Number(hex(tx.nonce)),txSelector:tx.input?.slice(0,10),
  calldataBytes:((tx.input?.length||2)-2)/2,
  effectiveGasPriceWei:price.toString(),gasUsed:used.toString(),gasL2Wei:gasL2.toString(),
  gasL1Wei:gasL1?.toString()??null,
  transactionFeesKnownWei:gasL1!==null?(gasL1+gasL2).toString():null,
  liquidationCount:liquidations.length,
  borrowerCount:new Set(liquidations.map(x=>x.borrower.toLowerCase())).size,
  liquidations,swapCount:swaps.length,venues:[...venues].map(([pool,style])=>({pool,style})).slice(0,30),
  relevantTransfers:transfers.length,tokenFlows:[...byToken.values()],
  indexerCount:apiEvents.length,
  warning:'Saldos do contrato, callbacks e PnL liquido necessitam traces ou saldo pre/post; transfer events podem ser incompletos.',
 };
}
(async()=>{
 const r=await recent(100);
 const groups=new Map();
 for(const t of r){let a=groups.get(t.txHash)||[];a.push(t);groups.set(t.txHash,a)}
 console.log('MORPHO INDEX',JSON.stringify({returnedEvents:r.length,distinctTx:groups.size,
  recentExamples:[...groups].slice(0,10).map(([hash,entries])=>({
    hash,block:entries[0].blockNumber,count:entries.length,
    marketIds:[...new Set(entries.map(x=>x.market?.marketId))]}))}));
 const txSamples=[...new Set([...SAMPLES.filter(x=>groups.has(x)),...[...groups.keys()].slice(0,6)])].slice(0,7);
 const results=[];
 for(const hash of txSamples){
  const [t,g]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),
   rpc('eth_getTransactionReceipt',[hash])]);
  if(!t.value||!g.value){const err={hash,errors:{tx:t.errors,receipt:g.errors}};
   results.push(err);console.log('RECEIPT_UNAVAILABLE',JSON.stringify(err));continue;}
  const decoded=parseReceipt(hash,t.value,g.value,groups.get(hash)||[]);
  decoded.providers={tx:t.provider,receipt:g.provider};
  results.push(decoded);
  console.log('CONFIRMED_TX',JSON.stringify(decoded));
 }
 let out={contract:CONTRACT,indexedAt:new Date().toISOString(),indexedEvents:r.length,
   indexedUniqueTransactions:groups.size,results,
   complete:results.some(x=>x.receiptSuccess&&x.liquidationCount>0)};
 fs.mkdirSync('.tmp',{recursive:true});
 fs.writeFileSync('.tmp/forenseMorphoVencedor.json',JSON.stringify(out,null,2));
 if(!out.complete)process.exitCode=2;
})().catch(e=>{console.error('FORENSIC_ERROR',e.stack||e);process.exitCode=1});
