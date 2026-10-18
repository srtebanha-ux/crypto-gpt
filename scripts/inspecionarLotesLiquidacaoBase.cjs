'use strict';
/**
 * Engenharia reversa 100% read-only: transacoes de lote Morpho na Base.
 * Sem private key; nao faz chamadas state-changing.
 */
const {Interface,id}=require('ethers');
const fs=require('node:fs');
const AAVE='0xA238Dd80C259a72e81d7e4664a9801594F98d1c5';
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const BASE_RPC=['https://base-rpc.publicnode.com','https://mainnet.base.org'];
const TARGETS=[
 '0x583dcfef0d240dc80753f0f0b26513fee27d9b77', // executor
 '0x8b61f5925f4515edb0b7b76c38036aaf9a818472', // 47 liquidations / 10tx on incomplete window
 '0x3ae5122d62e78dc14b98d8d30aca4faf9d1f1bba', // 32 liquidations / one tx
 '0xd12810b19b596347a3afac206d3ca65d08594b3f', // historic candidate
];
const TX=[
 '0xc0a51904f3bd704512b5c502e3812e7568cbbe6191c8110b4aa110899c26c1f9',
 '0xa5264ad734161f0846d1f00c9934f511ffd8804cc3f90e61620c327509bc45d6',
];
const morphoEvent=new Interface(['event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)']);
const morphoTopic=id('Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)').toLowerCase();
const slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const known=[
 'onMorphoLiquidate(uint256,bytes)','executeOperation(address,uint256,uint256,address,bytes)',
 'uniswapV3SwapCallback(int256,int256,bytes)','pancakeV3SwapCallback(int256,int256,bytes)',
 'upgradeToAndCall(address,bytes)','grantRole(bytes32,address)','renounceRole(bytes32,address)',
 'revokeRole(bytes32,address)','execute(address,uint256,bytes)',
 'multicall(bytes[])','aggregate((address,bytes)[])',
 'owner()','transferOwnership(address)','sweep(address,address,uint256)'
];
async function rpc(method,params){
 let last;
 for(const url of BASE_RPC){
  try{
   const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),14000);
   let res;try{res=await fetch(url,{method:'POST',signal:ctrl.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
   finally{clearTimeout(t)}
   if(!res.ok)throw Error('HTTP '+res.status);
   const json=await res.json();if(json.error)throw Error(JSON.stringify(json.error).slice(0,160));
   return json.result;
  }catch(e){last=e}
 }
 throw new Error(method+': '+String(last?.message||last));
}
function selectors(bytecode){
 const bytes=Buffer.from(String(bytecode).slice(2),'hex'),found=new Set();
 for(let i=0;i<bytes.length;i++){
  const x=bytes[i];if(x===0x63&&i+4<bytes.length)found.add('0x'+bytes.subarray(i+1,i+5).toString('hex'));
  if(x>=0x60&&x<=0x7f)i+=x-0x5f;
 }
 return{totalCandidates:found.size,known:known.filter(f=>found.has(id(f).slice(0,10))),others:[...found].slice(0,40)};
}
async function inspect(addr){
 const [code,stored]=await Promise.all([
   rpc('eth_getCode',[addr,'latest']),rpc('eth_getStorageAt',[addr,slot,'latest'])
 ]);
 const impl=/^0x[0-9a-f]{64}$/i.test(stored)&&BigInt(stored)>0n?'0x'+stored.slice(-40):null;
 const x={address:addr,codeBytes:(code.length-2)/2,selectors:selectors(code),
  ...(impl?{eip1967Implementation:impl}:{})};
 if(impl){
  const implCode=await rpc('eth_getCode',[impl,'latest']);
  x.implementation={address:impl,codeBytes:(implCode.length-2)/2,selectors:selectors(implCode)};
 }
 return x;
}
async function inspectTx(hash){
 const [tx,r]=await Promise.all([
  rpc('eth_getTransactionByHash',[hash]),
  rpc('eth_getTransactionReceipt',[hash]),
 ]);
 if(!tx||!r)throw Error('missing transaction '+hash);
 const logs=r.logs||[],events=[];
 for(const l of logs){
  if(l.address?.toLowerCase()!==MORPHO.toLowerCase()||l.topics?.[0]?.toLowerCase()!==morphoTopic)continue;
  try{
   const ev=morphoEvent.parseLog(l);
   events.push({index:Number(BigInt(l.logIndex??'0x0')),
    liquidator:ev.args.caller.toLowerCase(),borrower:ev.args.borrower.toLowerCase(),
    marketId:ev.args.id.toLowerCase(),repaidAssets:ev.args.repaidAssets.toString()});
  }catch(e){events.push({error:String(e.message).slice(0,80)})}
 }
 const fee=BigInt(r.gasUsed??'0')*BigInt(r.effectiveGasPrice??'0');
 const l1=BigInt(r.l1Fee??'0');
 return{
  hash,blockNumber:Number(BigInt(r.blockNumber??'0')),status:r.status,
  from:tx.from,to:tx.to,
  selector:tx.input?.slice(0,10)??null,calldataBytes:tx.input?((tx.input.length-2)/2):0,
  gasUsed:Number(BigInt(r.gasUsed??'0')),
  effectiveGasPriceWei:String(BigInt(r.effectiveGasPrice??'0')),
  feeL2Wei:fee.toString(),feeL1Wei:l1.toString(),feeTotalWei:(fee+l1).toString(),
  morphoEvents:events.length,uniqueBorrowers:new Set(events.map(x=>x.borrower)).size,
  uniqueMarkets:new Set(events.map(x=>x.marketId)).size,
  liquidators:[...new Set(events.map(x=>x.liquidator))],
  liquidationSamples:events.slice(0,5),
 };
}
(async()=>{
 const [contracts,txs]=await Promise.all([
   Promise.all(TARGETS.map(async address=>inspect(address).catch(e=>({address,error:String(e.message)})))),
   Promise.all(TX.map(async hash=>inspectTx(hash).catch(e=>({hash,error:String(e.message)}))))
 ]);
 const result={chainId:8453,contracts,transactions:txs,
  meaning:'Onchain events prove execution, not USD profit or strategy profitability. 32 events in one tx != 32 distinct gas-fee payments.'};
 fs.mkdirSync('.tmp',{recursive:true});
 fs.writeFileSync('.tmp/base-batch-liquidator-audit.json',JSON.stringify(result,null,2));
 console.log('BATCH_LIQUIDATOR_AUDIT='+JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});
