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
const {
    codificarTetoDeL1, ORACULO_DE_GAS_L1, somarCusto, julgar, GORJETA_PADRAO_WEI,
} = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const WETH = '0x4200000000000000000000000000000000000006';
const TOP_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)').toLowerCase();
// A operacao vencedora `CC` de maior liquido reconciliado.
// O hash VEM DO ARQUIVO, nao da minha cabeca: `.tmp/reconciliado.json`, a
// operacao `CC` de maior liquido reconciliado. Hash escrito a mao e o defeito
// do `0x80d1e0f4…` em 32 bytes, e este projeto ja o cometeu uma vez.
// A UNICA das 7 que e CICLO FECHADO de dois pools no MESMO par: WETH/USDC em
// duas fabricas (`0x33128a8f` fee 100 e `0x38015d05` fee 450).
//
// A `0x0aa98647`, de liquido muito maior (0,027 WETH), NAO serve: os pools dela
// sao WETH/USDC e USDC/TOKEN, que nao compartilham o par — ela e duas trocas em
// sequencia, nao um ciclo de dois pools. Usa-la como padrao fazia este arquivo
// afirmar que o gerador esta quebrado quando ele estava certo em nao emitir
// rota. Conferido pelo grafo de tokens, nao pela sequencia de topics.
const TX_VENCEDORA = process.env.V3V3_TX
    ?? '0x12226f04d99c911a118b6f63edd8d74300ad63bc641afdf3c2b5496c7fc2ed40';
