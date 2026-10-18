/**
 * TITAN-SVR v1 / offline-first auction adapter.
 * All amounts denominated in WETH wei. The bond is a separate expense; NEVER
 * mistake an Atlas bid for transaction gas or expected net profit.
 * No signer, no private key, no submission and no mainnet transaction here.
 */
import {Interface,isAddress} from 'ethers';

export const BASE_CHAIN_ID=8453;
export const SVR_GATEWAY='wss://svr-bid-endpoint.chain.link/ws/solver';
export const TITAN_ATLAS_BATCH_ABI=[
 'function executarLote(((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) market,address devedor,uint256 seizedAssets,uint256 repaidShares,bool poolEstavel,uint256 lucroMinimoWeth)[] alvos,uint256 minimoLiquidoWeth) returns (uint256 quantidade,uint256 minimoWeth)',
] as const;
export type ResultadoLanceSvr =
 | {permitido:false;motivo:string;excedenteWei?:bigint}
 | {permitido:true;lanceWei:bigint;lucroLiquidoPrevistoWei:bigint;
    reservaGasWei:bigint;limiteEconomicoWei:bigint;
    origemLance:'proprio'|'competidor';};
export interface CustosSvr {
 lucroBrutoEsperadoWei:bigint;
 custoSwapWei:bigint;riscoSlippageWei:bigint;
 custoGasEAtualizacaoOracleWei:bigint;
 margemSegurancaWei:bigint;
 minimoLiquidoWei:bigint;
 lanceCompetidorWei?:bigint;
 limiteOfertaBps?:number; // 8000 max by default; never unconditional ALL profit
 incrementoWei?:bigint;
 // When rival bids are private, bid a configurable share of our own ceiling.
 // 7500 bps of the ceiling = at most 60% of the uncommitted surplus by default.
 fracaoTetoSemRivalBps?:number;
}
export function planejarLanceSvr(x:CustosSvr):ResultadoLanceSvr {
 const vals=[x.lucroBrutoEsperadoWei,x.custoSwapWei,x.riscoSlippageWei,
  x.custoGasEAtualizacaoOracleWei,x.margemSegurancaWei,x.minimoLiquidoWei,
  x.lanceCompetidorWei??0n,x.incrementoWei??1n];
 if(vals.some(v=>v<0n))return{permitido:false,motivo:'custo ou lucro negativo'};
 const bps=x.limiteOfertaBps??8000;
 if(!Number.isInteger(bps)||bps<1||bps>9000)
  return{permitido:false,motivo:'limite de oferta fora da politica'};
 if(x.minimoLiquidoWei<=0n)
  return{permitido:false,motivo:'lucro minimo nao pode ser zero'};
 const custos=x.custoSwapWei+x.riscoSlippageWei
   +x.custoGasEAtualizacaoOracleWei+x.margemSegurancaWei;
 if(x.lucroBrutoEsperadoWei<=custos+x.minimoLiquidoWei)
  return{permitido:false,motivo:'lucro abaixo dos custos e reserva'};
 const sobra=x.lucroBrutoEsperadoWei-custos-x.minimoLiquidoWei;
 const limite=(sobra*BigInt(bps))/10000n;
 if(limite<=0n)return{permitido:false,motivo:'nao sobra valor para lance',excedenteWei:sobra};
 const fallbackBps=x.fracaoTetoSemRivalBps??7500;
 if(!Number.isInteger(fallbackBps)||fallbackBps<1||fallbackBps>10000)
  return{permitido:false,motivo:'fraçao sem rival fora da politica',excedenteWei:sobra};
 const semRival=x.lanceCompetidorWei===undefined;
 // Actual live competitor bids are generally private. Using our own
 // simulated surplus avoids blocking every legitimate Atlas auction.
 const proposta=semRival
   ?(limite*BigInt(fallbackBps))/10000n
   :x.lanceCompetidorWei!+(x.incrementoWei??1n);
 if(proposta<=0n||proposta>limite)
  return{permitido:false,motivo:'lance nao cabe no lucro disponivel',excedenteWei:sobra};
 const liquido=x.lucroBrutoEsperadoWei-custos-proposta;
 if(liquido<x.minimoLiquidoWei)
  return{permitido:false,motivo:'resultado abaixo do lucro minimo',excedenteWei:sobra};
 return{permitido:true,lanceWei:proposta,limiteEconomicoWei:limite,
    lucroLiquidoPrevistoWei:liquido,reservaGasWei:x.custoGasEAtualizacaoOracleWei,
    origemLance:semRival?'proprio':'competidor'};
}
export interface LeilaoSvr{
 id:string;hash:string;atlas:string;control:string;
 deadline:bigint;maxFeePerGas:bigint;gasDaOracle:bigint;
}
function obj(x:unknown):Record<string,unknown>|null{
 return x!==null&&typeof x==='object'&&!Array.isArray(x)
  ?x as Record<string,unknown>:null;
}
function hexNumber(x:unknown):bigint|null{
 if(typeof x!=='string'||!/^0x[0-9a-fA-F]+$/.test(x))return null;
 try{return BigInt(x)}catch{return null;}
}
export function decodificarNotificacaoSvr(raw:unknown):LeilaoSvr|null{
 const n=obj(raw),p=obj(n?.params),r=obj(p?.result),uo=obj(r?.partial_user_operation);
 if(n?.method!=='solver_subscription'||!r||!uo)return null;
 const id=r.auction_id,hash=uo.userOpHash;
 const chain=hexNumber(uo.chainId),deadline=hexNumber(uo.deadline);
 const fee=hexNumber(uo.maxFeePerGas),gas=hexNumber(uo.gas);
 if(typeof id!=='string'||!/^[a-fA-F0-9-]{36}$/.test(id)
    ||typeof hash!=='string'||!/^0x[a-fA-F0-9]{64}$/.test(hash)
    ||chain!==BigInt(BASE_CHAIN_ID)||deadline===null||fee===null||gas===null
    ||typeof uo.to!=='string'||!isAddress(uo.to)
    ||typeof uo.control!=='string'||!isAddress(uo.control))return null;
 return {id,hash:hash.toLowerCase(),atlas:uo.to.toLowerCase(),
   control:uo.control.toLowerCase(),deadline,maxFeePerGas:fee,gasDaOracle:gas};
}
/**
 * The same userOpHash can have TWO independent auction IDs on Base.
 * Dedup on ID, not userOpHash; otherwise the competing solver loses
 * one of the two possible Chainlink SVR oracle updates.
 */
