/** Bounded read-only transport. No signing, broadcasts or upstream error text. */
type Rpc=(url:string,method:string,params:unknown[])=>Promise<unknown>;
type Opcoes={fetcher?:typeof fetch;esperar?:(ms:number)=>Promise<void>;agora?:()=>number};
const methods=new Set(['eth_chainId','eth_getBlockByNumber','eth_getTransactionCount',
 'eth_getBalance','eth_getCode']);
const MAX_RETRY_AFTER_MS=5000;
export class FalhaRpcLeitura extends Error {
 constructor(message:string,readonly method:string,readonly categoria:string,
   readonly tentativas:number,readonly rpcCode?:number){super(message);}
}


export function criarRpcPreflight({fetcher=fetch,
 esperar=ms=>new Promise(r=>setTimeout(r,ms)),agora=Date.now}:Opcoes={}):Rpc{
 const queues=new Map<string,Promise<unknown>>();
 let requestId=0;
 const notBefore=new Map<string,number>();
 return (url,method,params)=>{
   if(!methods.has(method))return Promise.reject(Error('metodo fora do preflight somente leitura'));
   const previous=queues.get(url)??Promise.resolve();
   const task=previous.catch(()=>{}).then(async()=>{
     for(let attempt=0;attempt<3;attempt++){
       const cooldown=(notBefore.get(url)??0)-agora();
       if(cooldown>MAX_RETRY_AFTER_MS)throw new FalhaRpcLeitura('RPC HTTP 429',method,'http429',attempt);
       if(cooldown>0)await esperar(cooldown);
       // Serialize each endpoint independently; do not burst all readiness reads.
       await esperar(300);
       let response:Response;
       const id=++requestId;
       try{
         response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},
           body:JSON.stringify({jsonrpc:'2.0',id,method,params}),
           signal:AbortSignal.timeout(10000)});
       }catch{
         if(attempt<2){await esperar(400*(attempt+1));continue;}
         throw new FalhaRpcLeitura('preflight RPC: transporte indisponivel',method,'transporte',attempt+1);
       }
       if(response.status===429){
         const header=response.headers.get('retry-after');
         let delay=300*(attempt+1);
         if(header!==null){
           if(/^\d+(?:\.\d+)?$/.test(header.trim()))delay=Math.ceil(Number(header)*1000);
           else{
             const date=Date.parse(header);
             if(Number.isFinite(date))delay=Math.max(0,date-agora());
           }
         }
         // Release response resources before a bounded retry. Never shorten a
         // server cooldown to fit the budget; fail over instead of hammering it.
         try{await response.body?.cancel();}catch{/* no payload in diagnostics */}
         notBefore.set(url,agora()+delay);
         if(attempt===2||delay>MAX_RETRY_AFTER_MS)throw new FalhaRpcLeitura('RPC HTTP 429',method,'http429',attempt+1);
         continue;
       }
       if(!response.ok){
         try{await response.body?.cancel();}catch{}
         if(response.status>=500&&response.status<=599&&attempt<2){await esperar(400*(attempt+1));continue;}
         throw new FalhaRpcLeitura('RPC HTTP '+response.status,method,
           response.status>=500?'http5xx':'http4xx',attempt+1);
       }
       type RpcBody={jsonrpc?:unknown;id?:unknown;result?:unknown;error?:{code?:unknown}};
       let body:RpcBody|null=null;
       try{body=await response.json() as RpcBody;}catch{/* never log upstream bodies */}
       const code=typeof body?.error?.code==='number'&&Number.isSafeInteger(body.error.code)?body.error.code:undefined;
       const envelope=!!body&&typeof body==='object'&&!Array.isArray(body)
         &&body.jsonrpc==='2.0'&&body.id===id;
       if(!envelope||body!.error!==undefined||body!.result===undefined||body!.result===null){
         const permanent=code===-32600||code===-32601||code===-32602;
         const category=!envelope?'envelope':code!==undefined?'jsonrpc_'+code:'resultado_ausente';
         if(attempt===2||permanent)throw new FalhaRpcLeitura('resposta RPC invalida ['+method+']',method,category,attempt+1,code);
         await esperar(400*(attempt+1));continue;
       }
       return body!.result;
     }
     throw Error('RPC HTTP 429');
   });
   queues.set(url,task);
   // Keep ordering for concurrent calls, without retaining completed URLs.
   void task.finally(()=>{if(queues.get(url)===task)queues.delete(url);}).catch(()=>{});
   return task;
 };
}
