import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { Decimal } from 'decimal.js';
import { ABI_MULTI, codificarMulti, poolsDaConfiguracao, gasEmTokenDaDivida, validarPonte, lucroConfirmadoPorEventoMulti } from './titanPonteMultiHop';
const a=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const pool={endereco:a(11),token0:a(1),token1:a(2),protocolo:'v3' as const,taxa:500,permitida:true};
test('ABI do contrato implantavel recebe tuple[] e piso nao zero',()=>{
    const data=codificarMulti({usuario:a(3),garantia:a(1),divida:a(2)},1000n,100n,
        {pernas:[{pool:a(11),tokenEntra:a(1),tipo:0,fee:500}],caminho:[a(1),a(2)],chave:a(11)});
    const r=ABI_MULTI.decodeFunctionData('liquidar',data);
    assert.equal(r[3],1000n); assert.equal(r[4],100n);
    assert.equal(r[5][0].fee,500n); assert.equal(r[5][0].tokenEntra.toLowerCase(),a(1));
});
test('tamanho ou piso zero jamais codificados',()=>{
    const rota={pernas:[{pool:a(11),tokenEntra:a(1),tipo:0 as const,fee:500}],caminho:[a(1),a(2)],chave:a(11)};
    assert.throws(()=>codificarMulti({usuario:a(3),garantia:a(1),divida:a(2)},100n,0n,rota));
});
test('JSON recusa pools sem comprovacao explicita',()=>{
    assert.throws(()=>poolsDaConfiguracao(JSON.stringify([{...pool,permitida:false}])));
    assert.throws(()=>poolsDaConfiguracao(JSON.stringify([{...pool,taxa:20000}])));
    assert.deepEqual(poolsDaConfiguracao(JSON.stringify([pool])),[pool]);
});
test('gas em divida converte casas decimais sem perder precisao',()=>{
    // 100000 gas * 1gwei + 0 reserva, ETH 2000 USD = 0.20 USDC.
    assert.equal(gasEmTokenDaDivida(100000n,1_000_000_000n,0n,
        1_000_000n,new Decimal(1),new Decimal(2000)),200_000n);
});
test('validacao financeira barra referencia a gas/preco sem fundamento',()=>{
    const e={usuario:a(3),garantia:a(1),divida:a(2),dono:a(4),contrato:a(5),
        cofre:a(6),aave:a(7),fabricaV3:a(8),pools:[pool],dividaCrua:1_000_000n,
        creditoMaximo:500_000n,dividaUsd:new Decimal(1),ethUsd:new Decimal(2000),
        maxFeePerGas:1_000_000_000n,reservaL1Wei:0n,gasMax:1_000_000n};
    assert.throws(()=>validarPonte(e),/invalidos/);
    e.reservaL1Wei=1000n;assert.doesNotThrow(()=>validarPonte(e));
});

test('evento assinado do executor comprova pagamento; contrato, alvo ou valor divergentes nao',()=>{
    const frag=ABI_MULTI.getEvent('LiquidouComRota');
    assert.ok(frag);
    const usuario=a(3),contrato=a(9),p1=a(11),p2=a(12);
    const ev=ABI_MULTI.encodeEventLog(frag,[usuario,p1,p2,1000n,130n]);
    const logs=[{address:contrato,topics:ev.topics,data:ev.data}];
    assert.equal(lucroConfirmadoPorEventoMulti(logs,contrato,usuario,1000n),130n);
    assert.equal(lucroConfirmadoPorEventoMulti(logs,a(5),usuario,1000n),null);
    assert.equal(lucroConfirmadoPorEventoMulti(logs,contrato,a(4),1000n),null);
    assert.equal(lucroConfirmadoPorEventoMulti(logs,contrato,usuario,999n),null);
    assert.equal(lucroConfirmadoPorEventoMulti([],contrato,usuario,1000n),null);
});
