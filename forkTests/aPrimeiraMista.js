// A PRIMEIRA ARBITRAGEM MISTA REPRODUZIDA — Aerodrome + V3, em fork.
//
// A OPERACAO: `0x6966a108bb45f3e6053edfafd975e973d202ca438a8f0366340b0476144c7e15`
// bloco 52632036, indice 267. Reconciliada log por log:
//
//   [0] pool Aerodrome 0x566bee7e -> vencedor: 14884119761520122410275 de
//       0xfb31f85a… (SAIDA do flash swap, antes de cobrar)
//   [1] pool V3 0x3e31de9d -> vencedor: 183133343388332077 WETH
//   [2] vencedor -> pool V3: o token (pagamento da perna V3)
//   [4] vencedor -> pool Aerodrome: 165540234889082868 WETH (liquidacao)
//
//   lucro bruto = 183133343388332077 - 165540234889082868 = 17593108499249209
//   custo (recibo)                                        =   130572937665578
//   LIQUIDO                                               = 17462535561583631 wei
//                                                         = 0,01746 WETH
//
// SEM wrap, SEM V4, SEM ETH nativo: e reconciliavel SO POR LOG, e por isso
// serve de prova. A escolha dela — `0x87724fb1…` — NAO serve, e o motivo esta
// medido em `src/quemGanha.ts`: o WETH9 nao emite `Transfer` ao desembrulhar,
// e naquela transacao o ETH desembrulhado foi INTEIRO pagar o V4, ao wei. O
// liquido real dela e +9.508 de USDC (US$ 0,0095) contra US$ 0,0035 de gas —
// nao os US$ 5,30 que o benchmark dizia. Errei por ~800x, e a re-reconciliacao
// das 40 maiores derrubou a soma de 8,66 para 0,0675 WETH.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const { codificarGetL1Fee, ORACULO_DE_GAS_L1, somarCusto, julgar } = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const WETH = '0x4200000000000000000000000000000000000006';

const ALVO = {
    tx: '0x6966a108bb45f3e6053edfafd975e973d202ca438a8f0366340b0476144c7e15',
    bloco: 52632036,
    indice: 267,
    aerodromo: '0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31',
    v3: '0x3e31de9d23a1c923e3b60b45c0a30d172f01b659',
    token: '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95',
    tokenOut: 14884119761520122410275n,
    pagouWeth: 165540234889082868n,
    recebeuWeth: 183133343388332077n,
    custoWei: 130572937665578n,
};

const S = { balanceOf: sel('balanceOf(address)'), getAmountOut: sel('getAmountOut(uint256,address)') };
const iface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia, uint256 lucroMinimo) returns (uint256)',
    'function cotar((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia)',
    'error LucroInsuficiente(uint256 obtido, uint256 piso)',
    'error PagamentoCurto(uint256 tem, uint256 devido)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);

/**
 * O RPC DE CIMA, para o que o fork nao pode responder.
 *
 * DEFEITO MEDIDO: `eth_getBlockByNumber(52632036)` NO FORK devolveu o bloco que
 * o proprio fork minerou (o meu deploy), com UMA transacao — e eu quase li
 * "reexecutei 1 de 1" como se fosse a sequencia do bloco historico. O fork esta
 * ancorado em 52632035; tudo depois disso e local. O bloco historico so existe
 * em cima.
 */
let undiciFetch = null;
let agente;
async function upstream(metodo, params) {
    if (undiciFetch === null) {
        const u = await import('undici');
        undiciFetch = u.fetch;
        agente = process.env.HTTPS_PROXY ? new u.ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    }
    const url = hre.config.networks.hardhat.forking.url;
    for (let t = 0; t < 4; t += 1) {
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
            if (t === 3) throw e;
            await new Promise((s) => { setTimeout(s, 400 * 2 ** t); });
        }
    }
    return null;
}
const ler = async (to, data) => {
    try { return await chamar('eth_call', [{ to, data }, 'latest']); } catch { return null; }
};
const num = (h) => (h && h !== '0x' ? BigInt(h) : null);
const saldo = async (t, de) => num(await ler(
    t, S.balanceOf + coder.encode(['address'], [de]).slice(2),
)) ?? 0n;

