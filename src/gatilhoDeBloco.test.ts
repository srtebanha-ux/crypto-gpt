import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsDoHttp, pedidoDeAssinatura, blocoDaMensagem, esperarBlocoOuTempo,
    pedidoDePing, SILENCIO_QUE_MATA_MS, OuvinteDeBlocos,
    lerFalhaDeWs, comoLerAFalhaDeWs, enderecoDeBlocos, classificarNegociacao,
    comoLerANegociacao, idDoEndpoint } from './gatilhoDeBloco';

test('deriva o WebSocket do mesmo provedor', () => {
    assert.equal(wsDoHttp('https://base-mainnet.g.alchemy.com/v2/abc'), 'wss://base-mainnet.g.alchemy.com/v2/abc');
    assert.equal(wsDoHttp('http://localhost:8545'), 'ws://localhost:8545');
});

test('endereço que já é WebSocket passa direto', () => {
    assert.equal(wsDoHttp('wss://x.com/y'), 'wss://x.com/y');
});

test('endereço que não dá para derivar devolve null, não um chute', () => {
    // Chutar faria o bot tentar conectar num lugar que não existe e reclamar
    // para sempre. null quer dizer "segue perguntando", que funciona.
    assert.equal(wsDoHttp('base-mainnet.g.alchemy.com'), null);
    assert.equal(wsDoHttp(''), null);
});

test('o pedido de assinatura é newHeads', () => {
    const p = JSON.parse(pedidoDeAssinatura());
    assert.equal(p.method, 'eth_subscribe');
    assert.deepEqual(p.params, ['newHeads']);
});

test('lê o número do bloco do aviso', () => {
    const bloco = 51781302;
    const aviso = JSON.stringify({
        jsonrpc: '2.0', method: 'eth_subscription',
        params: { subscription: '0xabc', result: { number: `0x${bloco.toString(16)}` } },
    });
    assert.equal(blocoDaMensagem(aviso), bloco);
});

test('a confirmação da assinatura NÃO é um bloco', () => {
    // Ela chega primeiro. Contá-la como bloco faria o bot acordar uma vez sem
    // motivo, logo no começo, e parecer que o gatilho funciona quando não há
    // nada acontecendo.
    const confirmacao = JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x9ce59a13' });
    assert.equal(blocoDaMensagem(confirmacao), null);
});

test('mensagem estranha não derruba nada', () => {
    assert.equal(blocoDaMensagem('não é json'), null);
    assert.equal(blocoDaMensagem('{}'), null);
    assert.equal(blocoDaMensagem(JSON.stringify({ method: 'eth_subscription', params: {} })), null);
});

test('a espera termina no bloco quando ele chega', async () => {
    let desassinou = false;
    const como = await esperarBlocoOuTempo(
        (aoBloco) => { setTimeout(() => aoBloco(123), 1); return () => { desassinou = true; }; },
        1000,
        (fn, ms) => setTimeout(fn, ms),
        (id) => clearTimeout(id as NodeJS.Timeout),
    );
    assert.equal(como, 'bloco');
    assert.equal(desassinou, true, 'tem que desassinar, senão vaza ouvinte a cada espera');
});

test('a espera termina no tempo quando o aviso não vem', async () => {
    // WebSocket caído em silêncio é indistinguível de rede parada. Ficar
    // pendurado seria pior que perguntar.
    const como = await esperarBlocoOuTempo(
        () => () => {},
        5,
        (fn, ms) => setTimeout(fn, ms),
        (id) => clearTimeout(id as NodeJS.Timeout),
    );
    assert.equal(como, 'tempo');
});

