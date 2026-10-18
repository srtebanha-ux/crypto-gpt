'use strict';
const URL='https://api.morpho.org/graphql';
async function gql(query,variables={}){
 const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),14000);
 try{
 const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},
 body:JSON.stringify({query,variables}),signal:ctl.signal});
 const txt=await r.text();
 console.log('HTTP',r.status,'bytes',txt.length);
 let js;try{js=JSON.parse(txt)}catch{return{err:txt.slice(0,400)}}
 if(js.errors)console.log('GRAPHQL ERRORS',JSON.stringify(js.errors).slice(0,1200));
 return js;
 }finally{clearTimeout(t)}
}
(async()=>{
 console.log('INTROSPECTION FILTERS');
 const intro=await gql('query { __type(name:"MarketTransactionFilters") { name kind inputFields {name type {name kind ofType {name kind}}} } }');
 console.log('FILTERS',JSON.stringify(intro?.data?.__type||intro).slice(0,11000));
 console.log('QUERY SAMPLE');
 const q='query { marketTransactions(first:20,orderBy:Timestamp,orderDirection:Desc, where:{type_in:[Liquidation],chainId_in:[8453]}) { items { blockNumber txHash logIndex type user { address } market { marketId } data { ... on MarketTransactionLiquidationData { seizedAssets repaidAssets badDebtAssets liquidator } } } } }';
 let r=await gql(q);console.log('SAMPLES',JSON.stringify(r.data?.marketTransactions||r).slice(0,14000));
})().catch(e=>{console.error('PROBE FAILED',String(e));process.exitCode=1});
