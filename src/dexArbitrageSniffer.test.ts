// Arquivo: src/dexArbitrageSniffer.test.ts
//
// Teste de FIAÇÃO, não das peças. `evmAbi`, `dexGraph` e `ammMath` já têm
// testes próprios; o que ainda não estava coberto era a costura entre eles
// dentro do sniffer — decodificar respostas de RPC, casar cada resposta com o
// pool certo, normalizar decimais e montar os ciclos.
//
// Isso importa porque a costura tem um risco que as peças não têm: `loadPools`
// indexa `results[i * 3]` assumindo que o lote voltou completo e em ordem. Se
// o fatiamento em lotes desalinhasse por um, cada pool receberia as reservas
// do vizinho — sem lançar exceção, e virando "arbitragem" pura invenção.
// Descobrir isso rodando contra um RPC real custaria uma ida e volta ao vivo.
//
// `fetch` é substituído por um nó JSON-RPC falso; nada aqui toca a rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    loadPools,
    discoverPoolAddresses,
    discoverFactoryFromPool,
    discoverPairsAcrossFactories,
    discoverTokensFromFactory,
    chunkedEthCall,
} from './dexArbitrageSniffer';
import { SELECTORS } from './evmAbi';
import { findTwoPoolCycles, hopsForCycle } from './dexGraph';
import { evaluateCycle } from './ammMath';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x1111111111111111111111111111111111111111';

function word(hex: string): string {
    return hex.replace(/^0x/, '').padStart(64, '0');
}

/** Converte um decimal humano para inteiro on-chain e depois para palavra ABI. */
function reserveWord(amount: string, decimals: number): string {
    const raw = new Decimal(amount).mul(new Decimal(10).pow(decimals));
    let n = raw.toDecimalPlaces(0, Decimal.ROUND_DOWN);
    let hex = '';
    while (n.greaterThan(0)) {
        hex = n.mod(16).toNumber().toString(16) + hex;
        n = n.dividedToIntegerBy(16);
    }
    return word(hex === '' ? '0' : hex);
}

interface FakePool {
    address: string;
    token0: string;
    token1: string;
    reserve0: string;
    reserve1: string;
}

/**
 * Nó JSON-RPC falso: responde token0/token1/getReserves/decimals conforme o
 * `to` e o seletor do `data`, respeitando o protocolo de lote (ids de volta).
 */
function installFakeRpc(pools: FakePool[], decimalsByToken: Record<string, number>, extra?: Record<string, string>) {
    const byAddress = new Map(pools.map((p) => [p.address.toLowerCase(), p]));
    const original = globalThis.fetch;

    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init!.body!);
        const respond = (req: { id: number; method: string; params: unknown[] }) => {
            if (req.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: req.id, result: '0x5f5e100' };
            const { to, data } = (req.params as Array<{ to: string; data: string }>)[0];
            const target = to.toLowerCase();
            const selector = data.slice(0, 10);

            if (extra && extra[`${target}:${selector}`] !== undefined) {
                return { jsonrpc: '2.0', id: req.id, result: extra[`${target}:${selector}`] };
            }
            const pool = byAddress.get(target);
            if (pool) {
                if (selector === SELECTORS.token0) return { jsonrpc: '2.0', id: req.id, result: '0x' + word(pool.token0) };
                if (selector === SELECTORS.token1) return { jsonrpc: '2.0', id: req.id, result: '0x' + word(pool.token1) };
                if (selector === SELECTORS.getReserves) {
                    const d0 = decimalsByToken[pool.token0.toLowerCase()];
                    const d1 = decimalsByToken[pool.token1.toLowerCase()];
                    return {
                        jsonrpc: '2.0',
                        id: req.id,
                        result: '0x' + reserveWord(pool.reserve0, d0) + reserveWord(pool.reserve1, d1) + word('66d1a2b0'),
                    };
                }
            }
            if (selector === SELECTORS.decimals && decimalsByToken[target] !== undefined) {
                return { jsonrpc: '2.0', id: req.id, result: '0x' + word(decimalsByToken[target].toString(16)) };
            }
            return { jsonrpc: '2.0', id: req.id, result: '0x' };
        };

        const body = Array.isArray(payload) ? payload.map(respond) : respond(payload);
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;

    return () => {
        globalThis.fetch = original;
    };
}

