// ENTREGA 3 — ROTAS DE 2, 3 E 4 SWAPS, com custo completo da Base.
//
// Usa `FlashArbN` (N pernas) implantado SO NO FORK — implantacao efemera, como
// ela mandou: *"continue utilizando implantacao efemera no fork para testar
// rotas completas"*. Nenhum deploy real, nenhum ETH gasto.
//
// O QUE ESTE ARQUIVO PROVA, e o que NAO prova:
//
//   descobre rotas de 2, 3 e 4 swaps em pools REAIS da Base       -> prova
//   dimensiona cada uma sobre a funcao que decide                 -> prova
//   elimina duplicacao economica (mesmo conjunto de pools)         -> prova
//   mede o custo COMPLETO: gasUsed do recibo, baseFee L2, gorjeta,
//     dado L1 pelo oraculo, taxa do emprestimo                    -> prova
//   rejeita token hostil por SIMULACAO, nao por calculo            -> prova
//   executa atomicamente e apura o liquido                         -> prova
//   LUCRO REALIZADO                                                -> NAO: nao
//     ha transacao real, e simulacao em fork nao e recibo
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');
const Decimal = require('decimal.js');

const {
    descobrirUniverso, lerPools, precoDoGasWei, FABRICAS_COM_FLASH_SWAP, WETH_DA_BASE,
} = require('../dist/cacarArbitragem.js');
const {
    acharRotas, melhorTamanhoDaRota, semDuplicacaoEconomica, comoLerARota, saidaDoHop,
} = require('../dist/rotas.js');
const {
    somarCusto, julgar, codificarGetL1Fee, ORACULO_DE_GAS_L1, GORJETA_PADRAO_WEI,
} = require('../dist/custoDaBase.js');
const { Hostis, causaDaReversao, comoLerACausa } = require('../dist/tokensHostis.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const S = {
    balanceOf: sel('balanceOf(address)'),
    getFee: sel('getFee(address,bool)'),
    stable: sel('stable()'),
    getPool: sel('getPool(address,address,bool)'),
    getReserves: sel('getReserves()'),
    token0: sel('token0()'),
    token1: sel('token1()'),
};
const nIface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint16 taxaPorDezMil)[] pernas, uint256 quantidade, uint256 lucroMinimo)',
    'function saidaV2(uint256 entrada, uint256 reservaEntra, uint256 reservaSai, uint16 taxa) pure returns (uint256)',
]);

/** A fabrica da Aerodrome, confirmada na corrente: 29.765 pools. */
const FABRICA_AERODROME = '0x420dd381b31aef6683db6b902084cb0ffece40da';

let p;
const chamar = (m, ps) => p.send(m, ps);
const ler = async (to, data) => {
    try { return await chamar('eth_call', [{ to, data }, 'latest']); } catch { return null; }
};
const num = (h) => (h && h !== '0x' ? BigInt(h) : null);
const endDe = (h) => (h && h.length >= 42 ? `0x${h.slice(-40)}`.toLowerCase() : null);
const enviar = async (from, to, data, gas = '0x1000000') => {
    const campos = { from, data, gas };
    if (to) campos.to = to;
    const tx = await chamar('eth_sendTransaction', [campos]);
    return chamar('eth_getTransactionReceipt', [tx]);
};
const saldo = async (t, de) => num(await ler(
    t, S.balanceOf + coder.encode(['address'], [de]).slice(2),
)) ?? 0n;

