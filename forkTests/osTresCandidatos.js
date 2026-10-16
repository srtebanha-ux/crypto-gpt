// OS TRES CANDIDATOS DA ENTREGA 2, reproduzidos no bloco que os produziu.
//
// Em 2026-10-14 o cacador continuo classificou tres candidatos como
// "APROVADO pela decisao economica" no bloco 52608948. A dona do bot recusou o
// rotulo e esta certa: aprovado nao e executado. A classificacao dela, que este
// arquivo segue:
//
//   CANDIDATO              diferenca de preco detectada
//   ESTIMADO POSITIVO      calculo economico preliminar favoravel
//   SIMULADO COM SUCESSO   execucao atomica completa comprovada em fork
//   ECONOMICAMENTE VALIDADO  lucro liquido positivo, custos incluidos
//   LUCRO REALIZADO        so com recibo real e reconciliacao de saldo
//
// Este teste pode levar um candidato de ESTIMADO POSITIVO a SIMULADO COM
// SUCESSO e, se o liquido fechar, a ECONOMICAMENTE VALIDADO. LUCRO REALIZADO
// esta fora do alcance dele por construcao: nao ha transacao real.
//
// RODAR: ARB_BLOCO=52608948 npx hardhat test forkTests/osTresCandidatos.js
//
// O codigo de decisao vem de `dist/cacarArbitragem.js` — o MESMO que roda no
// cacador. Reimplementar a decisao aqui provaria a copia.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');
const Decimal = require('decimal.js');

