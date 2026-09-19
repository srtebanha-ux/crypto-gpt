// Arquivo: src/rateLimiter.test.ts
//
// O que estes testes protegem é a diferença entre "recuei um pouco" e "fui
// banido por três dias". A punição da Binance é escalonada, e o erro mais caro
// possível — tentar de novo durante um banimento — é justamente o
// comportamento padrão de qualquer código que trate 418 como erro comum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControleDeVazao, lerRetryAfter } from './rateLimiter';

/** Relógio controlado: tempo real tornaria estes testes lentos e instáveis. */
function relogio(inicio = 1_000_000) {
    let t = inicio;
    return { agora: () => t, avancar: (ms: number) => (t += ms) };
}

test('deixa passar até o limite e então segura', () => {
    const r = relogio();
    // Capacidade 100 com uso máximo de 80% = 80 fichas.
    const c = new ControleDeVazao({ capacidade: 100, janelaMs: 60_000, nome: 'teste' }, r.agora);
    for (let i = 0; i < 80; i += 1) {
        assert.equal(c.esperaNecessariaMs(), 0, `ficha ${i} deveria passar`);
        c.consumir();
    }
    assert.ok(c.esperaNecessariaMs() > 0, 'a 81ª tem que esperar');
});

test('a folga de 20% NÃO é desperdício — é o que sobra para o que não passa por aqui', () => {
    // Reconexão de WebSocket, consulta de saldo, e a divergência inevitável
    // entre o nosso contador e o da corretora. Usar 100% garante estourar.
    const r = relogio();
    const c = new ControleDeVazao({ capacidade: 100, janelaMs: 60_000, nome: 'teste' }, r.agora);
    assert.equal(c.resumo().limite, 80);

    const semFolga = new ControleDeVazao(
        { capacidade: 100, janelaMs: 60_000, usoMaximo: 1, nome: 'teste' },
        r.agora,
    );
    assert.equal(semFolga.resumo().limite, 100);
});

test('a janela é FIXA, como a da Binance conta', () => {
    // Deslizante seria mais suave e permitiria picos que a contagem real
    // rejeita. O objetivo não é ser justo, é não ser banido.
    const r = relogio();
    const c = new ControleDeVazao({ capacidade: 10, janelaMs: 60_000, usoMaximo: 1, nome: 'teste' }, r.agora);
    for (let i = 0; i < 10; i += 1) c.consumir();
    assert.ok(c.esperaNecessariaMs() > 0);

    r.avancar(59_999);
    assert.ok(c.esperaNecessariaMs() > 0, 'ainda dentro da janela');

    r.avancar(2);
    assert.equal(c.esperaNecessariaMs(), 0, 'janela nova, contador zerado');
});

test('418 BLOQUEIA por tempo, e não é tratado como erro recuperável', () => {
    // O erro mais caro possível: cada requisição durante o banimento estende a
    // pena. Tentar de novo é literalmente a ação que piora a situação.
    const r = relogio();
    const c = new ControleDeVazao({ capacidade: 1000, janelaMs: 60_000, nome: 'teste' }, r.agora);
    c.registrarRecusa({ status: 418, retryAfterSegundos: 300 });

    assert.equal(c.bloqueado, true);
    assert.equal(c.esperaNecessariaMs(), 300_000);

    r.avancar(299_999);
    assert.equal(c.bloqueado, true, 'um milissegundo antes ainda é banimento');

    r.avancar(2);
    assert.equal(c.bloqueado, false);
});

test('418 SEM Retry-After assume o mínimo documentado, nunca zero', () => {
    const r = relogio();
    const c = new ControleDeVazao({ capacidade: 1000, janelaMs: 60_000, nome: 'teste' }, r.agora);
    c.registrarRecusa({ status: 418 });
    assert.equal(c.esperaNecessariaMs(), 120_000, 'dois minutos, não zero');
});

test('429 recua e esgota a janela corrente', () => {
    // Se estourou, o nosso contador estava otimista. Continuar gastando a
    // janela como se nada tivesse acontecido repetiria o erro na hora.
    const r = relogio();
    const c = new ControleDeVazao({ capacidade: 100, janelaMs: 60_000, nome: 'teste' }, r.agora);
    c.consumir(5);
    c.registrarRecusa({ status: 429, retryAfterSegundos: 10 });

    assert.equal(c.esperaNecessariaMs(), 10_000);
    r.avancar(10_001);
    // Passado o recuo, a janela original expirou e o contador zera.
    r.avancar(60_000);
    assert.equal(c.esperaNecessariaMs(), 0);
});

test('o bloqueio tem precedência sobre a renovação da janela', () => {
    // Sem isso, um banimento de 3 dias seria ignorado assim que a janela de
    // 1 minuto virasse — e o motor voltaria a bombardear durante a pena.
    const r = relogio();
    const c = new ControleDeVazao({ capacidade: 100, janelaMs: 60_000, nome: 'teste' }, r.agora);
    c.registrarRecusa({ status: 418, retryAfterSegundos: 3600 });
    r.avancar(120_000); // duas janelas inteiras se passaram
    assert.ok(c.esperaNecessariaMs() > 0, 'o banimento sobrevive à renovação da janela');
    assert.equal(c.bloqueado, true);
});

test('custo maior que uma ficha é respeitado', () => {
    // Requisições da Binance têm PESO diferente: uma consulta de profundidade
    // pesa muito mais que um bookTicker. Contar tudo como 1 subestimaria o
    // consumo real e levaria ao 429.
    const r = relogio();
    const c = new ControleDeVazao({ capacidade: 100, janelaMs: 60_000, usoMaximo: 1, nome: 'teste' }, r.agora);
    c.consumir(95);
    assert.equal(c.esperaNecessariaMs(1), 0);
    assert.ok(c.esperaNecessariaMs(10) > 0, 'não cabe uma requisição de peso 10');
});

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

const headersFalsos = (valor: string | null) => ({ get: () => valor });

test('Retry-After ausente ou com lixo devolve undefined, NUNCA zero', () => {
    // Tratar lixo como zero faria o motor tentar de novo imediatamente durante
    // um banimento — o pior comportamento possível no pior momento possível.
    assert.equal(lerRetryAfter(headersFalsos(null)), undefined);
    assert.equal(lerRetryAfter(headersFalsos('depois')), undefined);
    assert.equal(lerRetryAfter(headersFalsos('')), undefined);
    assert.equal(lerRetryAfter(headersFalsos('-5')), undefined);
});

test('Retry-After válido é lido em segundos', () => {
    assert.equal(lerRetryAfter(headersFalsos('30')), 30);
    assert.equal(lerRetryAfter(headersFalsos('0')), 0);
});
