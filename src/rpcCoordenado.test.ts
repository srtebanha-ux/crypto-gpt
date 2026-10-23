import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgendaRpc,CacheLeituraRpc,ehSaturacaoRpc,agendaRpc} from './rpcCoordenado';

test('30 concurrent reservations obey a rolling quota, including JSON-RPC batch costs',async()=>{
    let t=1000;const inicios:{t:number;custo:number}[]=[];
    const a=new AgendaRpc(20,()=>t,async ms=>{t+=ms;});
    await Promise.all(Array.from({length:30},(_,i)=>(async()=>{
        const custo=i%3===0?4:1;await a.reservar(custo);inicios.push({t,custo});
    })()));
    for(const x of inicios){
        const total=inicios.filter(v=>v.t<=x.t&&x.t-v.t<1000).reduce((n,v)=>n+v.custo,0);
        assert.ok(total<=20,`quota exceeded: ${total}`);
    }
    assert.ok(t>=3000);
    await assert.rejects(a.reservar(21),/excede/);
});

test('429 cooldown is shared by every subsequent reservation and respects Retry-After',async()=>{
    let t=1000;const a=new AgendaRpc(20,()=>t,async ms=>{t+=ms;});
    await a.reservar();a.recusar(10_000);
    await Promise.all([a.reservar(),a.reservar()]);
    assert.equal(t,11_000);
    a.recusar();await a.reservar();assert.equal(t,15_000);
});

test('endpoint instances share quota; unrelated endpoints do not',()=>{
    assert.equal(agendaRpc('https://a.invalid'),agendaRpc('https://a.invalid'));
    assert.notEqual(agendaRpc('https://a.invalid'),agendaRpc('https://b.invalid'));
});

test('concurrent metadata checks coalesce, expire, and do not reuse failures',async()=>{
    let t=1000;let chamadas=0;
    const c=new CacheLeituraRpc<string>(15_000,()=>t);
    const carregar=async()=>{chamadas++;return 'owner-validado';};
    assert.deepEqual(await Promise.all(Array.from({length:12},()=>c.ler('executor',carregar))),
        Array(12).fill('owner-validado'));
    assert.equal(chamadas,1);
    t+=14_999;await c.ler('executor',carregar);assert.equal(chamadas,1);
    t++;await c.ler('executor',carregar);assert.equal(chamadas,2);
    await assert.rejects(c.ler('outro',async()=>{throw Error('429');}),/429/);
    assert.equal(await c.ler('outro',carregar),'owner-validado');
    assert.equal(chamadas,3);
});

test('a contract revert is not a provider throttle; HTTP-200 rate limits are',()=>{
    assert.equal(ehSaturacaoRpc({code:-32007,message:'25/second request limit reached'}),true);
    assert.equal(ehSaturacaoRpc('HTTP 429'),true);
    assert.equal(ehSaturacaoRpc({code:3,message:'execution reverted: PagamentoCurto'}),false);
});

// Real ethers transport against a local JSON-RPC fixture: metadata is cached,
// while every route still gets fresh owner-origin call and gas estimation.
test('two atomic probes reuse metadata but simulate both routes and gas afresh',async()=>{
    const {createServer}=await import('node:http');
    const {ABI_TITAN,simularTitanAoVivo}=await import('./titanExecucao');
    const dono='0x0000000000000000000000000000000000000011';
    const cofre='0x0000000000000000000000000000000000000022';
    const contrato='0x0000000000000000000000000000000000000033';
    const weth='0x4200000000000000000000000000000000000006';
    const contagem=new Map<string,number>();
    const remetentes:string[]=[];
    const server=createServer(async(req,res)=>{
        let cru='';for await(const chunk of req)cru+=chunk;
        const payload=JSON.parse(cru);
        const responder=(p:{method:string;id:number;params:any[]})=>{
            contagem.set(p.method,(contagem.get(p.method)??0)+1);
            let result:unknown;
            if(p.method==='eth_chainId')result='0x2105';
            else if(p.method==='eth_getCode')result='0x6000';
            else if(p.method==='eth_blockNumber')result='0x64';
            else if(p.method==='eth_getBlockByNumber')result={
                number:'0x64',hash:'0x'+'01'.repeat(32),parentHash:'0x'+'02'.repeat(32),
                timestamp:'0x1',nonce:'0x0000000000000000',difficulty:'0x0',
                gasLimit:'0x1c9c380',gasUsed:'0x1',miner:dono,extraData:'0x',
                transactions:[],baseFeePerGas:'0x1',
            };
            else if(p.method==='eth_estimateGas'){
                remetentes.push(p.params[0].from);result='0x186a0';
            }else if(p.method==='eth_call'){
                const data=p.params[0].data;
                if(data===ABI_TITAN.encodeFunctionData('dono'))result=ABI_TITAN.encodeFunctionResult('dono',[dono]);
                else if(data===ABI_TITAN.encodeFunctionData('cofre'))result=ABI_TITAN.encodeFunctionResult('cofre',[cofre]);
                else if(p.params[0].to.toLowerCase()===contrato.toLowerCase()){
                    remetentes.push(p.params[0].from);
                    result=ABI_TITAN.encodeFunctionResult('executarRota',[10n**15n]);
                }else result='0x'+(100n).toString(16).padStart(64,'0');
            }else throw Error('unexpected RPC '+p.method);
            return {jsonrpc:'2.0',id:p.id,result};
        };
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify(Array.isArray(payload)?payload.map(responder):responder(payload)));
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    try{
        const address=server.address() as {port:number};
        const url=`http://127.0.0.1:${address.port}`;
        const env={TITAN_CONTRATO:contrato,TITAN_COFRE:cofre,
            TITAN_ORCAMENTO_GAS_WEI:'1000000000000000',TITAN_LUCRO_GAS_BPS:'100'};
        const plano={rota:[{pool:dono,tokenEntra:weth,tipo:0 as const,pagamento:0n},
            {pool:cofre,tokenEntra:dono,tipo:0 as const,pagamento:0n}],
            quantia:100n,bloco:100,brutoEstimado:0n,liquidoEstimado:0n,estadoConsistente:true};
        for(let i=0;i<2;i++){
            const resultado=await simularTitanAoVivo(plano,url,env);
            assert.equal(resultado.situacao,'executavel',resultado.motivo);
        }
        assert.equal(contagem.get('eth_chainId'),1);
        assert.equal(contagem.get('eth_getCode'),1);
        assert.equal(contagem.get('eth_estimateGas'),2);
        assert.equal(contagem.get('eth_getBlockByNumber'),2);
        assert.equal(contagem.get('eth_blockNumber'),2);
        assert.equal(remetentes.length,4);
        assert.ok(remetentes.every(x=>x.toLowerCase()===dono.toLowerCase()));
        assert.equal(contagem.get('eth_sendRawTransaction'),undefined);
    }finally{
        server.closeAllConnections();
        await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    }
});
