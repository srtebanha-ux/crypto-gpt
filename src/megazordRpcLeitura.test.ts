import test from 'node:test';
import assert from 'node:assert/strict';
import {criarRpcPreflight as estrito} from './megazordRpcLeitura';
const criarRpcPreflight=(options:Parameters<typeof estrito>[0]={})=>{
 const fetcher=options.fetcher;
 return estrito({...options,fetcher:fetcher?(async(u,i)=>{
  const r=await fetcher(u,i);if(!r.ok)return r;
  const body=await r.json() as object;
  return new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(String(i?.body)).id,...body}),{status:r.status});
 }) as typeof fetch:undefined});
};
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
   assert.ok(waits.reduce((sum,ms)=>sum+ms,0)>=2000,'server cooldown and request pacing were respected');
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
 await assert.rejects(rpc('a','eth_chainId',[]),/^Error: resposta RPC invalida \[eth_chainId\]$/);
});

test('HTTP 200 with temporary JSON-RPC error retries, then requires valid onchain result',async()=>{
 let attempts=0;
 const waits:number[]=[];
 const rpc=criarRpcPreflight({
  esperar:async ms=>{waits.push(ms);},
  fetcher:(async()=>{
   attempts++;
   return attempts<3
    ?new Response(JSON.stringify({error:{code:-32000,message:'backend error'}}),{status:200})
    :new Response(JSON.stringify({result:'0x2105'}),{status:200});
  }) as typeof fetch,
 });
 assert.equal(await rpc('https://rpc.invalid','eth_chainId',[]),'0x2105');
 assert.equal(attempts,3);
 assert.ok(waits.includes(400));
 assert.ok(waits.includes(800));
});
test('persistent HTTP-200 RPC errors fail closed after exactly three read attempts',async()=>{
 let attempts=0;
 const rpc=criarRpcPreflight({
  esperar:async()=>{},
  fetcher:(async()=>{
   attempts++;
   return new Response(JSON.stringify({error:{code:-32005,message:'secrettoken'}}),{status:200});
  }) as typeof fetch,
 });
 await assert.rejects(rpc('https://rpc.invalid','eth_getCode',['0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb','latest']),
  e=>e instanceof Error&&e.message==='resposta RPC invalida [eth_getCode]');
 assert.equal(attempts,3);
});

test('each read request has a distinct JSON-RPC id, including retries',async()=>{
 const ids:number[]=[];
 let attempts=0;
 const rpc=criarRpcPreflight({
  esperar:async()=>{},
  fetcher:(async(_url,init)=>{
   const payload=JSON.parse(String(init?.body));
   ids.push(payload.id);
   attempts++;
   return attempts===1
    ?new Response(JSON.stringify({error:{code:-32000,message:'temporary'}}),{status:200})
    :ok();
  }) as typeof fetch,
 });
 await rpc('https://rpc.invalid','eth_chainId',[]);
 await rpc('https://rpc.invalid','eth_getBalance',['0x'+'11'.repeat(20),'latest']);
 assert.equal(ids.length,3);
 assert.equal(new Set(ids).size,ids.length);
});

test('strict wire envelope rejects wrong id, missing version and result mixed with error',async()=>{
 for(const body of [{jsonrpc:'2.0',id:999,result:'0x2105'},
  {id:1,result:'0x2105'},{jsonrpc:'2.0',id:1,result:'0x2105',error:{code:-32602}}]){
  const rpc=estrito({esperar:async()=>{},fetcher:(async()=>new Response(JSON.stringify(body))) as typeof fetch});
  await assert.rejects(rpc('https://rpc.invalid/secret','eth_chainId',[]),/resposta RPC invalida/);
 }
});
test('HTTP 5xx recovers within transport budget; method errors fail immediately with numeric code only',async()=>{
 let n=0;
 const rpc=estrito({esperar:async()=>{},fetcher:(async(_u,i)=>{
  if(++n<3)return new Response('private upstream body',{status:503});
  return new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(String(i?.body)).id,result:'0x2105'}));
 }) as typeof fetch});
 assert.equal(await rpc('a','eth_chainId',[]),'0x2105');assert.equal(n,3);
 let bad=0;
 const unsupported=estrito({esperar:async()=>{},fetcher:(async(_u,i)=>{
  bad++;return new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(String(i?.body)).id,
   error:{code:-32602,message:'SECRET'}}));
 }) as typeof fetch});
 await assert.rejects(unsupported('a','eth_getCode',[]),e=>e instanceof Error
  &&!e.message.includes('SECRET')&&(e as {rpcCode?:number}).rpcCode===-32602);
 assert.equal(bad,1);
});
