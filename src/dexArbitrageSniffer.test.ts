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
import { loadPools, discoverPoolAddresses, discoverFactoryFromPool, chunkedEthCall } from './dexArbitrageSniffer';
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
