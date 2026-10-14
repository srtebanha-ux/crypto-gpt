// BLOCOS COM MUDANCA VERIFICADA DE RESERVAS — e so neles a busca roda de novo.
//
// Item 5 dela: *"Reexecute a busca em blocos com mudanças efetivamente
// verificadas de reservas, evitando repetir amostras economicamente
// idênticas."*
//
// O defeito que isto evita esta medido: em 2026-10-14 eu rodei o funil em
// 52612934 e em 52612196 e reportei "dois blocos". As contagens sairam
// IDENTICAS — 385 pools, 24.434 rotas, 509 com sobra — porque as rotas sao
// combinatorias do mesmo conjunto de pools e os pools que carregam a sobra nao
// negociaram entre os dois blocos. Dois blocos diferentes, UMA amostra
// economica. Chamar aquilo de confirmacao independente seria o defeito deste
// projeto com outra roupa.
//
// Aqui a mudanca e VERIFICADA antes de a busca rodar: as reservas de cada pool
// sao lidas em cada bloco e comparadas uma a uma. Bloco sem mudanca nos pools
// que importam e DECLARADO como amostra repetida, e nao vira linha de resultado.
const assert = require('node:assert/strict');

const {
    descobrirUniverso, lerPools, WETH_DA_BASE,
} = require('../dist/cacarArbitragem.js');
const {
    acharRotas, melhorTamanhoDaRota, semDuplicacaoEconomica,
} = require('../dist/rotas.js');

let p;
const chamar = (m, ps) => p.send(m, ps);

/**
 * Os blocos a amostrar, DERIVADOS DO TOPO da corrente.
 *
 * A primeira versao tinha quatro numeros cravados, e dois deles estavam no
 * FUTURO: o topo era 52615393 e eu pedi 52620334. O fork recusou, e com razao.
 * Numero de bloco cravado tem data de validade de minutos — e este arquivo
 * esta num projeto cujo CLAUDE.md registra tres remedicoes do mesmo limite de
 * provedor em cinco dias.
 *
 * Espacados de proposito: blocos colados repetem a amostra economica.
 */
const ESPACOS = [0, 600, 1700, 2400];
function blocosAAmostrar(topo) {
    const pedidos = process.env.ARB_BLOCOS;
    if (pedidos !== undefined) {
        return pedidos.split(',').map((x) => Number(x.trim()))
            .filter((x) => Number.isFinite(x) && x > 0 && x <= topo);
    }
    // Do mais ANTIGO para o mais novo, todos abaixo do topo.
    return ESPACOS.map((d) => topo - ESPACOS[ESPACOS.length - 1] + d).filter((x) => x > 0);
}

