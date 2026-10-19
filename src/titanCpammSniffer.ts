/**
 * CPAMM 2-pool sizing bridge: turns oriented human-unit reserves into
 * onchain-denominated BigInts and brings the analytic size into the EXISTING
 * scanner. It does NOT prove pool identity, fee-on-transfer behavior, atomic
 * repayment, gas L1 or viability. Even a positive result is only theoretical.
 *
 * A different size is selected only after re-evaluating it with the SAME
 * human-unit costs and the existing conservative calculation.
 */
import {Decimal} from 'decimal.js';
import {evaluateCycle,simulateCycle,type Hop,type FlashLoanCosts,type CycleEvaluation} from './ammMath';
import type {Cycle} from './dexGraph';
import {estimarTamanhoCicloCpamm,type PoolCpamm} from './titanTamanhoCpamm';

const FEE_SCALE=1000000000n; // fee fractions must be exact at 9 digits
export type ResultadoSementeCpamm={
 evaluation:CycleEvaluation;
 origem:'busca-decimal'|'semente-cpamm-bigint';
 sementeCrua:bigint|null;
 razaoRejeicao:string|null;
};

function taxaRetida(f:Decimal):bigint|null{
 if(!f.isFinite()||f.lt(0)||f.gte(1))return null;
 const out=new Decimal(1).minus(f).mul(FEE_SCALE.toString());
 if(!out.isInteger()||out.lte(0))return null;
 return BigInt(out.toFixed(0));
}
function paraRaw(val:Decimal,decimals:number):bigint|null{
 if(!Number.isInteger(decimals)||decimals<0||decimals>36
    ||!val.isFinite()||val.lte(0))return null;
 const raw=val.mul(new Decimal(10).pow(decimals));
 // Never round up a reserve or silently lose high-precision raw units.
 if(!raw.isInteger())return null;
 return BigInt(raw.toFixed(0));
}
function poolCpamm(hop:Hop,decEntrada:number,decSaida:number):PoolCpamm|null{
 const reservaEntrada=paraRaw(hop.reserveIn,decEntrada);
 const reservaSaida=paraRaw(hop.reserveOut,decSaida);
 const taxaNumerador=taxaRetida(hop.feeFraction);
 if(reservaEntrada===null||reservaSaida===null||taxaNumerador===null)return null;
 return {reservaEntrada,reservaSaida,taxaNumerador,taxaDenominador:FEE_SCALE};
}
/**
 * Never treat a CPAMM guess as a confirmed executable amount: the scanner
 * still calls its full eth_call for profitable candidates, and should reject
 * unsupported tokens/pools there before any sending.
 */
export function avaliarCicloComSementeCpamm(
 cycle:Cycle,hops:Hop[],maximo:Decimal,costs:FlashLoanCosts,
 decimalsByToken:Map<string,number>,
):ResultadoSementeCpamm{
 const baseline=evaluateCycle(hops,maximo,costs);
 const onlyBaseline=(why:string):ResultadoSementeCpamm=>({
  evaluation:baseline,origem:'busca-decimal',
  sementeCrua:null,razaoRejeicao:why
 });
 if(cycle.pools.length!==2||hops.length!==2||cycle.path.length!==3
    ||cycle.path[0].toLowerCase()!==cycle.path[2].toLowerCase())
  return onlyBaseline('Somente ciclos de 2 pools CPAMM orientadas');
 const decBase=decimalsByToken.get(cycle.path[0].toLowerCase());
 const decAlt=decimalsByToken.get(cycle.path[1].toLowerCase());
 if(decBase===undefined||decAlt===undefined)
  return onlyBaseline('Decimais de token desconhecidos');
 const first=poolCpamm(hops[0],decBase,decAlt);
 const second=poolCpamm(hops[1],decAlt,decBase);
 const ceiling=paraRaw(maximo,decBase);
 const feeN=costs.flashLoanFeeFraction.mul(FEE_SCALE.toString());
 if(!first||!second||ceiling===null||!feeN.isInteger()
   ||feeN.lt(0)||!costs.flashLoanFeeFraction.isFinite()
   ||!costs.gasCostInToken.isFinite()||costs.gasCostInToken.lt(0))
  return onlyBaseline('Reserva, fee, gas ou teto nao verificavel em unidades inteiras');
 const seed=estimarTamanhoCicloCpamm(first,second,ceiling,
  ceiling/100000n>0n?ceiling/100000n:1n,
  BigInt(feeN.toFixed(0)),FEE_SCALE);
 if(!seed)return onlyBaseline('Modelo CPAMM nao encontrou tamanho positivo');
 const amount=new Decimal(seed.tamanhoSugerido.toString())
  .div(new Decimal(10).pow(decBase));
 const gross=simulateCycle(amount,hops).minus(amount);
 const flashFee=amount.mul(costs.flashLoanFeeFraction);
 const net=gross.minus(flashFee).minus(costs.gasCostInToken);
 if(!net.isFinite()||net.lte(baseline.netProfit))
  return {...onlyBaseline('Semente nao supera busca existente'),
   sementeCrua:seed.tamanhoSugerido};
 const evaluation:CycleEvaluation={
  amountIn:amount,grossProfit:gross,flashLoanFee:flashFee,
  gasCost:costs.gasCostInToken,netProfit:net,profitable:net.gt(0)
 };
 return {evaluation,origem:'semente-cpamm-bigint',
  sementeCrua:seed.tamanhoSugerido,razaoRejeicao:null};
}
