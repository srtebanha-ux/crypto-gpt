// O TITAN CONTRA OS OPERADORES QUE GANHAM — no estado ANTERIOR a operacao.
//
// Item B dela: *"O TITAN reproduzindo e avaliando essas oportunidades em fork,
// sem informação futura."*
//
// O benchmark (`.tmp/benchmarkDeArbitragem.json`, de `src/varrerQuemGanha.ts`)
// tem arbitragens REAIS e lucrativas, com lucro medido por delta de saldo e
// custo lido do recibo. Aqui o fork e posicionado no bloco ANTERIOR a cada uma
// e o motor do TITAN roda com o que existia naquele instante. Nada do futuro:
// nem o hash, nem o tamanho, nem a rota do vencedor entram na busca.
//
// AS QUATRO RESPOSTAS POSSIVEIS, e elas pedem acoes diferentes:
//
//   FORA DO UNIVERSO   o TITAN nao conhece os pools da operacao. Nao e defeito
//                      de matematica nem de latencia: e cobertura
//   CONHECIA E ACHOU   o motor achou um ciclo pelos mesmos pools. Aí a conta
//                      economica decide, e e comparavel com o vencedor
//   CONHECIA E NAO VIU o motor tinha os pools e nao achou ciclo: defeito de
//                      deteccao, e e o caso que vale consertar
//   NAO DEU PARA DIZER o fork nao pos o estado de pe. Nao condena nem absolve
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');

const {
    descobrirUniverso, universoPorAtividade, lerPools, WETH_DA_BASE,
    FABRICAS_COM_FLASH_SWAP,
} = require('../dist/cacarArbitragem.js');
const { acharRotas, melhorTamanhoDaRota, comoLerARota } = require('../dist/rotas.js');

const CAMINHO = process.env.QG_BENCHMARK ?? '.tmp/benchmarkDeArbitragem.json';

let p;
const chamar = (m, ps) => p.send(m, ps);

