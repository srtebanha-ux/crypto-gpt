/**
 * TITAN: one owner / one nonce / two possible Morpho exit routes.
 * This module is shared by block-hot and the slower discovery radar.
 * A rejected simulation is never an order; both use full onchain proof.
 */
import type {MercadoDaApi} from './morphoApi';
import {avaliarELiquidarMorphoV3} from './titanMorphoV3Tiro';
import {avaliarELiquidarMorphoAero} from './titanMorphoAeroTiro';
type Entrada={mercado:MercadoDaApi;usuario:string;rpcUrl:string};
type Resultado=Awaited<ReturnType<typeof avaliarELiquidarMorphoV3>>;
export type TentativaMorpho={via:'Uniswap V3'|'Aerodrome';resultado:Resultado;primeiroMotivo?:string};
let ocupado=false;
export async function avaliarSaidasMorpho(e:Entrada,env:NodeJS.ProcessEnv=process.env):
 Promise<TentativaMorpho>{
 if(ocupado)return{via:'Uniswap V3',resultado:{
   status:'descartada',motivo:'outro preflight Morpho ocupa a unica carteira'}};
 ocupado=true;
 try {
   const v3=await avaliarELiquidarMorphoV3(e,env);
   if(v3.status!=='inviavel'||!env.CACA_MORPHO_AERO_CONTRATO)
     return {via:'Uniswap V3',resultado:v3};
   // The V3 call has no hash/broadcast, so and ONLY so can the alternative
   // attempt a fresh independent proof of the same borrower.
   const aero=await avaliarELiquidarMorphoAero(e,env);
   return {via:'Aerodrome',resultado:aero,primeiroMotivo:v3.motivo};
 }finally{ocupado=false;}
}