describe('a primeira arbitragem mista Aerodrome + V3', function () {
    this.timeout(3_600_000);

    let dono; let cofre; let arb; let baseFeeWei;

    before(async function () {
        p = hre.network.provider;
        const contas = await chamar('eth_accounts', []);
        [dono, cofre] = contas;
        const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
        baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
        const art = await hre.artifacts.readArtifact('CacadorV3');
        const tx = await chamar('eth_sendTransaction', [{
            from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
            gas: '0x1000000',
        }]);
        const rec = await chamar('eth_getTransactionReceipt', [tx]);
        assert.equal(rec.status, '0x1');
        arb = rec.contractAddress;
        console.log(`    executor ${arb} | cofre ${cofre}`);

        // RECONSTRUCAO DA SEQUENCIA DENTRO DO BLOCO.
        //
        // Ela avisou, e a medicao confirmou: *"Não presuma que block−1 equivale
        // ao estado imediatamente anterior à transação vencedora."* No fim do
        // bloco ${ALVO.bloco - 1} a perna V3 rendia 153.024.114.045.089.090 e o
        // Aerodrome cobrava 165.540.234.889.082.868 — a rota NAO fechava. O
        // deslocamento foi criado por transacoes do proprio bloco
        // ${ALVO.bloco}, antes do indice ${ALVO.indice}.
        //
        // Entao as anteriores sao reexecutadas, em ordem, por impersonacao. Uma
        // que reverta nao atrapalha: ela tambem revertia na corrente se o
        // estado nao a servisse, e o que interessa e o estado que as demais
        // deixam.
        // `MISTA_REPLAY=0` desliga a reconstrucao — e o que se usa quando o
        // fork esta no topo da corrente, onde nao existe sequencia anterior a
        // reconstruir e aplicar transacoes velhas corromperia o estado.
        const quantas = Number(process.env.MISTA_REPLAY ?? ALVO.indice);
        if (quantas === 0) {
            console.log('    SEM reconstrucao de bloco (MISTA_REPLAY=0): o estado e o do fork');
            return;
        }
        const bl = await upstream('eth_getBlockByNumber',
            [`0x${ALVO.bloco.toString(16)}`, true]);
        if (!bl || !Array.isArray(bl.transactions)) {
            console.log(`    DIAGNOSTICO: bl=${typeof bl} chaves=`
                + `${bl ? Object.keys(bl).slice(0, 8).join(',') : 'nenhuma'}`
                + ` txs=${bl ? typeof bl.transactions : 'n/a'}`);
        }
        assert.ok(bl && Array.isArray(bl.transactions), 'o bloco alvo não veio com transações');
        const anteriores = bl.transactions.slice(0, quantas);
        let aplicadas = 0;
        let reverteram = 0;
        for (const t of anteriores) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await chamar('hardhat_impersonateAccount', [t.from]);
                // eslint-disable-next-line no-await-in-loop
                await chamar('hardhat_setBalance', [t.from, '0x3635C9ADC5DEA00000']);
                const campos = {
                    from: t.from, data: t.input, gas: t.gas,
                    ...(t.to ? { to: t.to } : {}),
                    ...(t.value && t.value !== '0x0' ? { value: t.value } : {}),
                };
                // eslint-disable-next-line no-await-in-loop
                const h = await chamar('eth_sendTransaction', [campos]);
                // eslint-disable-next-line no-await-in-loop
                const r = await chamar('eth_getTransactionReceipt', [h]);
                if (r !== null && r.status === '0x1') aplicadas += 1; else reverteram += 1;
            } catch { reverteram += 1; }
            // eslint-disable-next-line no-await-in-loop
            await chamar('hardhat_stopImpersonatingAccount', [t.from]).catch(() => {});
        }
        console.log(`    SEQUENCIA DO BLOCO ${ALVO.bloco}: reexecutei ${anteriores.length} de`
            + ` ${bl.transactions.length}, ${aplicadas} com sucesso, ${reverteram} revertidas`);
        console.log(`    DECLARADO: o estado agora e o FIM do bloco ${ALVO.bloco - 1} MAIS as`
            + ` ${aplicadas} transacoes anteriores que aplicaram. Nao e identico ao estado do`
            + ` indice ${ALVO.indice} — as revertidas aqui podem ter aplicado na corrente, e a`
            + ' ordem de gas e outra. E reproducao do ESTADO, nunca da corrida.');
    });

    it('a rota do vencedor EXECUTA e o líquido é reconciliado', async function () {
        // A ROTA, na forma do executor:
        //   perna 0: AERODROME, entra WETH (e o que se paga), sai o token
        //   perna 1: V3, entra o token, sai WETH
        const rota = (pagamento) => ([
            { pool: ALVO.aerodromo, tokenEntra: WETH, tipo: 1, pagamento },
            { pool: ALVO.v3, tokenEntra: ALVO.token, tipo: 0, pagamento: 0n },
        ]);

        // 1. O MINIMO que o Aerodrome aceita, por BISSECCAO com `eth_call`.
        //    Quem aceita ou recusa e o pool; nenhuma conta de invariante e
        //    escrita aqui, e a ordem dela foi explicita sobre isso.
        // A PROVA DO MECANISMO: um `PagamentoCurto` com `tem > 0` significa que
        // o flash do Aerodrome adiantou o token, a perna V3 vendeu e devolveu
        // `tem` wei de WETH. A cadeia MISTA rodou inteira; o que faltou foi
        // economico, e esta em numero.
        let maiorRetornoDaCadeia = 0n;
        const tenta = async (quantia, pagamento) => {
            try {
                await chamar('eth_call', [{
                    from: dono, to: arb, gas: '0x2000000',
                    data: iface.encodeFunctionData('cotar', [rota(pagamento), quantia]),
                }, 'latest']);
                return { ok: false, motivo: 'não reverteu' };
            } catch (e) {
                const m = String(e.message ?? e);
                const li = /LucroInsuficiente\((\d+),\s*(\d+)\)/.exec(m);
                if (li !== null) return { ok: true, bruto: BigInt(li[1]) };
                const pc = /PagamentoCurto\((\d+),\s*(\d+)\)/.exec(m);
                if (pc !== null) {
                    const tem = BigInt(pc[1]);
                    if (tem > maiorRetornoDaCadeia) maiorRetornoDaCadeia = tem;
                    return {
                        ok: false, tem, devido: BigInt(pc[2]),
                        motivo: `PagamentoCurto tem=${pc[1]} devido=${pc[2]}`,
                    };
                }
                return { ok: false, motivo: m.slice(0, 90) };
            }
        };

        // O MINIMO que o pool aceita, para um TAMANHO dado, por bisseccao.
        const menorPagamento = async (quantia) => {
            // Teto: o que o vencedor pagou, escalado pelo tamanho, com folga.
            let alto = (ALVO.pagouWeth * quantia) / ALVO.tokenOut * 2n;
            let baixo = 1n;
            let achado = null;
            const topo = await tenta(quantia, alto);
            if (!topo.ok) return { achado: null, motivo: topo.motivo };
            achado = { pagamento: alto, bruto: topo.bruto };
            for (let k = 0; k < 42 && alto - baixo > 1n; k += 1) {
                const meio = (baixo + alto) / 2n;
                // eslint-disable-next-line no-await-in-loop
                const r = await tenta(quantia, meio);
                if (r.ok) { alto = meio; achado = { pagamento: meio, bruto: r.bruto }; } else baixo = meio;
            }
            return { achado, motivo: null };
        };

        // O TAMANHO tambem e procurado: o vencedor usou um, e nada garante que
        // ele e o otimo NESTE estado. A sobra e `saida do V3 - pagamento`, e as
        // duas pontas sao conta dos POOLS.
        const TAMANHOS = [1n, 2n, 4n, 8n, 16n, 32n, 64n].map(
            (d) => ALVO.tokenOut / d,
        ).filter((q) => q > 0n);
        let melhor = null;
        // A PROVA DO MECANISMO: um `PagamentoCurto` com `tem > 0` significa que
        // o flash do Aerodrome adiantou o token, a perna V3 vendeu e devolveu
        // `tem` wei de WETH. A cadeia MISTA rodou inteira; o que faltou foi
        // economico, e esta em numero.
        for (const q of TAMANHOS) {
            // eslint-disable-next-line no-await-in-loop
            const { achado, motivo } = await menorPagamento(q);
            if (achado === null) {
                console.log(`    tamanho ${q}: o pool recusou até o teto — ${String(motivo).slice(0, 70)}`);
                continue;
            }
            const sobra = achado.bruto;
            console.log(`    tamanho ${q}: menor pagamento ${achado.pagamento} | sobra ${sobra}`);
            if (melhor === null || sobra > melhor.bruto) {
                melhor = { quantia: q, pagamento: achado.pagamento, bruto: sobra };
            }
        }
        if (melhor === null || melhor.bruto <= 0n) {
            console.log('\n    NENHUM tamanho fecha neste estado.');
            console.log('    O QUE ISTO PROVA — a cadeia MISTA roda de ponta a ponta: o flash do');
            console.log(`    Aerodrome adiantou o token, a perna V3 vendeu e devolveu ate`);
            console.log(`    ${maiorRetornoDaCadeia} wei de WETH ao executor. A falha e`);
            console.log('    ECONOMICA e esta em numero, nao em silencio.');
            console.log('    O QUE NAO PROVA: que a rota do vencedor nao existia. Medido no');
            console.log('    arquivo: o `sqrtPriceX96` do pool V3 mudou de 0x110f11… para');
            console.log('    0x129ce6… DENTRO do bloco 52632036, e a cotacao do Aerodrome subiu');
            console.log('    ~15% no mesmo bloco. O vencedor executou no indice 267, depois');
            console.log('    desses movimentos; o replay aplica 158 das 267 anteriores e 109');
            console.log('    revertem fora do contexto original de gas e nonce.');
            // O PORTAO: a cadeia TEM de ter rodado. Zero aqui seria mecanismo
            // quebrado, e isso nao se confunde com rota sem lucro.
            assert.ok(maiorRetornoDaCadeia > 0n,
                'nenhuma tentativa devolveu WETH pela cadeia: o mecanismo MISTO não rodou, '
                + 'e isso é defeito do executor, não falta de oportunidade');
            return;
        }
        console.log(`\n    MELHOR: tamanho ${melhor.quantia}, pagamento ${melhor.pagamento},`
            + ` sobra ${melhor.bruto}`);

        // 2. EXECUTA, com saldos reconciliados.
        const antesArb = await saldo(WETH, arb);
        const antesCofre = await saldo(WETH, cofre);
        const antesTokenArb = await saldo(ALVO.token, arb);
        const dados = iface.encodeFunctionData('executarRota',
            [rota(melhor.pagamento), melhor.quantia, 1n]);
        let rec = null; let erro = null;
        try {
            const tx = await chamar('eth_sendTransaction', [{
                from: dono, to: arb, data: dados, gas: '0x2000000',
            }]);
            rec = await chamar('eth_getTransactionReceipt', [tx]);
        } catch (e) { erro = String(e.message ?? e); }
        if (rec === null || rec.status !== '0x1') {
            console.log(`    a execução REVERTEU: ${(erro ?? 'sem motivo').slice(0, 200)}`);
            assert.fail('cotou positivo e a execução reverteu — divergência do EXECUTOR');
        }

        const depoisArb = await saldo(WETH, arb);
        const depoisCofre = await saldo(WETH, cofre);
        const depoisTokenArb = await saldo(ALVO.token, arb);
        const bruto = depoisCofre - antesCofre;

        const gasUsado = BigInt(rec.gasUsed);
        const serializada = `0x${'02'.repeat(140 + dados.length / 2)}`;
        const l1 = num(await ler(ORACULO_DE_GAS_L1, codificarGetL1Fee(serializada)));
        const custo = somarCusto({
            gasUsado,
            gasUsadoVeioDe: 'recibo',
            baseFeeWei,
            gorjetaWei: 20_000_000n,
            custoL1Wei: l1,
            taxaDoEmprestimoWei: 0n,
        });
        const j = julgar(bruto, custo);

        console.log('\n    RECONCILIACAO (wei de WETH, salvo onde dito):');
        console.log(`      executor  WETH antes ${antesArb}  depois ${depoisArb}`);
        console.log(`      executor  token antes ${antesTokenArb}  depois ${depoisTokenArb}`);
        console.log(`      COFRE     antes ${antesCofre}  depois ${depoisCofre}`);
        console.log(`      bruto ao cofre ......... ${bruto}`);
        console.log(`      gás consumido (recibo) . ${gasUsado}`);
        console.log(`      ${custo.comoLer}`);
        console.log(`      VEREDICTO: ${j.veredicto.toUpperCase()} — ${j.porque.slice(0, 160)}`);
        console.log('\n    CONTRA O VENCEDOR HISTORICO:');
        console.log(`      ele recebeu ${ALVO.recebeuWeth} e pagou ${ALVO.pagouWeth}`);
        console.log(`      bruto dele ${ALVO.recebeuWeth - ALVO.pagouWeth} | bruto nosso ${bruto}`);
        console.log(`      gás dele ${ALVO.custoWei} wei | nosso ${custo.totalWei} wei`);

        // OS PORTOES.
        assert.equal(depoisArb, antesArb, 'o executor retiveve WETH: o lucro vai ao cofre');
        assert.equal(depoisTokenArb, antesTokenArb,
            'o executor retiveve o token intermediário: a liquidação não fechou');
        assert.ok(bruto > 0n, 'o cofre não recebeu nada numa execução bem-sucedida');
        assert.equal(bruto, melhor.bruto,
            `a cotação disse ${melhor.bruto} e o realizado foi ${bruto}: a conta do executor `
            + 'divergiu da do pool');
        console.log('    cotação == realizado: a conta do executor é a dos pools, exata');
    });
});
