// Arquivo: src/escadaDeRpc.test.ts
//
// O defeito que estes testes impedem é o que já estava em produção: failover
// escrito, nunca alcançado. Então o caso central não é "troca quando falha" — é
// "NÃO troca quando o nó respondeu", porque trocar numa reversão gasta os
// milissegundos que decidem a liquidação em cima de uma resposta que já veio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EscadaDeRpc, ehFalhaDeTransporte, escadaDeRpcs, listaDeRpcs, porQueNaoServe, logsComRpcHistorico, faixaHistoricaReversa, classificarFalhaHistorica } from './escadaDeRpc';

const A = 'https://a.exemplo/v2/k';
const B = 'https://b.exemplo';
const C = 'https://c.exemplo';

// As fixturas usavam `https://publico`, um host SEM PONTO. Em 2026-10-09 a
// lista passou a recusar o que não é URL de verdade — porque a escada dela
// tinha `mainnet.base.orghttps` como degrau — e `https://publico` cai na mesma
// regra, com razão: não é um domínio. A fixtura virou `publico.exemplo`. Isto
// é corrigir o teste, não afrouxar a regra: o caso real dela é o teste abaixo.
test('listaDeRpcs aceita os três nomes, nessa ordem, e os padrões no fim', () => {
    assert.deepEqual(
        listaDeRpcs({ CACA_RPC_URL: A, RPC_URL_1: B, CACA_RPC_URLS: C }, ['https://publico.exemplo']),
        [A, B, C, 'https://publico.exemplo'],
    );
});

test('listaDeRpcs: só RPC_URL_1 e RPC_URL_2, como ela pediu', () => {
    assert.deepEqual(listaDeRpcs({ RPC_URL_1: A, RPC_URL_2: B }, ['https://publico.exemplo']),
        [A, B, 'https://publico.exemplo']);
});

test('listaDeRpcs não repete: dois nomes para o mesmo host não são redundância', () => {
    // Uma escada de dois degraus que caem juntos é uma escada de um degrau com
    // cara de duas.
    assert.deepEqual(listaDeRpcs({ CACA_RPC_URL: A, RPC_URL_1: A }, [A]), [A]);
});

test('listaDeRpcs ignora vazio, espaço e vírgula solta', () => {
    assert.deepEqual(
        listaDeRpcs({ CACA_RPC_URL: '  ', RPC_URL_1: '', CACA_RPC_URLS: `${A}, ,${B},` }, []),
        [A, B],
    );
});

test('listaDeRpcs cai nos padrões quando o ambiente está vazio', () => {
    assert.deepEqual(listaDeRpcs({}, [A, B]), [A, B]);
});

test('ehFalhaDeTransporte: nó MUDO é falha', () => {
    for (const m of [
        'fetch failed', 'The operation was aborted due to timeout',
        'socket hang up', 'ECONNRESET', 'getaddrinfo ENOTFOUND base.exemplo',
        'HTTP 503 Service Unavailable', '429 Too Many Requests',
        'rate limit exceeded', 'Bad Gateway', 'terminated',
    ]) assert.equal(ehFalhaDeTransporte(m), true, m);
});

test('ehFalhaDeTransporte: nó que RESPONDEU "não" NÃO é falha', () => {
    // Trocar de provedor aqui repetiria o mesmo revert em outro lugar.
    for (const m of [
        'execution reverted', 'execution reverted: HealthFactorNotBelowThreshold()',
        'revertido sem mensagem', 'insufficient funds for gas',
        'nonce too low', 'replacement transaction underpriced',
    ]) assert.equal(ehFalhaDeTransporte(m), false, m);
});

test('ehFalhaDeTransporte: um revert que CONTENHA palavra de rede continua resposta', () => {
    // O caso que inverteria a regra: a reversão sai na frente de propósito.
    assert.equal(ehFalhaDeTransporte('execution reverted: network paused'), false);
    assert.equal(ehFalhaDeTransporte('execution reverted: timeout on oracle'), false);
});

