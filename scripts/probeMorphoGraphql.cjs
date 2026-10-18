'use strict';
const url='https://api.morpho.org/graphql';
async function post(query){
 const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),18000);
 try{
  const res=await fetch(url,{method:'POST',signal:ctrl.signal,
   headers:{'content-type':'application/json',accept:'application/json'},
   body:JSON.stringify({query})});
  return {status:res.status,body:(await res.text()).slice(0,11000)};
 }finally{clearTimeout(t)}
}
(async()=>{
 const q1='query { tx:__type(name:"MarketTransaction"){name fields{name type{name kind ofType{name}}}} filters:__type(name:"MarketTransactionFilters"){name inputFields{name type{name kind ofType{name}}}} }';
 const intro=await post(q1);console.log('API_INTROSPECTION='+JSON.stringify(intro));
 const q2='query { marketTransactions(first:3,orderBy:Timestamp,orderDirection:Desc,where:{chainId_in:[8453],type_in:[Liquidation]}) { items{timestamp txHash logIndex blockNumber type data{... on MarketTransactionLiquidationData{liquidator repaidAssets}}} } }';
 const sample=await post(q2);console.log('API_SAMPLE='+JSON.stringify(sample));
})().catch(e=>{console.error('API_FAILED:',e.message);process.exitCode=1});
