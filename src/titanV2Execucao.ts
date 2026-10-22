/**
 * FlashArb V2 paid execution. Strictly separate from read-only virtual probes.
 * Activation needs a deployed contract, explicit flags, live EVM profit proof,
 * nonce quorum, conservative gas budget and durable one-shot accounting.
 */
import fs from 'node:fs';
import {ocultarSegredos} from './logger';
import {Interface,JsonRpcProvider,Wallet,getAddress,keccak256} from 'ethers';
import {pisoConservadorV2,correspondeFlashArb,WETH_BASE,type CandidatoV2Prova} from './titanV2Prova';
import {ORACULO_DE_GAS_L1} from './custoDaBase';
import {conferirJanelaDeNonce} from './janelaDeNonce';
import {impedimentoTitanContinuo,reservarTitanContinuo,fecharTitanContinuo} from './titanAutorizacaoContinua';

const i=new Interface([
 'function owner() view returns(address)',
 'function executarArbitragem(address,address,address,uint256,uint256)',
 'function balanceOf(address) view returns(uint256)',
 'function getL1Fee(bytes) view returns(uint256)',
]);
type Artifact={runtime:string;creation:string;
 ownerReferences:Array<{start:number;length:number}>};
export type ResultadoV2Pago={status:'desligado'|'recusado'|'enviado'|'confirmado'|'revertido'|'desconhecido';
 motivo:string;hash?:string;lucroWei?:string;gasL2Wei?:string;gasL1Wei?:string;};

export function habilitacaoV2(env:NodeJS.ProcessEnv):string|null{
 if(env.TITAN_V2_ENVIAR!=='1'||env.TITAN_ENVIAR!=='1'
   ||env.TITAN_V2_CONFIRMAR!=='OPERAR_BASE_REAL')
    return 'TITAN V2 desativado: exige tres autorizacoes explicitas';
 if(env.TITAN_AUTORIZACAO_CONTINUA!=='1'
   ||env.TITAN_NONCE_EXCLUSIVO!=='1'||env.TITAN_VALIDAR_AO_VIVO!=='1')
    return 'sem diario de gas, exclusividade de nonce ou prova atomica';
 if(!env.TITAN_V2_CONTRATO || !env.TITAN_CHAVE_PRIVADA
   || !env.TITAN_ORCAMENTO_GAS_WEI)
    return 'executor V2 implantado, carteira ou teto de gas ausente';
 return null;
}
/** Read-only contract preflight at boot: never sends or signs. */
export async function diagnosticarFlashArbV2(
 rpcUrl:string,env:NodeJS.ProcessEnv=process.env,
):Promise<{pronto:boolean;motivo:string}> {
 if(!env.TITAN_V2_CONTRATO||!env.TITAN_CHAVE_PRIVADA)
   return {pronto:false,motivo:'contrato ou identidade do executor nao configurados'};
 let rpc:JsonRpcProvider|undefined;
 try {
   const wallet=new Wallet(env.TITAN_CHAVE_PRIVADA);
   const contrato=getAddress(env.TITAN_V2_CONTRATO);
   const arquivo=JSON.parse(fs.readFileSync('.tmp/artifacts/FlashArbProva.json','utf8')) as Artifact;
   rpc=new JsonRpcProvider(rpcUrl,8453,{staticNetwork:true});
   if(BigInt(await rpc.send('eth_chainId',[]))!==8453n)
     return {pronto:false,motivo:'RPC nao aponta para Base 8453'};
   const codigo=await rpc.getCode(contrato);
   if(codigo==='0x')
     return {pronto:false,motivo:'endereco sem bytecode na Base'};
   if(!correspondeFlashArb(codigo,arquivo,wallet.address))
     return {pronto:false,motivo:'bytecode onchain nao corresponde ao FlashArb do executor'};
   const dono=i.decodeFunctionResult('owner',await rpc.call({
     to:contrato,data:i.encodeFunctionData('owner'),
   }))[0] as string;
   if(getAddress(dono)!==wallet.address)
     return {pronto:false,motivo:'owner do contrato e carteira do TITAN sao diferentes'};
   return {pronto:true,motivo:'Base 8453, bytecode exato e owner correspondem; nao e prova de lucro'};
 }catch(e) {
   return {pronto:false,motivo:'auditoria de implantacao: '+ocultarSegredos(e instanceof Error?e.message.slice(0,240):'falha desconhecida',env)};
 }finally {rpc?.destroy()}
}

