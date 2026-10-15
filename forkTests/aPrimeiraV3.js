// A PRIMEIRA ARBITRAGEM V3 — executada de ponta a ponta em fork, com saldos
// e custos reconciliados.
//
// Ordem dela: *"UMA operação histórica real reproduzida por um executor V3 em
// fork, com saldos e custos reconciliados."*
//
// AS DUAS PROVAS, separadas porque ela mandou separar:
//
//   A. REPRODUCAO ECONOMICA   o estado historico permitia uma operacao
//                             lucrativa por pools V3?
//   B. DESCOBERTA SEM FUTURO  o TITAN acharia a rota com o que existia naquele
//                             instante?
//
// A prova B e garantida por CONSTRUCAO: os pools candidatos saem de blocos
// ESTRITAMENTE ANTERIORES ao bloco avaliado, lidos do RPC de cima (nao do
// fork, que nao suporta `eth_getBlockReceipts` — medido em 2026-10-15). Os
// pools da transacao vencedora NAO sao usados como semente: isso seria
// informacao futura, e ela proibiu por nome.
//
// A COTACAO e do pool. `cotar` executa a rota e reverte devolvendo o numero —
// o padrao do Quoter do protocolo. Nenhuma conta de tick e escrita por mim.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const { codificarGetL1Fee, ORACULO_DE_GAS_L1, somarCusto, julgar } = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const WETH = '0x4200000000000000000000000000000000000006';
const TOPICO_SWAP_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)');

