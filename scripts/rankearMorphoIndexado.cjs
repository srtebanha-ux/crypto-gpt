'use strict';
/**
 * Ranking Morpho Blue BASE: usa o indexador oficial Morpho e cruza amostras
 * com os recibos onchain. Nenhuma chave privada, assinatura ou envio.
 */
const fs=require('node:fs');
const URL='https://api.morpho.org/graphql';
const LIMIT=100;
const QUERY='query Leaderboard($skip:Int!,$start:Int!,$end:Int!){ marketTransactions(first:100,skip:$skip,orderBy:Timestamp,orderDirection:Desc,where:{chainId_in:[8453],type_in:[Liquidation],timestamp_gte:$start,timestamp_lte:$end}) {items{txHash logIndex timestamp blockNumber type chain{id} user{address} market{marketId} data{... on MarketTransactionLiquidationData{liquidator repaidAssets}}}}}';
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function graph(skip,start,end){
 let err;
 for(let i=0;i<4;i++){
  const ctrl=new AbortController(),tm=setTimeout(()=>ctrl.abort(),20000);
  try{
   const response=await fetch(URL,{method:'POST',signal:ctrl.signal,
    headers:{'content-type':'application/json',accept:'application/json'},
    body:JSON.stringify({query:QUERY,variables:{skip,start,end}})});
   if(!response.ok)throw Error('HTTP '+response.status);
   const data=await response.json();
   if(data.errors?.length)throw Error('GraphQL '+JSON.stringify(data.errors).slice(0,200));
   if(!Array.isArray(data.data?.marketTransactions?.items))throw Error('invalid indexer page');
   return data.data.marketTransactions.items;
  }catch(e){err=e;await sleep(500*(i+1));}finally{clearTimeout(tm)}
 }
 throw err;
}
function analyze(items){
 const unique=new Set(),map=new Map();
 let malformed=0,duplicate=0;
 for(const v of items){
  if(!v||v.chain?.id!==8453||v.type!=='Liquidation'
    ||!/^0x[0-9a-f]{64}$/i.test(v.txHash||'')
    ||!/^0x[0-9a-f]{40}$/i.test(v.data?.liquidator||'')
    ||!Number.isInteger(v.logIndex)){
   malformed++;continue;
  }
  const eid=v.txHash.toLowerCase()+':'+v.logIndex;
  if(unique.has(eid)){duplicate++;continue;}
  unique.add(eid);
  const who=v.data.liquidator.toLowerCase();
  if(!map.has(who))map.set(who,{liquidator:who,liquidations:0,tx:new Set(),borrowers:new Set(),markets:new Set(),examples:[]});
  const z=map.get(who);z.liquidations++;z.tx.add(v.txHash.toLowerCase());
  if(v.user?.address)z.borrowers.add(v.user.address.toLowerCase());
  if(v.market?.marketId)z.markets.add(v.market.marketId.toLowerCase());
  if(z.examples.length<5&&!z.examples.includes(v.txHash))z.examples.push(v.txHash);
 }
 const ranked=[...map.values()].map(x=>({
  liquidator:x.liquidator,liquidations:x.liquidations,transactions:x.tx.size,
  borrowers:x.borrowers.size,markets:x.markets.size,examples:x.examples,
  explorer:'https://basescan.org/address/'+x.liquidator,
 })).sort((a,b)=>b.liquidations-a.liquidations||b.transactions-a.transactions);
 return{ranked,validEvents:unique.size,malformed,duplicate};
}
async function main(){
 const now=Math.floor(Date.now()/1000),days=Number(process.env.MORPHO_RANK_DAYS||7);
 if(!Number.isSafeInteger(days)||days<1||days>30)throw Error('days out of range');
 const since=now-days*86400,maxPages=Number(process.env.MORPHO_RANK_MAX_PAGES||250);
 if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>400)throw Error('maxpages out of range');
 let all=[],page=0,ended=false;
 while(page<maxPages){
  const batch=await graph(page*LIMIT,since,now);
  all.push(...batch);
  page++;
  if(page%10===0)console.log('[MORPHO/RANK] pages',page,'events',all.length);
  if(batch.length<LIMIT){ended=true;break;}
  await sleep(100);
 }
 const score=analyze(all);
 const result={protocol:'Morpho Blue',chainId:8453,
  startUtc:new Date(since*1000).toISOString(),endUtc:new Date(now*1000).toISOString(),
  coverageComplete:ended,pages:page,receivedEvents:all.length,
  validEvents:score.validEvents,malformed:score.malformed,duplicates:score.duplicate,
  source:'Morpho API marketTransactions; confirmed onchain at index time. No USD pricing, no proof of net profit.',
  top:score.ranked.slice(0,35),
 };
 fs.mkdirSync('.tmp',{recursive:true});
 fs.writeFileSync('.tmp/rankingMorphoBaseIndexado.json',JSON.stringify(result,null,2));
 console.log('MORPHO_LEADERBOARD='+JSON.stringify(result));
 if(!ended||score.malformed>0||score.duplicate>0){
  console.error('INCOMPLETE INDEXER RESULT: no winner may be declared.');
  process.exitCode=1;
 }
}
if(require.main===module)main().catch(e=>{console.error('INDEXED_RANK_FAILED:',e.message);process.exitCode=1});
module.exports={analyze};
