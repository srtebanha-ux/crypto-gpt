import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import WebSocket from 'ws';
import {lerSubbloco,anotarSubbloco,iniciarObservadorFlashblocks,type EstadoFlashblocks} from './titanFlashblocks';
import type {Logger} from './logger';
const base={payload_id:'0x01020304',index:0,
 base:{block_number:'0x32'},diff:{transactions:[]}};
const zero:EstadoFlashblocks={estado:'conectando',blocosLogicos:0,
 subblocos:0,indiceMaximo:0,pendentesRecebidos:0,erros:0,
 ultimoPayloadId:null,ultimoNumero:null,ultimoAvisoEm:0};
test('Base RPC newFlashblocks uses payload_id snake_case and carries 0 index',()=>{
 const a=lerSubbloco(base);
 assert.deepEqual(a,{payloadId:'0x01020304',indice:0,numero:'0x32'});
});
test('Flashblock indices above 10 belong to the same logical block until payload id changes',()=>{
 let z=anotarSubbloco(zero,lerSubbloco(base)!,100);
 z=anotarSubbloco(z,lerSubbloco({...base,index:11,base:undefined})!,200);
 assert.equal(z.blocosLogicos,1);assert.equal(z.subblocos,2);
 assert.equal(z.indiceMaximo,11);assert.equal(z.ultimoNumero,'0x32');
 z=anotarSubbloco(z,lerSubbloco({...base,payload_id:'0x05060708',index:0})!,300);
 assert.equal(z.blocosLogicos,2);assert.equal(z.ultimoPayloadId,'0x05060708');
});
test('rejected payload ids and unsupported schema never become a flashblock',()=>{
 assert.equal(lerSubbloco({...base,payloadId:'0xabc',payload_id:undefined}),null);
 assert.equal(lerSubbloco({...base,index:-1}),null);
 assert.equal(lerSubbloco({...base,index:11.2}),null);
 assert.equal(lerSubbloco({...base,payload_id:'https://site'}),null);
 assert.equal(lerSubbloco({}),null);
});
test('duplicate and out-of-order subblocks cannot advance counters or freshness',()=>{
 let z=anotarSubbloco(zero,lerSubbloco(base)!,100);
 z=anotarSubbloco(z,lerSubbloco({...base,index:11})!,200);
 assert.equal(anotarSubbloco(z,lerSubbloco({...base,index:11})!,300),z);
 assert.equal(anotarSubbloco(z,lerSubbloco({...base,index:5})!,400),z);
 assert.equal(z.ultimoAvisoEm,200);
 z=anotarSubbloco(z,lerSubbloco({...base,index:12})!,500);
 assert.equal(z.subblocos,3);assert.equal(z.blocosLogicos,1);
 assert.equal(z.ultimoIndice,12);
});
test('a new payload without base metadata clears the old block number and ignores old payload replays',()=>{
 const a=anotarSubbloco(zero,lerSubbloco(base)!,100);
 const b=anotarSubbloco(a,lerSubbloco({...base,payload_id:'0x05060708',base:undefined})!,200);
 assert.equal(b.ultimoNumero,null);
 assert.equal(anotarSubbloco(b,lerSubbloco({...base,index:12})!,300),b);
 assert.equal(b.blocosLogicos,2);assert.equal(b.subblocos,2);
});
test('payload replay memory is bounded during long-running observation',()=>{
 let z=zero;
 for(let n=0;n<100;n++){
  z=anotarSubbloco(z,lerSubbloco({...base,payload_id:`0x${n.toString(16).padStart(4,'0')}`})!,n);
 }
 assert.equal(z.payloadIdsRecentes?.length,64);
 assert.equal(z.blocosLogicos,100);
 const recent=lerSubbloco({...base,payload_id:'0x0062'})!;
 assert.equal(anotarSubbloco(z,recent,101),z);
});

