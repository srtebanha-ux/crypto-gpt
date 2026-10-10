// Arquivo: src/escadaDeRpc.test.ts
//
// O defeito que estes testes impedem é o que já estava em produção: failover
// escrito, nunca alcançado. Então o caso central não é "troca quando falha" — é
// "NÃO troca quando o nó respondeu", porque trocar numa reversão gasta os
// milissegundos que decidem a liquidação em cima de uma resposta que já veio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EscadaDeRpc, ehFalhaDeTransporte, escadaDeRpcs, listaDeRpcs, porQueNaoServe } from './escadaDeRpc';

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
