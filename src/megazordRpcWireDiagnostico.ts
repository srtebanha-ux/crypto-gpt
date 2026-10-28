/** Safe in-container wire probe for Base RPC. Only logs fixed-schema metadata.
 * Never prints endpoint URLs, credentials, RPC bodies, response text or headers.
 * Runs before signer load and does not mutate env, wallets or persistent data.
 */
type Probe={endpoint:string;method:string;http?:number;mime?:string;bytes?:number;
 json?:boolean;envelope?:boolean;idMatch?:boolean;resultPresent?:boolean;
 resultNull?:boolean;errorCode?:number|null;issue?:string;firstKind?:string;
 lastKind?:string;invalidUnicode?:boolean;parseProblem?:string;
 reportedLength?:number;compressed?:boolean};
function mimeType(value:string|null):string{
 const s=(value??'').toLowerCase();
 return s.includes('json')?'json':s.includes('html')?'html':
   s.startsWith('text/')?'text':s===''?'absent':'other';
}
export async function diagnosticarFioRpcMegazord(env:NodeJS.ProcessEnv,
 fetcher:typeof fetch=fetch):Promise<{somenteLeitura:true;probes:Probe[]}>{
 const input:[string,string|undefined][]=[
  ['principal',env.MEGAZORD_RPC_URL],
  ['secundario',env.MEGAZORD_RPC_SECUNDARIO],
  ['publicnode','https://base-rpc.publicnode.com'],
 ];
 const used=new Set<string>(),probes:Probe[]=[];
 for(const [name,uri] of input){
   if(!uri)continue;
   let host:string;
   try{const u=new URL(uri);host=u.hostname.toLowerCase();
     if(u.protocol!=='https:'||!host||used.has(host))continue;
   }catch{continue}
   used.add(host);
   for(const method of ['eth_chainId','eth_getBlockByNumber']){
     const p:Probe={endpoint:name,method};
     const id=1417;
     try{
       const res=await fetcher(uri,{method:'POST',
         headers:{'content-type':'application/json','accept':'application/json',
           'accept-encoding':'identity'},
         body:JSON.stringify({jsonrpc:'2.0',id,method,
           params:method==='eth_chainId'?[]:['latest',false]}),
         signal:AbortSignal.timeout(6000)});
       p.http=res.status;
       p.mime=mimeType(res.headers.get('content-type'));
       // Cap bytes; do not print or persist content.
       const raw=await res.text();
       p.bytes=raw.length;
       const trimmed=raw.trim();
       const kind=(v:string):string=>v==='{ '?'object':
         v==='{'?'object':v==='['?'array':v==='<'?'html':v==='}'?'object_end':
         v===']'?'array_end':v===''?'empty':'other';
       p.firstKind=kind(trimmed.slice(0,1));
       p.lastKind=kind(trimmed.slice(-1));
       p.invalidUnicode=raw.includes('\uFFFD');
       const len=res.headers.get('content-length');
       if(len&&/^\\d+$/.test(len))p.reportedLength=Number(len);
       p.compressed=!!res.headers.get('content-encoding');
       let data:unknown=null;
       try{data=JSON.parse(raw);p.json=true;}
       catch(e){
         p.json=false;
         const m=e instanceof Error?e.message:'';
         p.parseProblem=/end of JSON|Unterminated|Unexpected end/i.test(m)?
           'truncated_or_unterminated':/after JSON/i.test(m)?
           'trailing_content':/Unexpected token|Expected/i.test(m)?
           'invalid_syntax':'unknown_syntax';
       }
       if(data!==null&&typeof data==='object'&&!Array.isArray(data)){
         const obj=data as Record<string,unknown>;
         p.envelope=obj.jsonrpc==='2.0';
         p.idMatch=obj.id===id;
         p.resultPresent=Object.prototype.hasOwnProperty.call(obj,'result');
         p.resultNull=obj.result===null;
         const error=obj.error;
         p.errorCode=error&&typeof error==='object'
           &&typeof (error as {code?:unknown}).code==='number'
           ?(error as {code:number}).code:null;
       }else {p.envelope=false;p.idMatch=false;p.resultPresent=false;}
     }catch{p.issue='transport_or_read_failure';}
     probes.push(p);
   }
 }
 return {somenteLeitura:true,probes};
}
