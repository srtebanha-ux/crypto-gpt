import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticarFioRpcMegazord} from './megazordRpcWireDiagnostico';
test('wire probe emits metadata only, never endpoint secrets or upstream bodies',async()=>{
 const privateUrl='https://private.example/SECRET-URL';
 const upstreamSecret='SECRET-BODY-DO-NOT-LOG';
 const fetcher=(async(_url:string,opts:RequestInit)=>{
   const m=JSON.parse(String(opts.body)) as {id:number;method:string};
   if(m.method==='eth_chainId')
     return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,result:'0x2105',secret:upstreamSecret}),
       {status:200,headers:{'content-type':'application/json'}});
   return new Response('<html>'+upstreamSecret+'</html>',{status:200,headers:{'content-type':'text/html'}});
 }) as typeof fetch;
 const report=await diagnosticarFioRpcMegazord({
  MEGAZORD_RPC_URL:privateUrl,
  MEGAZORD_RPC_SECUNDARIO:'https://private.example/another-secret',
 },fetcher);
 assert.equal(report.somenteLeitura,true);
 assert.equal(report.probes.length,4);
 assert.equal(report.probes[0].idMatch,true);
 assert.equal(report.probes[1].mime,'html');
 assert.equal(report.probes[1].json,false);
 const printed=JSON.stringify(report);
 assert.doesNotMatch(printed,/SECRET-URL|another-secret|SECRET-BODY-DO-NOT-LOG/);
});
