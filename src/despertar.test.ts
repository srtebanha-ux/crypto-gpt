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
    // A regra é sobre USO, não sobre a palavra: o cabeçalho do módulo cita a
    // instrução dela, que contém "nonce". A primeira versão deste assert
    // proibia a string e reprovou a própria citação.
    assert.ok(!/getNextNonce|nonceManager|sendTransaction|\.nonce\b/.test(fonte),
        'o módulo de despertar não pode TOCAR no nonce nem transmitir');
    // E fora de comentário, a palavra não aparece.
    const semComentarios = fonte.split('\n')
        .filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/nonce/i.test(semComentarios), 'nenhum código de despertar fala de nonce');
});

// ---------------------------------------------------------------------------
// INTEGRAÇÃO com o passo de espera DE PRODUÇÃO, com dependências controladas.
// Conta avaliações, chamadas RPC por método e reservas de nonce.
// ---------------------------------------------------------------------------
import { esperarOProximoCiclo, type DependenciasDaEspera } from './despertar';

/** Um ouvinte falso que entrega avisos sob comando, e conta assinaturas. */
function ouvinteFalso() {
    const fs = new Set<(n: number) => void>();
    let vivo = true;
    let assinaturas = 0; let desassinaturas = 0;
    return {
        o: {
            get vivo() { return vivo; },
            assinar(f: (n: number) => void) {
                assinaturas += 1; fs.add(f);
                return () => { desassinaturas += 1; fs.delete(f); };
            },
        },
        avisar: (n = 1) => { for (let i = 0; i < n; i++) for (const f of [...fs]) f(1000 + i); },
        cair: () => { vivo = false; fs.clear(); },
        voltar: () => { vivo = true; },
        get assinaturas() { return assinaturas; },
        get desassinaturas() { return desassinaturas; },
        get pendurados() { return fs.size; },
    };
}

/** Um mundo falso que conta TUDO o que custa. */
function mundoFalso(ouv: ReturnType<typeof ouvinteFalso> | null, acordaPorBloco: boolean) {
    const conta = { avaliacoes: 0, nonceReservado: 0, rpc: {} as Record<string, number> };
    const rpc = (m: string, n = 1) => { conta.rpc[m] = (conta.rpc[m] ?? 0) + n; };
    let t = 0n;
    const d: DependenciasDaEspera = {
        ouvinte: ouv === null ? null : ouv.o,
        acordaPorBloco,
        dormir: async (ms) => { t += BigInt(ms) * 1_000_000n; },
        dormirDeOlho: async (total, fatia) => {
            // O sono real olha o mercado entre fatias: cada olhada é 1 chamada.
            const fatias = Math.max(1, Math.floor(total / Math.max(1, fatia)));
            rpc('mercado_http', fatias);
            t += BigInt(total) * 1_000_000n;
            return false;
        },
        esperarBloco: async (assinar, teto) => {
            const parar = assinar(() => {});
            t += BigInt(Math.min(teto, 50)) * 1_000_000n;
            parar();
            return ouv !== null && ouv.o.vivo ? 'bloco' : 'tempo';
        },
        agoraNs: () => t,
    };
    /** Um ciclo: o que ele custa em RPC, medido no log do artefato. */
    const umCiclo = () => {
        conta.avaliacoes += 1;
        // POR CAMINHO: o ciclo da brasa é 1 multicall (eth_call) que embute o
        // eth_blockNumber. A varredura completa é ~248 multicalls. Contar "1+1"
        // para todo ciclo seria o palpite que ela proibiu.
        rpc('eth_call', 1);
        rpc('eth_blockNumber', 1);
    };
    return { d, conta, umCiclo };
}

test('INTEGRAÇÃO: rajada durante a espera = UM retorno, UMA avaliação', async () => {
    const ouv = ouvinteFalso();
    const { d, conta, umCiclo } = mundoFalso(ouv, true);
    // A espera começa; dez avisos chegam; ela retorna uma vez.
    const p = esperarOProximoCiclo('dormindo', 8000, 8000, 1000, d);
    ouv.avisar(10);
    const r = await p;
    umCiclo();
    assert.equal(conta.avaliacoes, 1, 'dez avisos não são dez avaliações');
    assert.equal(conta.nonceReservado, 0, 'e nenhuma reserva de nonce');
    assert.equal(ouv.pendurados, 0, 'nenhum ouvinte pendurado: vazamento é consulta duplicada depois');
    assert.ok(r.porque === 'bloco' || r.porque === 'sono');
});

