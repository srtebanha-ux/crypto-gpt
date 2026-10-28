import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Interface,keccak256} from 'ethers';
import {prepararCpammAtomico,WETH_BASE_CPAMM,type ConfigCpammAtomico} from './titanCpammAtomico';
const a=(n:string)=>'0x'+n.repeat(40);
const pool1=a('1'),pool2=a('2'),alt=a('3'),factory=a('4'),factory2=a('8'),owner=a('5'),executor=a('6');
const abi=new Interface([
 'function factory() view returns(address)','function token0() view returns(address)',
 'function token1() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)',
 'function getPair(address,address) view returns(address)','function owner() view returns(address)',
 'function balanceOf(address) view returns(uint256)','function getL1FeeUpperBound(uint256) view returns(uint256)',
 'function executarArbitragem(address,address,address,uint256,uint256)',
]);
const unit=10n**18n;
const config:ConfigCpammAtomico={executor,executorCodeHash:keccak256('0x6001'),
 factories:[factory,factory2].map(endereco=>({endereco,poolCodeHash:keccak256('0x6002'),taxaNumerador:997,taxaDenominador:1000})),
 minimoLiquidoWei:1000000000000n};
function fixture(opts:{taxed?:boolean;wrongCode?:boolean;wrongFactory?:boolean;priorAlt?:boolean;noL1?:boolean;stale?:boolean;expensive?:boolean}={}) {
 const calls:{method:string;params:any[]}[]=[];let heads=0;
 const rpc=async(method:string,params:unknown[]):Promise<unknown>=>{
  calls.push({method,params:params as any[]});
  if(method==='eth_chainId')return '0x2105';
  if(method==='eth_blockNumber')return ++heads>1&&opts.stale?'0x65':'0x64';
  if(method==='eth_getCode')return params[0]===executor?(opts.wrongCode?'0x6003':'0x6001'):'0x6002';
  if(method==='eth_gasPrice')return opts.expensive?'0xe8d4a51000':'0x1';
  if(method==='eth_getTransactionCount')return '0x0';
  if(method==='eth_estimateGas'){
   if(opts.taxed)throw Error('UniswapV2: K (fee-on-transfer)');
   return '0x493e0';
  }
  assert.equal(method,'eth_call','planner must never sign or send');
  const tx=params[0] as {to:string;data:string};const parsed=abi.parseTransaction({data:tx.data})!;
  const encode=(v:unknown[])=>abi.encodeFunctionResult(parsed.name,v);
  switch(parsed.name){
   case 'owner':return encode([owner]);
   case 'factory':return encode([opts.wrongFactory?a('7'):tx.to===pool1?factory:factory2]);
   case 'token0':return encode([WETH_BASE_CPAMM]);
   case 'token1':return encode([alt]);
   case 'getReserves':return encode([tx.to===pool1?100n*unit:110n*unit,300000n*unit,0]);
   case 'getPair':return encode([tx.to.toLowerCase()===factory?pool1:pool2]);
   case 'balanceOf':return encode([tx.to.toLowerCase()===alt&&opts.priorAlt?unit:0n]);
   case 'getL1FeeUpperBound':if(opts.noL1)throw Error('oracle unavailable');return encode([1000n]);
   case 'executarArbitragem':{
    assert.equal(params[1],'0x64');
    assert.equal((params[0] as any).from.toLowerCase(),owner);
    assert.ok(parsed.args[4]>config.minimoLiquidoWei,'floor includes full costs');
    return '0x';
   }
   default:throw Error('unexpected '+parsed.name);
  }
 };
 return {rpc,calls};
}
test('integer seed reaches full calldata simulation with L1+L2 and positive net floor',async()=>{
 const f=fixture();const r=await prepararCpammAtomico(f.rpc,config,[pool1,pool2],WETH_BASE_CPAMM,8n*unit);
 assert.ok(r);assert.equal(r.etapa,'simulada');assert.ok(r.lucroMinimoWei>=config.minimoLiquidoWei);
 assert.ok(r.custoMaximoWei>300000n);assert.ok(r.entradaWei<=8n*unit);assert.ok(r.emprestadoWei>r.entradaWei);
 assert.ok(r.simulacoes>0&&r.simulacoes<=3);
 assert.ok(f.calls.filter(c=>c.method==='eth_call').every(c=>c.params[1]==='0x64'));
 assert.ok(!f.calls.some(c=>/send|sign/i.test(c.method)));
});
test('theoretical profit never passes without repayment, L1 costs or fresh state',async()=>{
 for(const opts of [{taxed:true},{noL1:true},{stale:true},{expensive:true}]){
  const {rpc}=fixture(opts);
  assert.equal(await prepararCpammAtomico(rpc,config,[pool1,pool2],WETH_BASE_CPAMM,8n*unit),null);
 }
});
test('executor identity, factory, fees and preexisting collateral fail closed',async()=>{
 for(const opts of [{wrongCode:true},{wrongFactory:true},{priorAlt:true}]){
  const {rpc}=fixture(opts);
  await assert.rejects(prepararCpammAtomico(rpc,config,[pool1,pool2],WETH_BASE_CPAMM,8n*unit));
 }
 const {rpc}=fixture();
 await assert.rejects(prepararCpammAtomico(rpc,{...config,factories:[{...config.factories[0],taxaNumerador:999}]},[pool1,pool2],WETH_BASE_CPAMM,unit),/Configuração/);
});
test('non-WETH cycles cannot compare USDC profit directly to ETH gas',async()=>{
 const f=fixture();assert.equal(await prepararCpammAtomico(f.rpc,config,[pool1,pool2],alt,unit),null);
 assert.equal(f.calls.length,0);
});