test('uma falha sozinha NÃO troca: soluço de rede não vale perder a conexão quente', () => {
    const e = new EscadaDeRpc([A, B]);
    const r = e.falhou();
    assert.equal(r.trocou, false);
    assert.equal(e.url(), A);
    assert.equal(e.trocas, 0);
});

test('duas falhas seguidas trocam de degrau', () => {
    const e = new EscadaDeRpc([A, B]);
    e.falhou();
    const r = e.falhou();
    assert.equal(r.trocou, true);
    assert.equal(r.de, A);
    assert.equal(r.para, B);
    assert.equal(e.url(), B);
    assert.equal(e.ehOPrimario(), false);
    assert.equal(e.trocas, 1);
});

test('sucesso apaga a conta de falhas: uma falha hoje e outra amanhã não trocam', () => {
    const e = new EscadaDeRpc([A, B]);
    e.falhou();
    e.deuCerto();
    const r = e.falhou();
    assert.equal(r.trocou, false, 'a falha anterior já tinha sido perdoada pelo sucesso');
    assert.equal(e.url(), A);
});

test('todos os degraus caídos VOLTA para o primário em vez de desistir', () => {
    // "Todos fora" é quase sempre a rede local ou o proxy. Insistir no melhor
    // provedor é melhor que insistir no pior, e desistir não é opção.
    const e = new EscadaDeRpc([A, B]);
    e.falhou(); e.falhou();            // A -> B
    assert.equal(e.url(), B);
    e.falhou(); e.falhou();            // B -> volta A
    assert.equal(e.url(), A);
    assert.equal(e.trocas, 2);
});

test('a escada anda em três degraus na ordem configurada', () => {
    const e = new EscadaDeRpc([A, B, C]);
    e.falhou(); e.falhou();
    assert.equal(e.url(), B);
    e.falhou(); e.falhou();
    assert.equal(e.url(), C);
    assert.equal(e.indice(), 2);
    assert.equal(e.quantos(), 3);
});

test('não volta ao primário antes do castigo vencer, e volta depois', () => {
    // Sem o relógio, um soluço de 30s na Alchemy deixaria o bot no RPC público
    // pelo resto do mês: 5x mais lento, degradado em silêncio.
    let agora = 1_000_000;
    const e = new EscadaDeRpc([A, B], { voltarAoPrimarioMs: 300_000, agora: () => agora });
    e.falhou(); e.falhou();
    assert.equal(e.url(), B);
    assert.equal(e.deveVoltarAoPrimario(), false, 'acabou de cair');
    agora += 299_000;
    assert.equal(e.deveVoltarAoPrimario(), false);
    agora += 2_000;
    assert.equal(e.deveVoltarAoPrimario(), true);
    e.voltarAoPrimario();
    assert.equal(e.url(), A);
    assert.equal(e.ehOPrimario(), true);
});

test('no primário nunca "volta ao primário"', () => {
    const e = new EscadaDeRpc([A, B]);
    assert.equal(e.deveVoltarAoPrimario(), false);
});

test('depois de voltar, o primário começa com a conta limpa', () => {
    let agora = 0;
    const e = new EscadaDeRpc([A, B], { voltarAoPrimarioMs: 10, agora: () => agora });
    e.falhou(); e.falhou();
    agora = 100;
    e.voltarAoPrimario();
    // Uma falha só, logo após voltar, não pode derrubar de novo na hora.
    assert.equal(e.falhou().trocou, false);
});

test('um provedor só continua funcionando — e a escada não mente sobre isso', () => {
    const e = new EscadaDeRpc([A]);
    assert.equal(e.quantos(), 1);
    e.falhou();
    const r = e.falhou();
    // Com um degrau, "trocar" é voltar para ele mesmo: a chamada repete, e o
    // log do boot é que avisa que não há redundância.
    assert.equal(r.para, A);
    assert.equal(e.url(), A);
});

