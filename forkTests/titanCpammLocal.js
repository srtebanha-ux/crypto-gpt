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
