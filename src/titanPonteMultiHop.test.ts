import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, type JsonRpcProvider } from 'ethers';
import { Decimal } from 'decimal.js';
import { gerarRotasLiquidacao } from './titanRotasLiquidacao';
import { ABI_MULTI, codificarMulti, poolsDaConfiguracao, gasEmTokenDaDivida, validarPonte, lucroConfirmadoPorEventoMulti, poolsDoCaca, FABRICA_V3_BASE, tetoL1PeloCaca, creditoMaximoComResiduoCbBtc, CBBTC_BASE, POOLS_CBBTC_V3_BASE } from './titanPonteMultiHop';
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

test('CACA reaproveita pools V3 da Base sem segundo JSON no Railway',()=>{
    assert.match(FABRICA_V3_BASE,/^0x[0-9a-fA-F]{40}$/);
    const pools=poolsDoCaca();
    assert.equal(pools.length,3);
    const weth='0x4200000000000000000000000000000000000006';
    const usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const rotas=gerarRotasLiquidacao(pools,weth,usdc,4,20);
    assert.deepEqual(rotas.map(x=>x.pernas.length),[1,2]);
    assert.deepEqual(poolsDoCaca(''),poolsDoCaca());
});
test('CACA aceita pool extra sem apagar as rotas ja verificadas',()=>{
    const extra={endereco:a(27),token0:a(1),token1:a(2),
        protocolo:'v3',taxa:3000,permitida:true};
    const pools=poolsDoCaca(JSON.stringify([extra]));
    assert.equal(pools.length,4);
    assert.ok(pools.some(x=>x.endereco.toLowerCase()===extra.endereco));
});

test('Multi-Hop usa oraculo de L1 do CACA e margem de segurança',async()=>{
    let chamado=false;
    const rpc={
        call:async(t:{to:string;data:string})=>{
            assert.equal(t.to.toLowerCase(),'0x420000000000000000000000000000000000000f');
            assert.ok(t.data.startsWith('0x'));
            chamado=true;
            return '0x'+(1000n).toString(16).padStart(64,'0');
        }
    } as unknown as JsonRpcProvider;
    assert.equal(await tetoL1PeloCaca(rpc),2000n);
    assert.equal(chamado,true);
    const zero = {call:async()=> '0x'+ '0'.repeat(64)} as unknown as JsonRpcProvider;
    await assert.rejects(()=>tetoL1PeloCaca(zero),/nao retornou custo valido/);
});

test('EURC Slipstream route is opt-in, uses canonical pool and tick spacing 50',()=>{
    const eurc='0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';
    const usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    assert.equal(poolsDoCaca(undefined,false).length,3);
    const pools=poolsDoCaca(undefined,true);
    assert.equal(pools.length,4);
    const rota=gerarRotasLiquidacao(pools,eurc,usdc,4,20);
    assert.equal(rota.length,1);
    assert.equal(rota[0].pernas[0].tipo,2);
    assert.equal(rota[0].pernas[0].fee,50);
    const data=codificarMulti({usuario:a(3),garantia:eurc,divida:usdc},
        1_000_000n,1n,rota[0]);
    const decoded=ABI_MULTI.decodeFunctionData('liquidar',data);
    assert.equal(decoded[5][0].tipo,2n);
    assert.equal(decoded[5][0].fee,50n);
});
test('Slipstream spoofed pool or spacing fails closed',()=>{
    const real=poolsDoCaca(undefined,true)[3];
    for (const p of [{...real,taxa:60},{...real,endereco:a(99)},
        {...real,token0:a(98)}]) {
        assert.equal(gerarRotasLiquidacao([p],real.token0,real.token1).length,0);
        assert.throws(()=>poolsDaConfiguracao(JSON.stringify([p])));
    }
});

test('cbBTC/USDC routes require explicit opt-in; legacy pools remain identical',()=>{
    const usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    assert.equal(poolsDoCaca(undefined,false,false).length,3);
    assert.equal(gerarRotasLiquidacao(poolsDoCaca(undefined,false,false),CBBTC_BASE,usdc).length,0);
    const pools=poolsDoCaca(undefined,false,true);
    assert.equal(pools.length,6);
    const rotas=gerarRotasLiquidacao(pools,CBBTC_BASE,usdc);
    assert.ok(rotas.some(r=>r.pernas.length===1&&r.pernas[0].fee===500));
    assert.ok(rotas.some(r=>r.pernas.length===1&&r.pernas[0].fee===3000));
    assert.ok(rotas.some(r=>r.pernas.length===2&&r.caminho[1].toLowerCase()==='0x4200000000000000000000000000000000000006'));
    for(const p of POOLS_CBBTC_V3_BASE){
        assert.equal(p.protocolo,'v3');
        assert.equal(p.permitida,true);
    }
});
test('Aave residue cap keeps cbBTC target debt safely above measured dust',()=>{
    const debt=1_891_533_663n;
    const half=debt/2n;
    const safe=creditoMaximoComResiduoCbBtc(debt,new Decimal('1891.533663'),half);
    assert.ok(safe>870_000_000n&&safe<872_000_000n);
    assert.ok(safe<half);
    const remains=new Decimal(debt.toString()).minus(safe).div(1_000_000);
    assert.ok(remains.gte(new Decimal('1020.1632')));
    assert.equal(creditoMaximoComResiduoCbBtc(3_000_000_000n,new Decimal(3000),1_500_000_000n),1_500_000_000n);
    assert.equal(creditoMaximoComResiduoCbBtc(1_000_000_000n,new Decimal(1000),500_000_000n),0n);
    assert.equal(creditoMaximoComResiduoCbBtc(debt,new Decimal(1891.53),0n),0n);
});
