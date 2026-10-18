import test from 'node:test';
import assert from 'node:assert/strict';
import {selecionarProximaProvaV2,V2_TOKENS_COM_REPROVACAO_NO_FORK} from './titanV2Selecao';
const t='0x7787548c57031023c031304f274beda304da734f';
const outro='0x4200000000000000000000000000000000000006';
const p=(T:string,emprestimo:string,venda:string)=>({
 candidato:{T,emprestimo:{endereco:emprestimo},venda:{endereco:venda}}
});
test('ignore token demonstrably taxed and probe next WETH-compatible route',()=>{
 const route=[p(t,'0xA','0xB'),p(outro,'0xC','0xD')];
 const chosen=selecionarProximaProvaV2(route,new Map(),300_000);
 assert.equal(chosen.oportunidade,route[1]);
 assert.equal(chosen.ignoradoPorTaxa,1);
 assert.equal(V2_TOKENS_COM_REPROVACAO_NO_FORK[0],t);
});
test('cooldown is per route, no fabricated profitable candidate',()=>{
 const route=[p(t,'0xA','0xB'),p(outro,'0xC','0xD')];
 const x=selecionarProximaProvaV2(route,new Map([['0xc>0xd',100_000]]),150_000);
 assert.equal(x.oportunidade,null);
 assert.equal(x.esgotadas,1);
 assert.equal(x.ignoradoPorTaxa,1);
});
