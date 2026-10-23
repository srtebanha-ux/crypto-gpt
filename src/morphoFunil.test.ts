import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {enumerarDevedores,TransporteHttp} from './morphoApi';
import {CursoresMorpho} from './morphoCursores';
import {OrcamentoHttp} from './canais';
import {abrirSnapshotMorpho} from './morphoDescobertaRpc';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {avaliarSaidasMorpho,rotasMorphoHabilitadas,SondadoresMorpho} from './titanMorphoDiretorDeRota';
import {planejarRotasMorphoV3,planejarRotasMorphoAero,PONTES_MORPHO,combinarSondasMorpho} from './titanMorphoRotas';
import type {MercadoDaApi} from './morphoApi';
const endereco=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const market='0x'+'a'.repeat(64);
const semSono=async()=>{};

test('quarta pagina e devedores pequenos sobrevivem a reinicio sem exceder tres pedidos por rodada',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'morpho-cursor-'));
 try{
  const skips:number[]=[];
  const buscar:TransporteHttp=async(_,o)=>{
   const {skip,first}=JSON.parse(o!.body!).variables as {skip:number;first:number};skips.push(skip);
   const items=Array.from({length:Math.min(first,8-skip)},(_,i)=>({user:{address:endereco(skip+i+1)},state:{borrowShares:'10'}}));
   return{status:200,text:async()=>JSON.stringify({data:{marketPositions:{items}}})};
  };
  const arquivo=path.join(dir,'cursor.json');
  const c=new CursoresMorpho(arquivo);await c.carregar();
  const primeira=await enumerarDevedores(buscar,market,{porPagina:2,tetoDePaginas:3,dormir:semSono});
  await c.guardar(market,primeira.proximo,primeira.devedores);
  assert.equal(primeira.requisicoes,3);assert.equal(primeira.proximo,6);
  const reinicio=new CursoresMorpho(arquivo);await reinicio.carregar();
  assert.equal(reinicio.obter(market).proximo,6);
  const segunda=await enumerarDevedores(buscar,market,{inicio:6,porPagina:2,tetoDePaginas:3,dormir:semSono});
  await reinicio.guardar(market,segunda.proximo,segunda.devedores);
  assert.ok(segunda.devedores.some(d=>d.endereco===endereco(7)));
  assert.equal(reinicio.obter(market).devedores.length,8);
  assert.equal(reinicio.obter(market).proximo,0);
  assert.deepEqual(skips,[0,2,4,6,8]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('teto compartilhado e cancelamento impedem novas paginas e conservam cursor da falha',async()=>{
 const budget=new OrcamentoHttp(2,1000);let pedidos=0;
 const buscar:TransporteHttp=async(_,o)=>{pedidos++;
  const skip=JSON.parse(o!.body!).variables.skip as number;
  return{status:200,text:async()=>JSON.stringify({data:{marketPositions:{items:[{user:{address:endereco(skip+1)}}]}}})};
 };
 const r=await enumerarDevedores(buscar,market,{porPagina:1,tetoDePaginas:8,orcamento:budget,dormir:semSono});
 assert.equal(pedidos,2);assert.equal(r.proximo,2);assert.equal(r.completa,false);
 await enumerarDevedores(buscar,market,{orcamento:budget});assert.equal(pedidos,2);
 const erro=await enumerarDevedores(async()=>({status:429,text:async()=>''}),market,{inicio:700});
 assert.equal(erro.proximo,700);
});
test('deadline aborta o transporte em voo sem depender de outra chamada pedir',async()=>{
 const b=new OrcamentoHttp(100,20);let cancelou=false;
 const transporte:TransporteHttp=async(_,o)=>new Promise((_,reject)=>{
  o!.signal!.addEventListener('abort',()=>{cancelou=true;reject(Error('aborted'));},{once:true});
 });
 // Keep the test alive; production sockets provide the event-loop handle.
 const hold=setTimeout(()=>{},1000);
 try{const r=await enumerarDevedores(transporte,market,{orcamento:b});
  assert.equal(cancelou,true);assert.equal(r.proximo,0);assert.equal(r.requisicoes,1);
 }finally{clearTimeout(hold);}
});
test('fallback confirma secundario, rejeita candidato nao canonico e fixa snapshot',async()=>{
 const chamadas:Array<{url:string;method:string;params:unknown[]}>=[];
 const snap=await abrirSnapshotMorpho(['falha','bom'],[endereco(99),MORPHO_FLASH_BASE],async(url,method,params)=>{
  chamadas.push({url,method,params});if(url==='falha')throw Error('offline');
  if(method==='eth_chainId')return'0x2105';
  if(method==='eth_getCode')return'0xcafe';
  if(method==='eth_getBlockByNumber')return{number:'0x123',hash:'0x'+'b'.repeat(64)};
  if(method==='eth_call')return'0x1234';throw Error(method);
 },code=>code==='0xcafe');
 assert.ok(snap);assert.equal(snap.url,'bom');assert.equal(await snap.chamar('0xab'),'0x1234');
 assert.equal(chamadas.find(x=>x.method==='eth_call')?.params[1],'0x123');
 assert.ok(chamadas.filter(x=>x.method==='eth_getCode').every(x=>x.params[0]===MORPHO_FLASH_BASE.toLowerCase()));
});
test('fallback durante leitura recusa chain ou hash divergente, sem misturar snapshots',async()=>{
 let primaryDown=false;
 const snap=await abrirSnapshotMorpho(['p','wrong-chain','wrong-hash','s'],[],async(url,m)=>{
  if(url==='p'&&primaryDown)throw Error('offline');
  if(m==='eth_chainId')return url==='wrong-chain'?'0x1':'0x2105';
  if(m==='eth_getCode')return'0xcafe';
  if(m==='eth_getBlockByNumber')return{number:'0x123',hash:'0x'+(url==='wrong-hash'?'a':'b').repeat(64)};
  if(m==='eth_call'){assert.equal(url,'s');return'0xbeef';}throw Error(m);
 },()=>true);
 primaryDown=true;assert.equal(await snap!.chamar('0xab'),'0xbeef');
});
const entrada={mercado:{} as MercadoDaApi,usuario:endereco(1),rpcUrl:'http://teste'};
test('Aero e independente de V3 ausente/desabilitado e mutex recusa concorrente',async()=>{
 let v3=0,aero=0;let sair!:()=>void;
 const env={CACA_MORPHO_V3_AVALIAR:'0',CACA_MORPHO_AERO_CONTRATO:endereco(1)};
 const sondadores:SondadoresMorpho={v3:async()=>{v3++;throw Error('nao deve chamar');},aero:async()=>{
  aero++;await new Promise<void>(r=>{sair=r;});return{status:'aprovada-simulada',motivo:'simulada'};
 }};
 assert.equal(rotasMorphoHabilitadas(env),true);
 const primeiro=avaliarSaidasMorpho(entrada,env,sondadores);
 await new Promise(r=>setImmediate(r));
 const segundo=await avaliarSaidasMorpho(entrada,env,sondadores);assert.equal(segundo.resultado.status,'descartada');
 sair();assert.equal((await primeiro).via,'Aerodrome');assert.equal(v3,0);assert.equal(aero,1);
});
test('hash, inclusao desconhecida e aprovacao simulada impedem segunda rota',async()=>{
 for(const resultado of [
  {status:'desconhecida' as const,motivo:'incerta'},
  {status:'inviavel' as const,motivo:'incerta',hash:'0xabc'},
  {status:'aprovada-simulada' as const,motivo:'ok'},
 ]){
  let aero=0;
  await avaliarSaidasMorpho(entrada,{CACA_MORPHO_V3_CONTRATO:endereco(1),CACA_MORPHO_AERO_CONTRATO:endereco(2)},
   {v3:async()=>resultado,aero:async()=>{aero++;throw Error('nao deve chamar');}});
  assert.equal(aero,0);
 }
});
test('planner acha rota indireta sem direta; contrato antigo nao recebe multihop',async()=>{
 const a=endereco(1),b=endereco(2),meio=PONTES_MORPHO[0];
 const pool=async(x:string,y:string,f:number)=>f===500&&((x===a&&y===meio)||(x===meio&&y===b));
 const rotas=await planejarRotasMorphoV3(a,b,true,pool,async()=>true);
 assert.equal(rotas.length,1);assert.equal(rotas[0]!.path.length,134);assert.deepEqual(rotas[0]!.tokens,[a,meio,b]);
 assert.deepEqual(await planejarRotasMorphoV3(a,b,false,pool,async()=>true),[]);
 assert.deepEqual(await planejarRotasMorphoV3(a,b,true,pool,async()=>false),[]);
 const aero=await planejarRotasMorphoAero(a,b,endereco(3),true,
  async(x,y,s)=>!s&&((x===a&&y===meio)||(x===meio&&y===b)),async()=>true);
 assert.equal(aero[0]!.length,2);
 assert.ok(combinarSondasMorpho(rotas,[1n,2n,3n,4n,5n],true).length<=4);
});

test('provider cancela socket em voo e nao inicia pedidos apos deadline',async()=>{
 const {createServer}=await import('node:http');
 const {ProviderMorphoRpc}=await import('./morphoProvider');
 let recebidas=0,fechada=false;
 let chegou!:()=>void;const inicio=new Promise<void>(r=>{chegou=r;});
 const server=createServer((req,res)=>{recebidas++;chegou();res.on('close',()=>{fechada=true;});req.resume();});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as {port:number}).port;
 const proxy=process.env.HTTPS_PROXY;delete process.env.HTTPS_PROXY;
 const abort=new AbortController();const provider=new ProviderMorphoRpc(`http://127.0.0.1:${port}`,abort.signal);
 if(proxy!==undefined)process.env.HTTPS_PROXY=proxy;
 try{
  const primeira=provider._send({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]});
  const rejeita=assert.rejects(primeira);
  await inicio;abort.abort();await rejeita;
  await assert.rejects(()=>provider._send({jsonrpc:'2.0',id:2,method:'eth_blockNumber',params:[]}));
  await new Promise(r=>setTimeout(r,10));
  assert.equal(recebidas,1);assert.equal(fechada,true);
 }finally{provider.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
