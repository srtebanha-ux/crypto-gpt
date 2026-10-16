import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorDeColeta, TENTATIVAS_POR_LACUNA, LACUNAS_POR_VOLTA } from './cursorDeColeta';

test('o cursor NÃO avança por cima de uma lacuna', () => {
    const c = new CursorDeColeta(1000);
    c.varri(1001, 1200, true);
    assert.equal(c.cursorContiguo, 1200);
    // A janela do meio falha. O cursor PARA antes dela, para sempre, até ela
    // ser recuperada — senão o buraco vai ao disco e o próximo boot começa
    // depois dele e ninguém volta.
    c.varri(1201, 1400, false, 'request limit reached');
    c.varri(1401, 1600, true);
    assert.equal(c.ultimoTentado, 1600, 'eu TENTEI até 1600');
    assert.equal(c.cursorContiguo, 1200, 'mas só afirmo cobertura até 1200');
    assert.equal(c.blocosEmFalta(), 200);
});

test('os três números são diferentes e saem juntos na frase', () => {
    const c = new CursorDeColeta(1000);
    c.viBloco(2000);
    c.varri(1001, 1400, false);
    c.varri(1401, 1500, true);
    assert.equal(c.blocoObservado, 2000);
    assert.equal(c.ultimoTentado, 1500);
    assert.equal(c.cursorContiguo, 1000);
    const f = c.comoLer();
    assert.match(f, /bloco OBSERVADO 2000/);
    assert.match(f, /último TENTADO 1500/);
    assert.match(f, /cobertura CONTÍGUA 1000/);
    assert.match(f, /não quer dizer que eu li/);
    assert.match(f, /NÃO passa por cima/);
});

test('ver um bloco não é ter lido um bloco', () => {
    const c = new CursorDeColeta(500);
    c.viBloco(9999);
    assert.equal(c.cursorContiguo, 500, 'observar a corrente não é cobertura');
    assert.equal(c.ultimoTentado, 0, 'nem tentativa');
});

test('fechar a lacuna mais antiga DESTRAVA o cursor', () => {
    const c = new CursorDeColeta(1000);
    c.varri(1001, 1200, false);
    c.varri(1201, 1600, true);
    assert.equal(c.cursorContiguo, 1000);
    c.recuperei(1001, 1200, true);
    assert.equal(c.cursorContiguo, 1600, 'agora tudo até o tentado está coberto');
    assert.deepEqual(c.abertas(), []);
});

test('duas lacunas: fechar a segunda não destrava além da primeira', () => {
    const c = new CursorDeColeta(1000);
    c.varri(1001, 1100, false);
    c.varri(1101, 1200, false);
    c.varri(1201, 1500, true);
    c.recuperei(1101, 1200, true);
    assert.equal(c.cursorContiguo, 1000, 'a primeira lacuna ainda bloqueia');
    c.recuperei(1001, 1100, true);
    assert.equal(c.cursorContiguo, 1500);
});

test('a recuperação é LIMITADA: três tentativas e a lacuna fica declarada', () => {
    const c = new CursorDeColeta(1000);
    c.varri(1001, 1100, false, 'Monthly capacity limit exceeded');
    for (let i = 0; i < TENTATIVAS_POR_LACUNA; i += 1) {
        assert.equal(c.abertas().length, 1, `tentativa ${i + 1}`);
        c.recuperei(1001, 1100, false);
    }
    assert.deepEqual(c.abertas(), [], 'parou de tentar — não é laço infinito contra a cota');
    assert.equal(c.naoRecuperadas().length, 1, 'mas NÃO foi esquecida');
    assert.equal(c.naoRecuperadas()[0]!.motivo, 'Monthly capacity limit exceeded');
    assert.equal(c.blocosEmFalta(), 100, 'e continua contando como falta');
    assert.match(c.comoLer(), /NÃO RECUPERADA/);
});

test('desistir de uma lacuna NÃO libera o cursor por cima dela', () => {
    const c = new CursorDeColeta(1000);
    c.varri(1001, 1100, false);
    c.varri(1101, 1500, true);
    for (let i = 0; i < TENTATIVAS_POR_LACUNA; i += 1) c.recuperei(1001, 1100, false);
    assert.equal(c.cursorContiguo, 1000,
        'desistir é parar de tentar, não passar a afirmar que leu');
});

test('a fila de recuperação respeita o teto por volta, da mais antiga para a mais nova', () => {
    const c = new CursorDeColeta(0);
    for (let i = 0; i < 5; i += 1) c.varri(i * 100 + 1, i * 100 + 100, false);
    const fila = c.aRecuperar();
    assert.equal(fila.length, LACUNAS_POR_VOLTA);
    assert.equal(fila[0]!.de, 1, 'a mais antiga primeiro: é ela que bloqueia o cursor');
    assert.equal(fila[1]!.de, 101);
});

test('sem lacuna, o curso avança normalmente e a frase não fala de lacuna', () => {
    const c = new CursorDeColeta(1000);
    c.varri(1001, 2000, true);
    assert.equal(c.cursorContiguo, 2000);
    assert.equal(c.blocosEmFalta(), 0);
    const f = c.comoLer();
    assert.ok(!/lacuna/.test(f));
});

test('recuperar uma faixa que não é lacuna conhecida não mexe em nada', () => {
    const c = new CursorDeColeta(1000);
    c.varri(1001, 1100, false);
    c.recuperei(5000, 5100, true);
    assert.equal(c.abertas().length, 1);
    assert.equal(c.cursorContiguo, 1000);
});
