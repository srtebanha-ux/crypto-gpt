/**
 * TITAN SVR auction observer. No wallet, no signing, no bond, no bid submission.
 * Runs independently of the Aave/Morpho liquidation loop when enabled.
 * Uses Chainlink's documented read-only solver_subscribe transport.
 */
import WebSocket from 'ws';
import type {Logger} from './logger';
import {DedupLeiloesSvr,decodificarNotificacaoSvr,SVR_GATEWAY,type LeilaoSvr} from './titanSvr';
export type EstadoObservadorSvr={
 status:'desligado'|'conectando'|'conectado'|'reconectando'|'parado';
 recebidos:number;unicos:number;invalidos:number;erros:number;inscricaoConfirmada:boolean;ultimo?:LeilaoSvr;
};
export function iniciarObservadorSvr(
 logger:Logger,
 onAuction:(leilao:LeilaoSvr)=>void=()=>{},
 env:NodeJS.ProcessEnv=process.env,
):{estado:()=>EstadoObservadorSvr;parar:()=>void}{
 const state:EstadoObservadorSvr={
  status:env.TITAN_SVR_OBSERVAR==='1'?'conectando':'desligado',
  recebidos:0,unicos:0,invalidos:0,erros:0,inscricaoConfirmada:false
 };
 if(env.TITAN_SVR_OBSERVAR!=='1')return{
  estado:()=>({...state}),parar:()=>{}
 };
 const dedup=new DedupLeiloesSvr();
 let ws:WebSocket|null=null;
 let reconnect:ReturnType<typeof setTimeout>|null=null;
 let heartbeat:ReturnType<typeof setInterval>|null=null;
 let fechado=false,delay=1000;
 let subscriptionId:string|null=null;
 const onMessage=(data:WebSocket.RawData)=>{
  const tamanho=Array.isArray(data)?data.reduce((n,b)=>n+b.byteLength,0):data.byteLength;
  if(tamanho>512000){state.invalidos++;return;}
  let decoded:unknown;
  try{decoded=JSON.parse(data.toString('utf8'))}catch{state.invalidos++;return;}
  const o=decoded as Record<string,unknown>;
  if(o?.id===1&&typeof o.result==='string'&&o.result.length>0){
   subscriptionId=o.result;
   state.inscricaoConfirmada=true;state.status='conectado';
   logger.info('[TITAN/SVR] Inscricao de leiloes ACEITA pelo gateway.',{
    subscriptionId:o.result,modo:'somente observacao',transacoesAssinadas:0
   });
   return;
  }
  if(o?.id===1&&o.error){
   state.erros++;state.inscricaoConfirmada=false;subscriptionId=null;
   logger.warn('[TITAN/SVR] Inscricao recusada pelo gateway.',{
    resposta:JSON.stringify(o.error).slice(0,300)
   });
   ws?.close();
   return;
  }
  if(o?.method!=='solver_subscription')return;
  // Never consume a notification from an unacknowledged/different subscription.
  const params=o.params as Record<string,unknown>|undefined;
  if(!state.inscricaoConfirmada||typeof params?.subscription!=='string'
     ||params.subscription!==subscriptionId){state.invalidos++;return;}
  state.recebidos++;
  const auction=decodificarNotificacaoSvr(o);
  if(!auction){state.invalidos++;return;}
  if(!dedup.recebe(auction))return;
  state.unicos++;state.ultimo=auction;
  logger.info('[TITAN/SVR] Leilao Base identificado (somente observacao).',{
   auctionId:auction.id,userOpHash:auction.hash,
   atlas:auction.atlas,control:auction.control,
   deadlineBlock:auction.deadline.toString(),
   userOpMaxFeePerGasWei:auction.maxFeePerGas.toString(),
   aggregatorPrevisto:auction.precoPrevisto?.aggregador??null,
   medianPricePrevisto:auction.precoPrevisto?.medianPrice.toString()??null,
   dapp:auction.dapp??null,totalAuctions:state.unicos,
   modo:'observacao, sem assinatura nem envio'
  });
  try{onAuction(auction)}catch{state.erros++;}
 };
 const connect=()=>{
  if(fechado)return;
  state.status=state.status==='conectando'?'conectando':'reconectando';
  try{
   ws=new WebSocket(SVR_GATEWAY,{maxPayload:512000,handshakeTimeout:12000});
   ws.on('open',()=>{
    state.status='conectando';state.inscricaoConfirmada=false;
    subscriptionId=null;delay=1000;
    ws?.send(JSON.stringify({
     jsonrpc:'2.0',id:1,method:'solver_subscribe',params:['userOperations']
    }));
    if(heartbeat)clearInterval(heartbeat);
    heartbeat=setInterval(()=>{
     if(ws?.readyState===WebSocket.OPEN)ws.ping();
    },25000);heartbeat.unref?.();
    logger.info('[TITAN/SVR] WebSocket aberto; aguardando ACEITE da inscricao SVR.');
   });
   ws.on('message',onMessage);
   ws.on('error',(err:Error)=>{
    state.erros++;
    logger.warn('[TITAN/SVR] Canal indisponivel; buscando reconectar.',{
     causa:err.message.slice(0,120)
    });
   });
   ws.on('close',()=>{
    if(heartbeat){clearInterval(heartbeat);heartbeat=null;}
    if(fechado)return;
    state.status='reconectando';state.inscricaoConfirmada=false;
    subscriptionId=null;
    reconnect=setTimeout(connect,delay);
    reconnect.unref?.();
    delay=Math.min(30000,delay*2);
   });
  }catch(err){
   state.erros++;state.status='reconectando';state.inscricaoConfirmada=false;
   subscriptionId=null;
   logger.warn('[TITAN/SVR] Conexao ainda nao estabelecida.',{
    causa:String(err).slice(0,130)
   });
   reconnect=setTimeout(connect,delay);
   reconnect.unref?.();
   delay=Math.min(30000,delay*2);
  }
 };
 connect();
 return {
  estado:()=>({...state}),
  parar:()=>{
   fechado=true;state.status='parado';state.inscricaoConfirmada=false;subscriptionId=null;
   if(reconnect)clearTimeout(reconnect);
   if(heartbeat)clearInterval(heartbeat);
   ws?.removeAllListeners();
   ws?.terminate();
  }
 };
}
