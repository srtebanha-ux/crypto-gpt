import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import type {MercadoDaApi} from './morphoApi';
import {registrarQuenteMorpho,resumoQuentesMorpho,
  montarLoteMorphoHot,limparQuentesMorpho,bloquearMercadoSemSaida,renovarQuenteMorphoPorLeitura,resolverRpcMorphoHot,exigeSondaIntegralMorphoHot,semRotaExecutavelMorpho,compararPrioridadeMorphoHot,criarPortaoProvaMorphoHot,pausaDeInsolvenciaMorpho} from './titanMorphoHot';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {avaliarSaidasMorpho,recusaIndependenteDeRotaMorpho,type SondadoresMorpho} from './titanMorphoDiretorDeRota';
const block=1_801_000_000_000;
const marketId='0x'+'99'.repeat(32);
const oracle='0x'+'55'.repeat(20);
const user1='0x'+'11'.repeat(20),user2='0x'+'22'.repeat(20);
function mercado(confirmado:boolean,id=marketId):MercadoDaApi{
  return {
    id,loanToken:'0x'+'33'.repeat(20),collateralToken:'0x'+'44'.repeat(20),
    oracle,irm:'0x'+'66'.repeat(20),lltv:new Decimal('0.77'),
    bonusPct:new Decimal('7.4'),blocoDaCriacao:0,
    chainId:8453,confirmadoNaCorrente:confirmado,blocoIndexado:null,
  };
}
test('HOT refuses API-only, invalid user, and healthy positions',()=>{
  assert.equal(registrarQuenteMorpho(mercado(false),user1,10n,block),false);
  assert.equal(registrarQuenteMorpho(mercado(true),'garbage',10n,block),false);
  assert.equal(registrarQuenteMorpho(mercado(true),user1,501n,block),false);
});
test('HOT upserts market/user and builds one market + oracle per group',()=>{
  const m=mercado(true);
  assert.equal(registrarQuenteMorpho(m,user1,70n,block),true);
  assert.equal(registrarQuenteMorpho(m,user2,135n,block),true);
  assert.equal(registrarQuenteMorpho(m,user1,40n,block),true);
  const state=resumoQuentesMorpho(block+5);
  assert.equal(state.posicoes,2);
  assert.equal(state.maisProximaBps,'40');
  const records=[
    {mercado:m,usuario:user1,distanciaBps:40n,atualizadoEm:block},
    {mercado:m,usuario:user2,distanciaBps:135n,atualizadoEm:block},
  ];
  const b=montarLoteMorphoHot(records);
  assert.equal(b.calls.length,4); // market,oracle,2 positions; one eth_call
  assert.equal(b.calls[0]?.target,MORPHO_FLASH_BASE);
  assert.equal(b.calls[1]?.target,oracle);
  assert.equal(b.calls[2]?.target,MORPHO_FLASH_BASE);
  assert.equal(b.indices.size,2);
  assert.equal(b.indices.get(m.id.toLowerCase()+'|'+user2.toLowerCase())?.position,3);
  assert.ok(b.calls.every(c=>c.allowFailure));
});
test('HOT retains nearest 24 targets and evicts distant targets to bound block calls',()=>{
 const base=block+1000;
 for(let i=0;i<30;i++){
   const user='0x'+(100+i).toString(16).padStart(40,'0');
   const id='0x'+(100+i).toString(16).padStart(64,'0');
   registrarQuenteMorpho(mercado(true,id),user,BigInt(i+1),base);
 }
 assert.equal(resumoQuentesMorpho(base).posicoes,24);
 assert.equal(resumoQuentesMorpho(base).maisProximaBps,'1');
});
test('HOT keeps scarce slots across markets, not 24 borrowers from one illiquid market',()=>{
 const now=block+30*60_000;
 limparQuentesMorpho(now);
 const marketA=mercado(true,'0x'+'d1'.repeat(32));
 const marketB=mercado(true,'0x'+'d2'.repeat(32));
 for(let i=0;i<24;i++){
   registrarQuenteMorpho(marketA,'0x'+(500+i).toString(16).padStart(40,'0'),BigInt(1+i),now);
 }
 for(let i=0;i<12;i++){
   registrarQuenteMorpho(marketB,'0x'+(700+i).toString(16).padStart(40,'0'),BigInt(40+i),now);
 }
 const snap=resumoQuentesMorpho(now);
 assert.equal(snap.posicoes,24); // 8+8 reserved, 8 spare filled by A
 assert.equal(snap.mercados,2);
 assert.equal(snap.maiorMercado,16); // B retains all eight reserved slots
 assert.equal(snap.vagasLivres,0);
 assert.equal(snap.maisProximaBps,'1');
 limparQuentesMorpho(now+26*60_000);
});
test('HOT uses all 22 slots when 22 near-liquidatable borrowers come from one market',()=>{
 const now=block+60*60_000;
 limparQuentesMorpho(now);
 const m=mercado(true,'0x'+'e1'.repeat(32));
 for(let i=0;i<22;i++){
   assert.equal(registrarQuenteMorpho(m,
     '0x'+(900+i).toString(16).padStart(40,'0'),BigInt(20+i),now),true);
 }
 const state=resumoQuentesMorpho(now);
 assert.equal(state.posicoes,22);
 assert.equal(state.mercados,1);
 assert.equal(state.maiorMercado,22);
 assert.equal(state.vagasLivres,2);
 limparQuentesMorpho(now+26*60_000);
});
test('HOT admits a fourth market even when three nearer books already fill every slot',()=>{
 const now=block+120*60_000;
 limparQuentesMorpho(now);
 for(let m=0;m<3;m++)for(let i=0;i<8;i++){
   registrarQuenteMorpho(mercado(true,'0x'+(300+m).toString(16).padStart(64,'0')),
     '0x'+(3000+m*100+i).toString(16).padStart(40,'0'),BigInt(1+m*10+i),now);
 }
 assert.equal(resumoQuentesMorpho(now).mercados,3);
 registrarQuenteMorpho(mercado(true,'0x'+(303).toString(16).padStart(64,'0')),
   user1,100n,now);
 const state=resumoQuentesMorpho(now);
 assert.equal(state.mercados,4);
 assert.equal(state.posicoes,24);
 assert.equal(state.vagasLivres,0);
 limparQuentesMorpho(now+26*60_000);
});
test('HOT suppresses an entire market without canonical DEX exit instead of retrying borrowers',()=>{
 const id='0x'+'aa'.repeat(32);
 const other='0x'+'bb'.repeat(32);
 const a=block+1;
 assert.equal(registrarQuenteMorpho(mercado(true,id),user1,5n,a),true);
 assert.equal(registrarQuenteMorpho(mercado(true,id),user2,9n,a),true);
 assert.equal(registrarQuenteMorpho(mercado(true,other),user1,6n,a),true);
 bloquearMercadoSemSaida(id,a+10);
 assert.equal(registrarQuenteMorpho(mercado(true,id),user1,1n,a+11),false);
 assert.equal(registrarQuenteMorpho(mercado(true,other),user2,7n,a+11),true);
 assert.equal(registrarQuenteMorpho(mercado(true,id),user1,1n,a+31*60_000),true);
 limparQuentesMorpho(a+60*60_000); // reset registry for other tests
});
test('illiquid market can be rotated for 10 minutes without blocking others',()=>{
 const marketId='0x'+'cc'.repeat(32);
 const other='0x'+'dd'.repeat(32);
 const now=block+6*60*60_000;
 assert.equal(registrarQuenteMorpho(mercado(true,marketId),user1,5n,now),true);
 bloquearMercadoSemSaida(marketId,now,10*60_000);
 assert.equal(registrarQuenteMorpho(mercado(true,marketId),user2,2n,now+9*60_000),false);
 assert.equal(registrarQuenteMorpho(mercado(true,other),user1,5n,now+9*60_000),true);
 assert.equal(registrarQuenteMorpho(mercado(true,marketId),user1,1n,now+11*60_000),true);
 limparQuentesMorpho(now+40*60_000);
});
test('HOT forgets old debtors rather than treating stale API as an actionable target',()=>{
  assert.equal(limparQuentesMorpho(block+26*60_000),0);
});