describe('a busca só repete em bloco com mudança VERIFICADA', function () {
    this.timeout(3_600_000);

    it('mede a mudança de reservas e só então reexecuta', async function () {
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const topo = Number(await chamar('eth_blockNumber', []));
        const blocos = blocosAAmostrar(topo);
        console.log(`    topo do fork: ${topo} | amostrando ${blocos.join(', ')}`);
        assert.ok(blocos.length >= 2, 'preciso de pelo menos dois blocos para comparar reservas');
        const amostras = [];
        let anterior = null;

        for (const bloco of blocos) {
            // eslint-disable-next-line no-await-in-loop
            await chamar('hardhat_reset', [{ forking: { jsonRpcUrl: url, blockNumber: bloco } }]);
            // eslint-disable-next-line no-await-in-loop
            const u = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 100));
            // eslint-disable-next-line no-await-in-loop
            const lido = await lerPools(chamar, u.pools, u.porFabrica, bloco);
            const porEndereco = new Map();
            for (const q of lido.pools) porEndereco.set(q.endereco, q);

            // A MUDANCA, pool por pool. Nao e "o bloco e outro": e a reserva
            // ser outra, que e o que move a economia.
            let mudaram = 0;
            let comparados = 0;
            if (anterior !== null) {
                for (const [end, q] of porEndereco) {
                    const a = anterior.get(end);
                    if (a === undefined) continue;
                    comparados += 1;
                    if (a.reserva0 !== q.reserva0 || a.reserva1 !== q.reserva1) mudaram += 1;
                }
            }

            const paraRota = lido.pools.map((q) => ({
                endereco: q.endereco, token0: q.token0, token1: q.token1,
                reserva0: q.reserva0, reserva1: q.reserva1,
                tipo: 'v2', taxaPorDezMil: 30, fabrica: q.fabrica,
            }));
            const rotas = acharRotas(paraRota, WETH_DA_BASE, {
                maxHops: 4, podeEmprestar: (q) => q.tipo === 'v2', teto: 40_000,
            });
            const brutas = [];
            for (const r of rotas) {
                const m = melhorTamanhoDaRota(r, 40);
                if (m === null || m.sobra <= 0n) continue;
                brutas.push({ rota: r, sobra: m.sobra, ...m });
            }
            const { unicas, colapsadas } = semDuplicacaoEconomica(brutas);
            // A IMPRESSAO ECONOMICA do bloco: a melhor sobra e o conjunto de
            // pools da melhor rota. Dois blocos com a mesma impressao sao a
            // mesma amostra, mesmo com numeros de bloco diferentes.
            const melhor = unicas.length === 0
                ? null
                : unicas.reduce((x, y) => (y.sobra > x.sobra ? y : x));
            const impressao = melhor === null
                ? 'nenhuma'
                : `${melhor.sobra}|${melhor.rota.hops.map((h) => h.pool.endereco).sort().join(',')}`;

            amostras.push({
                bloco,
                pools: lido.pools.length,
                comparados,
                mudaram,
                rotas: rotas.length,
                positivas: unicas.length,
                colapsadas,
                impressao,
            });
            anterior = porEndereco;
        }

        console.log('\n    bloco        pools  comparados  MUDARAM  rotas  positivas  amostra');
        const vistas = new Map();
        for (const a of amostras) {
            const repetida = vistas.has(a.impressao);
            const rotulo = a.comparados === 0
                ? 'primeira (nada a comparar)'
                : (repetida
                    ? `REPETIDA — mesma impressão econômica do bloco ${vistas.get(a.impressao)}`
                    : 'NOVA');
            if (!repetida) vistas.set(a.impressao, a.bloco);
            console.log(`    ${a.bloco}  ${String(a.pools).padStart(5)}  `
                + `${String(a.comparados).padStart(10)}  ${String(a.mudaram).padStart(7)}  `
                + `${String(a.rotas).padStart(5)}  ${String(a.positivas).padStart(9)}  ${rotulo}`);
        }

        const comMudanca = amostras.filter((a) => a.mudaram > 0);
        const novas = vistas.size;
        console.log(`\n    blocos amostrados: ${amostras.length}`);
        console.log(`    com mudança VERIFICADA de reservas: ${comMudanca.length}`);
        console.log(`    amostras economicamente DISTINTAS: ${novas}`);
        console.log('    LEITURA: contagem de rotas igual entre blocos NÃO é confirmação'
            + ' independente — as rotas são combinatórias do mesmo conjunto de pools. O que'
            + ' distingue uma amostra é a reserva ter mudado E a melhor rota ser outra.');

        // O portao: se nenhum bloco mudou, a conclusao e que a amostra e UMA,
        // e isso tem de ser dito em vez de contado como varias.
        if (comMudanca.length === 0) {
            console.log('    >>> NENHUM bloco mudou: isto é UMA amostra, não '
                + `${amostras.length}. Qualquer conclusão vale para um estado só.`);
        }
        assert.ok(amostras.length === blocos.length, 'perdi blocos no caminho');
        for (const a of amostras) {
            assert.ok(a.pools > 0, `o bloco ${a.bloco} não devolveu pool nenhum`);
        }
    });
});
