/** Auditoria de candidatos Slipstream - NAO habilita novo executor. */
import {getAddress,Interface} from 'ethers';
export const EURC_BASE='0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';
export const USDC_BASE='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const POOL_CANDIDATO='0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7';
export const FABRICA_SLIPSTREAM='0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';
export const QUOTER_SLIPSTREAM='0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0';

const meta=new Interface([
 'function token0() view returns(address)',
 'function token1() view returns(address)',
 'function factory() view returns(address)',
 'function tickSpacing() view returns(int24)',
]);
const fabrica=new Interface([
 'function getPool(address tokenA,address tokenB,int24 tickSpacing) view returns(address pool)',
]);
const quoter=new Interface([
 'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
export const dadoPool=(metodo:'token0'|'token1'|'factory'|'tickSpacing')=>meta.encodeFunctionData(metodo,[]);
export const dadoFabricar=(tickSpacing:number)=>fabrica.encodeFunctionData('getPool',[EURC_BASE,USDC_BASE,tickSpacing]);
export const dadoQuoteSlipstream=(quantia:bigint,tickSpacing:number)=>{
 if(quantia<=0n||tickSpacing<=0||!Number.isInteger(tickSpacing)||tickSpacing>100000)throw new Error('parametros quoter invalidos');
 return quoter.encodeFunctionData('quoteExactInputSingle',[[EURC_BASE,USDC_BASE,quantia,tickSpacing,0]]);
};
export function decodificarMeta(metodo:'token0'|'token1'|'factory'|'tickSpacing',raw:string|null|undefined):string|number|null{
 try{
  if(!raw)return null;
  const [n]=meta.decodeFunctionResult(metodo,raw);
  if(metodo==='tickSpacing'){
    const v=Number(n);
    return Number.isSafeInteger(v)&&v>0&&v<=100000?v:null;
  }
  return getAddress(String(n));
 }catch{return null;}
}
export function decodificarPoolConfirmado(raw:string|null|undefined):string|null{
 try{
  if(!raw)return null;
  const [pool]=fabrica.decodeFunctionResult('getPool',raw);
  if(!pool||/^0x0{40}$/i.test(pool))return null;
  return getAddress(pool);
 }catch{return null;}
}
export function validaPoolSlipstream(p:{
 token0:string|null; token1:string|null; fabrica:string|null;
 espaco:number|null; confirmado:string|null;
}):boolean{
 try{
  if(!p.token0||!p.token1||!p.fabrica||!p.espaco||!p.confirmado)return false;
  const tokens=[getAddress(p.token0).toLowerCase(),getAddress(p.token1).toLowerCase()].sort();
  const esperados=[EURC_BASE.toLowerCase(),USDC_BASE.toLowerCase()].sort();
  return tokens[0]===esperados[0]&&tokens[1]===esperados[1]
    &&p.fabrica.toLowerCase()===FABRICA_SLIPSTREAM.toLowerCase()
    &&p.confirmado.toLowerCase()===POOL_CANDIDATO.toLowerCase();
 }catch{return false;}
}
export function decodificarQuoteSlipstream(raw:string|null|undefined):{
 saida:bigint;gasEstimate:bigint;
}|null{
 try{
  if(!raw)return null;
  const [saida,, , gas]=quoter.decodeFunctionResult('quoteExactInputSingle',raw);
  if(BigInt(saida)<=0n||BigInt(gas)<=0n)return null;
  return {saida:BigInt(saida),gasEstimate:BigInt(gas)};
 }catch{return null;}
}
