/**
 * TITAN-SVR: diagnosta o que REALMENTE falta para a oferta Atlas na Base.
 * Consultas publicas onchain, sem carteira nem gas. Nao habilita envio.
 */
import {Interface,getAddress,isAddress,formatEther} from 'ethers';
import {BASE_ATLAS,BASE_CONTROL} from './titanSvrOperacao';
import type {Logger} from './logger';

const I_ATLAS=new Interface([
 'function VERIFICATION() view returns (address)',
 'function balanceOfBonded(address) view returns (uint256)'
]);
const I_CONTROL=new Interface(['function getSolverGasLimit() view returns (uint256)']);
const EXPECTED_VERIFICATION='0x6e1886aEca75160BAa5610B7c1D3a895198C61cf';
export interface LeitorAtlas {
 call(t:{to:string;data:string}):Promise<string>;
 getCode(address:string):Promise<string>;
}
export interface DiagnosticoSvr {
 verificadoEm:string;
 inscricaoSvrAtiva:boolean;
 assinadorPublico:string|null;
 contratoExecutor:string|null;
 garantiaEth:string|null;
 gasMaximoSolver:string|null;
 verificacaoAtlas:string|null;
 prontoParaAnaliseFinanceira:boolean;
 impeditivos:string[];
}
export async function diagnosticarSvr(
 leitor:LeitorAtlas,enderecoAssinador:string|null,
 enderecoExecutor:string|null
):Promise<DiagnosticoSvr>{
 const impeditivos:string[]=[];
 const d:DiagnosticoSvr={
  verificadoEm:new Date().toISOString(),inscricaoSvrAtiva:true,
  assinadorPublico:null,contratoExecutor:null,garantiaEth:null,
  gasMaximoSolver:null,verificacaoAtlas:null,prontoParaAnaliseFinanceira:false,
  impeditivos,
 };
 async function ler<T extends string>(
  target:string,iface:Interface,fn:T,args:unknown[]=[]
 ) {
  const raw=await leitor.call({
   to:target,data:iface.encodeFunctionData(fn,args)
  });
  return iface.decodeFunctionResult(fn,raw)[0];
 }
 try {
  const code=await leitor.getCode(BASE_ATLAS);
  if(code==='0x'||code==='0x0')impeditivos.push('Contrato Atlas nao existe neste RPC');
  const verification=await ler(BASE_ATLAS,I_ATLAS,'VERIFICATION');
  d.verificacaoAtlas=getAddress(String(verification));
  if(d.verificacaoAtlas.toLowerCase()!==EXPECTED_VERIFICATION.toLowerCase())
   impeditivos.push('EIP712 Verification divergente da versao Atlas validada');
  const gas=await ler(BASE_CONTROL,I_CONTROL,'getSolverGasLimit');
  d.gasMaximoSolver=BigInt(gas).toString();
  if(BigInt(gas)<=0n)impeditivos.push('SolverGasLimit invalido');
 }catch(e){
  impeditivos.push('Nao foi possivel conferir contratos Atlas: '+String(e).slice(0,190));
 }
 if(!enderecoAssinador||!isAddress(enderecoAssinador)){
  impeditivos.push('Assinador publico da conta de operacao nao configurado');
 }else{
  d.assinadorPublico=getAddress(enderecoAssinador);
  try{
   const bonded=BigInt(await ler(BASE_ATLAS,I_ATLAS,'balanceOfBonded',[d.assinadorPublico]));
   d.garantiaEth=formatEther(bonded);
   if(bonded===0n)impeditivos.push('0 ETH bonded no Atlas: nao e elegivel para pagar gas de solver');
  }catch(e){
   impeditivos.push('Falha ao ler bond onchain: '+String(e).slice(0,180));
  }
 }
 if(!enderecoExecutor||!isAddress(enderecoExecutor)){
  impeditivos.push('Contrato TITAN-SVR ainda nao implantado/configurado');
 }else{
  d.contratoExecutor=getAddress(enderecoExecutor);
  try{
   const code=await leitor.getCode(d.contratoExecutor);
   if(code==='0x'||code==='0x0')impeditivos.push('Nao ha bytecode no endereco TITAN-SVR');
  }catch(e){impeditivos.push('Nao foi possivel ler bytecode TITAN-SVR: '+String(e).slice(0,160))}
 }
 d.prontoParaAnaliseFinanceira=impeditivos.length===0;
 return d;
}
export function iniciarMonitorProntidaoSvr(
 logger:Logger,leitor:LeitorAtlas,assinador:string|null,
 env:NodeJS.ProcessEnv=process.env
):{parar:()=>void}{
 if(env.TITAN_SVR_OBSERVAR!=='1')return{parar:()=>{}};
 let timer:ReturnType<typeof setInterval>|undefined;
 let parado=false,ocupado=false,ultimo='';
 const poll=async()=>{
  if(parado||ocupado)return;ocupado=true;
  try{
   const d=await diagnosticarSvr(leitor,assinador,env.TITAN_SVR_SOLVER_ADDRESS||null);
   const atual=JSON.stringify({
    elegivel:d.prontoParaAnaliseFinanceira,impeditivos:d.impeditivos,
    garantia:d.garantiaEth,executor:d.contratoExecutor
   });
   // Only on material changes: no noise every minute while still reporting
   // an actual missing bond/contract on startup.
   if(atual!==ultimo){
    ultimo=atual;
    logger.info('[TITAN/SVR-PRONTIDAO] Elegibilidade de execucao verificada no Atlas.',{
     prontoParaAnaliseFinanceira:d.prontoParaAnaliseFinanceira,
     garantiaEth:d.garantiaEth,executor:d.contratoExecutor,
     gasMaximoSolver:d.gasMaximoSolver,
     impeditivos:d.impeditivos,
     observacao:'Nao autoriza lances; ainda precisa de simulacao e oportunidade real',
    });
   }
  }catch(e){
   logger.warn('[TITAN/SVR-PRONTIDAO] Sem diagnostico confiavel.',{
    motivo:String(e).slice(0,180)
   });
  }finally{ocupado=false}
 };
 void poll();
 timer=setInterval(()=>{void poll()},120000);
 timer.unref?.();
 return{parar:()=>{parado=true;if(timer)clearInterval(timer)}};
}
