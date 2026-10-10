import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    exigirResultado, RespostaSemResultado, coberturaVazia, coberturaCompleta,
    fracaoQueFalhou, comoLerACobertura, idDoLote, classificarRecusa,
    diagnosticarRecusaDeLogs, comoLerODiagnosticoDeLogs, lerErroJsonRpc, comoLerOErroJsonRpc,
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


test('dado de CACHE nunca conta como leitura nova', () => {
    // Ela pediu: *"dados de cache não contam como leituras novas."* `reusadas` e
    // `lidas` sao campos separados, e a soma delas NAO e cobertura: somar faria
    // 2.500 posicoes nao lidas aparecerem como lidas porque havia estado velho
    // guardado para elas.
    const c = coberturaVazia(1000);
    c.lidas = 750; c.falharam = 250; c.reusadas = 250; c.idadeMaisVelhaMs = 600_000;
    assert.equal(coberturaCompleta(c), false, 'estado reusado não completa cobertura');
    const f = comoLerACobertura(c);
    assert.match(f, /750 de 1000 lidas \(75\.0%\)/, 'a fração lida exclui as reusadas');
    assert.match(f, /250 respondidas com estado GUARDADO/);
    assert.ok(!/1000 de 1000/.test(f));
});

test('`request limit reached` NÃO comprova frequência: a causa é INDETERMINADA', () => {
    // RETRATAÇÃO: a versão anterior deste teste afirmava `restricao: 'frequencia'`.
    // A mensagem diz que um limite foi alcançado e não diz qual.
    const d = diagnosticarRecusaDeLogs('request limit reached');
    assert.equal(d.restricao, 'indeterminada');
    assert.match(d.comprova, /autoriza ESPERAR/);
    assert.match(d.comprova, /NÃO comprova qual/);
    assert.ok(!/é FREQUÊNCIA/.test(d.comprova), 'a conclusão antiga não voltou');
    assert.ok(d.desconhecido.some((x) => /causa específica é INDETERMINADA/.test(x)));
    assert.match(d.comoDescobrir, /se falhar igual, continua indeterminada/);
});

test('restrição de TAMANHO só quando a resposta fala de faixa ou resultados', () => {
    for (const m of ['eth_getLogs is limited to a 500 range', 'query exceeds max results',
        'block range is too large']) {
        const d = diagnosticarRecusaDeLogs(m);
        assert.equal(d.restricao, 'tamanho', m);
        assert.match(d.comoDescobrir, /tamanho não medido fica DESCONHECIDO, não 250/);
    }
    // E o teto exato continua desconhecido: a mensagem diz que é grande, não qual é.
    assert.ok(diagnosticarRecusaDeLogs('query exceeds max results')
        .desconhecido.some((x) => /teto exato/.test(x)));
});

test('capacidade e método são classificações próprias, e cada uma diz o que falta', () => {
    const cap = diagnosticarRecusaDeLogs('Monthly capacity limit exceeded');
    assert.equal(cap.restricao, 'capacidade');
    assert.match(cap.comprova, /vale para todo método/);
    assert.ok(cap.desconhecido.some((x) => /tamanho/.test(x)), 'cota não diz nada sobre tamanho');
    const met = diagnosticarRecusaDeLogs('the method eth_getLogs is not available');
    assert.equal(met.restricao, 'metodo');
    assert.match(met.comprova, /MÉTODO/);
});

test('mensagem sem padrão observado fica DESCONHECIDA nos quatro', () => {
    const d = diagnosticarRecusaDeLogs('weird upstream failure 7');
    assert.equal(d.restricao, 'desconhecida');
    assert.ok(d.desconhecido.some((x) => /todos os quatro/.test(x)));
    assert.match(d.comoDescobrir, /escolher um dos quatro seria invenção/);
});

test('o diagnóstico não publica credencial', () => {
    const d = diagnosticarRecusaDeLogs('request limit reached at https://h/v2/CHAVE_MUITO_SECRETA_123');
    assert.ok(!comoLerODiagnosticoDeLogs(d).includes('CHAVE_MUITO_SECRETA_123'));
});

test('o erro `[code, message]` era o que comia a mensagem das 5.750 posições', () => {
    // A FORMA ANTIGA, copiada: `corpo.error.message` num array é `undefined`.
    const corpo = { jsonrpc: '2.0', id: 1, error: [-32005, 'request limit reached'] };
    const comoEraAntes = (corpo as unknown as { error: { message?: string } }).error.message
        ?? 'erro sem mensagem';
    assert.equal(comoEraAntes, 'erro sem mensagem', 'era esta a prosa que chegava ao log');

    // AGORA: código, mensagem e forma, cada um no seu campo.
    const e = lerErroJsonRpc(corpo, 200);
    assert.equal(e.codigo, -32005);
    assert.equal(e.mensagem, 'request limit reached');
    assert.equal(e.status, 200);
    assert.equal(e.formato, 'par');
    const frase = comoLerOErroJsonRpc(e);
    assert.match(frase, /request limit reached/);
    assert.match(frase, /code -32005/);
    assert.match(frase, /HTTP 200/);
    assert.match(frase, /forma do erro: par/);
});

test('as outras formas do `error`, e nenhuma vira "sem mensagem" calada', () => {
    assert.equal(lerErroJsonRpc({ error: { code: -1, message: 'x' } }).formato, 'objeto');
    assert.equal(lerErroJsonRpc({ error: 'texto solto' }).mensagem, 'texto solto');
    assert.equal(lerErroJsonRpc({ error: 'texto solto' }).formato, 'texto');
    assert.equal(lerErroJsonRpc({ result: '0x' }).formato, 'ausente');
    assert.equal(lerErroJsonRpc('não é objeto').formato, 'estranho');
    // Sem mensagem, a frase DIZ que não há — e diz que a forma não explica a causa.
    const semMsg = lerErroJsonRpc({ error: [-32000] });
    assert.equal(semMsg.mensagem, null);
    assert.match(comoLerOErroJsonRpc(semMsg), /SEM mensagem legível/);
    assert.match(comoLerOErroJsonRpc(semMsg), /não por que o provedor recusou/);
});

test('a forma não é a causa, e a frase não deixa confundir', () => {
    // Ela avisou: *"Não atribua a causa apenas ao formato."*
    const e = lerErroJsonRpc({ error: [-32005, 'request limit reached'] }, 200);
    const frase = comoLerOErroJsonRpc(e);
    // A forma aparece como diagnóstico de LEITURA, ao lado da mensagem real.
    assert.match(frase, /forma do erro: par/);
    assert.ok(frase.indexOf('request limit reached') < frase.indexOf('forma do erro'),
        'a mensagem do provedor vem primeiro: ela é a evidência, a forma é contexto');
    // E a causa específica continua indeterminada.
    assert.equal(diagnosticarRecusaDeLogs(e.mensagem!).restricao, 'indeterminada');
});

test('a credencial não passa pelo leitor de erro', () => {
    const e = lerErroJsonRpc({ error: [-1, 'denied at https://h/v2/CHAVE_SECRETA_LONGA_1234'] });
    assert.ok(!comoLerOErroJsonRpc(e).includes('CHAVE_SECRETA_LONGA_1234'));
});
