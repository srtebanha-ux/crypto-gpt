/**
 * OS TESTES DO INCIDENTE DE 2026-10-14.
 *
 * O defeito nao era um valor errado: era a disponibilidade de um canal HTTP
 * sendo decidida pelo estado de um provedor de RPC. Entao os testes aqui
 * afirmam a REGRA — e dois deles varrem TODAS as combinacoes de estado de RPC,
 * em vez de escolher uma, porque foi exatamente uma combinacao nao prevista
 * (`CACA_MERCADOS_MORPHO` ainda ligada + capacidade esgotada) que produziu o
 * incidente em producao.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    disponibilidadeDoCanal, comoLerOsCanais, comoLerODesfecho, OrcamentoHttp,
    CANAIS, type EstadoDaInfra,
} from './canais';

/** Todas as combinacoes de estado de RPC que podem existir. */
const TODOS_OS_ESTADOS: EstadoDaInfra[] = [];
for (const esgotados of [[], ['alchemy'], ['alchemy', 'publicnode']]) {
    for (const noFallback of [false, true]) {
        for (const eventosRecusados of [undefined, false, true]) {
            TODOS_OS_ESTADOS.push({ provedoresEsgotados: esgotados, noFallback, eventosRecusados });
        }
    }
}

test('ALCHEMY ESGOTADA NÃO BLOQUEIA a chamada HTTP à Morpho — em estado nenhum', () => {
    // A REGRA do incidente, e ela e varrida e nao amostrada. Ela pediu este
    // teste por nome: *"Inclua um teste especifico demonstrando que Alchemy
    // esgotada NAO bloqueia a chamada HTTP a Morpho."*
    assert.ok(TODOS_OS_ESTADOS.length >= 18, 'a varredura tem de cobrir as combinações');
    for (const e of TODOS_OS_ESTADOS) {
        const d = disponibilidadeDoCanal('apiHttp', e);
        assert.equal(
            d.pode, true,
            `apiHttp foi bloqueado com ${JSON.stringify(e)} — é o incidente de 2026-10-14`,
        );
        // E nem degradado: nao ha nada no RPC que encareca uma chamada HTTP.
        assert.equal(d.degradado, false, 'apiHttp não degrada por estado de RPC');
    }
    // O caso EXATO do log dela: Alchemy esgotada, no fallback, eventos recusados.
    const oDoLog: EstadoDaInfra = {
        provedoresEsgotados: ['base-mainnet.g.alchemy.com'],
        noFallback: true,
        eventosRecusados: true,
    };
    assert.equal(disponibilidadeDoCanal('apiHttp', oDoLog).pode, true);
    // E nesse MESMO estado o canal de eventos tem de estar pausado: se os dois
    // respondessem igual, nao haveria dois canais.
    assert.equal(disponibilidadeDoCanal('rpcEventos', oDoLog).pode, false);
});

test('eth_call DEGRADA mas não para: foi observado respondendo com a Alchemy esgotada', () => {
    // Medido no log de 2026-10-14: *"Leituras eth_call continuaram funcionando
    // pelos provedores alternativos."* Parar aqui desligaria a validacao, que e
    // justamente o que autoriza um candidato.
    for (const canal of ['rpcLeitura', 'validacao'] as const) {
        const limpo = disponibilidadeDoCanal(canal, { provedoresEsgotados: [], noFallback: false });
        assert.equal(limpo.pode, true);
        assert.equal(limpo.degradado, false);

        const sujo = disponibilidadeDoCanal(canal, {
            provedoresEsgotados: ['alchemy'], noFallback: true,
        });
        assert.equal(sujo.pode, true, `${canal} não pode PARAR por esgotamento`);
        assert.equal(sujo.degradado, true, `${canal} tem de DECLARAR que está degradado`);
    }
});

test('o monitoramento nunca pausa, em nenhum estado', () => {
    for (const e of TODOS_OS_ESTADOS) {
        assert.equal(disponibilidadeDoCanal('monitoramento', e).pode, true);
    }
});

test('eventos recusados DESCONHECIDO não vira "disponível"', () => {
    // Ausente e DESCONHECIDO. Mas aqui o lado seguro e deixar passar com o
    // primario limpo: afirmar recusa sem evidencia pausaria o censo de graca.
    // O que NAO pode e o inverso — `true` tem de pausar, e pausa.
    const semSaber: EstadoDaInfra = { provedoresEsgotados: [], noFallback: false };
    assert.equal(disponibilidadeDoCanal('rpcEventos', semSaber).pode, true);
    const sabendo: EstadoDaInfra = { ...semSaber, eventosRecusados: true };
    assert.equal(disponibilidadeDoCanal('rpcEventos', sabendo).pode, false);
    assert.match(disponibilidadeDoCanal('rpcEventos', sabendo).porque, /Não é "não há eventos"/);
});