const DECIMALS = { [WETH.toLowerCase()]: 18, [USDC.toLowerCase()]: 6 };

test('loadPools decodifica, normaliza decimais e casa cada resposta com seu pool', async () => {
    const restore = installFakeRpc(
        [
            { address: '0xpool1'.padEnd(42, '0'), token0: WETH, token1: USDC, reserve0: '100', reserve1: '300000' },
            { address: '0xpool2'.padEnd(42, '0'), token0: WETH, token1: USDC, reserve0: '50', reserve1: '155000' },
        ],
        DECIMALS,
    );
    try {
        const pools = await loadPools('http://fake', ['0xpool1'.padEnd(42, '0'), '0xpool2'.padEnd(42, '0')], new Decimal('0.003'));

        assert.equal(pools.length, 2);
        // WETH tem 18 casas, USDC tem 6 — sem normalizar isso erraria por 1e12.
        assert.equal(pools[0].reserve0.toString(), '100');
        assert.equal(pools[0].reserve1.toString(), '300000');
        assert.equal(pools[1].reserve0.toString(), '50');
        assert.equal(pools[1].reserve1.toString(), '155000');
        assert.equal(pools[0].token0, WETH.toLowerCase());
    } finally {
        restore();
    }
});

test('cada pool recebe SUAS reservas mesmo com muitos pools (sem desalinhar no lote)', async () => {
    // 60 pools => 180 chamadas => atravessa o fatiamento em lotes de 100. Um
    // desalinhamento de um daria a cada pool as reservas do vizinho, sem erro
    // nenhum — exatamente o modo de falha que este teste existe para pegar.
    const fakes: FakePool[] = [];
    for (let i = 1; i <= 60; i++) {
        fakes.push({
            address: `0x${i.toString(16).padStart(40, '0')}`,
            token0: WETH,
            token1: USDC,
            reserve0: String(i),
            reserve1: String(i * 3000),
        });
    }
    const restore = installFakeRpc(fakes, DECIMALS);
    try {
        const pools = await loadPools('http://fake', fakes.map((f) => f.address), new Decimal('0.003'));
        assert.equal(pools.length, 60);
        for (let i = 0; i < 60; i++) {
            assert.equal(pools[i].reserve0.toString(), String(i + 1), `pool ${i} pegou reserva de outro`);
            assert.equal(pools[i].reserve1.toString(), String((i + 1) * 3000));
        }
    } finally {
        restore();
    }
});

test('pool que não é V2 é descartado sem desalinhar os demais', async () => {
    // O pool do meio devolve `0x` (é V3, ou não é pool). Os vizinhos precisam
    // continuar com as reservas certas.
    const bom1 = { address: '0xa'.padEnd(42, '0'), token0: WETH, token1: USDC, reserve0: '10', reserve1: '30000' };
    const bom2 = { address: '0xc'.padEnd(42, '0'), token0: WETH, token1: USDC, reserve0: '20', reserve1: '62000' };
    const restore = installFakeRpc([bom1, bom2], DECIMALS);
    try {
        const pools = await loadPools(
            'http://fake',
            [bom1.address, '0xb'.padEnd(42, '0'), bom2.address],
            new Decimal('0.003'),
        );
        assert.equal(pools.length, 2, 'o pool inválido tem que sumir, não virar pool vazio');
        assert.equal(pools[0].reserve0.toString(), '10');
        assert.equal(pools[1].reserve0.toString(), '20');
    } finally {
        restore();
    }
});

