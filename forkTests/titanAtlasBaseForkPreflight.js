// REAL Base fork-only preflight, no broadcast and no funded signer.
// Verifies canonical counterparts and immutables. This is not a profitable
// liquidation/Atlas auction simulation; a separate full-metacall replay is required.
const assert=require('node:assert/strict');
const {Interface,getAddress}=require('ethers');
const ADDR={
 atlas:'0x583dcFef0D240DC80753F0F0B26513feE27D9B77',
 control:'0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83',
 morpho:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
 router:'0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
 factory:'0x420DD381b31aEf6683db6B902084cB0FFECE40Da',
 weth:'0x4200000000000000000000000000000000000006',
 cofre:'0x3dffA934170bdD491724747Be2c4F56E3f1512A7',
};
const read=new Interface([
 'function VERIFICATION() view returns(address)',
 'function getSolverGasLimit() view returns(uint256)',
 'function defaultFactory() view returns(address)',
 'function dono() view returns(address)',
 'function cofre() view returns(address)',
 'function atlas() view returns(address)',
 'function weth() view returns(address)',
 'function factory() view returns(address)',
 'function router() view returns(address)',
 'function morpho() view returns(address)',
]);
describe('TITAN SVR: mainnet Base fork preflight',function(){
 this.timeout(180000);
 let p,owner;
 async function ethCall(address,name){
  const data=read.encodeFunctionData(name);
  const response=await p.send('eth_call',[{to:address,data},'latest']);
  return read.decodeFunctionResult(name,response)[0];
 }
 before(async()=>{
  p=hre.network.provider;
  assert.equal(BigInt(await p.send('eth_chainId',[])),8453n);
  [owner]=await p.send('eth_accounts',[]);
 });
 it('all external counterparties are real contracts, Atlas and Aerodrome coherent',async()=>{
  for(const [name,address] of Object.entries(ADDR)){
   if(name==='cofre')continue;
   assert.notEqual(await p.send('eth_getCode',[address,'latest']),'0x',name+' has no bytecode');
  }
  const verification=await ethCall(ADDR.atlas,'VERIFICATION');
  assert.equal(getAddress(verification),getAddress('0x6e1886aEca75160BAa5610B7c1D3a895198C61cf'));
  assert.ok((await ethCall(ADDR.control,'getSolverGasLimit'))>0n);
  assert.equal(getAddress(await ethCall(ADDR.router,'defaultFactory')),getAddress(ADDR.factory));
 });
 it('Solidity solver can deploy into a Base state fork with matching immutable addresses',async()=>{
  const art=await hre.artifacts.readArtifact('TitanAtlasMorphoLote');
  const iface=new Interface(art.abi);
  const args=[ADDR.atlas,ADDR.morpho,ADDR.router,ADDR.factory,ADDR.weth,ADDR.cofre];
  const calldata=art.bytecode+iface.encodeDeploy(args).slice(2);
  const tx=await p.send('eth_sendTransaction',[{from:owner,data:calldata,gas:'0x900000'}]);
  const receipt=await p.send('eth_getTransactionReceipt',[tx]);
  assert.equal(receipt.status,'0x1','deploy in fork reverted');
  const deployed=receipt.contractAddress;
  for(const [method,want] of Object.entries({
   dono:owner,cofre:ADDR.cofre,atlas:ADDR.atlas,morpho:ADDR.morpho,
   factory:ADDR.factory,weth:ADDR.weth,router:ADDR.router,
  })){
   const data=iface.encodeFunctionData(method);
   const raw=await p.send('eth_call',[{to:deployed,data},'latest']);
   assert.equal(getAddress(iface.decodeFunctionResult(method,raw)[0]),getAddress(want));
  }
  await assert.rejects(()=>p.send('eth_call',[{from:owner,to:deployed,
   data:iface.encodeFunctionData('executarLote',[[],1n])},'latest']));
  await assert.rejects(()=>p.send('eth_call',[{from:owner,to:deployed,
   data:iface.encodeFunctionData('atlasSolverCall',[
    owner,owner,'0x0000000000000000000000000000000000000000',
    1n,'0x12345678','0x'
   ])},'latest']));
 });
});