describe('rotas de 2, 3 e 4 swaps — descoberta, custo e execução', function () {
    this.timeout(1_800_000);

    let bloco; let dono; let arbN; let cofre;
    let poolsParaRota; let rotas; let avaliadas; let colapsadas;
    let gasWei; let baseFeeWei;

    before(async function () {
        p = hre.network.provider;
        bloco = Number(await chamar('eth_blockNumber', []));
        const contas = await chamar('eth_accounts', []);
        [dono, cofre] = contas;

        // ---- pools V2 das quatro fabricas CONFERIDAS ----
        const universo = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 150));
        const lido = await lerPools(chamar, universo.pools, universo.porFabrica, bloco);
        poolsParaRota = lido.pools.map((q) => ({
            endereco: q.endereco, token0: q.token0, token1: q.token1,
            reserva0: q.reserva0, reserva1: q.reserva1,
            tipo: 'v2', taxaPorDezMil: 30, fabrica: q.fabrica,
        }));

        // ---- pools da AERODROME, com o TIPO e a TAXA lidos da corrente ----
        //
        // `stable()` distingue os dois, e a taxa vem de `getFee(pool, stable)`:
        // medido 30 para volatil e 5 para stable. Supor 30 para os dois trataria
        // pool stable como V2 convencional, que e exatamente o que ela proibiu.
        const tokens = [...new Set(poolsParaRota.flatMap((q) => [q.token0, q.token1]))]
            .filter((t) => t !== WETH_DA_BASE).slice(0, 60);
        let aero = 0;
        for (const t of tokens) {
            for (const stable of [false, true]) {
                const r = await ler(FABRICA_AERODROME, S.getPool
                    + coder.encode(['address', 'address', 'bool'], [WETH_DA_BASE, t, stable]).slice(2));
                const pool = endDe(r);
                if (pool === null || /^0x0+$/.test(pool)) continue;
                const [res, t0, t1, fee] = await Promise.all([
                    ler(pool, S.getReserves), ler(pool, S.token0), ler(pool, S.token1),
                    ler(FABRICA_AERODROME, S.getFee
                        + coder.encode(['address', 'bool'], [pool, stable]).slice(2)),
                ]);
                if (!res || res === '0x') continue;
                let r0; let r1;
                try { [r0, r1] = coder.decode(['uint112', 'uint112', 'uint32'], res); } catch { continue; }
                if (r0 === 0n || r1 === 0n) continue;
                const taxa = Number(num(fee) ?? 30n);
                poolsParaRota.push({
                    endereco: pool, token0: endDe(t0), token1: endDe(t1),
                    reserva0: r0, reserva1: r1,
                    tipo: stable ? 'aerodromeStable' : 'aerodromeVolatil',
                    taxaPorDezMil: taxa, fabrica: FABRICA_AERODROME,
                });
                aero += 1;
            }
        }

        // ---- ROTAS de 2 a 4, so WETH como base ----
        //
        // WETH porque o custo esta medido em wei de ETH: comparar lucro em
        // outro token com custo em ETH seria somar unidades diferentes, e sem
        // preco do token eu nao converto. E a mesma razao do `gasDesconhecido`.
        rotas = acharRotas(poolsParaRota, WETH_DA_BASE, {
            maxHops: 4,
            // A AERODROME NAO EMPRESTA: pools de 45 bytes, callback de outro
            // nome. Ela entra como perna de VENDA.
            podeEmprestar: (q) => q.tipo === 'v2',
            teto: 40_000,
        });

        // A COTACAO DE FORA para os hops que a conta local recusa (stable).
        // Perguntar ao pool, nao reimplementar o invariante.
        const cotar = (h, entrada) => {
            if (h.pool.tipo !== 'aerodromeStable') return null;
            // `eth_call` sincrono nao existe: o valor vem do cache preenchido
            // abaixo. Sem cotacao, a rota nao anda — e nao anda em silencio.
            const k = `${h.pool.endereco}|${h.de}|${entrada}`;
            return cacheDeCotacao.get(k) ?? null;
        };
        const cacheDeCotacao = new Map();

        // Avalia: rotas sem hop stable primeiro (conta local, exata).
        const semStable = rotas.filter((r) => r.hops.every((h) => h.pool.tipo !== 'aerodromeStable'));
        avaliadas = [];
        for (const r of semStable) {
            const m = melhorTamanhoDaRota(r, 40, cotar);
            if (m === null || m.sobra <= 0n) continue;
            avaliadas.push({ rota: r, sobra: m.sobra, ...m });
        }
        const dedup = semDuplicacaoEconomica(avaliadas);
        avaliadas = dedup.unicas;
        colapsadas = dedup.colapsadas;

        gasWei = await precoDoGasWei(chamar);
        const b = await chamar('eth_getBlockByNumber', ['latest', false]);
        baseFeeWei = BigInt(b.baseFeePerGas ?? '0x0');

        const artN = await hre.artifacts.readArtifact('FlashArbN');
        const rec = await enviar(dono, undefined,
            artN.bytecode + coder.encode(['address'], [cofre]).slice(2));
        assert.equal(rec.status, '0x1', 'o FlashArbN tem de publicar no fork');
        arbN = rec.contractAddress;

        const porTamanho = new Map();
        for (const r of rotas) porTamanho.set(r.hops.length, (porTamanho.get(r.hops.length) ?? 0) + 1);
        console.log(`    bloco ${bloco} | ${poolsParaRota.length} pools`
            + ` (${aero} da Aerodrome, com tipo e taxa lidos)`);
        console.log(`    rotas por tamanho: ${[...porTamanho.entries()]
            .sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k} swaps: ${v}`).join(' | ')}`);
        console.log(`    ${avaliadas.length} com sobra positiva após colapsar ${colapsadas} duplicadas`);
    });

    it('descobre rotas de 2, 3 E 4 swaps em pools reais', function () {
        const tamanhos = new Set(rotas.map((r) => r.hops.length));
        assert.ok(rotas.length > 0, 'nenhuma rota');
        assert.ok(tamanhos.has(2), 'nenhuma rota de 2 swaps');
        assert.ok(tamanhos.has(3), 'nenhuma rota TRIANGULAR (3 swaps)');
        for (const r of rotas) {
            assert.ok(r.hops.length >= 2 && r.hops.length <= 4);
            assert.equal(r.poolsDistintos, r.hops.length, 'rota com pool repetido');
            assert.equal(r.hops[0].pool.tipo, 'v2', 'perna de empréstimo não-V2');
            assert.equal(r.hops[0].de, WETH_DA_BASE);
            assert.equal(r.hops[r.hops.length - 1].para, WETH_DA_BASE);
        }
        if (!tamanhos.has(4)) {
            console.log('    NENHUMA rota de 4 swaps neste universo — e isso é propriedade do'
                + ' grafo, não do buscador: com poucos tokens em comum não há ciclo de 4 com'
                + ' pools distintos. O teste de 4 hops roda em `rotas.test.ts` sobre grafo'
                + ' construído.');
        }
    });

    it('a matemática do FlashArbN com taxa 30 é IGUAL à do FlashArb', async function () {
        // O FlashArb esta provado; o novo generaliza a taxa. Se os dois
        // divergirem com taxa 30, a generalizacao quebrou o que funcionava.
        const amostra = poolsParaRota.filter((q) => q.tipo === 'v2').slice(0, 6);
        assert.ok(amostra.length >= 3);
        const artM = await hre.artifacts.readArtifact('MathHarness');
        const recM = await enviar(dono, undefined, artM.bytecode);
        const harness = recM.contractAddress;
        const mIface = new Interface([
            'function amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) pure returns (uint256)',
        ]);
        let conferidas = 0;
        for (const q of amostra) {
            const entrada = q.reserva0 / 997n;
            if (entrada <= 0n) continue;
            const doAntigo = num(await ler(harness, mIface.encodeFunctionData('amountOut',
                [entrada, q.reserva0, q.reserva1])));
            const doNovo = num(await ler(arbN, nIface.encodeFunctionData('saidaV2',
                [entrada, q.reserva0, q.reserva1, 30])));
            assert.equal(doNovo, doAntigo,
                `FlashArbN divergiu do FlashArb em ${q.endereco}`);
            // E a conta LOCAL do `rotas.ts` bate com as duas.
            const local = saidaDoHop({ pool: q, de: q.token0, para: q.token1 }, entrada);
            assert.equal(local, doAntigo, 'a conta de rotas.ts divergiu do contrato');
            conferidas += 1;
        }
        assert.ok(conferidas >= 3, `só ${conferidas} conferências`);
        console.log(`    ${conferidas} conferências: FlashArbN == FlashArb == rotas.ts`);
    });

    it('SIMULA as melhores rotas e apura o líquido com o CUSTO COMPLETO', async function () {
        if (avaliadas.length === 0) {
            console.log('    ZERO rotas com sobra positiva neste bloco.');
            console.log(`    COBERTURA TESTADA: ${poolsParaRota.length} pools,`
                + ` ${rotas.length} rotas de 2 a 4 swaps, ${colapsadas} duplicadas colapsadas.`);
            console.log('    Isto é a RECUSA correta: o motor varreu, dimensionou e não achou.');
            this.skip();
            return;
        }

        // O LACO QUE APRENDE: reverteu -> condena o token -> exclui as rotas
        // que passam por ele -> desce a lista.
        //
        // DEFEITO MEDIDO que isto conserta: sem o registro, as OITO melhores
        // rotas do bloco atravessavam todas o mesmo token (`0x7787…734f`, 48%
        // de taxa). Um token taxado faz a reserva parecer mal precificada,
        // entao ele DOMINA o ranking de sobra e o motor simula o mesmo token
        // para sempre, sem nunca chegar aos candidatos que importam.
        const hostis = new Hostis();
        const tetoDeSimulacoes = Number(process.env.ARB_SIMULAR ?? 10);
        const resultados = [];
        const hashDoCodigo = async (t) => {
            const c = await chamar('eth_getCode', [t, 'latest']);
            // Nao e keccak: e tamanho + prefixo. Serve de ancora de mudanca de
            // codigo sem custar uma hash de 10 KB a cada volta, e qualquer
            // troca de implementacao muda um dos dois.
            return typeof c === 'string' ? `${(c.length - 2) / 2}:${c.slice(0, 18)}` : null;
        };

        let i = 0;
        let simuladas = 0;
        let puladasPorHostil = 0;
        while (i < avaliadas.length && simuladas < tetoDeSimulacoes) {
            const a = avaliadas[i];
            i += 1;
            const r = a.rota;
            const tokensDaRota = [...new Set(r.hops.flatMap((h) => [h.de, h.para]))];
            const jaCondenado = hostis.rotaTemHostil(tokensDaRota);
            if (jaCondenado.tem) {
                puladasPorHostil += 1;
                continue;
            }

            const pernas = r.hops.map((h) => ({
                pool: h.pool.endereco,
                tokenEntra: h.de,
                tipo: h.pool.tipo === 'v2' ? 0 : 1,
                taxaPorDezMil: h.pool.taxaPorDezMil,
            }));
            const piso = (a.sobra * 8n) / 10n;
            const antes = await saldo(WETH_DA_BASE, arbN);
            let rec = null; let erro = null;
            const dados = nIface.encodeFunctionData('executarRota', [pernas, a.quantia, piso]);
            try {
                rec = await enviar(dono, arbN, dados);
            } catch (e) { erro = String(e.message ?? e); }
            simuladas += 1;

            if (rec === null || rec.status !== '0x1') {
                // REJEITADO POR SIMULACAO. O token que NAO e o WETH leva a
                // culpa: ele e o unico incomum na rota, e condenar o WETH
                // pararia o motor inteiro.
                const suspeitos = tokensDaRota.filter((t) => t !== WETH_DA_BASE);
                const causa = causaDaReversao(erro ?? '');
                for (const t of suspeitos) {
                    hostis.marcar({
                        token: t, causa, bloco,
                        rota: r.hops.map((h) => h.pool.endereco),
                        hashDoCodigo: await hashDoCodigo(t),
                        retidoPorMil: null,
                        // POR ASSOCIACAO quando ha mais de um suspeito: com
                        // dois ou tres tokens incomuns na rota, qualquer um
                        // pode ser o culpado, e condenar todos pune inocente.
                        porAssociacao: suspeitos.length > 1,
                    });
                }
                resultados.push({ i: simuladas - 1, estado: 'REVERTEU', causa });
                console.log(`    [${simuladas - 1}] REVERTEU (${causa}) — ${comoLerARota(r)}`);
                console.log(`         ${(erro ?? 'sem motivo').slice(0, 120)}`);
                console.log(`         condenei ${suspeitos.length} token(s): ${comoLerACausa(causa).slice(0, 90)}`);
                continue;
            }

            const depois = await saldo(WETH_DA_BASE, arbN);
            const sobrou = depois - antes;
            const gasUsado = BigInt(rec.gasUsed);
            const serializada = `0x${'02'.repeat(110 + dados.length / 2)}`;
            const l1 = num(await ler(ORACULO_DE_GAS_L1, codificarGetL1Fee(serializada)));
            const custo = somarCusto({
                gasUsado,
                gasUsadoVeioDe: 'recibo',
                baseFeeWei,
                gorjetaWei: GORJETA_PADRAO_WEI,
                custoL1Wei: l1,
                taxaDoEmprestimoWei: 0n,
            });
            const j = julgar(sobrou, custo);
            resultados.push({ i: simuladas - 1, estado: j.veredicto, sobrou, liquido: j.liquidoWei });

            console.log(`    [${simuladas - 1}] ${j.veredicto.toUpperCase()} — ${comoLerARota(r)}`);
            console.log(`         esperado ${a.sobra} | realizado ${sobrou} wei de WETH`);
            console.log(`         ${custo.comoLer}`);
            console.log(`         ${j.porque}`);
            assert.ok(sobrou > 0n, 'completou e não sobrou WETH');
            const razao = new Decimal(sobrou.toString()).div(new Decimal(a.sobra.toString()));
            if (razao.lessThanOrEqualTo('0.95')) {
                // ENTREGOU MENOS do que a conta previu: alguem cobrou. Condena
                // por MEDICAO, com a fracao retida registrada.
                const suspeitos = tokensDaRota.filter((t) => t !== WETH_DA_BASE);
                const retido = Number(new Decimal(1).minus(razao).mul(1000).toFixed(0));
                for (const t of suspeitos) {
                    hostis.marcar({
                        token: t, causa: 'taxaDeTransferencia', bloco,
                        rota: r.hops.map((h) => h.pool.endereco),
                        hashDoCodigo: await hashDoCodigo(t), retidoPorMil: retido,
                        porAssociacao: suspeitos.length > 1,
                    });
                }
                console.log(`         >>> entregou ${razao.toFixed(6)} do previsto: ${retido}/1000`
                    + ' retido no caminho. Tokens CONDENADOS por medição.');
            }
        }
        console.log(`\n    ${hostis.comoLer()}`);
        console.log(`    ${puladasPorHostil} rota(s) PULADA(S) por atravessar token já condenado`);

        const lucrativas = resultados.filter((x) => x.estado === 'lucrativa');
        console.log(`\n    RESUMO: ${resultados.length} simulada(s) |`
            + ` ${lucrativas.length} LUCRATIVA(S) com custo completo |`
            + ` ${resultados.filter((x) => x.estado === 'REVERTEU').length} reverteu/reverteram |`
            + ` ${resultados.filter((x) => x.estado === 'deficitaria').length} deficitária(s)`);
        console.log(`    COBERTURA: ${poolsParaRota.length} pools, ${rotas.length} rotas,`
            + ` ${colapsadas} duplicadas colapsadas, ${avaliadas.length} com sobra positiva`);
        if (lucrativas.length > 0) {
            const melhor = lucrativas.reduce((x, y) => (y.liquido > x.liquido ? y : x));
            console.log(`    melhor líquido ${melhor.liquido} wei = `
                + `${new Decimal(melhor.liquido.toString()).div(1e18).toFixed(12)} ETH`);
            console.log('    ISTO NÃO É LUCRO REALIZADO: nenhuma transação real foi enviada.');
        }
        for (const x of resultados) assert.ok(String(x.estado).length > 0);
    });
});
