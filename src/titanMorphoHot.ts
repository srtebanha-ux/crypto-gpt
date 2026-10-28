import {rotasMorphoHabilitadas} from './titanMorphoDiretorDeRota';
/**
 * TITAN Morpho HOT — bloco a bloco nas posicoes ja descobertas.
 *
 * API enumera mercados/dev no ciclo lento; este worker mantem os que estao
 * perto do LLTV e revalida mercado, preco e posicao NO MESMO BLOCO via
 * multicall3. Se cruzar, chama o executor atomico real imediatamente.
 * Uma unica leitura batelada por bloco, sem varrer a API a cada 2 segundos.
 */
import {Interface,JsonRpcProvider} from 'ethers';
import type {MercadoDaApi} from './morphoApi';
import {codificarMarket,codificarPosition,lerMarket,lerPosition} from './morphoApi';
import {examinarSaudeMorpho} from './titanMorphoRadar';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {MULTICALL3} from './multicall';
import {createLogger} from './logger';
const log=createLogger('morpho-hot');
const price=new Interface(['function price() view returns(uint256)']);
const multicall=new Interface([
 'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)'
]);
type Alvo={mercado:MercadoDaApi;usuario:string;distanciaBps:bigint;atualizadoEm:number};
const alvos=new Map<string,Alvo>();
const MAX_QUENTES=24;
const TTL_MS=25*60_000;
const INT_MS=2_250;
const EXCLUIR_TEMP_MS=45_000;
const PAUSA_MERCADO_SEM_ROTA_MS=15*60_000;
const PAUSA_POSICAO_SAUDAVEL_MS=90_000;
const LIMIAR_SONDA_PROXIMA_BPS=75n;
/** Recheck health every block even when an expensive complete probe is cooling down. */
export function exigeSondaIntegralMorphoHot(
 situacao:string,distanciaBps:bigint|null,bloqueadoAte:number,agora:number,
):boolean {
 if(situacao==='cruzou-estimado')return true;
 return situacao==='proxima'&&distanciaBps!==null
   &&distanciaBps<=LIMIAR_SONDA_PROXIMA_BPS&&bloqueadoAte<=agora;
}
/** The same-block risk result decides priority, never an API snapshot. */
export function compararPrioridadeMorphoHot(
 a:{situacao:string;distanciaBps:bigint|null},
 b:{situacao:string;distanciaBps:bigint|null},
):number{
 const crossed=Number(b.situacao==='cruzou-estimado')-Number(a.situacao==='cruzou-estimado');
 if(crossed!==0)return crossed;
 const da=a.distanciaBps??999999n,db=b.distanciaBps??999999n;
 return da<db?-1:da>db?1:0;
}
export function semRotaExecutavelMorpho(
 via:'Uniswap V3'|'Aerodrome',status:string,motivo:string,primeiroMotivo?:string,
):boolean {
 const semRota=(s:string)=>s.includes('sem rota direta ou multihop comprovada garantia -> divida')
   ||s.includes('rota_nao_suportada: sem pool direta')
   ||s.includes('sem pool V3 comprovada')||s.includes('sem pool Aerodrome comprovada');
 return status==='inviavel'&&semRota(motivo)
   &&(via==='Uniswap V3'||semRota(primeiroMotivo??''));
}
const aguardando=new Map<string,number>();
// Assets without any verified direct V3 or Aerodrome exit cannot repay the
// Morpho debt. Block the WHOLE market temporarily, not just one borrower.
const mercadosSemSaida=new Map<string,number>();
export function bloquearMercadoSemSaida(marketId:string,agora=Date.now(),duracaoMs=30*60_000):number{
 const until=agora+duracaoMs;
 mercadosSemSaida.set(marketId.toLowerCase(),until);
 for(const [k,a] of alvos)if(a.mercado.id.toLowerCase()===marketId.toLowerCase())alvos.delete(k);
 return until;
}
let iniciado=false;
let emCurso=false;
let ultimoBloco=0;
let contagem=0;
let ultimoLog=0;
let rpc:JsonRpcProvider|null=null;
let rpcHotUrl:string|null=null;
/** Use the verified financial RPC before falling back to the rate-limited public endpoint.
 * Keep the block trigger and the full executor probe on the same configured endpoint.
 * Never log the RPC URL: it can contain credentials.
 */