test('leituras onchain continuas conservam alvo por mais de 25min sem nova rodada da API',()=>{
 const now=block+8*60*60_000;
 limparQuentesMorpho(now);
 const m=mercado(true,'0x'+'ef'.repeat(32));
 assert.equal(registrarQuenteMorpho(m,user1,30n,now),true);
 for(let minute=10;minute<=60;minute+=10){
  assert.equal(renovarQuenteMorphoPorLeitura(m.id,user1,20n,now+minute*60_000),true);
  assert.equal(resumoQuentesMorpho(now+minute*60_000).posicoes,1);
 }
 // No further successful onchain reads: expiry still protects stale data.
 assert.equal(resumoQuentesMorpho(now+86*60_000).posicoes,0);
 assert.equal(renovarQuenteMorphoPorLeitura(m.id,user1,10n,now+87*60_000),false);
});
test('renovacao nao insere desconhecido nem prolonga posicao distante ou expirada',()=>{
 const now=block+10*60*60_000;
 limparQuentesMorpho(now);
 const m=mercado(true,'0x'+'fa'.repeat(32));
 assert.equal(renovarQuenteMorphoPorLeitura(m.id,user1,1n,now),false);
 registrarQuenteMorpho(m,user1,10n,now);
 assert.equal(renovarQuenteMorphoPorLeitura(m.id,user1,501n,now+20*60_000),false);
 assert.equal(renovarQuenteMorphoPorLeitura(m.id,user1,1n,now+26*60_000),false);
 assert.equal(resumoQuentesMorpho(now+26*60_000).posicoes,0);
});