describe('o TITAN contra os operadores que ganham', function () {
    this.timeout(3_600_000);

    it('avalia as operações reais no bloco ANTERIOR, sem informação futura', async function () {
        if (!existsSync(CAMINHO)) {
            console.log(`    sem benchmark em ${CAMINHO}: rode src/varrerQuemGanha.ts primeiro.`);
            console.log('    Isto é FALTA DE DADO, não "o TITAN passou".');
            this.skip();
            return;
        }
        p = hre.network.provider;
        const b = JSON.parse(readFileSync(CAMINHO, 'utf8'));
        const url = hre.config.networks.hardhat.forking.url;
        const fabricas = new Set(FABRICAS_COM_FLASH_SWAP.map((x) => x.toLowerCase()));

        // AS MAIORES primeiro: e onde esta o dinheiro, e o orçamento e limitado.
        const quantas = Number(process.env.QG_REPLAY ?? 6);
        const alvos = [...b.operacoes]
            .sort((x, y) => (BigInt(y.liquidoWei) > BigInt(x.liquidoWei) ? 1 : -1))
            .slice(0, quantas);

        const linhas = [];
        for (const op of alvos) {
            const anterior = op.bloco - 1;
            let universo = null;
            let pools = null;
            try {
                // eslint-disable-next-line no-await-in-loop
                await chamar('hardhat_reset', [{
                    forking: { jsonRpcUrl: url, blockNumber: anterior },
                }]);
                // eslint-disable-next-line no-await-in-loop
                universo = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 100));
                // eslint-disable-next-line no-await-in-loop
                const lido = await lerPools(chamar, universo.pools, universo.porFabrica, anterior);
                pools = lido.pools;
            } catch (e) {
                linhas.push({
                    op, veredicto: 'NAO DEU PARA DIZER',
                    porque: `o fork não pôs o bloco ${anterior} de pé: ${String(e).slice(0, 60)}`,
                });
                continue;
            }

            // 1b. O UNIVERSO POR ATIVIDADE, no MESMO bloco anterior.
            //
            // Item 8.6 dela: *"Quais mudanças no motor aumentaram
            // comprovadamente a capacidade de detecção."* A comparacao e entre
            // ler `allPairs[0..N]` (prefixo por indice de criacao) e ler os
            // pools que EMITIRAM `Swap` nos blocos anteriores. Os dois rodam no
            // mesmo bloco, sem informacao do futuro.
            let porAtividade = null;
            try {
                // eslint-disable-next-line no-await-in-loop
                porAtividade = await universoPorAtividade(chamar, {
                    blocos: Number(process.env.QG_ATIV_BLOCOS ?? 20),
                    tetoDePools: 300,
                });
            } catch { porAtividade = null; }

            // 1. O TITAN CONHECE OS POOLS DA OPERACAO?
            const conhecidos = new Set(pools.map((q) => q.endereco.toLowerCase()));
            const daOperacao = op.pools.map((x) => x.toLowerCase());
            const vistos = daOperacao.filter((x) => conhecidos.has(x));

            // E, se nao conhece, a pergunta seguinte: eles sao de uma fabrica
            // que o TITAN varre? Isso separa "nao varri este pool" de "este
            // pool nem e do tipo que eu sei emprestar".
            const deFabricaNossa = [];
            for (const pool of daOperacao) {
                try {
                    // `factory()` responde em pool V2; em V3 tambem, e o
                    // endereco da fabrica e que decide.
                    // eslint-disable-next-line no-await-in-loop
                    const r = await chamar('eth_call', [{
                        to: pool, data: '0xc45a0155',
                    }, 'latest']);
                    const f = r && r.length >= 42 ? `0x${r.slice(-40)}`.toLowerCase() : null;
                    deFabricaNossa.push({ pool, fabrica: f, nossa: f !== null && fabricas.has(f) });
                } catch {
                    deFabricaNossa.push({ pool, fabrica: null, nossa: false });
                }
            }

            const porAtiv = porAtividade === null
                ? null
                : new Set(porAtividade.pools.map((x) => x.toLowerCase()));
            const vistosPorAtiv = porAtiv === null
                ? [] : daOperacao.filter((x) => porAtiv.has(x));
            const compara = porAtividade === null
                ? 'atividade: NÃO MEDIDA neste bloco'
                : `atividade: ${porAtividade.pools.length} pool(s) ativos`
                    + ` (${porAtividade.poolsVistos} vistos negociando,`
                    + ` ${porAtividade.recusadosPorFabrica} recusados por fábrica) ->`
                    + ` cobre ${vistosPorAtiv.length}/${daOperacao.length}`;

            if (vistos.length === 0) {
                const fs = deFabricaNossa.map((x) => x.fabrica ?? 'sem factory()');
                const nossas = deFabricaNossa.filter((x) => x.nossa).length;
                linhas.push({
                    op,
                    veredicto: 'FORA DO UNIVERSO',
                    cobreIndice: 0,
                    cobreAtividade: vistosPorAtiv.length,
                    deFabricaNossa: nossas,
                    porque: `índice: nenhum dos ${daOperacao.length} pool(s) está entre os `
                        + `${pools.length} lidos, apesar de ${nossas} ser(em) de fábrica que o `
                        + `TITAN varre. Fábricas: ${[...new Set(fs)].join(', ')}. ${compara}`,
                });
                continue;
            }

            // 2. CONHECE: o motor acha um ciclo que passe por eles?
            const paraRota = pools.map((q) => ({
                endereco: q.endereco, token0: q.token0, token1: q.token1,
                reserva0: q.reserva0, reserva1: q.reserva1,
                tipo: 'v2', taxaPorDezMil: 30, fabrica: q.fabrica,
            }));
            const rotas = acharRotas(paraRota, WETH_DA_BASE, {
                maxHops: 4, podeEmprestar: (q) => q.tipo === 'v2', teto: 40_000,
            });
            const pelosMesmos = rotas.filter((r) => {
                const usados = new Set(r.hops.map((h) => h.pool.endereco.toLowerCase()));
                return vistos.some((x) => usados.has(x));
            });
            let melhor = null;
            for (const r of pelosMesmos) {
                const m = melhorTamanhoDaRota(r, 40);
                if (m === null || m.sobra <= 0n) continue;
                if (melhor === null || m.sobra > melhor.m.sobra) melhor = { r, m };
            }
            linhas.push({
                op,
                cobreIndice: vistos.length,
                cobreAtividade: vistosPorAtiv.length,
                deFabricaNossa: deFabricaNossa.filter((x) => x.nossa).length,
                veredicto: melhor === null ? 'CONHECIA E NAO VIU' : 'CONHECIA E ACHOU',
                porque: melhor === null
                    ? `conhecia ${vistos.length}/${daOperacao.length} pool(s) e nenhuma das `
                        + `${pelosMesmos.length} rota(s) por eles deu sobra positiva`
                    : `achou sobra ${melhor.m.sobra} em ${comoLerARota(melhor.r)}`,
                sobra: melhor === null ? null : melhor.m.sobra,
            });
        }

        // O RELATORIO: a comparacao que ela pediu, operacao por operacao.
        console.log('\n    OPERACAO REAL                           LUCRO REAL      O QUE O TITAN FEZ');
        for (const l of linhas) {
            const eth = Number(BigInt(l.op.liquidoWei)) / 1e18;
            console.log(`    ${l.op.tx.slice(0, 14)}… b${l.op.bloco} [${l.op.dexes.join('+')}]`
                + `  ${eth.toFixed(8)} WETH  ${l.veredicto}`);
            console.log(`        ${l.porque}`);
        }

        const conta = new Map();
        for (const l of linhas) conta.set(l.veredicto, (conta.get(l.veredicto) ?? 0) + 1);
        console.log('\n    O FUNIL DE COMPETITIVIDADE:');
        console.log(`    operações reais lucrativas no benchmark ... ${b.lucrativas}`);
        console.log(`    reavaliadas aqui (as maiores) ............. ${linhas.length}`);
        for (const [v, n] of conta) console.log(`    ${v} ${'.'.repeat(Math.max(1, 34 - v.length))} ${n}`);
        // A COMPARACAO DOS DOIS UNIVERSOS, somada.
        const somaI = linhas.reduce((a, l) => a + (l.cobreIndice ?? 0), 0);
        const somaA = linhas.reduce((a, l) => a + (l.cobreAtividade ?? 0), 0);
        const somaF = linhas.reduce((a, l) => a + (l.deFabricaNossa ?? 0), 0);
        const totalPools = linhas.reduce((a, l) => a + l.op.pools.length, 0);
        console.log(`\n    COBERTURA DOS POOLS DOS VENCEDORES (${totalPools} pool(s) em`
            + ` ${linhas.length} operação(ões)):`);
        console.log(`    de fábrica que o TITAN sabe emprestar ... ${somaF}`);
        console.log(`    universo por ÍNDICE (allPairs[0..N]) .... ${somaI}`);
        console.log(`    universo por ATIVIDADE (Swap recente) ... ${somaA}`);
        console.log('    LEITURA: a diferença entre as duas últimas linhas é capacidade de'
            + ' detecção que a mudança de universo adiciona, medida nos pools que de fato'
            + ' produziram lucro. A primeira linha é o teto do mecanismo atual.');

        const totalReal = b.operacoes.reduce((a, o) => a + BigInt(o.liquidoWei), 0n);
        const soV2 = b.operacoes.filter((o) => o.dexes.length === 1 && o.dexes[0] === 'v2');
        const lucroV2 = soV2.reduce((a, o) => a + BigInt(o.liquidoWei), 0n);
        console.log(`\n    lucro real somado .............. ${Number(totalReal) / 1e18} WETH`);
        console.log(`    em operações SÓ de V2 .......... ${Number(lucroV2) / 1e18} WETH`
            + ` (${totalReal > 0n ? Number((lucroV2 * 100n) / totalReal) : 0}%)`);
        console.log('    O V2 é o único universo que o TITAN empresta hoje. O resto exige'
            + ' liquidez concentrada ou outro mecanismo de flash.');
        console.log(`    COBERTURA do benchmark: ${b.blocosVarridos} blocos`
            + ` (${b.primeiroBloco}..${b.topo}), ${b.coberturaPct}% dos blocos lidos,`
            + ` ${b.candidatas} candidatas com 2+ trocas, ${b.lucrativas} lucrativas.`);

        assert.ok(linhas.length > 0, 'nenhuma operação foi reavaliada');
        // O portao: um veredicto por operacao, e nenhum inventado.
        for (const l of linhas) {
            assert.ok(['FORA DO UNIVERSO', 'CONHECIA E ACHOU', 'CONHECIA E NAO VIU',
                'NAO DEU PARA DIZER'].includes(l.veredicto), `veredicto estranho: ${l.veredicto}`);
        }
    });
});
