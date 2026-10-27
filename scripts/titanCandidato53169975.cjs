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
function classeRevertPublica(error){
 // Read only public RPC revert data, not its raw error message or URL.
 // A provider may nest eth_call error.data inside multiple RPC wrappers.
 const candidates=[error?.data,error?.error?.data,error?.info?.error?.data,
  error?.info?.error?.error?.data,error?.error?.error?.data];
 for(const x of candidates){
  const data=typeof x==='string'?x:typeof x?.data==='string'?x.data:null;
  if(data&&/^0x(?:[0-9a-f]{2})+$/i.test(data)&&data.length>=10){
   const selector=data.slice(0,10).toLowerCase();
   if(selector==='0x08c379a0'){
    try{
     const reason=AbiCoder.defaultAbiCoder().decode(['string'],'0x'+data.slice(10))[0];
     // This string comes from EVM Error(string), not from an RPC exception:
     // it is public revert data. Bound printable text and never publish
     // arbitrary provider errors (which may include private RPC URLs).
     const safe=typeof reason==='string'&&reason.length<=160
       &&/^[\x20-\x7e]+$/.test(reason)?reason:null;
     return {tipo:reason==='position is healthy'?'saudavel_no_liquidate':
       'revert_com_mensagem',selector,razaoPublica:safe};
    }catch{}
   }
   return {tipo:'revert_sem_classificacao',selector,razaoPublica:null};
  }
 }
 return {tipo:'sem_revert_decodificavel',selector:null,razaoPublica:null};
}
function classificarRevert(error){
 const d=classeRevertPublica(error);
 return d.tipo==='saudavel_no_liquidate'?d.tipo:'inconclusiva';
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
 let diagnosticoRevert=null;
 if(position.borrowShares>0n){
  // liquidate accrues interest itself. One share tests its real eligibility gate;
  // a repayment failure remains inconclusive, never a claimed successful route.
  try{
   const result=await rpc('eth_call',[{from:candidato.usuario,to:MORPHO_FLASH_BASE,
    data:abi.encodeFunctionData('liquidate',[tuple,candidato.usuario,0n,1n,'0x'])},tag]);
   abi.decodeFunctionResult('liquidate',result);
   elegibilidade='uma_share_liquidavel_em_eth_call';
  }catch(e){elegibilidade=classificarRevert(e);
   diagnosticoRevert=classeRevertPublica(e);}
 }
 if((await rpc('eth_getBlockByNumber',[tag,false]))?.hash!==block.hash)throw Error('bloco mudou durante leituras');
 return {somenteLeitura:true,...candidato,blockHash:block.hash,timestamp:block.timestamp,
  params:{...params,lltv:params.lltv.toFixed()},position,market,price,risco,elegibilidade,diagnosticoRevert,
  executorPronto:false,lucroComprovado:false,
  limite:'Sonda direta Morpho; nao substitui o preflight integral do executor V3.'};
}
module.exports={candidato,classificarRevert,classeRevertPublica,investigar};
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
