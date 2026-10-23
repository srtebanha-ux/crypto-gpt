import test from 'node:test';
import assert from 'node:assert/strict';
import {criarRpcPreflight} from './megazordRpcLeitura';
const ok=()=>new Response(JSON.stringify({result:'0x2105'}),{status:200});
test('429 obeys Retry-After seconds and date before retrying read calls',async()=>{
 for(const header of ['2',new Date(Date.UTC(2026,0,1)+2150).toUTCString()]){
   let now=Date.UTC(2026,0,1),calls=0;
   const waits:number[]=[];
   const rpc=criarRpcPreflight({agora:()=>now,
     esperar:async ms=>{waits.push(ms);now+=ms;},
     fetcher:(async()=>++calls===1
       ?new Response('',{status:429,headers:{'retry-after':header}}):ok()) as typeof fetch});
   assert.equal(await rpc('https://rpc.invalid','eth_chainId',[]),'0x2105');
   assert.equal(calls,2);
   assert.ok(waits.some(ms=>ms>=1850),'server cooldown was respected');
 }
});
test('long server cooldown fails over without shortening it or hammering queued reads',async()=>{
 let now=0,calls=0;
 const rpc=criarRpcPreflight({agora:()=>now,esperar:async ms=>{now+=ms;},
   fetcher:(async()=>{calls++;return new Response('',{status:429,
     headers:{'retry-after':'60'}});}) as typeof fetch});
 const pending=[rpc('a','eth_chainId',[]),rpc('a','eth_getBalance',[])];
 const results=await Promise.allSettled(pending);
 assert.ok(results.every(r=>r.status==='rejected'));
 assert.equal(calls,1);
});
test('retries are bounded and never apply to broadcast or upstream secret-bearing errors',async()=>{
 let calls=0,now=0;
 const rpc=criarRpcPreflight({agora:()=>now,esperar:async ms=>{now+=ms;},
   fetcher:(async()=>{calls++;return new Response('',{status:429});}) as typeof fetch});
 await assert.rejects(rpc('a','eth_chainId',[]),/RPC HTTP 429/);
 assert.equal(calls,3);
 await assert.rejects(rpc('a','eth_sendRawTransaction',['sensitive']),/somente leitura/);
 assert.equal(calls,3);
 const hidden='https://rpc.invalid/private-secret';
 const broken=criarRpcPreflight({esperar:async()=>{},fetcher:(async()=>{
   throw Error(hidden);
 }) as typeof fetch});
 await assert.rejects(broken(hidden,'eth_chainId',[]),e=>
   e instanceof Error&&!e.message.includes('private-secret'));
});
test('one provider is serialized while the independent provider remains usable',async()=>{
 let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 let callsA=0,activeA=0,peakA=0;
 const rpc=criarRpcPreflight({esperar:async()=>{},fetcher:(async url=>{
   if(url==='a'){
     callsA++;activeA++;peakA=Math.max(peakA,activeA);
     if(callsA===1)await gate;
     activeA--;
   }
   return ok();
 }) as typeof fetch});
 const first=rpc('a','eth_chainId',[]),second=rpc('a','eth_getBalance',[]);
 assert.equal(await rpc('b','eth_chainId',[]),'0x2105');
 assert.equal(callsA,1);
 release();await Promise.all([first,second]);assert.equal(peakA,1);
});
test('JSON-RPC error data is never reproduced in diagnostics',async()=>{
 const rpc=criarRpcPreflight({esperar:async()=>{},fetcher:(async()=>
   new Response(JSON.stringify({error:{message:'private-secret',code:-1}}))) as typeof fetch});
 await assert.rejects(rpc('a','eth_chainId',[]),/^Error: resposta RPC invalida$/);
});
