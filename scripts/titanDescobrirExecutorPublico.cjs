// Public Base 8453 discovery only. Does not use a signer, token, or private RPC.
// Predicts only DIRECT CREATE addresses from the existing wallet's transaction nonces.
// A factory/CREATE2 deployment will not be found. Never authorize a tx from this output.
const {Interface,getCreateAddress,getAddress,keccak256}=require('ethers');
const wallet='0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const endpoints=['https://mainnet.base.org','https://base-rpc.publicnode.com'];
const abi=new Interface([
 'function dono() view returns(address)',
 'function versaoRotas() view returns(uint256)',
 'function cofre() view returns(address)',
 'function morpho() view returns(address)',
 'function routerV3() view returns(address)',
 'function fabricaV3() view returns(address)',
 'function aerodromeRouter() view returns(address)',
 'function aerodromeFactory() view returns(address)',
]);
let reqId=0;
async function rpc(url,method,params=[]){
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:++reqId,method,params}),
  signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error('rpc_unavailable');
 const body=await response.json();
 if(body.error||typeof body.result==='undefined')throw Error('rpc_unavailable');
 return body.result;
}
function noncesToInspect(count,limit=128){
 if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(limit)||limit<2)
  throw Error('invalid_count');
 if(count<=limit)return Array.from({length:count},(_,i)=>i);
 const half=Math.floor(limit/2);
 return [...Array.from({length:half},(_,i)=>i),
  ...Array.from({length:limit-half},(_,i)=>count-(limit-half)+i)];
}
async function safeMethod(url,address,method){
 try{
  const result=await rpc(url,'eth_call',[{to:address,data:abi.encodeFunctionData(method)},'latest']);
  const value=abi.decodeFunctionResult(method,result)[0];
  return typeof value==='bigint'?value.toString():getAddress(value);
 }catch{return null;}
}
async function inspectDirectDeploys(url1,url2,address,limit=128){
 const chain=await rpc(url1,'eth_chainId');
 if(BigInt(chain)!==8453n)throw Error('wrong_chain');
 const chain2=await rpc(url2,'eth_chainId').catch(()=>null);
 const secondaryValid=chain2!==null&&BigInt(chain2)===8453n;
 const count=Number(BigInt(await rpc(url1,'eth_getTransactionCount',[address,'latest'])));
 const nonces=noncesToInspect(count,limit);
 const found=[];
 const withCode=[];
 let cursor=0;
 async function worker(){
  while(cursor<nonces.length){
   const nonce=nonces[cursor++];
   const predicted=getCreateAddress({from:address,nonce});
   let code;
   try{code=await rpc(url1,'eth_getCode',[predicted,'latest']);}
   catch{continue;}
   if(!code||code==='0x')continue;
   const codeHash=keccak256(code);
   const owner=await safeMethod(url1,predicted,'dono');
   const versao=await safeMethod(url1,predicted,'versaoRotas');
   // Audit older contracts too: V1 implementations may lack versaoRotas().
   // Read every immutable before rejecting an address. Never send any tx.
   const publicImmutables={};
   for(const name of ['cofre','morpho','routerV3','fabricaV3','aerodromeRouter','aerodromeFactory'])
    publicImmutables[name]=await safeMethod(url1,predicted,name);
   const canonMorpho='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
   const canonCofre='0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
   const canonV3Factory='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
   const canonV3Router='0x2626664c2603336E57B271c5C0b26F421741e481';
   const compatV3=Boolean(owner&&owner.toLowerCase()===address.toLowerCase()
    &&publicImmutables.morpho?.toLowerCase()===canonMorpho.toLowerCase()
    &&publicImmutables.cofre?.toLowerCase()===canonCofre.toLowerCase()
    &&publicImmutables.routerV3?.toLowerCase()===canonV3Router.toLowerCase()
    &&publicImmutables.fabricaV3?.toLowerCase()===canonV3Factory.toLowerCase());
   withCode.push({nonce,address:predicted,codeHash,bytes:(code.length-2)/2,
    dono:owner,versaoRotas:versao,publicImmutables,
    parametrosCompativeisComMorphoV3:compatV3,
    candidatoMorphoReconhecido:Boolean(owner&&owner.toLowerCase()===address.toLowerCase()&&versao!==null)});
   if(!owner||owner.toLowerCase()!==address.toLowerCase()||versao===null)continue;
   let secondCode=null;
   if(secondaryValid)secondCode=await rpc(url2,'eth_getCode',[predicted,'latest']).catch(()=>null);
   const invariants={};
   for(const key of ['cofre','morpho','routerV3','fabricaV3','aerodromeRouter','aerodromeFactory'])
    invariants[key]=await safeMethod(url1,predicted,key);
   found.push({nonce,address:predicted,versaoRotas:versao,owner,
    codeHash,confirmacaoSegundoRpc:secondCode===null?'nao_obtida':
      keccak256(secondCode)===codeHash?'bytecode_igual':'bytecode_divergente',
    invariants,
    aptoParaEnvio:false});
  }
 }
 await Promise.all(Array.from({length:6},()=>worker()));
 found.sort((a,b)=>a.nonce-b.nonce);
 withCode.sort((a,b)=>a.nonce-b.nonce);
 return {chainId:8453,carteira:address,totalNoncesEOA:count,noncesLidos:nonces.length,
  coberturaCompleta:nonces.length===count,secundarioChain8453:secondaryValid,
  createDiretosComBytecode:withCode,enderecosCreateDiretos:found,aptoParaEnvio:false,
  limites:'Busca somente CREATE direto da carteira; não encontra CREATE2/factory. Métodos e codehash não substituem identidade, artefato auditado, marcador e diário.'};
}
async function main(){
 let result=null;
 // Swap public sources if the primary is temporarily unavailable.
 for(const [a,b] of [[endpoints[0],endpoints[1]],[endpoints[1],endpoints[0]]]){
  try{result=await inspectDirectDeploys(a,b,wallet);break;}
  catch{/* no RPC credentials, URL or error messages in output */}
 }
 console.log(JSON.stringify(result??{carteira:wallet,status:'rpc_publico_indisponivel',
  aptoParaEnvio:false},null,2));
}
if(require.main===module)void main().catch(()=>{process.exitCode=1;});
module.exports={noncesToInspect,inspectDirectDeploys};
