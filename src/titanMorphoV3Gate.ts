import {contextoExecutorMegazord} from './megazordExecutor';
/**
 * Morpho V3 - policy and economic gate. No RPC, keys or side effects.
 * The solver can only spend gas when an entire transaction was simulated.
 */
export type MorphoV3Policy = Readonly<{
  armed:boolean; maxGas:bigint; maxCostWei:bigint; tipWei:bigint;
  minReturnBps:bigint; minNetWethWei:bigint; maxAgeBlocks:number;
}>;
function positiveBigInt(s:string|undefined,defaultValue:string,max:bigint):bigint{
  const x=s===undefined?defaultValue:s;
  if(!/^[0-9]+$/.test(x))throw Error('gas policy must be a nonnegative integer');
  const v=BigInt(x);
  if(v<=0n||v>max)throw Error('gas policy outside capped range');
  return v;
}
export function politicaMorphoV3(
  env:NodeJS.ProcessEnv=process.env,
):MorphoV3Policy{
  return {
    // CACA Aave and Morpho MUST NOT sign simultaneously with one wallet.
    armed:env.CACA_MORPHO_V3_ENVIAR==='1'
      &&env.CACA_MORPHO_V3_CONFIRMAR==='OPERAR_MORPHO_BASE'
      &&env.CACA_MORPHO_V3_NONCE_EXCLUSIVO==='1'
      &&(env.CACA_ENVIAR!=='1'||contextoExecutorMegazord()),
    maxGas:positiveBigInt(env.CACA_MORPHO_V3_GAS_MAX,'1200000',2000000n),
    maxCostWei:positiveBigInt(env.CACA_MORPHO_V3_CUSTO_MAX_WEI,'500000000000000',2000000000000000n),
    tipWei:positiveBigInt(env.CACA_MORPHO_V3_TIP_WEI,'20000000',3000000000n),
    minReturnBps:positiveBigInt(env.CACA_MORPHO_V3_RETORNO_BPS,'12000',20000n),
    minNetWethWei:positiveBigInt(env.CACA_MORPHO_V3_LUCRO_MIN_WETH_WEI,'1',
      10000000000000000n)-1n,
    maxAgeBlocks:3,
  };
}
/** Aero can be observed and armed independently; still one shared signer/nonce gate. */
export function politicaMorphoAero(env:NodeJS.ProcessEnv=process.env):MorphoV3Policy{
 return politicaMorphoV3({...env,
   CACA_MORPHO_V3_ENVIAR:env.CACA_MORPHO_AERO_ENVIAR,
   CACA_MORPHO_V3_CONFIRMAR:env.CACA_MORPHO_AERO_CONFIRMAR,
   CACA_MORPHO_V3_NONCE_EXCLUSIVO:env.CACA_MORPHO_AERO_NONCE_EXCLUSIVO,
 });
}
/** Admission to read-only full liquidation, never a broadcast authorization. */
export function candidatoElegivelV3(situacao:string,mercadoConfirmado:boolean):boolean{
  return (situacao==='cruzou-estimado'||situacao==='proxima')&&mercadoConfirmado;
}
export function custoConservadorMorphoV3(
  gasEstimado:bigint,baseFee:bigint,tipWei:bigint,l1Fee:bigint,policy:MorphoV3Policy,
):{gasLimit:bigint;maxFee:bigint;custo:bigint}{
  if([gasEstimado,baseFee,tipWei,l1Fee].some(x=>x<=0n))
    throw Error('gas or L1 unavailable');
  const gasLimit=gasEstimado+gasEstimado/5n;
  if(gasLimit>policy.maxGas)throw Error('gas exceeds cap');
  const maxFee=baseFee*2n+tipWei;
  const custo=gasLimit*maxFee+2n*l1Fee;
  if(custo>policy.maxCostWei)throw Error('cost exceeds shot budget');
  return {gasLimit,maxFee,custo};
}
export function pisoEconomicoMorphoV3(
  lucroEmToken:bigint,pisoEmWeth:bigint,custoWei:bigint,policy:MorphoV3Policy,
):{pisoToken:bigint;aprovado:boolean}{
  // No approval without WETH conversion of the actual enforceable token floor.
  if(lucroEmToken<=1n||pisoEmWeth<=0n||custoWei<=0n)
    return {pisoToken:0n,aprovado:false};
  const pisoToken=(lucroEmToken*80n)/100n;
  // Net threshold is in WETH, NOT USD. It is evaluated on the enforceable
  // profit floor (after the 20% haircut), after the full L1/L2 gas bound.
  return{pisoToken,aprovado:pisoToken>0n
    &&pisoEmWeth>custoWei
    &&pisoEmWeth-custoWei>=policy.minNetWethWei
    &&pisoEmWeth*10000n>=custoWei*policy.minReturnBps};
}
