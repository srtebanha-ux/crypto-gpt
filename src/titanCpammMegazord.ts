/** Adaptador do scanner Megazord para CPAMM: sem Wallet nem broadcaster paralelo. */
import {JsonRpcProvider} from 'ethers';
import {prepararCpammAtomico,type OfertaCpammAtomica} from './titanCpammAtomico';
import {comExecutorMegazord,executorMegazordInstalado} from './megazordExecutor';
import {executarFlashArbV2,habilitacaoV2,type ResultadoV2Pago} from './titanV2Execucao';
import {lerRiscoEconomico,margemLiquidaDinamica} from './titanRiscoEconomico';
import type {Candidato} from './cacarArbitragem';
export type ResultadoCpammMegazord=ResultadoV2Pago|{status:'simulada';motivo:string};
type Deps={ativo:()=>boolean;fila:<T>(nome:string,work:()=>Promise<T>)=>Promise<T>;
 preparar:(c:Candidato,url:string,env:NodeJS.ProcessEnv)=>Promise<OfertaCpammAtomica|null>;
 executar:typeof executarFlashArbV2;};
const deps:Deps={ativo:executorMegazordInstalado,fila:comExecutorMegazord,executar:executarFlashArbV2,
 preparar:async(c,url,env)=>{
  if(!env.TITAN_V2_CONTRATO||!env.FLASH_ARB_CODEHASH||!env.FLASH_ARB_CPAMM_FACTORIES)
    throw Error('CPAMM requer executor V2, codehash e factories auditadas');
  const rpc=new JsonRpcProvider(url,8453,{staticNetwork:true});
  try {
   const e=c.emprestimo;
   const reserva=e.token0.toLowerCase()===c.U.toLowerCase()?e.reserva0:e.reserva1;
   const oferta=await prepararCpammAtomico((method,params)=>rpc.send(method,params),{
    executor:env.TITAN_V2_CONTRATO,executorCodeHash:env.FLASH_ARB_CODEHASH,
    factories:JSON.parse(env.FLASH_ARB_CPAMM_FACTORIES),
    minimoLiquidoWei:BigInt(env.FLASH_ARB_MIN_NET_WEI??(lerRiscoEconomico(env)?'1':'1000000000000')),
   },[e.endereco,c.venda.endereco],c.U,reserva/10n);
   const risco=lerRiscoEconomico(env);
   if(oferta&&risco&&oferta.lucroMinimoWei<margemLiquidaDinamica(oferta.custoMaximoWei,risco))return null;
   return oferta;
  }finally{rpc.destroy();}
 }};
export async function avaliarEExecutarCpammMegazord(
 c:Candidato,url:string,env:NodeJS.ProcessEnv=process.env,d:Deps=deps,
):Promise<ResultadoCpammMegazord>{
 if(env.TITAN_CPAMM_ATOMICO!=='1')return{status:'desligado',motivo:'CPAMM atomico nao selecionado'};
 const armado=habilitacaoV2(env)===null;
 if(armado&&!d.ativo())return{status:'recusado',motivo:'envio CPAMM exige emissor Megazord instalado'};
 let encaminhado=false;
 try {
  return await d.fila('arbitragem-cpamm',async()=>{
   // Refaz TODAS as leituras após adquirir a fila, não reutiliza prova envelhecida.
   const oferta=await d.preparar(c,url,env);
   if(!oferta)return{status:'recusado',motivo:'CPAMM nao passou na simulacao economica integral'};
   if(oferta.contrato.toLowerCase()!==env.TITAN_V2_CONTRATO?.toLowerCase())
    return{status:'recusado',motivo:'executor diverge entre prova e transmissao'};
   if(!armado)return{status:'simulada',motivo:'prova atomica aprovada; envio nao autorizado'};
   // O executor oficial revalida bytecode, owner, custos, piso, saldo e nonce,
   // simula calldata final e reserva o hash no diário antes de transmitir.
   encaminhado=true;
   return await d.executar({...c,quantia:oferta.emprestadoWei},url,env);
  });
 }catch{return encaminhado
  ?{status:'desconhecido',motivo:'emissor interrompido; reconciliar diario Megazord, nao repetir'}
  :{status:'recusado',motivo:'preflight CPAMM/fila indisponivel; nenhum envio autorizado por esta prova'};}
}
