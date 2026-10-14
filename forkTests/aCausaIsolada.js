// A CAUSA, ISOLADA PECA POR PECA — e a verificacao do isolamento de saldo.
//
// Em 2026-10-14 o filtro condenou CINCO tokens a partir de DUAS rotas que
// reverteram, e com isso excluiu 1.254 de 1.256 candidatos. A dona do bot
// recusou: *"NÃO ACEITO ESSA CONCLUSÃO ENQUANTO A EXCLUSÃO NÃO FOR CAUSALMENTE
// COMPROVADA."* Certo — "zero oportunidades" ali significava "o meu filtro
// desistiu".
//
// Aqui cada peca e testada SOZINHA, no fork:
//
//   TOKEN   transferencia direta de um detentor real para uma conta nova. O que
//           chega contra o que saiu da uma fracao MEDIDA. Reverter tambem e
//           evidencia, e das boas
//   POOL    um swap de UMA perna, com um token que passou no teste isolado. Se
//           o token passa e o pool recusa, o pool e o culpado
//   EXECUTOR  pecas passam e a rota cai com erro de conta nossa -> defeito NOSSO
//
// E o ponto 5 dela, que apontou um defeito que eu havia introduzido: o
// `FlashArbN` lia `balanceOf` cru, entao um saldo PREEXISTENTE do contrato
// entrava na conta da rota — seria vendido junto e apurado como lucro. O teste
// `isolamento` abaixo pre-carrega o contrato e exige que a operacao nao toque
// nesse saldo.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');
const Decimal = require('decimal.js');

const {
    descobrirUniverso, lerPools, precoDoGasWei, WETH_DA_BASE,
} = require('../dist/cacarArbitragem.js');
const {
    acharRotas, melhorTamanhoDaRota, semDuplicacaoEconomica, comoLerARota,
} = require('../dist/rotas.js');
const { julgarFalha, comoLerOVeredicto, retidoPorMil } = require('../dist/causaDaFalha.js');
const {
    somarCusto, julgar, codificarGetL1Fee, ORACULO_DE_GAS_L1, GORJETA_PADRAO_WEI,
} = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const S = {
    balanceOf: sel('balanceOf(address)'),
    token0: sel('token0()'),
    token1: sel('token1()'),
    getReserves: sel('getReserves()'),
};
const erc20 = new Interface(['function transfer(address to, uint256 v) returns (bool)']);
const nIface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint16 taxaPorDezMil)[] pernas, uint256 quantidade, uint256 lucroMinimo)',
    'function sacar(address token)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);
const ler = async (to, data) => {
    try { return await chamar('eth_call', [{ to, data }, 'latest']); } catch { return null; }
};
const num = (h) => (h && h !== '0x' ? BigInt(h) : null);
const endDe = (h) => (h && h.length >= 42 ? `0x${h.slice(-40)}`.toLowerCase() : null);
const enviar = async (de, para, dados, gas = '0x1000000') => {
    const campos = { from: de, data: dados, gas };
    if (para) campos.to = para;
    const tx = await chamar('eth_sendTransaction', [campos]);
    return chamar('eth_getTransactionReceipt', [tx]);
};
const saldo = async (t, de) => num(await ler(
    t, S.balanceOf + coder.encode(['address'], [de]).slice(2),
)) ?? 0n;

/**
 * SONDA DE TOKEN: transferencia direta de um pool que o detem para uma conta
 * nova e vazia. Conta nova de proposito — um destino com saldo esconderia um
 * token que mexe em saldo de terceiros.
 */
