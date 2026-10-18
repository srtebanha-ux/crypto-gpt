import {test} from 'node:test';
import assert from 'node:assert/strict';
import {id} from 'ethers';
import {REDES,TOPIC_LIQUIDATION_CALL} from './liquidacoes';
import {detectarRebotesAave,RadarDeRebotes,priorizarRebotes} from './titanRebote';

const poolAave=REDES.base!.pool;
const poolDexA='0x1111111111111111111111111111111111111111';
const poolDexB='0x2222222222222222222222222222222222222222';
const swapV2=id('Swap(address,uint256,uint256,uint256,uint256,address)');
const swapV3=id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const liquidacao={address:poolAave,topics:[TOPIC_LIQUIDATION_CALL]};
const swapA={address:poolDexA,topics:[swapV2]};
const swapB={address:poolDexB,topics:[swapV3]};

test('somente LiquidationCall Aave e swaps em recibo confirmado da MESMA transacao',()=>{
 const obs=detectarRebotesAave([
  {status:'0x1',logs:[liquidacao,swapA,swapB]},
  {status:'0x1',logs:[swapA]}, // uma venda sem liquidacao nao prova relacao
  {status:'0x0',logs:[liquidacao,swapA]}, // revert
  {status:'0x1',logs:[{address:poolDexA,topics:[TOPIC_LIQUIDATION_CALL]},swapB]},
  {status:'0x1',logs:[liquidacao]}, // evento sem swap
 ]);
 assert.equal(obs.liquidacoes,2);
 assert.equal(obs.transacoesComSwaps,1);
 assert.deepEqual(new Set(obs.pools),new Set([poolDexA,poolDexB]));
});
test('respostas desconhecidas nao viram lucro nem pista de rebote',()=>{
 assert.deepEqual(detectarRebotesAave(null),{
   liquidacoes:0,transacoesComSwaps:0,pools:[],
 });
 assert.equal(detectarRebotesAave([{logs:[liquidacao,swapA]}]).pools.length,0);
});
test('radar expira pistas depois de 3 blocos e preserva leitura mais recente',()=>{
 const radar=new RadarDeRebotes();
 radar.registrar(200,{liquidacoes:1,transacoesComSwaps:1,pools:[poolDexA]});
 assert.equal(radar.ativos(202).has(poolDexA),true);
 radar.registrar(202,{liquidacoes:1,transacoesComSwaps:1,pools:[poolDexB]});
 radar.registrar(201,{liquidacoes:0,transacoesComSwaps:0,pools:[]});
 assert.equal(radar.ativos(204).has(poolDexA),false);
 assert.equal(radar.ativos(204).has(poolDexB),true);
 assert.equal(radar.ativos(206).has(poolDexB),false);
});
test('no maximo uma fracao dos candidatos recebe prioridade; nenhum ganha autorizacao',()=>{
 const mk=(chave:string,pool:string)=>({chave,pernas:[{pool}]});
 const x=[mk('a',poolDexB),mk('b',poolDexB),mk('c',poolDexB),mk('d',poolDexB)];
 const q=[...x,mk('f1',poolDexA),mk('f2',poolDexA),mk('f3',poolDexA)];
 const res=priorizarRebotes(x,q,new Set([poolDexA.toLowerCase()]),1);
 assert.equal(res.length,x.length);
 assert.deepEqual(res.map(r=>r.chave),['f1','a','b','c']);
 assert.deepEqual(priorizarRebotes(x,q,new Set(),2),x);
});