export function resolverRpcMorphoHot(env:NodeJS.ProcessEnv):string{
  return env.CACA_MORPHO_V3_RPC_URL?.trim()
    ||env.MEGAZORD_RPC_URL?.trim()
    ||env.TITAN_EXECUTOR_RPC_URL?.trim()
    ||env.CACA_RPC_URL?.trim()
    ||'https://mainnet.base.org';
}
function chave(a:Alvo):string {return a.mercado.id.toLowerCase()+'|'+a.usuario.toLowerCase();}
export function registrarQuenteMorpho(
 mercado:MercadoDaApi,usuario:string,distanciaBps:bigint,agora=Date.now(),
):boolean{
 if(!mercado.confirmadoNaCorrente||distanciaBps>500n||!/^0x[a-fA-F0-9]{40}$/.test(usuario)
   ||(mercadosSemSaida.get(mercado.id.toLowerCase())??0)>agora)
   return false;
 const a:Alvo={mercado,usuario,distanciaBps,atualizadoEm:agora};
 alvos.set(chave(a),a);
 limparQuentesMorpho(agora);
 return true;
}
/** Renew only an existing near position after the worker decoded market,
 * oracle and position successfully at the same block. No API insertion here. */
export function renovarQuenteMorphoPorLeitura(
 mercadoId:string,usuario:string,distanciaBps:bigint,agora=Date.now(),
):boolean{
 const a=alvos.get(mercadoId.toLowerCase()+'|'+usuario.toLowerCase());
 if(!a||agora<a.atualizadoEm||agora-a.atualizadoEm>TTL_MS||distanciaBps>500n)return false;
 a.distanciaBps=distanciaBps;
 a.atualizadoEm=agora;
 return true;
}
export function limparQuentesMorpho(agora=Date.now()):number{
 for(const [k,a] of alvos){
   if(agora-a.atualizadoEm>TTL_MS)alvos.delete(k);
 }
 const sorted=[...alvos.values()].sort((a,b)=>
   a.distanciaBps<b.distanciaBps?-1:a.distanciaBps>b.distanciaBps?1:b.atualizadoEm-a.atualizadoEm);
 const keep=new Set<string>();
 const counts=new Map<string,number>();
 // Admit one borrower per market BEFORE filling the eight-slot allowance.
 // Otherwise three nearer books fill 24 slots and a fourth market never
 // reaches the block trigger, even when it has a verified exit route.
 for(const a of sorted){
   const id=a.mercado.id.toLowerCase();
   if(counts.has(id)||keep.size>=MAX_QUENTES)continue;
   keep.add(chave(a));
   counts.set(id,1);
 }
 // Reserve remaining slots up to eight per represented market.
 for(const a of sorted){
   const id=a.mercado.id.toLowerCase();
   if(keep.has(chave(a))||(counts.get(id)??0)>=8||keep.size>=MAX_QUENTES)continue;
   keep.add(chave(a));
   counts.set(id,(counts.get(id)??0)+1);
 }
 // Then fill unused capacity with remaining near-liquidation borrowers.
 // Previously 22 real near borrowers in one market became only 8 monitored,
 // wasting 16 out of 24 available block-level slots.
 for(const a of sorted){
   if(keep.size>=MAX_QUENTES)break;
   keep.add(chave(a));
 }
 for(const k of alvos.keys())if(!keep.has(k))alvos.delete(k);
 return alvos.size;
}
/** Public observability without leak of secrets, clients or keys. */
export function resumoQuentesMorpho(agora=Date.now()):{
 posicoes:number;mercados:number;vagasLivres:number;maiorMercado:number;
 maisProximaBps:string|null;idadeMaisAntigaMs:number;
}{
 limparQuentesMorpho(agora);
 const a=[...alvos.values()];
 const porMercado=new Map<string,number>();
 for(const x of a){
   const id=x.mercado.id.toLowerCase();
   porMercado.set(id,(porMercado.get(id)??0)+1);
 }
 return {posicoes:a.length,
   mercados:porMercado.size,
   vagasLivres:MAX_QUENTES-a.length,
   maiorMercado:Math.max(0,...porMercado.values()),
   maisProximaBps:a.length?a.reduce((n,x)=>x.distanciaBps<n?x.distanciaBps:n,a[0]!.distanciaBps).toString():null,
   idadeMaisAntigaMs:a.length?Math.max(...a.map(x=>agora-x.atualizadoEm)):0};
}
type Call={target:string;allowFailure:boolean;callData:string};
export function montarLoteMorphoHot(ativos:readonly Alvo[]):{
 calls:Call[];indices:Map<string,{market:number;oracle:number;position:number}>;
}{
 const calls:Call[]=[];
 const indices=new Map<string,{market:number;oracle:number;position:number}>();
 const markets=new Map<string,{market:number;oracle:number}>();
 for(const a of ativos){
   const id=a.mercado.id.toLowerCase();
   let m=markets.get(id);
   if(!m){
     const market=calls.push({target:MORPHO_FLASH_BASE,allowFailure:true,
       callData:codificarMarket(a.mercado.id)})-1;
     const oracle=calls.push({target:a.mercado.oracle,allowFailure:true,
       callData:price.encodeFunctionData('price')})-1;
     m={market,oracle};
     markets.set(id,m);
   }
   const position=calls.push({target:MORPHO_FLASH_BASE,allowFailure:true,
     callData:codificarPosition(a.mercado.id,a.usuario)})-1;
   indices.set(chave(a),{...m,position});
 }
 return {calls,indices};
}
function token(id:string){return id.replace(/^0x/,'').toLowerCase();}
async function verificarBlocoMorphoHot():Promise<void>{
 if(emCurso||!rpc)return;
 emCurso=true;
 try{
   if(limparQuentesMorpho()===0)return;
   const block=await rpc.getBlockNumber();
   if(block<=ultimoBloco)return;
   ultimoBloco=block;
   const agora=Date.now();
   // Cheap snapshot every block for ALL candidates; only full proofs use cooldown.
   const selecionados=[...alvos.values()]
     .sort((a,b)=>Number(b.distanciaBps<=0n)-Number(a.distanciaBps<=0n)
       ||(aguardando.get(chave(a))??0)-(aguardando.get(chave(b))??0));
   if(!selecionados.length)return;
   const lote=montarLoteMorphoHot(selecionados);
   const retorno=await rpc.send('eth_call',[{
     to:MULTICALL3,data:multicall.encodeFunctionData('aggregate3',[lote.calls]),
   },'0x'+block.toString(16)]);
   const decoded=multicall.decodeFunctionResult('aggregate3',retorno)[0] as
     Array<{success:boolean;returnData:string}>;
   let validadas=0,cruzaram=0,emProva=0;
   const avaliaveis:Array<{a:Alvo;situacao:string;distanciaBps:bigint|null}>=[];
   for(const a of selecionados){
     // A route proven unavailable earlier in THIS block releases all its remaining slots.
     if((mercadosSemSaida.get(a.mercado.id.toLowerCase())??0)>agora)continue;
     const idx=lote.indices.get(chave(a));
     if(!idx)continue;
     const mm=decoded[idx.market],oo=decoded[idx.oracle],pp=decoded[idx.position];
     if(!mm?.success||!oo?.success||!pp?.success)continue;
     const market=lerMarket(mm.returnData),pos=lerPosition(pp.returnData);
     let preco:bigint;
     try{preco=price.decodeFunctionResult('price',oo.returnData)[0] as bigint;}
     catch{continue;}
     if(!market||!pos||preco<=0n)continue;
     const state=examinarSaudeMorpho({
       borrowShares:pos.borrowShares,collateral:pos.collateral,
       totalBorrowAssets:market.totalBorrowAssets,totalBorrowShares:market.totalBorrowShares,
       precoOracle:preco,lltvWad:BigInt(a.mercado.lltv.mul('1e18').toFixed(0)),
     });
     validadas++;
     if(state.distanciaBps!==null)a.distanciaBps=state.distanciaBps;
     if(state.situacao==='sem-divida'||state.situacao==='sem-garantia'){
       alvos.delete(chave(a));continue;
     }
     if(state.situacao!=='cruzou-estimado'&&state.situacao!=='proxima')continue;
     if(state.distanciaBps!==null)renovarQuenteMorphoPorLeitura(
       a.mercado.id,a.usuario,state.distanciaBps,agora);
     if(state.situacao==='cruzou-estimado')cruzaram++;
     if(exigeSondaIntegralMorphoHot(state.situacao,state.distanciaBps,
       aguardando.get(chave(a))??0,agora))
       avaliaveis.push({a,situacao:state.situacao,distanciaBps:state.distanciaBps});
   }
   // Crossed borrowers come first even if another target appeared first
   // in the old snapshot. The one-wallet gate remains unchanged.
   avaliaveis.sort(compararPrioridadeMorphoHot);
   for(const {a} of avaliaveis){
     if(emProva>0)break;
     if((mercadosSemSaida.get(a.mercado.id.toLowerCase())??0)>agora)continue;
     emProva++;
     aguardando.set(chave(a),Date.now()+EXCLUIR_TEMP_MS);
     const {avaliarSaidasMorpho}=await import('./titanMorphoDiretorDeRota');
     const {via,resultado:result,primeiroMotivo}=await avaliarSaidasMorpho({
       mercado:a.mercado,usuario:a.usuario,signal:AbortSignal.timeout(20_000),
       rpcUrl:rpcHotUrl??resolverRpcMorphoHot(process.env),
     });
     // An existent pool is not liquid. If ALL executor sizes reverted from
     // the canonical DEX output floor, give its market a short cooling period.
     // The slow radar keeps discovering other users/markets as usual.
     if(semRotaExecutavelMorpho(via,result.status,result.motivo,primeiroMotivo)){
       bloquearMercadoSemSaida(a.mercado.id,Date.now(),PAUSA_MERCADO_SEM_ROTA_MS);
       log.info('[TITAN/MORPHO-HOT/ROTACAO]',{
         mercado:a.mercado.id,motivo:'sem caminho DEX executavel no contrato atual',
         pausaMinutos:PAUSA_MERCADO_SEM_ROTA_MS/60_000,
         estrategia:'liberar vagas para outros mercados; revalidar depois',
       });
     }
     if(result.status==='inviavel'&&result.motivo.includes('position is healthy'))
       aguardando.set(chave(a),Date.now()+PAUSA_POSICAO_SAUDAVEL_MS);
     const semLiquidezDeSaida=primeiroMotivo?.includes('nenhuma rota passou')
       &&result.motivo.includes('nenhuma rota passou')
       &&(result.motivo.includes('0x42301c23')
           ||result.motivo.includes('InsufficientOutputAmount'));
     if(semLiquidezDeSaida){
       bloquearMercadoSemSaida(a.mercado.id,Date.now(),10*60_000);
       aguardando.set(chave(a),Date.now()+10*60_000);
       log.warn('[TITAN/MORPHO-HOT] Mercado com saida DEX insuficiente; rotacionar.',{
         mercado:a.mercado.id,motivo:'todos eth_call falharam por output insuficiente',
         pausaMinutos:10,
       });
     }
     if(primeiroMotivo?.includes('sem pool V3 comprovada')
       &&result.motivo.includes('sem pool Aerodrome comprovada')){
       bloquearMercadoSemSaida(a.mercado.id);
       aguardando.set(chave(a),Date.now()+30*60_000);
     }
     log.warn('[TITAN/MORPHO-HOT/TIRO] Posicao cruzada ou proxima sondada com liquidacao integral.',{
       bloco:block,mercado:a.mercado.id,usuario:a.usuario,
       via,resultado:result,
       primeiroV3:primeiroMotivo,
     });
     if(['enviada','confirmada','desconhecida'].includes(result.status)){
       // Reconciliation must happen before any attempt against same target.
       aguardando.set(chave(a),Date.now()+30*60_000);
     }
   }
   contagem++;
   if(cruzaram>0||contagem%30===0||Date.now()-ultimoLog>120_000){
     ultimoLog=Date.now();
     log.info('[TITAN/MORPHO-HOT] Bloco processado, gatilho ativo.',{
       bloco:block,mercados:[...new Set(selecionados.map(a=>token(a.mercado.id)))].length,
       observadas:selecionados.length,validadas,cruzaram,preflights:emProva,
       intervaloMs:INT_MS,via:'Multicall3 no bloco; V3 eth_call antes de assinar',
     });
   }
 }catch(e){
   const mensagem=e instanceof Error?e.message.slice(0,260):String(e).slice(0,260);
   // Reuse next block: provider 429/403 is observable, never interpreted as healthy.
   if(Date.now()-ultimoLog>10_000){ultimoLog=Date.now();
     log.warn('[TITAN/MORPHO-HOT] Bloco nao validado; retry sem envio.',{motivo:mensagem});
   }
 }finally{emCurso=false;}
}
export function iniciarGatilhoQuenteMorpho(env:NodeJS.ProcessEnv=process.env):void{
 if(iniciado||!rotasMorphoHabilitadas(env))return;
 iniciado=true;
 const url=resolverRpcMorphoHot(env);
 rpcHotUrl=url;
 rpc=new JsonRpcProvider(url,8453,{staticNetwork:true,batchMaxCount:1});
 log.info('[TITAN/MORPHO-HOT] Gatilho de execucao por bloco iniciado.',{
   intervaloMs:INT_MS,maxPosicoes:MAX_QUENTES,ttlMs:TTL_MS,
   envioConfigurado:env.CACA_MORPHO_V3_ENVIAR==='1',
   nota:'aguarda lista de mercado onchain do radar; multicall por bloco',
 });
 const t=setInterval(()=>{void verificarBlocoMorphoHot();},INT_MS);
 t.unref?.();
}