test('pipeline completo: dois pools desalinhados produzem ciclo lucrativo detectado', async () => {
    // Pool 1: 1 WETH = 3000 USDC. Pool 2: 1 WETH = 3100 USDC. ~3,3% de
    // desalinhamento, bem acima dos 0,6% de taxa dos dois hops.
    const p1 = { address: '0xaaa'.padEnd(42, '1'), token0: WETH, token1: USDC, reserve0: '1000', reserve1: '3000000' };
    const p2 = { address: '0xbbb'.padEnd(42, '2'), token0: WETH, token1: USDC, reserve0: '1000', reserve1: '3100000' };
    const restore = installFakeRpc([p1, p2], DECIMALS);
    try {
        const pools = await loadPools('http://fake', [p1.address, p2.address], new Decimal('0.003'));
        const cycles = findTwoPoolCycles(pools, WETH);

        // Os DOIS sentidos precisam existir: vender no pool caro e recomprar no
        // barato dá lucro; o inverso dá prejuízo. Emitir só um seria acertar
        // por sorte metade das vezes.
        assert.equal(cycles.length, 2, 'os dois sentidos do par têm que ser avaliados');

        const evaluations = cycles.map((c) =>
            evaluateCycle(hopsForCycle(c), new Decimal('100'), {
                flashLoanFeeFraction: new Decimal('0.0005'),
                gasCostInToken: new Decimal('0.00001'), // gas barato de L2, em WETH
            }),
        );

        const lucrativos = evaluations.filter((e) => e.profitable);
        assert.equal(lucrativos.length, 1, 'exatamente um sentido dá lucro — o outro é a operação inversa');
        assert.ok(lucrativos[0].amountIn.greaterThan(0));
        assert.ok(lucrativos[0].netProfit.greaterThan(0), 'desalinhamento de 3,3% supera 0,6% de taxa com folga');
    } finally {
        restore();
    }
});

test('pools alinhados: pipeline completo NÃO inventa oportunidade', async () => {
    // O teste espelho do anterior. Se a orientação das reservas estivesse
    // invertida em algum ponto da costura, este caso viraria "lucro".
    const p1 = { address: '0xaaa'.padEnd(42, '1'), token0: WETH, token1: USDC, reserve0: '1000', reserve1: '3000000' };
    const p2 = { address: '0xbbb'.padEnd(42, '2'), token0: WETH, token1: USDC, reserve0: '1000', reserve1: '3000000' };
    const restore = installFakeRpc([p1, p2], DECIMALS);
    try {
        const pools = await loadPools('http://fake', [p1.address, p2.address], new Decimal('0.003'));
        const cycles = findTwoPoolCycles(pools, WETH);
        // NENHUM dos dois sentidos pode dar lucro quando os pools concordam.
        for (const cycle of cycles) {
            const evaluation = evaluateCycle(hopsForCycle(cycle), new Decimal('100'), {
                flashLoanFeeFraction: new Decimal('0.0005'),
                gasCostInToken: new Decimal('0.00001'),
            });
            assert.ok(!evaluation.profitable, 'pools alinhados não podem produzir lucro em sentido nenhum');
        }
    } finally {
        restore();
    }
});

test('discoverPoolAddresses lê allPairsLength e busca os índices selecionados', async () => {
    const factory = '0xfac'.padEnd(42, '0');
    const restore = installFakeRpc([], DECIMALS, {
        [`${factory}:${SELECTORS.allPairsLength}`]: '0x' + word('3'), // 3 pools
        [`${factory}:${SELECTORS.allPairs}`]: '0x' + word('0xdead'.replace('0x', '')),
    });
    const prev = process.env.DEX_SCAN_LIMIT;
    process.env.DEX_SCAN_LIMIT = '2';
    try {
        const addresses = await discoverPoolAddresses('http://fake', factory);
        assert.equal(addresses.length, 2);
        assert.ok(addresses.every((a) => a.startsWith('0x')));
    } finally {
        if (prev === undefined) delete process.env.DEX_SCAN_LIMIT;
        else process.env.DEX_SCAN_LIMIT = prev;
        restore();
    }
});

