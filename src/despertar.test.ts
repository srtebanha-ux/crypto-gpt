// As duas políticas de despertar, e os riscos que ela nomeou.
import test from 'node:test';
import assert from 'node:assert';
import { simular, comparar, comoLerAComparacao } from './despertar';
import { esperarBlocoOuTempo } from './gatilhoDeBloco';

/** Blocos da Base a cada 2s, por 60s. */
const blocos2s = Array.from({ length: 30 }, (_, i) => (i + 1) * 2000);

test('a candidata ACORDA pelo bloco; a atual espera o sono', () => {
    const atual = simular({ nome: 'atual', ritmoMs: 8000, trabalhoMs: 106, blocoInterrompe: false }, blocos2s, 60_000);
    const cand = simular({ nome: 'candidata', ritmoMs: 8000, trabalhoMs: 106, blocoInterrompe: true }, blocos2s, 60_000);
    assert.ok(atual.every((d) => d.porque === 'sono'), 'a atual nunca acorda por bloco');
    assert.ok(cand.filter((d) => d.porque === 'bloco').length > 20,
        'a candidata acorda por bloco quase sempre');
    // E o atraso cai: a atual vê um bloco de até 8s atrás.
    const atrasoAtual = Math.max(...atual.filter((d) => d.atrasoMs > 0).map((d) => d.atrasoMs));
    const atrasoCand = Math.max(...cand.filter((d) => d.atrasoMs > 0).map((d) => d.atrasoMs));
    assert.ok(atrasoAtual > 1000, `a atual atrasa ${atrasoAtual}ms`);
    assert.ok(atrasoCand < atrasoAtual, `a candidata atrasa ${atrasoCand}ms, menos que ${atrasoAtual}`);
});

test('RAJADA não cria ciclo por evento nem fila crescente', () => {
    // Dez avisos em 50ms — o que um WebSocket faz quando reconecta.
    const rajada = Array.from({ length: 10 }, (_, i) => 1000 + i * 5);
    const cand = simular({ nome: 'candidata', ritmoMs: 8000, trabalhoMs: 106, blocoInterrompe: true }, rajada, 20_000);
    // Um ciclo consome TODOS os pendentes: dez avisos não são dez ciclos.
    const comBloco = cand.filter((d) => d.blocoPendenteDe !== null);
    assert.ok(comBloco.length <= 2, `dez avisos geraram ${comBloco.length} ciclos com bloco pendente`);
    // E nada fica acumulando: o último ciclo não tem pendente antigo.
    assert.equal(cand.at(-1)!.blocoPendenteDe, null, 'sobrou bloco pendente no fim: é fila');
});

test('o atraso EVITÁVEL e o custo saem na MESMA conta', () => {
    const c = comparar(blocos2s, 60_000, 8000, 106, { eth_call: 1, eth_blockNumber: 1 });
    assert.ok(c.atrasoEvitavelP50Ms! > 0, 'a candidata evita atraso');
    assert.ok(c.ciclosAMais > 0, 'e cobra em ciclos');
    // O custo é POR MÉTODO, derivado do custo medido de um ciclo — não palpite.
    assert.equal(c.chamadasAMais.eth_call, c.ciclosAMais);
    assert.equal(c.chamadasAMais.eth_blockNumber, c.ciclosAMais);
    assert.match(comoLerAComparacao(c), /atraso EVITÁVEL/);
    assert.match(comoLerAComparacao(c), /\+\d+ ciclos/);
    assert.match(c.oQueIssoNaoMede, /CAPTURA/);
    assert.match(c.oQueIssoNaoMede, /não da fatia/, 'newHeads é bloco, não fatia');
});

test('fluxo vazio não vira "a candidata não ajuda"', () => {
    const c = comparar([], 60_000, 8000, 106, { eth_call: 1 });
    assert.equal(c.eventos, 0);
    assert.equal(c.atrasoEvitavelP50Ms, null, 'sem evento não há atraso medido: null, não zero');
    assert.match(comoLerAComparacao(c), /nada a comparar/);
});

test('as duas políticas rodam sobre o MESMO fluxo, sem consulta externa', () => {
    // `simular` é pura: dois cálculos com a mesma entrada dão a mesma saída, e
    // nenhum deles toca a rede. É isso que permite comparar sem duplicar RPC.
    const a = simular({ nome: 'candidata', ritmoMs: 1000, trabalhoMs: 106, blocoInterrompe: true }, blocos2s, 30_000);
    const b = simular({ nome: 'candidata', ritmoMs: 1000, trabalhoMs: 106, blocoInterrompe: true }, blocos2s, 30_000);
    assert.deepEqual(a, b);
});

test('UMA rajada no esperarBlocoOuTempo resolve UMA vez e desassina', async () => {
    // O mecanismo de verdade, não o simulador: dez avisos durante uma espera
    // não podem resolver dez vezes (ciclos concorrentes) nem deixar o ouvinte
    // pendurado (vazamento, e consulta duplicada no ciclo seguinte).
    let desassinou = 0;
    let resolveu = 0;
    const r = await (async () => {
        const p = esperarBlocoOuTempo(
            (aoBloco) => {
                for (let i = 0; i < 10; i++) setTimeout(() => aoBloco(1000 + i), 1);
                return () => { desassinou += 1; };
            },
            500,
            (fn, ms) => setTimeout(fn, ms),
            (id) => clearTimeout(id as NodeJS.Timeout),
        );
        const v = await p;
        resolveu += 1;
        return v;
    })();
    assert.equal(r, 'bloco');
    assert.equal(resolveu, 1, 'a espera resolve UMA vez');
    assert.equal(desassinou, 1, 'e desassina UMA vez: ouvinte pendurado é vazamento');
    await new Promise((s) => { setTimeout(s, 60); });
    assert.equal(desassinou, 1, 'e não desassina de novo depois');
});

test('NONCE: o despertar não reserva nada — a comparação é só de horários', () => {
    // A política de despertar não toca no nonce: `simular` não tem como. Este
    // teste existe para a regra ficar escrita, porque adiantar o contador sem
    // mandar desarma `provaAgora()` para sempre (registrado em 2026-09-28).
    const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, 'despertar.ts'), 'utf8');
    assert.ok(!/nonce/i.test(fonte), 'o módulo de despertar não menciona nonce, e não deve');
    assert.ok(!/sendTransaction|getNextNonce/.test(fonte));
});
