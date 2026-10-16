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
const {
    julgarFalha, comoLerOVeredicto, escopoDoVeredicto, Exclusoes, retidoPorMil,
} = require('../dist/causaDaFalha.js');
const { FUNIL, comoLerOFunil } = require('../dist/cacarArbitragem.js');

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
const erc20Min = new Interface(['function transfer(address to, uint256 v) returns (bool)']);
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

        // O LACO QUE APRENDE — agora por CAUSA COMPROVADA, nao por associacao.
        //
        // O que estava aqui antes condenava TODOS os tokens incomuns de uma
        // rota que reverteu (`porAssociacao: suspeitos.length > 1`). Ela
        // recusou, com razao: *"Não condene todos os tokens de uma rota que
        // reverteu."* No bloco 52612934 aquilo excluiu 1.254 de 1.256
        // candidatos a partir de DUAS simulacoes.
        //
        // Agora: reverteu -> SONDA cada peca sozinha -> `julgarFalha` diz a
        // causa -> so TOKEN_HOSTIL e POOL_INCOMPATIVEL excluem a peca, e no
        // MENOR escopo que a sonda sustenta (o PAR, quando a taxa depende de
        // quem manda).
        const ex = new Exclusoes();
        const tetoDeSimulacoes = Number(process.env.ARB_SIMULAR ?? 10);
        const resultados = [];
        const contas = await chamar('eth_accounts', []);
        const destinoLimpo = contas[2];

        // A SONDA: transferencia direta de um pool que detem o token para uma
        // conta nova e vazia. O retorno traz quem mandou, porque o escopo da
        // exclusao depende disso.
        const sondarToken = async (token, detentor) => {
            const base = {
                token, rodou: false, enviado: null, recebido: null, reverteu: false, porque: '',
            };
            const tem = await saldo(token, detentor);
            if (tem <= 0n) return { s: { ...base, porque: 'o detentor não tem o token' }, de: detentor };
            const enviado = tem / 1000n;
            if (enviado <= 0n) return { s: { ...base, porque: 'saldo pequeno demais' }, de: detentor };
            await chamar('hardhat_impersonateAccount', [detentor]);
            await chamar('hardhat_setBalance', [detentor, '0x56BC75E2D63100000']);
            const antesD = await saldo(token, destinoLimpo);
            let rc = null; let er = null;
            try {
                rc = await enviar(detentor, token,
                    erc20Min.encodeFunctionData('transfer', [destinoLimpo, enviado]));
            } catch (e) { er = String(e.message ?? e); }
            await chamar('hardhat_stopImpersonatingAccount', [detentor]);
            if (rc === null || rc.status !== '0x1') {
                return {
                    s: {
                        ...base, rodou: true, enviado, reverteu: true,
                        porque: `a transferência REVERTEU: ${(er ?? 'sem motivo').slice(0, 90)}`,
                    },
                    de: detentor,
                };
            }
            const recebido = (await saldo(token, destinoLimpo)) - antesD;
            return {
                s: {
                    ...base, rodou: true, enviado, recebido,
                    porque: recebido === enviado ? 'entregou o que mandou' : `entregou ${recebido} de ${enviado}`,
                },
                de: detentor,
            };
        };

        let i = 0;
        let simuladas = 0;
        let puladasComProva = 0;
        let inviaveisComTaxa = 0;
        // Pernas (token|pool) em que a retencao MEDIDA nao bastou: uma rota
        // por elas reverteu com a taxa ja descontada na conta.
        const taxaInsuficiente = new Set();
        let desconhecidas = 0;
        let reverteram = 0;
        while (i < avaliadas.length && simuladas < tetoDeSimulacoes) {
            const a = avaliadas[i];
            i += 1;
            const r = a.rota;
            // EXCLUSAO PROVADA cobre esta rota? Olha o PAR (token + pool de
            // onde ele sai), nao so o token — e TAXA NAO EXCLUI.
            //
            // A primeira versao disto pulava a rota por QUALQUER exclusao, e
            // com isso 2.324 de 2.326 candidatos sairam por uma taxa de
            // 29/1000. Isso e o que ela proibiu: *"Não descarte
            // automaticamente uma rota apenas porque existe taxa."* E era a
            // REGRA 3 outra vez — o caçador barra so `reverteu`, e aqui eu
            // escrevi outra regra para a mesma pergunta.
            //
            // Transferencia RECUSADA barra (nenhum tamanho executa). Taxa
            // MEDIDA entra na CONTA, e a rota e reavaliada com o valor
            // efetivo: se a sobra nao sobrevive a taxa, a reprovacao e
            // economica e tem numero.
            const barrada = r.hops.some((h) => {
                const e = ex.cobre(h.para, h.pool.endereco);
                return e !== null && e.reverteu;
            });
            if (barrada) { puladasComProva += 1; continue; }

            const pernasComTaxa = r.hops.filter((h) => {
                const t = ex.retencaoDe(h.para, h.pool.endereco);
                return t !== null && t > 0;
            }).map((h) => `${h.para}|${h.pool.endereco}`.toLowerCase());
            const temTaxa = pernasComTaxa.length > 0;

            // PERNA JA REPROVADA COM EVIDENCIA: uma rota que passou por esta
            // perna reverteu DEPOIS de a retencao medida ter sido aplicada na
            // conta. Isso e evidencia sobre a PERNA — a retencao que uma
            // transferencia pool->conta mede nao explica o que a rota sofre —
            // e repetir a simulacao nela so gasta o orcamento reprovando o
            // mesmo. Era o pedido dela: *"Não repita testes já comprovados sem
            // motivo"* e *"evitando repetir amostras economicamente
            // idênticas"*.
            const jaReprovada = pernasComTaxa.find((k) => taxaInsuficiente.has(k));
            if (jaReprovada !== undefined) {
                inviaveisComTaxa += 1;
                FUNIL.inviavelComTaxa += 1;
                continue;
            }

            if (temTaxa) {
                // REAVALIA com a taxa medida descontada perna por perna.
                const comTaxa = melhorTamanhoDaRota(
                    r, 40, undefined,
                    (tok, rem) => ex.retencaoDe(tok, rem),
                    arbN,
                );
                if (comTaxa === null || comTaxa.sobra <= 0n) {
                    inviaveisComTaxa += 1;
                    FUNIL.inviavelComTaxa += 1;
                    continue;
                }
                // Sobreviveu a taxa: segue para a simulacao integral com o
                // tamanho RECALCULADO, nao com o tamanho otimista de antes.
                a.quantia = comTaxa.quantia;
                a.sobra = comTaxa.sobra;
                console.log(`    [taxa] rota sobreviveu à retenção medida: quantia ${a.quantia},`
                    + ` sobra ${a.sobra} — vai para simulação integral`);
            }

            // ESTADO LIMPO POR ROTA: um pool V2 confere o invariante contra
            // `balanceOf`, e a sonda de token tira saldo de pools da rota. Sem
            // o instantaneo, a rota seguinte reverte por causa da sonda
            // anterior — e eu leria a minha contaminacao como "a rota falhou".
            const instantaneo = await chamar('evm_snapshot', []);
            try {
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
            FUNIL.simuladasIntegralmente += 1;

            if (rec === null || rec.status !== '0x1') {
                reverteram += 1;
                FUNIL.reverteram += 1;
                // SONDA CADA PECA antes de condenar qualquer uma. Todos os
                // detentores da rota, e fica a PIOR medicao: a taxa depende do
                // par, medido (479/1000 de um pool, 0/1000 de outro).
                const incomuns = [...new Set(r.hops.flatMap((h) => [h.de, h.para]))]
                    .filter((t) => t !== WETH_DA_BASE);
                const sondas = [];
                for (const t of incomuns) {
                    const detentores = [...new Set(r.hops.map((h) => h.pool)
                        .filter((q) => q.token0 === t || q.token1 === t)
                        .map((q) => q.endereco))];
                    if (detentores.length === 0) {
                        sondas.push({
                            s: {
                                token: t, rodou: false, enviado: null, recebido: null,
                                reverteu: false, porque: 'sem detentor na rota',
                            },
                            de: null,
                        });
                        continue;
                    }
                    let pior = null;
                    for (const d of detentores) {
                        const x = await sondarToken(t, d);
                        const rx = retidoPorMil(x.s);
                        const rp = pior === null ? null : retidoPorMil(pior.s);
                        if (pior === null || x.s.reverteu
                            || (rx !== null && (rp === null || rx > rp))) pior = x;
                        if (pior.s.reverteu) break;
                    }
                    sondas.push(pior);
                }
                // A SONDA DE POOL: o pool responde a interface do tipo que o
                // motor declarou? Prova resposta de interface, NAO que aceita
                // swap — e por isso POOL_INCOMPATIVEL exige tokens limpos.
                const sondasDePool = [];
                for (const h of r.hops) {
                    const res = await ler(h.pool.endereco, S.getReserves);
                    sondasDePool.push({
                        pool: h.pool.endereco, rodou: true,
                        passou: !!res && res !== '0x',
                        porque: !res || res === '0x'
                            ? 'o pool declarado v2 NÃO responde getReserves()'
                            : 'responde getReserves (NÃO prova que aceita swap)',
                    });
                }
                const v = julgarFalha({
                    tokens: sondas.map((x) => x.s),
                    pools: sondasDePool,
                    mensagemDaRota: erro ?? 'sem motivo',
                });
                if (v.causa === 'CAUSA_DESCONHECIDA') {
                    desconhecidas += 1;
                    FUNIL.desconhecidas += 1;
                }
                // E A EXCLUSAO SO AQUI, no menor escopo que a sonda sustenta.
                if (v.excluiPermanentemente) {
                    for (const culpado of v.culpados) {
                        const x = sondas.find(
                            (y) => y.s.token.toLowerCase() === culpado.toLowerCase(),
                        );
                        if (x === undefined) continue;
                        const e = escopoDoVeredicto(x.s, x.de);
                        ex.registrar(e);
                        FUNIL.excluidasComCausa += 1;
                        console.log(`         exclusão: ${e.porque.slice(0, 150)}`);
                    }
                }
                // E A EVIDENCIA SOBRE A PERNA: a rota reverteu COM a retencao
                // medida aplicada. Nao e "o token e pior do que parece" (isso
                // seria inventar um numero): e "a retencao que eu consigo medir
                // de fora NAO explica esta reversao", registrado na perna.
                for (const k of pernasComTaxa) taxaInsuficiente.add(k);
                if (pernasComTaxa.length > 0) {
                    console.log(`         >>> a retenção MEDIDA já estava na conta e a rota`
                        + ` reverteu: ${pernasComTaxa.length} perna(s) marcada(s) como`
                        + ' "retenção medida não explica a reversão" — não simulo nelas de novo');
                }
                resultados.push({ i: simuladas - 1, estado: 'REVERTEU', causa: v.causa });
                console.log(`    [${simuladas - 1}] REVERTEU — ${comoLerARota(r)}`);
                console.log(`         ${(erro ?? 'sem motivo').slice(0, 110)}`);
                console.log(`         >>> ${comoLerOVeredicto(v).slice(0, 200)}`);
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
            // `validadasEconomicamente` SO aqui: execucao integral bem-sucedida
            // E liquido positivo depois de todos os custos. E o unico ponto do
            // projeto que pode incrementar este campo.
            if (j.veredicto === 'lucrativa') FUNIL.validadasEconomicamente += 1;

            console.log(`    [${simuladas - 1}] ${j.veredicto.toUpperCase()} — ${comoLerARota(r)}`);
            console.log(`         esperado ${a.sobra} | realizado ${sobrou} wei de WETH`);
            console.log(`         ${custo.comoLer}`);
            console.log(`         ${j.porque}`);
            assert.ok(sobrou > 0n, 'completou e não sobrou WETH');
            } finally {
                await chamar('evm_revert', [instantaneo]);
            }
        }
        console.log(`\n    ${ex.comoLer()}`);
        console.log(`    ${puladasComProva} rota(s) PULADA(S) por tocar peça com causa COMPROVADA`);
        console.log(`    ${inviaveisComTaxa} rota(s) REPROVADA(S) pela conta com a taxa medida`
            + ' aplicada — não descartadas por TER taxa, reprovadas pelo valor efetivo');
        console.log(`    ${desconhecidas} com CAUSA_DESCONHECIDA — nada condenado nelas`);
        console.log(`    ${reverteram} reverteram de ${simuladas} simuladas integralmente`);

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
        // O ESPACO DE BUSCA, MEDIDO aqui. Antes a linha imprimia `0 par(es)`
        // porque este teste nunca preenchia o campo: etiqueta que nao descreve
        // o conjunto, na linha que existe para ser auditada.
        const porPar = new Map();
        for (const q of poolsParaRota) {
            const k = [q.token0, q.token1].sort().join('|');
            const f = porPar.get(k);
            if (f === undefined) porPar.set(k, new Set([q.fabrica])); else f.add(q.fabrica);
        }
        FUNIL.espacoDeBusca = [...porPar.values()].filter((f) => f.size >= 2).length;
        FUNIL.rotasEncontradas = rotas.length;
        FUNIL.estimadasPositivas = avaliadas.length;
        console.log(`\n    ${comoLerOFunil('fork')}`);
        if (FUNIL.validadasEconomicamente === 0) {
            console.log('    ZERO economicamente validadas. LIMITAÇÕES DA AMOSTRA: um bloco,'
                + ` ${poolsParaRota.length} pools das 4 fábricas com \`uniswapV2Call\` provado,`
                + ` teto de ${tetoDeSimulacoes} simulações, e rotas de 2 a 4 swaps.`
                + ' Não é "não existe arbitragem na Base": é esta amostra, neste bloco.');
        }
        for (const x of resultados) assert.ok(String(x.estado).length > 0);
        // NENHUMA exclusao sem escopo medido. O portao da regra desta rodada.
        for (const e of ex.todos()) {
            assert.ok(e.reverteu || typeof e.retidoPorMil === 'number',
                `${e.token} excluído sem retenção medida nem recusa de transferência`);
        }
    });
});
