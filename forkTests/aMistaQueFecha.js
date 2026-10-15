// UMA EXECUCAO ATOMICA COMPLETA — procurada entre as operacoes VERIFICADAS.
//
// Item 4 dela: *"Se esse estado não puder ser reconstruído com os recursos
// disponíveis, selecione outra operação histórica lucrativa, economicamente
// reconciliada, cuja reprodução seja viável. Não fique preso indefinidamente ao
// mesmo hash."*
//
// O hash `0x6966a108bb45…` esta travado por FIDELIDADE DE ESTADO, e o numero
// que mede isso e este: pagando o valor EXATO que o vencedor pagou
// (165540234889082868 wei de WETH), o Aerodrome no estado reconstruido devolve
// 12265670319999560128029 do token contra os 14884119761520122410275 que ele
// recebeu — razao 0,824. Com 232 de 266 desfechos iguais ao original e os dois
// pools intocados pelas 267 anteriores, o estado do indice 267 nao se
// reconstroi por este caminho.
//
// Entao aqui a busca e por OUTRA operacao: as que a reconciliacao (com
// wrap/unwrap e nativo, `src/quemGanha.ts`) confirmou lucrativas E que sao
// verificaveis SO POR LOG — sem wrap, sem V4, sem ETH nativo. Para cada uma, o
// fork vai ao bloco ANTERIOR e o executor misto tenta FECHAR.
//
// O criterio e o dela, e nao admite reversao: recibo `status = 1`, emprestimo
// quitado, executor zerado, lucro MEDIDO no cofre.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const { codificarGetL1Fee, ORACULO_DE_GAS_L1, somarCusto, julgar } = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const WETH = '0x4200000000000000000000000000000000000006';
const TOP_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const TOP_AERO = id('Swap(address,address,uint256,uint256,uint256,uint256)');

/**
 * As operacoes VERIFICADAS: lucrativas depois da reconciliacao completa e
 * reconciliaveis so por log. Vieram de `.tmp/reconciliado.json`, e o liquido
 * esta em wei de WETH.
 */
const VERIFICADAS = [
    // DEFEITO MEU, corrigido antes de rodar: a primeira versao desta lista
    // tinha um hash que eu COMPLETEI a partir do display truncado
    // (`0xa72914e1acbf0b4b…`). Hash de cabeca e o defeito do `0x80d1e0f4…` que
    // o CLAUDE.md deste projeto registra, so que em 32 bytes. Estes cinco
    // saem de `.tmp/reconciliado.json`, impressos inteiros.
    { tx: '0x5b1a4ba5e6c34ba1aaea53f8869ce992ea224c4621e90e9bb765b28502ae6ded', bloco: 52632037, liquido: 20456182645360211n },
    { tx: '0x6966a108bb45f3e6053edfafd975e973d202ca438a8f0366340b0476144c7e15', bloco: 52632036, liquido: 17462535561583631n },
    { tx: '0xa72914e1acbf9272cbb264c7b593ac940b125cd796169d92365f7fe09efcd333', bloco: 52632037, liquido: 1907651085753665n },
    { tx: '0x8d6dd35225472121fc8e72cf21751f21f42398e7913bc82c2fc59ced15ed3891', bloco: 52632084, liquido: 225701082603133n },
    { tx: '0xd87a644b56ba1d1a8b04162b9c253279515747894ea0b9d9adfef5f647e43af0', bloco: 52632039, liquido: 160606596118558n },
];

const S = { balanceOf: sel('balanceOf(address)'), token0: sel('token0()'), token1: sel('token1()') };
const iface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia, uint256 lucroMinimo) returns (uint256)',
    'function cotar((address pool,address tokenEntra,uint8 tipo,uint256 pagamento)[] rota, uint256 quantia)',
    'error LucroInsuficiente(uint256 obtido, uint256 piso)',
    // TODOS os erros do contrato: sem isto a reversao sai como "unrecognized
    // custom error" e o motivo fica ilegivel — que e o mesmo defeito do
    // `naoCruzouAinda`, so que no instrumento.
    'error NaoEDono()',
    'error CacaViva()',
    'error ChamadaInesperada(address quemChamou, address esperado)',
    'error SemCaca()',
    'error EstagioErrado(uint8 estagio)',
    'error PernasInvalidas(uint256 quantas)',
    'error PernaNaoEncaixa(uint8 indice, address esperado, address veio)',
    'error TipoDePernaDesconhecido(uint8 tipo)',
    'error PagamentoNaoDeclarado(uint8 indice)',
    'error PoolSemEsteToken(address pool, address token)',
    'error NadaEntrou()',
    'error TransferenciaFalhou(address token)',
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

