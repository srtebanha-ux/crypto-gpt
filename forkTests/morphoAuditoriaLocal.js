/* Regression for the TITAN/Morpho contract. Uses local Hardhat only; no Base RPC. */
const assert=require('node:assert/strict');
const {Interface}=require('ethers');

describe('TITAN Morpho: confronto com executor open-source da Base',function(){
 this.timeout(120000);
 let p,owner,cofre,estranho;
 async function tx(from,to,data){
  const r=await p.send('eth_sendTransaction',[{
   from,...to?{to}:{},data,gas:'0x7a1200',
  }]);
  const receipt=await p.send('eth_getTransactionReceipt',[r]);
  assert.equal(receipt?.status,'0x1');
  return receipt;
 }
 async function deploy(name,args=[]){
  const artifact=await hre.artifacts.readArtifact(name);
  const iface=new Interface(artifact.abi);
  const receipt=await tx(owner,null,artifact.bytecode+iface.encodeDeploy(args).slice(2));
  assert.match(receipt.contractAddress,/^0x[a-fA-F0-9]{40}$/);
  return{address:receipt.contractAddress,iface};
 }
 async function send(from,c,name,args){
  return tx(from,c.address,c.iface.encodeFunctionData(name,args));
 }
 async function balance(c,account){
  const hex=await p.send('eth_call',[{
   from:owner,to:c.address,data:c.iface.encodeFunctionData('balanceOf',[account]),
  },'latest']);
  return BigInt(hex);
 }
 beforeEach(async function(){
  p=hre.network.provider;
  [owner,estranho,,cofre]=await p.send('eth_accounts',[]);
 });
 it('a liquidacao so paga o lucro NOVO; nao consome saldo antigo',async function(){
  const divida=await deploy('TokenFalso',['USDC']);
  const garantia=await deploy('TokenFalso',['WETH']);
  const morpho=await deploy('MorphoAuditoriaFalso');
  const router=await deploy('RoteadorAerodromeFalso');
  const hunter=await deploy('CacadorMorpho',[morpho.address,router.address,owner,cofre]);

  await send(owner,divida,'criar',[router.address,1000n]);
  await send(owner,garantia,'criar',[morpho.address,1000n]);
  await send(owner,divida,'criar',[hunter.address,25n]);
  await send(owner,garantia,'criar',[hunter.address,7n]);
  const params=[divida.address,garantia.address,owner,owner,625000000000000000n];
  const beforeVault=await balance(divida,cofre);
  await send(owner,hunter,'cacar',[
   params,estranho,100n,0n,owner,false,10n,
  ]);
  assert.equal(await balance(divida,cofre)-beforeVault,10n,'cofre recebe APENAS 10 de novo lucro');
  assert.equal(await balance(divida,hunter.address),25n,'os 25 anteriores continuam intocados');
  assert.equal(await balance(garantia,hunter.address),7n,'os 7 anteriores nao entraram no swap');
  assert.equal(await balance(divida,morpho.address),100n,'Morpho recebeu o repay');

  await assert.rejects(()=>send(owner,hunter,'cacar',[
   params,estranho,100n,0n,owner,false,11n,
  ]),'piso acima de lucro REAL deve reverter sem usar dinheiro antigo');
  assert.equal(await balance(divida,cofre)-beforeVault,10n,'revert nao gera lucro fantasma');
 });
 it('token transferindo false nao registra saque como se tivesse pago',async function(){
  const falso=await deploy('ERC20RetornoFalsoTeste');
  const morpho=await deploy('MorphoAuditoriaFalso');
  const router=await deploy('RoteadorAerodromeFalso');
  const hunter=await deploy('CacadorMorpho',[morpho.address,router.address,owner,cofre]);
  await send(owner,falso,'criar',[hunter.address,33n]);
  await assert.rejects(()=>send(owner,hunter,'resgatar',[falso.address]),
   'um token que retorna false nao pode ser tratado como transferencia bem sucedida');
  assert.equal(await balance(falso,hunter.address),33n);
  await assert.rejects(()=>send(estranho,hunter,'resgatar',[falso.address]),
   'terceiros nao podem varrer cofres');
  const cb=new Interface(['function onMorphoLiquidate(uint256,bytes)']);
  await assert.rejects(()=>tx(estranho,hunter.address,
   cb.encodeFunctionData('onMorphoLiquidate',[1n,'0x'])),
   'callback nao autorizado deve reverter');
 });
});
