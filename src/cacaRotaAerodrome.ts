/**
 * Aerodrome Base factory getPool(tokenA, tokenB, stable): diagnóstico de rota.
 * NUNCA substitua validação de liquidez/amountOut por existência do pool.
 */
import {Interface, getAddress} from 'ethers';
const abi=new Interface(['function getPool(address tokenA,address tokenB,bool stable) view returns (address pool)']);
export function dadosGetPoolAerodrome(tokenA:string,tokenB:string,stable:boolean):string{
 return abi.encodeFunctionData('getPool',[getAddress(tokenA),getAddress(tokenB),stable]);
}
export function lerPoolAerodrome(hex:string):string|null{
 try{
  const [pool]=abi.decodeFunctionResult('getPool',hex);
  if(typeof pool!=='string'||/^0x0{40}$/i.test(pool))return null;
  return getAddress(pool);
 }catch{return null}
}
export type RotaObservada='nenhuma'|'apenas-estavel'|'apenas-volatil'|'ambas';
export function classificarRota(poolEstavel:string|null,poolVolatil:string|null):RotaObservada{
 if(poolEstavel&&poolVolatil)return 'ambas';
 if(poolEstavel)return 'apenas-estavel';
 if(poolVolatil)return 'apenas-volatil';
 return 'nenhuma';
}
