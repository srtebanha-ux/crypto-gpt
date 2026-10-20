/**
 * TITAN Morpho Blue read-only risk radar.
 *
 * API is an index, never economic truth. The caller MUST compare all five
 * market params with idToMarketParams, then read oracle.price(), market() and
 * position() onchain. These calculations are only prioritization: Morpho
 * accrues interest at liquidation time, so even a position that looks unsafe
 * here still REQUIRES an actual executor eth_call before any transaction.
 */
export type RadarMorpho={
 situacao:'desconhecida'|'sem-divida'|'sem-garantia'|'segura'|'proxima'|'cruzou-estimado';
 dividaCrua:bigint|null;
 distanciaBps:bigint|null;
 motivo:string;
};
export const WAD_MORPHO=10n**18n;
export const ORACLE_SCALE_MORPHO=10n**36n;
// Official Morpho Blue SharesMathLib: 1e6 virtual shares and one virtual asset.
export const VIRTUAL_SHARES_MORPHO=1_000_000n;
export const VIRTUAL_ASSETS_MORPHO=1n;
function divCeil(n:bigint,d:bigint):bigint{
 if(n<0n||d<=0n)throw Error('unidades invalidas');
 return (n+d-1n)/d;
}
export function examinarSaudeMorpho(e:{
 borrowShares:bigint;collateral:bigint;
 totalBorrowAssets:bigint;totalBorrowShares:bigint;
 precoOracle:bigint;lltvWad:bigint;
 proximoBps?:bigint;
}):RadarMorpho{
 const unknown=(motivo:string):RadarMorpho=>({
  situacao:'desconhecida',dividaCrua:null,distanciaBps:null,motivo});
 const {borrowShares,collateral,totalBorrowAssets,totalBorrowShares,precoOracle,lltvWad}=e;
 if([borrowShares,collateral,totalBorrowAssets,totalBorrowShares,precoOracle,lltvWad]
    .some(x=>x<0n))return unknown('valor negativo');
 if(borrowShares===0n)return {situacao:'sem-divida',dividaCrua:0n,distanciaBps:null,motivo:'sem borrowShares'};
 if(totalBorrowShares===0n||totalBorrowAssets===0n)
  return unknown('totais do mercado indisponiveis: impossivel converter shares');
 if(precoOracle===0n||lltvWad===0n||lltvWad>=WAD_MORPHO)
  return unknown('oraculo ou LLTV invalido');
 if(collateral===0n)
  return {situacao:'sem-garantia',dividaCrua:null,distanciaBps:null,motivo:'sem garantia: liquidacao normal nao demonstrada'};
 // Morpho Blue SharesMathLib.toAssetsUp, including virtual shares/assets.
 const divida=divCeil(
  borrowShares*(totalBorrowAssets+VIRTUAL_ASSETS_MORPHO),
  totalBorrowShares+VIRTUAL_SHARES_MORPHO,
 );
 if(divida===0n)return unknown('divida convertida em zero');
 const limiteNumerador=collateral*precoOracle*lltvWad;
 const dividaNumerador=divida*ORACLE_SCALE_MORPHO*WAD_MORPHO;
 // Decimal-free bps; no overflow (JS BigInt). Negative means estimated
 // threshold already crossed under the sampled market state.
 const distancia=(limiteNumerador*10000n)/dividaNumerador-10000n;
 const perto=e.proximoBps??500n;
 if(perto<0n||perto>5000n)return unknown('limiar de proximidade invalido');
 const situacao=distancia<=0n?'cruzou-estimado'
   :distancia<=perto?'proxima':'segura';
 return {situacao,dividaCrua:divida,distanciaBps:distancia,
  motivo:situacao==='cruzou-estimado'
   ?'LIMIAR MATEMATICO estimado cruzado; exige eth_call liquidate com juros atuais'
   :situacao==='proxima'
   ?'proxima do limiar; nao autoriza liquidacao'
   :'garantia acima da divida ajustada ao LLTV'};
}
