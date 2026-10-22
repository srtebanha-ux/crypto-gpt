// Arquivo: src/logger.test.ts
//
// LOG_LEVEL é lido uma única vez no carregamento do módulo (não por
// chamada), então cada teste que varia LOG_LEVEL precisa invalidar o cache
// do require e reimportar — replicando o que aconteceria num processo novo
// com a env var já setada (é assim que se usa na prática: setando antes de
// iniciar o processo, nunca em runtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOGGER_MODULE_PATH = require.resolve('./logger');

function freshLoggerModule(logLevel: string | undefined): typeof import('./logger') {
    delete require.cache[LOGGER_MODULE_PATH];
    if (logLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = logLevel;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./logger');
}

function captureConsole<T>(fn: () => T): { result: T; logLines: string[]; warnLines: string[]; errorLines: string[] } {
    const logLines: string[] = [];
    const warnLines: string[] = [];
    const errorLines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (msg: string) => logLines.push(msg);
    console.warn = (msg: string) => warnLines.push(msg);
    console.error = (msg: string) => errorLines.push(msg);
    try {
        const result = fn();
        return { result, logLines, warnLines, errorLines };
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }
}

test('sem LOG_LEVEL definido (padrão), info/warn/error são todos emitidos', () => {
    const { createLogger } = freshLoggerModule(undefined);
    const log = createLogger('test');
    const { logLines, warnLines, errorLines } = captureConsole(() => {
        log.info('mensagem info');
        log.warn('mensagem warn');
        log.error('mensagem error');
    });
    assert.equal(logLines.length, 1);
    assert.equal(warnLines.length, 1);
    assert.equal(errorLines.length, 1);
});

test("LOG_LEVEL=warn suprime info mas mantém warn/error (uso: simulações em lote com muitos ciclos)", () => {
    const { createLogger } = freshLoggerModule('warn');
    const log = createLogger('test');
    const { logLines, warnLines, errorLines } = captureConsole(() => {
        log.info('não deveria aparecer');
        log.warn('deveria aparecer');
        log.error('deveria aparecer');
    });
    assert.equal(logLines.length, 0);
    assert.equal(warnLines.length, 1);
    assert.equal(errorLines.length, 1);
});

test('LOG_LEVEL=error suprime info e warn, só error passa', () => {
    const { createLogger } = freshLoggerModule('error');
    const log = createLogger('test');
    const { logLines, warnLines, errorLines } = captureConsole(() => {
        log.info('não deveria aparecer');
        log.warn('não deveria aparecer');
        log.error('deveria aparecer');
    });
    assert.equal(logLines.length, 0);
    assert.equal(warnLines.length, 0);
    assert.equal(errorLines.length, 1);
});

test('LOG_LEVEL inválido/desconhecido cai no padrão (info) em vez de silenciar tudo por engano', () => {
    const { createLogger } = freshLoggerModule('nivel-que-nao-existe');
    const log = createLogger('test');
    const { logLines } = captureConsole(() => {
        log.info('deveria aparecer — fallback pro padrão');
    });
    assert.equal(logLines.length, 1);
    delete process.env.LOG_LEVEL;
});


test('debug fica silencioso no nível padrão — detalhe por item não afoga o log', () => {
    // LOG_LEVELS já declarava `debug: 0` antes de o método existir, então
    // LOG_LEVEL=debug era aceito e nada podia emitir nele. Este teste fixa
    // que os dois lados agora concordam.
    const { createLogger } = freshLoggerModule(undefined);
    const log = createLogger('test');
    const { logLines } = captureConsole(() => log.debug('detalhe por item'));
    assert.equal(logLines.length, 0);
});

test('LOG_LEVEL=debug faz o detalhe aparecer, marcado como DEBUG', () => {
    const { createLogger } = freshLoggerModule('debug');
    const log = createLogger('test');
    const { logLines } = captureConsole(() => {
        log.debug('detalhe por item');
        log.info('resumo');
    });
    assert.equal(logLines.length, 2);
    assert.match(logLines[0], /\[DEBUG\]/);
    assert.match(logLines[1], /\[INFO\]/);
});


test('redacts configured secrets in message, serialized errors and nested fields', () => {
    const { createLogger } = freshLoggerModule(undefined);
    const secret = 'fixture-secret-never-a-production-key';
    process.env.MEGAZORD_CHAVE_PRIVADA = secret;
    try {
        const {errorLines} = captureConsole(() => createLogger('test').error(
            'library rejected ' + secret,
            {error: new Error('invalid value=' + secret), nested: {privateKey: 'unknown-secret'}, gas: 42n},
        ));
        assert.ok(!errorLines[0].includes(secret));
        assert.ok(!errorLines[0].includes('unknown-secret'));
        assert.match(errorLines[0], /REDACTED/);
        assert.match(errorLines[0], /"gas":"42"/);
        assert.match(errorLines[0], /invalid value=/);
    } finally { delete process.env.MEGAZORD_CHAVE_PRIVADA; }
});
test('scrubs RPC credential URLs and key prefix variants without hiding transaction hashes', () => {
    const {ocultarSegredos} = freshLoggerModule(undefined);
    const key = 'a'.repeat(64), hash = '0x' + 'b'.repeat(64);
    const result = ocultarSegredos('0x' + key + ' https://rpc.test/private-path ' + hash,
        {BOT_PRIVATE_KEY: key, ARB_RPC_URL: 'https://rpc.test/private-path'});
    assert.ok(!result.includes(key));assert.ok(!result.includes('private-path'));
    assert.ok(result.includes(hash));
});
test('circular diagnostic data does not crash the logger', () => {
    const {createLogger} = freshLoggerModule(undefined);
    const data:Record<string,unknown> = {count: 1};data.self = data;
    const {warnLines} = captureConsole(() => createLogger('test').warn('diagnostic', data));
    assert.match(warnLines[0], /Circular/);
});
