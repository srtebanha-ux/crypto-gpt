// A COBERTURA CONTINUA: o ANTES e o DEPOIS, no MESMO historico.
//
// O DEFEITO, medido em 2026-10-16: o universo e descoberto UMA vez, no boot,
// pelos pools que emitiram `Swap` na janela recente. Pool que fica quieto
// desaparece, e a rota sobre ele nem e gerada. Os dois pools da vencedora
// `0x6966a108…` nao emitiram `Swap` em 60 blocos anteriores (cobertura 100% da
// varredura) e nasceram 14,5 MILHOES de blocos antes — nem janela maior nem
// evento de fabrica em janela curta os acham.
//
// O QUE ESTE ARQUIVO PROVA, com leitura so do passado:
//
//   ANTES   descoberta de uma janela no bloco de avaliacao  ->  cobertura e
//           rotas sobre os dois pools-alvo
//   DEPOIS  a MESMA descoberta, UNIDA a uma memoria aprendida numa janela
//           ANTERIOR, relida do DISCO (processo novo)       ->  idem
//
// A semente da memoria vem de uma janela ANTERIOR ao bloco de avaliacao, e uma
// assercao barra qualquer pedido de bloco maior que o avaliado. O estado e a
// cotacao sao SEMPRE do bloco avaliado: a memoria guarda identidade, nao preco.
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

const BENCHMARK = process.env.CC_BENCHMARK ?? '.tmp/benchmarkDeArbitragem.json';
// O BLOCO DE AVALIACAO: depois do bloco em que os alvos negociaram, para que
// a janela dele NAO os veja. Nenhuma leitura passa daqui.
const AVALIA = Number(process.env.CC_BLOCO ?? 52632200);
// O bloco em que os alvos negociaram — a semente sai de uma janela que termina
// aqui, e esta ANTES do bloco de avaliacao.
const SEMENTE_ATE = Number(process.env.CC_SEMENTE ?? 52632036);
const JANELA = Number(process.env.CC_JANELA ?? 12);
const TETO_DE_RPC = Number(process.env.CC_TETO_RPC ?? 60);

let p;
const chamar = (m, ps) => p.send(m, ps);

let undiciFetch = null;
let agente;
let pedidosUpstream = 0;
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
            // RESPOSTA NAO-LISTA e recusa do no, nao medicao de ausencia: na
            // primeira varredura deste historico 62 de 120 blocos voltaram
            // `undefined` sem campo de erro, e aceitar isso publicaria 48% de
            // cobertura como "o pool nao negociou".
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

// O ADAPTADOR, e e tudo o que este teste acrescenta: o topo da corrente e o
// bloco pedido (o que o cacador veria naquele instante), os recibos vem do
// upstream — porque o fork do Hardhat nao implementa `eth_getBlockReceipts` — e
// toda leitura de estado vai ao FORK. Nenhum bloco depois do avaliado e lido.
const transporte = (topo) => async (metodo, params) => {
    if (metodo === 'eth_blockNumber') return `0x${topo.toString(16)}`;
    if (metodo === 'eth_getBlockReceipts') {
        const b = Number(BigInt(params[0]));
        assert.ok(b <= topo, `pediu o bloco ${b}, acima do topo ${topo}: sem informação futura`);
        assert.ok(b <= AVALIA, `pediu o bloco ${b}, acima do avaliado ${AVALIA}`);
        return upstream(metodo, params);
    }
    return chamar(metodo, params);
};

const descobrir = async (topo) => universoPorAtividade(transporte(topo), {
    blocos: JANELA, tetoDePools: Number(process.env.CC_TETO ?? 300),
});

