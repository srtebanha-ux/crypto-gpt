import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {diagnosticarReversaoTitan,tamanhosDePrecisaoTitan,retentarTamanhoPorErroTitan} from './titanTaticas';

const abi=new Interface([
  'error PagamentoCurto(uint256 tem,uint256 devido)',
  'error LucroInsuficiente(uint256 obtido,uint256 minimo)',
]);

test('PagamentoCurto aninhado e uma rota economicamente INVIAVEL, nao erro desconhecido',()=>{
  const data=abi.encodeErrorResult('PagamentoCurto',[451470n,453976n]);
  const e={info:{error:{data}}};
  const r=diagnosticarReversaoTitan(e);
  assert.equal(r?.tipo,'pagamento-curto');
  if(r?.tipo!=='pagamento-curto')throw Error('decoder falhou');
  assert.equal(r.tem,451470n);
  assert.equal(r.devido,453976n);
  assert.equal(r.deficit,2506n);
  assert.equal(r.deficitBps,55n);
  assert.deepEqual(tamanhosDePrecisaoTitan(1000n,r),[500n]);
});
test('na borda de arredondamento testa uma escada curta, +1/-1 somente ate 1bp',()=>{
  const data=abi.encodeErrorResult('PagamentoCurto',[999_999n,1_000_000n]);
  const r=diagnosticarReversaoTitan({error:{data}});
  assert.equal(r?.tipo,'pagamento-curto');
  assert.deepEqual(tamanhosDePrecisaoTitan(100_000n,r),[50_000n,99_999n,100_001n]);
});
test('LucroInsuficiente representa falta de lucro, nao sucesso',()=>{
  const data=abi.encodeErrorResult('LucroInsuficiente',[0n,10n]);
  assert.deepEqual(diagnosticarReversaoTitan({data}),{
    tipo:'lucro-insuficiente',obtido:0n,minimo:10n,deficit:10n
  });
});
test('nenhum dado/erro conhecido nao vira sinal economico',()=>{
  assert.equal(diagnosticarReversaoTitan({data:'0x12345678'}),null);
  assert.equal(diagnosticarReversaoTitan(new Error('connection reset')),null);
  assert.deepEqual(tamanhosDePrecisaoTitan(500n,null),[]);
});

test('resultado de revert near-breakeven autoriza APENAS segunda cotacao offchain',()=>{
  assert.deepEqual(retentarTamanhoPorErroTitan(1_000_000n,'pagamento-curto','55'),[500_000n]);
  assert.deepEqual(retentarTamanhoPorErroTitan(1_000_000n,'lucro-insuficiente','55'),[]);
  assert.deepEqual(retentarTamanhoPorErroTitan(1_000_000n,undefined,'55'),[]);
  assert.deepEqual(retentarTamanhoPorErroTitan(1_000_000n,'pagamento-curto','ruim'),[]);
});
