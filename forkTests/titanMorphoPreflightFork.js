require('ts-node/register');
const assert=require('node:assert/strict');
const http=require('node:http');
const {preflightMorpho}=require('../src/titanMorphoPreflight');

describe('Morpho V3: preflight de candidato real em fork Base',function(){
 this.timeout(180000);
 it('prepara calldata revalidada sem assinar, financiar ou transmitir',async()=>{
  // Deliberately fail, not skip or substitute a fabricated address, if unavailable.
  assert.match(process.env.ARB_BLOCO??'',/^\d+$/,'ARB_BLOCO historico obrigatorio');
  assert.ok(process.env.TITAN_PREFLIGHT_MERCADO,'mercado real obrigatorio');
  assert.ok(process.env.TITAN_PREFLIGHT_USUARIO,'devedor real obrigatorio');
  const allowed=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber',
   'eth_call','eth_estimateGas','eth_getCode','eth_getBalance','eth_getTransactionCount']);
  const calls=[];
  const server=http.createServer(async(req,res)=>{
   let body='';for await(const b of req)body+=b;
   try{
    const payload=JSON.parse(body);
    const run=async x=>{
     assert.ok(allowed.has(x.method),'RPC com efeito colateral proibido: '+x.method);
     calls.push(x.method);
     try{return{jsonrpc:'2.0',id:x.id,result:await hre.network.provider.send(x.method,x.params)};}
     catch(e){return{jsonrpc:'2.0',id:x.id,error:{code:-32000,message:e.message,data:e.data}};}
    };
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(Array.isArray(payload)?await Promise.all(payload.map(run)):await run(payload)));
   }catch{res.writeHead(400);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const proxy=process.env.HTTPS_PROXY;delete process.env.HTTPS_PROXY;
  try{
   const r=await preflightMorpho({...process.env,
    MEGAZORD_RPC_URL:'http://127.0.0.1:'+server.address().port});
   assert.equal(r.pronto,true,JSON.stringify(r));
   assert.ok(r.resultado.transacaoPreparada.data.startsWith('0x'));
   assert.ok(calls.includes('eth_estimateGas'));assert.ok(calls.includes('eth_call'));
   console.log(JSON.stringify(r));
  }finally{
   if(proxy!==undefined)process.env.HTTPS_PROXY=proxy;
   await new Promise(r=>server.close(r));
  }
 });
});
