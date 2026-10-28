import {JsonRpcProvider,JsonRpcPayload,JsonRpcResult} from 'ethers';
import {fetch,ProxyAgent} from 'undici';
import {agendaRpc,ehSaturacaoRpc} from './rpcCoordenado';
/** Read/preflight deadline propagates to the actual socket, not only a Promise race. */
export class ProviderMorphoRpc extends JsonRpcProvider {
 private operacoes=0;
 private readonly agente=process.env.HTTPS_PROXY?new ProxyAgent(process.env.HTTPS_PROXY):undefined;
 constructor(private readonly urlMorpho:string,private readonly sinal?:AbortSignal){
  super(urlMorpho,8453,{staticNetwork:true,batchMaxCount:1,batchStallTime:0,cacheTimeout:0});
 }
 override async _send(payload:JsonRpcPayload|JsonRpcPayload[]):Promise<JsonRpcResult[]>{
  this.sinal?.throwIfAborted();
  const n=Array.isArray(payload)?payload.length:1;
  if(this.operacoes+n>240)throw Error('teto de operacoes do preflight Morpho');
  this.operacoes+=n;
  const agenda=agendaRpc(this.urlMorpho);
  const reserva=agenda.reservar(n);
  if(this.sinal){
   await new Promise<void>((resolve,reject)=>{
    const abortar=()=>reject(this.sinal!.reason??Error('preflight cancelado'));
    this.sinal!.addEventListener('abort',abortar,{once:true});
    reserva.then(()=>{this.sinal!.removeEventListener('abort',abortar);resolve();},e=>{
     this.sinal!.removeEventListener('abort',abortar);reject(e);
    });
    if(this.sinal!.aborted)abortar();
   });
  }else await reserva;
  this.sinal?.throwIfAborted();
  const signal=this.sinal?AbortSignal.any([this.sinal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
  try{
   const response=await fetch(this.urlMorpho,{
    ...(this.agente?{dispatcher:this.agente}:{}),method:'POST',
    headers:{'content-type':'application/json','accept':'application/json','accept-encoding':'identity'},body:JSON.stringify(payload),signal,
   });
   if(!response.ok)throw Error('RPC HTTP '+response.status);
   const raw=await response.json();
   const result=(Array.isArray(raw)?raw:[raw]) as JsonRpcResult[];
   if(result.some(r=>'error'in r&&ehSaturacaoRpc(r.error)))agenda.recusar();else agenda.passou();
   return result;
  }catch(e){if(ehSaturacaoRpc(e))agenda.recusar();throw e;}
 }
 override destroy():void{super.destroy();void this.agente?.close();}
}
