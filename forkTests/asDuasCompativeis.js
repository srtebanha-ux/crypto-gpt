// AS DUAS VENCEDORAS COMPATIVEIS, contra o MOTOR DE PRODUCAO.
//
// POR QUE ESTE ARQUIVO EXISTE: o benchmark anterior
// (`oTitanContraOsVencedores.js`) concluiu "FORA DO UNIVERSO" para seis
// operacoes usando `descobrirUniverso` — o scanner por INDICE de `allPairs`,
// que e V2. Nenhuma das fabricas dos vencedores esta em
// `FABRICAS_COM_FLASH_SWAP`, entao aquela resposta era sobre o caminho V2 e nao
// sobre o motor que esta rodada validou. Concluir cobertura de pool V3/Aerodrome
// pelo scanner V2 seria ausencia com cara de resposta.
//
// AQUI o caminho e o de producao, nas MESMAS funcoes e na mesma ordem do laco
// de `cacarArbitragem`:
//
//     universoPorAtividade  ->  candidatasMistas  ->  lerEstadoMisto
//                           ->  triarCandidatas   ->  cotarAfetadas
//
// AS DUAS OPERACOES sao as unicas da amostra reconciliada cuja FORMA o executor
// atual alcanca: duas pernas, uma concentrada e uma Aerodrome. Os hashes sao
// LIDOS dos dados reconciliados, nao escritos aqui — hash de cabeca e o defeito
// do `0x80d1e0f4…` em 32 bytes.
//
// REGRA DE INFORMACAO: a descoberta roda SO com blocos ANTERIORES ao bloco
// vencedor. Os pools do recibo do vencedor sao carregados, mas usados APENAS
// DEPOIS da busca, para medir cobertura. Nenhum deslocamento de preco e
// aplicado: o estado e o que estava la.
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { AbiCoder, Interface } = require('ethers');

const {
    universoPorAtividade, lerEstadoMisto, cotarAfetadas, WETH_DA_BASE,
} = require('../dist/cacarArbitragem.js');
const { candidatasMistas, triarCandidatas, pernasDaCandidata } = require('../dist/rotasMistas.js');
const { GORJETA_PADRAO_WEI, somarCusto, julgar } = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const RECONCILIADO = process.env.QG2_RECONCILIADO ?? '.tmp/reconciliado.json';
const BENCHMARK = process.env.QG2_BENCHMARK ?? '.tmp/benchmarkDeArbitragem.json';
// OS PREFIXOS vem da ordem dela; o hash completo sai do arquivo.
const PREFIXOS = (process.env.QG2_PREFIXOS ?? '0x6966a108,0xa72914e1').split(',');
// A JANELA DE DESCOBERTA, curta e documentada: N blocos que TERMINAM no bloco
// anterior ao vencedor. Nenhum bloco >= o do vencedor e lido.
const JANELA = Number(process.env.QG2_JANELA ?? 12);

const iface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia, uint256 lucroMinimo) returns (uint256)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);
const ler = async (to, data) => {
    try { return await chamar('eth_call', [{ to, data }, 'latest']); } catch { return null; }
};
const num = (h) => (h && h !== '0x' && h.length >= 66 ? BigInt(h.slice(0, 66)) : null);
const saldo = async (t, de) => num(await ler(
    t, `0x70a08231${coder.encode(['address'], [de]).slice(2)}`,
)) ?? 0n;

let undiciFetch = null;
let agente;
// O UPSTREAM, so para leitura historica de recibos.
//
// MEDIDO hoje: o fork do Hardhat responde "eth_getBlockReceipts is not
// supported", e `universoPorAtividade` devolve `metodoIndisponivel: true` —
// corretamente, em vez de zero pools. O RPC publico responde o MESMO metodo em
// bloco historico (350 recibos no bloco 52632035). Entao a descoberta de
// producao PODE ser medida: os recibos vem do upstream, em blocos anteriores.
async function upstream(metodo, params) {
    if (undiciFetch === null) {
        const u = await import('undici');
        undiciFetch = u.fetch;
        agente = process.env.HTTPS_PROXY ? new u.ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    }
    const url = hre.config.networks.hardhat.forking.url;
    for (let t = 0; t < 4; t += 1) {
        try {
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
            return j.result;
        } catch (e) {
            if (t === 3) throw e;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((s) => { setTimeout(s, 500 * 2 ** t); });
        }
    }
    return null;
}

