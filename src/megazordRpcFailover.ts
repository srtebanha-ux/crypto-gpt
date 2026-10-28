/** Select a SECOND independent Base RPC by the complete read-only preflight.
 * Never treat the primary as its own second witness for nonce or receipts.
 */
import {conferirRedeMegazord,FalhaLeituraRede} from './megazordPreflight';
type Preflight=(env:NodeJS.ProcessEnv)=>Promise<unknown>;
export function candidatosRpcSecundario(env:NodeJS.ProcessEnv):string[]{
 const input=[
  env.MEGAZORD_RPC_SECUNDARIO,
  ...(env.MEGAZORD_RPC_ALTERNATIVOS??'').split(','),
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://1rpc.io/base',
 ];
 const primary=env.MEGAZORD_RPC_URL?.trim().replace(/\/+$/,'');
 const seen=new Set<string>();
 const host=(u:string)=>{try{return new URL(u).hostname.toLowerCase();}catch{return '';}};
 const primaryHost=host(primary??'');
 return input.filter((u):u is string=>!!u)
   .map(u=>u.trim().replace(/\/+$/,''))
   .filter(u=>{
     // Security: no primary self-reference and no non HTTPS fallback.
     const hostname=host(u);
     if(!u.startsWith('https://')||!hostname||hostname===primaryHost||seen.has(hostname))return false;
     seen.add(hostname);return true;
   });
}
/** Retry only bounded transport/freshness faults; never weaken quorum, nonce,
 * wallet or bytecode checks. Reasons are allowlisted and never contain RPC URLs. */
function erroRpcSeguro(error:unknown):string{
 const m=error instanceof Error?error.message:'';
 if(/^RPC HTTP 429$/.test(m))return 'http429';
 if(/^RPC HTTP 5\d\d$/.test(m))return 'http5xx';
 if(/^RPC HTTP 4\d\d$/.test(m))return 'http4xx';
 if(m==='preflight RPC: transporte indisponivel')return 'transporte';
 // A valid HTTP reply can still contain a transient JSON-RPC error, often
 // caused by provider throttling; never interpret it as a successful read.
 if(m==='resposta RPC invalida')return 'resposta_rpc';
 const meth=m.match(/^resposta RPC invalida \[(eth_(?:chainId|getBlockByNumber|getTransactionCount|getBalance|getCode))\]$/);
 if(meth)return 'resposta_rpc_'+meth[1];
 if(/^RPC [01]: bloco ausente ou antigo$/.test(m))return 'bloco_antigo';
 if(m==='RPCs discordam sobre nonce/bloco')return 'divergencia_nonce_bloco';
 if(m==='configuracao publica incompleta')return 'configuracao_publica';
 if(/^RPC [01]: (nonce pendente|rede diferente da Base|destino sem bytecode valido|saldo de gas zerado)$/.test(m))
  return 'invariante_rejeitada';
 return 'outra_rejeicao';
}
export async function selecionarRpcSecundarioMegazord(
 env:NodeJS.ProcessEnv,
 preflight:Preflight=conferirRedeMegazord,
 esperar:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms)),
):Promise<unknown>{
 if(!env.MEGAZORD_RPC_URL)throw Error('RPC principal ausente');
 let attempted=0;
 const reasons:string[]=[];
 for(const secondary of candidatosRpcSecundario(env)){
   attempted++;
   for(let tentativa=0;tentativa<3;tentativa++){
     try{
       const result=await preflight({...env,MEGAZORD_RPC_SECUNDARIO:secondary});
       env.MEGAZORD_RPC_SECUNDARIO=secondary;
       return result;
     }catch(error){
       // The inner transport already exhausted bounded retries. Rotating the
       // secondary cannot repair a primary failure and only multiplies load.
       if(error instanceof FalhaLeituraRede){
         if([-32600,-32601,-32602].includes(error.detalhe.rpcCode??0))
           throw Error('preflight requisicao RPC invalida: sem envio');
         if(error.rpcIndex===0)throw Error('preflight principal bloqueado: '+error.message);
         reasons.push('secundario_'+attempted+'_'+error.detalhe.method+'_'+error.detalhe.categoria);
         break;
       }
       const kind=erroRpcSeguro(error);
       if(kind==='invariante_rejeitada'||kind==='divergencia_nonce_bloco')
         throw Error('preflight invariante financeira divergente: sem envio');
       reasons.push(kind);
       const retryable=new Set(['http429','http5xx','transporte','resposta_rpc','bloco_antigo','divergencia_nonce_bloco']);
       if(!(retryable.has(kind)||kind.startsWith('resposta_rpc_eth_'))||tentativa===2)break;
       await esperar(400*(tentativa+1));
     }
   }
 }
 const counts=Object.entries(reasons.reduce<Record<string,number>>((a,kind)=>{
  a[kind]=(a[kind]??0)+1;return a;
 },{})).map(([kind,n])=>kind+':'+n).join(',');
 throw Error('preflight bloqueado: '+attempted+
   ' RPCs secundarios independentes indisponiveis, sem fallback inseguro ao principal ['+counts+']');
}

/** Re-establish two independent witnesses when the configured PRIMARY is
 * unresponsive to block reads. No provider is ever its own witness; each pair
 * passes the complete nonce/block/balance/bytecode preflight before use.
 * This function never signs, broadcasts, or mutates persistent state.
 */
export async function selecionarParRpcMegazord(
 env:NodeJS.ProcessEnv,
 preflight:Preflight=conferirRedeMegazord,
 esperar:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms)),
):Promise<unknown>{
 if(!env.MEGAZORD_RPC_URL)throw Error('RPC principal ausente');
 const candidates=[env.MEGAZORD_RPC_URL,env.MEGAZORD_RPC_SECUNDARIO,
   ...(env.MEGAZORD_RPC_ALTERNATIVOS??'').split(','),
   'https://mainnet.base.org','https://1rpc.io/base'];
 const hosts=new Set<string>();
 const primaries:string[]=[];
 for(const candidate of candidates){
   if(!candidate?.startsWith('https://'))continue;
   try{
     const h=new URL(candidate).hostname.toLowerCase();
     if(!h||hosts.has(h))continue;
     hosts.add(h);primaries.push(candidate);
   }catch{/* unsafe URL is never used */}
   if(primaries.length===4)break;
 }
 let attempted=0;
 for(const primary of primaries){
   attempted++;
   const tmp:NodeJS.ProcessEnv={...env,MEGAZORD_RPC_URL:primary};
   try{
     const ready=await selecionarRpcSecundarioMegazord(tmp,preflight,esperar);
     env.MEGAZORD_RPC_URL=tmp.MEGAZORD_RPC_URL;
     env.MEGAZORD_RPC_SECUNDARIO=tmp.MEGAZORD_RPC_SECUNDARIO;
     return ready;
   }catch(error){
     const m=error instanceof Error?error.message:'';
     // Rotate ONLY after transport failure or exhaustion of independent
     // witnesses. Never use alternative providers to bypass nonce, chain,
     // ownership, gas, profitability or other invariant rejection.
     if(!m.startsWith('preflight principal bloqueado:')
       &&!m.startsWith('preflight bloqueado:'))throw error;
   }
 }
 throw Error('preflight bloqueado: '+attempted+
   ' primarios independentes indisponiveis para quorum de dois RPCs; sem envio');
}
