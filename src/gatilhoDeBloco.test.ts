import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsDoHttp, pedidoDeAssinatura, blocoDaMensagem, esperarBlocoOuTempo } from './gatilhoDeBloco';

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
