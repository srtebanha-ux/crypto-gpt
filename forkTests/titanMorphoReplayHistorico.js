'use strict';
/**
 * Historical Base mainnet EVM fork replay of a REAL successful competitor
 * transaction. Never signs, broadcasts or touches the user's production wallet.
 *
 * Run with a Base archive RPC that supports the historical block:
 * BASE_ARCHIVE_RPC_URL=... npx hardhat test --config hardhat.morpho-local.cjs forkTests/titanMorphoReplayHistorico.js
 *
 * This tests whether the archive/fork can re-execute a competitor transaction,
 * NOT whether TITAN can win a contemporary race. The TITAN executor must pass
 * its own exact liquidation call and economic floor separately.
 */
const assert=require('node:assert/strict');
const {JsonRpcProvider,toBeHex}=require('ethers');
const HASH='0x4f3ce6daf1f4e9a0f2feaa42d73f55cdf12c4c551622087a3f8b744dae44920b';
const HISTORICAL_BLOCK=52826091;
describe('Base mainnet historical competitor liquidation fork',function(){
 this.timeout(180000);
 it('replays a real cbETH/USDC liquidation at the parent block, with zero mainnet spend',async function(){
   const url=process.env.BASE_ARCHIVE_RPC_URL;
   if(!url){this.skip();return;}
   assert.equal(hre.network.name,'hardhat','Never use a real network for replay');
   const source=new JsonRpcProvider(url,8453,{staticNetwork:true,batchMaxCount:1});
   try{
     const [tx,original]=await Promise.all([
       source.getTransaction(HASH),source.getTransactionReceipt(HASH),
     ]);
     assert.ok(tx&&original,'Transaction or receipt not found on the archive RPC');
     assert.equal(tx.blockNumber,HISTORICAL_BLOCK,'Historical fixture block changed');
     assert.equal(original.status,1,'Reference tx did not succeed');
     assert.ok(tx.to&&tx.from&&tx.data!=='0x','Reference is not a contract call');
     // Reset to the parent BLOCK. A same-block oracle update or another swap
     // may mean replay needs a transaction-index-aware fixture.
     await hre.network.provider.request({method:'hardhat_reset',params:[{
       forking:{jsonRpcUrl:url,blockNumber:HISTORICAL_BLOCK-1},
     }]});
     await hre.network.provider.request({method:'hardhat_impersonateAccount',params:[tx.from]});
     await hre.network.provider.request({method:'hardhat_setBalance',
       params:[tx.from,toBeHex(10n**18n)]});
     const localHash=await hre.network.provider.request({method:'eth_sendTransaction',params:[{
       from:tx.from,to:tx.to,data:tx.data,value:toBeHex(tx.value),
       gas:toBeHex(tx.gasLimit),
     }]});
     const simulated=await hre.network.provider.request({
       method:'eth_getTransactionReceipt',params:[localHash],
     });
     assert.equal(simulated?.status,'0x1',
       'Competitor historical replay failed; check same-block state/oracle ordering');
     assert.ok(Number.parseInt(simulated.gasUsed,16)>0,'No real EVM execution');
     console.log(JSON.stringify({
       replay:'BASE_ARCHIVE_FORK_ONLY',originalHash:HASH,
       originalBlock:HISTORICAL_BLOCK,localHash,
       gasUsed:BigInt(simulated.gasUsed).toString(),
       realMainnetTransaction:false,mainnetCostWei:'0',
       proven:'historical competitor calldata can execute in isolated fork',
       notProven:'TITAN executor profitability or live competition',
     }));
   }finally{source.destroy();}
 });
});
