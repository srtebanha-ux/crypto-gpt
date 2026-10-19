/**
 * Morpho read-only scout scheduling. Runs immediately and every interval;
 * overlapping scans are rejected. Does not import a signer, wallet, or code
 * capable of sending transactions. The caller still owns API/RPC budgets.
 */
export interface EstadoAgendadorMorpho{
 executando:boolean;
 concluidas:number;
 falhas:number;
 puladasPorSobreposicao:number;
}
export type RelogioMorpho={
 agendar:(callback:()=>void,ms:number)=>{unref?:()=>void};
 cancelar:(timer:{unref?:()=>void})=>void;
};
export function agendarDescobertaMorpho(
 trabalho:()=>Promise<void>,intervaloMs:number,
 registrarErro:(erro:unknown)=>void=()=>{},
 relogio:RelogioMorpho={
  agendar:(cb,ms)=>setInterval(cb,ms),
  cancelar:(timer)=>clearInterval(timer as ReturnType<typeof setInterval>),
 },
):{rodarAgora:()=>Promise<boolean>;parar:()=>void;estado:()=>EstadoAgendadorMorpho}{
 if(!Number.isSafeInteger(intervaloMs)||intervaloMs<900000||intervaloMs>86400000)
  throw Error('intervalo de varredura Morpho invalido (15min a 24h)');
 const estado:EstadoAgendadorMorpho={
  executando:false,concluidas:0,falhas:0,puladasPorSobreposicao:0,
 };
 let ativo=true;
 const rodarAgora=async():Promise<boolean>=>{
  if(!ativo)return false;
  if(estado.executando){estado.puladasPorSobreposicao++;return false}
  estado.executando=true;
  try{await trabalho();estado.concluidas++;return true}
  catch(e){
   estado.falhas++;
   try{registrarErro(e)}catch{/* callback de log nunca pode derrubar processo */}
   return false;
  }finally{estado.executando=false}
 };
 const timer=relogio.agendar(()=>{void rodarAgora()},intervaloMs);
 timer.unref?.();
 void rodarAgora();
 return {rodarAgora,estado:()=>({...estado}),
  parar:()=>{ativo=false;relogio.cancelar(timer)}};
}