async function sondarToken(token, detentor, destino) {
    const base = {
        token, rodou: false, enviado: null, recebido: null, reverteu: false, porque: '',
    };
    const tem = await saldo(token, detentor);
    if (tem <= 0n) {
        return { ...base, porque: `o detentor ${detentor} não tem o token: sonda NÃO rodou` };
    }
    const enviado = tem / 1000n;
    if (enviado <= 0n) return { ...base, porque: 'saldo do detentor pequeno demais para medir' };
    await chamar('hardhat_impersonateAccount', [detentor]);
    await chamar('hardhat_setBalance', [detentor, '0x56BC75E2D63100000']);
    const antes = await saldo(token, destino);
    let rec = null; let erro = null;
    try {
        rec = await enviar(detentor, token, erc20.encodeFunctionData('transfer', [destino, enviado]));
    } catch (e) { erro = String(e.message ?? e); }
    await chamar('hardhat_stopImpersonatingAccount', [detentor]);
    if (rec === null || rec.status !== '0x1') {
        return {
            ...base, rodou: true, enviado, reverteu: true,
            porque: `a transferência REVERTEU: ${(erro ?? 'sem motivo').slice(0, 110)}`,
        };
    }
    const recebido = (await saldo(token, destino)) - antes;
    return {
        ...base, rodou: true, enviado, recebido,
        porque: recebido === enviado
            ? 'entregou exatamente o que mandou'
            : `entregou ${recebido} de ${enviado}`,
    };
}

/**
 * SONDA DE POOL: o pool responde a interface do tipo que o motor declarou?
 *
 * DECLARADO, e a limitacao e o ponto principal desta funcao: isto prova que o
 * pool RESPONDE A INTERFACE, nao que ele aceita um swap. Um pool com callback
 * de outro nome passaria aqui. E por isso que `POOL_INCOMPATIVEL` exige que os
 * tokens tenham passado antes — a evidencia e fraca, e so vale quando nao sobra
 * outra explicacao sobre as PECAS.
 *
 * A PRIMEIRA versao desta sonda exigia WETH no pool e devolvia `rodou: false`
 * para todo pool intermediario. O efeito era pior que a limitacao: duas rotas
 * em que TODOS os tokens mediram limpos cairam em `CAUSA_DESCONHECIDA` porque a
 * sonda de pool "nao rodou" — e `CAUSA_DESCONHECIDA` ali escondia a resposta
 * que a propria reversao dava ('UniswapV2: K' e o invariante do pool recusando
 * a COMBINACAO). A sonda nao precisa de WETH para perguntar a cotacao: ela
 * pergunta na moeda do proprio pool.
 */
async function sondarPool(pool, tipo) {
    const base = { pool, rodou: false, passou: false, porque: '' };
    const [t0h, t1h, resh] = await Promise.all([
        ler(pool, S.token0), ler(pool, S.token1), ler(pool, S.getReserves),
    ]);
    const t0 = endDe(t0h); const t1 = endDe(t1h);
    if (t0 === null || t1 === null) {
        return { ...base, porque: 'o pool não respondeu token0/token1' };
    }
    if (tipo !== 1) {
        return {
            ...base, rodou: true, passou: !!resh && resh !== '0x',
            porque: !resh || resh === '0x'
                ? 'o pool declarado v2 NÃO responde getReserves()'
                : 'responde token0/token1/getReserves (NÃO prova que aceita swap)',
        };
    }
    // Aerodrome: a cotacao e do proprio pool, na moeda do proprio pool. Uma
    // unidade do token0 basta — o que se pergunta e se ele RESPONDE.
    const q = await ler(pool, sel('getAmountOut(uint256,address)')
        + coder.encode(['uint256', 'address'], [1_000_000n, t0]).slice(2));
    return {
        ...base, rodou: true, passou: q !== null && q !== '0x',
        porque: q === null || q === '0x'
            ? 'o pool declarado Aerodrome NÃO responde getAmountOut(uint256,address)'
            : 'responde getAmountOut do próprio tipo (NÃO prova que aceita swap)',
    };
}