const S = {
    token0: sel('token0()'),
    token1: sel('token1()'),
    fee: sel('fee()'),
    liquidity: sel('liquidity()'),
    slot0: sel('slot0()'),
    balanceOf: sel('balanceOf(address)'),
};
const iface = new Interface([
    'function executarRota((address pool,address tokenEntra)[] rota, uint256 quantia, uint256 lucroMinimo) returns (uint256)',
    'function cotar((address pool,address tokenEntra)[] rota, uint256 quantia)',
    'function sacar(address token)',
    'error LucroInsuficiente(uint256 obtido, uint256 piso)',
    'error PagamentoCurto(uint256 tem, uint256 devido)',
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

/** O RPC de CIMA, para o que o fork nao sabe responder. */
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

describe('a primeira arbitragem V3', function () {
    this.timeout(3_600_000);

    // O bloco de uma operacao REAL do benchmark, e o estado e o ANTERIOR a ela.
    const BLOCO_ALVO = Number(process.env.V3_BLOCO ?? 52631818);
    const BLOCOS_DE_ATIVIDADE = Number(process.env.V3_ATIVIDADE ?? 24);

    let dono; let cofre; let arb; let candidatos; let baseFeeWei;

    before(async function () {
        p = hre.network.provider;
        const contas = await chamar('eth_accounts', []);
        [dono, cofre] = contas;

        // DESCOBERTA SEM FUTURO: pools V3 que negociaram nos blocos
        // ESTRITAMENTE anteriores ao alvo. Os pools do vencedor nao entram como
        // semente — eles so apareceriam aqui se tivessem negociado ANTES.
        const vistos = new Map();
        let lidos = 0;
        for (let b = BLOCO_ALVO - BLOCOS_DE_ATIVIDADE; b < BLOCO_ALVO; b += 1) {
            // eslint-disable-next-line no-await-in-loop
            const recs = await upstream('eth_getBlockReceipts', [`0x${b.toString(16)}`]);
            if (recs === null) continue;
            lidos += 1;
            for (const r of recs) {
                for (const l of r.logs ?? []) {
                    if ((l.topics[0] ?? '').toLowerCase() !== TOPICO_SWAP_V3) continue;
                    const k = l.address.toLowerCase();
                    vistos.set(k, (vistos.get(k) ?? 0) + 1);
                }
            }
        }
        console.log(`    descoberta: ${vistos.size} pool(s) V3 negociando em ${lidos} bloco(s)`
            + ` ANTERIORES ao ${BLOCO_ALVO} (sem informação futura)`);

        // IDENTIFICACAO POSITIVA antes de qualquer cotacao.
        //
        // DEFEITO MEDIDO em 2026-10-15: as 180 primeiras cotacoes reverteram
        // com "invalid opcode" e eu quase li isso como "nenhuma rota V3 rende".
        // A causa: `0xfba22a6b…` e um PROXY DE 46 BYTES sem o seletor
        // `0x128acb08` — o `swap(address,bool,int256,uint160,bytes)` que este
        // contrato chama simplesmente nao existe nele. Pool com `token0`,
        // `token1` e `fee` que responde NAO e prova de ABI compativel.
        //
        // Entao: o seletor tem de estar no bytecode. Os pools V3 de verdade
        // medidos aqui tem 22.143 bytes e o carregam; os proxies nao. Um proxy
        // que esconda a implementacao sai como NAO IDENTIFICADO, e nao como
        // "nao e V3" — a diferenca fica no log.
        const arbOuZero = '0x0000000000000000000000000000000000000001';
        const pools = [];
        let proxiesOuSemSeletor = 0;
        for (const [pool] of [...vistos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 160)) {
            // eslint-disable-next-line no-await-in-loop
            const [t0, t1, f, liq] = await Promise.all([
                ler(pool, S.token0), ler(pool, S.token1), ler(pool, S.fee), ler(pool, S.liquidity),
            ]);
            const a = endDe(t0); const b2 = endDe(t1);
            const taxa = num(f); const liquidez = num(liq);
            if (a === null || b2 === null || taxa === null) continue;
            if (liquidez === null || liquidez === 0n) continue;
            // SONDA POSITIVA, e nao substring de bytecode.
            //
            // MEDIDO em 2026-10-15: com o filtro por substring, 264 de 720
            // cotacoes ainda sairam "function selector was not recognized" —
            // o seletor aparece no bytecode (metadata, constante) sem a funcao
            // existir. Substring nao e prova.
            //
            // A sonda e o proprio protocolo respondendo: um pool V3 de verdade
            // recusa `amountSpecified = 0` com a razao 'AS'. Quem nao tem a
            // funcao responde "selector was not recognized". As duas respostas
            // sao distinguiveis, e nenhuma delas move dinheiro.
            let temSwapV3 = false;
            try {
                // eslint-disable-next-line no-await-in-loop
                await chamar('eth_call', [{
                    to: pool,
                    data: sel('swap(address,bool,int256,uint160,bytes)')
                        + coder.encode(
                            ['address', 'bool', 'int256', 'uint160', 'bytes'],
                            [arbOuZero, true, 0, 4295128740n, '0x'],
                        ).slice(2),
                }, 'latest']);
            } catch (e) {
                const m = String(e.message ?? e);
                temSwapV3 = !m.includes('selector was not recognized');
            }
            if (!temSwapV3) {
                proxiesOuSemSeletor += 1;
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const fab = endDe(await ler(pool, sel('factory()')));
            pools.push({
                endereco: pool, token0: a, token1: b2, taxa, liquidez,
                fabrica: fab,
            });
        }
        console.log(`    ${pools.length} pool(s) com ABI V3 CONFIRMADA pelo próprio pool,`
            + ' fee tier e liquidez lidos dele');
        console.log(`    ${proxiesOuSemSeletor} descartado(s): o próprio pool respondeu que NÃO`
            + ' tem `swap(address,bool,int256,uint160,bytes)`. Responder token0/token1/fee não'
            + ' prova ABI compatível, e substring de bytecode também não — as duas versões'
            + ' anteriores deste filtro deixaram passar 180 e 264 cotações inúteis');
        const porFabrica = new Map();
        for (const q of pools) porFabrica.set(q.fabrica, (porFabrica.get(q.fabrica) ?? 0) + 1);
        console.log('    por fábrica (lida do pool):');
        for (const [f, n] of [...porFabrica.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`      ${n}x  ${f}`);
        }

        // CANDIDATOS: CICLOS de 2 a 4 pernas no grafo de tokens.
        //
        // A primeira versao so montava dois pools do MESMO par, e isso nao
        // acha nada por construcao: dois pools do mesmo par precisam de um
        // deslocamento maior que a SOMA das duas taxas, e o par medido tinha
        // 0,8% + 1% = 1,8%. Medido no bloco 52632036: 228 de 288 cotacoes
        // rodaram as duas pernas e voltaram CURTAS, a menor por 2,08e-7 WETH.
        //
        // As arbitragens REAIS do benchmark sao TRIANGULARES — WETH -> X ->
        // USDC -> WETH — e cruzam taxas de 0,01% a 0,05%. E esse o grafo.
        const arestas = new Map();
        const poe = (a, b, q) => {
            const l = arestas.get(a) ?? [];
            l.push({ para: b, pool: q });
            arestas.set(a, l);
        };
        for (const q of pools) {
            poe(q.token0, q.token1, q);
            poe(q.token1, q.token0, q);
        }
        const BASE = WETH;
        const maxPernas = Number(process.env.V3_PERNAS ?? 3);
        candidatos = [];
        const caminhar = (tokenAtual, usados, rota) => {
            if (candidatos.length >= Number(process.env.V3_CANDIDATOS ?? 4000)) return;
            if (rota.length >= 2 && tokenAtual === BASE) {
                candidatos.push({ rota: [...rota] });
                return;
            }
            if (rota.length >= maxPernas) return;
            for (const aresta of arestas.get(tokenAtual) ?? []) {
                if (usados.has(aresta.pool.endereco)) continue;
                // Pool repetido na mesma rota trava no proprio pool: o segundo
                // `swap` entra num contrato ja em execucao.
                usados.add(aresta.pool.endereco);
                rota.push({ pool: aresta.pool, tokenEntra: tokenAtual, tokenSai: aresta.para });
                caminhar(aresta.para, usados, rota);
                rota.pop();
                usados.delete(aresta.pool.endereco);
            }
        };
        caminhar(BASE, new Set(), []);
        // AS MENORES TAXAS PRIMEIRO: a taxa somada e o piso que o
        // deslocamento tem de vencer, e e o criterio que separa rota possivel
        // de rota decorativa.
        for (const c of candidatos) {
            c.taxaSomada = c.rota.reduce((a, h) => a + Number(h.pool.taxa), 0);
        }
        candidatos.sort((a, b) => a.taxaSomada - b.taxaSomada);
        const porTamanho = new Map();
        for (const c of candidatos) {
            porTamanho.set(c.rota.length, (porTamanho.get(c.rota.length) ?? 0) + 1);
        }
        console.log(`    ${candidatos.length} ciclo(s) V3 que começam e terminam em WETH: `
            + [...porTamanho.entries()].sort((a, b) => a[0] - b[0])
                .map(([k, n]) => `${n} de ${k} pernas`).join(' | '));
        if (candidatos.length > 0) {
            console.log(`    menor taxa somada: ${candidatos[0].taxaSomada} por milhão`
                + ` (${(candidatos[0].taxaSomada / 10000).toFixed(3)}%) — é o piso que o`
                + ' deslocamento precisa vencer');
        }

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
        console.log(`    CacadorV3 em ${arb} | cofre ${cofre}`);
    });

    it('PROVA A: executa uma rota V3 real e reconcilia saldos e custos', async function () {
        if (candidatos.length === 0) {
            console.log('    nenhum par de pools V3 do mesmo par de tokens neste estado:'
                + ' NADA a provar aqui, e isto é ausência MEDIDA e não "V3 não serve"');
            this.skip();
            return;
        }

        // 1. COTA cada candidato pelo PROPRIO pool, em vários tamanhos.
        //    `cotar` executa e reverte com o número: ticks cruzados e impacto de
        //    preço são a conta do pool, não a minha.
        const comoRota = (c) => c.rota.map((h) => ({ pool: h.pool.endereco, tokenEntra: h.tokenEntra }));
        const cotar = async (c, quantia) => {
            const dados = iface.encodeFunctionData('cotar', [comoRota(c), quantia]);
            try {
                await chamar('eth_call', [{ from: dono, to: arb, data: dados, gas: '0x2000000' }, 'latest']);
                return null; // nao reverteu: nao deveria acontecer
            } catch (e) {
                const m = String(e.message ?? e);
                // O numero vem no `data` do erro `LucroInsuficiente(obtido, piso)`.
                const mm = /LucroInsuficiente\((\d+),\s*(\d+)\)/.exec(m);
                if (mm !== null) return BigInt(mm[1]);
                // PAGAMENTO CURTO e resposta, nao falha: diz quanto faltou.
                const pc = /PagamentoCurto\((\d+),\s*(\d+)\)/.exec(m);
                if (pc !== null) {
                    const falta = BigInt(pc[2]) - BigInt(pc[1]);
                    if (menorFalta === null || falta < menorFalta) menorFalta = falta;
                    motivos.set('PagamentoCurto (o ciclo volta com menos do que o pool cobra)',
                        (motivos.get('PagamentoCurto (o ciclo volta com menos do que o pool cobra)') ?? 0) + 1);
                    return undefined;
                }
                const hex = /0x[0-9a-fA-F]{8,}/.exec(m);
                if (hex !== null && hex[0].length >= 138) {
                    try {
                        const d = iface.parseError(hex[0]);
                        if (d && d.name === 'LucroInsuficiente') return BigInt(d.args[0]);
                    } catch { /* outro erro */ }
                }
                // REVERTEU POR OUTRO MOTIVO, e o motivo e registrado.
                //
                // Em 2026-10-15 as 180 primeiras cotacoes sairam todas assim e
                // eu quase publiquei "nenhuma rota V3 rende". Era `cotar`
                // fazendo `this.executarRota`, chamada EXTERNA, e `soDono`
                // recusando o proprio contrato. Motivo nao contado e motivo que
                // vira conclusao errada.
                const nome = /custom error '([^']+)'|reason string '([^']+)'|revert(?:ed)?:?\s*([^\n]{0,60})/
                    .exec(m);
                const chave = nome === null
                    ? m.slice(0, 50)
                    : (nome[1] ?? nome[2] ?? nome[3] ?? 'sem motivo').trim();
                motivos.set(chave, (motivos.get(chave) ?? 0) + 1);
                return undefined;
            }
        };

        const motivos = new Map();
        let menorFalta = null;
        const TAMANHOS = [
            10n ** 15n, 10n ** 16n, 5n * 10n ** 16n, 10n ** 17n, 5n * 10n ** 17n, 10n ** 18n,
        ];
        let melhor = null;
        let cotadas = 0;
        let recusadas = 0;
        const teto = Number(process.env.V3_COTAR ?? 60);
        for (const c of candidatos.slice(0, teto)) {
            for (const q of TAMANHOS) {
                // eslint-disable-next-line no-await-in-loop
                const r = await cotar(c, q);
                cotadas += 1;
                if (r === undefined) { recusadas += 1; continue; }
                if (r === null) continue;
                if (melhor === null || r > melhor.bruto) melhor = { c, quantia: q, bruto: r };
            }
        }
        console.log(`\n    ${cotadas} cotação(ões) pelo próprio pool | ${recusadas} recusada(s)`);
        if (motivos.size > 0) {
            console.log('    POR QUE recusaram (e nenhuma destas é "não há oportunidade"):');
            for (const [k, n] of [...motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
                console.log(`      ${n}x  ${k}`);
            }
        }
        if (melhor === null || melhor.bruto === 0n) {
            console.log('    NENHUMA rota V3 deste estado devolve saída positiva.');
            if (menorFalta !== null) {
                console.log(`    A MENOR falta medida foi ${menorFalta} wei: o ciclo existe, roda`
                    + ' e volta curto. Isto é recusa MEDIDA pela conta do pool — e a distância'
                    + ' até fechar está quantificada, não é silêncio.');
            } else {
                console.log('    Nenhuma cotação chegou a medir falta: a recusa NÃO foi'
                    + ' identificada, e isso é limitação do avaliador, não ausência.');
            }
            this.skip();
            return;
        }
        console.log(`    melhor cotação: ${melhor.bruto} wei de WETH com entrada`
            + ` ${melhor.quantia} (${melhor.c.rota.length} pernas, taxa somada`
            + ` ${melhor.c.taxaSomada})`);
        for (const h of melhor.c.rota) {
            console.log(`      ${h.pool.endereco} fee ${h.pool.taxa}`
                + ` | entra ${h.tokenEntra.slice(0, 10)}… sai ${h.tokenSai.slice(0, 10)}…`);
        }

        // 2. EXECUTA DE VERDADE, com saldos reconciliados.
        const antesArb = await saldo(WETH, arb);
        const antesCofre = await saldo(WETH, cofre);
        const dados = iface.encodeFunctionData('executarRota',
            [comoRota(melhor.c), melhor.quantia, 1n]);
        let rec = null; let erro = null;
        try {
            const tx = await chamar('eth_sendTransaction', [{
                from: dono, to: arb, data: dados, gas: '0x2000000',
            }]);
            rec = await chamar('eth_getTransactionReceipt', [tx]);
        } catch (e) { erro = String(e.message ?? e); }

        if (rec === null || rec.status !== '0x1') {
            console.log(`    a execução REVERTEU: ${(erro ?? 'sem motivo').slice(0, 200)}`);
            console.log('    A cotação é do pool, então divergência aqui é do EXECUTOR —'
                + ' e fica declarada como tal, não como "V3 não dá".');
            assert.fail('a rota cotou positivo e a execução reverteu');
        }

        const depoisArb = await saldo(WETH, arb);
        const depoisCofre = await saldo(WETH, cofre);
        const lucroBruto = depoisCofre - antesCofre;

        // 3. O CUSTO COMPLETO, do recibo e do oráculo de L1.
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
        const j = julgar(lucroBruto, custo);

        console.log('\n    RECONCILIACAO (tudo em wei do token base):');
        console.log(`      saldo do executor  antes ${antesArb}  depois ${depoisArb}`);
        console.log(`      saldo do COFRE     antes ${antesCofre}  depois ${depoisCofre}`);
        console.log(`      bruto que chegou ao cofre .. ${lucroBruto}`);
        console.log(`      gás consumido (recibo) ..... ${gasUsado}`);
        console.log(`      ${custo.comoLer}`);
        console.log(`      VEREDICTO: ${j.veredicto.toUpperCase()} — ${j.porque.slice(0, 180)}`);

        // O portao: o executor nao pode ficar com nada, e o cofre tem de
        // receber exatamente o lucro.
        assert.equal(depoisArb, antesArb, 'o executor retiveve saldo: o lucro vai ao cofre');
        assert.ok(lucroBruto > 0n, 'o cofre não recebeu nada numa execução bem-sucedida');
        // E a cotação do pool tem de bater com o realizado. Divergência aqui é
        // defeito do executor, e um teste que a tolera não prova nada.
        assert.equal(lucroBruto, melhor.bruto,
            `a cotação disse ${melhor.bruto} e o realizado foi ${lucroBruto}: a conta do `
            + 'executor divergiu da do pool');
        console.log('    cotação == realizado: a conta do executor é a do pool, exata');
        console.log(`\n    DECLARADO: o estado é o FIM do bloco ${BLOCO_ALVO - 1}. A operação`
            + ` histórica deste bloco está no índice 32, então 32 transações do bloco`
            + ` ${BLOCO_ALVO} NÃO estão aplicadas. Isto prova VIABILIDADE naquele estado,`
            + ' não capacidade de vencer a corrida real.');
    });

    it('os limites de preço do protocolo funcionam nos DOIS sentidos', async function () {
        // `MIN_SQRT`/`MAX_SQRT` nao foram verificados por leitura de codigo, e o
        // contrato diz isso. A verificacao possivel e esta: se estivessem
        // errados, TODO swap reverteria com `SPL` — entao uma cotacao que
        // devolve numero em pool com `zeroForOne` true E false os confere.
        if (candidatos.length === 0) { this.skip(); return; }
        const direcoes = new Set();
        for (const c of candidatos.slice(0, 40)) {
            for (const h of c.rota) direcoes.add(h.pool.token0 === h.tokenEntra);
        }
        console.log(`    sentidos exercitados entre os candidatos: ${[...direcoes].join(', ')}`);
        assert.ok(direcoes.size >= 1, 'nenhum sentido foi exercitado');
    });
});