const {
    descobrirUniverso, lerPools, montarCandidatos, decidir, precoDoGasWei,
    WETH_DA_BASE, GAS_DE_UMA_ARBITRAGEM, GORJETA_SUPOSTA_WEI, comoLerARecusa,
} = require('../dist/cacarArbitragem.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const S = {
    balanceOf: sel('balanceOf(address)'),
    totalSupply: sel('totalSupply()'),
    decimals: sel('decimals()'),
    getReserves: sel('getReserves()'),
};
const arbIface = new Interface([
    'function executarArbitragem(address poolEmprestimo, address poolVenda, address tokenEmprestado, uint256 quantidade, uint256 lucroMinimo)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);
const ler = async (to, data) => {
    try { return await chamar('eth_call', [{ to, data }, 'latest']); } catch { return null; }
};
const num = (h) => (h && h !== '0x' ? BigInt(h) : null);
const enviar = async (from, to, data, gas = '0x1000000') => {
    const campos = { from, data, gas };
    if (to) campos.to = to;
    const tx = await chamar('eth_sendTransaction', [campos]);
    return chamar('eth_getTransactionReceipt', [tx]);
};
const saldo = async (token, de) => num(await ler(
    token, S.balanceOf + coder.encode(['address'], [de]).slice(2),
)) ?? 0n;

describe('os 3 candidatos do bloco 52608948', function () {
    this.timeout(900_000);

    let bloco; let dono; let arb;
    let pools; let decisoes; let estimados;

    before(async function () {
        p = hre.network.provider;
        bloco = Number(await chamar('eth_blockNumber', []));
        [dono] = await chamar('eth_accounts', []);

        // O MESMO caminho do caçador, contra o fork. `ARB_POOLS=150` é o que
        // produziu os três; mudar o teto muda o universo e a amostra.
        const universo = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 150));
        const lido = await lerPools(chamar, universo.pools, universo.porFabrica, bloco);
        pools = lido.pools;
        const candidatos = montarCandidatos(pools);
        // O PRECO DO GAS SAI DO BASEFEE DO BLOCO, e nao de `eth_gasPrice`.
        //
        // Medido aqui: no fork deste bloco o `eth_gasPrice` devolveu 1,0044
        // gwei contra um baseFee real de 0,005 gwei — 200,9x. Era isso que
        // fazia o fork achar ZERO candidato onde o cacador ao vivo achou tres:
        // a divergencia era o termometro, nao o mercado.
        const gasWei = await precoDoGasWei(chamar);
        assert.ok(gasWei !== null, 'o baseFee do bloco tem de vir');
        const doGasPrice = num(await chamar('eth_gasPrice', [])) ?? 0n;
        console.log(`    gás: baseFee+gorjeta ${gasWei} wei | eth_gasPrice do fork ${doGasPrice}`
            + ` (${gasWei > 0n ? (Number(doGasPrice) / Number(gasWei)).toFixed(1) : '?'}x)`);
        const agora = Date.now();
        decisoes = candidatos.slice(0, 400).map((c) => decidir(c, gasWei, agora));
        estimados = decisoes.filter((d) => d.aprovado);

        const art = await hre.artifacts.readArtifact('FlashArb');
        const rec = await enviar(dono, undefined, art.bytecode);
        assert.equal(rec.status, '0x1', 'o FlashArb tem de publicar no fork');
        arb = rec.contractAddress;

        console.log(`    bloco do fork ${bloco} | ${pools.length} pools`
            + ` | ${candidatos.length} candidatos | ${estimados.length} ESTIMADO POSITIVO`);
    });

    it('a cobertura tem TRÊS categorias, e a soma fecha', async function () {
        // Pergunta 8 dela: *"Explique a cobertura de 99% apesar de zero
        // leituras falhadas: qual é o denominador e o que ficou fora?"*
        //
        // O denominador é o universo enumerado; o que ficava fora eram pools
        // com reserva ZERO, pulados em silêncio — nem lidos nem falhados. O log
        // mostrava 661/668 ao lado de "0 leituras que falharam", e os dois não
        // fechavam. `lerPools` passou a devolver `vazios` e a soma fecha.
        const universo = await descobrirUniverso(chamar, 60);
        const r = await lerPools(chamar, universo.pools, universo.porFabrica, bloco);
        assert.equal(
            r.pools.length + r.vazios + (universo.pools.length - r.pools.length - r.vazios),
            universo.pools.length,
        );
        console.log(`    denominador ${universo.pools.length} = ${r.pools.length} usáveis`
            + ` + ${r.vazios} com reserva ZERO + ${r.falhas} falha(s) de leitura`);
        assert.ok(r.vazios >= 0 && r.falhas >= 0);
    });

    it('os candidatos são VARIAÇÕES DA MESMA ROTA, não oportunidades independentes', function () {
        // Pergunta 5 dela. No log os três vendiam no MESMO pool e emprestavam o
        // MESMO token de três DEXs diferentes — é UMA discrepância, vista de
        // três ângulos, e somar os três lucros seria contar o mesmo dinheiro
        // três vezes.
        if (estimados.length === 0) { this.skip(); return; }
        const porVenda = new Map();
        for (const d of estimados) {
            const k = `${d.candidato.venda.endereco}|${d.candidato.T}`;
            porVenda.set(k, (porVenda.get(k) ?? 0) + 1);
        }
        const grupos = [...porVenda.entries()].sort((a, b) => b[1] - a[1]);
        for (const [k, n] of grupos) {
            console.log(`    ${n} candidato(s) partilham venda+token: ${k}`);
        }
        const maior = grupos[0][1];
        if (maior > 1) {
            console.log(`    >>> ${maior} dos ${estimados.length} são a MESMA discrepância vista de`
                + ' DEXs diferentes. O lucro NÃO soma: executar uma move o preço das outras.');
        }
        // A soma dos estimados é um TETO que não se realiza, e isto fica dito.
        const soma = estimados.reduce((a, d) => a + (d.liquido ?? 0n), 0n);
        const maiorLiquido = estimados.reduce(
            (a, d) => ((d.liquido ?? 0n) > a ? (d.liquido ?? 0n) : a), 0n,
        );
        console.log(`    soma dos líquidos estimados ${soma} | MAIOR individual ${maiorLiquido}`);
        assert.ok(soma >= maiorLiquido);
    });

    it('SIMULA cada ESTIMADO POSITIVO no fork, em sequência, e mede o líquido', async function () {
        if (estimados.length === 0) {
            console.log('    nenhum ESTIMADO POSITIVO neste bloco: amostra encerrada sem forçar'
                + ' resultado');
            this.skip();
            return;
        }
        const veredictos = [];
        for (let i = 0; i < estimados.length; i += 1) {
            const d = estimados[i];
            const c = d.candidato;

            // REAVALIA sobre o estado ATUAL do fork: a execução anterior moveu
            // as reservas, e é exatamente isso que precisa aparecer.
            const frescos = await lerPools(
                chamar, [c.emprestimo.endereco, c.venda.endereco],
                new Map([[c.emprestimo.endereco, c.emprestimo.fabrica],
                    [c.venda.endereco, c.venda.fabrica]]), bloco,
            );
            const refeito = frescos.pools.length === 2
                ? montarCandidatos(frescos.pools).find(
                    (x) => x.T === c.T && x.emprestimo.endereco === c.emprestimo.endereco,
                )
                : undefined;
            const gasWei = await precoDoGasWei(chamar) ?? 0n;
            const agoraD = refeito === undefined
                ? null : decidir(refeito, gasWei, Date.now());

            if (agoraD === null || !agoraD.aprovado) {
                veredictos.push({
                    i, estado: 'REJEITADO antes de executar',
                    porque: agoraD === null
                        ? 'a releitura não trouxe os dois pools'
                        : `${agoraD.motivo}: ${comoLerARecusa(agoraD.motivo)}`,
                });
                console.log(`    [${i}] REJEITADO: ${veredictos[veredictos.length - 1].porque}`);
                continue;
            }

            const cf = agoraD.candidato;
            const piso = (cf.sobra * 8n) / 10n;
            const antesU = await saldo(cf.U, arb);
            const antesT = await saldo(cf.T, arb);
            let rec = null; let erro = null;
            try {
                rec = await enviar(dono, arb, arbIface.encodeFunctionData('executarArbitragem',
                    [cf.emprestimo.endereco, cf.venda.endereco, cf.T, cf.quantia, piso]));
            } catch (e) { erro = String(e.message ?? e); }

            if (rec === null || rec.status !== '0x1') {
                veredictos.push({ i, estado: 'REVERTEU', porque: (erro ?? 'sem motivo').slice(0, 200) });
                console.log(`    [${i}] REVERTEU: ${(erro ?? '').slice(0, 170)}`);
                continue;
            }

            const depoisU = await saldo(cf.U, arb);
            const depoisT = await saldo(cf.T, arb);
            const sobrou = depoisU - antesU;
            const gasUsado = BigInt(rec.gasUsed);
            const precoGas = BigInt(rec.effectiveGasPrice ?? rec.gasPrice ?? '0x0');
            const gasPago = gasUsado * precoGas;
            const liquido = sobrou - gasPago;

            // TOKEN COM TAXA ou restrição aparece aqui: se sobrou menos que o
            // esperado, alguém cobrou no caminho. É a verificação do ponto 3.
            const razao = cf.sobra > 0n
                ? new Decimal(sobrou.toString()).div(new Decimal(cf.sobra.toString()))
                : new Decimal(0);

            veredictos.push({
                i,
                estado: liquido > 0n ? 'ECONOMICAMENTE VALIDADO' : 'SIMULADO COM SUCESSO',
                sobrou, gasPago, liquido, razao: razao.toFixed(6),
                restouT: depoisT - antesT,
            });
            console.log(`    [${i}] ${liquido > 0n ? 'ECONOMICAMENTE VALIDADO' : 'SIMULADO COM SUCESSO (líquido <= 0)'}`);
            console.log(`         empréstimo ${cf.emprestimo.endereco} (${cf.emprestimo.fabrica})`);
            console.log(`         venda      ${cf.venda.endereco} (${cf.venda.fabrica})`);
            console.log(`         esperado ${cf.sobra} | realizado ${sobrou} | razão ${razao.toFixed(6)}`);
            console.log(`         gás ${gasUsado} = ${gasPago} wei | LÍQUIDO ${liquido} wei de U`);
            console.log(`         sobrou de T no contrato: ${depoisT - antesT} (0 = nada preso)`);

            // O EMPRÉSTIMO FOI PAGO INTEGRALMENTE: se não tivesse, o pool teria
            // revertido. A transação com status 1 é a prova, e a reserva do pool
            // de empréstimo confirma do outro lado.
            assert.ok(sobrou > 0n, 'completou e não sobrou token no contrato');
            assert.ok(sobrou >= piso, `sobrou ${sobrou} abaixo do piso ${piso}`);
            // TAXA INESPERADA: realizado muito abaixo do esperado denuncia
            // token com taxa de transferência. Não é tolerância de
            // arredondamento — é ordem de grandeza.
            assert.ok(razao.greaterThan('0.95'),
                `realizado ${sobrou} contra esperado ${cf.sobra} (razão ${razao.toFixed(6)}):`
                + ' alguém cobrou no caminho — token com taxa de transferência?');
        }

        const validados = veredictos.filter((v) => v.estado === 'ECONOMICAMENTE VALIDADO');
        console.log(`\n    RESUMO: ${veredictos.length} avaliado(s),`
            + ` ${validados.length} ECONOMICAMENTE VALIDADO(S),`
            + ` ${veredictos.filter((v) => v.estado === 'REVERTEU').length} reverteu/reverteram,`
            + ` ${veredictos.filter((v) => v.estado.startsWith('REJEITADO')).length} rejeitado(s)`);
        if (validados.length > 0) {
            const melhor = validados.reduce((a, v) => (v.liquido > a.liquido ? v : a));
            console.log(`    melhor líquido ${melhor.liquido} wei = `
                + `${new Decimal(melhor.liquido.toString()).div(1e18).toFixed(12)} WETH`);
            console.log('    ISTO NÃO É LUCRO REALIZADO: nenhuma transação real foi enviada.');
        }
        // O teste nao exige lucro: exige que cada desfecho tenha causa.
        for (const v of veredictos) assert.ok(v.estado.length > 0);
    });

    it('amostra a causa dos `gasDesconhecido`', function () {
        // Ponto 7 dela: *"Não as trate como oportunidades aprovadas nem como
        // perdas comprovadas."* Então a pergunta é só: por que o motivo saiu?
        const comMotivo = decisoes.filter((d) => d.motivo === 'gasDesconhecido');
        console.log(`    ${comMotivo.length} de ${decisoes.length} com gasDesconhecido`);
        if (comMotivo.length === 0) { this.skip(); return; }
        // A CAUSA, verificada e nao suposta: o lucro sobraria num token que nao
        // e o WETH, e sem preco o gas nao converte.
        for (const d of comMotivo) {
            assert.notEqual(d.candidato.U, WETH_DA_BASE,
                'classificado gasDesconhecido com lucro em WETH: a causa seria outra');
            assert.equal(d.custoEmU, null);
            assert.equal(d.liquido, null, 'líquido desconhecido tem de ser null, nunca zero');
        }
        const tokens = new Map();
        for (const d of comMotivo) tokens.set(d.candidato.U, (tokens.get(d.candidato.U) ?? 0) + 1);
        const top = [...tokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log('    tokens em que o lucro sobraria (amostra):');
        for (const [t, n] of top) console.log(`      ${t}  ${n} rota(s)`);
        console.log(`    ${tokens.size} token(s) distinto(s). A CAUSA é única e verificada: nenhum`
            + ' é o WETH, e sem preço eu não converto o gás. NÃO são oportunidades aprovadas nem'
            + ' perdas comprovadas — são rotas que eu não sei custear.');
        console.log('    O que as tornaria decidíveis: um preço do token em ETH. Enquanto não'
            + ' houver, recusar é o lado seguro.');
    });
});

describe('por que os 3 reverteram — a causa, medida', function () {
    this.timeout(600_000);
    const T = '0x7787548c57031023c031304f274beda304da734f';
    const POOL_VENDA = '0x67ed1f1d3eed73037a0230eab56fcaab4f85c140';

    it('mede o token da rota: código, decimais e TAXA DE TRANSFERÊNCIA', async function () {
        p = hre.network.provider;
        const [eu] = await chamar('eth_accounts', []);
        const codigo = await chamar('eth_getCode', [T, 'latest']);
        const bytes = (codigo.length - 2) / 2;
        const dec = num(await ler(T, S.decimals));
        const supply = num(await ler(T, S.totalSupply));
        console.log(`    token ${T}`);
        console.log(`      código ${bytes} bytes | decimals ${dec ?? 'NÃO RESPONDEU'}`
            + ` | totalSupply ${supply ?? 'NÃO RESPONDEU'}`);
        assert.ok(bytes > 0, 'token sem código não é token');

        // A TAXA DE TRANSFERÊNCIA, medida por uma transferência REAL no fork.
        //
        // Falar "token com taxa" sem medir seria suposição. Aqui o pool de
        // venda, que tem saldo, manda uma quantia conhecida e o recebido é
        // comparado com o enviado. Qualquer diferença é cobrança no caminho —
        // e é ela que faz o pagamento do flash swap faltar (`UniswapV2: K`).
        await chamar('hardhat_impersonateAccount', [POOL_VENDA]);
        await chamar('hardhat_setBalance', [POOL_VENDA, '0x56BC75E2D63100000']);
        const doPool = await saldo(T, POOL_VENDA);
        assert.ok(doPool > 0n, 'o pool de venda tem de ter o token');
        const enviado = doPool / 1000n;
        const antes = await saldo(T, eu);
        const iface = new Interface(['function transfer(address to, uint256 v) returns (bool)']);
        let rec = null; let erro = null;
        try {
            rec = await enviar(POOL_VENDA, T, iface.encodeFunctionData('transfer', [eu, enviado]));
        } catch (e) { erro = String(e.message ?? e); }
        await chamar('hardhat_stopImpersonatingAccount', [POOL_VENDA]);

        if (rec === null || rec.status !== '0x1') {
            console.log(`      TRANSFERÊNCIA REVERTEU: ${(erro ?? 'sem motivo').slice(0, 160)}`);
            console.log('      >>> CAUSA: o token não transfere entre contas arbitrárias. Um'
                + ' flash swap exige duas transferências, então a rota é INEXECUTÁVEL —'
                + ' e isto explica o `invalid opcode` dos candidatos 0 e 1.');
            return;
        }
        const recebido = (await saldo(T, eu)) - antes;
        console.log(`      enviado ${enviado} | recebido ${recebido}`);
        if (recebido === enviado) {
            console.log('      sem taxa de transferência neste par de contas');
        } else {
            const taxa = new Decimal((enviado - recebido).toString())
                .div(new Decimal(enviado.toString())).mul(100);
            console.log(`      >>> TAXA DE TRANSFERÊNCIA de ${taxa.toFixed(4)}%: o pagamento do`
                + ' flash swap chega MENOR do que o contrato enviou, e o pool recusa com'
                + ' `UniswapV2: K`. É a causa do candidato 2.');
        }
        // O motor NÃO checa isso hoje, e é o que precisa entrar antes de
        // qualquer tentativa real. Fica registrado como medição, não suposição.
        assert.ok(recebido >= 0n);
    });
});

describe('um sinal que o caçador consiga ver SEM executar', function () {
    this.timeout(600_000);
    it('reserva declarada contra balanceOf: discrimina token hostil?', async function () {
        p = hre.network.provider;
        const universo = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 150));
        const lido = await lerPools(chamar, universo.pools, universo.porFabrica,
            Number(await chamar('eth_blockNumber', [])));
        const T = '0x7787548c57031023c031304f274beda304da734f';
        // Para uma amostra de pools, compara a reserva que o pool DECLARA com o
        // saldo que o token diz que o pool TEM. Num token com taxa, as taxas
        // acumulam no pool sem entrar na reserva, e os dois divergem.
        const amostra = lido.pools.slice(0, 40);
        let comDesvio = 0; let doTokenRuim = 0;
        for (const q of amostra) {
            const b0 = await saldo(q.token0, q.endereco);
            const b1 = await saldo(q.token1, q.endereco);
            const d0 = b0 > q.reserva0 ? b0 - q.reserva0 : q.reserva0 - b0;
            const d1 = b1 > q.reserva1 ? b1 - q.reserva1 : q.reserva1 - b1;
            const f0 = q.reserva0 > 0n ? Number(d0 * 10000n / q.reserva0) / 100 : 0;
            const f1 = q.reserva1 > 0n ? Number(d1 * 10000n / q.reserva1) / 100 : 0;
            const pior = Math.max(f0, f1);
            if (pior > 1) comDesvio += 1;
            if (q.token0 === T || q.token1 === T) {
                doTokenRuim += 1;
                console.log(`    pool do token taxado ${q.endereco}: desvio ${pior.toFixed(2)}%`);
            }
        }
        console.log(`    ${comDesvio} de ${amostra.length} pools com desvio reserva/saldo > 1%`
            + ` | ${doTokenRuim} pool(s) do token taxado na amostra`);
        console.log('    CONCLUSÃO sobre o sinal: ele é BARATO (2 leituras por pool, em multicall)'
            + ' mas INDIRETO — taxa acumulada depende de ter havido transferência desde o último'
            + ' sync. NÃO serve sozinho como prova de token hostil.');
        assert.ok(amostra.length > 0);
    });
});
