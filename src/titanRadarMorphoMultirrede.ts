/**
 * TITAN 24/7: independent multichain Morpho liquidation radar (read-only).
 * Polls one chain every 30 seconds => 6 chains covered in 3 minutes,
 * without RPC, EVM transactions, keys or blocking the CACA event loop.
 * A recent event sample is NOT a currently liquidatable borrower.
 */
import type {Logger} from './logger';

export const REDES_MORPHO_RADAR=[
 {chainId:8453,rede:'Base',atlas:true},
 {chainId:42161,rede:'Arbitrum',atlas:true},
 {chainId:10,rede:'OP Mainnet',atlas:false},
 {chainId:137,rede:'Polygon',atlas:false},
 {chainId:130,rede:'Unichain',atlas:false},
 {chainId:1,rede:'Ethereum',atlas:false},
] as const;
export interface AmostraLiquidacoes {
 rede:string;chainId:number;eventos:number;transacoesUnicas:number;
 lideres:{liquidador:string;eventos:number;transacoesUnicas:number}[];
}
const QUERY='query($ids:[Int!],$first:Int!){marketTransactions(first:$first,orderBy:Timestamp,orderDirection:Desc,where:{chainId_in:$ids,type_in:[Liquidation]}){items{txHash data{... on MarketTransactionLiquidationData{liquidator}}}}}';
export function analisarEventosMorpho(
 rede:string,chainId:number,json:unknown
):AmostraLiquidacoes {
 const content=json as {data?:{marketTransactions?:{items?:unknown}};errors?:unknown[]};
 if(content?.errors?.length)throw Error('Indexer errors');
 const items=content?.data?.marketTransactions?.items;
 if(!Array.isArray(items))throw Error('Missing Morpho event list');
 const grouped=new Map<string,{eventos:number;tx:Set<string>}>();
 const tx=new Set<string>();
 for(const row of items) {
  const x=row as {txHash?:unknown;data?:{liquidator?:unknown}};
  if(typeof x.txHash!=='string'||!/^0x[a-f0-9]{64}$/i.test(x.txHash)||
    typeof x.data?.liquidator!=='string'||
    !/^0x[a-f0-9]{40}$/i.test(x.data.liquidator))continue;
  const address=x.data.liquidator.toLowerCase();
  const r=grouped.get(address)??{eventos:0,tx:new Set<string>()};
  r.eventos++;r.tx.add(x.txHash.toLowerCase());grouped.set(address,r);
  tx.add(x.txHash.toLowerCase());
 }
 return {rede,chainId,eventos:items.length,transacoesUnicas:tx.size,
  lideres:[...grouped.entries()].map(([liquidador,x])=>({
   liquidador,eventos:x.eventos,transacoesUnicas:x.tx.size
  })).sort((a,b)=>b.eventos-a.eventos).slice(0,3)};
}
export function iniciarRadarMorphoMultirrede(
 logger:Logger,env:NodeJS.ProcessEnv=process.env
):{ativo:boolean;parar:()=>void}{
 if(env.TITAN_RADAR_MULTIRREDE!=='1')return{ativo:false,parar:()=>{}};
 let stopped=false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 let idx=0;
 const sample=async()=>{
  if(stopped)return;
  const chain=REDES_MORPHO_RADAR[idx++%REDES_MORPHO_RADAR.length];
  const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),10000);
  try{
   const response=await fetch('https://api.morpho.org/graphql',{
    method:'POST',signal:ctrl.signal,headers:{'content-type':'application/json'},
    body:JSON.stringify({query:QUERY,variables:{ids:[chain.chainId],first:50}})
   });
   if(!response.ok)throw Error('HTTP '+response.status);
   const value=analisarEventosMorpho(chain.rede,chain.chainId,await response.json());
   logger.info('[TITAN/MULTIREDE] Amostra historica recente de liquidacoes Morpho.',{
    rede:value.rede,chainId:value.chainId,eventosDaAmostra:value.eventos,
    transacoesDaAmostra:value.transacoesUnicas,
    principaisLiquidadores:value.lideres.slice(0,2),
    nota:'Nao sao alvos liquidaveis agora; nao dispara e nao paga gas',
   });
  }catch(e){
   logger.warn('[TITAN/MULTIREDE] Falha ao ler indexador; cobertura desconhecida.',{
    rede:chain.rede,causa:String(e).slice(0,160)});
  }finally{
   clearTimeout(timeout);
   if(!stopped){timer=setTimeout(()=>{void sample()},30000);timer.unref?.()}
  }
 };
 void sample();
 return {ativo:true,parar:()=>{
  stopped=true;if(timer)clearTimeout(timer);
 }};
}
