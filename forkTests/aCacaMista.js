// O CACADOR MISTO EM MODO OBSERVACAO — descobre, cota, dimensiona, simula.
//
// Isto e a integracao, nao um modulo ao lado: a descoberta e `candidatasMistas`
// de `src/rotasMistas.ts`, o MESMO arquivo que o cacador ao vivo usa, e a
// execucao e o `CacadorV3` que a prova de atomicidade ja validou.
//
// ELA CORRIGIU DUAS COISAS MINHAS, e as duas estao aqui:
//
//   1. *"Não alegue que é obrigatório gastar ETH para cotar."* Certo: o
//      `cotar` roda em fork com implantacao EFEMERA, e nenhum ETH e gasto. A
//      desculpa de "precisa de quoter implantado" era falsa.
//   2. *"Não apresente como exata uma taxa calculada sobre bytes fictícios."*
//      Certo: `'02'.repeat(N)` nao mede nada, porque o custo L1 depende do
//      CONTEUDO. Agora o L1 vem de `getL1FeeUpperBound(tamanho real)`, que e
//      TETO declarado em vez de exatidao fabricada.
//
// AS CINCO ORIGENS ficam separadas no funil. Esta corrida preenche apenas
// `detectadaEmObservacao` e `validadaEmFork`: nao ha deslocamento artificial
// aqui, e `realizadaNaRede` e ZERO por construcao — `CACA_ENVIAR=0` e nada foi
// transmitido.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const {
    candidatasMistas, pernasDaCandidata, funilVazio, comoLerOFunilMisto, limitacaoDominante,
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

