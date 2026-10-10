import test from 'node:test';
import assert from 'node:assert/strict';
import { resumoDoCiclo, soOHost, type EstadoDoCiclo } from './resumoDoCiclo';

const cheio: EstadoDoCiclo = {
    versao: '98e5ebd', servico: 'caçando', envioAutorizado: false,
    lidas: 233, pedidas: 233, idadeDoDadoMs: 1200, falhas: 0,
    rpcAtivo: 'base-mainnet.g.alchemy.com', webSocket: true,
    decisoes: 4, decisoesQueAtirariam: 0, duracaoMs: 118, amostras: 500,
};

test('as onze coisas que ela pediu estão na linha', () => {
    const l = resumoDoCiclo(cheio);
    for (const p of ['v 98e5ebd', 'caçando', 'envio desligado', 'cobertura 233/233',
        'dado 1.2s', 'falhas 0', 'rpc base-mainnet.g.alchemy.com', 'ws ligado',
        'decisões 4 (0 atirariam)', 'ciclo 118ms', 'amostras 500']) {
        assert.ok(l.includes(p), `falta "${p}" em: ${l}`);
    }
    assert.equal(l.split(' · ').length, 11, 'onze campos, nem mais nem menos');
});

test('campo ausente sai como `?` e NUNCA como zero', () => {
    const vazio: EstadoDoCiclo = {
        versao: null, servico: 'dormindo', envioAutorizado: false,
        lidas: null, pedidas: null, idadeDoDadoMs: null, falhas: null,
        rpcAtivo: null, webSocket: null, decisoes: null, decisoesQueAtirariam: null,
        duracaoMs: null, amostras: null,
    };
    const l = resumoDoCiclo(vazio);
    assert.ok(!/\b0\b/.test(l), `nenhum zero inventado em: ${l}`);
    // OITO: versão, cobertura, idade, falhas, rpc, decisões, duração, amostras.
    // Serviço e envio nunca são `?` — o laço sempre sabe o que está fazendo e a
    // autorização de envio é um booleano, não uma leitura.
    assert.equal((l.match(/\?/g) ?? []).length, 8, 'um `?` por coisa que não se sabe');
    assert.ok(l.includes('ws não uso'), 'WebSocket não configurado não é WebSocket caído');
});

test('cobertura parcial é marcada INCOMPLETA na própria linha', () => {
    const l = resumoDoCiclo({ ...cheio, lidas: 59_500, pedidas: 62_000, falhas: 2500 });
    assert.match(l, /cobertura 59500\/62000 INCOMPLETA/);
    assert.match(l, /falhas 2500/);
});

test('envio desligado e envio autorizado não se confundem', () => {
    assert.match(resumoDoCiclo({ ...cheio, envioAutorizado: true }), /envio AUTORIZADO/);
    assert.match(resumoDoCiclo(cheio), /envio desligado/);
});

test('o RPC entra só como host: a chave mora no caminho e na consulta', () => {
    assert.equal(soOHost('https://base-mainnet.g.alchemy.com/v2/CHAVE_SECRETA'),
        'base-mainnet.g.alchemy.com');
    assert.equal(soOHost('https://rpc.exemplo/?apikey=SEGREDO'), 'rpc.exemplo');
    assert.equal(soOHost(''), null);
    assert.equal(soOHost('não é url'), null);
    assert.equal(soOHost(null), null);
    const l = resumoDoCiclo({
        ...cheio, rpcAtivo: soOHost('https://base-mainnet.g.alchemy.com/v2/CHAVE_SECRETA'),
    });
    assert.ok(!l.includes('CHAVE_SECRETA'));
});

test('WebSocket caído aparece em maiúscula, porque é o que muda o diagnóstico', () => {
    assert.match(resumoDoCiclo({ ...cheio, webSocket: false }), /ws CAÍDO/);
});
