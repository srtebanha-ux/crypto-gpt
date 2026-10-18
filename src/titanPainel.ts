/**
 * TITAN Mission Control. Read-only in-process HTTP/SSE endpoint.
 *
 * Only explicit, sanitized telemetry is published. Never serializes environment,
 * private keys, RPC credentials, wallet addresses, raw errors or arbitrary logs.
 * Requires HTTPS-at-the-edge Basic authentication (Railway service domain).
 */
import {createHash,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http,{type IncomingMessage,type ServerResponse} from 'node:http';
import {TITAN_PAINEL_HTML} from './titanPainelHtml';

export type EventoTitanKind='sistema'|'ciclo'|'prova'|'envio'|'alerta'|'descoberta';
export interface EventoTitan {
 at:string;kind:EventoTitanKind;title:string;detail:string;
}
interface PontoTitan {cycle:number;routes:number}
interface RegistroDiario {
 hash:string;diaUtc:string;estado:string;tetoGasWei:string;
 lucroRealizadoWei?:string;gasRealL2Wei?:string;
}
interface DiarioExposto {
 count:number;confirmed:number;reverted:number;pending:number;
 grossWei:string;gasL2Wei:string;
 recent:Array<{hash:string;status:string;date:string;profitWei?:string}>;
}
export interface AlvoCacaPainel {
 id:string; hf:number|null; faltaPct:number|null; bloco:number|null; lidoEm:string|null;
}
export interface CacaPainel {
 observadoEm:string; bloco:number; vigiados:number; podemAtirar:number;
 envioAutorizado:boolean; alvos:AlvoCacaPainel[];
 ultimoTiro?:{hash:string;bloco:number;estado:'enviado'|'confirmado'|'revertido'|'desconhecido'};
}
let cacaRecebido:CacaPainel|null=null;
export function validarCacaPainel(raw:unknown):CacaPainel|null {
 if(!raw||typeof raw!=='object')return null;
 const q=raw as Partial<CacaPainel>;
 if(typeof q.observadoEm!=='string'||!Number.isFinite(Date.parse(q.observadoEm)))return null;
 if(Math.abs(Date.now()-Date.parse(q.observadoEm))>120_000)return null;
 if(!Number.isSafeInteger(q.bloco)||q.bloco!<0||!Number.isSafeInteger(q.vigiados)||q.vigiados!<0
   ||!Number.isSafeInteger(q.podemAtirar)||q.podemAtirar!<0
   ||typeof q.envioAutorizado!=='boolean'||!Array.isArray(q.alvos)||q.alvos.length>20)return null;
 const ids=new Set<string>();const alvos:AlvoCacaPainel[]=[];
 for(const x of q.alvos){
  if(!x||typeof x.id!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(x.id)||ids.has(x.id.toLowerCase()))return null;
  ids.add(x.id.toLowerCase());
  if(x.hf!==null&&(!Number.isFinite(x.hf)||x.hf!<0||x.hf!>100))return null;
  if(x.faltaPct!==null&&(!Number.isFinite(x.faltaPct)||x.faltaPct!<0||x.faltaPct!>100))return null;
  if(x.bloco!==null&&(!Number.isSafeInteger(x.bloco)||x.bloco!<0))return null;
  if(x.lidoEm!==null&&(typeof x.lidoEm!=='string'||!Number.isFinite(Date.parse(x.lidoEm))))return null;
  alvos.push({id:x.id.toLowerCase(),hf:x.hf,faltaPct:x.faltaPct,bloco:x.bloco,lidoEm:x.lidoEm});
 }
 let ultimoTiro:CacaPainel['ultimoTiro'];
 if(q.ultimoTiro && /^0x[0-9a-fA-F]{64}$/.test(q.ultimoTiro.hash)
    &&Number.isSafeInteger(q.ultimoTiro.bloco)
    &&(['enviado','confirmado','revertido','desconhecido'] as string[]).includes(q.ultimoTiro.estado)){
  ultimoTiro={hash:q.ultimoTiro.hash,bloco:q.ultimoTiro.bloco,estado:q.ultimoTiro.estado};
 }
 return{observadoEm:q.observadoEm,bloco:q.bloco!,vigiados:q.vigiados!,
  podemAtirar:q.podemAtirar!,envioAutorizado:q.envioAutorizado!,alvos,
  ...(ultimoTiro?{ultimoTiro}:{})};
}
export interface EstadoTitan {
 startedAt:string;updatedAt:string;
 phase:string;description:string;mode:string;
 contractReady:boolean|null;
 block:number;cycles:number;routes:number;positives:number;
 pools:number|null;mixed:number|null;quotes:number|null;queue:number|null;
 proof:string;
 chart:PontoTitan[];events:EventoTitan[];
 journal:DiarioExposto|null;
 caca:CacaPainel|null;
}
const startedAt=new Date().toISOString();
const state:Omit<EstadoTitan,'journal'>={
 startedAt,updatedAt:startedAt,phase:'Inicializando monitoramento',
 description:'Carregando universo da Base e preparando a leitura de pools.',
 mode:'Somente leitura',contractReady:null,
 block:0,cycles:0,routes:0,positives:0,
 pools:null,mixed:null,quotes:null,queue:null,proof:'Aguardando',
 chart:[],events:[],
};
const clientes=new Set<ServerResponse>();
let timer:ReturnType<typeof setTimeout>|null=null;
let diarioPath:string|undefined;
function diario():DiarioExposto|null {
 if(!diarioPath)return null;
 try{
  const st=fs.statSync(diarioPath);
  if(st.size>10_000_000)return null;
  const obj=JSON.parse(fs.readFileSync(diarioPath,'utf8')) as {versao?:number;registros?:RegistroDiario[]};
  if(obj.versao!==1||!Array.isArray(obj.registros)||obj.registros.length>100_000)return null;
  let count=0,confirmed=0,reverted=0,pending=0,gross=0n,gas=0n;
  const recent:DiarioExposto['recent']=[];
  for(const item of obj.registros){
   if(!item||!/^0x[0-9a-fA-F]{64}$/.test(item.hash)||!['pendente','confirmado','revertido'].includes(item.estado))continue;
   count++;
   if(item.estado==='confirmado')confirmed++;
   if(item.estado==='revertido')reverted++;
   if(item.estado==='pendente')pending++;
   if(item.estado==='confirmado'&&/^\d+$/.test(item.lucroRealizadoWei||''))gross+=BigInt(item.lucroRealizadoWei!);
   if(/^\d+$/.test(item.gasRealL2Wei||''))gas+=BigInt(item.gasRealL2Wei!);
   if(recent.length>=8)recent.shift();
   recent.push({
    hash:item.hash,status:item.estado,date:item.diaUtc,
    ...(item.estado==='confirmado'&&/^\d+$/.test(item.lucroRealizadoWei||'')
     ?{profitWei:item.lucroRealizadoWei}:{})
   });
  }
  return{count,confirmed,reverted,pending,grossWei:gross.toString(),
   gasL2Wei:gas.toString(),recent:recent.reverse()};
 }catch{return null;}
}
export function lerEstadoTitan():EstadoTitan {
 return{...state,chart:[...state.chart],events:[...state.events],journal:diario(),
  caca:cacaRecebido&&Date.now()-Date.parse(cacaRecebido.observadoEm)<60_000?cacaRecebido:null};
}
function publicar():void {
 if(timer!==null)return;
 timer=setTimeout(()=>{
  timer=null;
  if(clientes.size===0)return;
  const payload='data: '+JSON.stringify(lerEstadoTitan())+'\n\n';
  for(const res of clientes)try{res.write(payload);}catch{clientes.delete(res);}
 },250);
 timer.unref?.();
}
export function atualizarTitan(partial:Partial<Omit<EstadoTitan,'chart'|'events'|'journal'>>):void {
 const allowed:Array<keyof Omit<EstadoTitan,'chart'|'events'|'journal'>>=[
  'phase','description','mode','contractReady','block','cycles','routes',
  'positives','pools','mixed','quotes','queue'
 ];
 for(const field of allowed) {
  if(!Object.prototype.hasOwnProperty.call(partial,field))continue;
  const value=partial[field];
  if(field==='contractReady'&&(typeof value==='boolean'||value===null))state.contractReady=value;
  else if(['block','cycles','routes','positives'].includes(field)
   &&typeof value==='number'&&Number.isSafeInteger(value)&&value>=0){
   (state as unknown as Record<string,unknown>)[field]=value;
  } else if(['pools','mixed','quotes','queue'].includes(field)
   &&(value===null||(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0))){
   (state as unknown as Record<string,unknown>)[field]=value;
  } else if(['phase','description','mode'].includes(field)&&typeof value==='string'){
   (state as unknown as Record<string,unknown>)[field]=value.slice(0,220);
  }
 }
 state.updatedAt=new Date().toISOString();
 publicar();
}
export function progressoTitan(cycle:number,routes:number):void {
 if(!Number.isSafeInteger(cycle)||!Number.isSafeInteger(routes)||cycle<0||routes<0)return;
 state.chart.push({cycle,routes});
 if(state.chart.length>40)state.chart.splice(0,state.chart.length-40);
 state.updatedAt=new Date().toISOString();
 publicar();
}
export function eventoTitan(kind:EventoTitanKind,title:string,detail=''):void {
 const ev={at:new Date().toISOString(),kind,title:title.slice(0,140),detail:detail.slice(0,270)};
 state.events.unshift(ev);
 if(state.events.length>70)state.events.length=70;
 if(kind==='prova')state.proof=title.slice(0,120);
 state.updatedAt=ev.at;
 publicar();
}
function hashed(str:string):Buffer{
 return createHash('sha256').update(str,'utf8').digest();
}
function autorizado(req:IncomingMessage,usuario:string,senha:string):boolean{
 const h=req.headers.authorization;
 if(!h||!h.startsWith('Basic ')||h.length>512)return false;
 let text='';
 try{text=Buffer.from(h.slice(6),'base64').toString('utf8');}catch{return false;}
 return timingSafeEqual(hashed(text),hashed(usuario+':'+senha));
}
function headers(res:ServerResponse):void{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Cache-Control','no-store, max-age=0');
 res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}
export function iniciarPainelTitan(env:NodeJS.ProcessEnv=process.env):http.Server|null{
 if(env.TITAN_PAINEL_ATIVO!=='1')return null;
 const usuario=env.TITAN_PAINEL_USUARIO,senha=env.TITAN_PAINEL_SENHA;
 if(!usuario||!senha||senha.length<20)throw Error('Painel: configure usuario e senha forte de ao menos 20 caracteres');
 const port=Number(env.PORT||env.TITAN_PAINEL_PORT||8080);
 if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('Painel: porta invalida');
 const file=env.TITAN_DIARIO_OPERACOES;
 if(file?.startsWith('/app/data/')&&!file.includes('..')&&file.endsWith('.json'))diarioPath=file;
 const server=http.createServer((req,res)=>{
  headers(res);
  // Endpoint exclusivo do Caçador, com credencial independente da senha web.
 // Não oferece comandos e não aceita logs, carteiras ou chaves.
 if(req.url==='/api/caca'&&req.method==='POST'){
  const token=env.TITAN_TELEMETRIA_TOKEN;
  const head=req.headers.authorization;
  const supplied=typeof head==='string'&&head.startsWith('Bearer ')?head.slice(7):'';
  if(!token||token.length<24||!supplied||!timingSafeEqual(hashed(supplied),hashed(token))){
   res.writeHead(401);res.end('Nao autorizado');return;
  }
  let bytes=0,parts:Buffer[]=[];
  req.on('data',(chunk:Buffer)=>{
   bytes+=chunk.length;
   if(bytes>8192){parts=[];req.destroy();return;}
   parts.push(chunk);
  });
  req.on('end',()=>{
   try {
    if(bytes>8192)throw Error('payload muito grande');
    const parsed=validarCacaPainel(JSON.parse(Buffer.concat(parts).toString('utf8')));
    if(!parsed){res.writeHead(422);res.end('Medicao invalida');return;}
    cacaRecebido=parsed;
    publicar();
    res.writeHead(204);res.end();
   }catch{res.writeHead(400);res.end('Formato invalido')}
  });
  return;
 }
 if(!autorizado(req,usuario,senha)){
   res.statusCode=401;
   res.setHeader('WWW-Authenticate','Basic realm="TITAN Mission Control", charset="UTF-8"');
   res.setHeader('Content-Type','text/plain; charset=utf-8');
   res.end('Painel privado. Autenticacao obrigatoria.');
   return;
  }
  if(req.method!=='GET'){
   res.writeHead(405,{'Allow':'GET'});
   res.end('Somente leitura');
   return;
  }
  const path=(req.url||'/').split('?')[0];
  if(path==='/api/state'){
   res.setHeader('Content-Type','application/json; charset=utf-8');
   res.end(JSON.stringify(lerEstadoTitan()));
  }else if(path==='/api/events'){
   if(clientes.size>=24){res.writeHead(503);res.end('Conexoes ao vivo esgotadas');return;}
   res.setHeader('Content-Type','text/event-stream; charset=utf-8');
   res.setHeader('Connection','keep-alive');
   res.setHeader('X-Accel-Buffering','no');
   res.flushHeaders();
   clientes.add(res);
   res.write('retry: 5000\ndata: '+JSON.stringify(lerEstadoTitan())+'\n\n');
   const hb=setInterval(()=>{try{res.write(': heartbeat\n\n')}catch{}},15000);
   hb.unref?.();
   req.on('close',()=>{clearInterval(hb);clientes.delete(res)});
  }else if(path==='/'){
   res.setHeader('Content-Type','text/html; charset=utf-8');
   res.end(TITAN_PAINEL_HTML);
  }else{
   res.writeHead(404);res.end('Pagina nao encontrada');
  }
 });
 server.listen(port,'0.0.0.0');
 server.on('error',(error)=>{console.error('[TITAN/PAINEL] Falha do servidor read-only:',error.message);});
 return server;
}
