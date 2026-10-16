// O REPLAY CAUSAL: PRESERVACAO de pool nao e DESCOBERTA ANTECIPADA.
//
// A PROVA ANTERIOR (`aCoberturaContinua.js`) semeou a memoria com uma janela
// que termina em 52632036 e avaliou no 52632200 — DEPOIS das duas vencedoras.
// Aquilo prova que pool quieto nao desaparece (preservacao). NAO prova que o
// TITAN teria conhecido o pool ANTES do concorrente.
//
// Aqui o corte e ESTRITO e por operacao:
//
//     operacao do bloco 52632036  ->  so informacao existente ate 52632035
//     operacao do bloco 52632037  ->  so informacao existente ate 52632036
//
// A memoria comeca VAZIA (COLD START) e e atualizada BLOCO A BLOCO, como um
// processo que subiu antes e foi aprendendo. Cada registro tem origem
// verificavel: o bloco em que o pool foi visto negociando, e esse bloco e
// anotado. Uma assercao no transporte barra qualquer leitura acima do corte.
//
// IDENTIDADE DOS POOLS, lida dos recibos e nao reaproveitada entre operacoes:
// as DUAS operacoes usam os MESMOS dois pools (`0x3e31de9d…` V3 e
// `0x566bee7e…` Aerodrome), em ordem de perna invertida — CA na primeira, AC na
// segunda. O teste le os pools de CADA recibo e afirma isso em vez de supor.
const assert = require('node:assert/strict');
const { readFileSync, existsSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
    universoPorAtividade, lerEstadoMisto, cotarAfetadas, WETH_DA_BASE,
} = require('../dist/cacarArbitragem.js');
const { candidatasMistas, triarCandidatas } = require('../dist/rotasMistas.js');
const {
    lerMemoria, gravarMemoria, memoriaVazia, juntar, paraRotas, deDescoberta,
} = require('../dist/memoriaDoUniverso.js');
const { GORJETA_PADRAO_WEI } = require('../dist/custoDaBase.js');

const BENCHMARK = process.env.RC_BENCHMARK ?? '.tmp/benchmarkDeArbitragem.json';
const PREFIXOS = (process.env.RC_PREFIXOS ?? '0x6966a108,0xa72914e1').split(',');
/** A janela do replay incremental, em blocos, terminando no CORTE. */
const JANELA = Number(process.env.RC_JANELA ?? 12);
/** Amostras de historico ANTIGO, para nao declarar impossivel sem olhar. */
const AMOSTRAS = (process.env.RC_AMOSTRAS ?? '500,2000,10000').split(',').map(Number);
const BLOCOS_POR_AMOSTRA = Number(process.env.RC_BLOCOS_AMOSTRA ?? 3);
const TETO_DE_RPC = Number(process.env.RC_TETO_RPC ?? 200);

let p;
const chamar = (m, ps) => p.send(m, ps);
let pedidosUpstream = 0;
let undiciFetch = null;
let agente;
async function upstream(metodo, params) {
    if (undiciFetch === null) {
        const u = await import('undici');
        undiciFetch = u.fetch;
        agente = process.env.HTTPS_PROXY ? new u.ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    }
    const url = hre.config.networks.hardhat.forking.url;
    for (let t = 0; t < 6; t += 1) {
        try {
            pedidosUpstream += 1;
            // eslint-disable-next-line no-await-in-loop
            const r = await undiciFetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: metodo, params }),
                ...(agente ? { dispatcher: agente } : {}),
            });
            // eslint-disable-next-line no-await-in-loop
            const j = await r.json();
            if (j.error) throw new Error(j.error.message ?? 'erro');
            // Resposta nao-lista e RECUSA do no, nao medicao: aceitar isso
            // publicaria cobertura parcial como "o pool nao negociou".
            if (metodo === 'eth_getBlockReceipts' && !Array.isArray(j.result)) {
                throw new Error('resposta nao-lista');
            }
            return j.result;
        } catch (e) {
            if (t === 5) throw e;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((s) => { setTimeout(s, 700 * 2 ** t); });
        }
    }
    return null;
}

