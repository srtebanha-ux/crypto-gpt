import {test} from 'node:test';
import assert from 'node:assert/strict';
import {id} from 'ethers';
import {REDES,TOPIC_LIQUIDATION_CALL} from './liquidacoes';
import {detectarRebotesAave,detectarRebotesMorpho,TOPICO_LIQUIDACAO_MORPHO,RadarDeRebotes,priorizarRebotes} from './titanRebote';

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


const atlas='0x583dcfef0d240dc80753f0f0b26513fee27d9b77';
const morpho='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const morphoLog={address:morpho,topics:[TOPICO_LIQUIDACAO_MORPHO]};

test('Morpho: reconhece liquidacoes em lote via Atlas mesmo sem swap',()=>{
 const obs=detectarRebotesMorpho([
  {status:'0x1',to:atlas,logs:[morphoLog,morphoLog,morphoLog]},
  {status:'0x0',to:atlas,logs:[morphoLog,swapA]},
 ]);
 assert.equal(obs.liquidacoes,3);
 assert.equal(obs.liquidacoesViaAtlas,3);
 assert.equal(obs.transacoesAtlas,1);
 assert.equal(obs.transacoesComSwaps,0);
 assert.deepEqual(obs.pools,[],'a liquidacao sem swap nao pode fabricar rebote');
});
test('Morpho: só promove pool com Swap na MESMA transação confirmada da liquidação',()=>{
 const obs=detectarRebotesMorpho([
  {status:'0x1',to:atlas,logs:[morphoLog,swapA,morphoLog,swapB]},
  {status:'0x1',logs:[swapB]},
  {status:'0x0',logs:[morphoLog,swapB]},
  {status:'0x1',logs:[{address:poolDexA,topics:[TOPICO_LIQUIDACAO_MORPHO]},swapB]},
 ]);
 assert.equal(obs.liquidacoes,2);
 assert.equal(obs.liquidacoesViaAtlas,2);
 assert.equal(obs.transacoesComSwaps,1);
 assert.deepEqual(new Set(obs.pools),new Set([poolDexA,poolDexB]));
});
test('Morpho: sem status confirmado não publica liquidacao nem pools',()=>{
 assert.deepEqual(detectarRebotesMorpho([
   {to:atlas,logs:[morphoLog,swapA]},
 ]),{liquidacoes:0,transacoesComSwaps:0,liquidacoesViaAtlas:0,transacoesAtlas:0,pools:[]});
});