test('factory falsa (allPairsLength = 0) estoura com mensagem acionável', async () => {
    const factory = '0xfac'.padEnd(42, '0');
    const restore = installFakeRpc([], DECIMALS, {
        [`${factory}:${SELECTORS.allPairsLength}`]: '0x', // endereço que não é factory
    });
    try {
        await assert.rejects(() => discoverPoolAddresses('http://fake', factory), /provavelmente não é uma factory V2/);
    } finally {
        restore();
    }
});

test('chunkedEthCall preserva ordem através dos lotes', async () => {
    // Se a ordem se perdesse entre lotes, todo o resto da costura ficaria
    // errado de forma silenciosa.
    const fakes: FakePool[] = [];
    for (let i = 1; i <= 250; i++) {
        fakes.push({
            address: `0x${i.toString(16).padStart(40, '0')}`,
            token0: WETH,
            token1: USDC,
            reserve0: String(i),
            reserve1: String(i),
        });
    }
    const restore = installFakeRpc(fakes, DECIMALS);
    try {
        const results = await chunkedEthCall(
            'http://fake',
            fakes.map((f) => ({ to: f.address, data: SELECTORS.token0 })),
        );
        assert.equal(results.length, 250);
        assert.ok(results.every((r) => r.toLowerCase().endsWith(WETH.slice(2).toLowerCase())));
    } finally {
        restore();
    }
});

test('descobre a factory a partir de um pool semente via factory()', async () => {
    // Endereço de pool aparece na interface de swap; endereço de factory se
    // garimpa em documentação. Pedir o que é fácil de obter reduz a chance de
    // alguém colar o endereço errado — que não estouraria, viraria relatório
    // errado.
    const seed = '0xseed'.padEnd(42, '0');
    const fac = '0x' + 'fa'.repeat(20);
    const restore = installFakeRpc([], DECIMALS, {
        [`${seed}:${SELECTORS.factory}`]: '0x' + word(fac),
    });
    try {
        assert.equal(await discoverFactoryFromPool('http://fake', seed), fac.toLowerCase());
    } finally {
        restore();
    }
});

test('pool semente que não é V2 estoura apontando a causa provável', async () => {
    const seed = '0xseed'.padEnd(42, '0');
    const restore = installFakeRpc([], DECIMALS, { [`${seed}:${SELECTORS.factory}`]: '0x' });
    try {
        await assert.rejects(
            () => discoverFactoryFromPool('http://fake', seed),
            /não é um pool de produto constante/,
        );
    } finally {
        restore();
    }
});

test('factory() devolvendo endereço zero é recusado', async () => {
    // Endereço zero passaria na decodificação e viraria uma "factory" que
    // responde vazio a tudo — silenciosamente zero pools.
    const seed = '0xseed'.padEnd(42, '0');
    const restore = installFakeRpc([], DECIMALS, {
        [`${seed}:${SELECTORS.factory}`]: '0x' + word('0'),
    });
    try {
        await assert.rejects(() => discoverFactoryFromPool('http://fake', seed), /endereço zero/);
    } finally {
        restore();
    }
});