describe('as duas vencedoras compatíveis, contra o motor de produção', function () {
    this.timeout(3_600_000);

    it('descobre, dimensiona e avalia no estado ANTERIOR, pelo caminho real', async function () {
        if (!existsSync(RECONCILIADO) || !existsSync(BENCHMARK)) {
            console.log(`    FALTA DE DADOS: ${RECONCILIADO} ou ${BENCHMARK} não existe.`);
            console.log('    Isto é falta de dado, não "o TITAN passou".');
            this.skip();
            return;
        }
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const rec = JSON.parse(readFileSync(RECONCILIADO, 'utf8'));
        const bench = JSON.parse(readFileSync(BENCHMARK, 'utf8'));

        const alvos = PREFIXOS.map((pre) => {
            const r = rec.find((o) => o.tx.toLowerCase().startsWith(pre.toLowerCase()));
            assert.ok(r !== undefined, `nenhuma operação reconciliada começa com ${pre}`);
            const o = bench.operacoes.find((x) => x.tx.toLowerCase() === r.tx.toLowerCase());
            assert.ok(o !== undefined, `${r.tx} não está no benchmark: sem os pools do recibo não`
                + ' há como medir cobertura depois da busca');
            assert.ok(r.liquidoReconciliado !== null,
                `${r.tx} não tem líquido reconciliado: sem ele não há vencedor a comparar`);
            return {
                tx: r.tx,
                bloco: r.bloco,
                venues: (r.dexes ?? []).join('+'),
                liquidoDoVencedor: BigInt(r.liquidoReconciliado),
                custoDoVencedor: BigInt(r.custoWei),
                // USO SO DEPOIS DA BUSCA.
                poolsDoRecibo: o.pools.map((x) => x.toLowerCase()),
            };
        });

        const linhas = [];
        for (const op of alvos) {
            const anterior = op.bloco - 1;
            const linha = { op, etapas: {} };
            linhas.push(linha);
            console.log(`\n    ===== ${op.tx.slice(0, 12)}… bloco ${op.bloco} [${op.venues}] =====`);
            console.log(`      vencedor capturou (reconciliado): ${op.liquidoDoVencedor} wei`
                + ` | custo dele ${op.custoDoVencedor}`);

            // 1. O FORK no bloco ANTERIOR.
            try {
                // eslint-disable-next-line no-await-in-loop
                await chamar('hardhat_reset', [{
                    forking: { jsonRpcUrl: url, blockNumber: anterior },
                }]);
            } catch (e) {
                linha.etapas.fork = `NÃO SUBIU: ${String(e).slice(0, 80)}`;
                console.log(`      FORK: ${linha.etapas.fork}`);
                continue;
            }

            // 2. A DESCOBERTA DE PRODUCAO, na janela curta anterior.
            //
            // O ADAPTADOR, e e tudo o que este teste acrescenta: `eth_blockNumber`
            // devolve o bloco ANTERIOR (e o topo que o caçador veria naquele
            // instante), `eth_getBlockReceipts` vai ao upstream — porque o fork
            // nao implementa o metodo — e TODA leitura de estado (`eth_call`) vai
            // ao FORK, que esta fixado no bloco anterior. Assim os tokens, taxas e
            // reservas sao os daquele bloco, nao os de hoje.
            let pedidosUpstream = 0;
            const chamarDescoberta = async (metodo, params) => {
                if (metodo === 'eth_blockNumber') return `0x${anterior.toString(16)}`;
                if (metodo === 'eth_getBlockReceipts') {
                    const b = Number(BigInt(params[0]));
                    assert.ok(b <= anterior,
                        `a descoberta pediu o bloco ${b}, que não é anterior a ${op.bloco}:`
                        + ' informação do futuro não entra na busca');
                    pedidosUpstream += 1;
                    return upstream(metodo, params);
                }
                return chamar(metodo, params);
            };
            let universo;
            try {
                // eslint-disable-next-line no-await-in-loop
                universo = await universoPorAtividade(chamarDescoberta, {
                    blocos: JANELA, tetoDePools: Number(process.env.QG2_TETO ?? 300),
                });
            } catch (e) {
                linha.etapas.descoberta = `FALHOU: ${String(e).slice(0, 100)}`;
                console.log(`      DESCOBERTA: ${linha.etapas.descoberta}`);
                continue;
            }
            if (universo.metodoIndisponivel) {
                linha.etapas.descoberta = 'eth_getBlockReceipts INDISPONÍVEL nos dois caminhos:'
                    + ' sem recibos não há universo por atividade, e zero pools aqui NÃO é'
                    + ' medição de cobertura';
                console.log(`      DESCOBERTA: ${linha.etapas.descoberta}`);
                continue;
            }
            console.log(`      DESCOBERTA (janela ${JANELA} blocos, ${anterior - JANELA + 1}..`
                + `${anterior}, ${pedidosUpstream} pedido(s) ao upstream):`);
            console.log(`        ${universo.blocosLidos} bloco(s) lidos, ${universo.blocosFalhos}`
                + ` falhos | pools ativos vistos: ${universo.poolsVistos}`
                + ` (${universo.porVenue.v2} V2, ${universo.porVenue.v3} V3,`
                + ` ${universo.porVenue.aerodrome} Aerodrome)`);
            console.log(`        concentrados com token0/token1 lidos: `
                + `${universo.concentrados.length} (${universo.tokensQueFalharam} de `
                + `${universo.tokensPedidos} leituras falharam)`);

            // 3. AS ROTAS, pelo gerador de producao.
            const MISTAS = candidatasMistas(universo.concentrados, WETH_DA_BASE);
            console.log(`      GERADOR: ${MISTAS.length} rota(s) mista(s)`);

            // 4. O ESTADO e a TRIAGEM, de producao.
            let L;
            try {
                // eslint-disable-next-line no-await-in-loop
                L = await lerEstadoMisto(chamar, MISTAS, anterior, 'latest');
            } catch (e) {
                linha.etapas.estado = `FALHOU: ${String(e).slice(0, 90)}`;
                console.log(`      ESTADO: ${linha.etapas.estado}`);
                continue;
            }
            const tri = triarCandidatas(MISTAS, WETH_DA_BASE, L);
            console.log(`      FILTRO: ${tri.valem.length} passaram,`
                + ` ${tri.recusadasPorSpread.length} descartadas com prova,`
                + ` ${tri.semDados} sem dado, ${tri.semProvaDoInvariante} sem prova do invariante`);

            // 5. AGORA, e so agora, os pools do recibo entram — para MEDIR
            //    cobertura e achar a rota comparavel. A busca acima nao os viu.
            const conhecidos = new Set(universo.pools.map((x) => x.toLowerCase()));
            for (const c of universo.concentrados) conhecidos.add(c.endereco.toLowerCase());
            const cobertos = op.poolsDoRecibo.filter((x) => conhecidos.has(x));
            linha.cobertura = `${cobertos.length}/${op.poolsDoRecibo.length}`;
            console.log(`      COBERTURA (comparação pós-busca): ${linha.cobertura} pool(s) do`
                + ` vencedor no universo de produção`);
            const doVencedor = new Set(op.poolsDoRecibo);
            const comparaveis = tri.valem.filter(
                (c) => c.pernas.every((x) => doVencedor.has(x.pool.toLowerCase())),
            );
            const tocam = tri.valem.filter(
                (c) => c.pernas.some((x) => doVencedor.has(x.pool.toLowerCase())),
            );
            console.log(`      ROTA DO VENCEDOR: ${comparaveis.length} rota(s) com AS DUAS pernas`
                + ` nos pools dele, ${tocam.length} tocando ao menos um`);
            linha.rotas = { comparaveis: comparaveis.length, tocam: tocam.length };
            if (comparaveis.length === 0) {
                const nasDescartadas = tri.recusadasPorSpread.filter(
                    (r) => (r.c ?? r).pernas?.every?.(
                        (x) => doVencedor.has(x.pool.toLowerCase()),
                    ),
                ).length;
                linha.etapas.rota = 'o gerador NÃO emitiu a rota de duas pernas sobre os pools do'
                    + ` vencedor (${nasDescartadas} apareceu(ram) entre as descartadas com prova)`;
                console.log(`      ${linha.etapas.rota}`);
                continue;
            }

            // 6. A COTACAO, pela funcao de producao. Custo real: baseFee puro +
            //    gorjeta UMA vez dentro de `somarCusto` + L1 por teto.
            // eslint-disable-next-line no-await-in-loop
            const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
            const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
            const tamanhos = [];
            const emLote = async (pedidos) => {
                const saidas = [];
                for (const pedido of pedidos) {
                    const data = String(pedido.params[0].data);
                    tamanhos.push(BigInt(`0x${data.slice(74, 138)}`));
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
            const art = await hre.artifacts.readArtifact('CacadorV3');
            // eslint-disable-next-line no-await-in-loop
            const sinais = await cotarAfetadas(
                emLote, chamar, comparaveis, L, 'latest', anterior, Date.now(),
                baseFeeWei, art.deployedBytecode,
            );
            console.log(`      COTAÇÃO (cotarAfetadas, produção) — baseFee ${baseFeeWei}`
                + ` + gorjeta ${GORJETA_PADRAO_WEI} por gás`);
            console.log(`        tamanhos cotados (${tamanhos.length}):`
                + ` ${tamanhos.map(String).join(', ')}`);
            for (const s of sinais) {
                console.log(`        ${s.rota}`);
                console.log(`          tamanho ${s.melhorTamanho} | bruto ${s.lucroBrutoEstimado}`
                    + ` | custo ${s.custoTotalEstimado} | LÍQUIDO ${s.lucroLiquidoEstimado}`);
                console.log(`          ${s.motivo}`);
            }
            linha.sinais = sinais.map((s) => ({
                rota: s.rota,
                tamanho: s.melhorTamanho,
                bruto: s.lucroBrutoEstimado,
                custo: s.custoTotalEstimado,
                liquido: s.lucroLiquidoEstimado,
            }));
            linha.tamanhos = tamanhos.length;
            const aprovados = sinais.filter(
                (s) => s.lucroLiquidoEstimado !== null && s.lucroLiquidoEstimado > 0n,
            );
            console.log(`      DECISÃO DO CAÇADOR: ${aprovados.length} de ${sinais.length}`
                + ' aprovada(s)');
            linha.aprovados = aprovados.length;

            // 7. SO SE A DECISAO APROVAR: execucao no fork, reconciliada.
            //    Sem aprovacao nao se executa — executar um deficit e simular
            //    uma operacao que o motor recusou.
            if (aprovados.length === 0) {
                linha.etapas.execucao = 'não executada: o motor RECUSOU (nenhum líquido positivo),'
                    + ' e executar o que ele recusou seria simular operação não aprovada';
                console.log(`      EXECUÇÃO: ${linha.etapas.execucao}`);
                continue;
            }
            const melhor = aprovados.reduce(
                (a, b) => (b.lucroLiquidoEstimado > a.lucroLiquidoEstimado ? b : a),
            );
            const candidata = comparaveis.find((c) => c.chave === melhor.rota);
            assert.ok(candidata !== undefined, 'sinal sem candidata: identidade de rota quebrada');
            // eslint-disable-next-line no-await-in-loop
            const contas = await chamar('eth_accounts', []);
            const [dono, cofre] = contas;
            // eslint-disable-next-line no-await-in-loop
            const dep = await chamar('eth_sendTransaction', [{
                from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
                gas: '0xB71B00',
            }]);
            // eslint-disable-next-line no-await-in-loop
            const arb = (await chamar('eth_getTransactionReceipt', [dep])).contractAddress;
            // eslint-disable-next-line no-await-in-loop
            const antes = await saldo(WETH_DA_BASE, cofre);
            const dados = iface.encodeFunctionData('executarRota', [
                pernasDaCandidata(candidata, WETH_DA_BASE, melhor.melhorTamanho),
                melhor.melhorTamanho, 1n,
            ]);
            // eslint-disable-next-line no-await-in-loop
            const tx = await chamar('eth_sendTransaction', [{
                from: dono, to: arb, data: dados, gas: '0xB71B00',
            }]);
            // eslint-disable-next-line no-await-in-loop
            const r = await chamar('eth_getTransactionReceipt', [tx]);
            // eslint-disable-next-line no-await-in-loop
            const bruto = (await saldo(WETH_DA_BASE, cofre)) - antes;
            const gasMedido = BigInt(r.gasUsed);
            const custo = somarCusto({
                gasUsado: gasMedido,
                gasUsadoVeioDe: 'recibo',
                baseFeeWei,
                gorjetaWei: GORJETA_PADRAO_WEI,
                // LIMITACAO DESTA LINHA, declarada: o L1 nao e relido aqui, vai
                // ZERO. Entao esta reconciliacao SUBESTIMA o custo pelo L1 — que
                // na medicao de 10/16, no mesmo calldata, foi 4.348.819.154 wei
                // (0,05% do total). O numero que DECIDE e o de `cotarAfetadas`
                // acima, que le o oraculo de L1 por teto; este serve para
                // reconciliar o gas do RECIBO contra a estimativa, e esta linha
                // existe para que ninguem o leia como custo completo.
                custoL1Wei: melhor.custoTotalEstimado === null ? null : 0n,
                taxaDoEmprestimoWei: 0n,
            });
            const j = julgar(bruto, custo);
            console.log(`      EXECUÇÃO no fork: status ${r.status} | gás ${gasMedido}`
                + ` | bruto no cofre ${bruto}`);
            console.log(`        cotação dizia ${melhor.lucroBrutoEstimado} —`
                + ` diferença ${bruto - melhor.lucroBrutoEstimado}`);
            console.log(`        ${custo.comoLer}`);
            console.log(`        VEREDICTO: ${j.veredicto.toUpperCase()} | líquido ${j.liquidoWei}`);
            linha.etapas.execucao = `status ${r.status}, bruto ${bruto}, gás ${gasMedido}`;
            assert.equal(r.status, '0x1', 'o motor aprovou e a execução reverteu: defeito');
            assert.equal(bruto, melhor.lucroBrutoEstimado,
                'cotação diferente do realizado: a cotação não serve para decidir dinheiro');
        }

        console.log('\n    ===== RESUMO =====');
        for (const l of linhas) {
            console.log(`    ${l.op.tx.slice(0, 12)}… cobertura ${l.cobertura ?? '—'}`
                + ` | rotas comparáveis ${l.rotas ? l.rotas.comparaveis : '—'}`
                + ` | tamanhos ${l.tamanhos ?? 0}`
                + ` | aprovadas ${l.aprovados ?? '—'}`
                + ` | ${Object.entries(l.etapas).map(([k, v]) => `${k}: ${v}`).join(' | ') || 'sem falha registrada'}`);
        }
        console.log('    DECLARADO: o lucro do vencedor NÃO é o lucro que o TITAN poderia obter no'
            + ' bloco anterior. São estados diferentes, e esta medição é só do bloco anterior.');
    });
});