test('bloco atrasado depois do tempo não resolve duas vezes', async () => {
    let quantas = 0;
    const p = esperarBlocoOuTempo(
        (aoBloco) => { setTimeout(() => aoBloco(1), 30); return () => {}; },
        5,
        (fn, ms) => setTimeout(fn, ms),
        (id) => clearTimeout(id as NodeJS.Timeout),
    );
    p.then(() => { quantas += 1; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(quantas, 1);
});

// ===================================================================
// O CÃO DE GUARDA — 2026-09-30.
//
// `close` e `error` só chegam quando a queda é LIMPA. Socket meio-aberto
// (idle da Railway, NAT que esquece a conexão, provedor que para de
// empurrar sem fechar o TCP) não dispara nenhum dos dois: `vivo` ficava
// `true` para sempre, o ciclo esperava os 2.500ms inteiros a cada volta,
// e o log imprimia `avisoDeBloco: ligado (último 51954999)` com o número
// congelado. Degradação silenciosa que se parece com saúde.
// ===================================================================

test('o silêncio que mata é 15s, e a Base faz bloco a cada 2s', () => {
    // O número não é escolhido: 15s são ~7 blocos. Bloco nasce mesmo sem
    // ninguém negociar, então silêncio não é mercado calmo.
    assert.equal(SILENCIO_QUE_MATA_MS, 15_000);
    assert.equal(SILENCIO_QUE_MATA_MS / 2000 >= 7, true, 'sete blocos de folga antes de derrubar');
});

test('o ping é JSON-RPC barato, porque o WebSocket do Node não expõe ping()', () => {
    const p = JSON.parse(pedidoDePing());
    assert.equal(p.method, 'net_version');
    assert.equal(p.jsonrpc, '2.0');
    // Id diferente do da assinatura, senão a resposta de um seria lida como a do outro.
    assert.notEqual(JSON.parse(pedidoDePing()).id, JSON.parse(pedidoDeAssinatura()).id);
});

test('o cão derruba a conexão MUDA, e não a saudável', () => {
    let relogio = 1_000_000;
    const o = new OuvinteDeBlocos('wss://exemplo.invalido', undefined, 15_000, () => relogio);
    // Simula a conexão aberta sem tocar a rede: é o estado que o defeito cria.
    (o as unknown as { vivo: boolean }).vivo = true;
    (o as unknown as { ultimoAvisoEm: number }).ultimoAvisoEm = relogio;

    assert.equal(o.msSemAviso(), 0);
    assert.equal(o.baterUmaVez(), false, 'recém-aberta: não derruba');

    relogio += 14_000;
    assert.equal(o.baterUmaVez(), false, '14s ainda é dentro do limite');
    assert.equal(o.vivo, true);

    relogio += 2_000; // 16s de silêncio
    assert.equal(o.baterUmaVez(), true, '16s sem aviso: derruba');
    assert.equal(o.vivo, false, 'e `vivo` passa a dizer a verdade — era isto que mentia');
    assert.equal(o.quedasPorSilencio, 1, 'e a queda fica contada para o log');
});

test('o cão não late numa conexão já fechada nem numa que nunca abriu', () => {
    let relogio = 1_000_000;
    // Nunca abriu: `vivo` falso, `ultimoAvisoEm` zero. Bater não pode derrubar
    // nada nem contar queda — senão o contador do log viraria ruído.
    const nova = new OuvinteDeBlocos('wss://exemplo.invalido', undefined, 15_000, () => relogio);
    assert.equal(nova.msSemAviso(), null, '`null` é "nenhum aviso ainda", e é diferente de zero');
    relogio += 999_999;
    assert.equal(nova.baterUmaVez(), false);
    assert.equal(nova.quedasPorSilencio, 0);

    // Fechada de propósito: `fechar()` é ordem do dono, não falha.
    const fechada = new OuvinteDeBlocos('wss://exemplo.invalido', undefined, 15_000, () => relogio);
    (fechada as unknown as { vivo: boolean }).vivo = true;
    (fechada as unknown as { ultimoAvisoEm: number }).ultimoAvisoEm = relogio - 60_000;
    fechada.fechar();
    assert.equal(fechada.baterUmaVez(), false, 'fechada não reconecta sozinha');
    assert.equal(fechada.quedasPorSilencio, 0);
});

test('QUALQUER mensagem realimenta o cão, não só bloco novo', () => {
    // Marcar só no bloco novo faria o cão derrubar uma conexão saudável num
    // vale de blocos — e o pong, que existe justamente para provar vida,
    // não contaria para nada.
    let relogio = 1_000_000;
    const o = new OuvinteDeBlocos('wss://exemplo.invalido', undefined, 15_000, () => relogio);
    (o as unknown as { vivo: boolean }).vivo = true;
    (o as unknown as { ultimoAvisoEm: number }).ultimoAvisoEm = relogio;
    relogio += 14_000;
    // Um pong (sem número de bloco) tem de valer como sinal de vida.
    (o as unknown as { ultimoAvisoEm: number }).ultimoAvisoEm = relogio;
    relogio += 14_000;
    assert.equal(o.baterUmaVez(), false, '14s desde o pong: a conexão está viva');
});

// ---------------------------------------------------------------------------
// A CAUSA DA FALHA DO WEBSOCKET, que era descartada.
//
// O log de producao trazia `[BLOCOS] conexão de blocos caiu; volto a perguntar
// enquanto reconecto` repetido a cada 30 segundos, sem codigo, sem razao e sem
// distinguir "a rede piscou" de "este provedor nao vai me aceitar". A funcao
// `cair()` RECEBIA o evento e nao olhava nada dele.
// ---------------------------------------------------------------------------

test('o código de fechamento e a razão são capturados, não descartados', () => {
    const f = lerFalhaDeWs({ code: 1008, reason: 'policy violation' }, true);
    assert.equal(f.status, 'caiu');
    assert.equal(f.codigo, 1008);
    assert.equal(f.mensagem, 'policy violation');
    assert.equal(f.persistente, true);
    const frase = comoLerAFalhaDeWs(f);
    assert.match(frase, /código 1008/);
    assert.match(frase, /PERSISTENTE/);
    assert.match(frase, /10 min/);
});

test('conexão que NUNCA abriu é "recusada", não "caiu"', () => {
    assert.equal(lerFalhaDeWs({ code: 1006 }, false).status, 'recusada');
    assert.equal(lerFalhaDeWs({ code: 1006 }, true).status, 'caiu');
    assert.match(comoLerAFalhaDeWs(lerFalhaDeWs({}, false)), /RECUSADA \(nunca abriu\)/);
});

test('código ausente sai `null` e NÃO vira persistente', () => {
    // Zero seria um codigo de fechamento inventado, e "sem codigo" tratado como
    // bloqueio deixaria o bot 10 min sem aviso de bloco por um soluço.
    for (const ev of [{}, undefined, null, 'erro', { code: NaN }]) {
        const f = lerFalhaDeWs(ev, true);
        assert.equal(f.codigo, null, JSON.stringify(ev));
        assert.equal(f.persistente, false);
    }
    assert.match(comoLerAFalhaDeWs(lerFalhaDeWs({}, true)), /NÃO informado pelo evento/);
});

test('1006 (queda anormal) é TRANSITÓRIA: é o código de rede piscando', () => {
    const f = lerFalhaDeWs({ code: 1006 }, true);
    assert.equal(f.persistente, false);
    assert.match(comoLerAFalhaDeWs(f), /transitória/);
    assert.match(comoLerAFalhaDeWs(f), /30s/);
});

test('a faixa 4000–4999 é da aplicação: é ali que o provedor diz cota/autorização', () => {
    for (const c of [4000, 4429, 4999]) assert.equal(lerFalhaDeWs({ code: c }, false).persistente, true);
    assert.equal(lerFalhaDeWs({ code: 3999 }, false).persistente, false);
    assert.equal(lerFalhaDeWs({ code: 5000 }, false).persistente, false);
});

test('a mensagem do WebSocket é SANITIZADA: a chave mora na URL', () => {
    const f = lerFalhaDeWs(
        { code: 1008, reason: 'denied for wss://base-mainnet.g.alchemy.com/v2/CHAVE_SUPER_SECRETA_1234567' },
        false,
    );
    assert.ok(!f.mensagem!.includes('CHAVE_SUPER_SECRETA_1234567'));
    assert.ok(!comoLerAFalhaDeWs(f).includes('CHAVE_SUPER_SECRETA_1234567'));
});

test('o diagnóstico do ouvinte diz ausência de falha sem inventar uma', () => {
    const o = new OuvinteDeBlocos('wss://exemplo.invalido');
    const d = o.diagnostico();
    assert.equal(d.estado, 'configurado', 'há endereço e nada foi tentado ainda');
    assert.equal(d.msSemAviso, null, 'nenhum aviso ainda não é "0ms desde o último"');
    assert.equal(d.falhasPersistentes, 0);
    assert.match(d.ultimaFalha, /nenhuma falha registrada/);
    o.fechar();
});

// ---------------------------------------------------------------------------
// O ENDERECO NAO SE DERIVA POR SUPOSICAO, e a NEGOCIACAO diz qual e o problema.
//
// MEDIDO em 2026-10-10 com `negociarWs`: `wss://mainnet.base.org` responde
// HTTP 405 Method Not Allowed. Era contra esse host que o bot reconectava a
// cada 30 segundos, e a biblioteca so dizia "Received network error or
// non-101 status code.".
// ---------------------------------------------------------------------------

test('sem CACA_WS_URL o bot NÃO deriva o endereço: não conecta e diz por quê', () => {
    const r = enderecoDeBlocos('https://mainnet.base.org', {});
    assert.equal(r.url, null);
    assert.equal(r.origem, 'ausente');
    assert.match(r.porque, /derivar do HTTP seria supor que o provedor oferece o serviço/);
});

test('CACA_WS_URL declarada manda, com caminho e credencial de quem definiu', () => {
    const r = enderecoDeBlocos('https://mainnet.base.org', { CACA_WS_URL: 'wss://x.exemplo/v2/K' });
    assert.equal(r.url, 'wss://x.exemplo/v2/K');
    assert.equal(r.origem, 'declarada');
});

test('CACA_WS_URL inválida é CONFIGURAÇÃO, não bloqueio nem rede', () => {
    const r = enderecoDeBlocos('https://mainnet.base.org', { CACA_WS_URL: 'https://x.exemplo' });
    assert.equal(r.url, null);
    assert.match(r.porque, /configuração INVÁLIDA/);
    assert.match(r.porque, /não é bloqueio nem falha de rede/);
});

test('derivar só com permissão explícita, e a frase diz que é SUPOSIÇÃO', () => {
    const r = enderecoDeBlocos('https://mainnet.base.org', { CACA_WS_DERIVAR: '1' });
    assert.equal(r.url, 'wss://mainnet.base.org');
    assert.equal(r.origem, 'derivada');
    assert.match(r.porque, /SUPOSIÇÃO/);
    assert.match(r.porque, /mainnet\.base\.org em 2026-10-10/);
});

test('o status da negociação separa serviço ausente de bloqueio e de rede', () => {
    // 405 e o que `mainnet.base.org` devolveu, MEDIDO.
    assert.equal(classificarNegociacao(405).classe, 'servicoAusente');
    assert.equal(classificarNegociacao(200).classe, 'servicoAusente');
    assert.equal(classificarNegociacao(426).classe, 'servicoAusente');
    assert.equal(classificarNegociacao(101).classe, 'aceita');
    assert.equal(classificarNegociacao(401).classe, 'autenticacao');
    assert.equal(classificarNegociacao(403).classe, 'autenticacao');
    assert.equal(classificarNegociacao(404).classe, 'caminho');
    assert.equal(classificarNegociacao(429).classe, 'limitacao');
    assert.equal(classificarNegociacao(503).classe, 'transitoria');
    // SEM resposta e transitoria: nao houve negociacao para julgar.
    assert.equal(classificarNegociacao(null, 'ECONNRESET').classe, 'transitoria');
    assert.match(classificarNegociacao(405).mensagem, /não oferece WebSocket aqui/);
    assert.match(classificarNegociacao(401).mensagem, /CONFIGURAÇÃO, não rede/);
});

test('a mensagem da negociação é sanitizada e a frase traz só o host', () => {
    const n = classificarNegociacao(401, 'denied for wss://h.exemplo/v2/CHAVE_SECRETA_LONGA_123456');
    const f = comoLerANegociacao(n, 'wss://h.exemplo/v2/CHAVE_SECRETA_LONGA_123456');
    assert.ok(!f.includes('CHAVE_SECRETA_LONGA_123456'));
    assert.match(f, /h\.exemplo/);
    assert.match(f, /HTTP 401/);
});


test('NUNCA "conectado" antes do evento `open`: os quatro estados', () => {
    // O log de 19:57:13.608 publicou `ligado: true` e 22ms depois a conexão foi
    // recusada: a linha saía logo após `abrir()`, que só AGENDA.
    const o = new OuvinteDeBlocos('wss://exemplo.invalido/v2/CHAVE_SECRETA_LONGA_123');
    assert.equal(o.diagnostico().estado, 'configurado');
    o.abrir();
    assert.notEqual(o.diagnostico().estado, 'conectado',
        '`abrir()` não conecta: ele agenda');
    assert.ok(['conectando', 'recusado'].includes(o.diagnostico().estado));
    o.fechar();
});

test('o endpoint entra no log pelo HOST e pela FORMA do caminho, sem a chave', () => {
    assert.equal(idDoEndpoint('wss://base-mainnet.g.alchemy.com/v2/CHAVE_SECRETA_LONGA_123'),
        'base-mainnet.g.alchemy.com/v2/<23 chars>');
    assert.equal(idDoEndpoint('wss://mainnet.base.org'), 'mainnet.base.org/(raiz)');
    assert.equal(idDoEndpoint('wss://x.exemplo/ws'), 'x.exemplo/ws');
    assert.equal(idDoEndpoint('não é url'), '(endereço ilegível)');
    // A FORMA distingue `/v2/<chave>` de `/ws` sem publicar nada.
    assert.notEqual(idDoEndpoint('wss://h/v2/AAAAAAAAAAAAAAAAAAAAAAA'),
        idDoEndpoint('wss://h/ws'));
    assert.ok(!idDoEndpoint('wss://h/v2/CHAVE_SECRETA_LONGA_123').includes('CHAVE'));
});

test('o diagnóstico traz o endpoint sanitizado, não a URL', () => {
    const o = new OuvinteDeBlocos('wss://h.exemplo/v2/CHAVE_SECRETA_LONGA_123');
    const d = o.diagnostico();
    assert.equal(d.endpoint, 'h.exemplo/v2/<23 chars>');
    assert.ok(!JSON.stringify(d).includes('CHAVE_SECRETA_LONGA_123'));
    o.fechar();
});
