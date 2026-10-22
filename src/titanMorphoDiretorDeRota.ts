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

/**
 * Only a conclusive no-send V3 outcome may try the Aero exit.
 * A missing V3 contract is not a reason to disable an otherwise configured
 * Aero executor. Never fall back after a broadcast, receipt or uncertain tx.
 */
export function deveTentarSaidaAero(v3:Pick<Resultado,'status'|'motivo'>,
  env:NodeJS.ProcessEnv=process.env):boolean{
  if(!env.CACA_MORPHO_AERO_CONTRATO)return false;
  if(v3.status==='inviavel')return true;
  return v3.status==='descartada'
    && !env.CACA_MORPHO_V3_CONTRATO
    && v3.motivo==='executor V3, carteira ou identificacao publica indisponivel';
}

export async function avaliarSaidasMorpho(e:Entrada,env:NodeJS.ProcessEnv=process.env):
 Promise<TentativaMorpho>{
 if(ocupado)return{via:'Uniswap V3',resultado:{
   status:'descartada',motivo:'outro preflight Morpho ocupa a unica carteira'}};
 ocupado=true;
 try {
   const v3=await avaliarELiquidarMorphoV3(e,env);
   if(!deveTentarSaidaAero(v3,env))
     return {via:'Uniswap V3',resultado:v3};
   // There was no V3 broadcast: evaluate Aero from scratch with its own full
   // onchain proof, gas cap and economic floor before any authorization.
   const aero=await avaliarELiquidarMorphoAero(e,env);
   return {via:'Aerodrome',resultado:aero,primeiroMotivo:v3.motivo};
 }finally{ocupado=false;}
}
