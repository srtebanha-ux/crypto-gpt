// A ARBITRAGEM MISTA Aerodrome + V3: MECANISMO e EXECUCAO, separados.
//
// ELA APONTOU UM FALSO POSITIVO MEU, e estava certa: a versao anterior deste
// arquivo aceitava `maiorRetornoDaCadeia > 0` e passava. *"Uma transação
// revertida não quitou o empréstimo e não realizou lucro."* Exato — aquilo
// provava que os callbacks correm, nao que existe arbitragem.
//
// Agora sao DOIS testes, e o segundo nao pode passar sem recibo:
//
//   MECANISMO_PARCIAL  prova que o flash do Aerodrome adianta o token e que a
//                      perna V3 vende e devolve WETH. Diz em voz alta que NAO
//                      e arbitragem: a transacao reverteu e nada foi quitado
//   EXECUCAO_COMPLETA  exige `status = 1`, emprestimo quitado, saldo do
//                      executor zerado e lucro MEDIDO no cofre. Sem isso,
//                      FALHA
//
// O REPLAY tambem foi consertado. A versao anterior reassinava cada transacao
// por impersonacao, com nonce e gas novos — e 109 das 267 revertiam, o que
// corrompia justamente o estado que eu queria reproduzir. Agora as transacoes
// originais sao RE-SERIALIZADAS com a assinatura, o nonce e o gas de verdade
// (`r`, `s`, `yParity` vem do `eth_getTransactionByHash`) e entram por
// `eth_sendRawTransaction`. Os metodos de raw do provedor estao bloqueados
// ("rejected due to request filter settings"), entao a serializacao e feita
// aqui a partir dos campos.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, Transaction, id } = require('ethers');