describe('uma execução atômica completa, Aerodrome + V3', function () {
    this.timeout(3_600_000);

    it('procura entre as operações VERIFICADAS e exige recibo status=1', async function () {
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const contas = await chamar('eth_accounts', []);
        const [dono, cofre] = contas;
        const art = await hre.artifacts.readArtifact('CacadorV3');

        const tentativas = [];
        let concluida = null;

        for (const op of VERIFICADAS) {
            // 1. A ESTRUTURA sai dos LOGS da propria operacao.
            const rec = await upstream('eth_getTransactionReceipt', [op.tx]);
            if (rec === null) {
                tentativas.push({ op, estado: 'sem recibo no RPC' });
                continue;
            }
            const aero = [...new Set((rec.logs ?? [])
                .filter((l) => (l.topics[0] ?? '').toLowerCase() === TOP_AERO)
                .map((l) => l.address.toLowerCase()))];
            const v3 = [...new Set((rec.logs ?? [])
                .filter((l) => (l.topics[0] ?? '').toLowerCase() === TOP_V3)
                .map((l) => l.address.toLowerCase()))];
            if (aero.length === 0 || v3.length === 0) {
                tentativas.push({
                    op, estado: `não é mista (aero ${aero.length}, v3 ${v3.length})`,
                });
                continue;
            }

            // 2. O FORK no bloco ANTERIOR. Sem reconstrucao intrabloco: se a
            //    oportunidade existe ali, ela nao depende da ordem interna — e
            //    e exatamente isso que torna a reproducao viavel.
            await chamar('hardhat_reset', [{
                forking: { jsonRpcUrl: url, blockNumber: op.bloco - 1 },
            }]);
            const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
            const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
            const dep = await chamar('eth_sendTransaction', [{
                from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
                gas: '0x1000000',
            }]);
            const arb = (await chamar('eth_getTransactionReceipt', [dep])).contractAddress;

            // 3. O par: o pool Aerodrome com WETH e o pool V3 com o MESMO token.
            const parDe = async (a, b) => {
                const [a0, a1, b0, b1] = await Promise.all([
                    ler(a, S.token0), ler(a, S.token1), ler(b, S.token0), ler(b, S.token1),
                ]);
                const ta = [endDe(a0), endDe(a1)];
                const tb = [endDe(b0), endDe(b1)];
                if (!ta.includes(WETH)) return null;
                const token = ta.find((x) => x !== WETH);
                if (token === undefined || !tb.includes(token)) return null;
                return token;
            };

            let fechou = null;
            for (const pa of aero) {
                for (const pv of v3) {
                    // eslint-disable-next-line no-await-in-loop
                    const token = await parDe(pa, pv);
                    if (token === null) continue;
                    // AS DUAS ORDENS. A primeira versao so tentava a de cima,
                    // e isso NAO e ausencia de oportunidade: e metade da busca.
                    //
                    //   A) Aerodrome empresta (paga WETH, sai token) e o V3
                    //      vende o token de volta a WETH
                    //   B) V3 empresta (entra WETH exato, sai token) e o
                    //      Aerodrome vende o token — perna interna com
                    //      `pagamento = 0`, que agora significa "gasta tudo"
                    const ORDENS = [
                        (pagamento) => ([
                            { pool: pa, tokenEntra: WETH, tipo: 1, pagamento },
                            { pool: pv, tokenEntra: token, tipo: 0, pagamento: 0n },
                        ]),
                        (pagamento) => ([
                            { pool: pv, tokenEntra: WETH, tipo: 0, pagamento: 0n },
                            { pool: pa, tokenEntra: token, tipo: 1, pagamento: 0n },
                        ]),
                    ];
                    for (const monta of ORDENS) {
                    const rota = monta;
                    const cotar = async (quantia, pagamento) => {
                        try {
                            await chamar('eth_call', [{
                                from: dono, to: arb, gas: '0xB71B00',
                                data: iface.encodeFunctionData('cotar', [rota(pagamento), quantia]),
                            }, 'latest']);
                            return { ok: false, motivo: 'não reverteu' };
                        } catch (e) {
                            const m = String(e.message ?? e);
                            const li = /LucroInsuficiente\((\d+),\s*(\d+)\)/.exec(m);
                            if (li !== null) return { ok: true, bruto: BigInt(li[1]) };
                            const pc = /PagamentoCurto\((\d+),\s*(\d+)\)/.exec(m);
                            if (pc !== null) {
                                return { ok: false, tem: BigInt(pc[1]), devido: BigInt(pc[2]) };
                            }
                            // O DADO vem no objeto do erro, nao na prosa: o Hardhat poe o
                // retorno da reversao em `e.data`. Procurar hex na mensagem
                // deixava todo erro nosso como "unrecognized custom error".
                const bruto = (e && (e.data || (e.error && e.error.data))) || null;
                const hex = bruto ? [String(bruto)] : /0x[0-9a-fA-F]{8,}/.exec(m);
                if (hex !== null) {
                    try {
                        const d = iface.parseError(hex[0]);
                        if (d) return { ok: false, motivo: `${d.name}(${d.args.join(',')})` };
                    } catch { /* nao e erro nosso */ }
                }
                return { ok: false, motivo: m.slice(0, 80) };
                        }
                    };
                    // O TAMANHO sai da reserva do pool, nao de numero meu: o
                    // pagamento e uma fracao do WETH que o Aerodrome tem.
                    // eslint-disable-next-line no-await-in-loop
                    const wethNoPool = await saldo(WETH, pa);
                    const FRACOES = [1000n, 300n, 100n, 30n, 10n, 3n];
                    for (const f of FRACOES) {
                        const pagamento = wethNoPool / f;
                        if (pagamento === 0n) continue;
                        // eslint-disable-next-line no-await-in-loop
                        const r = await cotar(pagamento, pagamento);
                        if (r.ok && r.bruto > 0n && (fechou === null || r.bruto > fechou.bruto)) {
                            fechou = { pa, pv, token, pagamento, bruto: r.bruto, rota, arb, baseFeeWei };
                        }
                    }
                    }
                }
            }

            if (fechou === null) {
                tentativas.push({ op, estado: 'nenhum tamanho fecha no bloco anterior' });
                continue;
            }

            // 4. EXECUTA DE VERDADE e exige recibo.
            const antesArb = await saldo(WETH, fechou.arb);
            const antesTok = await saldo(fechou.token, fechou.arb);
            const antesCofre = await saldo(WETH, cofre);
            const dados = iface.encodeFunctionData('executarRota',
                [fechou.rota(fechou.pagamento), fechou.pagamento, 1n]);
            let r2 = null; let erro = null;
            try {
                const tx = await chamar('eth_sendTransaction', [{
                    from: dono, to: fechou.arb, data: dados, gas: '0xB71B00',
                }]);
                r2 = await chamar('eth_getTransactionReceipt', [tx]);
            } catch (e) { erro = String(e.message ?? e); }
            if (r2 === null || r2.status !== '0x1') {
                tentativas.push({
                    op, estado: `cotou ${fechou.bruto} e a execução reverteu: `
                        + `${String(erro).slice(0, 90)}`,
                });
                continue;
            }
            const depoisArb = await saldo(WETH, fechou.arb);
            const depoisTok = await saldo(fechou.token, fechou.arb);
            const depoisCofre = await saldo(WETH, cofre);
            const gasUsado = BigInt(r2.gasUsed);
            const l1 = num(await ler(ORACULO_DE_GAS_L1,
                codificarGetL1Fee(`0x${'02'.repeat(140 + dados.length / 2)}`)));
            const custo = somarCusto({
                gasUsado, gasUsadoVeioDe: 'recibo', baseFeeWei: fechou.baseFeeWei,
                gorjetaWei: 20_000_000n, custoL1Wei: l1, taxaDoEmprestimoWei: 0n,
            });
            concluida = {
                op, fechou, r2, custo,
                bruto: depoisCofre - antesCofre,
                antesArb, depoisArb, antesTok, depoisTok, antesCofre, depoisCofre, gasUsado,
                j: julgar(depoisCofre - antesCofre, custo),
            };
            break;
        }

        console.log('\n    TENTATIVAS:');
        for (const t of tentativas) {
            console.log(`      ${t.op.tx.slice(0, 14)}… b${t.op.bloco} → ${t.estado}`);
        }

        if (concluida === null) {
            console.log('\n    NENHUMA execução atômica concluída entre as verificadas.');
            console.log('    BLOQUEIO EXATO: a oportunidade das operações verificadas não existe'
                + ' no estado do fim do bloco anterior — ela é INTRABLOCO. Medido no alvo'
                + ' `0x6966a108bb45…`: pagando o valor exato do vencedor, o Aerodrome devolve'
                + ' 0,824 do que ele recebeu, com os dois pools intocados pelas 267 anteriores'
                + ' e 232 de 266 desfechos reproduzidos.');
            assert.fail('nenhuma execução atômica concluída: sem recibo status=1 não há '
                + 'arbitragem provada');
        }

        const c = concluida;
        console.log('\n    EXECUÇÃO ATÔMICA CONCLUÍDA — recibo status=1');
        console.log(`      operação de referência ${c.op.tx}`);
        console.log(`      Aerodrome ${c.fechou.pa} | V3 ${c.fechou.pv} | token ${c.fechou.token}`);
        console.log(`      pagamento ${c.fechou.pagamento}`);
        console.log(`      executor WETH ${c.antesArb} -> ${c.depoisArb}`);
        console.log(`      executor token ${c.antesTok} -> ${c.depoisTok}`);
        console.log(`      COFRE ${c.antesCofre} -> ${c.depoisCofre} | bruto ${c.bruto}`);
        console.log(`      gás ${c.gasUsado} | ${c.custo.comoLer}`);
        console.log(`      VEREDICTO: ${c.j.veredicto.toUpperCase()} — ${c.j.porque.slice(0, 150)}`);

        assert.equal(c.depoisArb, c.antesArb, 'o executor retiveve WETH');
        assert.equal(c.depoisTok, c.antesTok, 'o executor retiveve o token: liquidação incompleta');
        assert.ok(c.bruto > 0n, 'o cofre não recebeu nada');
        assert.equal(c.bruto, c.fechou.bruto, 'a cotação divergiu do realizado');
    });
});

