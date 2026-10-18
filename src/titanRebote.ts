/**
 * TITAN / Rebote de liquidacoes: detecta, em recibos CONFIRMADOS,
 * swaps que aconteceram na mesma transacao de uma LiquidationCall da
 * Aave V3 Base. Isto e um SINAL para cotar a liquidez depois da
 * transacao; NAO prova venda do colateral, spread, ordem de inclusao
 * nem lucro. Nenhum caminho de envio depende do observador.
 */
import {id} from 'ethers';
import {REDES, TOPIC_LIQUIDATION_CALL} from './liquidacoes';

export const TOPICOS_SWAP_REBOTE=new Set([
 id('Swap(address,uint256,uint256,uint256,uint256,address)').toLowerCase(),
 id('Swap(address,address,int256,int256,uint160,uint128,int24)').toLowerCase(),
 id('Swap(address,address,uint256,uint256,uint256,uint256)').toLowerCase(),
]);
const POOL_AAVE_BASE=(REDES.base?.pool??'').toLowerCase();
export interface ReciboConfirmado {
 status?:string|number;
 logs?:Array<{address?:string;topics?:string[]}>;
}
export interface ReboteObservado {
 liquidacoes:number;
 transacoesComSwaps:number;
 pools:string[];
}
/** Evento de liquidacao e de swap precisam vir na MESMA tx bem-sucedida. */
export function detectarRebotesAave(recibos:unknown):ReboteObservado {
 const pools=new Set<string>();
 let liquidacoes=0,transacoesComSwaps=0;
 if(!Array.isArray(recibos))return{liquidacoes,transacoesComSwaps,pools:[]};
 for(const item of recibos){
  if(!item||typeof item!=='object')continue;
  const r=item as ReciboConfirmado;
  if(r.status!=='0x1'&&r.status!==1)continue;
  if(!Array.isArray(r.logs)||r.logs.length===0)continue;
  const la=r.logs.filter(z=>typeof z?.address==='string'
    &&z.address.toLowerCase()===POOL_AAVE_BASE
    &&Array.isArray(z.topics)
    &&z.topics[0]?.toLowerCase()===TOPIC_LIQUIDATION_CALL.toLowerCase());
  if(la.length===0)continue;
  liquidacoes+=la.length;
  let achou=false;
  for(const l of r.logs) {
   if(typeof l?.address!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(l.address)
      ||!Array.isArray(l.topics)||!TOPICOS_SWAP_REBOTE.has(l.topics[0]?.toLowerCase()??''))continue;
   pools.add(l.address.toLowerCase());achou=true;
  }
  if(achou)transacoesComSwaps++;
 }
 return{liquidacoes,transacoesComSwaps,pools:[...pools]};
}
/** Mantem pistas somente nos 3 proximos blocos. Nunca inventa cotacao. */
export class RadarDeRebotes {
 private readonly pistas=new Map<string,number>();
 registrar(bloco:number,resultado:ReboteObservado):void {
  if(!Number.isSafeInteger(bloco)||bloco<1)return;
  for(const pool of resultado.pools)if(/^0x[0-9a-f]{40}$/.test(pool))this.pistas.set(pool,bloco);
  this.ativos(bloco);
 }
 ativos(bloco:number):ReadonlySet<string> {
  for(const [p,observado] of this.pistas) {
   if(bloco>observado+3)this.pistas.delete(p);
  }
  return new Set(this.pistas.keys());
 }
}
/** Reserva no maximo 25% das cotacoes para pistas de rebote. As rotas
 * ja passaram na triagem e devem continuar sujeitas a simulacao e lucro.
 * Nenhuma rota nova fica automaticamente autorizada a ser enviada.
 */
export function priorizarRebotes<T extends {chave:string;pernas:ReadonlyArray<{pool:string}>}>(
 selecionadas:readonly T[],
 candidatas:readonly T[],
 pools:ReadonlySet<string>,
 quota:number,
):T[] {
 if(pools.size===0||quota<=0||selecionadas.length===0)return [...selecionadas];
 const escolhidas=new Set(selecionadas.map(c=>c.chave));
 const promovidas=candidatas.filter(c=>!escolhidas.has(c.chave)
    &&c.pernas.some(p=>pools.has(p.pool.toLowerCase()))).slice(0,Math.min(quota,selecionadas.length));
 if(promovidas.length===0)return [...selecionadas];
 // O fundo da fila normal cede lugar, nunca as maiores cotações já ranqueadas.
 return [...promovidas,...selecionadas.slice(0,selecionadas.length-promovidas.length)];
}
