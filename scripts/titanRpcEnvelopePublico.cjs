// Public read-only JSON-RPC envelope probe. No keys, no provider URLs in output.
const urls=[
 ['base_public','https://mainnet.base.org'],
 ['publicnode','https://base-rpc.publicnode.com'],
 ['llama','https://base.llamarpc.com'],
 ['one_rpc','https://1rpc.io/base'],
];
async function probe(name,url,method){
 const id=77;
 let status=null,body=null,reason=null;
 try{
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id,method,
    params:method==='eth_getBlockByNumber'?['latest',false]:[]}),
   signal:AbortSignal.timeout(10000)});
  status=r.status;body=await r.json().catch(()=>null);
 }catch{reason='transport_or_json_parse'}
 const ok=body&&typeof body==='object'&&!Array.isArray(body);
 return {provider:name,method,httpStatus:status,readableBody:!!ok,
  jsonrpcValid:ok?body.jsonrpc==='2.0':false,
  responseIdType:ok?typeof body.id:null,
  responseIdMatched:ok?body.id===id:false,
  responseIdStringEquivalent:ok?String(body.id)===String(id):false,
  hasResult:ok&&Object.hasOwn(body,'result'),
  hasError:ok&&Object.hasOwn(body,'error'),
  rpcErrorCode:ok&&typeof body.error?.code==='number'?body.error.code:null,
  reason};
}
(async()=>{
 const results=[];
 for(const [name,url] of urls){
  for(const method of ['eth_chainId','eth_getBlockByNumber']){
   results.push(await probe(name,url,method));
   await new Promise(r=>setTimeout(r,300));
  }
 }
 console.log(JSON.stringify({readOnly:true,results},null,2));
})().catch(()=>{process.exitCode=1});
