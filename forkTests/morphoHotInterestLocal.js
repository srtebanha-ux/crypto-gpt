/* Local EVM only. No external RPC, real wallet, or mainnet transaction. */
const assert=require('node:assert/strict');
const {Interface}=require('ethers');
const solc=require('solc');
const {Decimal}=require('decimal.js');
const {montarLoteMorphoHot}=require('../dist/titanMorphoHot');
const {examinarSaudeMorpho}=require('../dist/titanMorphoRadar');
const {lerMarket,lerPosition}=require('../dist/morphoApi');
const {MORPHO_FLASH_BASE}=require('../dist/titanPonteMultiHop');
const source=`pragma solidity ^0.8.26;
contract InterestFixture {
 struct Params {address loanToken;address collateralToken;address oracle;address irm;uint256 lltv;}
 uint256 public debt;
 function init() external {debt=100;}
 function accrueInterest(Params calldata p) external {
   require(p.irm!=address(1),"IRM failed"); debt=120;
 }
 function market(bytes32) external view returns(uint128,uint128,uint128,uint128,uint128,uint128){
   return(1000,1000000000,uint128(debt),100000000,1,0);
 }
 function position(bytes32,address) external pure returns(uint256,uint128,uint128){
   return(0,100000000,140);
 }
 function price() external pure returns(uint256){return 1e36;}
}
contract AggregateFixture {
 struct Call {address target;bool allowFailure;bytes callData;}
 struct Result {bool success;bytes returnData;}
 function aggregate3(Call[] calldata calls) external returns(Result[] memory r){
   r=new Result[](calls.length);
   for(uint i;i<calls.length;i++){
     (r[i].success,r[i].returnData)=calls[i].target.call(calls[i].callData);
     require(r[i].success||calls[i].allowFailure,"subcall failed");
   }
 }
}`;
describe('Morpho HOT interest accrual inside eth_call',function(){
 this.timeout(120000);
 let p,owner,abi,aggregate,borrower;
 async function send(to,data){
   const hash=await p.send('eth_sendTransaction',[{from:owner,...to?{to}:{},data,gas:'0x7a1200'}]);
   const r=await p.send('eth_getTransactionReceipt',[hash]);
   assert.equal(r.status,'0x1');return r;
 }
 before(async()=>{
   p=hre.network.provider;[owner,borrower]=await p.send('eth_accounts',[]);
   const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',
     sources:{'Fixture.sol':{content:source}},settings:{evmVersion:'paris',
       outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}})));
   assert.deepEqual((output.errors||[]).filter(e=>e.severity==='error'),[]);
   const c=output.contracts['Fixture.sol'];abi=new Interface(c.InterestFixture.abi);
   await p.send('hardhat_setCode',[MORPHO_FLASH_BASE,'0x'+c.InterestFixture.evm.deployedBytecode.object]);
   const r=await send(null,'0x'+c.AggregateFixture.evm.bytecode.object);
   aggregate={address:r.contractAddress,abi:new Interface(c.AggregateFixture.abi)};
 });
 beforeEach(async()=>{await send(MORPHO_FLASH_BASE,abi.encodeFunctionData('init'));});
 function target(id,irm=owner){return {usuario:borrower,distanciaBps:100n,atualizadoEm:Date.now(),
   mercado:{id:'0x'+id.repeat(64),loanToken:owner,collateralToken:borrower,
     oracle:MORPHO_FLASH_BASE,irm,lltv:new Decimal('0.8'),confirmadoNaCorrente:true}};}
 async function simulate(targets){
   const batch=montarLoteMorphoHot(targets);
   const hex=await p.send('eth_call',[{to:aggregate.address,
     data:aggregate.abi.encodeFunctionData('aggregate3',[batch.calls])},'latest']);
   return {batch,rows:aggregate.abi.decodeFunctionResult('aggregate3',hex)[0]};
 }
 it('sees interest-crossed debt in the same call and leaves chain storage unchanged',async()=>{
   const a=target('a');const {batch,rows}=await simulate([a]);
   const idx=batch.indices.values().next().value;
   assert.equal(rows[idx.accrual].success,true);
   const m=lerMarket(rows[idx.market].returnData),pos=lerPosition(rows[idx.position].returnData);
   assert.equal(m.totalBorrowAssets,120n);
   const state=examinarSaudeMorpho({borrowShares:pos.borrowShares,collateral:pos.collateral,
     totalBorrowAssets:m.totalBorrowAssets,totalBorrowShares:m.totalBorrowShares,
     precoOracle:10n**36n,lltvWad:800000000000000000n});
   assert.equal(state.situacao,'cruzou-estimado');
   const hex=await p.send('eth_call',[{to:MORPHO_FLASH_BASE,data:abi.encodeFunctionData('debt')},'latest']);
   assert.equal(BigInt(hex),100n,'eth_call must not persist accrued debt');
 });
 it('flags a reverting accrual independently while another market remains readable',async()=>{
   const a=target('b','0x0000000000000000000000000000000000000001'),b=target('c');
   const {batch,rows}=await simulate([a,b]);const [bad,good]=[...batch.indices.values()];
   assert.equal(rows[bad.accrual].success,false,'watcher must skip this market');
   assert.equal(rows[good.accrual].success,true);
   assert.equal(rows[good.market].success,true);
   assert.equal(lerMarket(rows[good.market].returnData).totalBorrowAssets,120n);
 });
});
