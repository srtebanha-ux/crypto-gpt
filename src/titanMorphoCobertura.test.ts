import test from 'node:test';
import assert from 'node:assert/strict';
import {politicaDeCoberturaMorpho,indiceDeRodadaMorpho} from './titanMorphoCobertura';

test('Morpho: revisita mercados e mais posicoes por rodada, sem mudar sender',()=>{
 const x=politicaDeCoberturaMorpho({});
 assert.equal(x.intervaloMs,180_000);
 assert.equal(x.mercadosPorRodada,36);
 assert.equal(x.mercadosComDevedores,32);
 assert.equal(x.posicoesPorMercado,36);
 assert.equal(x.requisicoesHttp,95);
 assert.equal(x.prazoMs,75_000);
 assert.equal(Object.keys(x).some(k=>/enviar|wallet|nonce|chave/i.test(k)),false);
});

test('Morpho: orcamentos invalidos usam default, valores extremos sao limitados',()=>{
 const x=politicaDeCoberturaMorpho({
   CACA_MORPHO_INTERVALO_MS:'10',
   CACA_MORPHO_MERCADOS_POR_RODADA:'4',
   CACA_MORPHO_MERCADOS_COM_DEVEDORES:'1000',
   CACA_MORPHO_POSICOES_POR_MERCADO:'1000000',
   CACA_MORPHO_HTTP_POR_RODADA:'Infinity',
   CACA_MORPHO_PRAZO_MS:'abc',
 });
 assert.equal(x.intervaloMs,120_000);
 assert.equal(x.mercadosPorRodada,12);
 assert.equal(x.mercadosComDevedores,12);
 assert.equal(x.posicoesPorMercado,60);
 assert.equal(x.requisicoesHttp,95);
 assert.equal(x.prazoMs,75_000);
});

test('Morpho: indice avanca a cada ciclo, nao continua preso em 15 minutos',()=>{
 const intervalo=180_000;
 const a=indiceDeRodadaMorpho(900_000,intervalo);
 assert.equal(indiceDeRodadaMorpho(900_000+intervalo-1,intervalo),a);
 assert.equal(indiceDeRodadaMorpho(900_000+intervalo,intervalo),a+1);
 assert.throws(()=>indiceDeRodadaMorpho(-1,intervalo),/validos/);
 assert.throws(()=>indiceDeRodadaMorpho(5,0),/validos/);
});

test('capacidade ampliada atende 32 mercados sem ampliar HTTP, RPC nem tempo',()=>{
 const x=politicaDeCoberturaMorpho({});
 assert.equal(x.mercadosPorRodada,36);
 assert.equal(x.mercadosComDevedores,32);
 assert.equal(x.requisicoesHttp,95);
 assert.equal(x.prazoMs,75000);
 const explicito=politicaDeCoberturaMorpho({CACA_MORPHO_MERCADOS_COM_DEVEDORES:'20'});
 assert.equal(explicito.mercadosComDevedores,20,'quota explícita sempre prevalece');
});