export async function executarFlashArbV2(
 c:CandidatoV2Prova,rpcUrl:string,env:NodeJS.ProcessEnv=process.env,
):Promise<ResultadoV2Pago>{
 const recusa=habilitacaoV2(env);
 if(recusa)return{status:'desligado',motivo:recusa};
 if(c.U.toLowerCase()!==WETH_BASE.toLowerCase()||c.quantia<=0n
   ||c.emprestimo.endereco.toLowerCase()===c.venda.endereco.toLowerCase())
    return{status:'recusado',motivo:'rota V2 nao comparavel em WETH ou invalida'};
 let rpc:JsonRpcProvider|undefined,hash:string|undefined;
 try{
   const wallet=new Wallet(env.TITAN_CHAVE_PRIVADA!);
   const contrato=getAddress(env.TITAN_V2_CONTRATO!);
   const arquivo=JSON.parse(fs.readFileSync('.tmp/artifacts/FlashArbProva.json','utf8')) as Artifact;
   rpc=new JsonRpcProvider(rpcUrl,8453,{staticNetwork:true});
   if(BigInt(await rpc.send('eth_chainId',[]))!==8453n)
     throw Error('RPC nao e Base');
   const onchain=await rpc.getCode(contrato);
   if(!correspondeFlashArb(onchain,arquivo,wallet.address))
     throw Error('bytecode do FlashArb V2 diverge do solc e owner imutavel');
   const dono= i.decodeFunctionResult('owner',await rpc.call({
     to:contrato,data:i.encodeFunctionData('owner')}))[0] as string;
   if(getAddress(dono)!==wallet.address)throw Error('carteira nao dona do FlashArb');
   const janela=await conferirJanelaDeNonce(rpc,wallet.address,
      env.TITAN_SOLO_24H==='1'?'TITAN_SOLO':'TITAN');
   if(!janela.pode)return{status:'recusado',motivo:janela.motivo};
   const ultimo=await rpc.getBlock('latest');
   if(!ultimo?.baseFeePerGas || !janela.bloco || ultimo.number-janela.bloco>3)
     throw Error('Base stale ou baseFee ausente');
   const nonce=janela.nonce!;
   const emprestimo=getAddress(c.emprestimo.endereco);
   const venda=getAddress(c.venda.endereco);
   const token=getAddress(c.T);
   const saldoData=i.encodeFunctionData('balanceOf',[contrato]);
   const antes=BigInt(await rpc.call({to:WETH_BASE,data:saldoData}));
   const dadosZero=i.encodeFunctionData('executarArbitragem',
      [emprestimo,venda,token,c.quantia,antes+1n]);
   const trial={to:contrato,from:wallet.address,data:dadosZero};
   await rpc.call(trial); // REAL executor, complete callback: do not trust virtual proof
   const gasEstimado=await rpc.estimateGas(trial);
   const gorjeta=BigInt(env.TITAN_GORJETA_WEI??'20000000');
   const gasLimit=gasEstimado+gasEstimado/5n;
   const maxFee=2n*ultimo.baseFeePerGas+gorjeta;
   const assinadaProvisorio=await wallet.signTransaction({
      chainId:8453,type:2,nonce,to:contrato,data:dadosZero,
      gasLimit,maxFeePerGas:maxFee,maxPriorityFeePerGas:gorjeta,value:0n,
   });
   const l1Data=i.encodeFunctionData('getL1Fee',[assinadaProvisorio]);
   const l1Wei=BigInt(i.decodeFunctionResult('getL1Fee',await rpc.call({
     to:ORACULO_DE_GAS_L1,data:l1Data}))[0]);
   const politica=pisoConservadorV2(gasEstimado,
      BigInt(env.TITAN_GAS_MAX??'650000'),ultimo.baseFeePerGas,gorjeta,
      l1Wei,BigInt(env.TITAN_ORCAMENTO_GAS_WEI!),env);
   if((await rpc.getBalance(wallet.address))<politica.custo)
     return{status:'recusado',motivo:'saldo ETH insuficiente para o gas maximo'};
   const dia=impedimentoTitanContinuo(env,politica.custo);
   if(dia)return{status:'recusado',motivo:dia};
   const data=i.encodeFunctionData('executarArbitragem',
      [emprestimo,venda,token,c.quantia,antes+politica.piso]);
   const simBlock=await rpc.getBlockNumber();
   await rpc.call({to:contrato,from:wallet.address,data}); // revenue floor enforced on-chain
   if((await rpc.getBlockNumber())!==simBlock)
     return{status:'recusado',motivo:'bloco mudou na simulacao final'};
   const janela2=await conferirJanelaDeNonce(rpc,wallet.address,
      env.TITAN_SOLO_24H==='1'?'TITAN_SOLO':'TITAN');
   if(!janela2.pode||janela2.nonce!==nonce)
     return{status:'recusado',motivo:'janela/nonce mudou antes da assinatura'};
   const txAssinada=await wallet.signTransaction({
      chainId:8453,type:2,nonce,to:contrato,data,gasLimit:politica.gasLimite,
      maxFeePerGas:maxFee,maxPriorityFeePerGas:gorjeta,value:0n,
   });
   hash=keccak256(txAssinada);
   // Reserve BEFORE broadcast. A crash/timeout keeps the hash pending,
   // preventing double transmission and require manual reconciliation.
   reservarTitanContinuo(env,hash,politica.custo);
   const tx=await rpc.broadcastTransaction(txAssinada);
   if(tx.hash.toLowerCase()!==hash.toLowerCase())
     throw Error('hash de envio nao coincide com assinatura');
   const receipt=await tx.wait(1,60000);
   if(!receipt)return{status:'enviado',hash,motivo:'sem recibo; NAO repetir'};
   const depois=BigInt(await rpc.call({to:WETH_BASE,data:saldoData}));
   const lucro=depois>antes?depois-antes:0n;
   const gasL2=receipt.gasUsed*receipt.gasPrice;
   fecharTitanContinuo(env,hash,receipt.status===1?'confirmado':'revertido',
     gasL2,receipt.status===1?lucro:undefined);
   return{status:receipt.status===1?'confirmado':'revertido',hash,
      motivo:receipt.status===1
       ? 'recibo status=1; compare lucro WETH com custo L1+L2'
       : 'transacao revertida; circuito interrompido',
      lucroWei:lucro.toString(),gasL2Wei:gasL2.toString(),
      gasL1Wei:l1Wei.toString()};
 }catch(e){
   return{status:hash?'desconhecido':'recusado',hash,
     motivo:hash?'hash reservado ou transmitido: reconciliar, NAO reenviar':
       ocultarSegredos(e instanceof Error?e.message.slice(0,260):'falha nao identificada',env)};
 }finally{rpc?.destroy()}
}
