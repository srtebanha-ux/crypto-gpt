'use strict';
/**
 * Auditoria PUBLICA e SOMENTE LEITURA de liquidadores da Base.
 * Contagens são por evento LiquidationCall (Aave) e Liquidate (Morpho),
 * não por endereço da transação; os endereços 'from' e 'to' são enriquecidos
 * somente depois do ranking. NUNCA assina, envia ou acessa chaves.
 */
const {id,Interface}=require('ethers');
const fs=require('node:fs');
const path=require('node:path');
const AAVE='0xA238Dd80C259a72e81d7e4664a9801594F98d1c5';
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const AAVE_ABI=new Interface([
  'event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)'
]);
const MORPHO_ABI=new Interface([
  'event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)'
]);
const AAVE_TOPIC=id('LiquidationCall(address,address,address,uint256,uint256,address,bool)');
const MORPHO_TOPIC=id('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)');
const RPCS=(process.env.RANK_RPC_URLS||'https://base.gateway.tenderly.co,https://base.drpc.org')
 .split(',').map(x=>x.trim()).filter(x=>/^https:\/\//.test(x));
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
let callCount=0;
async function rpc(method,params=[],retries=3){
 let last;
 for(let a=0;a<retries;a++){
  for(let k=0;k<RPCS.length;k++){
   const url=RPCS[(a+k)%RPCS.length];
   try{
    callCount++;
    const ac=new AbortController();
    const t=setTimeout(()=>ac.abort(),18000);
    let res;
    try{
     res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
       body:JSON.stringify({jsonrpc:'2.0',id:callCount,method,params}),signal:ac.signal});
    }finally{clearTimeout(t)}
    if(!res.ok)throw Error('HTTP '+res.status);
    const v=await res.json();
    if(v.error)throw Error(String(v.error.message||'rpc error').slice(0,150));
    if(v.result===undefined)throw Error('RPC without result');
    return v.result;
   }catch(err){last=err;}
  }
  await wait(Math.min(2500,300*(a+1)**2));
 }
 throw new Error(method+': '+String(last?.message||last));
}
const hex=n=>'0x'+BigInt(n).toString(16);
const addr=x=>String(x||'').toLowerCase();
function analyzeLogs(logs){
 const grouped=new Map(),recent=new Map();
 let accepted=0,errors=0;
 const seen=new Set();
 for(const row of logs){
  if(!row?.transactionHash||!row?.topics?.length)continue;
  const protocol=addr(row.address)===addr(AAVE)?'Aave':addr(row.address)===addr(MORPHO)?'Morpho':null;
  if(!protocol)continue;
  try {
   const decoded=protocol==='Aave'?AAVE_ABI.parseLog(row):MORPHO_ABI.parseLog(row);
   if(!decoded)continue;
   const liquidator=addr(protocol==='Aave'?decoded.args.liquidator:decoded.args.caller);
   const eventId=protocol+':'+row.transactionHash.toLowerCase()+':'+String(row.logIndex??row.index);
   if(seen.has(eventId))continue;
   seen.add(eventId);
   if(!/^0x[a-f0-9]{40}$/.test(liquidator))throw Error('invalid liquidator');
   const key=protocol+':'+liquidator;
   let r=grouped.get(key);
   if(!r){r={protocol,liquidator,events:0,uniqueTx:new Set(),txSamples:[],
     borrowers:new Set(),markets:new Set(),blocks:new Set()};grouped.set(key,r);}
   r.events++;
   r.uniqueTx.add(row.transactionHash.toLowerCase());
   r.blocks.add(parseInt(row.blockNumber,16));
   r.borrowers.add(addr(protocol==='Aave'?decoded.args.user:decoded.args.borrower));
   if(protocol==='Morpho')r.markets.add(decoded.args.id.toLowerCase());
   if(r.txSamples.length<5)r.txSamples.push(row.transactionHash);
   accepted++;
  }catch(_e){errors++;}
 }
 return{
  events:accepted,decodeErrors:errors,
  ranked:[...grouped.values()].map(x=>({
   protocol:x.protocol,liquidator:x.liquidator,events:x.events,
   uniqueTx:x.uniqueTx.size,uniqueBorrowers:x.borrowers.size,
   uniqueMarkets:x.markets.size,blocks:x.blocks.size,examples:x.txSamples,
  })).sort((a,b)=>b.events-a.events||b.uniqueTx-a.uniqueTx),
 };
}
async function findBlockAt(targetTime,top){
 let lo=1,hi=top;
 while(lo+1<hi){
  const middle=Math.floor((lo+hi)/2);
  const block=await rpc('eth_getBlockByNumber',[hex(middle),false]);
  if(!block?.timestamp)throw Error('block timestamp unavailable');
  if(Number(BigInt(block.timestamp))<targetTime)lo=middle;else hi=middle;
 }
 return hi;
}
async function logsRange(from,to,depth=0){
 try{
  return await rpc('eth_getLogs',[{
    fromBlock:hex(from),toBlock:hex(to),
    address:[AAVE,MORPHO],
    topics:[[AAVE_TOPIC,MORPHO_TOPIC]],
  }],2);
 }catch(err){
  if(from>=to||depth>=5)throw err;
  const m=Math.floor((from+to)/2);
  const left=await logsRange(from,m,depth+1);
  const right=await logsRange(m+1,to,depth+1);
  return left.concat(right);
 }
}
async function profile(r){
 const example=r.examples?.[0];
 const out={...r,explorer:'https://basescan.org/address/'+r.liquidator,
  sampleLink:example?'https://basescan.org/tx/'+example:null};
 try{
  const code=await rpc('eth_getCode',[r.liquidator,'latest'],2);
  out.type=code==='0x'?'EOA':'contract';
  out.codeBytes=Math.max(0,(code.length-2)/2);
 }catch(e){out.type='unknown';out.codeError=String(e.message).slice(0,130);}
 if(example){
  try{
   const tx=await rpc('eth_getTransactionByHash',[example],2);
   out.sampleSender=tx?.from??null;
   out.sampleExecutor=tx?.to??null;
   if(tx?.to){
    const x=await rpc('eth_getCode',[tx.to,'latest'],2);
    out.executorType=x==='0x'?'EOA':'contract';
    out.executorCodeBytes=(x.length-2)/2;
    out.executorExplorer='https://basescan.org/address/'+tx.to;
   }
   const rec=await rpc('eth_getTransactionReceipt',[example],2);
   if(rec){out.sampleGasUsed=Number(BigInt(rec.gasUsed??'0x0'));
    out.sampleEffectiveGasPriceWei=(BigInt(rec.effectiveGasPrice??'0x0')).toString();}
  }catch(e){out.sampleError=String(e.message).slice(0,140)}
 }
 if(out.type==='contract'){
  try{
   const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
   const impl=await rpc('eth_getStorageAt',[r.liquidator,slot,'latest'],2);
   if(/^0x0{24}[1-9a-fA-F][0-9a-fA-F]{39}$/i.test(impl))out.proxyImplementation='0x'+impl.slice(-40);
  }catch(_e){}
 }
 return out;
}
async function main(){
 if(process.env.RANK_MOCK==='1'){console.log(JSON.stringify(analyzeLogs([])));return;}
 if(!RPCS.length)throw Error('No public RPC endpoints');
 const days=Number(process.env.RANK_DAYS||'7');
 if(!Number.isInteger(days)||days<1||days>30)throw Error('RANK_DAYS must be 1..30');
 const top=Number(BigInt(await rpc('eth_blockNumber')));
 const topHeader=await rpc('eth_getBlockByNumber',[hex(top),false]);
 const endTime=Number(BigInt(topHeader.timestamp));
 const start=await findBlockAt(endTime-days*86400,top);
 const total=top-start+1;
 const chunk=Number(process.env.RANK_CHUNK||'800');
 if(!Number.isInteger(chunk)||chunk<100||chunk>5000)throw Error('RANK_CHUNK 100..5000');
 const maxChunks=Math.ceil(total/chunk);
 if(RPCS.length===0)throw Error('No archive RPCs; use Tenderly or dRPC');
 console.log('[RANK] Base 8453 | start='+start+' top='+top+' days='+days+
  ' windows='+maxChunks+' | Aave '+AAVE+' Morpho '+MORPHO);
 let all=[],windows=0,missed=[];
 for(let from=start;from<=top;from+=chunk){
  const to=Math.min(top,from+chunk-1);
  try{
   const result=await logsRange(from,to);
   windows++;
   all.push(...result);
  }catch(e){missed.push({from,to,error:String(e.message||e).slice(0,170)});}
  if((windows+missed.length)%20===0)console.log('[RANK] progress',
   windows+missed.length,'/',maxChunks,'liquidation-logs',all.length,'errors',missed.length);
 }
 const analysis=analyzeLogs(all);
 const topRows=analysis.ranked.slice(0,12);
 const leaders=await Promise.all(topRows.slice(0,6).map(x=>profile(x)));
 const report={
  chainId:8453,lookbackDays:days,
  fromBlock:start,toBlock:top,fromTime:new Date((endTime-days*86400)*1000).toISOString(),
  toTime:new Date(endTime*1000).toISOString(),
  complete:missed.length===0,windowsOk:windows,windowsTotal:maxChunks,
  missed,events:analysis.events,decodeErrors:analysis.decodeErrors,
  note:'Ranking by successful emitted liquidation events, NOT by verified USD profit or volume.',
  top:analysis.ranked.slice(0,30).map(x=>leaders.find(y=>y.liquidator===x.liquidator&&y.protocol===x.protocol)||x)
 };
 fs.mkdirSync(path.join(process.cwd(),'.tmp'),{recursive:true});
 fs.writeFileSync('.tmp/rankingLiquidadoresBase.json',JSON.stringify(report,null,2));
 console.log('=== LIQUIDADORES BASE: CONTAGEM DE EVENTOS ===');
 console.log(JSON.stringify({fromBlock:start,toBlock:top,days,events:analysis.events,
  complete:report.complete,coverage:windows+'/'+maxChunks,
  top:report.top.slice(0,12)},null,2));
 if(!report.complete)throw Error('INCOMPLETE COVERAGE: '+missed.length+' windows failed. Do NOT declare a network leader.');
}
if(require.main===module)main().catch(e=>{console.error('RANK_FAILED:',e.message);process.exitCode=1});
module.exports={analyzeLogs, AAVE, MORPHO,AAVE_TOPIC,MORPHO_TOPIC};