describe('a causa isolada, peça por peça', function () {
    this.timeout(1_800_000);

    let bloco; let dono; let destino; let arbN; let cofre;
    let poolsParaRota; let avaliadas; let colapsadas; let rotas;
    let baseFeeWei;

    before(async function () {
        p = hre.network.provider;
        bloco = Number(await chamar('eth_blockNumber', []));
        const contas = await chamar('eth_accounts', []);
        [dono, cofre, destino] = contas;

        const universo = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 100));
        const lido = await lerPools(chamar, universo.pools, universo.porFabrica, bloco);
        poolsParaRota = lido.pools.map((q) => ({
            endereco: q.endereco, token0: q.token0, token1: q.token1,
            reserva0: q.reserva0, reserva1: q.reserva1,
            tipo: 'v2', taxaPorDezMil: 30, fabrica: q.fabrica,
        }));
        rotas = acharRotas(poolsParaRota, WETH_DA_BASE, {
            maxHops: 4, podeEmprestar: (q) => q.tipo === 'v2', teto: 40_000,
        });
        const brutas = [];
        for (const r of rotas) {
            const m = melhorTamanhoDaRota(r, 40);
            if (m === null || m.sobra <= 0n) continue;
            brutas.push({ rota: r, sobra: m.sobra, ...m });
        }
        const d = semDuplicacaoEconomica(brutas);
        avaliadas = d.unicas; colapsadas = d.colapsadas;

        const b = await chamar('eth_getBlockByNumber', ['latest', false]);
        baseFeeWei = BigInt(b.baseFeePerGas ?? '0x0');

        const art = await hre.artifacts.readArtifact('FlashArbN');
        const rec = await enviar(dono, undefined,
            art.bytecode + coder.encode(['address'], [cofre]).slice(2));
        assert.equal(rec.status, '0x1');
        arbN = rec.contractAddress;
        console.log(`    bloco ${bloco} | ${poolsParaRota.length} pools | ${rotas.length} rotas`
            + ` | ${avaliadas.length} com sobra positiva (${colapsadas} duplicadas colapsadas)`);
    });

    // CADA TESTE COMECA NO MESMO ESTADO. O pre-carregamento do teste de
    // isolamento tira WETH de um pool, e um pool V2 confere o invariante contra
    // `balanceOf`: sem isto, toda rota que passa por aquele pool reverte com
    // 'UniswapV2: K' no teste seguinte — por minha causa, nao pela rota. O
    // instantaneo e tomado DEPOIS do deploy, entao o contrato sobrevive aos
    // retornos; os instantaneos por rota, dentro do laco, voltam em LIFO.
    let instantaneoDoTeste;
    beforeEach(async function () {
        instantaneoDoTeste = await chamar('evm_snapshot', []);
    });
    afterEach(async function () {
        await chamar('evm_revert', [instantaneoDoTeste]);
    });

    it('ISOLAMENTO: a operação não consome saldo preexistente do contrato', async function () {
        // O ponto 5 dela, e ele apontou um defeito que eu havia INTRODUZIDO: ao
        // consertar o saque a descoberto eu passei a ler `balanceOf` cru, e com
        // isso o saldo preexistente entrava na conta da rota — seria vendido
        // junto e apurado como lucro que não é desta operação.
        // O MAIOR detentor de WETH entre os pools, nao o primeiro: o primeiro
        // pode ter reserva de poeira, e `/10_000` dela da ZERO — o pre-carga
        // nao chegaria e o teste reprovaria por escolha minha, nao por defeito.
        const comWeth = poolsParaRota
            .filter((q) => q.token0 === WETH_DA_BASE || q.token1 === WETH_DA_BASE)
            .map((q) => ({ q, weth: q.token0 === WETH_DA_BASE ? q.reserva0 : q.reserva1 }))
            .sort((a, b) => (a.weth < b.weth ? 1 : -1))[0];
        assert.ok(comWeth, 'preciso de um pool com WETH para a sonda');
        const detentor = comWeth.q.endereco;
        const quanto = (await saldo(WETH_DA_BASE, detentor)) / 10_000n;
        assert.ok(quanto > 0n, `o maior pool de WETH (${detentor}) não tem WETH suficiente `
            + 'para pré-carregar: a sonda de isolamento não pode rodar neste bloco');
        await chamar('hardhat_impersonateAccount', [detentor]);
        await chamar('hardhat_setBalance', [detentor, '0x56BC75E2D63100000']);
        await enviar(detentor, WETH_DA_BASE, erc20.encodeFunctionData('transfer', [arbN, quanto]));
        await chamar('hardhat_stopImpersonatingAccount', [detentor]);
        const preexistente = await saldo(WETH_DA_BASE, arbN);
        assert.equal(preexistente, quanto, 'o pré-carregamento não chegou');

        // Agora uma rota que FALHA: o saldo preexistente tem de ficar INTACTO.
        // Rota que falha é o caso difícil — se ela reverte, tudo volta; o teste
        // de verdade é a rota que PASSA, abaixo.
        if (avaliadas.length === 0) {
            console.log('    sem rota para o teste de isolamento neste bloco');
            this.skip();
            return;
        }
        const a = avaliadas[0];
        const pernas = a.rota.hops.map((h) => ({
            pool: h.pool.endereco, tokenEntra: h.de,
            tipo: h.pool.tipo === 'v2' ? 0 : 1, taxaPorDezMil: h.pool.taxaPorDezMil,
        }));
        let rec = null;
        try {
            rec = await enviar(dono, arbN, nIface.encodeFunctionData('executarRota',
                [pernas, a.quantia, (a.sobra * 8n) / 10n]));
        } catch { /* reverteu: o estado volta */ }
        const depois = await saldo(WETH_DA_BASE, arbN);
        if (rec === null || rec.status !== '0x1') {
            assert.equal(depois, preexistente,
                'a rota reverteu e o saldo preexistente mudou: isso é impossível sem bug');
            console.log(`    rota reverteu; saldo preexistente INTACTO (${depois})`);
        } else {
            // A rota PASSOU: o saldo final tem de ser preexistente + sobra, e a
            // sobra tem de ser MAIOR que zero. Se o contrato tivesse vendido o
            // preexistente, o final seria MENOR que o preexistente.
            assert.ok(depois >= preexistente,
                `a rota completou e o saldo caiu de ${preexistente} para ${depois}:`
                + ' a operação consumiu saldo preexistente');
            console.log(`    rota completou; preexistente ${preexistente} -> ${depois}`
                + ` (sobra desta rota: ${depois - preexistente})`);
        }

        // E o SAQUE manda tudo ao cofre imutável — inclusive o preexistente,
        // que é o comportamento certo: ele é do dono, não da rota.
        const antesCofre = await saldo(WETH_DA_BASE, cofre);
        await enviar(dono, arbN, nIface.encodeFunctionData('sacar', [WETH_DA_BASE]));
        assert.equal(await saldo(WETH_DA_BASE, arbN), 0n);
        assert.ok((await saldo(WETH_DA_BASE, cofre)) > antesCofre, 'o saque não chegou ao cofre');
    });

    it('SONDA cada peça e julga a causa — sem condenar por associação', async function () {
        if (avaliadas.length === 0) { this.skip(); return; }
        const teto = Number(process.env.ARB_SIMULAR ?? 8);
        const condenados = new Map(); // peca -> veredicto
        const porCausa = new Map();
        let testadas = 0; let reverteram = 0; let lucrativas = 0;
        let puladasComProva = 0;

        for (const a of avaliadas) {
            if (testadas >= teto) break;
            const r = a.rota;
            const pecas = [
                ...new Set(r.hops.flatMap((h) => [h.de, h.para, h.pool.endereco])),
            ];
            const jaCondenada = pecas.find((x) => condenados.has(x));
            if (jaCondenada !== undefined) { puladasComProva += 1; continue; }

            // ESTADO LIMPO POR ROTA, e isto conserta um defeito do MEU
            // experimento, nao do motor. Um pool V2 confere o invariante contra
            // `balanceOf`, nao contra `getReserves`. A sonda de token tira
            // saldo de um pool da rota, e o pre-carregamento do teste de
            // isolamento tira WETH de outro: depois disso, QUALQUER rota que
            // passe por esses pools reverte com 'UniswapV2: K' — e eu teria
            // lido a minha propria contaminacao como "a combinacao nao fecha".
            // Cada rota roda num instantaneo e o estado volta ao fim.
            const instantaneo = await chamar('evm_snapshot', []);
            try {
            const pernas = r.hops.map((h) => ({
                pool: h.pool.endereco, tokenEntra: h.de,
                tipo: h.pool.tipo === 'v2' ? 0 : 1, taxaPorDezMil: h.pool.taxaPorDezMil,
            }));
            const piso = (a.sobra * 8n) / 10n;
            const antes = await saldo(WETH_DA_BASE, arbN);
            const dados = nIface.encodeFunctionData('executarRota', [pernas, a.quantia, piso]);
            let rec = null; let erro = null;
            try { rec = await enviar(dono, arbN, dados); } catch (e) { erro = String(e.message ?? e); }
            testadas += 1;

            if (rec !== null && rec.status === '0x1') {
                const sobrou = (await saldo(WETH_DA_BASE, arbN)) - antes;
                const l1 = num(await ler(ORACULO_DE_GAS_L1,
                    codificarGetL1Fee(`0x${'02'.repeat(110 + dados.length / 2)}`)));
                const custo = somarCusto({
                    gasUsado: BigInt(rec.gasUsed), gasUsadoVeioDe: 'recibo',
                    baseFeeWei, gorjetaWei: GORJETA_PADRAO_WEI,
                    custoL1Wei: l1, taxaDoEmprestimoWei: 0n,
                });
                const j = julgar(sobrou, custo);
                if (j.veredicto === 'lucrativa') lucrativas += 1;
                porCausa.set(j.veredicto, (porCausa.get(j.veredicto) ?? 0) + 1);
                console.log(`    [${testadas}] ${j.veredicto.toUpperCase()} — ${comoLerARota(r)}`);
                console.log(`         realizado ${sobrou} | ${j.porque.slice(0, 150)}`);
                continue;
            }

            // REVERTEU: agora ISOLA cada peça antes de condenar qualquer uma.
            reverteram += 1;
            const tokensIncomuns = [...new Set(r.hops.flatMap((h) => [h.de, h.para]))]
                .filter((t) => t !== WETH_DA_BASE);
            const sondasDeToken = [];
            for (const t of tokensIncomuns) {
                // TODOS os detentores da rota, e fica a PIOR medicao.
                //
                // MEDIDO em 2026-10-14, e foi o que obrigou este laco: o token
                // `0x7787…734f` retem 479/1000 saindo de um pool da rota e
                // 0/1000 saindo de outro. A taxa dele nao e propriedade do
                // token sozinho — ela depende do PAR (quem manda, quem recebe),
                // porque o token isenta certos enderecos. Uma sonda unica mede
                // um par, nao o token, e publicar "retem 0/1000" a partir dela
                // seria absolver o token com a medicao mais favoravel.
                const detentores = r.hops.map((h) => h.pool)
                    .filter((q) => q.token0 === t || q.token1 === t)
                    .map((q) => q.endereco);
                if (detentores.length === 0) {
                    sondasDeToken.push({
                        token: t, rodou: false, enviado: null, recebido: null,
                        reverteu: false, porque: 'sem detentor conhecido na rota',
                    });
                    continue;
                }
                let pior = null;
                for (const d of [...new Set(detentores)]) {
                    // eslint-disable-next-line no-await-in-loop
                    const s = await sondarToken(t, d, destino);
                    const r1 = retidoPorMil(s);
                    const r0 = pior === null ? null : retidoPorMil(pior);
                    const melhorAteAgora = pior === null
                        || s.reverteu
                        || (!pior.reverteu && pior.rodou === false && s.rodou)
                        || (r1 !== null && (r0 === null || r1 > r0));
                    if (melhorAteAgora) {
                        pior = {
                            ...s,
                            porque: `${s.porque} (detentor ${d}; `
                                + `${detentores.length} detentor(es) na rota, fica a PIOR)`,
                        };
                    }
                    if (pior.reverteu) break;
                }
                sondasDeToken.push(pior);
            }
            const sondasDePool = [];
            for (const h of r.hops) {
                sondasDePool.push(await sondarPool(
                    h.pool.endereco, h.pool.tipo === 'v2' ? 0 : 1,
                ));
            }
            const v = julgarFalha({
                tokens: sondasDeToken, pools: sondasDePool,
                mensagemDaRota: erro ?? 'sem motivo',
            });
            porCausa.set(v.causa, (porCausa.get(v.causa) ?? 0) + 1);
            console.log(`    [${testadas}] ${comoLerARota(r)}`);
            console.log(`         ${(erro ?? '').slice(0, 110)}`);
            for (const s of sondasDeToken) {
                const ret = retidoPorMil(s);
                console.log(`         token ${s.token}: ${s.rodou ? `retém ${ret}/1000` : 'sonda NÃO rodou'}`
                    + ` — ${s.porque.slice(0, 80)}`);
            }
            console.log(`         >>> ${comoLerOVeredicto(v).slice(0, 220)}`);
            if (v.excluiPermanentemente) {
                for (const c of v.culpados) condenados.set(c.toLowerCase(), v);
            }
            } finally {
                await chamar('evm_revert', [instantaneo]);
            }
        }

        console.log(`\n    ROTAS TESTADAS ............ ${testadas}`);
        console.log(`    reverteram ................ ${reverteram}`);
        console.log(`    LUCRATIVAS (custo completo) ${lucrativas}`);
        console.log(`    peças excluídas COM PROVA .. ${condenados.size}`);
        console.log(`    rotas puladas por prova .... ${puladasComProva}`);
        console.log(`    causas: ${[...porCausa.entries()].map(([k, n]) => `${k}=${n}`).join(' | ')}`);

        // QUANTAS das 509 cada peca PROVADA responde, e quantas sobram sem
        // nenhuma peca provada. Sem esta quebra, "505 puladas" e um numero so,
        // e nao da para auditar se a poda e concentrada numa peca medida ou
        // espalhada. E a pergunta dela: a exclusao e causalmente comprovada?
        const porPeca = new Map();
        let sobrevivem = 0;
        for (const a of avaliadas) {
            const pecas = [...new Set(a.rota.hops.flatMap((h) => [h.de, h.para, h.pool.endereco]))]
                .map((x) => x.toLowerCase());
            const culpas = pecas.filter((x) => condenados.has(x));
            if (culpas.length === 0) { sobrevivem += 1; continue; }
            for (const c of culpas) porPeca.set(c, (porPeca.get(c) ?? 0) + 1);
        }
        console.log('\n    A PODA, peça por peça (uma rota pode tocar mais de uma):');
        for (const [c, n] of [...porPeca.entries()].sort((a, b) => b[1] - a[1])) {
            const v = condenados.get(c);
            console.log(`    ${c}  ${n} de ${avaliadas.length} rotas  [${v.causa}]`);
        }
        console.log(`    rotas que NÃO tocam nenhuma peça provada: ${sobrevivem}`);
        console.log('    LEITURA: a sobra positiva destas rotas vinha da taxa de transferência —'
            + ' um token taxado faz a reserva do pool parecer mal precificada, então ele SOBE no'
            + ' ranking de sobra. A exclusão é por transferência MEDIDA, token por token, não por'
            + ' associação.');
        console.log(`    COBERTURA: ${poolsParaRota.length} pools, ${rotas.length} rotas,`
            + ` ${avaliadas.length} com sobra positiva, ${colapsadas} duplicadas colapsadas`);
        // NENHUMA peça pode estar condenada sem evidência isolada sobre ela.
        for (const [peca, v] of condenados) {
            assert.ok(v.culpados.map((x) => x.toLowerCase()).includes(peca),
                `${peca} foi condenada sem constar nos culpados do veredicto`);
            assert.ok(v.causa === 'TOKEN_HOSTIL' || v.causa === 'POOL_INCOMPATIVEL',
                `${peca} condenada por ${v.causa}, que NÃO exclui peça`);
        }
    });
});
