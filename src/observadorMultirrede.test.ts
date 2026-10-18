import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type Log,type JsonRpcProvider} from 'ethers';
import {
    REDES_AAVE_V3,ifaceAave,alvosDeBorrow,faixasHistoricas,
    redesSolicitadas,carregarEstado,salvarEstado,verificarRede,faixasSegurasPorRede,tamanhoSeguroPorRede,faixaAposErroRpc,faixaAposSucessos,
} from './observadorMultirrede';

test('configuracao read-only: cada rede usa o Pool oficial com seu proprio chainId',()=>{
    assert.deepEqual(Object.values(REDES_AAVE_V3).map(r=>r.id),[42161,43114,137,10]);
    for(const c of Object.values(REDES_AAVE_V3)){
        assert.match(c.pool,/^0x[0-9a-fA-F]{40}$/);
        assert.ok(c.rpcPadrao.startsWith('https://'));
        assert.ok(c.envRpc.startsWith('CACA_OBSERVADOR_RPC_'));
    }
});
test('nao permite redes desconhecidas',()=>{
    assert.deepEqual(redesSolicitadas('arbitrum,optimism,arbitrum,pseudorede'),['arbitrum','optimism']);
    assert.deepEqual(redesSolicitadas('pseudorede'),[]);
});
test('faixa historica nao pula nem repete blocos',()=>{
    assert.deepEqual(faixasHistoricas(100,105,2),[[100,101],[102,103],[104,105]]);
    assert.deepEqual(faixasHistoricas(105,100),[]);
    assert.deepEqual(faixasHistoricas(-1,10),[]);
});
test('Borrow identifica o devedor correto: onBehalfOf, nao quem pediu o emprestimo',()=>{
    const event=ifaceAave.getEvent('Borrow')!;
    const reserve='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const operador='0x03d0a5c9e1843986fb2f9335f7eb936754f7eaf0';
    const dono='0x1b9f859e0c9d14f516273552d8de48b77388603c';
    const encoded=ifaceAave.encodeEventLog(event,[reserve,operador,dono,1000000n,2,1n,0]);
    const log={topics:encoded.topics,data:encoded.data} as unknown as Log;
    assert.deepEqual(alvosDeBorrow([log]),[dono]);
    assert.deepEqual(alvosDeBorrow([log,log]),[dono]);
});
test('checkpoint malformado nunca produz estado de cobertura inventado',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'multichain-aave-'));
    try{
        const file=join(dir,'state.json');
        assert.deepEqual(await carregarEstado(file),{versao:1,redes:{}});
        await salvarEstado(file,{versao:1,redes:{arbitrum:{
            proximoBloco:50,observados:['0x03d0a5c9e1843986fb2f9335f7eb936754f7eaf0'],
            proximoIndice:0,
        }}});
        assert.equal((await carregarEstado(file)).redes.arbitrum?.proximoBloco,50);
    }finally{await rm(dir,{recursive:true,force:true})}
});
test('RPC apontando para chainId incorreto nunca inicia observacao',async()=>{
    const fake={
        getNetwork:async()=>({chainId:8453n}),
        getBlockNumber:async()=>100,
        getCode:async()=> '0x1234',
    } as unknown as JsonRpcProvider;
    await assert.rejects(verificarRede(fake,REDES_AAVE_V3.arbitrum),/chainId/);
});
test('RPC sem contrato Aave V3 nunca produz falso zero',async()=>{
    const fake={
        getNetwork:async()=>({chainId:42161n}),
        getBlockNumber:async()=>100,
        getCode:async()=> '0x',
    } as unknown as JsonRpcProvider;
    await assert.rejects(verificarRede(fake,REDES_AAVE_V3.arbitrum),/nao implantado/);
});

test('Avalanche limita burst sem reduzir cadencia Arbitrum',()=>{
    assert.equal(faixasSegurasPorRede('avalanche',16),3);
    assert.equal(faixasSegurasPorRede('avalanche',2),2);
    assert.equal(faixasSegurasPorRede('arbitrum',8),8);
    assert.equal(faixasSegurasPorRede('polygon',8),8);
    assert.equal(faixasSegurasPorRede('optimism',8),8);
    assert.throws(()=>faixasSegurasPorRede('avalanche',0),/invalido/);
});

test('Arbitrum recupera backlog e limita faixa separadamente das outras redes',()=>{
    assert.equal(tamanhoSeguroPorRede('arbitrum',50),200);
    assert.equal(tamanhoSeguroPorRede('arbitrum',250),250);
    assert.equal(tamanhoSeguroPorRede('avalanche',50),100);
    assert.equal(tamanhoSeguroPorRede('avalanche',200),100);
    assert.equal(tamanhoSeguroPorRede('optimism',50),50);
    assert.equal(tamanhoSeguroPorRede('polygon',50),50);
    assert.throws(()=>tamanhoSeguroPorRede('arbitrum',0),/invalido/);
});

test('Polygon reduz faixa rejeitada e restaura throughput apenas apos ciclos estaveis',()=>{
    assert.equal(faixaAposErroRpc(50,'could not coalesce error: invalid block range params'),25);
    assert.equal(faixaAposErroRpc(25,'invalid block range params'),12);
    assert.equal(faixaAposErroRpc(1,'invalid block range params'),1);
    assert.equal(faixaAposErroRpc(50,'network timeout'),50);
    assert.equal(faixaAposSucessos(12,50,19),12);
    assert.equal(faixaAposSucessos(12,50,20),24);
    assert.equal(faixaAposSucessos(24,50,20),48);
    assert.equal(faixaAposSucessos(48,50,20),50);
    assert.throws(()=>faixaAposErroRpc(0,'invalid block range params'),/invalida/);
});
