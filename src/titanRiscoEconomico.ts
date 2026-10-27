/** Piso dinâmico: custo irrecuperável de falhas + margem, sempre arredondado para cima. */
export interface RiscoEconomico {falhaMaxBps:bigint;margemBps:bigint;}
export function lerRiscoEconomico(env:NodeJS.ProcessEnv):RiscoEconomico|null {
 if(env.MEGAZORD_PISO_DINAMICO!=='1')return null;
 const fail=env.MEGAZORD_FALHA_MAX_BPS,margin=env.MEGAZORD_MARGEM_RISCO_BPS;
 if(!fail||!margin||!/^\d+$/.test(fail)||!/^\d+$/.test(margin))
  throw Error('piso dinamico exige limite de falha e margem de risco explicitos');
 const r={falhaMaxBps:BigInt(fail),margemBps:BigInt(margin)};
 if(r.falhaMaxBps>=10000n||r.margemBps<1n||r.margemBps>10000n)
  throw Error('parametros de risco fora dos limites');
 return r;
}
export function margemLiquidaDinamica(custo:bigint,r:RiscoEconomico):bigint {
 if(custo<=0n||r.falhaMaxBps<0n||r.falhaMaxBps>=10000n||r.margemBps<1n||r.margemBps>10000n)
  throw Error('risco ou custo invalido');
 const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
 // p*perda / (1-p): quanto cada sucesso deve pagar pelas tentativas falhas.
 // Usa o teto integral de gasto da tentativa como perda, sem inventar gas menor.
 return ceil(custo*r.falhaMaxBps,10000n-r.falhaMaxBps)+ceil(custo*r.margemBps,10000n);
}
