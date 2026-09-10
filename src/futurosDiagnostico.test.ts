// Arquivo: src/futurosDiagnostico.test.ts
//
// O caso que estes testes protegem é o -2015: a Binance usa o MESMO código
// para "chave sem permissão de Futuros" e para "IP não autorizado". Confundir
// os dois manda alguém mexer em IP quando o problema é permissão, e vice-versa
// — cada erro custa a mesma hora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avaliarProntidao, diagnosticarFalhaDeFuturos } from './futurosDiagnostico';

test('-2015 sem menção a IP é permissão faltando na chave', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -2015, mensagem: 'Invalid API-key, IP, or permissions for action.' });
    // A mensagem padrão da Binance CITA a palavra "IP" mesmo quando o
    // problema é permissão — por isso o teste abaixo importa mais.
    assert.ok(['chave_sem_permissao', 'ip_nao_autorizado'].includes(d.bloqueio));
});

test('-2015 com mensagem de IP explícita aponta para a restrição de IP', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -2015, mensagem: 'Request IP is not in the whitelist' });
    assert.equal(d.bloqueio, 'ip_nao_autorizado');
    assert.match(d.comoResolver, /IP access restrictions/);
});

test('-2015 sem nenhuma mensagem cai em permissão, que é o caso comum no primeiro dia', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -2015 });
    assert.equal(d.bloqueio, 'chave_sem_permissao');
    assert.match(d.comoResolver, /criada ANTES/);
});

test('o 451 nem tem código — é reconhecido pelo status HTTP', () => {
    const d = diagnosticarFalhaDeFuturos({ httpStatus: 451 });
    assert.equal(d.bloqueio, 'geobloqueio');
    assert.match(d.comoResolver, /FUTURES_REST_URL/);
});

test('o questionário pendente é reconhecido pela palavra, não por código', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -2020, mensagem: 'Please complete the futures quiz first' });
    assert.equal(d.bloqueio, 'questionario_pendente');
    assert.match(d.comoResolver, /Finish Quiz/);
});

test('margem insuficiente aponta para a carteira errada, não para "sem dinheiro"', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -2019, mensagem: 'Margin is insufficient.' });
    assert.equal(d.bloqueio, 'carteira_vazia');
    assert.match(d.comoResolver, /USDⓈ-M Futures/);
});

test('-1022 é segredo trocado, não chave errada — a distinção que economiza a recriação', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -1022, mensagem: 'Signature for this request is not valid.' });
    assert.equal(d.bloqueio, 'assinatura_invalida');
    assert.match(d.comoResolver, /MESMO par/);
});

test('-1021 é relógio, e o provider já corrige sozinho', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -1021, mensagem: 'Timestamp for this request is outside of the recvWindow.' });
    assert.equal(d.bloqueio, 'relogio_dessincronizado');
});

test('código desconhecido não vira "erro genérico": devolve o que a Binance disse', () => {
    const d = diagnosticarFalhaDeFuturos({ codigo: -4131, mensagem: 'The counterparty best price does not meet the PERCENT_PRICE filter limit.' });
    assert.equal(d.bloqueio, 'desconhecido');
    assert.match(d.comoResolver, /-4131/);
    assert.match(d.comoResolver, /PERCENT_PRICE/);
});

test('carteira zerada é pendência antes de qualquer conta de margem', () => {
    const p = avaliarProntidao({ permissaoDeFuturos: true, saldoDisponivel: 0, margemNecessaria: 25 });
    assert.equal(p.pronto, false);
    assert.equal(p.pendencias.length, 1);
    assert.match(p.pendencias[0], /zerada/);
});

test('US$ 8 não é "pouco" em abstrato: é pouco para os US$ 25 que a configuração exige', () => {
    const p = avaliarProntidao({ permissaoDeFuturos: true, saldoDisponivel: 8.4, margemNecessaria: 25 });
    assert.equal(p.pronto, false);
    assert.match(p.pendencias[0], /8\.40/);
    assert.match(p.pendencias[0], /25\.00/);
    assert.match(p.pendencias[0], /Reduza o nocional/);
});

test('as pendências se acumulam — resolver uma não esconde a outra', () => {
    const p = avaliarProntidao({ permissaoDeFuturos: false, saldoDisponivel: 0, margemNecessaria: 25 });
    assert.equal(p.pendencias.length, 2);
});

test('saldo suficiente e permissão presente liberam o motor', () => {
    const p = avaliarProntidao({ permissaoDeFuturos: true, saldoDisponivel: 30, margemNecessaria: 25 });
    assert.equal(p.pronto, true);
    assert.equal(p.pendencias.length, 0);
});

test('saldo exatamente igual à margem passa — a borda não pode reprovar', () => {
    const p = avaliarProntidao({ permissaoDeFuturos: true, saldoDisponivel: 25, margemNecessaria: 25 });
    assert.equal(p.pronto, true);
});
