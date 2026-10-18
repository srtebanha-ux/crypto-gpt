'use strict';
/**
 * Multi-network Morpho liquidation sampling: official indexer.
 * Recent 100 indexed events per network; NOT a full historical leaderboard.
 * No keys, no wallet, no signing, no on-chain sends.
 */
const fs=require('node:fs');
const URL='https://api.morpho.org/graphql';
const chains=[
 {id:8453,name:'Base',atlas:true},
 {id:42161,name:'Arbitrum',atlas:true},
 {id:10,name:'OP Mainnet',atlas:false},
 {id:137,name:'Polygon',atlas:false},
 {id:130,name:'Unichain',atlas:false},
 {id:1,name:'Ethereum',atlas:false},
];
const query='query($ids:[Int!],$first:Int!){marketTransactions(first:$first,orderBy:Timestamp,orderDirection:Desc,where:{chainId_in:$ids,type_in:[Liquidation]}){items{txHash blockNumber logIndex user{address} market{marketId} data{... on MarketTransactionLiquidationData{liquidator repaidAssets seizedAssets badDebtAssets}}}}}';
async function graphql(chain){
 const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(),18000);
 try{
  const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({query,variables:{ids:[chain.id],first:100}}),signal:ctl.signal});
  if(!r.ok)throw Error('HTTP '+r.status);
  const b=await r.json();
  if(b.errors?.length)throw Error(JSON.stringify(b.errors).slice(0,350));
  const xs=b.data?.marketTransactions?.items;
  if(!Array.isArray(xs))throw Error('Invalid indexer response');
  return xs;
 }finally{clearTimeout(timeout)}
}
function sample(chain,items){
 const byL=new Map(),tx=new Set(),markets=new Set();
 let invalid=0;
 for(const x of items){
  const who=x.data?.liquidator;
  if(typeof who!=='string'||!/^0x[a-fA-F0-9]{40}$/.test(who)||
     !/^0x[a-fA-F0-9]{64}$/.test(x.txHash??'')){invalid++;continue}
  const address=who.toLowerCase(),rec=byL.get(address)||{
    liquidator:address,events:0,uniqueTx:new Set(),examples:[]};
  rec.events++;rec.uniqueTx.add(x.txHash.toLowerCase());
  if(rec.examples.length<2)rec.examples.push(x.txHash);
  byL.set(address,rec);tx.add(x.txHash.toLowerCase());
  if(typeof x.market?.marketId==='string')markets.add(x.market.marketId);
 }
 return{
  network:chain.name,chainId:chain.id,atlasSupported:chain.atlas,
  indexedEvents:items.length,invalidRows:invalid,
  uniqueTransactions:tx.size,uniqueMarkets:markets.size,
  leaders:[...byL.values()].map(x=>({
    liquidator:x.liquidator,events:x.events,uniqueTx:x.uniqueTx.size,txSamples:x.examples
  })).sort((a,b)=>b.events-a.events).slice(0,8),
  scope:'100 most recent indexed liquidation events, NOT a seven-day/full-network ranking',
 };
}
(async()=>{
 const results=[];
 for(const chain of chains){
  try{
   const s=sample(chain,await graphql(chain));results.push(s);
   console.log('NETWORK_SAMPLE',JSON.stringify({network:chain.name,events:s.indexedEvents,
    transactions:s.uniqueTransactions,leaders:s.leaders.slice(0,2)}));
  }catch(err){
   const x={network:chain.name,chainId:chain.id,
    error:String(err.message||err).slice(0,250),coverage:'UNKNOWN, not zero'};
   results.push(x);console.log('NETWORK_UNAVAILABLE',JSON.stringify(x));
  }
 }
 fs.mkdirSync('.tmp',{recursive:true});
 fs.writeFileSync('.tmp/titan-multirede-morpho.json',JSON.stringify({
  observedAt:new Date().toISOString(),results,
  note:'Samples, not profitability, proven best chain or full coverage.'
 },null,2));
 if(results.every(x=>x.error))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
