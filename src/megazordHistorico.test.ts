import test from 'node:test';
import assert from 'node:assert/strict';
import {DisponibilidadeReal} from './disponibilidadeReal';
import * as conexoes from './conexoes';
import {Response} from 'undici';

test('a fully deferred history batch stops without claiming read coverage or querying remaining ranges',async()=>{
 const originalFetch=conexoes.buscar;
 const originalVerdict=DisponibilidadeReal.prototype.veredicto;
 const oldRpc=process.env.CACA_RPC_URL;
 let queries=0;
 try{
   process.env.CACA_RPC_URL='https://rpc.megazord.test';
   // Exercise the actual collector; replace only its external RPC boundary.
   (conexoes as {buscar:typeof conexoes.buscar}).buscar=(async(_url,options)=>{
     const request=JSON.parse(String(options?.body));
     assert.equal(request.method,'eth_getLogs');queries++;
     return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:[]}),
       {status:200,headers:{'content-type':'application/json'}});
   }) as typeof conexoes.buscar;
   DisponibilidadeReal.prototype.veredicto=function(provider,method){
     return {...originalVerdict.call(this,provider,method),podeVarrer:false};
   };
   const {varrerDevedores}=require('./cacarAoVivo') as typeof import('./cacarAoVivo');
   const result=await varrerDevedores(100000,1,{calada:true});
   assert.equal(queries,1,'only the initial capacity probe reached RPC');
   assert.equal(result.faixasLidas.length,0);
   assert.equal(result.devedores.length,0);
   assert.equal(result.faixasQueFalharam,5,'only the first concurrent batch was attempted');
 }finally{
   (conexoes as {buscar:typeof conexoes.buscar}).buscar=originalFetch;
   DisponibilidadeReal.prototype.veredicto=originalVerdict;
   if(oldRpc===undefined)delete process.env.CACA_RPC_URL;else process.env.CACA_RPC_URL=oldRpc;
 }
});
