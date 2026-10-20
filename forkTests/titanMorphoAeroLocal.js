const assert=require('node:assert/strict');
const {Interface}=require('ethers');
/**
 * No fork, no RPC, no private key. Morpho mock models seized-assets -> callback
 * -> transferFrom exact loan repayment. V3 mock enforces token allowance and
 * amountOutMinimum; full Base USDe/USDC EVM fork still REQUIRED.
 */
describe('TITAN Morpho Aero stable atomic callback',function(){
 this.timeout(120000);
 let p,owner,outsider,cofre;
 async function send(from,to,data){
  const hash=await p.send('eth_sendTransaction',[{
   from,...(to?{to}:{}),data,gas:'0x7a1200',
  }]);
  const receipt=await p.send('eth_getTransactionReceipt',[hash]);
  assert.equal(receipt?.status,'0x1');
  return receipt;
 }
 async function deploy(name,args=[]){
  const art=await hre.artifacts.readArtifact(name);
  const iface=new Interface(art.abi);
  const rec=await send(owner,null,art.bytecode+iface.encodeDeploy(args).slice(2));
  assert.match(rec.contractAddress,/^0x[0-9a-fA-F]{40}$/);
  return{address:rec.contractAddress,iface};
 }
 async function invoke(from,contract,method,args=[]){
  return send(from,contract.address,contract.iface.encodeFunctionData(method,args));
 }
 async function balance(token,addr){
  const v=await p.send('eth_call',[{
   to:token.address,from:owner,
   data:token.iface.encodeFunctionData('balanceOf',[addr]),
  },'latest']);
  return BigInt(v);
 }
 async function setup(){
  const loan=await deploy('TokenFalso',['USDC']);
  const collateral=await deploy('TokenFalso',['USDe']);
  const morpho=await deploy('MorphoAuditoriaFalso');
  const router=await deploy('AeroRouterMock');
  const factory=await deploy('AeroFactoryMock');
  const pool=await deploy('AeroPoolMock');
  const hunter=await deploy('TitanCacadorMorphoAero',
    [morpho.address,router.address,factory.address,cofre]);
  const params=[loan.address,collateral.address,owner,owner,915000000000000000n];
  await invoke(owner,factory,'setPool',[collateral.address,loan.address,true,pool.address]);
  await invoke(owner,loan,'criar',[router.address,1000000n]);
  await invoke(owner,collateral,'criar',[morpho.address,1000000n]);
  await invoke(owner,loan,'criar',[hunter.address,25n]); // old loan assets
  await invoke(owner,collateral,'criar',[hunter.address,7n]); // old collateral
  return{loan,collateral,morpho,router,factory,pool,hunter,params};
 }
 beforeEach(async()=>{p=hre.network.provider;[owner,outsider,,cofre]=await p.send('eth_accounts',[]);});
 it('liquidates in one tx, Morpho pulls full repay, Aero stable swap and only new profit goes vault',async()=>{
  const a=await setup();
  const before=await balance(a.loan,cofre);
  const r=await invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,true,10n,9999999999n]);
  assert.ok(BigInt(r.gasUsed)>0n);
  assert.equal(await balance(a.loan,cofre)-before,10n);
  assert.equal(await balance(a.loan,a.morpho.address),100n);
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
 });
 it('fails closed for healthy-size? mock profitability, nonexisting pool, zero floor, missing pool, wrong owner',async()=>{
  const a=await setup();
  await assert.rejects(()=>invoke(outsider,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,true,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,true,0n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,false,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,false,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,0n,0n,true,10n,9999999999n]));
  await assert.rejects(()=>invoke(outsider,a.hunter,'onMorphoLiquidate',[100n,'0x']));
  assert.equal(await balance(a.loan,cofre),0n);
 });
 it('cannot consume original contract balances or record profit if route underperforms',async()=>{
  const a=await setup();
  await invoke(owner,a.router,'setOutputBps',[9800]);
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,true,10n,9999999999n]));
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
  assert.equal(await balance(a.loan,a.morpho.address),0n);
  assert.equal(await balance(a.loan,cofre),0n);
 });
});