export class DedupLeiloesSvr {
 private seen=new Map<string,number>();
 constructor(private maxAgeMs=120000,private maxSize=1024){}
 recebe(a:LeilaoSvr,now=Date.now()):boolean{
  for(const [k,t] of this.seen)if(now-t>this.maxAgeMs)this.seen.delete(k);
  if(this.seen.has(a.id))return false;
  if(this.seen.size>=this.maxSize)this.seen.delete(this.seen.keys().next().value!);
  this.seen.set(a.id,now);return true;
 }
}
/** Calldata for a new, undeployed TitanAtlasMorphoLote contract. */
export interface CandidatoBatchSvr {
 market:{loanToken:string;collateralToken:string;oracle:string;irm:string;lltv:bigint};
 devedor:string;seizedAssets:bigint;repaidShares:bigint;
 poolEstavel:boolean;lucroMinimoWeth:bigint;
}
export function codificarLoteSvr(alvos:CandidatoBatchSvr[],minimoLiquidoWei:bigint):string{
 if(alvos.length<1||alvos.length>16||minimoLiquidoWei<=0n)throw Error('lote ou lucro minimo invalido');
 for(const a of alvos){
  if(!isAddress(a.devedor)||!isAddress(a.market.loanToken)
    ||!isAddress(a.market.collateralToken)||!isAddress(a.market.oracle)
    ||!isAddress(a.market.irm)||a.lucroMinimoWeth<=0n
    ||(a.seizedAssets===0n)===(a.repaidShares===0n))throw Error('mercado ou tamanho invalido');
 }
 return new Interface(TITAN_ATLAS_BATCH_ABI).encodeFunctionData('executarLote',[alvos,minimoLiquidoWei]);
}