const BLOCO_VENCEDOR = Number(process.env.V3V3_BLOCO ?? 52631814);

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

    it('MECANISMO: gera, filtra, cota, EXECUTA e MEDE o líquido no estado real', async function () {
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

        // 5. COTACAO por override, a escada inteira, escolhendo o melhor
        //    LIQUIDO — nao o melhor bruto.
        //
        // ELA CORTOU O CRITERIO ANTERIOR, e com razao: *"Voce recebeu
        // 108.878.689.617 wei de WETH e gastou 372.944 unidades de gas. O teste
        // nao verifica o lucro liquido."* O ponto de equilibrio daquele caso e
        // ~0,000292 gwei, muito abaixo de qualquer baseFee real. Receber WETH
        // nao e ganhar dinheiro, e escolher o tamanho pelo BRUTO escolhe o
        // tamanho errado: o gas e quase constante no tamanho, entao quem decide
        // e a diferenca.
        const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
        const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
        // GAS ESTIMADO para ordenar a escada: o medido vem do recibo depois.
        const GAS_TIPICO = 400_000n;
        const custoDe = (gas) => gas * (baseFeeWei + GORJETA_PADRAO_WEI);
        let melhor = null;
        let melhorBruto = null;
        for (const c of tri.valem) {
            const emprestavel = saldoDaBaseNoV3.get(c.pernas[0].pool) ?? 0n;
            if (emprestavel === 0n) continue;
            for (const d of [10_000n, 2_000n, 500n, 100n, 20n]) {
                const q = emprestavel / d;
                if (q === 0n) continue;
                const dados = codificarCotarCiclo(pernasDaCandidata(c, WETH, q), q);
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
                const liquidoPrevisto = lido.sobra - custoDe(GAS_TIPICO);
                if (melhorBruto === null || lido.sobra > melhorBruto.sobra) {
                    melhorBruto = { c, quantia: q, sobra: lido.sobra };
                }
                if (melhor === null || liquidoPrevisto > melhor.liquidoPrevisto) {
                    melhor = { c, quantia: q, sobra: lido.sobra, liquidoPrevisto };
                }
            }
        }
        assert.ok(melhor !== null,
            'nenhuma cotação legível: sem número não há o que executar nem o que concluir');
        console.log(`    COTACAO (override): melhor BRUTO ${melhorBruto.sobra} |`
            + ` melhor LIQUIDO previsto ${melhor.liquidoPrevisto} na quantia ${melhor.quantia}`);
        console.log(`    baseFee ${baseFeeWei} + gorjeta ${GORJETA_PADRAO_WEI} por gas`);

        // 6. TESTE_DO_MECANISMO — executa e exige recibo, quitação e saldo.
        //
        //    Isto NAO afirma rentabilidade. E por isso que os dois testes sao
        //    separados: o anterior passava com `assert.ok(true)` quando a
        //    cotacao nao fechava, o que faz um teste identificado como prova
        //    nunca poder reprovar.
        assert.ok(melhorBruto.sobra > 0n,
            'TESTE_DO_MECANISMO: nenhum tamanho produziu sobra bruta neste estado real, então a '
            + 'execução não pode ser exercitada aqui. Isto é REPROVAÇÃO, não "tudo bem": sem '
            + 'sobra bruta não há o que quitar e a prova do mecanismo fica sem estado. Rode com '
            + 'V3V3_TX/V3V3_BLOCO de uma operação em que o ciclo feche no bloco anterior');

        const escolhido = melhor.liquidoPrevisto > 0n ? melhor : melhorBruto;
        const antesCofre = await saldo(WETH, cofre);
        const dados = iface.encodeFunctionData('executarRota',
            [pernasDaCandidata(escolhido.c, WETH, escolhido.quantia), escolhido.quantia, 1n]);
        const tx = await chamar('eth_sendTransaction', [{
            from: dono, to: arb, data: dados, gas: '0xB71B00',
        }]);
        const r = await chamar('eth_getTransactionReceipt', [tx]);
        assert.ok(r !== null, 'a execução não produziu recibo');
        assert.equal(r.status, '0x1',
            'recibo diferente de 1: o crédito NÃO foi quitado e a rota V3<->V3 não está provada');
        const bruto = (await saldo(WETH, cofre)) - antesCofre;
        const gasMedido = BigInt(r.gasUsed);
        console.log('\n    TESTE_DO_MECANISMO: recibo status=1');
        console.log(`      quantia ${escolhido.quantia} | gás MEDIDO ${gasMedido}`);
        console.log(`      COFRE ${antesCofre} -> ${antesCofre + bruto} | bruto ${bruto}`);
        assert.ok(bruto > 0n, 'o cofre não recebeu nada: sem saldo reconciliado não há prova');
        assert.equal(await saldo(WETH, arb), 0n, 'o executor retiveve WETH');
        assert.equal(await saldo(escolhido.c.token, arb), 0n, 'o executor retiveve o token');
        // A COTACAO tem de bater com o REALIZADO: se divergir, a cotação não
        // serve para decidir dinheiro.
        assert.equal(bruto, escolhido.sobra,
            `a cotação disse ${escolhido.sobra} e o realizado foi ${bruto}: cotação que não bate `
            + 'com a execução não pode autorizar envio');

        // 7. TESTE_DE_RENTABILIDADE — o custo COMPLETO, e líquido > 0.
        const bytesReais = (dados.length - 2) / 2;
        const l1 = num(await ler(ORACULO_DE_GAS_L1, codificarTetoDeL1(bytesReais)));
        const custo = somarCusto({
            gasUsado: gasMedido,
            gasUsadoVeioDe: 'recibo',
            baseFeeWei,
            gorjetaWei: GORJETA_PADRAO_WEI,
            // L1 por TETO; se o oráculo não responder, fica `null` e o total
            // fica DESCONHECIDO — nunca zero.
            custoL1Wei: l1,
            taxaDoEmprestimoWei: 0n,
        });
        const j = julgar(bruto, custo);
        console.log('\n    TESTE_DE_RENTABILIDADE');
        console.log(`      ${custo.comoLer}`);
        console.log(`      VEREDICTO: ${j.veredicto.toUpperCase()} | líquido ${j.liquidoWei}`);
        const equilibrioPorGas = bruto / gasMedido;
        console.log(`      ponto de equilíbrio: ${equilibrioPorGas} wei por gás`
            + ` (${(Number(equilibrioPorGas) / 1e9).toFixed(9)} gwei) contra baseFee+gorjeta`
            + ` ${baseFeeWei + GORJETA_PADRAO_WEI}`);

        if (process.env.V3V3_EXIGIR_LUCRO === '1') {
            assert.equal(j.veredicto, 'lucrativa',
                `TESTE_DE_RENTABILIDADE: líquido ${j.liquidoWei} não é estritamente positivo com `
                + `o custo completo (${custo.comoLer}). A execução é FUNCIONAL, não lucrativa`);
        } else {
            console.log('      DECLARADO: este arquivo prova o MECANISMO. A rentabilidade é'
                + ' medida e publicada acima, e só é EXIGIDA com V3V3_EXIGIR_LUCRO=1 — porque'
                + ' exigi-la sempre faria a prova do executor depender do mercado daquele bloco.');
        }
    });
});
