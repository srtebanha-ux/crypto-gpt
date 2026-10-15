// O CACADOR MISTO EM MODO OBSERVACAO — descobre, TRIA, cota, dimensiona, simula.
//
// Isto e a integracao, nao um modulo ao lado: a descoberta e a TRIAGEM sao
// `candidatasMistas` e `triarCandidatas` de `src/rotasMistas.ts`, o MESMO
// arquivo que o cacador ao vivo usa, e a execucao e o `CacadorV3` que a prova
// de atomicidade ja validou.
//
// ELA CORRIGIU QUATRO COISAS MINHAS, e as quatro estao aqui:
//
//   1. *"Não alegue que é obrigatório gastar ETH para cotar."* Certo: o
//      `cotar` roda em fork com implantacao EFEMERA, e nenhum ETH e gasto.
//   2. *"Não apresente como exata uma taxa calculada sobre bytes fictícios."*
//      Certo: o L1 vem de `getL1FeeUpperBound(tamanho real)`, declarado TETO.
//   3. *"250 BLOCOS OBSERVADOS NÃO SÃO 250 ESTADOS AVALIADOS."* Certo, e era o
//      pior dos quatro: o `hardhat_reset` acontecia UMA vez, no fim da janela,
//      e as rotas eram cotadas todas naquele unico estado. Agora os dois
//      numeros existem separados e sao MEDIDOS separados: a janela de
//      DESCOBERTA e uma coisa, e `estadosAvaliados` — cada um com o seu
//      `hardhat_reset` — e outra.
//   4. *"Não chame tempo total de varredura de latência sinal→decisão."*
//      Certo: a latencia agora e POR OPORTUNIDADE, com o instante do sinal, o
//      da leitura do estado, o tempo de pre-filtro, de cotacao, de simulacao, a
//      IDADE DO DADO na decisao e o total — e o tempo de varredura e publicado
//      com o nome dele, que e tempo de varredura.
//
// SEM INFORMACAO FUTURA, por construcao: a janela de descoberta TERMINA antes
// do primeiro estado avaliado. Nenhum pool entra no universo de um estado por
// ter negociado depois dele.
//
// AS CINCO ORIGENS ficam separadas no funil. Esta corrida preenche apenas
// `detectadaEmObservacao` e `validadaEmFork`: nao ha deslocamento artificial
// aqui, e `realizadaNaRede` e ZERO por construcao — `CACA_ENVIAR=0` e nada foi
// transmitido.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const {
    candidatasMistas, pernasDaCandidata, funilVazio, comoLerOFunilMisto, limitacaoDominante,
    triarCandidatas,
} = require('../dist/rotasMistas.js');
const {
    codificarTetoDeL1, ORACULO_DE_GAS_L1, somarCusto, julgar,
} = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const WETH = '0x4200000000000000000000000000000000000006';
const TOP_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const TOP_AERO = id('Swap(address,address,uint256,uint256,uint256,uint256)');
const SELETOR_SWAP_V3 = sel('swap(address,bool,int256,uint160,bytes)');
// NAO EXISTE MAIS EPSILON. Ela comprovou que `getAmountOut(epsilon)/epsilon`
// nao e razao maxima — a razao cai com o tamanho e fica sempre abaixo da
// marginal — e que o mesmo inteiro cru valia coisas diferentes em tokens de
// decimais diferentes. O teto agora sai das RESERVAS, demonstrado do invariante.
// Ainda ha uma chamada de `getAmountOut` na IDENTIFICACAO do pool: ali ela so
// responde "este contrato tem a interface do Aerodrome", e nao decide economia.
const SONDA_DE_INTERFACE = 10n ** 12n;