const { codificarGetL1Fee, ORACULO_DE_GAS_L1, somarCusto, julgar } = require('../dist/custoDaBase.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const WETH = '0x4200000000000000000000000000000000000006';

/**
 * A operacao historica, reconciliada log por log (ver `src/quemGanha.ts`):
 * bruto 183133343388332077 - 165540234889082868 = 17593108499249209 wei,
 * custo 130572937665578, LIQUIDO 17462535561583631 = 0,01746 WETH.
 * Sem wrap, sem V4, sem ETH nativo — reconciliavel so por log.
 */
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

const S = { balanceOf: sel('balanceOf(address)'), slot0: sel('slot0()') };
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
const saldo = async (t, de) => num(await ler(
    t, S.balanceOf + coder.encode(['address'], [de]).slice(2),
)) ?? 0n;

let undiciFetch = null;
let agente;
/** O RPC de CIMA: o bloco historico nao existe no fork, que para em N-1. */
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

/**
 * RE-SERIALIZA a transacao original, com a assinatura dela.
 *
 * `null` quando nao da: transacao de DEPOSITO da OP Stack (tipo 0x7e) nao tem
 * assinatura para re-serializar, e inventar uma seria fabricar a transacao.
 */
function reSerializar(t) {
    if (t.type === '0x7e' || Number(t.type ?? 0) === 126) return null;
    try {
        const campos = {
            type: Number(t.type ?? 0),
            chainId: Number(t.chainId ?? 8453),
            nonce: Number(t.nonce),
            to: t.to ?? null,
            value: BigInt(t.value ?? '0x0'),
            data: t.input ?? '0x',
            gasLimit: BigInt(t.gas),
            signature: {
                r: t.r,
                s: t.s,
                yParity: t.yParity !== undefined ? Number(t.yParity) : undefined,
                v: t.v !== undefined ? Number(t.v) : undefined,
            },
        };
        if (campos.type === 0 || campos.type === 1) {
            campos.gasPrice = BigInt(t.gasPrice);
        } else {
            campos.maxFeePerGas = BigInt(t.maxFeePerGas);
            campos.maxPriorityFeePerGas = BigInt(t.maxPriorityFeePerGas);
        }
        if (Array.isArray(t.accessList)) campos.accessList = t.accessList;
        const tx = Transaction.from(campos);
        // CONFERENCIA: a assinatura tem de reproduzir o MESMO hash. Se nao
        // reproduz, a serializacao esta errada e mandar isso seria replay de
        // outra transacao.
        if (tx.hash.toLowerCase() !== String(t.hash).toLowerCase()) return null;
        return tx.serialized;
    } catch {
        return null;
    }
}

describe('a arbitragem mista Aerodrome + V3', function () {
    this.timeout(3_600_000);

    let dono; let cofre; let arb; let baseFeeWei;
    let replay = null;

    before(async function () {
        p = hre.network.provider;
        const contas = await chamar('eth_accounts', []);
        [dono, cofre] = contas;

        const quantas = Number(process.env.MISTA_REPLAY ?? ALVO.indice);
        if (quantas > 0) {
            replay = await reconstruir(quantas);
        } else {
            console.log('    SEM reconstrucao (MISTA_REPLAY=0): o estado e o do fork');
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
        console.log(`    executor ${arb} | cofre ${cofre}`);
    });

    /**
     * Reconstroi a sequencia do bloco com as transacoes ORIGINAIS assinadas, e
     * COMPARA com os recibos de verdade — o pedido dela: *"Separe as que já
     * reverteram originalmente das que deveriam ter sucesso."*
     */
    async function reconstruir(quantas) {
        const bl = await upstream('eth_getBlockByNumber', [`0x${ALVO.bloco.toString(16)}`, true]);
        assert.ok(bl && Array.isArray(bl.transactions), 'o bloco alvo não veio com transações');
        const recs = await upstream('eth_getBlockReceipts', [`0x${ALVO.bloco.toString(16)}`]);
        const porHash = new Map();
        for (const r of recs ?? []) porHash.set(String(r.transactionHash).toLowerCase(), r);

        const anteriores = bl.transactions.slice(0, quantas);
        const antes = await estadoDosPools();

        // UM BLOCO SO: automine desligado, manda todas, mina uma vez. E o mais
        // perto da ordem original — cada uma num bloco proprio mudaria
        // `block.number` e `baseFee` a cada passo.
        // O TIMESTAMP REAL DO BLOCO.
        //
        // HIPOTESE MEDIDA depois: 37 das 266 divergiram do desfecho original, e
        // uma causa obvia e `deadline`. Roteadores recusam quando
        // `block.timestamp > deadline`, e o bloco que o Hardhat mina leva o
        // timestamp do pai + 1s, nao o do bloco historico. Com o timestamp de
        // verdade, uma transacao com prazo volta a valer.
        try {
            await chamar('evm_setNextBlockTimestamp', [Number(BigInt(bl.timestamp))]);
        } catch (e) {
            console.log(`    NAO consegui fixar o timestamp do bloco: ${String(e).slice(0, 70)}`);
        }
        await chamar('evm_setAutomine', [false]);
        const conta = {
            total: anteriores.length,
            semAssinatura: 0,
            recusadasNaEntrada: 0,
            enviadas: 0,
            okOriginal: 0,
            revertidasOriginal: 0,
        };
        const enviados = [];
        for (const t of anteriores) {
            const orig = porHash.get(String(t.hash).toLowerCase());
            if (orig !== undefined) {
                if (orig.status === '0x1') conta.okOriginal += 1; else conta.revertidasOriginal += 1;
            }
            const raw = reSerializar(t);
            if (raw === null) { conta.semAssinatura += 1; continue; }
            try {
                // eslint-disable-next-line no-await-in-loop
                const h = await chamar('eth_sendRawTransaction', [raw]);
                enviados.push({ hash: h, original: orig });
                conta.enviadas += 1;
            } catch {
                conta.recusadasNaEntrada += 1;
            }
        }
        await chamar('evm_mine', []);
        await chamar('evm_setAutomine', [true]);

        // AS QUE MEXEM NOS POOLS DA ROTA — o pedido dela: *"Identifique quais
        // alterações de estado foram relevantes para os pools Aerodrome e V3
        // utilizados."* Sai dos LOGS dos recibos originais, nao de palpite.
        const relevantes = [];
        for (let i = 0; i < anteriores.length; i += 1) {
            const t = anteriores[i];
            const orig = porHash.get(String(t.hash).toLowerCase());
            if (orig === undefined) continue;
            const toca = (orig.logs ?? []).some((l) => {
                const a = String(l.address).toLowerCase();
                return a === ALVO.aerodromo || a === ALVO.v3;
            });
            if (toca) relevantes.push({ i, hash: t.hash, status: orig.status });
        }

        let iguais = 0; let divergiram = 0; let semRecibo = 0;
        const divergentes = [];
        for (const e of enviados) {
            // eslint-disable-next-line no-await-in-loop
            const r = await chamar('eth_getTransactionReceipt', [e.hash]);
            if (r === null) { semRecibo += 1; continue; }
            const esperado = e.original ? e.original.status : null;
            if (esperado === null) { semRecibo += 1; continue; }
            if (r.status === esperado) iguais += 1;
            else { divergiram += 1; divergentes.push({ hash: e.hash, original: esperado, agora: r.status }); }
        }
        const depois = await estadoDosPools();

        console.log(`\n    REPLAY do bloco ${ALVO.bloco}, ${conta.total} transações anteriores:`);
        console.log(`      originalmente OK ............... ${conta.okOriginal}`);
        console.log(`      originalmente revertidas ....... ${conta.revertidasOriginal}`);
        console.log(`      sem assinatura (depósito OP) ... ${conta.semAssinatura}`);
        console.log(`      recusadas na entrada ........... ${conta.recusadasNaEntrada}`);
        console.log(`      enviadas ....................... ${conta.enviadas}`);
        console.log(`      desfecho IGUAL ao original ..... ${iguais}`);
        console.log(`      desfecho DIVERGENTE ............ ${divergiram}`);
        console.log(`      sem recibo ..................... ${semRecibo}`);
        console.log(`      ANTERIORES que mexem nos pools da rota: ${relevantes.length}`);
        for (const r2 of relevantes.slice(0, 10)) {
            const div = divergentes.find((d) => d.hash.toLowerCase() === String(r2.hash).toLowerCase());
            console.log(`        indice ${r2.i} ${String(r2.hash).slice(0, 14)}…`
                + ` original ${r2.status}${div ? ` | REPLAY DIVERGIU -> ${div.agora}` : ' | replay igual'}`);
        }
        console.log('    ESTADO DOS POOLS que a rota usa:');
        console.log(`      V3 slot0   antes ${antes.v3}`);
        console.log(`                 depois ${depois.v3}`);
        console.log(`      Aerodrome WETH antes ${antes.aeroWeth} depois ${depois.aeroWeth}`);
        console.log(`      Aerodrome token antes ${antes.aeroToken} depois ${depois.aeroToken}`);
        console.log('    FIDELIDADE, no pagamento EXATO do vencedor'
            + ` (${ALVO.pagouWeth} WETH):`);
        console.log(`      o Aerodrome daria antes  ${antes.cotacaoNoPagamentoDoVencedor}`);
        console.log(`      o Aerodrome daria depois ${depois.cotacaoNoPagamentoDoVencedor}`);
        console.log(`      o vencedor recebeu       ${ALVO.tokenOut}`);
        if (depois.cotacaoNoPagamentoDoVencedor !== null) {
            const r3 = (BigInt(depois.cotacaoNoPagamentoDoVencedor) * 10000n) / ALVO.tokenOut;
            console.log(`      razao depois/historico = ${(Number(r3) / 10000).toFixed(6)}`
                + ' — 1,000000 seria estado idêntico');
        }
        const mudouV3 = antes.v3 !== depois.v3;
        void 0;
        const mudouAero = antes.aeroWeth !== depois.aeroWeth || antes.aeroToken !== depois.aeroToken;
        console.log(`      mudou o V3? ${mudouV3 ? 'SIM' : 'NÃO'} | mudou o Aerodrome?`
            + ` ${mudouAero ? 'SIM' : 'NÃO'}`);
        return { conta, iguais, divergiram, antes, depois, mudouV3, mudouAero };
    }

    async function estadoDosPools() {
        const [s0, aw, at] = await Promise.all([
            ler(ALVO.v3, S.slot0),
            saldo(WETH, ALVO.aerodromo),
            saldo(ALVO.token, ALVO.aerodromo),
        ]);
        // SEM TRUNCAR. A versao anterior cortava o `slot0` em 48 caracteres e
        // comparava o PREFIXO — que e quase todo zero. O `sqrtPriceX96` mora
        // nos digitos de baixo, entao uma mudanca real lia como "nao mudou".
        // Defeito do meu instrumento, nao do estado.
        const cot = await ler(
            ALVO.aerodromo,
            sel('getAmountOut(uint256,address)')
                + coder.encode(['uint256', 'address'], [ALVO.pagouWeth, WETH]).slice(2),
        );
        return {
            v3: String(s0),
            aeroWeth: String(aw),
            aeroToken: String(at),
            // A FIDELIDADE, num numero: quanto o Aerodrome da pelo pagamento
            // EXATO do vencedor, contra o que ele recebeu de verdade.
            cotacaoNoPagamentoDoVencedor: cot === null ? null : BigInt(cot).toString(),
        };
    }

    const rota = (pagamento) => ([
        { pool: ALVO.aerodromo, tokenEntra: WETH, tipo: 1, pagamento },
        { pool: ALVO.v3, tokenEntra: ALVO.token, tipo: 0, pagamento: 0n },
    ]);

    /** Cota pelo POOL: `cotar` executa e reverte com o numero. */
    async function cotar(quantia, pagamento) {
        try {
            await chamar('eth_call', [{
                from: dono, to: arb, gas: '0xB71B00',
                data: iface.encodeFunctionData('cotar', [rota(pagamento), quantia]),
            }, 'latest']);
            return { ok: false, motivo: 'não reverteu — `cotar` deveria sempre reverter' };
        } catch (e) {
            const m = String(e.message ?? e);
            const li = /LucroInsuficiente\((\d+),\s*(\d+)\)/.exec(m);
            if (li !== null) return { ok: true, bruto: BigInt(li[1]) };
            const pc = /PagamentoCurto\((\d+),\s*(\d+)\)/.exec(m);
            if (pc !== null) {
                return {
                    ok: false, tem: BigInt(pc[1]), devido: BigInt(pc[2]),
                    motivo: `PagamentoCurto tem=${pc[1]} devido=${pc[2]}`,
                };
            }
            return { ok: false, motivo: m.slice(0, 100) };
        }
    }

    /** O melhor (tamanho, pagamento) que o POOL aceita, por bisseccao. */
    async function melhorRota() {
        const TAMANHOS = [1n, 2n, 4n, 8n, 16n, 32n, 64n]
            .map((d) => ALVO.tokenOut / d).filter((q) => q > 0n);
        let melhor = null;
        let maiorRetorno = 0n;
        for (const q of TAMANHOS) {
            let alto = ((ALVO.pagouWeth * q) / ALVO.tokenOut) * 2n;
            let baixo = 1n;
            // eslint-disable-next-line no-await-in-loop
            const topo = await cotar(q, alto);
            if (topo.tem !== undefined && topo.tem > maiorRetorno) maiorRetorno = topo.tem;
            if (!topo.ok) continue;
            let achado = { quantia: q, pagamento: alto, bruto: topo.bruto };
            for (let k = 0; k < 42 && alto - baixo > 1n; k += 1) {
                const meio = (baixo + alto) / 2n;
                // eslint-disable-next-line no-await-in-loop
                const r = await cotar(q, meio);
                if (r.tem !== undefined && r.tem > maiorRetorno) maiorRetorno = r.tem;
                if (r.ok) { alto = meio; achado = { quantia: q, pagamento: meio, bruto: r.bruto }; } else baixo = meio;
            }
            if (melhor === null || achado.bruto > melhor.bruto) melhor = achado;
        }
        return { melhor, maiorRetorno };
    }

    it('MECANISMO_PARCIAL: a cadeia corre, e isto NÃO é arbitragem', async function () {
        // O QUE ESTE TESTE PROVA, e so isto: o flash do Aerodrome adianta o
        // token, o `hook` autentica, a perna V3 vende e devolve WETH ao
        // executor. A transacao REVERTE no fim se a economia nao fecha — e
        // transacao revertida nao quitou emprestimo e nao realizou lucro.
        const { maiorRetorno } = await melhorRota();
        console.log(`\n    a cadeia devolveu até ${maiorRetorno} wei de WETH ao executor`);
        console.log('    ISTO NÃO É ARBITRAGEM: se a execução reverteu, nada foi quitado e'
            + ' nenhum lucro foi realizado. Quem prova arbitragem é EXECUCAO_COMPLETA.');
        assert.ok(maiorRetorno > 0n,
            'a cadeia não devolveu WETH em nenhuma tentativa: o mecanismo misto não corre, '
            + 'e isso é defeito do executor');
    });

    it('EXECUCAO_COMPLETA: recibo status=1, empréstimo quitado e lucro medido', async function () {
        const { melhor } = await melhorRota();
        if (melhor === null || melhor.bruto <= 0n) {
            // FALHA, e nao "passou com ressalva". Era o falso positivo que ela
            // apontou: *"Não aceite teste verde quando a operação que ele
            // deveria comprovar reverteu."*
            const r = replay;
            console.log('\n    NENHUM tamanho fecha neste estado — EXECUÇÃO NÃO COMPROVADA.');
            if (r !== null) {
                console.log(`    O replay reproduziu ${r.iguais} desfechos iguais ao original e`
                    + ` ${r.divergiram} divergentes; mudou o V3: ${r.mudouV3 ? 'SIM' : 'NÃO'},`
                    + ` mudou o Aerodrome: ${r.mudouAero ? 'SIM' : 'NÃO'}.`);
            }
            assert.fail('nenhuma execução atômica foi concluída: sem recibo status=1 não há '
                + 'arbitragem provada');
        }

        const antesArb = await saldo(WETH, arb);
        const antesTok = await saldo(ALVO.token, arb);
        const antesCofre = await saldo(WETH, cofre);
        const dados = iface.encodeFunctionData('executarRota',
            [rota(melhor.pagamento), melhor.quantia, 1n]);
        let rec = null; let erro = null;
        try {
            const tx = await chamar('eth_sendTransaction', [{
                from: dono, to: arb, data: dados, gas: '0xB71B00',
            }]);
            rec = await chamar('eth_getTransactionReceipt', [tx]);
        } catch (e) { erro = String(e.message ?? e); }

        assert.ok(rec !== null, `a execução não produziu recibo: ${String(erro).slice(0, 150)}`);
        assert.equal(rec.status, '0x1',
            `recibo status=${rec.status}: a transação reverteu, então o empréstimo NÃO foi `
            + `quitado. ${String(erro).slice(0, 120)}`);

        const depoisArb = await saldo(WETH, arb);
        const depoisTok = await saldo(ALVO.token, arb);
        const depoisCofre = await saldo(WETH, cofre);
        const bruto = depoisCofre - antesCofre;
        const gasUsado = BigInt(rec.gasUsed);
        const serializada = `0x${'02'.repeat(140 + dados.length / 2)}`;
        const l1 = num(await ler(ORACULO_DE_GAS_L1, codificarGetL1Fee(serializada)));
        const custo = somarCusto({
            gasUsado, gasUsadoVeioDe: 'recibo', baseFeeWei,
            gorjetaWei: 20_000_000n, custoL1Wei: l1, taxaDoEmprestimoWei: 0n,
        });
        const j = julgar(bruto, custo);

        console.log('\n    EXECUÇÃO ATÔMICA CONCLUÍDA — recibo status=1');
        console.log(`      tamanho ${melhor.quantia} | pagamento ${melhor.pagamento}`);
        console.log(`      executor WETH ${antesArb} -> ${depoisArb}`);
        console.log(`      executor token ${antesTok} -> ${depoisTok}`);
        console.log(`      COFRE ${antesCofre} -> ${depoisCofre} | bruto ${bruto}`);
        console.log(`      gás ${gasUsado} | ${custo.comoLer}`);
        console.log(`      VEREDICTO: ${j.veredicto.toUpperCase()} — ${j.porque.slice(0, 150)}`);

        assert.equal(depoisArb, antesArb, 'o executor retiveve WETH: o lucro vai ao cofre');
        assert.equal(depoisTok, antesTok, 'o executor retiveve o token: a liquidação não fechou');
        assert.ok(bruto > 0n, 'o cofre não recebeu nada');
        assert.equal(bruto, melhor.bruto, 'a cotação divergiu do realizado');
    });
});
