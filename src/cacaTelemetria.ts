/**
 * Telemetria separada de transacoes. Apenas publica medidas da brasa,
 * jamais compartilha chave da carteira ou expõe comandos ao painel.
 * O POST e assíncrono, sem bloquear o loop de disparos.
 */
import {request} from 'node:https';

interface AlvoLeitura {
 id:string; hf:number|null; faltaPct:number|null; bloco:number|null; lidoEm:string|null;
}
interface TiroResumo {
 hash:string;bloco:number;estado:'enviado'|'confirmado'|'revertido'|'desconhecido';
}
const alvos=new Map<string,AlvoLeitura>();
let blocos=0,vigiados=0,podemAtirar=0,envioAutorizado=false;
let ultimoTiro:TiroResumo|undefined;
let ativo=false,ocupado=false;
let intervalo:ReturnType<typeof setInterval>|undefined;
let destino:URL|undefined;let segredo:string|undefined;
export function configurarRadarCaca(ids:Iterable<string>,enviar:boolean,env=process.env):void {
 envioAutorizado=enviar;
 alvos.clear();
 for(const endereco of ids){
  if(/^0x[0-9a-fA-F]{40}$/.test(endereco)){
   const id=endereco.toLowerCase();
   alvos.set(id,{id,hf:null,faltaPct:null,bloco:null,lidoEm:null});
  }
 }
 const token=env.CACA_TELEMETRIA_TOKEN,url=env.CACA_TELEMETRIA_URL;
 if(!token||token.length<24||!url)return;
 try{
  const check=new URL(url);
  if(check.protocol!=='https:'||check.username||check.password||check.search||check.hash
    ||check.pathname!=='/api/caca')return;
  destino=check;segredo=token;ativo=true;
 }catch{return}
 if(intervalo)return;
 intervalo=setInterval(()=>{void publicar()},10_000);
 intervalo.unref();
 void publicar();
}
export function atualizarRadarCaca(
 bloco:number,examinados:number,candidatosLiquidaveis:number,
):void{
 if(Number.isSafeInteger(bloco)&&bloco>=0)blocos=bloco;
 if(Number.isSafeInteger(examinados)&&examinados>=0)vigiados=examinados;
 if(Number.isSafeInteger(candidatosLiquidaveis)&&candidatosLiquidaveis>=0)
  podemAtirar=candidatosLiquidaveis;
}
export function registrarAlvoCaca(id:string,hf:number,faltaPct:number|null,bloco:number):void {
 const item=alvos.get(id.toLowerCase());if(!item)return;
 if(!Number.isFinite(hf)||hf<0||hf>100)return;
 if(faltaPct!==null&&(!Number.isFinite(faltaPct)||faltaPct<0||faltaPct>100))return;
 item.hf=hf;item.faltaPct=faltaPct;item.bloco=bloco;item.lidoEm=new Date().toISOString();
}
export function registrarTiroCaca(hash:string,bloco:number,
 estado:'enviado'|'confirmado'|'revertido'|'desconhecido'):void{
 if(!/^0x[0-9a-fA-F]{64}$/.test(hash)||!Number.isSafeInteger(bloco))return;
 ultimoTiro={hash,bloco,estado};
}
export function estadoRadarCaca():{
 observadoEm:string;bloco:number;vigiados:number;podemAtirar:number;
 envioAutorizado:boolean;alvos:AlvoLeitura[];ultimoTiro?:TiroResumo;
}{
 return{
  observadoEm:new Date().toISOString(),bloco:blocos,vigiados,podemAtirar,
  envioAutorizado,alvos:Array.from(alvos.values()),
  ...(ultimoTiro?{ultimoTiro}:{})
 };
}
async function publicar():Promise<void>{
 if(!ativo||!destino||!segredo||ocupado)return;
 ocupado=true;
 const payload=Buffer.from(JSON.stringify(estadoRadarCaca()));
 try{
  await new Promise<void>((resolve)=>{
   const req=request(destino!,{
     method:'POST',timeout:4_000,headers:{
       'Authorization':'Bearer '+segredo,
       'Content-Type':'application/json',
       'Content-Length':payload.length,
     }
   },res=>{res.resume();res.on('end',resolve)});
   req.on('timeout',()=>req.destroy());
   req.on('error',()=>resolve());
   req.on('close',resolve);
   req.end(payload);
  });
 }finally{ocupado=false}
}