const S = {
    balanceOf: sel('balanceOf(address)'),
    token0: sel('token0()'),
    token1: sel('token1()'),
    fee: sel('fee()'),
    getAmountOut: sel('getAmountOut(uint256,address)'),
    slot0: sel('slot0()'),
    getReserves: sel('getReserves()'),
    estavel: sel('stable()'),
};
const iface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia, uint256 lucroMinimo) returns (uint256)',
    'function cotar((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia)',
    'error LucroInsuficiente(uint256 obtido, uint256 piso)',
    'error PagamentoCurto(uint256 tem, uint256 devido)',
    'error NadaEntrou()',
    'error PagamentoNaoDeclarado(uint8 indice)',
    'error PernaNaoEncaixa(uint8 indice, address esperado, address veio)',
    'error PoolSemEsteToken(address pool, address token)',
    'error TipoDePernaDesconhecido(uint8 tipo)',
    'error TransferenciaFalhou(address token)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);
const ler = async (to, data) => {
    try { return await chamar('eth_call', [{ to, data }, 'latest']); } catch { return null; }
};
const num = (h) => (h && h !== '0x' ? BigInt(h) : null);
const endDe = (h) => (h && h.length >= 42 ? `0x${h.slice(-40)}`.toLowerCase() : null);
const saldo = async (t, de) => num(await ler(
    t, S.balanceOf + coder.encode(['address'], [de]).slice(2),
)) ?? 0n;

let undiciFetch = null;
let agente;
async function upstream(metodo, params) {
    if (undiciFetch === null) {
        const u = await import('undici');
        undiciFetch = u.fetch;
        agente = process.env.HTTPS_PROXY ? new u.ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    }
    const url = hre.config.networks.hardhat.forking.url;
    for (let t = 0; t < 5; t += 1) {
        try {
            const r = await undiciFetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: metodo, params }),
                ...(agente ? { dispatcher: agente } : {}),
            });
            const j = await r.json();
            if (j.error) throw new Error(j.error.message ?? 'erro');
            return j.result;
        } catch (e) {
            if (t === 4) throw e;
            await new Promise((s) => { setTimeout(s, 500 * 2 ** t); });
        }
    }
    return null;
}

const agora = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms
const med = (a) => (a.length === 0 ? null
    : a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]);