describe('o executor misto FECHA quando existe deslocamento', function () {
    this.timeout(3_600_000);

    // POR QUE ESTE TESTE EXISTE, e o que ele NAO e.
    //
    // As cinco operacoes verificadas nao fecham no fim do bloco anterior — a
    // oportunidade delas e INTRABLOCO. Com isso, "nada fechou" tem duas
    // leituras possiveis: ou a economia nao estava la, ou o meu executor nao
    // fecha nunca. Elas pedem acoes opostas, e confundi-las seria o defeito que
    // este projeto persegue.
    //
    // Entao aqui o deslocamento e INDUZIDO por mim, de proposito: compro o
    // token no Aerodrome com um volume grande, o que encarece o token ali, e
    // depois a rota pega o token barato no V3 e vende caro no Aerodrome.
    //
    // ISTO NAO E REPRODUCAO HISTORICA. E a prova de que o executor conclui uma
    // operacao ATOMICA com recibo `status = 1`, emprestimo quitado e lucro
    // MEDIDO — e, por consequencia, que o bloqueio das cinco e economico.
    it('executa atomicamente, quita e entrega lucro medido ao cofre', async function () {
        p = hre.network.provider;
        const url = hre.config.networks.hardhat.forking.url;
        const AERO = '0x566bee7ef7b39f29d150ab3be6b6242c17cc5a31';
        const V3 = '0x3e31de9d23a1c923e3b60b45c0a30d172f01b659';
        const TOKEN = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';

        await chamar('hardhat_reset', [{
            forking: { jsonRpcUrl: url, blockNumber: 52632035 },
        }]);
        const contas = await chamar('eth_accounts', []);
        const [dono, cofre] = contas;
        const bloco = await chamar('eth_getBlockByNumber', ['latest', false]);
        const baseFeeWei = BigInt(bloco.baseFeePerGas ?? '0x0');
        const art = await hre.artifacts.readArtifact('CacadorV3');
        const dep = await chamar('eth_sendTransaction', [{
            from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
            gas: '0x1000000',
        }]);
        const arb = (await chamar('eth_getTransactionReceipt', [dep])).contractAddress;

        // 1. WETH de verdade, embrulhando ETH do proprio fork.
        await chamar('hardhat_setBalance', [dono, '0x152D02C7E14AF6800000']);
        const empurrao = 40n * 10n ** 18n;
        await chamar('eth_sendTransaction', [{
            from: dono, to: WETH, value: `0x${empurrao.toString(16)}`,
            data: sel('deposit()'), gas: '0x100000',
        }]);

        // 2. O EMPURRAO: compra token no Aerodrome. Transfere o WETH e chama
        //    `swap` com a saida que o PROPRIO pool cota — nenhuma conta minha.
        const antesCot = BigInt(await ler(AERO, sel('getAmountOut(uint256,address)')
            + coder.encode(['uint256', 'address'], [10n ** 15n, WETH]).slice(2)));
        await chamar('eth_sendTransaction', [{
            from: dono, to: WETH, gas: '0x100000',
            data: sel('transfer(address,uint256)')
                + coder.encode(['address', 'uint256'], [AERO, empurrao]).slice(2),
        }]);
        const saida = BigInt(await ler(AERO, sel('getAmountOut(uint256,address)')
            + coder.encode(['uint256', 'address'], [empurrao, WETH]).slice(2)));
        const t0 = endDe(await ler(AERO, S.token0));
        const r0 = await chamar('eth_sendTransaction', [{
            from: dono, to: AERO, gas: '0x400000',
            data: sel('swap(uint256,uint256,address,bytes)')
                + coder.encode(
                    ['uint256', 'uint256', 'address', 'bytes'],
                    [t0 === WETH ? 0n : saida, t0 === WETH ? saida : 0n, dono, '0x'],
                ).slice(2),
        }]);
        const recEmpurrao = await chamar('eth_getTransactionReceipt', [r0]);
        assert.equal(recEmpurrao.status, '0x1', 'o empurrão no Aerodrome falhou');
        const depoisCot = BigInt(await ler(AERO, sel('getAmountOut(uint256,address)')
            + coder.encode(['uint256', 'address'], [10n ** 15n, WETH]).slice(2)));
        console.log(`\n    EMPURRAO: comprei token no Aerodrome com ${empurrao} wei de WETH`);
        console.log(`      getAmountOut(1e15 WETH) antes ${antesCot} -> depois ${depoisCot}`);
        assert.ok(depoisCot < antesCot, 'o empurrão não moveu o preço do Aerodrome');

        // 3b. A INVARIANTE DELA, conferida ANTES de executar:
        //
        //   *"um filtro de rejeição nunca pode rejeitar uma rota que o
        //   executor comprovou lucrativa naquele mesmo estado."*
        //
        // Esta e a direcao B, e e a que rendeu 0,0598 WETH. Se o filtro a
        // recusar aqui, ele e um falso negativo — e era, antes do conserto: na
        // direcao B ele comparava um teto em TOKEN com um custo em WETH.
        const { semSpreadEmTamanhoNenhum } = require('../dist/rotasMistas.js');
        const EPS = 10n ** 12n;
        const slot0V3 = await ler(V3, sel('slot0()'));
        const sqrtV3 = (slot0V3 && slot0V3.length >= 66)
            ? BigInt(`0x${slot0V3.slice(2, 66)}`) : null;
        const t0V3 = endDe(await ler(V3, sel('token0()')));
        // Na direcao B a perna do Aerodrome VENDE o token do meio, entao a
        // cotacao dele e `getAmountOut(epsilon, TOKEN)`.
        const saidaAero = num(await ler(AERO, sel('getAmountOut(uint256,address)')
            + coder.encode(['uint256', 'address'], [EPS, TOKEN]).slice(2)));
        const filtro = semSpreadEmTamanhoNenhum({
            direcao: 'B',
            sqrtPriceX96: sqrtV3,
            tokenDoMeioEhToken0NoV3: t0V3 === TOKEN,
            saidaAerodromeNoEpsilon: saidaAero,
            epsilon: EPS,
        });
        console.log(`    FILTRO na direção B: ${filtro.vale ? 'PASSOU' : 'RECUSOU'}`
            + ` — ${filtro.porque.slice(0, 110)}`);
        assert.equal(filtro.vale, true,
            'INVARIANTE VIOLADA: o filtro rejeitou a rota que o executor prova lucrativa neste '
            + 'mesmo estado. Um filtro de rejeição não pode fazer isso');

        // 3. A ROTA: V3 empresta (WETH entra, token sai) e o Aerodrome vende o
        //    token, agora caro ali. `pagamento = 0` na perna interna = gasta o
        //    que esta em maos.
        const rota = [
            { pool: V3, tokenEntra: WETH, tipo: 0, pagamento: 0n },
            { pool: AERO, tokenEntra: TOKEN, tipo: 1, pagamento: 0n },
        ];
        const cotar = async (quantia) => {
            try {
                await chamar('eth_call', [{
                    from: dono, to: arb, gas: '0xB71B00',
                    data: iface.encodeFunctionData('cotar', [rota, quantia]),
                }, 'latest']);
                return { ok: false, motivo: 'não reverteu' };
            } catch (e) {
                const m = String(e.message ?? e);
                const li = /LucroInsuficiente\((\d+),\s*(\d+)\)/.exec(m);
                if (li !== null) return { ok: true, bruto: BigInt(li[1]) };
                const pc = /PagamentoCurto\((\d+),\s*(\d+)\)/.exec(m);
                if (pc !== null) return { ok: false, motivo: `PagamentoCurto ${pc[1]}/${pc[2]}` };
                // O DADO vem no objeto do erro, nao na prosa: o Hardhat poe o
                // retorno da reversao em `e.data`. Procurar hex na mensagem
                // deixava todo erro nosso como "unrecognized custom error".
                const bruto = (e && (e.data || (e.error && e.error.data))) || null;
                const hex = bruto ? [String(bruto)] : /0x[0-9a-fA-F]{8,}/.exec(m);
                if (hex !== null) {
                    try {
                        const d = iface.parseError(hex[0]);
                        if (d) return { ok: false, motivo: `${d.name}(${d.args.join(',')})` };
                    } catch { /* nao e erro nosso */ }
                }
                return { ok: false, motivo: m.slice(0, 80) };
            }
        };
        let melhor = null;
        for (const q of [10n ** 15n, 10n ** 16n, 10n ** 17n, 5n * 10n ** 17n, 10n ** 18n,
            5n * 10n ** 18n, 10n ** 19n]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await cotar(q);
            console.log(`      quantia ${q}: ${r.ok ? `bruto ${r.bruto}` : r.motivo}`);
            if (r.ok && r.bruto > 0n && (melhor === null || r.bruto > melhor.bruto)) {
                melhor = { quantia: q, bruto: r.bruto };
            }
        }
        assert.ok(melhor !== null,
            'com o deslocamento induzido nenhuma quantia fecha: o bloqueio é do EXECUTOR, '
            + 'não da economia');

        // 4. EXECUTA e EXIGE recibo.
        const antesArb = await saldo(WETH, arb);
        const antesTok = await saldo(TOKEN, arb);
        const antesCofre = await saldo(WETH, cofre);
        const dados = iface.encodeFunctionData('executarRota', [rota, melhor.quantia, 1n]);
        const tx = await chamar('eth_sendTransaction', [{
            from: dono, to: arb, data: dados, gas: '0xB71B00',
        }]);
        const rec = await chamar('eth_getTransactionReceipt', [tx]);
        assert.ok(rec !== null, 'a execução não produziu recibo');
        assert.equal(rec.status, '0x1',
            'recibo diferente de 1: a transação reverteu e o empréstimo NÃO foi quitado');

        const depoisArb = await saldo(WETH, arb);
        const depoisTok = await saldo(TOKEN, arb);
        const depoisCofre = await saldo(WETH, cofre);
        const bruto = depoisCofre - antesCofre;
        const gasUsado = BigInt(rec.gasUsed);
        const l1 = num(await ler(ORACULO_DE_GAS_L1,
            codificarGetL1Fee(`0x${'02'.repeat(140 + dados.length / 2)}`)));
        const custo = somarCusto({
            gasUsado, gasUsadoVeioDe: 'recibo', baseFeeWei,
            gorjetaWei: 20_000_000n, custoL1Wei: l1, taxaDoEmprestimoWei: 0n,
        });
        const j = julgar(bruto, custo);

        console.log('\n    EXECUCAO ATOMICA CONCLUIDA — recibo status=1');
        console.log(`      quantia ${melhor.quantia} | V3 empresta, Aerodrome vende`);
        console.log(`      executor WETH ${antesArb} -> ${depoisArb}`);
        console.log(`      executor token ${antesTok} -> ${depoisTok}`);
        console.log(`      COFRE ${antesCofre} -> ${depoisCofre} | bruto ${bruto}`);
        console.log(`      gas ${gasUsado} | ${custo.comoLer}`);
        console.log(`      VEREDICTO: ${j.veredicto.toUpperCase()} — ${j.porque.slice(0, 150)}`);
        console.log('    DECLARADO: o deslocamento foi INDUZIDO por mim neste fork. Isto prova'
            + ' o EXECUTOR — atomicidade, quitação e lucro medido —, nao uma oportunidade'
            + ' historica.');

        assert.equal(depoisArb, antesArb, 'o executor retiveve WETH');
        assert.equal(depoisTok, antesTok, 'o executor retiveve o token: liquidação incompleta');
        assert.ok(bruto > 0n, 'o cofre não recebeu nada');
        assert.equal(bruto, melhor.bruto, 'a cotação divergiu do realizado');
    });
});
