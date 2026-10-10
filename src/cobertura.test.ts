import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    exigirResultado, RespostaSemResultado, coberturaVazia, coberturaCompleta,
    fracaoQueFalhou, comoLerACobertura, idDoLote, classificarRecusa,
} from './cobertura';
import { codificarAggregate3, decodificarAggregate3Rapido } from './multicall';

/**
 * A REPRODUCAO DO DEFEITO, pelo caminho exato do log de 2026-10-10.
 *
 * Este teste FALHA com o codigo de antes (`return corpo.result as T`) e passa
 * com `exigirResultado`. Ele nao finge a mensagem: deixa o `undefined` chegar
 * ao decodificador de verdade e confere que a mensagem e a do log dela.
 */
test('resposta sem `result` produzia exatamente o `.replace` do log', () => {
    // 1. O QUE O PROVEDOR MANDOU: corpo sem `result` e sem `error`.
    const corpo = { jsonrpc: '2.0', id: 7 };

    // 2. O CODIGO DE ANTES, copiado: `corpo.result as T`.
    const comoEraAntes = (corpo as { result?: string }).result as string;
    const estourou = (() => {
        try { decodificarAggregate3Rapido(comoEraAntes); return null; }
        catch (e) { return (e as Error).message; }
    })();
    assert.equal(
        estourou,
        "Cannot read properties of undefined (reading 'replace')",
        'esta e a mensagem do log de producao, e ela nasce aqui',
    );

    // 3. O CODIGO DE AGORA: falha com nome, metodo e as chaves do corpo.
    assert.throws(
        () => exigirResultado<string>(corpo, 'eth_call'),
        (e: Error) => {
            assert.ok(e instanceof RespostaSemResultado);
            assert.match(e.message, /eth_call/);
            assert.match(e.message, /jsonrpc, id/, 'as CHAVES do corpo, para identificar o formato');
            assert.match(e.message, /FALHA DE LEITURA/);
            return true;
        },
    );
});

test('`result: null` é resposta e passa: o discriminador é a chave, não o valor', () => {
    assert.equal(exigirResultado<null>({ result: null }, 'eth_getTransactionByHash'), null);
    assert.equal(exigirResultado<string>({ result: '0x' }, 'eth_call'), '0x');
});

test('corpo que não é objeto também é falha de leitura, não string vazia', () => {
    for (const ruim of [null, undefined, 'erro de proxy', 42]) {
        assert.throws(() => exigirResultado(ruim, 'eth_call'), RespostaSemResultado);
    }
});

/**
 * O defeito NAO estava na preparacao, e isto fecha a pergunta dela ("determine
 * se o erro nasce na preparacao, no tratamento da resposta ou no tratamento de
 * outra excecao"): endereco ou dados ausentes estouram OUTRAS mensagens.
 */
test('a preparação falha com outra mensagem: o `.replace` não nasce nela', () => {
    const A = '0x4200000000000000000000000000000000000006';
    const msg = (c: unknown) => {
        try { codificarAggregate3([c as never]); return 'OK'; }
        catch (e) { return (e as Error).message; }
    };
    assert.match(msg({ alvo: undefined, dados: '0x12' }), /invalid address/);
    assert.match(msg({ alvo: A, dados: undefined }), /invalid BytesLike/);
    for (const m of [msg({ alvo: undefined, dados: '0x12' }), msg({ alvo: A, dados: undefined })]) {
        assert.ok(!m.includes('replace'), 'nenhuma delas é o erro do log');
    }
});

test('nenhuma chamada devolve `result` sem passar pelo portão', () => {
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    // So a FORMA EXECUTAVEL: `return corpo.result as T`. Citar o defeito num
    // comentario e documentacao, e proibir a citacao faria o teste reprovar o
    // registro do proprio conserto — erro que este projeto ja cometeu duas
    // vezes, proibindo um literal e depois a retratacao dele.
    // Sem os COMENTARIOS: citar o defeito num comentario e documentacao, e
    // proibir a citacao faria o teste reprovar o registro do proprio conserto
    // — erro que este projeto ja cometeu duas vezes, proibindo um literal e
    // depois a retratacao dele.
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const cruas = codigo.match(/return\s+corpo\.result\s+as\s+\w+/g) ?? [];
    assert.deepEqual(
        cruas, [],
        '`corpo.result as T` e a forma exata do defeito: um dado obrigatorio ausente '
        + 'prometido como presente. Use exigirResultado',
    );
    assert.ok(
        /exigirResultado</.test(fonte),
        'o cacador tem de usar o portao, nao so importa-lo',
    );
});

