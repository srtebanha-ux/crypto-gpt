/**
 * Reproduces real Base cbBTC/USDC borrower and canonical Uniswap V3 liquidity,
 * with only the Aave price feed changed inside a pinned Hardhat fork.
 * Never broadcasts to mainnet. No key loaded, and all debt/rewards are real
 * contract state from the historic Base block.
 */
const assert=require('node:assert/strict');
const hre=require('hardhat');
const {ethers}=require('ethers');
const p=hre.network.provider;
const rpc=new ethers.BrowserProvider({request:({method,params})=>p.request({method,params})});
const AAVE='0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const ALVO='0x03d0a5c9e1843986fb2f9335f7eb936754f7eaf0';
const COFRE='0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const CBBTC='0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const POOL='0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef';
const abi=new ethers.Interface([
 'function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)',
 'function ADDRESSES_PROVIDER() view returns(address)',
 'function getPriceOracle() view returns(address)',
 'function getSourceOfAsset(address) view returns(address)',
 'function getAssetPrice(address) view returns(uint256)',
 'function getPool(address,address,uint24) view returns(address)',
 'function balanceOf(address) view returns(uint256)',
]);
async function call(to,n,args=[]){
  const data=await p.send('eth_call',[{to,data:abi.encodeFunctionData(n,args)},'latest']);
  return abi.decodeFunctionResult(n,data)[0];
}
async function account(){
  const data=await p.send('eth_call',[{to:AAVE,data:abi.encodeFunctionData('getUserAccountData',[ALVO])},'latest']);
  return abi.decodeFunctionResult('getUserAccountData',data);
}
describe('cbBTC candidate: real Base Aave+Morpho+Uniswap V3 fork (zero mainnet)',function(){
 this.timeout(900000);
 it('adjusts only the oracle in fork and settles real cbBTC for USDC',async function(){
   assert.equal(Number(BigInt(await p.send('eth_chainId',[]))),8453);
   assert.equal(parseInt(await p.send('eth_blockNumber',[]),16),52746275);
   assert.equal((await call(FACTORY,'getPool',[CBBTC,USDC,500])).toLowerCase(),POOL.toLowerCase());
   const before=await account();
   console.log('ALVO1_PRESTATE '+JSON.stringify({hf:before[5].toString(),usdDebt8:before[1].toString()}));
   assert.ok(before[5]>=10n**18n,'snapshot should be healthy before mock change');
   const oracle=await call(await call(AAVE,'ADDRESSES_PROVIDER'),'getPriceOracle');
   const feed=await call(oracle,'getSourceOfAsset',[CBBTC]);
   const price=await call(oracle,'getAssetPrice',[CBBTC]);
   assert.ok(price>0n);
   const fakeArt=await hre.artifacts.readArtifact('OraculoFalso');
   const [admin]=await p.send('eth_accounts',[]);
   await p.send('hardhat_setBalance',[admin,'0x'+(10n**20n).toString(16)]);
   const fakeTx=await p.send('eth_sendTransaction',[{from:admin,data:fakeArt.bytecode,gas:'0x800000'}]);
   const fakeRc=await p.send('eth_getTransactionReceipt',[fakeTx]);
   const fakeCode=await p.send('eth_getCode',[fakeRc.contractAddress,'latest']);
   await p.send('hardhat_setCode',[feed,fakeCode]);
   let hf=before[5],newPrice=price;
   for(let step=1;step<=160&&hf>=10n**18n;step++){
     newPrice=price*BigInt(1000-step*5)/1000n;
     await p.send('hardhat_setStorageAt',[feed,'0x0','0x'+newPrice.toString(16).padStart(64,'0')]);
     hf=(await account())[5];
   }
   assert.ok(hf<10n**18n,'cbBTC price drop in fork did not cross HF < 1');
   const artifact=await hre.artifacts.readArtifact('CacadorAaveMultiHopMorpho');
   const signer=await rpc.getSigner(0);
   const exec=await new ethers.ContractFactory(artifact.abi,artifact.bytecode,signer)
     .deploy(COFRE,AAVE,MORPHO,FACTORY);
   await exec.waitForDeployment();
   const beforeVault=await call(USDC,'balanceOf',[COFRE]);
   // Debt ~$1,891; 850 USDC leaves >$1,020, avoiding observed Aave dust rule.
   // Try conservatively sized candidates against the real Aave data.
   let success=null;
   for(const size of [850_000_000n,820_000_000n,800_000_000n,750_000_000n,700_000_000n,600_000_000n]){
     try{
       const gross=await exec.liquidar.staticCall(ALVO,CBBTC,USDC,size,1n,[[POOL,CBBTC,0,500]]);
       if(gross>0n){success={size,gross};break;}
     }catch(e){console.log('ALVO1_CANDIDATE_REJECTED '+JSON.stringify({usdc6:size.toString(),
       error:String(e).slice(0,250)}));}
   }
   assert.ok(success,'no candidate returned a profitable cbBTC->USDC atomic liquidation in fork');
   const rc=await (await exec.liquidar(ALVO,CBBTC,USDC,success.size,1n,[[POOL,CBBTC,0,500]])).wait();
   assert.equal(rc.status,1);
   const afterVault=await call(USDC,'balanceOf',[COFRE]);
   assert.equal(afterVault-beforeVault,success.gross);
   console.log('ALVO1_CBBTC_FORK_SETTLED '+JSON.stringify({
      block:52746275,healthFactorAfterOracleMock:hf.toString(),
      coverageUsdc6:success.size.toString(),profitUsdc6:success.gross.toString(),
      gasUsed:rc.gasUsed.toString(),mainnetBroadcast:false,
   }));
 });
});
