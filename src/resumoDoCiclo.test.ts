import test from 'node:test';
import assert from 'node:assert/strict';
import { resumoDoCiclo, soOHost, type EstadoDoCiclo } from './resumoDoCiclo';

const cheio: EstadoDoCiclo = {
    versao: '98e5ebd', servico: 'caçando', envioAutorizado: false,
    lidas: 233, pedidas: 233, idadeDoDadoMs: 1200, falhas: 0,
    rpcAtivo: 'base-mainnet.g.alchemy.com', webSocket: true,
    decisoes: 4, decisoesQueAtirariam: 0, duracaoMs: 118, amostras: 500,
    semLeituraValida: 0, blocosPendentes: 0, descobertaAdiada: false,
};

test('as onze coisas que ela pediu estão na linha', () => {
    const l = resumoDoCiclo(cheio);
    for (const p of ['v 98e5ebd', 'caçando', 'envio desligado', 'cobertura 233/233',
        'dado 1.2s', 'falhas 0', 'rpc base-mainnet.g.alchemy.com', 'ws ligado',
        'decisões 4 (0 atirariam)', 'ciclo 118ms', 'amostras 500']) {
        assert.ok(l.includes(p), `falta "${p}" em: ${l}`);
    }
    // TREZE: os onze dela mais os dois que ela mandou separar da cobertura —
    // posições conhecidas sem leitura válida, e o atraso da descoberta.
    assert.equal(l.split(' · ').length, 13, 'os onze mais os dois separados');
});

test('campo ausente sai como `?` e NUNCA como zero', () => {
    const vazio: EstadoDoCiclo = {
        versao: null, servico: 'dormindo', envioAutorizado: false,
        lidas: null, pedidas: null, idadeDoDadoMs: null, falhas: null,
        rpcAtivo: null, webSocket: null, decisoes: null, decisoesQueAtirariam: null,
        duracaoMs: null, amostras: null,
        semLeituraValida: null, blocosPendentes: null, descobertaAdiada: null,
    };
    const l = resumoDoCiclo(vazio);
    assert.ok(!/\b0\b/.test(l), `nenhum zero inventado em: ${l}`);
    // OITO: versão, cobertura, idade, falhas, rpc, decisões, duração, amostras.
    // Serviço e envio nunca são `?` — o laço sempre sabe o que está fazendo e a
    // autorização de envio é um booleano, não uma leitura.
    assert.equal((l.match(/\?/g) ?? []).length, 10, 'um `?` por coisa que não se sabe');
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

test('`250/250` NÃO esconde as posições sem leitura nem os blocos pendentes', () => {
    // O caso real de 2026-10-11: o ciclo da brasa leu as 250 dele E havia
    // 5.750 posições sem estado e 2.135 blocos pendentes de descoberta.
    const l = resumoDoCiclo({
        ...cheio, lidas: 250, pedidas: 250,
        semLeituraValida: 5750, blocosPendentes: 2135, descobertaAdiada: true,
    });
    assert.match(l, /cobertura 250\/250/, 'a cobertura do CICLO continua verdadeira');
    assert.ok(!/INCOMPLETA/.test(l), 'o ciclo leu tudo que pediu — isso não é falso');
    assert.match(l, /semLeitura 5750/, 'e os 5.750 aparecem, em campo próprio');
    assert.match(l, /descoberta ADIADA \(2135 blocos pendentes\)/);
});

test('descoberta em dia com nada pendente não inventa número', () => {
    const l = resumoDoCiclo({ ...cheio, descobertaAdiada: false, blocosPendentes: 0 });
    assert.match(l, /descoberta em dia/);
    assert.ok(!/blocos pendentes/.test(l));
    assert.match(resumoDoCiclo({ ...cheio, descobertaAdiada: null, blocosPendentes: null }),
        /descoberta \?/);
});