test('escada sem url nenhuma morre no boot em vez de caçar sem rede', () => {
    assert.throws(() => new EscadaDeRpc([]), /sem nenhuma url/);
});

test('URL quebrada NÃO é degrau — o caso real do log de 2026-10-09', () => {
    // O log dela às 20:09 imprimiu a escada com CINCO degraus, e o segundo era
    // `mainnet.base.orghttps` — duas URLs coladas sem separador numa variável
    // de ambiente. Esse host não resolve em DNS nenhum.
    //
    // O custo não é cosmético: quando a Alchemy falhasse duas vezes, o bot
    // trocaria para esse degrau morto, gastaria as duas falhas de transporte
    // DELE, e só então chegaria num provedor vivo — no minuto em que o RPC cai,
    // que é o mesmo minuto em que as liquidações acontecem.
    const colada = 'https://mainnet.base.orghttps://base-rpc.publicnode.com';
    assert.ok(porQueNaoServe(colada) !== null, 'duas URLs coladas têm de ser recusadas');
    assert.match(porQueNaoServe(colada)!, /DUAS URLs coladas/);

    const r = escadaDeRpcs(
        { CACA_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/k', CACA_RPC_URLS: colada },
        ['https://mainnet.base.org'],
    );
    assert.deepEqual(r.degraus, ['https://base-mainnet.g.alchemy.com/v2/k', 'https://mainnet.base.org'],
        'a escada fica com os degraus que FUNCIONAM');
    assert.equal(r.recusados.length, 1);
    assert.equal(r.recusados[0]!.url, colada);

    // E o que serve continua servindo: isto não pode virar um filtro que come
    // provedor bom. Alchemy com chave no caminho, porta, path — todos passam.
    for (const boa of [
        'https://base-mainnet.g.alchemy.com/v2/AbC-123_xyz',
        'https://mainnet.base.org',
        'http://localhost.localdomain:8545',
        'https://base.llamarpc.com/',
    ]) {
        assert.equal(porQueNaoServe(boa), null, `${boa} tem de servir`);
    }
    // E o que não serve, com a frase dizendo o que consertar.
    for (const [ruim, padrao] of [
        ['nao-e-url', /não é uma URL/],
        ['wss://base-mainnet.g.alchemy.com/v2/k', /protocolo/],
        ['https://localhost', /não tem ponto/],
        ['https://base..org', /ponto duplo/],
    ] as [string, RegExp][]) {
        assert.match(porQueNaoServe(ruim) ?? '', padrao, ruim);
    }

    // `listaDeRpcs` continua devolvendo só os degraus: quem já a usa não muda.
    assert.deepEqual(
        listaDeRpcs({ CACA_RPC_URLS: `${colada},https://mainnet.base.org` }, []),
        ['https://mainnet.base.org'],
    );
});


const FILTRO_HISTORICO={
    address:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    fromBlock:'0x123',toBlock:'0x124',topics:['0xdead'],
};
test('historico: quando principal responde, nao usa segundo RPC',async()=>{
    let fallbackChamado=0;
    const resultado=await logsComRpcHistorico(async()=>[{blockNumber:'0x123'}],
        FILTRO_HISTORICO,{buscar:async()=>{fallbackChamado++;throw Error('nao deveria ser chamado')}});
    assert.equal(resultado.origem,'primario');
    assert.equal(resultado.logs.length,1);
    assert.equal(fallbackChamado,0);
});
test('historico: archive 403 usa somente eth_getLogs read-only no RPC secundario',async()=>{
    const pedidos:Record<string,unknown>[]=[];
    const resultado=await logsComRpcHistorico<{blockNumber:string}>(
        async()=>{throw Error('HTTP 403 archive requires token')},FILTRO_HISTORICO,{
            urlSecundaria:'https://mainnet.base.org',
            buscar:async(_url,init)=>{
                assert.equal((init?.headers as Record<string,string>)['accept-encoding'],'identity',
                    'history must request plain JSON rather than an unsupported compressed body');
                pedidos.push(JSON.parse(String(init?.body)) as Record<string,unknown>);
                return {ok:true,json:async()=>({jsonrpc:'2.0',id:1,
                    result:[{blockNumber:'0x124'}]})} as Response;
            },
        });
    assert.equal(resultado.origem,'secundario');
    assert.equal(resultado.provedor,'mainnet.base.org');
    assert.equal(resultado.logs[0]?.blockNumber,'0x124');
    assert.equal(pedidos[0]?.method,'eth_getLogs');
    assert.deepEqual(pedidos[0]?.params,[FILTRO_HISTORICO]);
});
test('historico: 403 dos dois RPCs nunca se torna zero liquidacoes',async()=>{
    await assert.rejects(logsComRpcHistorico(async()=>{throw Error('403 archive')},
        FILTRO_HISTORICO,{buscar:async()=>({ok:false,status:403}) as Response}),
        /historico indisponivel em ambos RPCs/);
});
test('historico: resposta malformada nao significa lista vazia',async()=>{
    await assert.rejects(logsComRpcHistorico(async()=>{throw Error('archive')},
        FILTRO_HISTORICO,{buscar:async()=>({ok:true,json:async()=>({result:null})}) as Response}),
        /sem lista de logs valida/);
});
test('historico: RPC secundario aceita apenas HTTPS valido',async()=>{
    await assert.rejects(logsComRpcHistorico(async()=>{throw Error('archive')},
        FILTRO_HISTORICO,{urlSecundaria:'http://exemplo.org'}),
        /invalido/);
});

test('censo da Base: paginação reversa 9 dias sem buracos, inclusive com ajuste de tamanho',()=>{
    const inicio=100000;
    const topo=inicio+388799;
    const vistos=new Set<number>();
    let ate=topo,contagem=0;
    while(ate>=inicio){
        const tamanho=contagem%3===0?1800:contagem%3===1?900:50;
        const f=faixaHistoricaReversa(ate,inicio,tamanho);
        assert.equal(f.ate,ate);
        assert.equal(f.proximoAte,f.de-1);
        for(let n=f.de;n<=f.ate;n++){
            assert.equal(vistos.has(n),false,'releitura desnecessária ou faixa sobreposta');
            vistos.add(n);
        }
        ate=f.proximoAte;
        contagem++;
    }
    assert.equal(vistos.size,388800);
    assert.equal(ate,inicio-1);
    assert.deepEqual(faixaHistoricaReversa(50,49,1800),{de:49,ate:50,proximoAte:48});
    assert.throws(()=>faixaHistoricaReversa(48,49,100),/invalida/);
    assert.throws(()=>faixaHistoricaReversa(100,0,0),/invalida/);
});

test('censo historico: nao reduz faixa por 429, 403, timeout ou erro de rede',()=>{
    for(const msg of [
        'historico indisponivel: secundario=HTTP 429',
        'too many requests',
        'rate limit exceeded',
    ])assert.equal(classificarFalhaHistorica(msg),'frequencia',msg);
    for(const msg of [
        'historico indisponivel: secundario=HTTP 403',
        'unauthorized archive requires subscription',
    ])assert.equal(classificarFalhaHistorica(msg),'acesso',msg);
    for(const msg of [
        'fetch failed',
        'operation aborted due to timeout',
        'HTTP 503 Service Unavailable',
    ])assert.equal(classificarFalhaHistorica(msg),'transitoria',msg);
});
test('censo historico: reduz faixa APENAS quando o provedor nega tamanho da consulta',()=>{
    for(const msg of [
        'block range exceeds limit of 1000 blocks',
        'query returned more than 10000 results',
        'response size exceeded',
        'block range too large',
    ])assert.equal(classificarFalhaHistorica(msg),'faixa',msg);
});

test('historical failover skips denied nodes, verifies Base and keeps the exact unread interval',async()=>{
    const urls=['https://denied.history.test','https://wrong.history.test','https://base.history.test'];
    const chamadas:Array<{url:string;method:string;params:unknown[]}>=[];
    const buscar=async(url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
        const u=String(url),p=JSON.parse(String(init?.body));
        chamadas.push({url:u,...p});
        if(u===urls[0])return {ok:false,status:403} as Response;
        if(p.method==='eth_chainId')return {ok:true,json:async()=>({result:u===urls[1]?'0x1':'0x2105'})} as Response;
        assert.equal(u,urls[2]);assert.equal(p.method,'eth_getLogs');
        assert.deepEqual(p.params,[FILTRO_HISTORICO]);
        return {ok:true,json:async()=>({result:[{blockNumber:FILTRO_HISTORICO.toBlock}]})} as Response;
    };
    const opcoes={urlSecundaria:urls[0],urlsAlternativas:urls.slice(1),chainIdEsperado:8453,buscar};
    for(let i=0;i<2;i++){
        const r=await logsComRpcHistorico(async()=>{throw Error('primary unavailable')},FILTRO_HISTORICO,opcoes);
        assert.equal(r.provedor,'base.history.test');assert.equal(r.logs.length,1);
    }
    assert.equal(chamadas.filter(x=>x.url===urls[0]).length,1,'denied provider is not retried in the next round');
    assert.equal(chamadas.filter(x=>x.url===urls[1]).length,1,'wrong chain is not queried for logs');
    assert.equal(chamadas.filter(x=>x.url===urls[2]&&x.method==='eth_chainId').length,1);
    assert.equal(chamadas.filter(x=>x.method==='eth_getLogs').length,2);
});

test('a 403 is a range rejection ONLY after a same-node one-block control succeeds',async()=>{
    let leituras=0;
    await assert.rejects(logsComRpcHistorico(async()=>{throw Error('primary down')},FILTRO_HISTORICO,{
        urlSecundaria:'https://range-control.history.test',verificarFaixaRecusada:true,
        buscar:async(_url,init)=>{
            const p=JSON.parse(String(init?.body));leituras++;
            if(leituras===1)return {ok:false,status:403} as Response;
            assert.equal(p.params[0].fromBlock,FILTRO_HISTORICO.toBlock);
            assert.equal(p.params[0].toBlock,FILTRO_HISTORICO.toBlock);
            return {ok:true,json:async()=>({result:[]})} as Response;
        },
    }),e=>classificarFalhaHistorica((e as Error).message)==='faixa');
    assert.equal(leituras,2);
});

test('a failed one-block control preserves the access-denied classification',async()=>{
    let leituras=0;
    await assert.rejects(logsComRpcHistorico(async()=>{throw Error('primary down')},FILTRO_HISTORICO,{
        urlSecundaria:'https://denied-control.history.test',verificarFaixaRecusada:true,
        buscar:async()=>{leituras++;return {ok:false,status:403} as Response;},
    }),e=>classificarFalhaHistorica((e as Error).message)==='acesso');
    assert.equal(leituras,2);
});

test('rate limiting the control query cannot turn the original 403 into an access verdict',async()=>{
    let calls=0;
    await assert.rejects(logsComRpcHistorico(async()=>{throw Error('primary down')},FILTRO_HISTORICO,{
        urlSecundaria:'https://rate-control.history.test',verificarFaixaRecusada:true,
        buscar:async()=>{calls++;return {ok:false,status:calls===1?403:429} as Response;},
    }),e=>classificarFalhaHistorica((e as Error).message)==='frequencia');
    assert.equal(calls,2);
});

test('a timed-out control query cannot prove access denial or range restriction',async()=>{
    let calls=0;
    await assert.rejects(logsComRpcHistorico(async()=>{throw Error('primary down')},FILTRO_HISTORICO,{
        urlSecundaria:'https://timeout-control.history.test',verificarFaixaRecusada:true,
        buscar:async()=>{if(++calls===1)return {ok:false,status:403} as Response;throw Error('timeout');},
    }),e=>classificarFalhaHistorica((e as Error).message)==='transitoria');
    assert.equal(calls,2);
});