describe('o caçador misto em observação', function () {
    this.timeout(7_200_000);

    it('descobre, tria e avalia ESTADOS DISTINTOS — com funil e latência por oportunidade', async function () {
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const f = funilVazio();
        // LATENCIA POR OPORTUNIDADE. `varredura` NAO e latencia e vive separada.
        const T = {
            leituraDoEstado: [], prefiltro: [], cotacao: [], simulacao: [],
            totalPorOportunidade: [], idadeDoDadoMs: [], varredura: [],
        };

        // ===== 1. DESCOBERTA: pools que NEGOCIARAM, em N blocos consecutivos.
        //
        // A janela TERMINA antes do primeiro estado avaliado: nenhum pool entra
        // por ter negociado depois do estado em que e avaliado.
        const QUANTOS = Number(process.env.MISTA_BLOCOS ?? 250);
        const ESTADOS = Number(process.env.MISTA_ESTADOS ?? 5);
        // `MISTA_TOPO` fixa a janela para REAVALIAR os mesmos estados de uma
        // corrida anterior. Sem ela, a janela e o topo da corrente.
        const topo = process.env.MISTA_TOPO
            ? Number(process.env.MISTA_TOPO)
            : Number(await upstream('eth_blockNumber', []));
        const fimDaDescoberta = topo - ESTADOS;
        const inicio = fimDaDescoberta - QUANTOS + 1;
        const vistos = new Map();
        let lidos = 0; let falhos = 0;
        const tVarre = agora();
        for (let b = inicio; b <= fimDaDescoberta; b += 1) {
            // eslint-disable-next-line no-await-in-loop
            let recs = null;
            try {
                // eslint-disable-next-line no-await-in-loop
                recs = await upstream('eth_getBlockReceipts', [`0x${b.toString(16)}`]);
            } catch { falhos += 1; continue; }
            if (recs === null) { falhos += 1; continue; }
            lidos += 1;
            for (const r of recs) {
                for (const l of r.logs ?? []) {
                    const t0 = (l.topics[0] ?? '').toLowerCase();
                    const venue = t0 === TOP_V3 ? 'v3' : (t0 === TOP_AERO ? 'aerodrome' : null);
                    if (venue === null) continue;
                    const k = l.address.toLowerCase();
                    const e = vistos.get(k);
                    if (e === undefined) vistos.set(k, { venue, n: 1 });
                    else e.n += 1;
                }
            }
        }
        T.varredura.push(agora() - tVarre);
        f.blocosVarridosParaDescoberta = lidos;
        console.log(`    DESCOBERTA: blocos ${inicio}..${fimDaDescoberta} | lidos ${lidos},`
            + ` falhos ${falhos} | ${vistos.size} pool(s) com Swap`);
        console.log(`    ESTADOS A AVALIAR: ${fimDaDescoberta + 1}..${topo} (${ESTADOS}),`
            + ' todos DEPOIS da janela de descoberta — sem informação futura');
        assert.ok(lidos >= 250 || QUANTOS < 250,
            `a amostra pedida era de 250 blocos e só ${lidos} foram lidos`);

        // ===== 2. OS POOLS, com ABI CONFIRMADA pelo proprio pool.
        //
        // O fork vai para o PRIMEIRO estado: a identificacao e feita uma vez, e
        // ela e sobre o CODIGO do pool, que nao muda de bloco para bloco.
        const primeiro = fimDaDescoberta + 1;
        await chamar('hardhat_reset', [{ forking: { jsonRpcUrl: url, blockNumber: primeiro } }]);
        const pools = [];
        const teto = Number(process.env.MISTA_POOLS ?? 220);
        for (const [endereco, v] of [...vistos.entries()]
            .sort((a, b) => b[1].n - a[1].n).slice(0, teto)) {
            // eslint-disable-next-line no-await-in-loop
            const [t0, t1] = await Promise.all([ler(endereco, S.token0), ler(endereco, S.token1)]);
            const a = endDe(t0); const b2 = endDe(t1);
            if (a === null || b2 === null) continue;
            if (v.venue === 'v3') {
                // IDENTIFICACAO POSITIVA: o pool V3 recusa `amountSpecified = 0`
                // com a razao DELE, 'AS'. Substring de bytecode nao prova — foi
                // medido, e deixou 264 cotações inúteis passarem.
                let tem = false;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await chamar('eth_call', [{
                        to: endereco,
                        data: SELETOR_SWAP_V3 + coder.encode(
                            ['address', 'bool', 'int256', 'uint160', 'bytes'],
                            ['0x0000000000000000000000000000000000000001', true, 0, 4295128740n, '0x'],
                        ).slice(2),
                    }, 'latest']);
                } catch (e) {
                    tem = String(e.message ?? e).includes("'AS'");
                }
                if (!tem) continue;
                // eslint-disable-next-line no-await-in-loop
                const fee = num(await ler(endereco, S.fee));
                pools.push({ endereco, token0: a, token1: b2, venue: 'v3', taxa: fee === null ? null : Number(fee) });
            } else {
                // Aerodrome: `getAmountOut` responde? O pool e proxy de 45
                // bytes, entao a chamada e a unica identificacao possivel.
                // eslint-disable-next-line no-await-in-loop
                const q = await ler(endereco, S.getAmountOut
                    + coder.encode(['uint256', 'address'], [SONDA_DE_INTERFACE, a]).slice(2));
                if (q === null || q === '0x') continue;
                // `stable()`: so `false` autoriza o descarte pelo filtro.
                // Ausencia fica `null`, e `null` manda cotar.
                // eslint-disable-next-line no-await-in-loop
                const est = num(await ler(endereco, S.estavel));
                pools.push({
                    endereco, token0: a, token1: b2, venue: 'aerodrome', taxa: null,
                    estavel: est === null ? null : est !== 0n,
                });
            }
        }
        f.poolsVistos = {
            v3: pools.filter((q) => q.venue === 'v3').length,
            aerodrome: pools.filter((q) => q.venue === 'aerodrome').length,
        };
        console.log(`    POOLS com ABI confirmada: ${f.poolsVistos.v3} V3,`
            + ` ${f.poolsVistos.aerodrome} Aerodrome`);

        // ===== 3. ROTAS DISTINTAS — e isto NAO e a contagem de pools.
        const candidatas = candidatasMistas(pools, WETH);
        f.rotasDistintas = candidatas.length;
        console.log(`    ROTAS DISTINTAS (par + direção): ${candidatas.length}`);
        if (candidatas.length === 0) {
            f.limitacaoDeCobertura += 1;
            console.log(`\n    ${comoLerOFunilMisto(f)}`);
            console.log('    Zero ROTAS com pools observados não é contradição: rota mista exige'
                + ' um pool Aerodrome E um pool V3 compartilhando o MESMO token com o WETH.');
            return;
        }

        // ===== 4. O INTERVALO ENTRE BLOCOS, medido na PROPRIA corrente.
        //
        // E ele que diz quando um sinal EXPIROU: passado um intervalo, o estado
        // que foi lido ja nao e o estado da corrente. O numero nao e meu — sai
        // dos timestamps dos blocos da janela.
        const tsPrimeiro = Number((await upstream(
            'eth_getBlockByNumber', [`0x${primeiro.toString(16)}`, false],
        )).timestamp);
        const tsTopo = Number((await upstream(
            'eth_getBlockByNumber', [`0x${topo.toString(16)}`, false],
        )).timestamp);
        const intervaloMs = ESTADOS > 1
            ? ((tsTopo - tsPrimeiro) * 1000) / (topo - primeiro)
            : null;
        console.log(`    INTERVALO ENTRE BLOCOS, medido nos timestamps: ${intervaloMs === null
            ? 'não dá para medir com 1 estado' : `${intervaloMs.toFixed(0)}ms`}`);

        const cotarNo = async (arb, dono, c, quantia, pagamento) => {
            const pernas = pernasDaCandidata(c, WETH, pagamento);
            const t0 = agora();
            try {
                await chamar('eth_call', [{
                    from: dono, to: arb, gas: '0xB71B00',
                    data: iface.encodeFunctionData('cotar', [pernas, quantia]),
                }, 'latest']);
                T.cotacao.push(agora() - t0);
                return { ok: false, causa: 'nao reverteu' };
            } catch (e) {
                T.cotacao.push(agora() - t0);
                const m = String(e.message ?? e);
                const dado = (e && (e.data || (e.error && e.error.data))) || null;
                if (dado) {
                    try {
                        const d = iface.parseError(String(dado));
                        if (d && d.name === 'LucroInsuficiente') {
                            return { ok: true, bruto: BigInt(d.args[0]) };
                        }
                        if (d) return { ok: false, causa: d.name };
                    } catch { /* erro de protocolo */ }
                    return { ok: false, causa: `protocolo ${String(dado).slice(0, 10)}` };
                }
                return { ok: false, causa: m.slice(0, 40) };
            }
        };

        // ===== 5. OS ESTADOS DISTINTOS, um `hardhat_reset` por estado.
        let melhor = null;
        let evitadas = 0;
        let auditadas = 0;
        // As cotacoes da AUDITORIA medem o mesmo caminho e entram nos TEMPOS,
        // mas nunca nos contadores do funil: elas sao cotacao de rota que o
        // filtro recusou, e soma-las a `cotacoesTentadas` faria o funil afirmar
        // que uma rota descartada foi avaliada economicamente.
        let expiradasNaAuditoria = 0;
        const auditarPorEstado = Number(process.env.MISTA_AUDITAR ?? 6);
        const limitePorEstado = Number(process.env.MISTA_COTAR ?? 60);
        for (let b = primeiro; b <= topo; b += 1) {
            // Cada estado e um bloco DIFERENTE da corrente. Isto e o que
            // faltava: antes era um `reset` so, e tudo era cotado no mesmo
            // estado — "250 blocos observados" que eram UM estado avaliado.
            if (b > primeiro) {
                // eslint-disable-next-line no-await-in-loop
                await chamar('hardhat_reset', [{ forking: { jsonRpcUrl: url, blockNumber: b } }]);
            }
            // O SINAL: o instante em que este estado passa a estar disponivel
            // para nos. Tudo que vem depois e atraso nosso.
            const tSinal = agora();
            // eslint-disable-next-line no-await-in-loop
            const contas = await chamar('eth_accounts', []);
            const [dono, cofre] = contas;
            // eslint-disable-next-line no-await-in-loop
            const art = await hre.artifacts.readArtifact('CacadorV3');
            // eslint-disable-next-line no-await-in-loop
            const dep = await chamar('eth_sendTransaction', [{
                from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
                gas: '0xB71B00',
            }]);
            // eslint-disable-next-line no-await-in-loop
            const arb = (await chamar('eth_getTransactionReceipt', [dep])).contractAddress;
            // eslint-disable-next-line no-await-in-loop
            const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
            const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');

            // A LEITURA DO ESTADO: `slot0` dos V3 e `getAmountOut(epsilon)` dos
            // Aerodrome. E a mesma informacao que `lerEstadoMisto` le ao vivo.
            const tLeitura0 = agora();
            const sqrtPorPoolV3 = new Map();
            const reservasAerodrome = new Map();
            const v3s = [...new Set(candidatas.map((c) => c.poolV3))];
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(v3s.map(async (pool) => {
                const r = await ler(pool, S.slot0);
                sqrtPorPoolV3.set(pool, (r && r.length >= 66) ? BigInt(`0x${r.slice(2, 66)}`) : null);
            }));
            const aeros = [...new Set(candidatas.map((c) => c.poolAerodrome))];
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(aeros.map(async (pool) => {
                const r = await ler(pool, S.getReserves);
                // `getReserves()` devolve tres palavras; as duas primeiras sao
                // as reservas CRUAS. Menos que isso e ausencia, nao zero.
                reservasAerodrome.set(pool, (r && r.length >= 130)
                    ? { r0: BigInt(`0x${r.slice(2, 66)}`), r1: BigInt(`0x${r.slice(66, 130)}`) }
                    : null);
            }));
            const tLeitura = agora();
            T.leituraDoEstado.push(tLeitura - tLeitura0);

            // O PRE-FILTRO: a MESMA funcao do cacador ao vivo.
            const tPre0 = agora();
            const tri = triarCandidatas(candidatas, WETH, {
                sqrtPorPoolV3, token0PorPool: new Map(), reservasAerodrome, bloco: b,
            });
            T.prefiltro.push(agora() - tPre0);
            f.estadosAvaliados += 1;
            f.rotasTriadas += tri.valem.length;
            f.faltaDeSpread += tri.recusadasPorSpread.length;
            f.faltaDeDados += tri.semDados;

            console.log(`    ESTADO ${b}: ${tri.valem.length} passaram o filtro,`
                + ` ${tri.recusadasPorSpread.length} DESCARTADAS com prova,`
                + ` ${tri.semDados} sem dado | leitura ${(tLeitura - tLeitura0).toFixed(1)}ms,`
                + ` filtro ${(agora() - tPre0).toFixed(1)}ms`);
            evitadas += tri.recusadasPorSpread.length;

            // A INVARIANTE DELA, exercitada em estado REAL: *"um filtro de
            // rejeição nunca pode rejeitar uma rota que o executor comprovou
            // lucrativa naquele mesmo estado."* Uma amostra das RECUSADAS e
            // cotada de qualquer jeito, e nenhuma pode devolver sobra bruta.
            // A AUDITORIA DE UM TAMANHO SO NAO PROVA NADA SOBRE OS OUTROS, e
            // ela cortou isso por nome: *"Não use o resultado das nove
            // auditorias em um único tamanho como prova para todos os
            // tamanhos."* Cada recusada e cotada em VARIOS tamanhos — e sao os
            // mesmos tamanhos que a cotacao de verdade usa.
            for (const c of tri.recusadasPorSpread.slice(0, auditarPorEstado)) {
                const poolBase = c.direcao === 'A' ? c.poolAerodrome : c.poolV3;
                // eslint-disable-next-line no-await-in-loop
                const wethNoPool = await saldo(WETH, poolBase);
                if (wethNoPool === 0n) continue;
                for (const fr of [10_000n, 1000n, 200n, 50n, 10n]) {
                    const q = wethNoPool / fr;
                    if (q === 0n) continue;
                    auditadas += 1;
                    const tAud = agora();
                    // eslint-disable-next-line no-await-in-loop
                    const r = await cotarNo(arb, dono, c, q, q);
                    const idadeAud = agora() - tLeitura;
                    T.idadeDoDadoMs.push(idadeAud);
                    T.totalPorOportunidade.push(agora() - tAud);
                    if (intervaloMs !== null && idadeAud > intervaloMs) expiradasNaAuditoria += 1;
                    assert.ok(!(r.ok && r.bruto > 0n),
                        `INVARIANTE VIOLADA no estado ${b}: o filtro recusou ${c.chave} e o `
                        + `executor devolveu sobra bruta ${r.bruto} no tamanho ${q}, no MESMO `
                        + 'estado');
                }
            }

            // ===== 6. COTACAO das que passaram, com o tamanho por fracao da
            // liquidez do pool que empresta — nao de numero meu.
            let tentadasNesteEstado = 0;
            for (const c of tri.valem) {
                if (tentadasNesteEstado >= limitePorEstado) break;
                const tOp0 = agora();
                const poolBase = c.direcao === 'A' ? c.poolAerodrome : c.poolV3;
                // eslint-disable-next-line no-await-in-loop
                const wethNoPool = await saldo(WETH, poolBase);
                if (wethNoPool === 0n) continue;
                for (const fr of [1000n, 200n, 50n, 10n]) {
                    if (tentadasNesteEstado >= limitePorEstado) break;
                    const q = wethNoPool / fr;
                    if (q === 0n) continue;
                    f.cotacoesTentadas += 1;
                    tentadasNesteEstado += 1;
                    // eslint-disable-next-line no-await-in-loop
                    const r = await cotarNo(arb, dono, c, q, q);
                    // A IDADE DO DADO NA DECISAO, e o EXPIRADO que sai dela.
                    const idade = agora() - tLeitura;
                    T.idadeDoDadoMs.push(idade);
                    if (intervaloMs !== null && idade > intervaloMs) {
                        // EXPIRADO, nao prejuizo e nao falta de spread: passou
                        // um intervalo de bloco desde a leitura, entao esta
                        // decisao e sobre um estado que a corrente ja superou.
                        f.expirado += 1;
                    }
                    if (!r.ok) {
                        f.porCausa[r.causa] = (f.porCausa[r.causa] ?? 0) + 1;
                        continue;
                    }
                    if (r.bruto <= 0n) continue;
                    f.cotacoesComSobra += 1;
                    if (melhor === null || r.bruto > melhor.bruto) {
                        melhor = {
                            c, quantia: q, pagamento: q, bruto: r.bruto, bloco: b, arb, dono, cofre, baseFeeWei,
                        };
                    }
                }
                T.totalPorOportunidade.push(agora() - tOp0);
            }
            // O instante do sinal existe para ser comparado com a decisao: este
            // e o atraso do estado INTEIRO, do sinal ao fim da avaliacao dele.
            console.log(`      sinal -> fim da avaliação deste estado: ${(agora() - tSinal).toFixed(1)}ms`);
        }

        console.log(`    COTACOES: ${f.cotacoesTentadas} tentadas, ${f.cotacoesComSobra}`
            + ` com sobra bruta | ${evitadas} DESCARTADAS pelo pré-filtro`
            + ` | ${auditadas} recusadas AUDITADAS contra a invariante`);
        console.log('    INVARIANTE DELA, exercitada em estado REAL: nenhuma das'
            + ` ${auditadas} cotações de rotas RECUSADAS devolveu sobra bruta no MESMO estado,`
            + ' e cada rota foi cotada em CINCO tamanhos (1/10.000 a 1/10 da liquidez do pool'
            + ' que empresta). O teste falharia no `assert` se alguma devolvesse.');

        // ===== 7. SIMULACAO ATOMICA COMPLETA. So ela classifica EXECUTAVEL.
        //
        // Ela roda no ESTADO em que a sobra foi medida: voltar o fork para la e
        // o que torna a simulacao uma afirmacao sobre aquele estado, e nao sobre
        // o estado em que a varredura acabou.
        if (melhor !== null) {
            f.detectadaEmObservacao += 1;
            await chamar('hardhat_reset', [{
                forking: { jsonRpcUrl: url, blockNumber: melhor.bloco },
            }]);
            const contas = await chamar('eth_accounts', []);
            const [dono, cofre] = contas;
            const art = await hre.artifacts.readArtifact('CacadorV3');
            const dep = await chamar('eth_sendTransaction', [{
                from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
                gas: '0xB71B00',
            }]);
            const arb = (await chamar('eth_getTransactionReceipt', [dep])).contractAddress;
            const antesArb = await saldo(WETH, arb);
            const antesTok = await saldo(melhor.c.token, arb);
            const antesCofre = await saldo(WETH, cofre);
            const pernas = pernasDaCandidata(melhor.c, WETH, melhor.pagamento);
            const dados = iface.encodeFunctionData('executarRota',
                [pernas, melhor.quantia, 1n]);
            const t0 = agora();
            let rec = null; let erro = null;
            try {
                const tx = await chamar('eth_sendTransaction', [{
                    from: dono, to: arb, data: dados, gas: '0xB71B00',
                }]);
                rec = await chamar('eth_getTransactionReceipt', [tx]);
            } catch (e) { erro = String(e.message ?? e); }
            T.simulacao.push(agora() - t0);

            if (rec === null || rec.status !== '0x1') {
                f.simulacoesRevertidas += 1;
                f.falhaDeExecucao += 1;
                const chave = `simulacao revertida: ${String(erro).slice(0, 40)}`;
                f.porCausa[chave] = (f.porCausa[chave] ?? 0) + 1;
                console.log(`    SIMULACAO REVERTEU: ${String(erro).slice(0, 140)}`);
            } else {
                f.simulacoesCompletas += 1;
                const bruto = (await saldo(WETH, cofre)) - antesCofre;
                const gasUsado = BigInt(rec.gasUsed);
                // O L1 por TETO sobre o tamanho REAL do calldata — nunca sobre
                // bytes inventados.
                const bytesReais = (dados.length - 2) / 2;
                const l1 = num(await ler(ORACULO_DE_GAS_L1, codificarTetoDeL1(bytesReais)));
                const custo = somarCusto({
                    gasUsado, gasUsadoVeioDe: 'recibo', baseFeeWei: melhor.baseFeeWei,
                    gorjetaWei: 20_000_000n, custoL1Wei: l1, taxaDoEmprestimoWei: 0n,
                });
                const j = julgar(bruto, custo);
                const depoisArb = await saldo(WETH, arb);
                const depoisTok = await saldo(melhor.c.token, arb);
                console.log('\n    SIMULACAO ATOMICA COMPLETA — recibo status=1');
                console.log(`      no ESTADO do bloco ${melhor.bloco}, o mesmo em que a sobra foi medida`);
                console.log(`      rota ${melhor.c.direcao}: Aerodrome ${melhor.c.poolAerodrome}`
                    + ` | V3 ${melhor.c.poolV3} | token ${melhor.c.token}`);
                console.log(`      executor WETH ${antesArb}->${depoisArb}`
                    + ` | token ${antesTok}->${depoisTok}`);
                console.log(`      bruto ao cofre ${bruto} | gás ${gasUsado}`);
                console.log(`      ${custo.comoLer}`);
                console.log(`      L1 por TETO (getL1FeeUpperBound sobre ${bytesReais}`
                    + ' bytes REAIS de calldata + 160 de envelope)');
                console.log(`      VEREDICTO: ${j.veredicto.toUpperCase()}`);
                if (j.veredicto === 'lucrativa') {
                    f.validadaEmFork += 1;
                    f.melhorLiquidoWei = j.liquidoWei;
                }
                assert.equal(depoisArb, antesArb, 'o executor retiveve WETH');
                assert.equal(depoisTok, antesTok, 'o executor retiveve o token');
            }
        }

        // ===== 8. O FUNIL, as cinco razoes e a LATENCIA POR OPORTUNIDADE.
        console.log(`\n    ${comoLerOFunilMisto(f)}`);
        console.log('\n    LATÊNCIA POR OPORTUNIDADE (ms, mediana) — não é tempo de varredura:');
        console.log(`      leitura do estado .... ${med(T.leituraDoEstado)?.toFixed(1) ?? 'sem amostra'}`);
        console.log(`      pré-filtro (um estado) ${med(T.prefiltro)?.toFixed(1) ?? 'sem amostra'}`);
        console.log(`      cotação (uma) ........ ${med(T.cotacao)?.toFixed(1) ?? 'sem amostra'}`);
        console.log(`      simulação atômica .... ${med(T.simulacao)?.toFixed(1) ?? 'sem amostra'}`);
        console.log(`      TOTAL por oportunidade ${med(T.totalPorOportunidade)?.toFixed(1) ?? 'sem amostra'}`);
        console.log(`      IDADE do dado na decisão ${med(T.idadeDoDadoMs)?.toFixed(1) ?? 'sem amostra'}`
            + ` (intervalo de bloco medido: ${intervaloMs === null ? 'n/d' : `${intervaloMs.toFixed(0)}ms`})`);
        console.log(`      ${f.expirado} de ${f.cotacoesTentadas} cotações decidiram sobre estado`
            + ' JÁ SUPERADO pela corrente — contadas como EXPIRADO, nunca como prejuízo');
        console.log(`      ${expiradasNaAuditoria} de ${auditadas} cotações da AUDITORIA também`
            + ' passaram do intervalo de bloco. Elas medem o MESMO caminho e entram nos tempos,'
            + ' mas não nos contadores do funil: cotação de rota descartada não é avaliação'
            + ' econômica dela');
        console.log(`\n    TEMPO DE VARREDURA (não é latência): ${med(T.varredura)?.toFixed(0) ?? 'n/d'}ms`
            + ` para ${f.blocosVarridosParaDescoberta} bloco(s) de DESCOBERTA`);
        console.log('      DECLARADO: estes tempos são de fork LOCAL. Não medem latência de'
            + ' rede nem inclusão no bloco, e não autorizam conclusão sobre competitividade.');
        console.log(`\n    ${limitacaoDominante(f)}`);
        console.log('    LUCRO REALIZADO NA REDE: 0 — `CACA_ENVIAR=0`, nenhuma transação'
            + ' transmitida. As cinco origens estão separadas de propósito.');

        // OS PORTOES: nada aqui pode virar "oportunidade" sem simulacao.
        assert.equal(f.realizadaNaRede, 0, 'nada foi transmitido: este campo tem de ser zero');
        assert.ok(f.validadaEmFork <= f.simulacoesCompletas,
            'validada em fork não pode passar das simulações que completaram');
        assert.equal(f.deslocamentoArtificial, 0,
            'esta corrida não cria deslocamento: o campo tem de ser zero');
        assert.ok(f.estadosAvaliados >= 1,
            'sem estado avaliado não há conclusão econômica: blocos varridos não são estados');
    });
});
