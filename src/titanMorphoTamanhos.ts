/**
 * Upper-bound for Morpho Blue repayment by collateral available,
 * including official max liquidation incentive.
 *
 * Only advisory sizing: actual amounts are checked inside Morpho.liquidate
 * during the COMPLETE executor eth_call; never authorizes a paid transaction.
 */
const WAD=10n**18n;
const ORACLE_SCALE=10n**36n;
const DIVIDERS=[64n,32n,16n,8n,4n,2n,1n] as const;
type Inputs=Readonly<{
  borrowShares:bigint; collateral:bigint; estimatedDebtAssets:bigint;
  oraclePrice:bigint; lltvWad:bigint;
}>;
export function tamanhosDeLiquidacaoMorpho(x:Inputs):bigint[]{
  const {borrowShares,collateral,estimatedDebtAssets,oraclePrice,lltvWad}=x;
  if([borrowShares,collateral,estimatedDebtAssets,oraclePrice].some(n=>n<=0n)
      ||lltvWad<=0n||lltvWad>=WAD)return [];
  // Morpho Blue: min(1.15,1/(1-0.3*(1-LLTV))) liquidation incentive.
  const denominator=WAD-(3n*(WAD-lltvWad)/10n);
  if(denominator<=0n)return [];
  const lif=(WAD*WAD)/denominator;
  const lifBound=lif>1150000000000000000n?1150000000000000000n:lif;
  if(lifBound<=0n)return [];
  const collateralValue=(collateral*oraclePrice)/ORACLE_SCALE;
  const repayCap=(collateralValue*WAD)/lifBound;
  // Conservative 5% reserve for interest accrual, rounding and oracle drift.
  const maximumShares=(
    borrowShares*repayCap*95n/(estimatedDebtAssets*100n)
  );
  const safeFull=borrowShares*95n/100n;
  const cap=maximumShares<safeFull?maximumShares:safeFull;
  if(cap<=0n)return [];
  const seen=new Set<string>();
  const result:bigint[]=[];
  for(const divisor of DIVIDERS){
    const shares=cap/divisor;
    if(shares>0n&&!seen.has(shares.toString())){
      seen.add(shares.toString());result.push(shares);
    }
  }
  return result;
}
