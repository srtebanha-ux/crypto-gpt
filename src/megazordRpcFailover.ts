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
export async function selecionarRpcSecundarioMegazord(
 env:NodeJS.ProcessEnv,
 preflight:Preflight=conferirRedeMegazord,
):Promise<unknown>{
 if(!env.MEGAZORD_RPC_URL)throw Error('RPC principal ausente');
 let attempted=0;
 for(const secondary of candidatosRpcSecundario(env)){
   attempted++;
   try{
     const result=await preflight({...env,MEGAZORD_RPC_SECUNDARIO:secondary});
     env.MEGAZORD_RPC_SECUNDARIO=secondary;
     return result;
   }catch{
     // Provider failures can contain API keys in their URLs; never log these.
   }
 }
 throw Error('preflight bloqueado: '+attempted+
   ' RPCs secundarios independentes indisponiveis, sem fallback inseguro ao principal');
}