const S = {
    balanceOf: sel('balanceOf(address)'),
    token0: sel('token0()'),
    token1: sel('token1()'),
    fee: sel('fee()'),
    getAmountOut: sel('getAmountOut(uint256,address)'),
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

describe('o caçador misto em observação', function () {
    this.timeout(7_200_000);

    it('descobre, cota, dimensiona e simula — com funil econômico', async function () {
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const f = funilVazio();
        const tempos = { sinalAteDecisao: [], cotacao: [], simulacao: [] };

        // ===== 1. OBSERVACAO: pools que NEGOCIARAM, em N blocos consecutivos.
        //
        // Sem informacao futura por construcao: a janela termina no bloco em
        // que a avaliacao vai rodar, e nada depois dele e lido.
        const QUANTOS = Number(process.env.MISTA_BLOCOS ?? 250);
        const topo = Number(await upstream('eth_blockNumber', []));
        const inicio = topo - QUANTOS + 1;
        const vistos = new Map();
        let lidos = 0; let falhos = 0;
        for (let b = inicio; b <= topo; b += 1) {
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
        f.blocosObservados = lidos;
        console.log(`    OBSERVACAO: blocos ${inicio}..${topo} | lidos ${lidos},`
            + ` falhos ${falhos} | ${vistos.size} pool(s) com Swap`);
        assert.ok(lidos >= 250 || QUANTOS < 250,
            `a amostra pedida era de 250 blocos e só ${lidos} foram lidos`);

        // ===== 2. O FORK no topo da janela, e a implantacao EFEMERA.
        await chamar('hardhat_reset', [{ forking: { jsonRpcUrl: url, blockNumber: topo } }]);
        const contas = await chamar('eth_accounts', []);
        const [dono, cofre] = contas;
        const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
        const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
        const art = await hre.artifacts.readArtifact('CacadorV3');
        const dep = await chamar('eth_sendTransaction', [{
            from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
            gas: '0xB71B00',
        }]);
        const arb = (await chamar('eth_getTransactionReceipt', [dep])).contractAddress;
        console.log(`    FORK no bloco ${topo} | CacadorV3 EFÊMERO em ${arb} (zero ETH gasto)`);

        // ===== 3. OS POOLS, com ABI CONFIRMADA pelo proprio pool.
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
                    + coder.encode(['uint256', 'address'], [10n ** 12n, a]).slice(2));
                if (q === null || q === '0x') continue;
                pools.push({ endereco, token0: a, token1: b2, venue: 'aerodrome', taxa: null });
            }
        }
        f.poolsVistos = {
            v3: pools.filter((q) => q.venue === 'v3').length,
            aerodrome: pools.filter((q) => q.venue === 'aerodrome').length,
        };
        console.log(`    POOLS com ABI confirmada: ${f.poolsVistos.v3} V3,`
            + ` ${f.poolsVistos.aerodrome} Aerodrome`);

        // ===== 4. ROTAS DISTINTAS — e isto NAO e a contagem de pools.
        const candidatas = candidatasMistas(pools, WETH);
        f.rotasDistintas = candidatas.length;
        console.log(`    ROTAS DISTINTAS (par + direção): ${candidatas.length}`);
        if (candidatas.length === 0) {
            console.log(`\n    ${comoLerOFunilMisto(f)}`);
            console.log('    Zero ROTAS com pools observados não é contradição: rota mista exige'
                + ' um pool Aerodrome E um pool V3 compartilhando o MESMO token com o WETH.');
            return;
        }

        // ===== 5. COTACAO pelo PROPRIO pool, e o tamanho por bisseccao.
        const cotar = async (c, quantia, pagamento) => {
            const pernas = pernasDaCandidata(c, WETH, pagamento);
            const t0 = agora();
            try {
                await chamar('eth_call', [{
                    from: dono, to: arb, gas: '0xB71B00',
                    data: iface.encodeFunctionData('cotar', [pernas, quantia]),
                }, 'latest']);
                tempos.cotacao.push(agora() - t0);
                return { ok: false, causa: 'nao reverteu' };
            } catch (e) {
                tempos.cotacao.push(agora() - t0);
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

        const tSinal = agora();
        let melhor = null;
        const limite = Number(process.env.MISTA_COTAR ?? 400);
        for (const c of candidatas) {
            if (f.cotacoesTentadas >= limite) break;
            // O TAMANHO sai da liquidez do pool que empresta, nao de numero meu.
            const poolBase = c.direcao === 'A' ? c.poolAerodrome : c.poolV3;
            // eslint-disable-next-line no-await-in-loop
            const wethNoPool = await saldo(WETH, poolBase);
            if (wethNoPool === 0n) continue;
            for (const fr of [1000n, 200n, 50n, 10n]) {
                if (f.cotacoesTentadas >= limite) break;
                const q = wethNoPool / fr;
                if (q === 0n) continue;
                f.cotacoesTentadas += 1;
                // eslint-disable-next-line no-await-in-loop
                const r = await cotar(c, q, q);
                if (!r.ok) {
                    f.porCausa[r.causa] = (f.porCausa[r.causa] ?? 0) + 1;
                    continue;
                }
                if (r.bruto <= 0n) continue;
                f.cotacoesComSobra += 1;
                if (melhor === null || r.bruto > melhor.bruto) {
                    melhor = { c, quantia: q, pagamento: q, bruto: r.bruto };
                }
            }
        }
        tempos.sinalAteDecisao.push(agora() - tSinal);
        console.log(`    COTACOES: ${f.cotacoesTentadas} tentadas, ${f.cotacoesComSobra}`
            + ' com sobra bruta');

        // ===== 6. SIMULACAO ATOMICA COMPLETA. So ela classifica EXECUTAVEL.
        if (melhor !== null) {
            f.detectadaEmObservacao += 1;
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
            tempos.simulacao.push(agora() - t0);

            if (rec === null || rec.status !== '0x1') {
                f.simulacoesRevertidas += 1;
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
                    gasUsado, gasUsadoVeioDe: 'recibo', baseFeeWei,
                    gorjetaWei: 20_000_000n, custoL1Wei: l1, taxaDoEmprestimoWei: 0n,
                });
                const j = julgar(bruto, custo);
                const depoisArb = await saldo(WETH, arb);
                const depoisTok = await saldo(melhor.c.token, arb);
                console.log('\n    SIMULACAO ATOMICA COMPLETA — recibo status=1');
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

        // ===== 7. O FUNIL, e as cinco origens separadas.
        const med = (a) => (a.length === 0 ? null
            : a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]);
        console.log(`\n    ${comoLerOFunilMisto(f)}`);
        console.log('\n    LATENCIA (ms, mediana):');
        console.log(`      sinal -> decisão ... ${med(tempos.sinalAteDecisao)?.toFixed(1) ?? 'sem amostra'}`
            + ` (inclui ${f.cotacoesTentadas} cotações)`);
        console.log(`      cotação (uma) ...... ${med(tempos.cotacao)?.toFixed(1) ?? 'sem amostra'}`);
        console.log(`      simulação atômica .. ${med(tempos.simulacao)?.toFixed(1) ?? 'sem amostra'}`);
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
    });
});
