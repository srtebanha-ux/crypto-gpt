'use strict';
async function req(url,method,params){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
 try{
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});
  let t=await r.text();return{http:r.status,body:t.slice(0,380)};
 }catch(e){return{error:String(e).slice(0,170)}}finally{clearTimeout(timer)}
}
(async()=>{
 const urls=['https://base-rpc.publicnode.com','https://mainnet.base.org',
   'https://base.gateway.tenderly.co','https://base.drpc.org','https://1rpc.io/base'];
 for(const url of urls) {
  const block=await req(url,'eth_blockNumber',[]);
  const n=parseInt(JSON.parse(block.body||'{}').result||'0x0',16);
  console.log('[RPC]',url,'block',n,'health',JSON.stringify(block).slice(0,230));
  if(!n)continue;
  const filters=[
   {fromBlock:'0x'+n.toString(16),toBlock:'0x'+n.toString(16),address:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'},
   {fromBlock:'0x'+(n-100).toString(16),toBlock:'0x'+n.toString(16),address:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'},
   {fromBlock:'0x'+(n-100).toString(16),toBlock:'0x'+n.toString(16),address:['0xA238Dd80C259a72e81d7e4664a9801594F98d1c5','0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb']},
  ];
  for(let i=0;i<filters.length;i++){
    const v=await req(url,'eth_getLogs',[filters[i]]);
    console.log('[LOGS]',url,'test',i,JSON.stringify(v).slice(0,600));
  }
 }
})().catch(e=>{console.error(e);process.exitCode=1});