test('o tamanho do lote se adapta quando o RPC recusa lotes grandes', async () => {
    // Defeito real: o tamanho do lote era fixo em 100. Funcionava no provedor
    // que eu tinha em mente e quebrava no RPC público da Base, que aceita 10 —
    // "maximum 10 calls in 1 batch", varredura abortada. O limite varia por
    // provedor e não é anunciado, então o scanner precisa descobri-lo tentando.
    const LIMITE = 10;
    const original = globalThis.fetch;
    const tamanhosPedidos: number[] = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        tamanhosPedidos.push(payload.length);
        if (payload.length > LIMITE) {
            // Resposta de erro ÚNICA, não array — que é como um RPC real
            // recusa um lote grande demais.
            return {
                ok: true,
                json: async () => ({ jsonrpc: '2.0', error: { code: -32014, message: `maximum ${LIMITE} calls in 1 batch` }, id: null }),
            };
        }
        return {
            ok: true,
            json: async () => payload.map((p, idx) => ({ jsonrpc: '2.0', id: p.id, result: '0x' + word(String(idx + 1)) })),
        };
    }) as unknown as typeof fetch;

    try {
        const calls = Array.from({ length: 45 }, (_v, i) => ({ to: `0x${i.toString(16).padStart(40, '0')}`, data: SELECTORS.token0 }));
        const results = await chunkedEthCall('http://fake', calls, 100);

        assert.equal(results.length, 45, 'nenhuma chamada pode se perder na redução');
        assert.ok(tamanhosPedidos.some((t) => t > LIMITE), 'a primeira tentativa usa o tamanho pedido');
        assert.ok(
            tamanhosPedidos.filter((t) => t > LIMITE).length <= 4,
            'a redução vale para os lotes seguintes — não se re-tenta o tamanho grande a cada lote',
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('endpoint que recusa até uma chamada única falha com orientação, não em silêncio', async () => {
    // Encolher o lote não resolve endpoint sem suporte a batch. Aí a mensagem
    // precisa dizer o que fazer, em vez de repetir "lote recusado" para sempre.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', error: { code: -32600, message: 'batch not supported' }, id: null }),
    })) as unknown as typeof fetch;

    try {
        await assert.rejects(
            () => chunkedEthCall('http://fake', [{ to: '0x' + '11'.repeat(20), data: SELECTORS.token0 }], 8),
            /recusou até uma única chamada|DEX_RPC_URL/,
        );
    } finally {
        globalThis.fetch = original;
    }
});

// As esperas reais somam mais de meio minuto; o que os testes verificam é o
// comportamento, não a duração.
process.env.DEX_RPC_RETRY_BASE_MS = '1';
// Sem isto, cada teste pagaria o ritmo real de 10 chamadas/s.
process.env.DEX_RPC_CALLS_PER_SEC = '100000';

test('limite de taxa é esperado e retentado, não tratado como falha do pool', async () => {
    // O RPC público da Base recusa por limite de taxa no meio da varredura.
    // Encolher o lote não resolve — o problema é ritmo, não tamanho — e tratar
    // como erro de leitura descartaria pools bons como se fossem inválidos.
    const original = globalThis.fetch;
    let chamadas = 0;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        chamadas += 1;
        if (chamadas <= 2) {
            return {
                ok: true,
                json: async () => payload.map((p) => ({ jsonrpc: '2.0', id: p.id, error: { message: 'over rate limit' } })),
            };
        }
        return {
            ok: true,
            json: async () => payload.map((p, idx) => ({ jsonrpc: '2.0', id: p.id, result: '0x' + word(String(idx + 1)) })),
        };
    }) as unknown as typeof fetch;

    try {
        const calls = Array.from({ length: 4 }, (_v, i) => ({ to: `0x${i.toString(16).padStart(40, '0')}`, data: SELECTORS.token0 }));
        const results = await chunkedEthCall('http://fake', calls, 4);
        assert.equal(results.length, 4, 'depois da espera, a varredura continua de onde parou');
        assert.ok(chamadas >= 3, 'houve retentativa em vez de desistência');
    } finally {
        globalThis.fetch = original;
    }
});

