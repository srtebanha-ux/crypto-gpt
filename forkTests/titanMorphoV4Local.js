const assert=require('node:assert/strict');
const {Interface}=require('ethers');
/**
 * No fork, no RPC, no private key. Morpho mock models seized-assets -> callback
 * -> transferFrom exact loan repayment. V3 mock enforces token allowance and
 * amountOutMinimum; full Base USDe/USDC EVM fork still REQUIRED.
 */
describe('TITAN Morpho V4 local atomic callback',function(){
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
  const mid=await deploy('TokenFalso',['WETH']);
  const morpho=await deploy('MorphoAuditoriaFalso');
  const router=await deploy('TitanMockV3Router02');
  const factory=await deploy('TitanMockV3Factory');
  const pool=await deploy('TitanMockV3Pool');
  const hunter=await deploy('TitanCacadorMorphoV4',
    [morpho.address,router.address,factory.address,cofre]);
  const params=[loan.address,collateral.address,owner,owner,915000000000000000n];
  await invoke(owner,factory,'setPool',[collateral.address,loan.address,500,pool.address]);
  await invoke(owner,factory,'setPool',[collateral.address,mid.address,500,pool.address]);
  await invoke(owner,factory,'setPool',[mid.address,loan.address,3000,pool.address]);
  await invoke(owner,loan,'criar',[router.address,1000000n]);
  await invoke(owner,collateral,'criar',[morpho.address,1000000n]);
  await invoke(owner,loan,'criar',[hunter.address,25n]); // old loan assets
  await invoke(owner,collateral,'criar',[hunter.address,7n]); // old collateral
  return{loan,collateral,mid,morpho,router,factory,pool,hunter,params};
 }
 beforeEach(async()=>{p=hre.network.provider;[owner,outsider,,cofre]=await p.send('eth_accounts',[]);});
 it('2-hop verified V3 path: collateral -> WETH -> loan, repay and profit only',async()=>{
  const a=await setup();
  const before=await balance(a.loan,cofre);
  const r=await invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,a.mid.address,3000,10n,9999999999n
  ]);
  assert.equal(r.status,'0x1');
  assert.equal(await balance(a.loan,cofre)-before,10n);
  assert.equal(await balance(a.loan,a.morpho.address),100n);
  assert.equal(await balance(a.loan,a.hunter.address),25n);
 });
 it('2-hop fails closed for bad second fee and routes missing canonical pool',async()=>{
  const a=await setup();
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,a.mid.address,123,10n,9999999999n
  ]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,a.mid.address,100,10n,9999999999n
  ]));
  await invoke(owner,a.router,'setOutputBps',[9800]);
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,a.mid.address,3000,10n,9999999999n
  ]));
 });
 it('liquidates in one tx, Morpho pulls full repay, V3 swap and only new profit goes vault',async()=>{
  const a=await setup();
  const before=await balance(a.loan,cofre);
  const r=await invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,'0x0000000000000000000000000000000000000000',0,10n,9999999999n]);
  assert.ok(BigInt(r.gasUsed)>0n);
  assert.equal(await balance(a.loan,cofre)-before,10n);
  assert.equal(await balance(a.loan,a.morpho.address),100n);
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
 });
 it('fails closed for healthy-size? mock profitability, unsupported fee, zero floor, missing pool, wrong owner',async()=>{
  const a=await setup();
  await assert.rejects(()=>invoke(outsider,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,'0x0000000000000000000000000000000000000000',0,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,'0x0000000000000000000000000000000000000000',0,0n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,2500,'0x0000000000000000000000000000000000000000',0,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,3000,'0x0000000000000000000000000000000000000000',0,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,0n,0n,500,'0x0000000000000000000000000000000000000000',0,10n,9999999999n]));
  await assert.rejects(()=>invoke(outsider,a.hunter,'onMorphoLiquidate',[100n,'0x']));
  assert.equal(await balance(a.loan,cofre),0n);
 });
 it('cannot consume original contract balances or record profit if route underperforms',async()=>{
  const a=await setup();
  await invoke(owner,a.router,'setOutputBps',[9800]);
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,'0x0000000000000000000000000000000000000000',0,10n,9999999999n]));
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
  assert.equal(await balance(a.loan,a.morpho.address),0n);
  assert.equal(await balance(a.loan,cofre),0n);
 });
});
