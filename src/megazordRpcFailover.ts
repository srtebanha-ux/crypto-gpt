/** Select a SECOND independent Base RPC by the complete read-only preflight.
 * Never treat the primary as its own second witness for nonce or receipts.
 */
import {conferirRedeMegazord} from './megazordPreflight';
type Preflight=(env:NodeJS.ProcessEnv)=>Promise<unknown>;
export function candidatosRpcSecundario(env:NodeJS.ProcessEnv):string[]{
 const input=[
  env.MEGAZORD_RPC_SECUNDARIO,
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://1rpc.io/base',
 ];
 const primary=env.MEGAZORD_RPC_URL?.trim().replace(/\/+$/,'');
 const seen=new Set<string>();
 return input.filter((u):u is string=>!!u)
   .map(u=>u.trim().replace(/\/+$/,''))
   .filter(u=>{
     // Security: no primary self-reference and no non HTTPS fallback.
     if(!u.startsWith('https://')||u===primary||seen.has(u))return false;
     seen.add(u);return true;
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
       const kind=erroRpcSeguro(error);
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
