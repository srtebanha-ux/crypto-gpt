/** One director owns both route preflights; no second route after an uncertain tx. */
import type {MercadoDaApi} from './morphoApi';
import {avaliarELiquidarMorphoV3} from './titanMorphoV3Tiro';
import {avaliarELiquidarMorphoAero} from './titanMorphoAeroTiro';
export function bloqueioRotaMorphoV3(env:NodeJS.ProcessEnv):string|null {
 if(env.CACA_MORPHO_V3_AVALIAR==='0')return 'CACA_MORPHO_V3_AVALIAR=0: preflight V3 desabilitado';
 if(!env.CACA_MORPHO_V3_CONTRATO)return 'CACA_MORPHO_V3_CONTRATO ausente: informar executor TitanCacadorMorphoV3 implantado e verificado';
 return null;
}
type Entrada={mercado:MercadoDaApi;usuario:string;rpcUrl:string;signal?:AbortSignal};
type Resultado=Awaited<ReturnType<typeof avaliarELiquidarMorphoV3>>;
export type TentativaMorpho={via:'Uniswap V3'|'Aerodrome';resultado:Resultado;primeiroMotivo?:string};
export function rotasMorphoHabilitadas(env:NodeJS.ProcessEnv):boolean {
 return env.CACA_MORPHO_V3_AVALIAR!=='0'||
   (!!env.CACA_MORPHO_AERO_CONTRATO&&env.CACA_MORPHO_AERO_AVALIAR!=='0');
}
export type SondadoresMorpho={v3:typeof avaliarELiquidarMorphoV3;aero:typeof avaliarELiquidarMorphoAero};
/** A second DEX cannot repair a protocol-level rejection. Allow the
 * hot worker to scan next-block debtors instead of spending its single proof
 * slot for another 20s on the same healthy/unsizeable borrower.
 * A DEX route failure MUST still fall through to Aerodrome.
 */
export function recusaIndependenteDeRotaMorpho(status:string,motivo:string):boolean{
 return status==='inviavel'
   &&(motivo.includes('position is healthy')
     ||motivo.includes('garantia insuficiente para qualquer parcela segura de divida'));
}
let ocupado=false;
export async function avaliarSaidasMorpho(e:Entrada,env:NodeJS.ProcessEnv=process.env,
 sondadores:SondadoresMorpho={v3:avaliarELiquidarMorphoV3,aero:avaliarELiquidarMorphoAero}):Promise<TentativaMorpho>{
 if(ocupado)return{via:'Uniswap V3',resultado:{status:'descartada',motivo:'outro preflight Morpho ocupa a unica carteira'}};
 ocupado=true;
 try {
   let v3:Resultado={status:'descartada',motivo:bloqueioRotaMorphoV3(env)??'preflight V3 ainda nao executado'};
   if(env.CACA_MORPHO_V3_CONTRATO&&env.CACA_MORPHO_V3_AVALIAR!=='0')
     v3=await sondadores.v3(e,env);
   // Hash is a stop even if a future adapter returns an unexpected status.
   if(v3.hash||!['inviavel','descartada'].includes(v3.status)
     ||recusaIndependenteDeRotaMorpho(v3.status,v3.motivo))
     return{via:'Uniswap V3',resultado:v3};
   if(e.signal?.aborted||!env.CACA_MORPHO_AERO_CONTRATO||env.CACA_MORPHO_AERO_AVALIAR==='0')
     return{via:'Uniswap V3',resultado:v3};
   const aero=await sondadores.aero(e,env);
   return{via:'Aerodrome',resultado:aero,primeiroMotivo:v3.motivo};
 }finally{ocupado=false;}
}
