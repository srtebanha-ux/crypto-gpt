const assert=require('node:assert/strict');
const hre=require('hardhat');
const {ethers}=require('ethers');
const rpc=new ethers.BrowserProvider({
 request:({method,params})=>hre.network.provider.request({method,params})
});
async function d(n,f,s,...args){
 const x=require('../.tmp/artifacts/contracts/'+f+'.sol/'+n+'.json');
 const c=await new ethers.ContractFactory(x.abi,x.bytecode,s).deploy(...args);
 await c.waitForDeployment();return c;
}
const Q=10n**18n;
const ALVO='0x00000000000000000000000000000000000000F1';
describe('TITAN: liquidacao Morpho Aave multi-hop LOCAL',function(){
 let u,ex,w,b,m,mo,av,fa,v1,v2,aero;
 async function setup(){
  u=await rpc.getSigner(0);
  b=await d('TitanTokenTeste','TitanCreditoTeste',u,'USDC');
  w=await d('TitanTokenTeste','TitanCreditoTeste',u,'WETH');
  m=await d('TitanTokenTeste','TitanCreditoTeste',u,'cbETH');
  mo=await d('TitanMorphoTeste','TitanCreditoTeste',u);
  av=await d('TitanAaveTestPool','TitanAaveTeste',u);
  fa=await d('TitanV3FactoryTest','TitanAaveTeste',u);
  v1=await d('TitanV3Teste','TitanCreditoTeste',u,w.target,m.target,11,10);
  v2=await d('TitanV3Teste','TitanCreditoTeste',u,m.target,b.target,11,10);
  aero=await d('TitanAeroMultiTeste','TitanAeroMultiTeste',u,m.target,b.target,11,10);
  ex=await d('CacadorAaveMultiHopMorpho','CacadorAaveMultiHopMorpho',u,
    u.address,av.target,mo.target,fa.target);
  await (await b.mint(mo.target,1000n*Q)).wait();
  await (await w.mint(av.target,1000n*Q)).wait();
  await (await m.mint(v1.target,1000n*Q)).wait();
  await (await b.mint(v2.target,1000n*Q)).wait();
  await (await m.mint(aero.target,1000n*Q)).wait();
  await (await b.mint(aero.target,1000n*Q)).wait();
  await (await aero.iniciar(1000n*Q,1000n*Q)).wait();
  await (await fa.registrar(w.target,m.target,500,v1.target)).wait();
  await (await fa.registrar(m.target,b.target,500,v2.target)).wait();
 }
 const caminho=()=>[[v1.target,w.target,0,500],[v2.target,m.target,0,500]];
 const params=()=>[ALVO,w.target,b.target,100n*Q,Q,caminho()];
 it('liquida, faz 2 swaps, paga Morpho e transfere apenas lucro',async()=>{
  await setup();
  await (await b.mint(ex.target,7n)).wait();
  const esperado=await ex.liquidar.staticCall(...params());
  assert.equal(esperado,100n*Q*105n/100n*11n/10n*11n/10n-100n*Q);
  const recibo=await (await ex.liquidar(...params())).wait();
  assert.equal(await b.balanceOf(mo.target),1000n*Q);
  assert.equal(await b.balanceOf(ex.target),7n);
  assert.equal(await b.balanceOf(u.address),esperado);
  console.log('multi_hop_gas='+recibo.gasUsed.toString());
 });
 it('liquida com V3 + Aerodrome autorizado e devolve Morpho',async()=>{
  await setup();
  const rota=[[v1.target,w.target,0,500],[aero.target,m.target,1,0]];
  const p=params();p[5]=rota;
  await assert.rejects(()=>ex.liquidar.staticCall(...p));
  await (await ex.autorizarPoolAero(aero.target,true)).wait();
  const lucro=await ex.liquidar.staticCall(...p);
  assert.ok(lucro>0n);
  await (await ex.liquidar(...p)).wait();
  assert.equal(await b.balanceOf(mo.target),1000n*Q);
  assert.equal(await b.balanceOf(u.address),lucro);
 });
 it('nao liquida HF saudavel e nao permite pool V3 nao registrada',async()=>{
  await setup();
  await (await av.configure(Q,105,100,true)).wait();
  await assert.rejects(()=>ex.liquidar.staticCall(...params()));
  await (await av.configure(98n*Q/100n,105,100,true)).wait();
  const p=params();p[5]=[[v1.target,w.target,0,3000],[v2.target,m.target,0,500]];
  await assert.rejects(()=>ex.liquidar.staticCall(...p));
 });
 it('rejeita reversao com lucro insuficiente e callback falso',async()=>{
  await setup();
  const p=params();p[4]=1000n*Q;
  await assert.rejects(()=>ex.liquidar.staticCall(...p));
  assert.equal(await b.balanceOf(mo.target),1000n*Q);
  await assert.rejects(()=>ex.onMorphoFlashLoan.staticCall(100n*Q,'0x'));
 });
});
