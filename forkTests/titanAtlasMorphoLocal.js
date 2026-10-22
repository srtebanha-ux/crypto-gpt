/* Zero-ETH mainnet simulation, local mock Atlantis/Morpho/Aerodrome. */
const assert=require('node:assert/strict');
const {Interface,parseEther}=require('ethers');

describe('TITAN SVR: Atlas solver, WETH-funded bids and 16-position batch',function(){
 this.timeout(120000);
 let p,owner,wrong,cofre,env,weth,collateral,morpho,router,atlas,solver,market;
 async function trans(from,to,data,value=0n){
  const hash=await p.send('eth_sendTransaction',[{
   from,...(to?{to}:{}),data,value:'0x'+value.toString(16),gas:'0xf42400'
  }]);
  const receipt=await p.send('eth_getTransactionReceipt',[hash]);
  assert.equal(receipt?.status,'0x1');
  return receipt;
 }
 async function create(name,args=[]){
  const a=await hre.artifacts.readArtifact(name);
  const iface=new Interface(a.abi);
  const r=await trans(owner,null,a.bytecode+iface.encodeDeploy(args).slice(2));
  return{address:r.contractAddress,iface};
 }
 async function send(from,c,method,args=[],value=0n){
  return trans(from,c.address,c.iface.encodeFunctionData(method,args),value);
 }
 async function call(c,method,args=[]){
  let val=await p.send('eth_call',[{to:c.address,data:c.iface.encodeFunctionData(method,args)},'latest']);
  return c.iface.decodeFunctionResult(method,val);
 }
 async function balance(c,who){return(await call(c,'balanceOf',[who]))[0];}
 async function expectFailure(from,to,data,value=0n){
  await assert.rejects(async()=>{
   let tx=await p.send('eth_sendTransaction',[{
     from,to,data,value:'0x'+value.toString(16),gas:'0xf42400'
   }]);
   let receipt=await p.send('eth_getTransactionReceipt',[tx]);
   if(receipt?.status==='0x0')throw Error('reverted');
  });
 }
 function targets(n=3,piso=8n){
  return Array.from({length:n},(_,idx)=>[
   market,idx%2?wrong:owner,100n,0n,false,piso
  ]);
 }
 async function bid(batch,bidAmount=12n,minAfter=15n,signer=owner){
  const encoded=solver.iface.encodeFunctionData('executarLote',[batch,minAfter]);
  return atlas.iface.encodeFunctionData('run',[
   solver.address,signer,env,bidAmount,encoded,
  ]);
 }
 beforeEach(async()=>{
  p=hre.network.provider;
  [owner,wrong,cofre,env]=await p.send('eth_accounts',[]);
  weth=await create('WethTitanFalso');
  collateral=await create('TokenFalso',['Collateral']);
  morpho=await create('MorphoAuditoriaFalso');
  router=await create('RoteadorAerodromeFalso');
  atlas=await create('AtlasTitanFalso');
  solver=await create('TitanAtlasMorphoLote',[
   atlas.address,morpho.address,router.address,owner,weth.address,cofre,
  ]);
  market=[weth.address,collateral.address,owner,owner,625000000000000000n];
  // Back ETH reserves in WETH. Use 200 ETH from local funded test signer;
  // these are NOT used as TITAN solver funds.
  await trans(owner,weth.address,'0x',parseEther('200'));
  await send(owner,weth,'criar',[router.address,2000n]);
  await send(owner,collateral,'criar',[morpho.address,2000n]);
  // Pre-existing funds must not pay a bid, repay, or inflate profit.
  await send(owner,weth,'criar',[solver.address,25n]);
  await send(owner,collateral,'criar',[solver.address,7n]);
 });
 it('3 Morpho positions in one Atlas solver call; 12 WETH bid funded from earned profit',async()=>{
  const initial=await balance(weth,solver.address);
  const envBefore=BigInt(await p.send('eth_getBalance',[env,'latest']));
  const cofreBefore=await balance(weth,cofre);
  const r=await trans(owner,atlas.address,await bid(targets()));
  assert.equal(await balance(weth,solver.address),initial,'old WETH untouched');
  assert.equal(await balance(collateral,solver.address),7n,'old collateral untouched');
  assert.equal(await balance(weth,cofre)-cofreBefore,18n,'only 18 WETH remaining after winning bid');
  const envAfter=BigInt(await p.send('eth_getBalance',[env,'latest']));
  assert.equal(envAfter-envBefore,12n,'bid paid from new WETH via unwrap');
  const eventLogs=r.logs.filter(x=>x.address.toLowerCase()===solver.address.toLowerCase());
  const types=eventLogs.map(x=>solver.iface.parseLog(x)?.name);
  assert.equal(types.filter(x=>x==='LiquidacaoDoLote').length,3);
  assert.equal(types.filter(x=>x==='LoteAtlasExecutado').length,1);
  assert.equal((await call(atlas,'calls'))[0],1n);
 });
 it('no use of previous WETH to raise bid above freshly-earned gain',async()=>{
  const before=await balance(weth,solver.address);
  const prevCofre=await balance(weth,cofre);
  await expectFailure(owner,atlas.address,await bid(targets(2),21n,1n));
  assert.equal(await balance(weth,solver.address),before);
  assert.equal(await balance(weth,cofre),prevCofre);
  assert.equal((await call(atlas,'calls'))[0],0n);
 });
 it('reject wrong signer, direct calls and malformed/unsupported markets',async()=>{
  await expectFailure(owner,atlas.address,await bid(targets(1),1n,1n,wrong));
  await expectFailure(wrong,solver.address,solver.iface.encodeFunctionData('executarLote',[targets(1),1n]));
  const other=await create('TokenFalso',['USDC']);
  const bad=[...market];bad[0]=other.address;
  await expectFailure(owner,atlas.address,await bid([[bad,owner,100n,0n,false,1n]],1n,1n));
  await expectFailure(owner,atlas.address,await bid(targets(0),1n,1n));
  await expectFailure(owner,atlas.address,await bid(targets(17),1n,1n));
  await expectFailure(owner,atlas.address,await bid(targets(1,11n),1n,1n));
  // Morpho callback cannot be spoofed by an external actor
  await expectFailure(wrong,solver.address,solver.iface.encodeFunctionData('onMorphoLiquidate',[100n,'0x']));
 });
 it('a failed 2nd item reverts all swaps, previous settlements and bid',async()=>{
  const initial=await balance(weth,solver.address);
  const prevMorpho=await balance(weth,morpho.address);
  const first=targets(2);
  first[1][2]=0n;first[1][3]=0n;
  await expectFailure(owner,atlas.address,await bid(first));
  assert.equal(await balance(weth,solver.address),initial);
  assert.equal(await balance(weth,morpho.address),prevMorpho);
  assert.equal((await call(atlas,'calls'))[0],0n);
 });
});