test('HOT reuses the configured Megazord RPC and avoids public fallback unless necessary',()=>{
 const configured={MEGAZORD_RPC_URL:'https://verified-rpc.example/private'};
 assert.equal(resolverRpcMorphoHot(configured),configured.MEGAZORD_RPC_URL);
 assert.equal(resolverRpcMorphoHot({...configured,CACA_MORPHO_V3_RPC_URL:'https://specific.example/rpc'}),
  'https://specific.example/rpc');
 assert.equal(resolverRpcMorphoHot({TITAN_EXECUTOR_RPC_URL:'https://executor.example/rpc'}),
  'https://executor.example/rpc');
 assert.equal(resolverRpcMorphoHot({CACA_RPC_URL:'https://caca.example/rpc'}),
  'https://caca.example/rpc');
 assert.equal(resolverRpcMorphoHot({}), 'https://mainnet.base.org');
 assert.equal(resolverRpcMorphoHot({...configured,CACA_MORPHO_V3_RPC_URL:'  '}),
  configured.MEGAZORD_RPC_URL);
});

test('HOT only spends full liquidation eth_call near threshold, but crossed candidates bypass cooldown',()=>{
 const now=block+12*60*60_000;
 assert.equal(exigeSondaIntegralMorphoHot('proxima',249n,0,now),false);
 assert.equal(exigeSondaIntegralMorphoHot('proxima',75n,0,now),true);
 assert.equal(exigeSondaIntegralMorphoHot('proxima',74n,now+30000,now),false);
 assert.equal(exigeSondaIntegralMorphoHot('cruzou-estimado',-1n,now+90000,now),true);
 assert.equal(exigeSondaIntegralMorphoHot('segura',10n,0,now),false);
 assert.equal(exigeSondaIntegralMorphoHot('proxima',null,0,now),false);
});
test('HOT classifies only structural no-exit errors for market rotation, not healthy or transient',()=>{
 assert.equal(semRotaExecutavelMorpho('Uniswap V3','inviavel',
  'sem rota direta ou multihop comprovada garantia -> divida'),true);
 assert.equal(semRotaExecutavelMorpho('Uniswap V3','inviavel',
  'rota_nao_suportada: sem pool direta; executor implantado sem suporte multihop'),true);
 assert.equal(semRotaExecutavelMorpho('Uniswap V3','inviavel',
  'nenhuma rota passou no liquidar(): position is healthy'),false);
 assert.equal(semRotaExecutavelMorpho('Uniswap V3','descartada',
  'sem rota direta ou multihop comprovada garantia -> divida'),false);
 assert.equal(semRotaExecutavelMorpho('Aerodrome','inviavel',
  'sem pool Aerodrome comprovada','nenhuma rota passou no liquidar(): healthy'),false);
 assert.equal(semRotaExecutavelMorpho('Aerodrome','inviavel',
  'sem pool Aerodrome comprovada','sem rota direta ou multihop comprovada garantia -> divida'),true);
});

test('same block crossed borrower outranks a nearer but still healthy candidate',()=>{
 const candidates=[
  {id:'first',situacao:'proxima',distanciaBps:5n},
  {id:'second',situacao:'cruzou-estimado',distanciaBps:-1n},
  {id:'third',situacao:'proxima',distanciaBps:2n},
 ];
 candidates.sort(compararPrioridadeMorphoHot);
 assert.deepEqual(candidates.map(x=>x.id),['second','third','first']);
});

