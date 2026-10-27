import {lerRiscoEconomico} from './titanRiscoEconomico';
/** Base Uniswap V3 WETH/USDC 30-minute TWAP. No signing or paid calls. */
import Decimal from 'decimal.js';
import {Interface,JsonRpcProvider,getAddress} from 'ethers';
import {FABRICA_V3_BASE,POOLS_V3_BASE_CACA} from './titanPonteMultiHop';
const WETH='0x4200000000000000000000000000000000000006';
const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const POOL=POOLS_V3_BASE_CACA[0]!.endereco;
const poolAbi=new Interface([
 'function token0() view returns(address)',
 'function token1() view returns(address)',
 'function factory() view returns(address)',
 'function fee() view returns(uint24)',
 'function liquidity() view returns(uint128)',
 'function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
 'function observe(uint32[] secondsAgos) view returns(int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)',
]);
const factoryAbi=new Interface(['function getPool(address,address,uint24) view returns(address)']);
const D=Decimal.clone({precision:65,rounding:Decimal.ROUND_CEIL});
export interface LeitorPrecoV3{
 getCode(address:string):Promise<string>;
 call(req:{to:string;data:string}):Promise<string>;
}
export function usdParaWethWei(usd:string,precoEthUsd:string):bigint{
 if(!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(usd))
   throw Error('MEGAZORD_LUCRO_MIN_USD exige decimais USD de ate 2 casas');
 const q=new D(usd),p=new D(precoEthUsd);
 if(!q.isFinite()||q.lte(0)||q.gt(100)||!p.isFinite()||p.lt(500)||p.gt(100000))
   throw Error('piso USD ou referencia ETH/USD fora do intervalo seguro');
 return BigInt(q.mul('1000000000000000000').div(p).ceil().toFixed(0));
}
/** Uniswap TWAP tick uses arithmetic floor, including for negative ticks. */
export function tickMedio(c0:bigint,c1:bigint,seconds=1800):number{
 if(!Number.isSafeInteger(seconds)||seconds<60||seconds>3600)throw Error('periodo TWAP invalido');
 const diff=c1-c0,window=BigInt(seconds);
 const result=diff>=0n?diff/window:(diff-window+1n)/window;
 if(result< -887272n||result>887272n)throw Error('TWAP tick fora da faixa Uniswap');
 return Number(result);
}
export function ethUsdNoTick(tick:number):string{
 if(!Number.isInteger(tick)||tick< -887272||tick>887272)throw Error('tick V3 invalido');
 // token0=WETH(18), token1=USDC(6): raw price token1/token0
 // =1.0001^tick, so USD/WETH = raw price * 10^(18-6).
 return new D('1.0001').pow(tick).mul('1000000000000').toFixed(12);
}
export async function consultarEthUsdBase(rpc:LeitorPrecoV3):Promise<string>{
 if(await rpc.getCode(POOL)==='0x')throw Error('referencia WETH/USDC sem codigo');
 const get=async(name:string,args:readonly unknown[]=[]):Promise<unknown[]>=>{
   const result=await rpc.call({to:POOL,data:poolAbi.encodeFunctionData(name,args)});
   return [...poolAbi.decodeFunctionResult(name,result)];
 };
 const canonical=await rpc.call({to:FABRICA_V3_BASE,
   data:factoryAbi.encodeFunctionData('getPool',[WETH,USDC,500])});
 const address=factoryAbi.decodeFunctionResult('getPool',canonical)[0] as string;
 if(getAddress(address)!==getAddress(POOL))
   throw Error('referencia WETH/USDC nao reconhecida pela fabrica Base');
 const [token0,token1,factory,fee,liq,spot,obs]=await Promise.all([
   get('token0'),get('token1'),get('factory'),get('fee'),get('liquidity'),
   get('slot0'),get('observe',[[1800,0]]),
 ]);
 if(getAddress(token0[0] as string)!==getAddress(WETH)
   ||getAddress(token1[0] as string)!==getAddress(USDC)
   ||getAddress(factory[0] as string)!==getAddress(FABRICA_V3_BASE)
   ||BigInt(fee[0] as bigint)!==500n
   ||BigInt(liq[0] as bigint)<=0n)
   throw Error('identidade, taxa ou liquidez do oraculo invalida');
 const ticks=obs[0] as bigint[];
 if(!Array.isArray(ticks)||ticks.length!==2)throw Error('observacoes TWAP insuficientes');
 const mean=tickMedio(ticks[0]!,ticks[1]!);
 const spotTick=Number(spot[1]);
 const twap=ethUsdNoTick(mean),instant=ethUsdNoTick(spotTick);
 const ratio=new D(instant).div(twap);
 // Reject a reference whose spot deviates >3% from its 30m TWAP.
 if(ratio.lt('0.97')||ratio.gt('1.03'))
   throw Error('preco spot diverge mais de 3% do TWAP; envio bloqueado');
 const p=new D(twap);
 if(!p.isFinite()||p.lt(500)||p.gt(100000))
   throw Error('cotacao ETH/USD fora do intervalo seguro');
 return twap;
}
export async function atualizarPisoUsdMegazord(
 env:NodeJS.ProcessEnv,ler:LeitorPrecoV3,
):Promise<{ethUsd:string;minimoWei:string}>{
 // Remove readiness first: a failed refresh cannot keep an obsolete
 // quote authorized. The policy checks this timestamp before every shot.
 env.MEGAZORD_COTACAO_ATUALIZADA_EM_MS='0';
 const ethUsd=await consultarEthUsdBase(ler);
 const dinamico=lerRiscoEconomico(env);
 const usd=env.MEGAZORD_LUCRO_MIN_USD??(dinamico?undefined:'0.35');
 // A margem proporcional é calculada por tentativa; nunca um piso zero.
 const floor=usd===undefined?1n:usdParaWethWei(usd,ethUsd);
 const original=env.MEGAZORD_LUCRO_MIN_WETH_ORIGINAL
   ??env.CACA_MORPHO_V3_LUCRO_MIN_WETH_WEI??'0';
 if(!/^\d+$/.test(original))throw Error('piso WETH original invalido');
 const min=BigInt(original)>floor?BigInt(original):floor;
 env.MEGAZORD_LUCRO_MIN_WETH_ORIGINAL=original;
 env.CACA_MORPHO_V3_LUCRO_MIN_WETH_WEI=String(min);
 env.MEGAZORD_COTACAO_ATUALIZADA_EM_MS=String(Date.now());
 return {ethUsd,minimoWei:String(min)};
}
export function iniciarAtualizacaoPisoUsd(
 env:NodeJS.ProcessEnv,rpcUrl:string,
 log:(message:string)=>void=()=>{},
):()=>void{
 const timer=setInterval(()=>{
   const rpc=new JsonRpcProvider(rpcUrl,8453,{staticNetwork:true});
   void atualizarPisoUsdMegazord(env,rpc)
     .catch(()=>log('Referencia ETH/USD indisponivel; novos envios Morpho bloqueados'))
     .finally(()=>rpc.destroy());
 },30000);
 timer.unref();
 return ()=>clearInterval(timer);
}