test('limite de taxa persistente falha com as três saídas possíveis nomeadas', async () => {
    // Esperar para sempre num endpoint que não aguenta a varredura é pior que
    // parar: o erro precisa dizer o que mudar.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        return {
            ok: true,
            json: async () => payload.map((p) => ({ jsonrpc: '2.0', id: p.id, error: { message: 'over rate limit' } })),
        };
    }) as unknown as typeof fetch;

    try {
        await assert.rejects(
            () => chunkedEthCall('http://fake', [{ to: '0x' + '22'.repeat(20), data: SELECTORS.token0 }], 1),
            /DEX_SCAN_LIMIT.*DEX_RPC_CALLS_PER_SEC.*DEX_RPC_URL/s,
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('erro comum de contrato NÃO é retentado — revert reverte sempre', async () => {
    // Retentar cada pool morto numa varredura de 200 multiplicaria o tempo sem
    // mudar resultado nenhum.
    const original = globalThis.fetch;
    let chamadas = 0;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        chamadas += 1;
        return {
            ok: true,
            json: async () => payload.map((p) => ({ jsonrpc: '2.0', id: p.id, error: { message: 'execution reverted' } })),
        };
    }) as unknown as typeof fetch;

    try {
        await assert.rejects(
            () => chunkedEthCall('http://fake', [{ to: '0x' + '33'.repeat(20), data: SELECTORS.token0 }], 1),
            /execution reverted/,
        );
        assert.equal(chamadas, 1, 'uma tentativa só');
    } finally {
        globalThis.fetch = original;
    }
});

test('mensagem que fala em LOTE encolhe, não espera', async () => {
    // "batch size exceeded" contém 'exceeded' e não é limite de ritmo: esperar
    // minutos não muda nada, encolher resolve na primeira tentativa. Foi o que
    // custou um diagnóstico às cegas contra um provedor real.
    const LIMITE = 5;
    const original = globalThis.fetch;
    const tamanhos: number[] = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        tamanhos.push(payload.length);
        if (payload.length > LIMITE) {
            return {
                ok: true,
                json: async () => ({ jsonrpc: '2.0', error: { message: 'batch size exceeded' }, id: null }),
            };
        }
        return {
            ok: true,
            json: async () => payload.map((p, idx) => ({ jsonrpc: '2.0', id: p.id, result: '0x' + word(String(idx + 1)) })),
        };
    }) as unknown as typeof fetch;

    try {
        const calls = Array.from({ length: 10 }, (_v, i) => ({ to: `0x${i.toString(16).padStart(40, '0')}`, data: SELECTORS.token0 }));
        const results = await chunkedEthCall('http://fake', calls, 20);
        assert.equal(results.length, 10);
        assert.ok(Math.min(...tamanhos) <= LIMITE, 'o lote encolheu até caber');
    } finally {
        globalThis.fetch = original;
    }
});

test('o aviso de limite carrega a mensagem do provedor', async () => {
    // Sem ela não dá para distinguir limite real de erro que só parece limite,
    // e a espera vira tempo jogado fora contra uma causa inexistente.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        return {
            ok: true,
            json: async () => payload.map((p) => ({ jsonrpc: '2.0', id: p.id, error: { message: 'exceeded compute unit capacity' } })),
        };
    }) as unknown as typeof fetch;

    try {
        await assert.rejects(
            () => chunkedEthCall('http://fake', [{ to: '0x' + '44'.repeat(20), data: SELECTORS.token0 }], 1),
            /exceeded compute unit capacity/,
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('a taxa é respeitada ANTES do primeiro lote sair, não depois', async () => {
    // O defeito: a pausa entre lotes tinha padrão zero, então 200 chamadas
    // partiam na velocidade da rede e estouravam o limite do provedor antes de
    // qualquer espera entrar em ação — "Your app has exceeded its compute units
    // per second capacity" na primeira leva. Pausa entre lotes não é taxa: com
    // lote grande, o pico continua sendo o lote inteiro de uma vez.
    const original = globalThis.fetch;
    const instantes: number[] = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        instantes.push(Date.now());
        return {
            ok: true,
            json: async () => payload.map((p, idx) => ({ jsonrpc: '2.0', id: p.id, result: '0x' + word(String(idx + 1)) })),
        };
    }) as unknown as typeof fetch;

    const salvo = process.env.DEX_RPC_CALLS_PER_SEC;
    process.env.DEX_RPC_CALLS_PER_SEC = '50'; // 5 chamadas por lote => 100ms entre lotes
    try {
        const calls = Array.from({ length: 15 }, (_v, i) => ({ to: `0x${i.toString(16).padStart(40, '0')}`, data: SELECTORS.token0 }));
        const inicio = Date.now();
        await chunkedEthCall('http://fake', calls, 5);
        const decorrido = Date.now() - inicio;

        assert.equal(instantes.length, 3, 'três lotes de cinco');
        // 15 chamadas a 50/s = 300ms de custo total; o último lote não precisa
        // esperar depois de enviado, então o piso é ~200ms.
        assert.ok(decorrido >= 180, `a varredura foi ritmada (levou ${decorrido}ms)`);
    } finally {
        globalThis.fetch = original;
        process.env.DEX_RPC_CALLS_PER_SEC = salvo;
    }
});

