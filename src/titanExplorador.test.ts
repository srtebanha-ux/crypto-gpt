import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ExploradorDeRotasTitan,limiteAtomicoSeguro} from './titanExplorador';
const signal=(rota:string,net:bigint,bruto:bigint=net+1n)=>({
    rota,lucroBrutoEstimado:bruto,lucroLiquidoEstimado:net,
    melhorTamanho:100n,motivo:'CONSISTENTE',
});
const rota=(chave:string,pernas=2)=>({chave,pernas:Array(pernas).fill({})});
test('seleciona lucro liquido, em vez de lucro bruto, e desempata por gas provavel',()=>{
    const e=new ExploradorDeRotasTitan();
    const s=[signal('a',10n,100000n),signal('b',90n,95n),signal('c',90n,100n)];
    const rs=[rota('a'),rota('b',3),rota('c',2)];
    assert.deepEqual(e.selecionar(s,rs,3,1000).map(x=>x.sinal.rota),['c','b','a']);
});
test('rota inviavel nao monopoliza o monitor; alternativa ganha chance',()=>{
    const e=new ExploradorDeRotasTitan(90_000,25_000),s=[signal('a',999n),signal('b',100n)];
    const rs=[rota('a'),rota('b')];
    e.registrar('a','inviavel',1000);
    assert.deepEqual(e.selecionar(s,rs,2,2000).map(x=>x.sinal.rota),['b']);
    assert.deepEqual(e.selecionar(s,rs,2,92000).map(x=>x.sinal.rota),['a','b']);
});
test('descarta sinais sem custo/estado/tamanho e nao duplica rotas',()=>{
    const e=new ExploradorDeRotasTitan(),ss=[
        signal('a',100n),{...signal('b',90n),lucroLiquidoEstimado:null},
        {...signal('c',90n),motivo:'ESTADO_INCONSISTENTE'},
        {...signal('d',90n),melhorTamanho:null},signal('a',100n),
        signal('e',0n)
    ];
    assert.deepEqual(e.selecionar(ss,[rota('a'),rota('b'),rota('c'),
        rota('d'),rota('e')],4,1).map(x=>x.sinal.rota),['a']);
});
test('qualquer configuracao inesperada conserva limite de consultas por ciclo',()=>{
    assert.equal(limiteAtomicoSeguro(undefined),2);
    for(const bad of ['0','5','99999999','-1','', 'NaN','2.0'])
        assert.equal(limiteAtomicoSeguro(bad),2);
    assert.equal(limiteAtomicoSeguro('4'),4);
});