describe('o replay causal: cold start, bloco a bloco, com corte estrito', function () {
    this.timeout(3_600_000);

    it('mede cobertura ANTIGA e NOVA sem nenhuma informação posterior ao corte', async function () {
        if (!existsSync(BENCHMARK)) {
            console.log(`    FALTA DE DADOS: ${BENCHMARK} não existe.`);
            this.skip();
            return;
        }
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const bench = JSON.parse(readFileSync(BENCHMARK, 'utf8'));
        const rede = 8453;

        const alvos = PREFIXOS.map((pre) => {
            const o = bench.operacoes.find(
                (x) => x.tx.toLowerCase().startsWith(pre.toLowerCase()),
            );
            assert.ok(o !== undefined, `nenhuma operação começa com ${pre}`);
            return {
                tx: o.tx,
                bloco: o.bloco,
                venues: (o.dexes ?? []).join('+'),
                // OS POOLS DESTE recibo. Nada e reaproveitado da outra operacao.
                pools: o.pools.map((x) => x.toLowerCase()),
            };
        });
        console.log('\n    IDENTIDADE DOS POOLS, de CADA recibo:');
        for (const op of alvos) {
            console.log(`      ${op.tx.slice(0, 12)}… b${op.bloco} [${op.venues}]:`
                + ` ${op.pools.join(', ')}`);
        }
        const iguais = alvos.length === 2
            && [...alvos[0].pools].sort().join() === [...alvos[1].pools].sort().join();
        console.log(`      as duas operações usam o MESMO conjunto de pools? ${iguais ? 'SIM' : 'NÃO'}`
            + ' — e a ordem das pernas é o que difere (CA contra AC)');

        for (const op of alvos) {
            // O CORTE: nada igual ou acima do bloco da operacao.
            const corte = op.bloco - 1;
            const t0 = Date.now();
            let lidosAcimaDoCorte = 0;
            const transporte = (topo) => async (metodo, params) => {
                if (metodo === 'eth_blockNumber') return `0x${topo.toString(16)}`;
                if (metodo === 'eth_getBlockReceipts') {
                    const b = Number(BigInt(params[0]));
                    if (b > corte) lidosAcimaDoCorte += 1;
                    assert.ok(b <= corte,
                        `pediu o bloco ${b}, acima do corte ${corte} da operação `
                        + `${op.tx.slice(0, 12)}: informação futura não entra`);
                    return upstream(metodo, params);
                }
                return chamar(metodo, params);
            };

            console.log(`\n    ===== ${op.tx.slice(0, 12)}… bloco ${op.bloco}`
                + ` | CORTE em ${corte} =====`);
            await chamar('hardhat_reset', [{ forking: { jsonRpcUrl: url, blockNumber: corte } }]);

            // 1. O METODO ANTIGO: UMA descoberta, janela de JANELA blocos, sem
            //    memoria — exatamente o que o caçador fazia no boot.
            const tAntigo = Date.now();
            const antigo = await universoPorAtividade(transporte(corte), {
                blocos: JANELA, tetoDePools: Number(process.env.RC_TETO ?? 300),
            });
            const msAntigo = Date.now() - tAntigo;
            assert.ok(!antigo.metodoIndisponivel,
                'sem `eth_getBlockReceipts` não há o que medir — e zero pool NÃO é cobertura zero');
            const poolsAntigo = new Set(antigo.concentrados.map((x) => x.endereco.toLowerCase()));
            const cobAntigo = op.pools.filter((x) => poolsAntigo.has(x));
            const rotasAntigo = candidatasMistas(antigo.concentrados, WETH_DA_BASE);
            const sobreAntigo = rotasAntigo.filter(
                (c) => c.pernas.every((x) => op.pools.includes(x.pool.toLowerCase())),
            );
            console.log(`      ANTIGO (1 descoberta, janela ${JANELA}: `
                + `${corte - JANELA + 1}..${corte}, ${msAntigo}ms):`);
            console.log(`        ${antigo.concentrados.length} concentrado(s) | cobertura`
                + ` ${cobAntigo.length}/${op.pools.length} | ${rotasAntigo.length} rota(s),`
                + ` ${sobreAntigo.length} sobre os pools do vencedor`);

            // 2. O METODO NOVO, COLD START: memoria VAZIA, atualizada BLOCO A
            //    BLOCO. Cada registro anota o bloco em que o pool foi visto —
            //    origem verificavel, e toda ela abaixo do corte.
            const caminho = path.join(os.tmpdir(), `replay-${op.bloco}-${Date.now()}.json`);
            let memoria = memoriaVazia(rede);
            const entrouNoBloco = new Map();
            const tNovo = Date.now();
            let reinicios = 0;
            const metade = corte - Math.floor(JANELA / 2);
            for (let b = corte - JANELA + 1; b <= corte; b += 1) {
                // eslint-disable-next-line no-await-in-loop
                const passo = await universoPorAtividade(transporte(b), {
                    blocos: 1, tetoDePools: Number(process.env.RC_TETO ?? 300),
                });
                if (passo.metodoIndisponivel) continue;
                const j = juntar(memoria, deDescoberta(passo.concentrados, rede, b));
                memoria = j.memoria;
                for (const k of j.novas) {
                    const end = k.split(':')[2];
                    if (op.pools.includes(end) && !entrouNoBloco.has(end)) {
                        entrouNoBloco.set(end, b);
                    }
                }
                if (b === metade) {
                    // REINICIO SIMULADO no meio do replay: grava, esquece e
                    // relê do disco. Se a persistência não funcionar, a
                    // cobertura cai aqui.
                    // eslint-disable-next-line no-await-in-loop
                    await gravarMemoria(caminho, memoria);
                    const doDisco = lerMemoria(caminho, rede);
                    assert.ok(doDisco !== null, 'a memória gravada tem de voltar do disco');
                    assert.equal(doDisco.pools.length, memoria.pools.length,
                        'persistência que perde pool não serve');
                    memoria = doDisco;
                    reinicios += 1;
                }
            }
            const msNovo = Date.now() - tNovo;
            const poolsNovo = new Set(memoria.pools.map((q) => q.endereco));
            const cobNovo = op.pools.filter((x) => poolsNovo.has(x));
            const rotasNovo = candidatasMistas(paraRotas(memoria), WETH_DA_BASE);
            const sobreNovo = rotasNovo.filter(
                (c) => c.pernas.every((x) => op.pools.includes(x.pool.toLowerCase())),
            );
            console.log(`      NOVO (COLD START, ${JANELA} atualizações incrementais,`
                + ` ${reinicios} reinício(s) simulado(s), ${msNovo}ms):`);
            console.log(`        ${memoria.pools.length} pool(s) lembrado(s) | cobertura`
                + ` ${cobNovo.length}/${op.pools.length} | ${rotasNovo.length} rota(s),`
                + ` ${sobreNovo.length} sobre os pools do vencedor`);
            for (const pool of op.pools) {
                const b = entrouNoBloco.get(pool);
                console.log(`        ${pool}: ${b === undefined
                    ? 'NÃO entrou na memória até o corte'
                    : `entrou no bloco ${b} (${op.bloco - b} bloco(s) antes da operação)`}`);
            }

            // 3. A COTACAO, se houver rota — no estado do CORTE, fresco.
            if (sobreNovo.length > 0) {
                const L = await lerEstadoMisto(chamar, sobreNovo, corte, 'latest');
                const tri = triarCandidatas(sobreNovo, WETH_DA_BASE, L);
                const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
                const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
                const art = await hre.artifacts.readArtifact('CacadorV3');
                let cotados = 0;
                const emLote = async (pedidos) => {
                    const saidas = [];
                    for (const pedido of pedidos) {
                        cotados += 1;
                        try {
                            // eslint-disable-next-line no-await-in-loop
                            const ok = await chamar(pedido.metodo, pedido.params);
                            saidas.push({ ok: true, dados: typeof ok === 'string' ? ok : null });
                        } catch (e) {
                            const d = (e && (e.data || (e.error && e.error.data))) || null;
                            saidas.push({ ok: false, dados: typeof d === 'string' ? d : null });
                        }
                    }
                    return saidas;
                };
                const sinais = await cotarAfetadas(
                    emLote, chamar, tri.valem, L, 'latest', corte, Date.now(),
                    baseFeeWei, art.deployedBytecode,
                );
                console.log(`        TRIAGEM ${tri.valem.length} de ${sobreNovo.length}`
                    + ` | baseFee ${baseFeeWei} + gorjeta ${GORJETA_PADRAO_WEI}`
                    + ` | ${cotados} cotação(ões)`);
                for (const s of sinais) {
                    console.log(`        COTAÇÃO tamanho ${s.melhorTamanho}`
                        + ` | bruto ${s.lucroBrutoEstimado} | custo ${s.custoTotalEstimado}`
                        + ` | LÍQUIDO ${s.lucroLiquidoEstimado}`);
                    if (s.custoTotalEstimado === null) {
                        assert.equal(s.lucroLiquidoEstimado, null,
                            'líquido sem custo seria lucro inventado');
                    }
                }
                const aprovados = sinais.filter(
                    (s) => s.lucroLiquidoEstimado !== null && s.lucroLiquidoEstimado > 0n,
                );
                console.log(`        DECISÃO: ${aprovados.length} de ${sinais.length}`
                    + ` aprovada(s)${aprovados.length === 0
                        ? ' — recusar deficitária é o resultado certo' : ''}`);
            }

            // 4. O HISTORICO ANTIGO, por AMOSTRAGEM e declarado como tal.
            //
            // Nao declarar impossivel so porque o pool ficou quieto perto do
            // corte: os contratos existem ha ~337 dias. Isto AMOSTRA janelas
            // mais antigas — amostra ACHA, nunca prova ausencia.
            const achadoEm = [];
            for (const atras of AMOSTRAS) {
                for (let k = 0; k < BLOCOS_POR_AMOSTRA; k += 1) {
                    const b = corte - atras - k;
                    if (b <= 0) continue;
                    // eslint-disable-next-line no-await-in-loop
                    const passo = await universoPorAtividade(transporte(b), {
                        blocos: 1, tetoDePools: Number(process.env.RC_TETO ?? 300),
                    });
                    if (passo.metodoIndisponivel) continue;
                    const vistos = passo.concentrados
                        .map((x) => x.endereco.toLowerCase())
                        .filter((x) => op.pools.includes(x));
                    for (const v of vistos) achadoEm.push({ pool: v, bloco: b, atras });
                }
            }
            console.log(`      HISTÓRICO ANTIGO (AMOSTRAGEM de ${AMOSTRAS.length} janelas de`
                + ` ${BLOCOS_POR_AMOSTRA} bloco(s), a ${AMOSTRAS.join(', ')} blocos atrás):`);
            if (achadoEm.length === 0) {
                console.log('        nenhum dos pools-alvo negociou nos blocos AMOSTRADOS.');
                console.log('        DECLARADO: amostragem ACHA, não prova ausência. Que uma'
                    + ' memória mais antiga os conheça fica NÃO COMPROVADO.');
            } else {
                for (const a of achadoEm) {
                    console.log(`        ${a.pool} negociou no bloco ${a.bloco}`
                        + ` (${a.atras} blocos antes do corte) -> memória aquecida o teria`);
                }
            }

            // --- AS AFIRMACOES, por operacao ---
            assert.equal(lidosAcimaDoCorte, 0,
                'nenhuma leitura pode passar do corte — e a assertiva do transporte já barra');
            assert.ok(cobNovo.length >= cobAntigo.length,
                `o método novo não pode cobrir MENOS: ${cobAntigo.length} -> ${cobNovo.length}`);
            assert.ok(sobreNovo.length >= sobreAntigo.length,
                'o método novo não pode achar MENOS rota sobre os pools do vencedor');
            for (const [pool, b] of entrouNoBloco) {
                assert.ok(b <= corte, `${pool} entrou no bloco ${b}, acima do corte ${corte}`);
            }
            console.log(`      tempo total desta operação: ${Date.now() - t0}ms`
                + ` | RPC acumulado ao upstream: ${pedidosUpstream}`);
            rmSync(caminho, { force: true });
        }

        console.log(`\n    RPC ao upstream no total: ${pedidosUpstream} (teto ${TETO_DE_RPC})`);
        assert.ok(pedidosUpstream <= TETO_DE_RPC,
            `orçamento estourado: ${pedidosUpstream} > ${TETO_DE_RPC}`);
        console.log('    DECLARADO: este arquivo mede COLD START. Memória aquecida só valeria se'
            + ' cada registro tivesse origem verificável antes do corte — e é por isso que o'
            + ' bloco de entrada de cada pool é anotado e conferido.');
    });
});