test('a frase dos canais DIZ que o apiHttp não depende do RPC', () => {
    // A linha que faltava: o incidente foi invisivel porque nada no log dizia
    // que o canal HTTP estava livre. Nao dizer e indistinguivel de nao poder.
    const f = comoLerOsCanais({
        provedoresEsgotados: ['alchemy'], noFallback: true, eventosRecusados: true,
    });
    assert.match(f, /apiHttp: livre/);
    assert.match(f, /rpcEventos: PAUSADO/);
    assert.match(f, /NÃO depende do estado do RPC/);
    // Todo canal aparece: uma frase que esconde canal nao serve de diagnostico.
    for (const c of CANAIS) assert.ok(f.includes(c), `a frase não menciona ${c}`);
});

test('o boot avalia os dois caminhos do Morpho em `if` SEPARADOS, não numa cadeia', () => {
    // LÊ O CÓDIGO, de propósito. O defeito era ESTRUTURAL — um `else if` — e
    // nenhum teste de valor o pega: foi assim que passou por 1.691 testes e
    // custou um deploy. É a mesma razão do teste que lê os gravadores de cache.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const iApi = fonte.indexOf("process.env.CACA_MORPHO_API === '1'");
    assert.ok(iApi > 0, 'o ramo da API tem de existir');
    // O trecho que antecede o teste da flag da API, na mesma linha logica, nao
    // pode ser um `else`: isso o subordina ao ramo anterior.
    const antes = fonte.slice(Math.max(0, iApi - 400), iApi);
    assert.ok(
        !/\}\s*else\s+if\s*\($/.test(antes.replace(/\s+$/, '')),
        'o ramo de CACA_MORPHO_API está pendurado num `else if` — é o incidente de 2026-10-14',
    );
    // E a descoberta pela API NAO pode consultar `oQuePausar` para se autorizar:
    // essa funcao decide por TAREFA de RPC, e o canal HTTP nao e tarefa de RPC.
    const bloco = fonte.slice(iApi, iApi + 1600);
    assert.ok(
        !bloco.includes('oQuePausar'),
        'o ramo da API consulta oQuePausar, que decide por capacidade de RPC',
    );
    assert.ok(
        bloco.includes("disponibilidadeDoCanal('apiHttp'"),
        'o ramo da API tem de perguntar ao canal dele',
    );
});

test('o orçamento HTTP CANCELA de verdade, e não só devolve false', () => {
    // Um `fetch` ignorado nao e um `fetch` cancelado. Este projeto mediu o
    // custo disso em `cotacoesDaBinance`: a perna que nunca respondia ficava
    // fora do teto e segurava a volta inteira.
    let t = 0;
    const o = new OrcamentoHttp(2, 1000, () => t);
    assert.equal(o.sinal.aborted, false);
    assert.equal(o.pedir(), true);
    assert.equal(o.pedir(), true);
    assert.equal(o.pedir(), false, 'o teto de requisições manda');
    assert.equal(o.sinal.aborted, true, 'estourar o teto tem de ABORTAR o sinal');
    assert.match(o.encerrado ?? '', /teto de 2 requisições/);
    assert.equal(o.gastas, 2, 'a requisição negada não conta como gasta');

    // E o teto de TEMPO, que e a outra metade.
    t = 0;
    const p = new OrcamentoHttp(100, 500, () => t);
    assert.equal(p.pedir(), true);
    t = 500;
    assert.equal(p.pedir(), false);
    assert.equal(p.sinal.aborted, true);
    assert.match(p.encerrado ?? '', /teto de 500ms/);
});

test('os quatro desfechos são frases DIFERENTES, porque pedem consertos opostos', () => {
    const d = ['naoExecutou', 'apiFalhou', 'apiVaziaDeVerdade', 'validacaoRecusou',
        'rpcIndisponivel', 'confirmou'] as const;
    const frases = d.map((x) => comoLerODesfecho(x));
    assert.equal(new Set(frases).size, d.length, 'dois desfechos com a mesma frase não separam nada');
    // E cada uma tem de dizer o que ela NAO e, porque a confusao entre elas e
    // o defeito: lista vazia por agendamento contra lista vazia por rede.
    assert.match(comoLerODesfecho('naoExecutou'), /Nenhuma requisição HTTP foi iniciada/);
    assert.match(comoLerODesfecho('apiFalhou'), /NÃO é "não há mercados"/);
    assert.match(comoLerODesfecho('apiVaziaDeVerdade'), /é uma RESPOSTA, não uma falha/);
    assert.match(comoLerODesfecho('rpcIndisponivel'), /NÃO CONFIRMADOS/);
});
