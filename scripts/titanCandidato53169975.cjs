// One public historical candidate; read-only, no signer, deploy or state override.
const {Interface,AbiCoder,keccak256}=require('ethers');
const {ProviderMorphoRpc}=require('../dist/morphoProvider');
const {MORPHO_FLASH_BASE}=require('../dist/titanPonteMultiHop');
const {codificarIdToMarketParams,codificarPosition,codificarMarket,
 lerIdToMarketParams,lerPosition,lerMarket}=require('../dist/morphoApi');
const {examinarSaudeMorpho}=require('../dist/titanMorphoRadar');
const candidato={mercado:'0x8138047cee79f3f79c35d50e2c296f6f24e6789f38c255c67125d0de43968faa',
 usuario:'0x73c2bcce6a57ea75b6f4450a13be23586baa6ef0',bloco:53169975};
const tag='0x'+candidato.bloco.toString(16);
const abi=new Interface(['function price() view returns(uint256)',
 'function liquidate((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),address,uint256,uint256,bytes) returns(uint256 seizedAssets,uint256 repaidAssets)']);
function classificarRevert(error){
 const data=error?.data??error?.error?.data??error?.info?.error?.data;
 try{
  const decoded=abi.parseError(data);
  if(decoded?.name==='Error'&&decoded.args[0]==='position is healthy')return 'saudavel_no_liquidate';
 }catch{}
 return 'inconclusiva'; // Repayment/callback/provider failure does not prove eligibility.
}
async function investigar(rpc){
 if(BigInt(await rpc('eth_chainId',[]))!==8453n)throw Error('rede diferente da Base');
 const block=await rpc('eth_getBlockByNumber',[tag,false]);
 if(!block?.hash||BigInt(block.number)!==BigInt(candidato.bloco))throw Error('bloco historico ausente');
 const call=(to,data)=>rpc('eth_call',[{to,data},tag]);
 const params=lerIdToMarketParams(await call(MORPHO_FLASH_BASE,codificarIdToMarketParams(candidato.mercado)));
 if(!params)throw Error('parametros historicos ausentes');
 const tuple=[params.loanToken,params.collateralToken,params.oracle,params.irm,
  BigInt(params.lltv.mul('1e18').toFixed(0))];
 const id=keccak256(AbiCoder.defaultAbiCoder().encode(['address','address','address','address','uint256'],tuple));
 if(id!==candidato.mercado)throw Error('parametros divergem do id do mercado');
 const position=lerPosition(await call(MORPHO_FLASH_BASE,codificarPosition(candidato.mercado,candidato.usuario)));
 const market=lerMarket(await call(MORPHO_FLASH_BASE,codificarMarket(candidato.mercado)));
 const price=abi.decodeFunctionResult('price',await call(params.oracle,abi.encodeFunctionData('price')))[0];
 if(!position||!market)throw Error('snapshot historico incompleto');
 const risco=examinarSaudeMorpho({...position,...market,precoOracle:price,lltvWad:tuple[4]});
 let elegibilidade=position.borrowShares===0n?'sem_divida':'inconclusiva';
 if(position.borrowShares>0n){
  // liquidate accrues interest itself. One share tests its real eligibility gate;
  // a repayment failure remains inconclusive, never a claimed successful route.
  try{
   const result=await rpc('eth_call',[{from:candidato.usuario,to:MORPHO_FLASH_BASE,
    data:abi.encodeFunctionData('liquidate',[tuple,candidato.usuario,0n,1n,'0x'])},tag]);
   abi.decodeFunctionResult('liquidate',result);
   elegibilidade='uma_share_liquidavel_em_eth_call';
  }catch(e){elegibilidade=classificarRevert(e);}
 }
 if((await rpc('eth_getBlockByNumber',[tag,false]))?.hash!==block.hash)throw Error('bloco mudou durante leituras');
 return {somenteLeitura:true,...candidato,blockHash:block.hash,timestamp:block.timestamp,
  params:{...params,lltv:params.lltv.toFixed()},position,market,price,risco,elegibilidade,
  executorPronto:false,lucroComprovado:false,
  limite:'Sonda direta Morpho; nao substitui o preflight integral do executor V3.'};
}
module.exports={candidato,classificarRevert,investigar};
if(require.main===module){
 const url=process.env.BASE_FORK_RPC_URL??process.env.MEGAZORD_RPC_URL;
 if(!url){console.error('Defina BASE_FORK_RPC_URL com acesso de arquivo; nenhuma consulta executada.');process.exitCode=1;}
 else{
  const p=new ProviderMorphoRpc(url,AbortSignal.timeout(45000));
  void investigar((m,a)=>p.send(m,a)).then(r=>console.log(JSON.stringify(r,(_,v)=>typeof v==='bigint'?v.toString():v,2)))
   .catch(()=>{console.error('Consulta historica bloqueada/incompleta. Elegibilidade NAO determinada; nenhum envio.');process.exitCode=1;})
   .finally(()=>p.destroy());
 }
}
