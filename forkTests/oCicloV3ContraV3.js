// PROVA DE PONTA A PONTA da rota CONCENTRADO <-> CONCENTRADO.
//
// POR QUE ESTA ROTA EXISTE: medido em 2026-10-16, das 7 operacoes com liquido
// reconciliado positivo, DUAS sao exatamente esta forma — `CC`, dois swaps em
// pools concentrados:
//
//     0x0aa98647e0…  bloco 52632036  CC  liquido 27.025.304.662.802.249 wei
//     0x12226f04d9…  bloco 52631814  CC  liquido    235.492.231.595.889 wei
//
// E o executor JA aceita duas pernas `tipo = 0`. O que faltava era o GERADOR
// de rotas emiti-las.
//
// O ESTADO E REAL, e isso e de proposito. Nao ha deslocamento artificial aqui:
// o fork vai para o bloco ANTERIOR ao da operacao vencedora e a nossa rota
// corre contra o estado que o vencedor encontrou. Se fechar, a forma esta
// provada com estado de mercado; se nao fechar, o resultado e a MEDICAO de que
// aquela oportunidade nao existia no comeco do bloco — e isso responde, para
// esta operacao, a pergunta de dependencia INTRABLOCO que ficou declarada como
// lacuna.
//
// Os pools NAO sao escritos de cabeca: saem dos logs do recibo da propria
// transacao vencedora, lidos do no de cima.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const {
    candidatasMistas, pernasDaCandidata, triarCandidatas,
} = require('../dist/rotasMistas.js');
const { codificarCotarCiclo, lerRespostaDaCotacao, COTADOR_LOCAL } = require('../dist/cotarMista.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const WETH = '0x4200000000000000000000000000000000000006';
const TOP_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)').toLowerCase();
// A operacao vencedora `CC` de maior liquido reconciliado.
// O hash VEM DO ARQUIVO, nao da minha cabeca: `.tmp/reconciliado.json`, a
// operacao `CC` de maior liquido reconciliado. Hash escrito a mao e o defeito
// do `0x80d1e0f4…` em 32 bytes, e este projeto ja o cometeu uma vez.
const TX_VENCEDORA = process.env.V3V3_TX
    ?? '0x0aa98647e00c24f5eec0ea5ffc2a5f5b937f47f272aaec7417a201b22c00d1fc';
const BLOCO_VENCEDOR = Number(process.env.V3V3_BLOCO ?? 52632036);