test('INTEGRAÇÃO: execução LENTA não acumula ciclos concorrentes', async () => {
    const ouv = ouvinteFalso();
    const { d, conta, umCiclo } = mundoFalso(ouv, true);
    // Simula o laço: espera, trabalha (lento), espera, trabalha…
    for (let i = 0; i < 5; i++) {
        const p = esperarOProximoCiclo('atento', 1000, 1000, 500, d);
        ouv.avisar(4);               // rajada a cada volta
        await p;
        await new Promise((s) => { setTimeout(s, 5); }); // trabalho lento
        umCiclo();
    }
    // Cinco voltas, cinco avaliações — nunca mais, por mais avisos que cheguem.
    assert.equal(conta.avaliacoes, 5);
    assert.equal(ouv.pendurados, 0);
    assert.equal(ouv.assinaturas, ouv.desassinaturas,
        `assinou ${ouv.assinaturas} e desassinou ${ouv.desassinaturas}`);
});

test('INTEGRAÇÃO: desconexão e reconexão não deixam ouvinte pendurado', async () => {
    const ouv = ouvinteFalso();
    const { d } = mundoFalso(ouv, true);
    const p1 = esperarOProximoCiclo('dormindo', 8000, 8000, 1000, d);
    ouv.cair();                      // o WebSocket caiu no meio da espera
    await p1;
    assert.equal(ouv.pendurados, 0);
    ouv.voltar();
    const p2 = esperarOProximoCiclo('dormindo', 8000, 8000, 1000, d);
    ouv.avisar(3);
    const r2 = await p2;
    assert.equal(ouv.pendurados, 0, 'depois de voltar, também não sobra ouvinte');
    assert.ok(r2.avisos >= 0);
});

test('CONSUMO por método e por CAMINHO — não "1+1 por ciclo"', async () => {
    // Política ATUAL: o sono olha o mercado entre fatias, e isso custa.
    const a = mundoFalso(ouvinteFalso(), false);
    await esperarOProximoCiclo('dormindo', 8000, 8000, 1000, a.d);
    a.umCiclo();
    // Política CANDIDATA: acorda por bloco, e NÃO paga as olhadas de mercado.
    const c = mundoFalso(ouvinteFalso(), true);
    await esperarOProximoCiclo('dormindo', 8000, 8000, 1000, c.d);
    c.umCiclo();
    assert.ok((a.conta.rpc.mercado_http ?? 0) > 0,
        'a atual paga olhadas de mercado durante o sono');
    assert.equal(c.conta.rpc.mercado_http, undefined,
        'a candidata NÃO paga essas olhadas — o custo dela não é só "+1 ciclo"');
    // Então a conta de custo tem DOIS sinais opostos, e o teste registra isso.
    assert.equal(a.conta.rpc.eth_call, 1);
    assert.equal(c.conta.rpc.eth_call, 1);
});

test('sem ouvinte vivo, a candidata CAI para o sono — e não some com a espera', async () => {
    const { d, conta } = mundoFalso(null, true);
    const r = await esperarOProximoCiclo('dormindo', 8000, 8000, 1000, d);
    assert.equal(r.porque, 'sono');
    assert.equal(r.avisos, 0);
    assert.ok((conta.rpc.mercado_http ?? 0) > 0, 'caiu para dormirDeOlho, que olha o mercado');
});

test('resta <= 0 não espera nada, e não assina ouvinte', async () => {
    const ouv = ouvinteFalso();
    const { d } = mundoFalso(ouv, true);
    const r = await esperarOProximoCiclo('atento', 1000, 0, 500, d);
    assert.equal(r.porque, 'semEspera');
    assert.equal(ouv.assinaturas, 0);
});