test('recusa por ritmo corta a TAXA, não só a pausa', async () => {
    // Aumentar a pausa entre lotes sem baixar a taxa mantém o mesmo pico e o
    // provedor recusa de novo — foi o que aconteceu contra a Alchemy.
    const original = globalThis.fetch;
    let chamadas = 0;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        chamadas += 1;
        if (chamadas === 1) {
            return {
                ok: true,
                json: async () => payload.map((p) => ({
                    jsonrpc: '2.0',
                    id: p.id,
                    error: { message: 'Your app has exceeded its compute units per second capacity' },
                })),
            };
        }
        return {
            ok: true,
            json: async () => payload.map((p, idx) => ({ jsonrpc: '2.0', id: p.id, result: '0x' + word(String(idx + 1)) })),
        };
    }) as unknown as typeof fetch;

    try {
        const calls = Array.from({ length: 8 }, (_v, i) => ({ to: `0x${i.toString(16).padStart(40, '0')}`, data: SELECTORS.token0 }));
        const results = await chunkedEthCall('http://fake', calls, 8);
        assert.equal(results.length, 8, 'a varredura completa depois de desacelerar');
        assert.ok(chamadas >= 2, 'houve retentativa com ritmo menor');
    } finally {
        globalThis.fetch = original;
    }
});

test('busca dirigida encontra o mesmo par em duas factories', async () => {
    // A varredura aleatória mediu que a Uniswap V2 na Base é grafo estrela:
    // 387 pools, 389 tokens, ZERO tokens em dois pools. Nesse grafo não existe
    // triângulo e amostrar mais não muda — sobra o mesmo par em duas DEXs, que
    // por amostragem tem probabilidade praticamente zero de aparecer.
    const facA = '0x' + 'aa'.repeat(20);
    const facB = '0x' + 'bb'.repeat(20);
    const USDT = '0x' + 'cc'.repeat(20);
    const poolA = '0x' + '1a'.repeat(20);
    const poolB = '0x' + '1b'.repeat(20);

    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number; params: [{ to: string; data: string }] }>;
        return {
            ok: true,
            json: async () =>
                payload.map((p) => {
                    const { to, data } = p.params[0];
                    if (data.startsWith(SELECTORS.getPair)) {
                        const alvo = to.toLowerCase() === facA ? poolA : poolB;
                        return { jsonrpc: '2.0', id: p.id, result: '0x' + word(alvo) };
                    }
                    if (data === SELECTORS.factory) {
                        return { jsonrpc: '2.0', id: p.id, result: '0x' + word(to.toLowerCase() === poolA ? facA : facB) };
                    }
                    return { jsonrpc: '2.0', id: p.id, result: '0x' };
                }),
        };
    }) as unknown as typeof fetch;

    try {
        const pares = await discoverPairsAcrossFactories('http://fake', [facA, facB], [USDT], WETH);
        assert.deepEqual(pares.sort(), [poolA, poolB].sort(), 'o mesmo par nas duas DEXs vira dois pools no grafo');
    } finally {
        globalThis.fetch = original;
    }
});

