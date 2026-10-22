/**
 * Real Base fork only. Never submits transactions to Base mainnet.
 * Tests canonical Slipstream pool and Aave/Morpho liquidation into EURC->USDC.
 * Uses an isolated fake price feed at a pinned historical fork snapshot.
 */
const assert=require('node:assert/strict');
const hre=require('hardhat');
const {ethers}=require('ethers');
const p=hre.network.provider;
const rpc=new ethers.BrowserProvider({request:({method,params})=>p.request({method,params})});
const AAVE='0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const UNISWAP_FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const SLIPSTREAM_FACTORY='0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';
const POOL='0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7';
const EURC='0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ALVO='0xd1a992417a0abffa632cbde4da9f5dcf85caa858';
const COFRE='0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const factoryABI=new ethers.Interface(['function getPool(address,address,int24) view returns(address)']);
const tokensABI=new ethers.Interface(['function token0() view returns(address)','function token1() view returns(address)','function tickSpacing() view returns(int24)']);
const poolABI=new ethers.Interface(['function ADDRESSES_PROVIDER() view returns(address)','function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)']);
const apABI=new ethers.Interface(['function getPriceOracle() view returns(address)']);
const oracleABI=new ethers.Interface(['function getSourceOfAsset(address) view returns(address)','function getAssetPrice(address) view returns(uint256)']);
const ercABI=new ethers.Interface(['function balanceOf(address) view returns(uint256)']);
const call=async(to,abi,name,args=[])=>{
    const data=await p.send('eth_call',[{to,data:abi.encodeFunctionData(name,args)},'latest']);
    return abi.decodeFunctionResult(name,data)[0];
};
describe('Slipstream EURC/USDC: Base snapshot, no mainnet broadcast',function(){
  this.timeout(900000);
  it('validates real factory, tickSpacing and profitable Aave+Morpho+Slipstream settlement',async function(){
    const block=parseInt(await p.send('eth_blockNumber',[]),16);
    assert.equal(block,52745456,'pin a historical Base fork block');
    assert.equal(Number(BigInt(await p.send('eth_chainId',[]))),8453);
    for(const a of [AAVE,MORPHO,SLIPSTREAM_FACTORY,POOL,EURC,USDC])
      assert.notEqual(await p.send('eth_getCode',[a,'latest']),'0x',a+' code missing');
    assert.equal((await call(SLIPSTREAM_FACTORY,factoryABI,'getPool',[EURC,USDC,50])).toLowerCase(),POOL.toLowerCase());
    const token0=await call(POOL,tokensABI,'token0');
    const token1=await call(POOL,tokensABI,'token1');
    assert.deepEqual([token0.toLowerCase(),token1.toLowerCase()].sort(),[EURC,USDC].sort());
    assert.equal(await call(POOL,tokensABI,'tickSpacing'),50n);
    assert.equal(await call(USDC,ercABI,'balanceOf',[MORPHO])>=1_000_000_000n,true,'Morpho has too little USDC');
    const prov=await call(AAVE,poolABI,'ADDRESSES_PROVIDER');
    const oracle=await call(prov,apABI,'getPriceOracle');
    const feed=await call(oracle,oracleABI,'getSourceOfAsset',[EURC]);
    const price=await call(oracle,oracleABI,'getAssetPrice',[EURC]);
    assert.ok(price>0n);
    const hfBefore=(poolABI.decodeFunctionResult('getUserAccountData',
      await p.send('eth_call',[{to:AAVE,data:poolABI.encodeFunctionData('getUserAccountData',[ALVO])},'latest'])))[5];
    assert.ok(hfBefore>0n);
    if(hfBefore>=10n**18n){
      const art=await hre.artifacts.readArtifact('OraculoFalso');
      const [admin]=await p.send('eth_accounts',[]);
      await p.send('hardhat_setBalance',[admin,'0x'+(10n**20n).toString(16)]);
      const tx=await p.send('eth_sendTransaction',[{from:admin,data:art.bytecode,gas:'0x800000'}]);
      const receipt=await p.send('eth_getTransactionReceipt',[tx]);
      const runtime=await p.send('eth_getCode',[receipt.contractAddress,'latest']);
      await p.send('hardhat_setCode',[feed,runtime]);
      let hf=hfBefore;
      for(let step=1;step<=100&&hf>=10n**18n;step++){
        const newPrice=price*BigInt(1000-step*5)/1000n;
        await p.send('hardhat_setStorageAt',[feed,'0x0','0x'+newPrice.toString(16).padStart(64,'0')]);
        const res=await p.send('eth_call',[{to:AAVE,data:poolABI.encodeFunctionData('getUserAccountData',[ALVO])},'latest']);
        hf=poolABI.decodeFunctionResult('getUserAccountData',res)[5];
      }
      assert.ok(hf<10n**18n,'EURC feed change did not make target liquidatable');
    }
    const art=await hre.artifacts.readArtifact('CacadorAaveMultiHopMorpho');
    const signer=await rpc.getSigner(0);
    const executor=await new ethers.ContractFactory(art.abi,art.bytecode,signer)
      .deploy(COFRE,AAVE,MORPHO,UNISWAP_FACTORY);
    await executor.waitForDeployment();
    assert.equal((await executor.slipstreamFactory()).toLowerCase(),SLIPSTREAM_FACTORY.toLowerCase());
    await assert.rejects(()=>executor.liquidar.staticCall(ALVO,EURC,USDC,1_000_000_000n,1n,
      [[POOL,EURC,2,60]]),'tickSpacing spoof must revert');
    const valor=1_000_000_000n,rota=[[POOL,EURC,2,50]];
    const saldoAntes=await call(USDC,ercABI,'balanceOf',[COFRE]);
    const resultado=await executor.liquidar.staticCall(ALVO,EURC,USDC,valor,1n,rota);
    assert.ok(resultado>0n,'complete liquidation should yield gross USDC profit');
    const receipt=await (await executor.liquidar(ALVO,EURC,USDC,valor,1n,rota)).wait();
    assert.equal(receipt.status,1);
    const saldoDepois=await call(USDC,ercABI,'balanceOf',[COFRE]);
    assert.equal(saldoDepois-saldoAntes,resultado,'profit must reach vault after Morpho repayment');
    console.log('SLIPSTREAM_FORK_SETTLED '+JSON.stringify({
      block,alvo:ALVO,pool:POOL,earningsUsdc6:resultado.toString(),
      gasUsed:receipt.gasUsed.toString(),mainnetBroadcast:false,
    }));
  });
});
