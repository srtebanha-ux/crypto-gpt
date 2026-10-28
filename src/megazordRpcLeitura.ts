/** Bounded read-only transport. No signing, broadcasts or upstream error text. */
type Rpc=(url:string,method:string,params:unknown[])=>Promise<unknown>;
type Opcoes={fetcher?:typeof fetch;esperar?:(ms:number)=>Promise<void>;agora?:()=>number};
const methods=new Set(['eth_chainId','eth_getBlockByNumber','eth_getTransactionCount',
 'eth_getBalance','eth_getCode']);
const MAX_RETRY_AFTER_MS=5000;

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
       if(cooldown>MAX_RETRY_AFTER_MS)throw Error('RPC HTTP 429');
       if(cooldown>0)await esperar(cooldown);
       // Serialize each endpoint independently; do not burst all readiness reads.
       await esperar(300);
       let response:Response;
       try{
         response=await fetcher(url,{method:'POST',headers:{'content-type':'application/json'},
           body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params}),
           signal:AbortSignal.timeout(10000)});
       }catch{throw Error('preflight RPC: transporte indisponivel');}
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
         if(attempt===2||delay>MAX_RETRY_AFTER_MS)throw Error('RPC HTTP 429');
         continue;
       }
       if(!response.ok)throw Error('RPC HTTP '+response.status);
       type RpcBody={result?:unknown;error?:unknown};
       let body:RpcBody|null=null;
       try{body=await response.json() as RpcBody;}catch{/* no upstream error text */}
       if(!body||typeof body!=='object'||body.error||body.result===undefined){
         // Providers sometimes send HTTP 200 containing temporary RPC errors.
         // Never accept these as valid onchain values: retry the same read
         // briefly, still bounded to three tries before the outer RPC failover.
         if(attempt===2)throw Error('resposta RPC invalida');
         await esperar(400*(attempt+1));
         continue;
       }
       return body.result;
     }
     throw Error('RPC HTTP 429');
   });
   queues.set(url,task);
   // Keep ordering for concurrent calls, without retaining completed URLs.
   void task.finally(()=>{if(queues.get(url)===task)queues.delete(url);}).catch(()=>{});
   return task;
 };
}
