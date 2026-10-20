/**
 * One-time deployment of the Morpho Aerodrome executor on Base. NEVER imported by
 * the scanner. Requires a stopped CACA paid signer and one-time confirmation.
 */
import fs from 'node:fs';
import path from 'node:path';
import {ContractFactory,Interface,JsonRpcProvider,Wallet,getAddress} from 'ethers';
import {ORACULO_DE_GAS_L1,codificarTetoDeL1} from './custoDaBase';
import {COFRE_ESPERADO} from './caca';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
const ROUTER='0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const AERO_FACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const ARTIFACT='.tmp/artifacts/contracts/TitanCacadorMorphoAero.sol/TitanCacadorMorphoAero.json';
const marker='/app/data/titanMorphoAeroDeploy.json';
const abi=new Interface(['function dono() view returns(address)','function cofre() view returns(address)',
 'function morpho() view returns(address)','function aerodromeFactory() view returns(address)',
 'function aerodromeRouter() view returns(address)']);
function no(m:string):never { throw Error(m); }
async function deployedInvariants(p:JsonRpcProvider,at:string,owner:string){
 if(await p.getCode(at)==='0x')no('deployed address has no code');
 for(const [method,expected] of Object.entries({dono:owner,cofre:COFRE_ESPERADO,
   morpho:MORPHO_FLASH_BASE,aerodromeFactory:AERO_FACTORY,aerodromeRouter:ROUTER})){
   const raw=await p.call({to:at,data:abi.encodeFunctionData(method)});
   const actual=abi.decodeFunctionResult(method,raw)[0] as string;
   if(getAddress(actual)!==getAddress(expected))no('immutable mismatch '+method);
 }
}
export async function implantarTitanMorphoAero(env:NodeJS.ProcessEnv=process.env):Promise<string>{
 if(env.TITAN_MORPHO_AERO_DEPLOY!=='1'
   ||env.TITAN_MORPHO_AERO_CONFIRMAR!=='IMPLANTAR_MORPHO_BASE'
   ||env.TITAN_NONCE_EXCLUSIVO!=='1'||env.CACA_ENVIAR==='1')
   no('deploy not enabled or CACA paid signer not isolated');
 const key=env.TITAN_CHAVE_PRIVADA??env.CACA_CHAVE_PRIVADA;
 const rpcUrl=env.TITAN_EXECUTOR_RPC_URL??env.CACA_RPC_URL??env.ARB_RPC_URL;
 if(!key||!rpcUrl)no('signer or RPC missing');
 const wallet=new Wallet(key);
 if(env.CACA_ENDERECO_PUBLICO && getAddress(env.CACA_ENDERECO_PUBLICO)!==wallet.address)
   no('wallet public address mismatch');
 const teto=env.TITAN_MORPHO_AERO_DEPLOY_WEI;
 if(!teto||!/^[0-9]+$/.test(teto)||BigInt(teto)<=0n||BigInt(teto)>2000000000000000n)
   no('explicit deployment gas budget <= 0.002 ETH required');
 if(fs.existsSync(marker))no('deploy marker exists; reconcile tx first, never auto retry');
 const art=JSON.parse(fs.readFileSync(ARTIFACT,'utf8')) as
   {abi:ConstructorParameters<typeof ContractFactory>[0];bytecode:string};
 if(!art.bytecode?.startsWith('0x')||art.bytecode.length<500)no('compiled artifact missing');
 const p=new JsonRpcProvider(rpcUrl,8453,{staticNetwork:true});
 try{
   if(BigInt(await p.send('eth_chainId',[]))!==8453n)no('wrong chain');
   for(const contract of [MORPHO_FLASH_BASE,AERO_FACTORY,ROUTER]){
     if(await p.getCode(contract)==='0x')no('onchain constructor address has no bytecode');
   }
   const latest=await p.getTransactionCount(wallet.address,'latest');
   const pending=await p.getTransactionCount(wallet.address,'pending');
   if(latest!==pending)no('pending nonce; CACA or TITAN still sending');
   const block=await p.getBlock('latest');
   if(!block?.baseFeePerGas||block.baseFeePerGas<=0n)no('no base fee');
   const factory=new ContractFactory(art.abi,art.bytecode,wallet.connect(p));
   const request=await factory.getDeployTransaction(MORPHO_FLASH_BASE,ROUTER,AERO_FACTORY,COFRE_ESPERADO);
   const gas=await p.estimateGas({...request,from:wallet.address});
   const gasLimit=gas+gas/5n;
   if(gasLimit>4000000n)no('deployment gas too large');
   const tip=20000000n,maxFeePerGas=block.baseFeePerGas*2n+tip;
   const l1=BigInt(await p.call({to:ORACULO_DE_GAS_L1,
     data:codificarTetoDeL1(Math.ceil((art.bytecode.length-2)/2)+500)}));
   const worst=gasLimit*maxFeePerGas+2n*l1;
   if(worst>BigInt(teto))no('deployment cost too high');
   if(await p.getBalance(wallet.address)<worst)no('wallet cannot cover worst case');
   if((await p.getTransactionCount(wallet.address,'pending'))!==pending)no('nonce changed');
   const raw=await wallet.signTransaction({...request,nonce:pending,
     chainId:8453,type:2,gasLimit,maxFeePerGas,maxPriorityFeePerGas:tip,value:0n});
   const {keccak256}=await import('ethers');
   const hash=keccak256(raw);
   // Durable reservation written BEFORE the first broadcast (ambiguity-safe).
   fs.mkdirSync(path.dirname(marker),{recursive:true});
   const fd=fs.openSync(marker,'wx',0o600);
   try{
     fs.writeFileSync(fd,JSON.stringify({status:'reserved',hash,nonce:pending,
       gasLimit:gasLimit.toString(),maxCostWei:worst.toString()}));
     fs.fsyncSync(fd);
   }finally{fs.closeSync(fd);}
   const tx=await p.broadcastTransaction(raw);
   if(tx.hash.toLowerCase()!==hash.toLowerCase())no('hash mismatch');
   const rec=await tx.wait(1,120000);
   if(!rec||rec.status!==1||!rec.contractAddress)no('missing receipt; check hash, do not retry');
   await deployedInvariants(p,rec.contractAddress,wallet.address);
   fs.writeFileSync(marker,JSON.stringify({status:'confirmed',hash,
     contract:rec.contractAddress,block:rec.blockNumber,nonce:pending}),{mode:0o600});
   return rec.contractAddress;
 }finally{p.destroy();}
}
if(require.main===module){
 void implantarTitanMorphoAero().then(x=>{
   console.log('[TITAN/MORPHO-AERO-DEPLOY] confirmed:',x);
 }).catch(e=>{
   console.error('[TITAN/MORPHO-AERO-DEPLOY] blocked:',e instanceof Error?e.message:String(e));
   process.exitCode=1;
 });
}
