const assert=require('node:assert/strict');
const {Interface}=require('ethers');
/**
 * No fork, no RPC, no private key. Morpho mock models seized-assets -> callback
 * -> transferFrom exact loan repayment. V3 mock enforces token allowance and
 * amountOutMinimum; full Base USDe/USDC EVM fork still REQUIRED.
 */
describe('TITAN Morpho V3 local atomic callback',function(){
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
 async function setup(morphoNome='MorphoAuditoriaFalso'){

  const loan=await deploy('TokenFalso',['USDC']);
  const collateral=await deploy('TokenFalso',['USDe']);
  const morpho=await deploy(morphoNome);
  const router=await deploy('TitanMockV3Router02');
  const factory=await deploy('TitanMockV3Factory');
  const pool=await deploy('TitanMockV3Pool');
  const hunter=await deploy('TitanCacadorMorphoV3',
    [morpho.address,router.address,factory.address,cofre]);
  const params=[loan.address,collateral.address,owner,owner,915000000000000000n];
  await invoke(owner,factory,'setPool',[collateral.address,loan.address,500,pool.address]);
  await invoke(owner,loan,'criar',[router.address,1000000n]);
  await invoke(owner,collateral,'criar',[morpho.address,1000000n]);
  await invoke(owner,loan,'criar',[hunter.address,25n]); // old loan assets
  await invoke(owner,collateral,'criar',[hunter.address,7n]); // old collateral
  return{loan,collateral,morpho,router,factory,pool,hunter,params};
 }
 beforeEach(async()=>{p=hre.network.provider;[owner,outsider,,cofre]=await p.send('eth_accounts',[]);});
 it('liquidates in one tx, Morpho pulls full repay, V3 swap and only new profit goes vault',async()=>{
  const a=await setup();
  const before=await balance(a.loan,cofre);
  const r=await invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,10n,9999999999n]);
  assert.ok(BigInt(r.gasUsed)>0n);
  assert.equal(await balance(a.loan,cofre)-before,10n);
  assert.equal(await balance(a.loan,a.morpho.address),100n);
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
 });
 it('fails closed for healthy-size? mock profitability, unsupported fee, zero floor, missing pool, wrong owner',async()=>{
  const a=await setup();
  await assert.rejects(()=>invoke(outsider,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,0n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,2500,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,3000,10n,9999999999n]));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,0n,0n,500,10n,9999999999n]));
  await assert.rejects(()=>invoke(outsider,a.hunter,'onMorphoLiquidate',[100n,'0x']));
  assert.equal(await balance(a.loan,cofre),0n);
 });
 it('cannot consume original contract balances or record profit if route underperforms',async()=>{
  const a=await setup();
  await invoke(owner,a.router,'setOutputBps',[9800]);
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidar',[
   a.params,outsider,100n,0n,500,10n,9999999999n]));
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
  assert.equal(await balance(a.loan,a.morpho.address),0n);
  assert.equal(await balance(a.loan,cofre),0n);
 });

 it('near position reaches full simulation: interest accrues before health; healthy case never sends',async()=>{
  const {candidatoElegivelV3}=require('../dist/titanMorphoV3Gate');
  assert.equal(candidatoElegivelV3('proxima',true),true);
  const a=await setup('MorphoJurosFalso');
  const data=a.hunter.iface.encodeFunctionData('liquidar',[
   a.params,outsider,100n,0n,500,10n,9999999999n]);
  const ret=await p.send('eth_call',[{from:owner,to:a.hunter.address,data},'latest']);
  assert.equal(BigInt(ret),10n);
  // eth_call does not persist accrual or move real balances.
  assert.equal(await balance(a.loan,cofre),0n);
  assert.equal(BigInt(await p.send('eth_call',[{to:a.morpho.address,
   data:a.morpho.iface.encodeFunctionData('divida')},'latest'])),100n);
  await invoke(owner,a.morpho,'configurar',[0]);
  await assert.rejects(()=>p.send('eth_call',[{from:owner,to:a.hunter.address,data},'latest']),/HEALTHY_POSITION/);
  assert.equal(await balance(a.loan,cofre),0n);
 });

 it('two-hop V3 route simulates and repays without direct pool; rejects wrong/unauthorized path and floor',async()=>{
  const {solidityPacked}=require('ethers');
  const a=await setup();const meio=await deploy('TokenFalso',['bridge']);
  const rota=solidityPacked(['address','uint24','address','uint24','address'],
   [a.collateral.address,500,meio.address,3000,a.loan.address]);
  await invoke(owner,a.factory,'setPool',[a.collateral.address,a.loan.address,500,'0x0000000000000000000000000000000000000000']);
  await invoke(owner,a.factory,'setPool',[a.collateral.address,meio.address,500,a.pool.address]);
  await invoke(owner,a.factory,'setPool',[meio.address,a.loan.address,3000,a.pool.address]);
  const args=[a.params,outsider,100n,0n,rota,10n,9999999999n];
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidarRota',args)); // not allowlisted
  await invoke(owner,a.hunter,'autorizarIntermediario',[meio.address,true]);
  await invoke(owner,meio,'criar',[a.router.address,1000000n]);
  await assert.rejects(()=>invoke(outsider,a.hunter,'liquidarRota',args));
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidarRota',[...args.slice(0,5),11n,args[6]]));
  const wrong=solidityPacked(['address','uint24','address','uint24','address'],
   [a.collateral.address,500,meio.address,3000,a.collateral.address]);
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidarRota',[...args.slice(0,4),wrong,10n,args[6]]));
  const data=a.hunter.iface.encodeFunctionData('liquidarRota',args);
  assert.equal(BigInt(await p.send('eth_call',[{from:owner,to:a.hunter.address,data},'latest'])),10n);
  await invoke(owner,a.hunter,'liquidarRota',args);
  assert.equal(await balance(a.loan,cofre),10n);
  assert.equal(await balance(a.loan,a.morpho.address),100n);
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
  assert.equal(BigInt(await p.send('eth_call',[{to:a.router.address,data:a.router.iface.encodeFunctionData('hopsExecutados')},'latest'])),2n);
 });
});