test('hot worker can continue snapshot scheduling while a slow liquidation proof is pending',async()=>{
 const gate=criarPortaoProvaMorphoHot();
 let liberar!:()=>void;
 const unresolved=new Promise<void>(resolve=>{liberar=resolve;});
 let launches=0;
 assert.equal(gate.executar(async()=>{launches++;await unresolved;}),true);
 assert.equal(gate.ocupada(),true);
 // Non-blocking: a new block sees gate busy and does not launch a second
 // signing proof, but can still calculate its own independent risk snapshot.
 const nextBlock=()=>({riskChecked:true,canLaunch:gate.executar(async()=>{launches++;})});
 const second=nextBlock();
 assert.equal(second.riskChecked,true);
 assert.equal(second.canLaunch,false);
 await Promise.resolve();
 assert.equal(launches,1);
 liberar();
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(gate.ocupada(),false);
 assert.equal(gate.executar(async()=>{launches++;}),true);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(launches,2);
 assert.equal(gate.ocupada(),false);
});
test('single-flight gate recovers from a rejected read-only proof without deadlocking',async()=>{
 const gate=criarPortaoProvaMorphoHot();
 assert.equal(gate.executar(async()=>{throw new Error('temporary RPC failure');}),true);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(gate.ocupada(),false);
 assert.equal(gate.executar(async()=>{}),true);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(gate.ocupada(),false);
});

test('deeply insolvent crossed borrower rotates out of costly full proofs but remains monitorable',()=>{
 const now=1_806_000_000_000;
 const paused={ate:now+300_000,distanciaBps:-6189n};
 assert.equal(pausaDeInsolvenciaMorpho(paused,-6189n,now+30_000),true);
 assert.equal(pausaDeInsolvenciaMorpho(paused,-6200n,now+30_000),true);
 // A 99bp improvement is not enough to retry the expensive route search.
 assert.equal(pausaDeInsolvenciaMorpho(paused,-6090n,now+30_000),true);
 // Meaningful improvement in collateralization immediately releases the gate.
 assert.equal(pausaDeInsolvenciaMorpho(paused,-6089n,now+30_000),false);
 assert.equal(pausaDeInsolvenciaMorpho(paused,-6189n,now+300_000),false);
 assert.equal(pausaDeInsolvenciaMorpho(paused,null,now+10),false);
 assert.equal(pausaDeInsolvenciaMorpho(undefined,-6189n,now),false);
 // Ordinary crossed borrower is still preferred over merely near healthy risk.
 assert.equal(exigeSondaIntegralMorphoHot('cruzou-estimado',-10n,now+300_000,now),true);
});

test('Morpho director skips second DEX for healthy or no-safe-share protocol rejection',async()=>{
 assert.equal(recusaIndependenteDeRotaMorpho('inviavel','4x Error(string) | position is healthy'),true);
 assert.equal(recusaIndependenteDeRotaMorpho('inviavel','garantia insuficiente para qualquer parcela segura de divida'),true);
 assert.equal(recusaIndependenteDeRotaMorpho('inviavel','sem rota direta ou multihop comprovada garantia -> divida'),false);
 assert.equal(recusaIndependenteDeRotaMorpho('descartada','position is healthy'),false);
 const env:NodeJS.ProcessEnv={
   CACA_MORPHO_V3_CONTRATO:'0x'+'11'.repeat(20),
   CACA_MORPHO_AERO_CONTRATO:'0x'+'22'.repeat(20),
   CACA_MORPHO_V3_AVALIAR:'1',CACA_MORPHO_AERO_AVALIAR:'1',
 };
 const entry={mercado:mercado(true),usuario:user1,rpcUrl:'https://unit.test'};
 let aero=0;
 for(const reason of [
   'nenhuma rota passou no liquidar() integral do executor (eth_call): 4x Error(string) | position is healthy',
   'garantia insuficiente para qualquer parcela segura de divida',
 ]){
   const result=await avaliarSaidasMorpho(entry,env,{
     v3:async()=>({status:'inviavel' as const,motivo:reason}),
     aero:async()=>{aero++;return {status:'inviavel' as const,motivo:'not expected'};},
   } as unknown as SondadoresMorpho);
   assert.equal(result.via,'Uniswap V3');
   assert.equal(result.resultado.motivo,reason);
 }
 assert.equal(aero,0);
 const fallback=await avaliarSaidasMorpho(entry,env,{
   v3:async()=>({status:'inviavel' as const,motivo:'sem rota direta ou multihop comprovada garantia -> divida'}),
   aero:async()=>{aero++;return{status:'descartada' as const,motivo:'sem rota Aerodrome'};},
 } as unknown as SondadoresMorpho);
 assert.equal(fallback.via,'Aerodrome');
 assert.equal(aero,1);
});