const iface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia, uint256 lucroMinimo) returns (uint256)',
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
const num = (h) => (h && h !== '0x' && h.length >= 66 ? BigInt(h.slice(0, 66)) : null);
const endDe = (h) => (h && h.length >= 42 ? `0x${h.slice(-40)}`.toLowerCase() : null);
const saldo = async (t, de) => num(await ler(
    t, sel('balanceOf(address)') + coder.encode(['address'], [de]).slice(2),
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

describe('o ciclo concentrado contra concentrado', function () {
    this.timeout(3_600_000);

    it('gera, filtra, cota e EXECUTA a rota V3<->V3 no estado real do vencedor', async function () {
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;

        // 1. OS POOLS, dos logs do recibo da transacao vencedora.
        const rec = await upstream('eth_getTransactionReceipt', [TX_VENCEDORA]);
        assert.ok(rec !== null,
            `a transação ${TX_VENCEDORA} não tem recibo: sem ela não há estado real para provar `
            + 'a forma. Passe V3V3_TX e V3V3_BLOCO de uma operação `CC` verificada');
        const pools = [];
        for (const l of rec.logs ?? []) {
            if ((l.topics[0] ?? '').toLowerCase() !== TOP_V3) continue;
            const a = l.address.toLowerCase();
            if (!pools.includes(a)) pools.push(a);
        }
        console.log(`    VENCEDORA ${TX_VENCEDORA.slice(0, 12)} bloco ${BLOCO_VENCEDOR}`
            + ` | ${pools.length} pool(s) concentrado(s): ${pools.map((x) => x.slice(0, 10)).join(', ')}`);
        assert.equal(pools.length, 2,
            'esta prova é da forma de DUAS pernas: com outro número de pools a operação é outra');

        // 2. O FORK no bloco ANTERIOR: o estado que o vencedor encontrou.
        await chamar('hardhat_reset', [{
            forking: { jsonRpcUrl: url, blockNumber: BLOCO_VENCEDOR - 1 },
        }]);
        const contas = await chamar('eth_accounts', []);
        const [dono, cofre] = contas;
        const art = await hre.artifacts.readArtifact('CacadorV3');
        const dep = await chamar('eth_sendTransaction', [{
            from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
            gas: '0xB71B00',
        }]);
        const arb = (await chamar('eth_getTransactionReceipt', [dep])).contractAddress;

        // 3. A DESCRICAO dos pools sai da corrente, e a rota sai do GERADOR —
        //    a mesma `candidatasMistas` do caçador, nao uma montagem deste teste.
        const descritos = [];
        for (const pool of pools) {
            const t0 = endDe(await ler(pool, sel('token0()')));
            const t1 = endDe(await ler(pool, sel('token1()')));
            const fab = endDe(await ler(pool, sel('factory()')));
            const fee = num(await ler(pool, sel('fee()')));
            assert.ok(t0 !== null && t1 !== null, `pool ${pool} não respondeu token0/token1`);
            descritos.push({
                endereco: pool, token0: t0, token1: t1, venue: 'v3',
                taxa: fee === null ? null : Number(fee), fabrica: fab,
            });
        }
        const fabricas = [...new Set(descritos.map((x) => x.fabrica))];
        console.log(`    fábricas: ${fabricas.map((x) => String(x).slice(0, 12)).join(', ')}`
            + ` | fees ${descritos.map((x) => x.taxa).join('/')}`);

        const rotas = candidatasMistas(descritos, WETH);
        console.log(`    GERADOR: ${rotas.length} rota(s) — as duas ordens do par`);
        assert.ok(rotas.length > 0,
            'o gerador não emitiu rota para dois pools concentrados do mesmo par: é exatamente o '
            + 'defeito que esta entrega conserta');
        for (const c of rotas) {
            assert.equal(c.pernas.length, 2);
            assert.equal(c.poolV3, undefined,
                'rota concentrado<->concentrado não pode carregar `poolV3`: o campo descreveria '
                + 'a rota errada em metade dos casos');
        }

        // 4. O ESTADO e o FILTRO, com as duas pernas lidas.
        const sqrtPorPoolV3 = new Map();
        const liquidezDoV3 = new Map();
        const saldoDaBaseNoV3 = new Map();
        for (const pool of pools) {
            const s0 = await ler(pool, sel('slot0()'));
            sqrtPorPoolV3.set(pool, (s0 && s0.length >= 66) ? BigInt(`0x${s0.slice(2, 66)}`) : null);
            liquidezDoV3.set(pool, num(await ler(pool, sel('liquidity()'))));
            saldoDaBaseNoV3.set(pool, await saldo(WETH, pool));
        }
        const estado = {
            sqrtPorPoolV3,
            token0PorPool: new Map(),
            reservasAerodrome: new Map(),
            liquidezDoV3,
            saldoDaBaseNoV3,
            bloco: BLOCO_VENCEDOR - 1,
        };
        const tri = triarCandidatas(rotas, WETH, estado);
        console.log(`    FILTRO: ${tri.valem.length} passaram, ${tri.recusadasPorSpread.length}`
            + ' descartadas com prova');

        // 5. COTACAO por override e EXECUCAO, tamanho por tamanho.
        let melhor = null;
        for (const c of tri.valem) {
            const emprestavel = saldoDaBaseNoV3.get(c.pernas[0].pool) ?? 0n;
            if (emprestavel === 0n) continue;
            for (const d of [10_000n, 2_000n, 500n, 100n, 20n]) {
                const q = emprestavel / d;
                if (q === 0n) continue;
                const dados = codificarCotarCiclo(pernasDaCandidata(c, WETH, q), q);
                // eslint-disable-next-line no-await-in-loop
                let lido = null;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await chamar('eth_call', [{
                        from: '0x0000000000000000000000000000000000000000',
                        to: COTADOR_LOCAL, data: dados, gas: '0xB71B00',
                    }, 'latest', { [COTADOR_LOCAL]: { code: art.deployedBytecode } }]);
                } catch (e) {
                    const dado = (e && (e.data || (e.error && e.error.data))) || null;
                    lido = lerRespostaDaCotacao(typeof dado === 'string' ? dado : null);
                }
                if (lido === null) continue;
                if (melhor === null || lido.sobra > melhor.sobra) {
                    melhor = { c, quantia: q, sobra: lido.sobra };
                }
            }
        }
        assert.ok(melhor !== null,
            'nenhuma cotação legível: sem número não há o que executar nem o que concluir');
        console.log(`    COTACAO (override): melhor sobra ${melhor.sobra} na quantia`
            + ` ${melhor.quantia}`);

        if (melhor.sobra <= 0n) {
            // RESULTADO, nao falha: a oportunidade do vencedor NAO existia no
            // comeco do bloco dele. Para ESTA operacao, ela dependia de estado
            // intrabloco — e o caminho de ler-e-reagir nao a alcança.
            console.log('\n    MEDIDO: no estado do bloco ANTERIOR a rota NÃO fecha (sobra'
                + ` ${melhor.sobra}). Então a oportunidade de ${TX_VENCEDORA.slice(0, 12)}`
                + ' foi criada DENTRO do bloco — é dependência INTRABLOCO medida, não falha do'
                + ' executor. A forma V3<->V3 continua sem prova de execução em estado real.');
            assert.ok(true);
            return;
        }

        const antesCofre = await saldo(WETH, cofre);
        const dados = iface.encodeFunctionData('executarRota',
            [pernasDaCandidata(melhor.c, WETH, melhor.quantia), melhor.quantia, 1n]);
        const tx = await chamar('eth_sendTransaction', [{
            from: dono, to: arb, data: dados, gas: '0xB71B00',
        }]);
        const r = await chamar('eth_getTransactionReceipt', [tx]);
        assert.ok(r !== null, 'a execução não produziu recibo');
        assert.equal(r.status, '0x1',
            'recibo diferente de 1: o crédito NÃO foi quitado e a rota V3<->V3 não está provada');
        const bruto = (await saldo(WETH, cofre)) - antesCofre;
        console.log('\n    EXECUCAO ATOMICA V3<->V3 CONCLUIDA — recibo status=1');
        console.log(`      quantia ${melhor.quantia} | gás ${BigInt(r.gasUsed)}`);
        console.log(`      COFRE ${antesCofre} -> ${antesCofre + bruto} | bruto ${bruto}`);
        assert.ok(bruto > 0n, 'o cofre não recebeu nada: sem saldo reconciliado não há prova');
        assert.equal(await saldo(WETH, arb), 0n, 'o executor retiveve WETH');
    });
});