test('a fração que falhou sai do contador, não da frase', () => {
    // O caso real do log: 40 falhas e 4 sucessos publicados como "um quarto".
    const c = coberturaVazia(44);
    c.lidas = 4; c.falharam = 40;
    assert.equal(fracaoQueFalhou(c), 40 / 44);
    const frase = comoLerACobertura(c);
    assert.match(frase, /90\.9% das tentativas falharam/);
    assert.ok(!/um quarto/.test(frase));
    assert.equal(coberturaCompleta(c), false);
});

test('cobertura sem nada pedido não é cobertura completa', () => {
    assert.equal(coberturaCompleta(coberturaVazia(0)), false);
    assert.match(comoLerACobertura(coberturaVazia(0)), /não há cobertura a declarar/);
});

test('"varredura encerrada" não é "cobertura completa"', () => {
    const c = coberturaVazia(1000);
    c.lidas = 1000;
    assert.ok(coberturaCompleta(c));
    assert.match(comoLerACobertura(c), /COMPLETA/);
    // Uma unica posicao perdida tira a palavra COMPLETA da frase, mesmo que a
    // varredura tenha terminado normalmente.
    c.lidas = 999; c.falharam = 1; c.posicoesFalhas.add(42);
    assert.ok(!coberturaCompleta(c));
    assert.match(comoLerACobertura(c), /INCOMPLETA/);
    assert.match(comoLerACobertura(c), /NÃO é ausência de oportunidade/);
});

test('estado reusado aparece com a idade ao lado', () => {
    const c = coberturaVazia(10);
    c.lidas = 7; c.falharam = 3; c.reusadas = 3; c.idadeMaisVelhaMs = 94_000;
    const f = comoLerACobertura(c);
    assert.match(f, /3 respondidas com estado GUARDADO/);
    assert.match(f, /94s de idade/);
});

test('o id do lote identifica a faixa, para agrupar sem perder o exemplo', () => {
    assert.equal(idDoLote('completa', 3, 750, 999), 'completa#3[750..999]');
    assert.notEqual(idDoLote('completa', 3, 750, 999), idDoLote('completa', 4, 1000, 1249));
});

test('`request limit reached` era limite de provedor e NÃO era reconhecido', () => {
    // A mensagem exata do log de 2026-10-10, 28 de 28 janelas. A lista antiga
    // tinha 'rate limit', '429', 'too many requests', 'timeout' e 'capacity' —
    // e nenhum deles casa com esta.
    const antiga = (m: string) => ['rate limit', '429', 'too many requests', 'timeout', 'capacity']
        .some((p) => m.toLowerCase().includes(p));
    assert.equal(antiga('request limit reached'), false, 'a lista antiga não a reconhecia');
    const c = classificarRecusa('request limit reached');
    assert.equal(c.tipo, 'taxa');
    assert.equal(c.absorveEsperando, true, 'agora a escada de espera a absorve');
});

test('cota não é taxa, e esperar contra cota queima o que sobrou', () => {
    for (const m of ['monthly quota exceeded', 'credits exhausted', '402 payment required']) {
        const c = classificarRecusa(m);
        assert.equal(c.tipo, 'cota', m);
        assert.equal(c.absorveEsperando, false, 'repetir contra cota não resolve');
        assert.match(c.oQueFazer, /NÃO resolve/);
    }
});

test('erro desconhecido NÃO é tratado como limite', () => {
    const c = classificarRecusa("Cannot read properties of undefined (reading 'replace')");
    assert.equal(c.tipo, 'outra');
    assert.equal(c.absorveEsperando, false,
        'tratar defeito nosso como "o provedor pediu calma" foi exatamente o que esconderia o '
        + 'erro que este arquivo existe para consertar');
});

test('timeout pede pedaço MENOR, não repetição igual', () => {
    const c = classificarRecusa('AbortError: The operation was aborted due to timeout');
    assert.equal(c.tipo, 'tempo');
    assert.match(c.oQueFazer, /MENOR/);
});