test('getPair devolvendo endereço que não se declara da factory PARA a medição', async () => {
    // Seletor errado não estoura: devolve lixo que decodifica como endereço, e
    // o relatório sairia medindo um contrato que ninguém escolheu. É a mesma
    // classe de erro que fez este projeto nunca embutir endereço de memória.
    const facA = '0x' + 'aa'.repeat(20);
    const intruso = '0x' + '99'.repeat(20);
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number; params: [{ to: string; data: string }] }>;
        return {
            ok: true,
            json: async () =>
                payload.map((p) => ({
                    jsonrpc: '2.0',
                    id: p.id,
                    // getPair devolve algo; factory() nesse algo devolve outra coisa.
                    result: '0x' + word(p.params[0].data.startsWith(SELECTORS.getPair) ? intruso : '0x' + 'ee'.repeat(20)),
                })),
        };
    }) as unknown as typeof fetch;

    try {
        await assert.rejects(
            () => discoverPairsAcrossFactories('http://fake', [facA], ['0x' + 'cc'.repeat(20)], WETH),
            /não se declara criado por nenhuma das factories/,
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('nenhum par encontrado distingue "não existe" de "seletor errado"', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const payload = JSON.parse(init?.body ?? '[]') as Array<{ id: number }>;
        return {
            ok: true,
            json: async () => payload.map((p) => ({ jsonrpc: '2.0', id: p.id, result: '0x' + word('0') })),
        };
    }) as unknown as typeof fetch;

    try {
        await assert.rejects(
            () => discoverPairsAcrossFactories('http://fake', ['0x' + 'aa'.repeat(20)], ['0x' + 'cc'.repeat(20)], WETH),
            /seletor de getPair está errado/,
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('com duas factories, os tokens saem dos pools da primeira — sem pedir endereço a ninguém', async () => {
    // Pedir "os endereços de USDC, cbBTC e DAI" transfere para quem opera um
    // garimpo em explorador de bloco, com risco de colar o endereço errado — e
    // endereço errado não estoura, vira medição de outro token. A máquina lê
    // isso da própria factory.
    const fac = '0x' + 'aa'.repeat(20);
    const USDC = '0x' + 'cc'.repeat(20);
    const DAI = '0x' + 'dd'.repeat(20);
    const pool1 = '0x' + '11'.repeat(20);
    const pool2 = '0x' + '22'.repeat(20);

    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}');
        const payload = Array.isArray(body) ? body : [body];
        return {
            ok: true,
            json: async () => {
                const respostas = payload.map((p: { id: number; params: [{ to: string; data: string }] }) => {
                    const { data } = p.params[0];
                    if (data === SELECTORS.allPairsLength) return { jsonrpc: '2.0', id: p.id, result: '0x' + word('2') };
                    if (data.startsWith(SELECTORS.allPairs)) {
                        const indice = parseInt(data.slice(-64), 16);
                        return { jsonrpc: '2.0', id: p.id, result: '0x' + word(indice === 0 ? pool1 : pool2) };
                    }
                    if (data === SELECTORS.token0) return { jsonrpc: '2.0', id: p.id, result: '0x' + word(WETH) };
                    if (data === SELECTORS.token1) {
                        const alvo = p.params[0].to.toLowerCase() === pool1 ? USDC : DAI;
                        return { jsonrpc: '2.0', id: p.id, result: '0x' + word(alvo) };
                    }
                    return { jsonrpc: '2.0', id: p.id, result: '0x' };
                });
                return Array.isArray(body) ? respostas : respostas[0];
            },
        };
    }) as unknown as typeof fetch;

    try {
        const tokens = await discoverTokensFromFactory('http://fake', fac, WETH, 10);
        assert.deepEqual(tokens.sort(), [USDC, DAI].sort(), 'os dois tokens dos pools, sem o token base');
        assert.ok(!tokens.includes(WETH), 'o token base é o eixo do grafo — perguntar getPair(base, base) não faz sentido');
    } finally {
        globalThis.fetch = original;
    }
});
