/**
 * Quotes independentes do Aave/Aerodrome: somente leitura, jamais ordem de venda.
 * Router V2 da Aerodrome: getAmountsOut(uint256, Route[]).
 */
import Decimal from 'decimal.js';
import {getAddress,Interface} from 'ethers';

const ABI = new Interface([
  'function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)',
]);
export function quantiaParaCotacaoUsd(
  valorUsd:Decimal,precoAave8:Decimal|undefined,decimais:number|undefined,
):bigint|null{
  if(!precoAave8?.isFinite()||precoAave8.lessThanOrEqualTo(0)
    ||!valorUsd.isFinite()||valorUsd.lessThanOrEqualTo(0)
    ||decimais===undefined||!Number.isInteger(decimais)||decimais<0||decimais>36)return null;
  const cru=valorUsd.mul(new Decimal(10).pow(decimais)).mul(100_000_000).div(precoAave8).floor();
  if(!cru.isFinite()||cru.lessThanOrEqualTo(0))return null;
  return BigInt(cru.toFixed(0));
}
export function encodeQuoteAerodrome(
  quantidade:bigint,garantia:string,divida:string,fabrica:string,stable:boolean,
):string{
  if(quantidade<=0n)throw new Error('quantia invalida');
  return ABI.encodeFunctionData('getAmountsOut',[
    quantidade,[[getAddress(garantia),getAddress(divida),stable,getAddress(fabrica)]],
  ]);
}
export function decodeQuoteAerodrome(raw:string|null|undefined,entrada:bigint):bigint|null{
  if(!raw||!/^0x[0-9a-fA-F]+$/.test(raw)||entrada<=0n)return null;
  try{
    const retorno=ABI.decodeFunctionResult('getAmountsOut',raw)[0] as readonly bigint[];
    if(retorno.length!==2||BigInt(retorno[0])!==entrada)return null;
    const saida=BigInt(retorno[1]);
    return saida>0n?saida:null;
  }catch{return null;}
}
export function usdDoToken(quantia:bigint,precoAave8:Decimal|undefined,decimais:number|undefined):Decimal|null{
  if(quantia<0n||!precoAave8?.isFinite()||precoAave8.lessThanOrEqualTo(0)
    ||decimais===undefined||!Number.isInteger(decimais)||decimais<0||decimais>36)return null;
  return new Decimal(quantia.toString()).mul(precoAave8).div(new Decimal(10).pow(decimais)).div(100_000_000);
}
