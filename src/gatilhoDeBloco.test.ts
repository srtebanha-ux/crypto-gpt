import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsDoHttp, pedidoDeAssinatura, blocoDaMensagem, esperarBlocoOuTempo,
    pedidoDePing, SILENCIO_QUE_MATA_MS, OuvinteDeBlocos } from './gatilhoDeBloco';

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
