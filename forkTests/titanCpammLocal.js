require('ts-node/register');
const assert=require('node:assert/strict');
const {Interface,keccak256}=require('ethers');
const {prepararCpammAtomico,WETH_BASE_CPAMM}=require('../src/titanCpammAtomico');
const {estimarTamanhoCicloCpamm,saidaCpamm}=require('../src/titanTamanhoCpamm');
const {montarCalldata}=require('../src/flashArbExecutor');
const WETH=WETH_BASE_CPAMM,ORACLE='0x420000000000000000000000000000000000000F',U=10n**18n;
describe('TITAN CPAMM: simulação real na EVM local, sem broadcast na Base',function(){
 this.timeout(120000);
 let p,owner,alt,pairs,executor,config;
 const rpc=(method,params)=>p.send(method,params);
 async function tx(to,data){
  const h=await rpc('eth_sendTransaction',[{from:owner,...(to?{to}:{}),data,gas:'0xb71b00'}]);
  const r=await rpc('eth_getTransactionReceipt',[h]);assert.equal(r.status,'0x1');return r;
 }
 async function deploy(name,args=[]){
  const a=await hre.artifacts.readArtifact(name);const abi=new Interface(a.abi);
  const r=await tx(null,a.bytecode+abi.encodeDeploy(args).slice(2));return{address:r.contractAddress,abi};
 }
 async function send(c,name,args=[]){return tx(c.address,c.abi.encodeFunctionData(name,args));}
 async function read(c,name,args=[]){return c.abi.decodeFunctionResult(name,await rpc('eth_call',[{to:c.address,data:c.abi.encodeFunctionData(name,args)},'latest']));}
 beforeEach(async()=>{
  p=hre.network.provider;await rpc('hardhat_reset',[]);[owner]=await rpc('eth_accounts',[]);
  const template=await deploy('TokenCpammTeste');
  await rpc('hardhat_setCode',[WETH,await rpc('eth_getCode',[template.address,'latest'])]);
  const oracle=await deploy('OracleL1CpammTeste');
  await rpc('hardhat_setCode',[ORACLE,await rpc('eth_getCode',[oracle.address,'latest'])]);
  const weth={address:WETH,abi:template.abi};alt=await deploy('TokenCpammTeste');
  const factories=[];pairs=[];
  for(let i=0;i<2;i++){
   const f=await deploy('FactoryCpammTeste');await send(f,'criar',[WETH,alt.address]);
   const pair=(await read(f,'pair'))[0];pairs.push(pair);
   await send(weth,'mint',[pair,(i===0?100n:110n)*U]);await send(alt,'mint',[pair,300000n*U]);
   const artifact=await hre.artifacts.readArtifact('ParCpammTeste');
   await send({address:pair,abi:new Interface(artifact.abi)},'sync');
   factories.push({endereco:f.address,poolCodeHash:keccak256(await rpc('eth_getCode',[pair,'latest'])),taxaNumerador:997,taxaDenominador:1000});
  }
  executor=await deploy('FlashArb');config={executor:executor.address,
   executorCodeHash:keccak256(await rpc('eth_getCode',[executor.address,'latest'])),factories,minimoLiquidoWei:1000000000000n};
 });
 it('a semente inteira vira simulação de empréstimo, swaps, repay e piso líquido',async()=>{
  const r=await prepararCpammAtomico(rpc,config,pairs,WETH,8n*U);
  assert.ok(r,'a execução CPAMM lucrativa deve passar na EVM');assert.equal(r.etapa,'simulada');
  assert.ok(r.lucroMinimoWei>0n);assert.ok(r.custoMaximoWei>0n);
  assert.equal((await read(alt,'balanceOf',[executor.address]))[0],0n,'eth_call não altera saldos');
 });
 it('candidato passa na prova, emissor unico transmite na EVM e reconcilia recibo',async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {BrowserProvider,Wallet}=require('ethers');
  const {ExecutorMegazord}=require('../src/megazordExecutor');
  const {lucroWethDoRecibo}=require('../src/titanReciboEconomico');
  const wallet=Wallet.fromPhrase('test test test test test test test test test test test junk');
  assert.equal(wallet.address.toLowerCase(),owner.toLowerCase());
  const a=new BrowserProvider(p,undefined,{cacheTimeout:-1});
  const b=new BrowserProvider(p,undefined,{cacheTimeout:-1});
  a.pollingInterval=b.pollingInterval=10;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cpamm-emissor-'));
  const journal=path.join(dir,'journal.json');let emitter;
  try{
   emitter=new ExecutorMegazord(wallet.privateKey,a,b,{journal,
    maxDailyWei:U,maxPerTxWei:U,maxDailyTx:1,contracts:[executor.address],
    canaryUntilMs:Date.now()+60000},async()=>1000000000n);
   await emitter.run('cpamm-canario-local',async()=>{
    const offer=await prepararCpammAtomico(rpc,config,pairs,WETH,8n*U);
    assert.ok(offer);assert.equal(offer.etapa,'simulada');
    const nonce=await a.getTransactionCount(owner,'pending');
    const gasPrice=BigInt(await rpc('eth_gasPrice',[]));
    const prepared={chainId:8453,type:2,nonce,to:offer.contrato,data:offer.calldata,
     gasLimit:offer.gasLimit,maxFeePerGas:gasPrice,maxPriorityFeePerGas:gasPrice,value:0n};
    await a.call({...prepared,from:owner});
    const sent=await emitter.broadcast(await emitter.sign(prepared));
    const receipt=await sent.wait();assert.equal(receipt.status,1);
    const result=lucroWethDoRecibo(executor.address,receipt.status,receipt.logs,
     receipt.gasUsed*receipt.gasPrice,null);
    assert.ok(result.brutoWei>0n);assert.equal(result.liquidoWei,null,'EVM local nao tem taxa L1 real');
    await emitter.reconcile();
    const saved=JSON.parse(fs.readFileSync(journal,'utf8'));
    assert.equal(saved.pending,null);assert.equal(saved.receipts[0].hash,sent.hash);
    assert.equal(saved.receipts[0].nonce,nonce);
   });
  }finally{emitter?.close();a.destroy();b.destroy();fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('reproduz margem teórica positiva que reverte em K por fee-on-transfer',async()=>{
  await send(alt,'taxar',[pairs[1]]);
  const first={reservaEntrada:100n*U,reservaSaida:300000n*U,taxaNumerador:997n,taxaDenominador:1000n};
  const second={...first,reservaEntrada:300000n*U,reservaSaida:110n*U};
  const seed=estimarTamanhoCicloCpamm(first,second,8n*U);assert.ok(seed.lucroTeoricoAntesGas>0n);
  const calldata=montarCalldata({poolEmprestimo:pairs[0],poolVenda:pairs[1],tokenEmprestado:alt.address,
   quantidade:saidaCpamm(first,seed.tamanhoSugerido),lucroMinimo:1n});
  await assert.rejects(rpc('eth_call',[{from:owner,to:executor.address,data:calldata},'latest']),/UniswapV2: K/);
  assert.equal(await prepararCpammAtomico(rpc,config,pairs,WETH,8n*U),null);
 });
 it('saldo anterior do ALT não pode subsidiar pagamento insuficiente',async()=>{
  await send(alt,'mint',[executor.address,U]);
  await assert.rejects(prepararCpammAtomico(rpc,config,pairs,WETH,8n*U),/Saldo prévio/);
  assert.equal((await read(alt,'balanceOf',[executor.address]))[0],U);
 });
});
