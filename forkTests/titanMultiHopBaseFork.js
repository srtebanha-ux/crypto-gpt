/**
 * Fork da Base com Aave V3, Morpho Blue, ERC20 e Uniswap V3 REAIS.
 * Transacoes e alteracao temporaria do oraculo acontecem SOMENTE no fork local.
 * Pino ARB_BLOCO=52418045: bloco historico onde havia posicao real elegivel.
 */
const assert=require('node:assert/strict');
const hre=require('hardhat');
const {ethers}=require('ethers');
const p=hre.network.provider;
const rpc=new ethers.BrowserProvider({request:({method,params})=>p.request({method,params})});
const AAVE='0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH='0x4200000000000000000000000000000000000006';
const ALVO='0x66bb6c2949b20503adf3621db9903ee52f92ffb5';
const COFRE='0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const poolABI=new ethers.Interface([
 'function ADDRESSES_PROVIDER() view returns(address)',
 'function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)',
]);
const apABI=new ethers.Interface(['function getPriceOracle() view returns(address)']);
const oracleABI=new ethers.Interface([
 'function getSourceOfAsset(address) view returns(address)',
 'function getAssetPrice(address) view returns(uint256)',
]);
const ercABI=new ethers.Interface(['function balanceOf(address) view returns(uint256)']);
const facABI=new ethers.Interface(['function getPool(address,address,uint24) view returns(address)']);
const call=async(to,i,n,args=[])=>{
 const d=await p.send('eth_call',[{to,data:i.encodeFunctionData(n,args)},'latest']);
 return i.decodeFunctionResult(n,d)[0];
};
describe('TITAN: Aave/Morpho/Uniswap Base FORK REAL (nenhuma tx na mainnet)',function(){
 this.timeout(900000);
 it('liquida alvo real com flash loan Morpho, swap V3 e cofre efetivo',async function(){
   assert.equal(Number(BigInt(await p.send('eth_chainId',[]))),8453);
   const number=parseInt(await p.send('eth_blockNumber',[]),16);
   assert.equal(number,52418045,'teste reproduz um bloco historico conhecido; nao aproximar');
   for(const c of [AAVE,MORPHO,FACTORY,USDC,WETH])
      assert.notEqual(await p.send('eth_getCode',[c,'latest']),'0x',c+' ausente');
   const factory=new ethers.Contract(FACTORY,facABI,rpc);
   let pool=null,fee=0;
   for(const f of [500,3000,10000]){
     const x=await factory.getPool(WETH,USDC,f);
     if(x!==ethers.ZeroAddress && (await p.send('eth_getCode',[x,'latest']))!=='0x'){
       pool=x;fee=f;break;
     }
   }
   assert.ok(pool,'sem pool Uniswap V3 real WETH/USDC');
   const prov=await call(AAVE,poolABI,'ADDRESSES_PROVIDER');
   const oracle=await call(prov,apABI,'getPriceOracle');
   const sourceWeth=await call(oracle,oracleABI,'getSourceOfAsset',[WETH]);
   const price=await call(oracle,oracleABI,'getAssetPrice',[WETH]);
   assert.ok(price>0n);
   const before=await call(AAVE,poolABI,'getUserAccountData',[ALVO]);
   assert.ok(before[5]>0n,'alvo inexistente no snapshot');
   const artOracle=await hre.artifacts.readArtifact('OraculoFalso');
   const [admin]=await p.send('eth_accounts',[]);
   await p.send('hardhat_setBalance',[admin,'0x'+(10n**20n).toString(16)]);
   const fake=await p.send('eth_sendTransaction',[{from:admin,data:artOracle.bytecode,gas:'0x800000'}]);
   const fakeReceipt=await p.send('eth_getTransactionReceipt',[fake]);
   const runtime=await p.send('eth_getCode',[fakeReceipt.contractAddress,'latest']);
   await p.send('hardhat_setCode',[sourceWeth,runtime]);
   let hf=before[5],newPrice=price;
   for(let step=1;step<=75 && hf>=10n**18n;step++){
     newPrice=price*BigInt(1000-step*5)/1000n;
     await p.send('hardhat_setStorageAt',[sourceWeth,'0x0','0x'+newPrice.toString(16).padStart(64,'0')]);
     hf=(await p.send('eth_call',[{to:AAVE,data:poolABI.encodeFunctionData('getUserAccountData',[ALVO])},'latest']));
     hf=poolABI.decodeFunctionResult('getUserAccountData',hf)[5];
   }
   assert.ok(hf<10n**18n,'oraculo alterado so no fork nao levou HF abaixo de 1');
   const liquidacaoArt=await hre.artifacts.readArtifact('CacadorAaveMultiHopMorpho');
   const signer=await rpc.getSigner(0);
   const contrato=await new ethers.ContractFactory(liquidacaoArt.abi,liquidacaoArt.bytecode,signer)
      .deploy(COFRE,AAVE,MORPHO,FACTORY);
   await contrato.waitForDeployment();
   const disponivelMorpho=await call(USDC,ercABI,'balanceOf',[MORPHO]);
   assert.ok(disponivelMorpho>=1_000_000_000n,'sem 1000 USDC no Morpho do snapshot');
   const cobrir=1_000_000_000n; // 1000 USDC, abaixo do teto de cobertura Aave
   const rota=[[pool,WETH,0,fee]];
   const antesCofre=await call(USDC,ercABI,'balanceOf',[COFRE]);
   const lucroSimulado=await contrato.liquidar.staticCall(ALVO,WETH,USDC,cobrir,1n,rota);
   assert.ok(lucroSimulado>0n,'liquidacao sem lucro no mesmo fork');
   const recibo=await (await contrato.liquidar(ALVO,WETH,USDC,cobrir,1n,rota)).wait();
   assert.equal(recibo.status,1);
   const depoisCofre=await call(USDC,ercABI,'balanceOf',[COFRE]);
   assert.equal(depoisCofre-antesCofre,lucroSimulado,
      'lucro deve realmente chegar ao cofre, em unidades USDC 6 casas');
   assert.ok(recibo.gasUsed>0n);
   console.log(JSON.stringify({forkBlock:number,uniswapPool:pool,fee,healthFactor: hf.toString(),
       lucroUSDC6:lucroSimulado.toString(),gasL2:recibo.gasUsed.toString(),realMainnetBroadcast:false}));
 });
});