describe('a cobertura contínua: antes e depois, no mesmo histórico', function () {
    this.timeout(3_600_000);

    it('pool quieto continua conhecido, atravessa reinício e vira rota cotada', async function () {
        if (!existsSync(BENCHMARK)) {
            console.log(`    FALTA DE DADOS: ${BENCHMARK} não existe.`);
            this.skip();
            return;
        }
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const bench = JSON.parse(readFileSync(BENCHMARK, 'utf8'));
        const op = bench.operacoes.find(
            (x) => x.tx.toLowerCase().startsWith('0x6966a108'),
        );
        assert.ok(op !== undefined, 'a operação 0x6966a108 não está no benchmark');
        // OS ALVOS entram só na COMPARAÇÃO, nunca na descoberta.
        const alvos = op.pools.map((x) => x.toLowerCase());
        assert.ok(op.bloco <= SEMENTE_ATE && SEMENTE_ATE < AVALIA,
            `a semente (${SEMENTE_ATE}) tem de estar entre o bloco dos alvos (${op.bloco}) e o`
            + ` bloco avaliado (${AVALIA})`);
        const rede = 8453;
        const caminho = path.join(os.tmpdir(), `coberturaContinua-${Date.now()}.json`);
        console.log(`    alvos (comparação pós-busca): ${alvos.join(', ')}`);
        console.log(`    semente: janela de ${JANELA} blocos até ${SEMENTE_ATE}`
            + ` | avaliação: bloco ${AVALIA}, janela de ${JANELA} blocos`);

        // 1. A SEMENTE: descoberta numa janela ANTERIOR, gravada no disco.
        await chamar('hardhat_reset', [{
            forking: { jsonRpcUrl: url, blockNumber: SEMENTE_ATE },
        }]);
        const semente = await descobrir(SEMENTE_ATE);
        assert.ok(!semente.metodoIndisponivel,
            'sem `eth_getBlockReceipts` nos dois caminhos não há o que medir — e zero pool aqui '
            + 'NÃO é cobertura zero');
        const js = juntar(
            memoriaVazia(rede), deDescoberta(semente.concentrados, rede, SEMENTE_ATE),
        );
        await gravarMemoria(caminho, js.memoria);
        const naSemente = alvos.filter(
            (a) => js.memoria.pools.some((q) => q.endereco === a),
        );
        console.log(`    SEMENTE: ${semente.concentrados.length} concentrado(s) aprendido(s),`
            + ` ${naSemente.length}/${alvos.length} alvo(s) entre eles`);

        // 2. O FORK no bloco de avaliação, onde os alvos estão quietos.
        await chamar('hardhat_reset', [{ forking: { jsonRpcUrl: url, blockNumber: AVALIA } }]);
        const agora = await descobrir(AVALIA);
        assert.ok(!agora.metodoIndisponivel, 'descoberta do bloco avaliado não rodou');

        // 3. ANTES: só a descoberta do bloco avaliado.
        const antesPools = new Set(agora.concentrados.map((x) => x.endereco.toLowerCase()));
        const antesRotas = candidatasMistas(agora.concentrados, WETH_DA_BASE);
        const antesCobertos = alvos.filter((a) => antesPools.has(a));
        const antesSobreAlvos = antesRotas.filter(
            (c) => c.pernas.every((x) => alvos.includes(x.pool.toLowerCase())),
        );
        console.log(`\n    ANTES (descoberta do boot, janela ${JANELA}):`);
        console.log(`      ${agora.concentrados.length} concentrado(s) |`
            + ` cobertura dos alvos ${antesCobertos.length}/${alvos.length}`
            + ` | ${antesRotas.length} rota(s) | sobre os alvos: ${antesSobreAlvos.length}`);

        // 4. DEPOIS: a memória RELIDA DO DISCO (processo novo) + a descoberta.
        const doDisco = lerMemoria(caminho, rede);
        assert.ok(doDisco !== null, 'a memória gravada tem de voltar do disco');
        assert.equal(doDisco.pools.length, js.memoria.pools.length,
            'a memória relida tem de ter os mesmos pools: persistência que perde pool não serve');
        const jd = juntar(doDisco, deDescoberta(agora.concentrados, rede, AVALIA));
        const depoisPools = new Set(jd.memoria.pools.map((q) => q.endereco));
        const depoisRotas = candidatasMistas(paraRotas(jd.memoria), WETH_DA_BASE);
        const depoisCobertos = alvos.filter((a) => depoisPools.has(a));
        const depoisSobreAlvos = depoisRotas.filter(
            (c) => c.pernas.every((x) => alvos.includes(x.pool.toLowerCase())),
        );
        console.log(`    DEPOIS (memória do disco + a MESMA descoberta):`);
        console.log(`      ${jd.memoria.pools.length} pool(s) lembrado(s) |`
            + ` cobertura dos alvos ${depoisCobertos.length}/${alvos.length}`
            + ` | ${depoisRotas.length} rota(s) | sobre os alvos: ${depoisSobreAlvos.length}`);
        console.log(`      novos nesta junção: ${jd.novas.length},`
            + ` já conhecidos revistos: ${jd.atualizadas},`
            + ` descartados por teto: ${jd.descartadosPorTeto}`);

        // 5. A COTAÇÃO, no estado FRESCO do bloco avaliado — a memória não tem
        //    preço, e é esta leitura que diz se a rota vale algo AGORA.
        let cotados = 0;
        let sinais = [];
        if (depoisSobreAlvos.length > 0) {
            const L = await lerEstadoMisto(chamar, depoisSobreAlvos, AVALIA, 'latest');
            const tri = triarCandidatas(depoisSobreAlvos, WETH_DA_BASE, L);
            const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
            const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
            const art = await hre.artifacts.readArtifact('CacadorV3');
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
            sinais = await cotarAfetadas(
                emLote, chamar, tri.valem, L, 'latest', AVALIA, Date.now(),
                baseFeeWei, art.deployedBytecode,
            );
            console.log(`      TRIAGEM: ${tri.valem.length} passaram de`
                + ` ${depoisSobreAlvos.length} | baseFee ${baseFeeWei}`
                + ` + gorjeta ${GORJETA_PADRAO_WEI}`);
            for (const s of sinais) {
                console.log(`      COTAÇÃO ${s.rota}`);
                console.log(`        tamanho ${s.melhorTamanho} | bruto ${s.lucroBrutoEstimado}`
                    + ` | custo ${s.custoTotalEstimado} | LÍQUIDO ${s.lucroLiquidoEstimado}`);
            }
            const aprovados = sinais.filter(
                (s) => s.lucroLiquidoEstimado !== null && s.lucroLiquidoEstimado > 0n,
            );
            console.log(`      DECISÃO: ${aprovados.length} de ${sinais.length} aprovada(s)`
                + `${aprovados.length === 0 ? ' — e recusar deficitária é o resultado certo' : ''}`);
        }

        console.log(`\n    RPC ao upstream: ${pedidosUpstream} pedido(s) (teto ${TETO_DE_RPC})`);
        console.log(`    cotações no fork: ${cotados}`);

        // --- AS AFIRMACOES ---
        assert.equal(antesCobertos.length, 0,
            'o ANTES tem de perder os alvos, senão este histórico não exercita o defeito');
        assert.equal(antesSobreAlvos.length, 0, 'sem cobertura não pode haver rota sobre os alvos');
        assert.equal(naSemente.length, alvos.length,
            'a semente tem de aprender os dois alvos — ela é uma janela em que eles negociaram');
        assert.equal(depoisCobertos.length, alvos.length,
            'DEPOIS a cobertura dos alvos tem de ser total: é o que a memória conserta');
        assert.ok(depoisSobreAlvos.length > 0,
            'cobertura sem rota não vale nada: o gerador tem de emitir o ciclo dos dois');
        assert.ok(depoisRotas.length > antesRotas.length,
            `as rotas têm de crescer: ${antesRotas.length} -> ${depoisRotas.length}`);
        assert.ok(cotados > 0, 'a rota nova tem de ser COTADA no estado fresco, não presumida');
        for (const s of sinais) {
            if (s.custoTotalEstimado !== null) continue;
            assert.equal(s.lucroLiquidoEstimado, null, 'líquido sem custo seria lucro inventado');
        }
        assert.ok(pedidosUpstream <= TETO_DE_RPC,
            `orçamento de RPC estourado: ${pedidosUpstream} > ${TETO_DE_RPC}`);
        rmSync(caminho, { force: true });
    });
});
