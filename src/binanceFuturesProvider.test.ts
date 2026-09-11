// Arquivo: src/binanceFuturesProvider.test.ts
//
// O que estes testes protegem é uma classe de defeito que já mordeu este
// projeto duas vezes: código escrito, comentado, TESTADO — e nunca ligado.
//
// O placar de alvos foi a versão barata (o log mentia). O recuo contra
// banimento foi a cara: rateLimiter.ts tem a escada inteira (429 recue, 418
// banido de 2 minutos a 3 dias, cada tentativa durante a pena ESTENDE a pena),
// tem registrarRecusa, tem lerRetryAfter, tudo com teste passando — e em
// produção `registrarRecusa` só era chamado pelos próprios testes. O motor
// rodou horas levando -1003 da Binance sem nunca conseguir saber que tinha
// levado.
//
// Testar a unidade não pega isso. O que pega é testar a PONTE: dado um servidor
// que recusa, o provider avisa quem precisa saber? É o que está aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { BinanceFuturesProvider } from './binanceFuturesProvider';

/** Sobe um servidor que responde sempre a mesma coisa, e devolve a URL dele. */
async function servidorQueResponde(
    status: number,
    corpo: unknown,
    cabecalhos: Record<string, string> = {},
): Promise<{ url: string; fechar: () => Promise<void> }> {
    const s: Server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cabecalhos });
        res.end(JSON.stringify(corpo));
    });
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    const { port } = s.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        fechar: () => new Promise<void>((ok) => s.close(() => ok())),
    };
}

function provider(url: string, recusas: Array<{ status: number; retryAfterSegundos?: number }>) {
    const p = new BinanceFuturesProvider({ apiKey: 'k', apiSecret: 's', restBaseUrl: url });
    p.avisarRecusasEm((r) => recusas.push(r));
    return p;
}

test('-1003 avisa o controle de vazão — o aviso que vem ANTES do banimento', async () => {
    // Este é exatamente o erro que apareceu em produção: "Too many requests;
    // current limit of IP is 2400 requests per minute". É a corretora pedindo
    // para diminuir enquanto ainda dá tempo. Ignorar é subir a escada sozinho.
    const srv = await servidorQueResponde(429, { code: -1003, msg: 'Too many requests' });
    const recusas: Array<{ status: number; retryAfterSegundos?: number }> = [];
    try {
        await assert.rejects(() => provider(srv.url, recusas).marcacaoDe('BTCUSDT'));
        assert.equal(recusas.length, 1, 'o controle de vazão PRECISA ser avisado');
        assert.equal(recusas[0].status, 429);
    } finally {
        await srv.fechar();
    }
});

test('418 avisa, e carrega o Retry-After que a corretora mandou', async () => {
    // No 418 o tempo informado não é sugestão: tentar antes dele ESTENDE a
    // pena. Perder esse número é perder a única informação que importa.
    const srv = await servidorQueResponde(418, { code: -1003, msg: 'banned' }, { 'retry-after': '120' });
    const recusas: Array<{ status: number; retryAfterSegundos?: number }> = [];
    try {
        await assert.rejects(() => provider(srv.url, recusas).marcacaoDe('BTCUSDT'));
        assert.deepEqual(recusas, [{ status: 418, retryAfterSegundos: 120 }]);
    } finally {
        await srv.fechar();
    }
});

test('erro comum NÃO avisa o controle de vazão', async () => {
    // Recuar por causa de um símbolo inválido seria punir o motor por um erro
    // que não tem nada a ver com ritmo.
    const srv = await servidorQueResponde(400, { code: -1121, msg: 'Invalid symbol' });
    const recusas: Array<{ status: number; retryAfterSegundos?: number }> = [];
    try {
        await assert.rejects(() => provider(srv.url, recusas).marcacaoDe('NAOEXISTE'));
        assert.deepEqual(recusas, [], 'símbolo inválido não é excesso de vazão');
    } finally {
        await srv.fechar();
    }
});

test('sem ouvinte ligado, a recusa ainda lança o erro em vez de estourar', async () => {
    // O gancho é opcional. Um provider sem motor (um script solto) não pode
    // quebrar de forma diferente por causa disso.
    const srv = await servidorQueResponde(429, { code: -1003, msg: 'Too many requests' });
    try {
        const p = new BinanceFuturesProvider({ apiKey: 'k', apiSecret: 's', restBaseUrl: srv.url });
        await assert.rejects(() => p.marcacaoDe('BTCUSDT'), /Too many requests/);
    } finally {
        await srv.fechar();
    }
});

test('marcacaoDe devolve o markPrice, que é o preço que o vigia do stop usa', async () => {
    const srv = await servidorQueResponde(200, { symbol: 'BTCUSDT', markPrice: '64123.45' });
    try {
        const p = new BinanceFuturesProvider({ apiKey: 'k', apiSecret: 's', restBaseUrl: srv.url });
        assert.equal((await p.marcacaoDe('BTCUSDT')).toString(), '64123.45');
    } finally {
        await srv.fechar();
    }
});
