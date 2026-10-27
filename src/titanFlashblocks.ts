/**
 * Read-only, opt-in Flashblocks observer for Base RPC WSS.
 *
 * Official Base RPC API uses eth_subscribe('newFlashblocks') on a provider
 * WebSocket. The wss://mainnet.flashblocks.base.org/ws raw infrastructure
 * stream is NOT an application RPC endpoint; never connect to it here.
 *
 * Safe across the future Denim change: if the Flashblocks subscription is
 * unsupported or stops delivering, fall back to eth_subscribe('newHeads').
 * No scheduled mainnet fork date, hardcoded index ceiling or wallet.
 */
import WebSocket from 'ws';
import type {Logger} from './logger';

export type EstadoRapido='desligado'|'conectando'|'flashblocks'|'canonico'|'reconectando'|'parado';
export interface EstadoFlashblocks{
 estado:EstadoRapido;blocosLogicos:number;subblocos:number;
 indiceMaximo:number;pendentesRecebidos:number;erros:number;
 ultimoPayloadId:string|null;ultimoNumero:string|null;
 ultimoAvisoEm:number;
 // Bounded replay window. Optional for callers restoring older snapshots.
 ultimoIndice?:number;payloadIdsRecentes?:readonly string[];
}
export interface SubblocoRecebido{payloadId:string;indice:number;numero:string|null}
export function lerSubbloco(raw:unknown):SubblocoRecebido|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const v=raw as Record<string,unknown>;
 // Base official schema is payload_id, not camelCase payloadId.
 const id=v.payload_id;
 if(typeof id!=='string'||!/^0x[0-9a-fA-F]{2,128}$/.test(id)
    ||!Number.isSafeInteger(v.index)||Number(v.index)<0)return null;
 const b=(v.base&&typeof v.base==='object'&&!Array.isArray(v.base))
   ?v.base as Record<string,unknown>:null;
 const num=typeof b?.block_number==='string'&&/^0x[0-9a-fA-F]+$/.test(b.block_number)
   ?b.block_number:null;
 return {payloadId:id.toLowerCase(),indice:Number(v.index),numero:num};
}
export function anotarSubbloco(
 anterior:EstadoFlashblocks,dado:SubblocoRecebido,agora:number
):EstadoFlashblocks{
 const mudou=anterior.ultimoPayloadId!==dado.payloadId;
 const recentes=anterior.payloadIdsRecentes??
  (anterior.ultimoPayloadId===null?[]:[anterior.ultimoPayloadId]);
 // A replay or an older subblock must not roll state backwards or manufacture
 // new logical blocks. Keep only a bounded window of payload identifiers.
 if((!mudou&&dado.indice<=(anterior.ultimoIndice??-1))
   ||(mudou&&recentes.includes(dado.payloadId)))return anterior;
 return {...anterior,estado:'flashblocks',subblocos:anterior.subblocos+1,
  blocosLogicos:anterior.blocosLogicos+(mudou?1:0),
  indiceMaximo:Math.max(anterior.indiceMaximo,dado.indice),
  ultimoPayloadId:dado.payloadId,
  ultimoNumero:dado.numero??(mudou?null:anterior.ultimoNumero),
  ultimoIndice:dado.indice,
  payloadIdsRecentes:mudou?[...recentes,dado.payloadId].slice(-64):recentes,
  ultimoAvisoEm:agora};
}
type CriarSocketFlashblocks=(url:string,options:WebSocket.ClientOptions)=>WebSocket;
export function iniciarObservadorFlashblocks(
 logger:Logger,env:NodeJS.ProcessEnv=process.env,
 criarSocket:CriarSocketFlashblocks=(url,options)=>new WebSocket(url,options)
):{estado:()=>EstadoFlashblocks;parar:()=>void}{
 const state:EstadoFlashblocks={estado:'desligado',blocosLogicos:0,
  subblocos:0,indiceMaximo:0,pendentesRecebidos:0,erros:0,
  ultimoPayloadId:null,ultimoNumero:null,ultimoAvisoEm:0};
 if(env.TITAN_FLASHBLOCKS_OBSERVAR!=='1')return{
  estado:()=>({...state}),parar:()=>{}
 };
 // Explicit endpoint only: do not infer a WS URL from HTTP or use raw infra.
 const url=(env.TITAN_FLASHBLOCKS_WSS??'').trim();
 let parsed:URL;
 try{
  parsed=new URL(url);
  if(parsed.protocol!=='wss:'||!parsed.hostname
    ||parsed.hostname==='mainnet.flashblocks.base.org'
    ||parsed.hostname==='sepolia.flashblocks.base.org')
    throw Error('unsupported endpoint');
 }catch{
  logger.warn('[TITAN/FLASHBLOCKS] Sem RPC WSS de aplicativo valido. Nao inicia.',{
   precisa:'TITAN_FLASHBLOCKS_WSS=wss://<provedor-rpc-compativel>',
   carteira:'nenhuma',envio:'nenhum'});
  return{estado:()=>({...state}),parar:()=>{}};
 }
 let ws:WebSocket|null=null;
 let timer:ReturnType<typeof setTimeout>|null=null;
 let watchdog:ReturnType<typeof setInterval>|null=null;
 let stopped=false,retryMs=1000,flashSub:string|null=null,headsSub:string|null=null;
 let lastLog=0,lastConnectionEvent=0;
 const scheduleReconnect=()=>{
  if(stopped)return;
  state.estado='reconectando';
  if(timer)clearTimeout(timer);
  timer=setTimeout(connect,retryMs);timer.unref?.();
  retryMs=Math.min(30000,retryMs*2);
 };
 const subscribeHeads=()=>{
  if(!ws||ws.readyState!==WebSocket.OPEN||headsSub!==null)return;
  // Trigger once per connection even while awaiting ack.
  if(askedHeads)return;
  askedHeads=true;
  ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['newHeads']}));
 };
 let askedHeads=false;
 const connect=()=>{
  if(stopped)return;
  state.estado='conectando';askedHeads=false;flashSub=null;headsSub=null;
  lastConnectionEvent=Date.now();lastFlashEvent=0;
  try{
   const socket=criarSocket(url,{maxPayload:1048576,handshakeTimeout:10000});
   ws=socket;
   socket.on('open',()=>{
    if(stopped||ws!==socket)return;
    retryMs=1000;lastConnectionEvent=Date.now();
    socket.send(JSON.stringify({jsonrpc:'2.0',id:1,
     method:'eth_subscribe',params:['newFlashblocks']}));
    logger.info('[TITAN/FLASHBLOCKS] WSS conectado; pedindo subblocos RPC.',{
     host:parsed.hostname,transacoes:'impossiveis (observador)'});
    watchdog=setInterval(()=>{
     if(stopped||ws!==socket||socket.readyState!==WebSocket.OPEN)return;
     // Historical telemetry survives reconnects; liveness starts afresh for
     // each connection so an old timestamp cannot kill a healthy new socket.
     const silence=Date.now()-lastConnectionEvent;
     // A Flashblocks endpoint can be retired by Denim without closing WS.
     if(silence>12000&&!askedHeads){
      logger.warn('[TITAN/FLASHBLOCKS] Sem subblocos; tentando newHeads canonico.',{
       silencioMs:silence});
      subscribeHeads();
     }
     if(silence>35000){
      state.erros++;socket.terminate();return;
     }
    },5000);watchdog.unref?.();
   });
   socket.on('message',(raw)=>{
    if(stopped||ws!==socket)return;
    if(Array.isArray(raw)?raw.reduce((n,b)=>n+b.byteLength,0)>1048576:raw.byteLength>1048576)return;
    let msg:any;try{msg=JSON.parse(raw.toString('utf8'))}catch{state.erros++;return}
    if(msg?.id===1){
     if(typeof msg.result==='string'&&msg.result.length>0){
      flashSub=msg.result;return;
     }
     if(msg.error){
      logger.warn('[TITAN/FLASHBLOCKS] Provedor nao aceitou newFlashblocks; usando newHeads.',{
       code:msg.error.code??null});
      subscribeHeads();return;
     }
    }
    if(msg?.id===2){
     if(typeof msg.result==='string'&&msg.result.length>0){headsSub=msg.result;return;}
     if(msg.error){state.erros++;logger.warn('[TITAN/FLASHBLOCKS] newHeads recusado.',{
      code:msg.error.code??null});socket.close();return}
    }
    if(msg?.method!=='eth_subscription'||!msg.params)return;
    const sub=msg.params.subscription,result=msg.params.result;
    if(flashSub!==null&&sub===flashSub){
     const d=lerSubbloco(result);
     if(!d){state.erros++;return}
     const now=Date.now();
     const next=anotarSubbloco(state,d,now);
     if(next===state)return;
     lastFlashEvent=now;lastConnectionEvent=now;
     Object.assign(state,next);
     // one log per minute; logging 10 times/s would slow the executor.
     if(Date.now()-lastLog>60000){
      lastLog=Date.now();
      logger.info('[TITAN/FLASHBLOCKS] Preconfirmacoes observadas.',{
       blocos:state.blocosLogicos,subblocos:state.subblocos,
       indiceMaximo:state.indiceMaximo,numero:state.ultimoNumero,
       modo:'somente observacao; sem envio e sem simulacao atomica'});
     }
     return;
    }
    if(headsSub!==null&&sub===headsSub){
     const numero=result?.number;
     if(typeof numero!=='string'||!/^0x[0-9a-fA-F]+$/.test(numero))return;
     state.ultimoNumero=numero;state.ultimoAvisoEm=Date.now();
     lastConnectionEvent=state.ultimoAvisoEm;
     // If provider has retired subblocks, track canonical heads instead.
     const flashStale=state.estado!=='flashblocks'
       ||Date.now()-lastFlashEvent>8000;
     if(flashStale){
      if(state.estado!=='canonico')
       logger.info('[TITAN/FLASHBLOCKS] Modo canonico newHeads ativado por capacidade observada.');
      state.estado='canonico';
     }
    }
   });
   socket.on('close',()=>{
    if(stopped||ws!==socket)return;
    if(watchdog){clearInterval(watchdog);watchdog=null}scheduleReconnect();
   });
   socket.on('error',()=>{if(!stopped&&ws===socket)state.erros++}); // Don't leak auth URL.
  }catch{state.erros++;scheduleReconnect()}
 };
 let lastFlashEvent=0;
 // Note: update lastFlashEvent in the on-message path when valid Flashblock arrives.
 connect();
 return{estado:()=>({...state,payloadIdsRecentes:state.payloadIdsRecentes?.slice()}),parar:()=>{
  if(stopped)return;
  stopped=true;state.estado='parado';
  if(timer)clearTimeout(timer);if(watchdog)clearInterval(watchdog);
  // ws emits an asynchronous error when terminating during its handshake.
  // Retain the guarded error listener until the socket is closed.
  ws?.terminate();
 }};
}