// Transport tests use no network, account or real timers.
class FakeSocket extends EventEmitter{
 readyState:number=WebSocket.CONNECTING;
 sent:any[]=[];
 terminated=0;
 send(data:string){this.sent.push(JSON.parse(data));}
 open(){this.readyState=WebSocket.OPEN;this.emit('open');}
 receive(data:unknown){this.emit('message',Buffer.from(JSON.stringify(data)));}
 close(){
  if(this.readyState===WebSocket.CLOSED)return;
  this.readyState=WebSocket.CLOSED;this.emit('close');
 }
 terminate(){
  this.terminated++;
  if(this.readyState===WebSocket.CONNECTING){
   // Match ws's deferred error when stopping an incomplete handshake.
   this.readyState=WebSocket.CLOSING;
   queueMicrotask(()=>{this.emit('error',new Error('handshake aborted'));this.close();});
  }else this.close();
 }
}
const quiet:Logger={debug(){},info(){},warn(){},error(){}};
function transport(t:TestContext){
 t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:1000});
 const sockets:FakeSocket[]=[];
 const observer=iniciarObservadorFlashblocks(quiet,{
  TITAN_FLASHBLOCKS_OBSERVAR:'1',TITAN_FLASHBLOCKS_WSS:'wss://rpc.example.test'
 },()=>{
  const socket=new FakeSocket();sockets.push(socket);
  return socket as unknown as WebSocket;
 });
 t.after(()=>observer.parar());
 return{observer,sockets};
}
function flash(socket:FakeSocket,payload=base){
 socket.receive({jsonrpc:'2.0',id:1,result:'flash-sub'});
 socket.receive({jsonrpc:'2.0',method:'eth_subscription',params:{
  subscription:'flash-sub',result:payload
 }});
}
test('unsupported Flashblocks falls back to canonical heads once without a scheduled fork date',(t)=>{
 const {observer,sockets}=transport(t);const socket=sockets[0];socket.open();
 assert.deepEqual(socket.sent[0].params,['newFlashblocks']);
 socket.receive({jsonrpc:'2.0',id:1,error:{code:-32602}});
 socket.receive({jsonrpc:'2.0',id:1,error:{code:-32602}});
 assert.equal(socket.sent.length,2);
 assert.deepEqual(socket.sent[1].params,['newHeads']);
 socket.receive({jsonrpc:'2.0',id:2,result:'head-sub'});
 socket.receive({jsonrpc:'2.0',method:'eth_subscription',params:{
  subscription:'head-sub',result:{number:'0x33'}
 }});
 assert.equal(observer.estado().estado,'canonico');
 assert.equal(observer.estado().ultimoNumero,'0x33');
});
test('a reconnected socket receives a fresh liveness window after historical silence',(t)=>{
 const {observer,sockets}=transport(t);const first=sockets[0];first.open();flash(first);
 t.mock.timers.tick(40000);
 assert.equal(first.terminated,1);
 assert.equal(observer.estado().estado,'reconectando');
 t.mock.timers.tick(1000);
 assert.equal(sockets.length,2);
 const second=sockets[1];second.open();
 t.mock.timers.tick(5000);
 assert.equal(second.terminated,0);
 assert.equal(second.sent.length,1,'fresh connection must not immediately fall back');
 flash(second,{...base,payload_id:'0x05060708',base:{block_number:'0x33'}});
 assert.equal(observer.estado().estado,'flashblocks');
 assert.equal(observer.estado().blocosLogicos,2);
});
test('transport ignores replayed events without extending freshness and snapshots are isolated',(t)=>{
 const {observer,sockets}=transport(t);const socket=sockets[0];socket.open();flash(socket);
 t.mock.timers.tick(5000);flash(socket);
 const snapshot=observer.estado();
 assert.equal(snapshot.subblocos,1);assert.equal(snapshot.ultimoAvisoEm,1000);
 (snapshot.payloadIdsRecentes as string[]).push('0x05060708');
 flash(socket,{...base,payload_id:'0x05060708'});
 assert.equal(observer.estado().blocosLogicos,2);
});
test('stopping during the handshake handles ws error and never reconnects',async(t)=>{
 const {observer,sockets}=transport(t);const socket=sockets[0];
 observer.parar();observer.parar();
 await Promise.resolve();
 assert.equal(socket.terminated,1);assert.equal(observer.estado().estado,'parado');
 assert.equal(observer.estado().erros,0);
 socket.open();flash(socket);
 t.mock.timers.tick(60000);
 assert.equal(sockets.length,1);assert.equal(socket.sent.length,0);
 assert.equal(observer.estado().subblocos,0);
});
