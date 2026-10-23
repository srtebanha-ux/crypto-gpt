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
 async function setup(morphoNome='MorphoAuditoriaFalso'){

  const loan=await deploy('TokenFalso',['USDC']);
  const collateral=await deploy('TokenFalso',['USDe']);
  const morpho=await deploy(morphoNome);
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

 it('near position reaches full simulation: interest accrues before health; healthy case never sends',async()=>{
  const {candidatoElegivelV3}=require('../dist/titanMorphoV3Gate');
  assert.equal(candidatoElegivelV3('proxima',true),true);
  const a=await setup('MorphoJurosFalso');
  const data=a.hunter.iface.encodeFunctionData('liquidar',[
   a.params,outsider,100n,0n,true,10n,9999999999n]);
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

 it('two-hop Aero route repays without direct pool; rejects disconnected route/factory and insufficient floor',async()=>{
  const a=await setup();const meio=await deploy('TokenFalso',['bridge']);
  const rota=[[a.collateral.address,meio.address,false,a.factory.address],[meio.address,a.loan.address,true,a.factory.address]];
  await invoke(owner,a.factory,'setPool',[a.collateral.address,a.loan.address,true,'0x0000000000000000000000000000000000000000']);
  await invoke(owner,a.factory,'setPool',[a.collateral.address,meio.address,false,a.pool.address]);
  await invoke(owner,a.factory,'setPool',[meio.address,a.loan.address,true,a.pool.address]);
  const args=[a.params,outsider,100n,0n,rota,10n,9999999999n];
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidarRota',args));
  await invoke(owner,a.hunter,'autorizarIntermediario',[meio.address,true]);
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidarRota',[...args.slice(0,5),11n,args[6]]));
  const wrong=[[a.collateral.address,meio.address,false,outsider],rota[1]];
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidarRota',[...args.slice(0,4),wrong,10n,args[6]]));
  const disconnected=[rota[0],[a.collateral.address,a.loan.address,true,a.factory.address]];
  await assert.rejects(()=>invoke(owner,a.hunter,'liquidarRota',[...args.slice(0,4),disconnected,10n,args[6]]));
  const data=a.hunter.iface.encodeFunctionData('liquidarRota',args);
  assert.equal(BigInt(await p.send('eth_call',[{from:owner,to:a.hunter.address,data},'latest'])),10n);
  await invoke(owner,a.hunter,'liquidarRota',args);
  assert.equal(await balance(a.loan,cofre),10n);
  assert.equal(await balance(a.loan,a.morpho.address),100n);
  assert.equal(await balance(a.loan,a.hunter.address),25n);
  assert.equal(await balance(a.collateral,a.hunter.address),7n);
 });
});
