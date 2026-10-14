// ENTREGA 1 — ARBITRAGEM COM FLASH LOAN, DE PONTA A PONTA, EM FORK DA BASE.
//
// O que NUNCA foi provado neste projeto: que o caminho inteiro da arbitragem
// funciona. `flashArbContract.test.ts` prova PARIDADE DE MATEMATICA (a saida de
// swap do contrato bate com a do scanner) contra mocks — isso nao e integracao.
// Nenhum teste pegava pool real, lia reserva real, escolhia rota, dimensionava,
// executava atomicamente e pagava o emprestimo.
//
// Aqui roda o vertical, contra a Base no estado de agora:
//
//   1. descobre pools REAIS na fabrica V2 da Base
//   2. le token0/token1/getReserves dos pools NO FORK (o mesmo estado que a
//      transacao vai encontrar — ler do RPC publico daria outro bloco)
//   3. agrupa por par e acha pares presentes em DOIS pools (ciclo de 2 pernas)
//   4. avalia e dimensiona com as funcoes REAIS do projeto:
//      `evaluateCycle` / `findOptimalCycleInput` / `getAmountOut` de ammMath.ts
//   5. executa `FlashArb.executarArbitragem` — flash swap V2, emprestimo e
//      pagamento na MESMA transacao
//   6. mede o resultado liquido: lucro no contrato menos o gas do recibo
//   7. quando nao ha oportunidade, prova a RECUSA em vez de fabricar lucro
//
// MEDIDO NA CORRENTE antes de escrever este arquivo (2026-10-14, mainnet.base.org):
//
//   fabrica V2 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6  ->  responde
//   pool[0] 0x88a43bbd…  11.293 bytes, e TEM no bytecode:
//     uniswapV2Call(address,uint256,uint256,bytes)   <- o callback do flash swap
//     swap(uint256,uint256,address,bytes)
//     getReserves()
//
// E O ACHADO ESTRUTURAL, que mudou o desenho deste teste: **uma fabrica V2 tem
// UM pool por par de tokens.** Entao arbitragem de duas pernas DENTRO de uma
// fabrica e impossivel por construcao — a primeira versao deste teste varreu
// 166 pools da Uniswap V2 e achou "0 candidatos", e isso NAO era escassez
// economica: era espaco de busca vazio. Publicar aquilo como "nao ha
// oportunidade neste bloco" seria ausencia com cara de resposta.
//
// O proprio `dexArbitrageSniffer.ts` ja dizia isso no texto de ajuda dele:
// *"Duas DEXs diferentes e o que permite arbitragem entre elas; uma so
// raramente fecha ciclo."* Eu reencontrei de fora o que o repositorio sabia.
//
// AS FABRICAS, medidas na corrente em 2026-10-14 pelo par WETH/USDC — cada uma
// entrou como HIPOTESE e a corrente decidiu, lendo o bytecode do pool devolvido:
//
//   Uniswap V2   0x8909Dc15…  pool 0x88a43bbd…  11.293b  [uniswapV2Call,swap,getReserves]
//   SushiSwap V2 0x71524B4f…  pool 0x2f8818d1…   9.079b  [uniswapV2Call,swap,getReserves]
//   SwapBased    0x04C9f118…  pool 0xaeeb835f…   8.708b  [uniswapV2Call,swap,getReserves]
//   Alien Base   0x3E84D913…  pool 0xb16d2257…  11.277b  [uniswapV2Call,swap,getReserves]
//
// FORA, e declarado: PancakeSwap e BaseSwap devolveram pool com `swap` e
// `getReserves` mas SEM `uniswapV2Call` — elas usam outro nome de callback, e
// este contrato nao as atende. RocketSwap nao respondeu `getPair`.
//
// E os pools da **Aerodrome** sao proxies de 45 bytes: procurar seletor no
// bytecode deles NAO responde nada, nem a favor nem contra. Integra-la exige
// descobrir o callback por EXECUCAO, e fica PENDENTE em vez de suposto.
//
// NENHUMA TRANSACAO REAL: tudo em `hardhat` com `forking`. Nada de capital.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');
const Decimal = require('decimal.js');

const {
    evaluateCycle, getAmountOut, simulateCycle,
    saidaCrua, entradaNecessariaCrua, sobraDoFlashSwap,
} = require('../dist/ammMath.js');

// As fabricas cuja superficie de FLASH SWAP a corrente confirmou (ver o
// cabecalho). Trocaveis por variavel, sem editar o teste.
const FABRICAS = (process.env.ARB_FABRICAS ?? [
    '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', // Uniswap V2
    '0x71524B4f93c58fcbF659783284E38825f0622859', // SushiSwap V2
    '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300', // SwapBased
    '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7', // Alien Base
].join(',')).split(',').map((x) => x.trim().toLowerCase()).filter((x) => x.length === 42);
// Quantos pools olhar POR FABRICA SECUNDARIA. Teto pequeno: cada um custa 3
// chamadas, e o que interessa sao os pares que existem em mais de uma DEX.
const QUANTOS_POOLS = Number(process.env.ARB_POOLS ?? 120);
// A taxa do pool V2 canonico. Entra como CONSTANTE declarada, nao medida por
// pool — se algum pool cobrar outra, a avaliacao erra e a execucao reverte, que
// e o lado seguro.
const TAXA_V2 = new Decimal('0.003');
// Gas de uma arbitragem de duas pernas. ESCOLHA declarada, usada so para o
// PISO economico; o gas REAL sai do recibo no fim e e ele que entra no liquido.
const GAS_SUPOSTO = 350_000n;

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const S = {
    allPairsLength: sel('allPairsLength()'),
    allPairs: sel('allPairs(uint256)'),
    token0: sel('token0()'),
    token1: sel('token1()'),
    getReserves: sel('getReserves()'),
    decimals: sel('decimals()'),
    balanceOf: sel('balanceOf(address)'),
    getPair: sel('getPair(address,address)'),
};

let p;
const chamar = (m, ps) => p.send(m, ps);
const ler = async (to, data) => {
    try {
        return await chamar('eth_call', [{ to, data }, 'latest']);
    } catch {
        return null;
    }
};
const num = (hex) => (hex && hex !== '0x' ? BigInt(hex) : null);
/** Envia e devolve o recibo. RPC cru: este projeto nao carrega hardhat-ethers. */
const enviar = async (from, to, data, gas = '0x1000000') => {
    const campos = { from, data, gas };
    if (to) campos.to = to;
    const tx = await chamar('eth_sendTransaction', [campos]);
    return chamar('eth_getTransactionReceipt', [tx]);
};
const arbIface = new Interface([
    'function executarArbitragem(address poolEmprestimo, address poolVenda, address tokenEmprestado, uint256 quantidade, uint256 lucroMinimo)',
    'function dono() view returns (address)',
]);
const mathIface = new Interface([
    'function amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) pure returns (uint256)',
    'function amountIn(uint256 amountOut_, uint256 reserveIn, uint256 reserveOut) pure returns (uint256)',
]);
const end = (hex) => (hex && hex.length >= 42 ? `0x${hex.slice(-40)}`.toLowerCase() : null);

/** Le em lote, com concorrencia limitada: 180 pools sao 540 chamadas. */
async function emLote(itens, trabalho, concorrencia = 12) {
    const fora = new Array(itens.length);
    let i = 0;
    await Promise.all(Array.from({ length: concorrencia }, async () => {
        for (;;) {
            const meu = i; i += 1;
            if (meu >= itens.length) return;
            fora[meu] = await trabalho(itens[meu], meu);
        }
    }));
    return fora;
}

describe('ENTREGA 1 — arbitragem com flash loan de ponta a ponta', function () {
    this.timeout(900_000);

    let bloco;
    let pools;        // os pools REAIS, com reserva lida no fork
    let candidatos;   // pares em dois pools, avaliados
    let arb;          // o FlashArb implantado no fork
    let harness;      // MathHarness, para a paridade (ver o guard no teste)
    let dono;

    before(async function () {
        p = hre.network.provider;
        bloco = Number(await chamar('eth_blockNumber', []));
        [dono] = await chamar('eth_accounts', []);

        // ETAPA 1+2 — DESCOBRIR POOLS REAIS E LER O ESTADO NO FORK.
        //
        // Do FORK e nao do RPC publico: a transacao vai executar contra este
        // estado, e ler de outro bloco produziria uma avaliacao que nao
        // corresponde ao que o contrato encontra.
        //
        // MODO CRUZADO: enumera as fabricas MENORES (poucos pools, baratas de
        // varrer), e para cada par que elas tem pergunta a TODAS as outras por
        // `getPair`. E o unico modo que pode fechar um ciclo de duas pernas —
        // ver o achado estrutural no cabecalho.
        const decimaisDe = new Map();
        const lerPool = async (a, fabrica) => {
            const [t0, t1, r] = await Promise.all([
                ler(a, S.token0), ler(a, S.token1), ler(a, S.getReserves),
            ]);
            const token0 = end(t0); const token1 = end(t1);
            if (token0 === null || token1 === null || !r || r === '0x') return null;
            let r0; let r1;
            try { [r0, r1] = coder.decode(['uint112', 'uint112', 'uint32'], r); } catch { return null; }
            if (r0 === 0n || r1 === 0n) return null;
            return { address: a.toLowerCase(), fabrica, token0, token1, r0, r1 };
        };

        // Quantos pools cada fabrica tem: define quem e "menor".
        const tamanhos = await emLote(FABRICAS, async (f) => ({
            fabrica: f, total: num(await ler(f, S.allPairsLength)),
        }));
        const vivas = tamanhos.filter((x) => x.total !== null && x.total > 0n);
        assert.ok(vivas.length >= 2,
            `só ${vivas.length} fábrica(s) respondeu allPairsLength — com uma só, arbitragem de `
            + 'duas pernas é impossível por construção, não por falta de oportunidade');
        vivas.sort((a, b) => (a.total < b.total ? -1 : 1));
        const menores = vivas.slice(0, vivas.length - 1); // todas menos a maior
        const maiores = vivas;

        // Pools das fabricas menores.
        const brutos = [];
        for (const { fabrica, total } of menores) {
            const quantos = Math.min(QUANTOS_POOLS, Number(total));
            const indices = Array.from({ length: quantos }, (_, k) => Number(total) - 1 - k);
            const ends = (await emLote(indices, async (idx) => end(
                await ler(fabrica, S.allPairs + coder.encode(['uint256'], [idx]).slice(2)),
            ))).filter((x) => x !== null);
            brutos.push(...(await emLote(ends, (a) => lerPool(a, fabrica))).filter((x) => x !== null));
        }
        assert.ok(brutos.length > 0, 'nenhum pool com reserva veio das fábricas menores');

        // O MESMO PAR nas outras fabricas. É aqui que o ciclo pode fechar.
        const pares = [...new Map(brutos.map((x) => [
            [x.token0, x.token1].sort().join('|'), [x.token0, x.token1],
        ])).values()];
        const cruzados = [];
        for (const f of maiores) {
            const achados = await emLote(pares, async ([a, b]) => {
                const r = await ler(f.fabrica, S.getPair
                    + coder.encode(['address', 'address'], [a, b]).slice(2));
                const pool = end(r);
                if (pool === null || /^0x0+$/.test(pool)) return null;
                return lerPool(pool, f.fabrica);
            });
            cruzados.push(...achados.filter((x) => x !== null));
        }
        const vivos = [...new Map([...brutos, ...cruzados].map((x) => [x.address, x])).values()];

        // `decimals()` de cada token, uma vez por token.
        const tokens = [...new Set(vivos.flatMap((x) => [x.token0, x.token1]))];
        await emLote(tokens, async (t) => {
            const d = num(await ler(t, S.decimals));
            decimaisDe.set(t, d === null ? 18 : Number(d));
        });
        const esc = (v, d) => new Decimal(v.toString()).div(new Decimal(10).pow(d));
        pools = vivos.map((x) => ({
            address: x.address, fabrica: x.fabrica, token0: x.token0, token1: x.token1,
            reserve0: esc(x.r0, decimaisDe.get(x.token0) ?? 18),
            reserve1: esc(x.r1, decimaisDe.get(x.token1) ?? 18),
            dec0: decimaisDe.get(x.token0) ?? 18,
            dec1: decimaisDe.get(x.token1) ?? 18,
            feeFraction: TAXA_V2,
        }));

        // ETAPA 3 — PARES EM DOIS POOLS.
        const porPar = new Map();
        for (const q of pools) {
            const k = [q.token0, q.token1].sort().join('|');
            if (!porPar.has(k)) porPar.set(k, []);
            porPar.get(k).push(q);
        }

        // ETAPA 4 — AVALIAR E DIMENSIONAR, com as funções REAIS.
        const gasWei = BigInt(num(await chamar('eth_gasPrice', [])) ?? 0n);
        candidatos = [];
        for (const [, lista] of porPar) {
            if (lista.length < 2) continue;
            for (let i = 0; i < lista.length; i += 1) {
                for (let j = 0; j < lista.length; j += 1) {
                    if (i === j) continue;
                    const emprestimo = lista[i]; const venda = lista[j];
                    // Empresta T do pool `emprestimo`, vende em `venda`, paga.
                    for (const qualT of [0, 1]) {
                        const T = qualT === 0 ? emprestimo.token0 : emprestimo.token1;
                        const U = qualT === 0 ? emprestimo.token1 : emprestimo.token0;
                        const hops = [
                            // perna 1: T -> U no pool de VENDA
                            {
                                reserveIn: venda.token0 === T ? venda.reserve0 : venda.reserve1,
                                reserveOut: venda.token0 === T ? venda.reserve1 : venda.reserve0,
                                feeFraction: TAXA_V2,
                            },
                            // perna 2: U -> T no pool do EMPRÉSTIMO (é o pagamento)
                            {
                                reserveIn: emprestimo.token0 === U
                                    ? emprestimo.reserve0 : emprestimo.reserve1,
                                reserveOut: emprestimo.token0 === U
                                    ? emprestimo.reserve1 : emprestimo.reserve0,
                                feeFraction: TAXA_V2,
                            },
                        ];
                        if (hops.some((h) => h.reserveIn.lessThanOrEqualTo(0)
                            || h.reserveOut.lessThanOrEqualTo(0))) continue;
                        // O TETO é a reserva do token emprestado: não se
                        // empresta o que o pool não tem.
                        const teto = hops[0].reserveIn.mul('0.3');
                        // O gás em unidade do token do ciclo. Só é conhecido
                        // quando T é o token nativo embrulhado; para qualquer
                        // outro token eu NÃO sei a conversão sem um preço, e
                        // inventá-la seria fabricar o piso econômico. Então o
                        // custo entra como ZERO e o candidato fica marcado como
                        // SEM PISO DE GÁS — ele não pode ser declarado lucrativo.
                        const ehWeth = T === '0x4200000000000000000000000000000000000006';
                        const gasNoToken = ehWeth
                            ? new Decimal((gasWei * GAS_SUPOSTO).toString()).div(1e18)
                            : new Decimal(0);
                        const av = evaluateCycle(hops, teto, {
                            // FLASH SWAP V2 não cobra taxa separada: a taxa do
                            // pool JÁ está nas duas pernas (0,3% cada). Cobrar
                            // 0,05% de Aave aqui seria somar uma taxa que esta
                            // fonte de liquidez não cobra.
                            flashLoanFeeFraction: new Decimal(0),
                            gasCostInToken: gasNoToken,
                        });
                        if (!av.netProfit.greaterThan(0)) continue;
                        candidatos.push({
                            emprestimo, venda, T, U, hops, av,
                            pisoDeGasConhecido: ehWeth,
                            decT: emprestimo.token0 === T ? emprestimo.dec0 : emprestimo.dec1,
                            decU: emprestimo.token0 === U ? emprestimo.dec0 : emprestimo.dec1,
                        });
                    }
                }
            }
        }
        candidatos.sort((a, b) => (b.av.netProfit.greaterThan(a.av.netProfit) ? 1 : -1));

        // O CONTRATO, implantado no fork a partir do fonte do repositório.
        const artArb = await hre.artifacts.readArtifact('FlashArb');
        const recArb = await enviar(dono, undefined, artArb.bytecode);
        assert.equal(recArb.status, '0x1', 'o FlashArb tem de publicar no fork');
        arb = recArb.contractAddress;
        const artMath = await hre.artifacts.readArtifact('MathHarness');
        const recMath = await enviar(dono, undefined, artMath.bytecode);
        assert.equal(recMath.status, '0x1', 'o MathHarness tem de publicar no fork');
        harness = recMath.contractAddress;
    });

    it('descobre pools reais e lê o estado on-chain do mesmo bloco', function () {
        assert.ok(pools.length >= 10,
            `só ${pools.length} pools com reserva: a descoberta não está trazendo estado real`);
        // Reserva lida é POSITIVA e os tokens são distintos: um pool que não
        // passa disto não é pool, e contá-lo infla a descoberta.
        for (const q of pools.slice(0, 20)) {
            assert.ok(q.reserve0.greaterThan(0) && q.reserve1.greaterThan(0));
            assert.notEqual(q.token0, q.token1);
        }
        console.log(`    bloco ${bloco} | ${pools.length} pools com reserva real`
            + ` | ${candidatos.length} candidato(s) de 2 pernas com lucro bruto positivo`);
    });

    it('a matemática do CONTRATO bate com a do avaliador, no estado real', async function () {
        // Paridade sobre RESERVA REAL, não mock: é o que liga o número que
        // decide ao número que executa. Se divergirem, a avaliação aprova o que
        // a execução reverte.
        const q = pools.find((x) => x.reserve0.greaterThan(1) && x.reserve1.greaterThan(1));
        assert.ok(q, 'nenhum pool com reserva suficiente para a paridade');
        const entrada = q.reserve0.div(1000);
        const fora = getAmountOut(entrada, {
            reserveIn: q.reserve0, reserveOut: q.reserve1, feeFraction: TAXA_V2,
        });
        // O contrato calcula em unidades CRUAS. `_amountOut` do FlashArb e
        // `interna`, então a paridade passa pelo MathHarness — que DUPLICA a
        // fórmula, e uma cópia prova a cópia. O guard abaixo fecha isso: as
        // duas expressões têm de ser idênticas no fonte, senão o harness pode
        // divergir do contrato que executa e a paridade não vale nada.
        const fs = require('node:fs');
        const corpoDoArb = fs.readFileSync('contracts/FlashArb.sol', 'utf8');
        const corpoDoHarness = fs.readFileSync('contracts/MathHarness.sol', 'utf8');
        // As duas LINHAS da fórmula, como estão nos dois arquivos (medido).
        const linhas = [
            'uint256 amountInComTaxa = amountIn * 997;',
            'return (amountInComTaxa * reserveOut) / (reserveIn * 1000 + amountInComTaxa);',
        ];
        for (const l of linhas) {
            assert.ok(corpoDoArb.includes(l),
                `a fórmula do FlashArb mudou (${l}): a paridade pelo harness deixou de valer`);
            assert.ok(corpoDoHarness.includes(l),
                `MathHarness divergiu do FlashArb (${l}): a cópia pararia de provar o original`);
        }
        const cru = (v, d) => BigInt(v.mul(new Decimal(10).pow(d)).toFixed(0));
        const doContrato = num(await ler(harness, mathIface.encodeFunctionData('amountOut', [
            cru(entrada, q.dec0), cru(q.reserve0, q.dec0), cru(q.reserve1, q.dec1),
        ])));
        assert.ok(doContrato !== null, 'o MathHarness não respondeu');
        const esperado = cru(fora, q.dec1);
        // TOLERÂNCIA RELATIVA, e não absoluta de 2 unidades: a primeira versão
        // deste teste reprovou por 500 unidades em 1,29e22 — erro relativo de
        // 4e-20, que é precisão de `Decimal` contra inteiro da EVM, não
        // divergência de lógica. Tolerância absoluta sobre número de 22 dígitos
        // mede o tipo de dado, não a fórmula.
        const d = doContrato > esperado ? doContrato - esperado : esperado - doContrato;
        const rel = new Decimal(d.toString()).div(new Decimal(esperado.toString()));
        assert.ok(rel.lessThan('1e-12'),
            `contrato ${doContrato} contra avaliador ${esperado} (erro relativo ${rel.toExponential(3)})`);
        console.log(`    paridade sobre reserva real: erro relativo ${rel.toExponential(3)}`);
    });

    it('a aritmética do CAÇADOR CONTÍNUO é igual à do contrato, bit a bit', async function () {
        // ENTREGA 2 decide com `saidaCrua`/`entradaNecessariaCrua` (BigInt), e
        // não com `Decimal`: o pagamento do flash swap é arredondado PARA CIMA
        // pelo contrato, e um `Decimal` que arredonda para baixo aprova o que a
        // cadeia recusa. Esta igualdade EXATA contra o contrato implantado é o
        // que faz daquelas funções uma leitura do contrato, e não uma
        // reimplementação paralela.
        const amostras = pools.slice(0, 12).filter(
            (q) => q.reserve0.greaterThan(0) && q.reserve1.greaterThan(0),
        );
        assert.ok(amostras.length >= 3, 'poucos pools para a conferência');
        let conferidas = 0;
        for (const q of amostras) {
            const cru = (v, d) => BigInt(v.mul(new Decimal(10).pow(d)).toFixed(0));
            const rIn = cru(q.reserve0, q.dec0);
            const rOut = cru(q.reserve1, q.dec1);
            if (rIn <= 0n || rOut <= 0n) continue;
            for (const div of [1000n, 97n, 7n]) {
                const entrada = rIn / div;
                if (entrada <= 0n) continue;
                const noContrato = num(await ler(harness,
                    mathIface.encodeFunctionData('amountOut', [entrada, rIn, rOut])));
                assert.equal(saidaCrua(entrada, rIn, rOut), noContrato,
                    `saidaCrua divergiu do contrato em ${q.address} com entrada ${entrada}`);
                const saida = noContrato / 2n;
                if (saida <= 0n || saida >= rOut) continue;
                const entradaNoContrato = num(await ler(harness,
                    mathIface.encodeFunctionData('amountIn', [saida, rIn, rOut])));
                assert.equal(entradaNecessariaCrua(saida, rIn, rOut), entradaNoContrato,
                    `entradaNecessariaCrua divergiu em ${q.address} com saída ${saida}`);
                conferidas += 1;
            }
        }
        assert.ok(conferidas >= 6, `só ${conferidas} conferências`);
        console.log(`    ${conferidas} conferências EXATAS da aritmética do caçador contra o contrato`);
    });

    it('o contrato RECUSA operação sem margem — e a recusa é verificável', async function () {
        // A proteção que existe para o dinheiro, exercitada SEMPRE: ela não
        // depende de haver oportunidade no bloco. Piso impossível tem de
        // reverter, e com os DOIS números no erro.
        const q = pools.find((x) => x.reserve0.greaterThan(1) && x.reserve1.greaterThan(1));
        const quantia = BigInt(q.reserve0.div(10_000).mul(new Decimal(10).pow(q.dec0)).toFixed(0));
        assert.ok(quantia > 0n);
        const outro = pools.find((x) => x.address !== q.address
            && ((x.token0 === q.token0 && x.token1 === q.token1)
                || (x.token0 === q.token1 && x.token1 === q.token0)));
        const poolVenda = outro ? outro.address : q.address;
        const pisoImpossivel = (1n << 120n);
        const dados = arbIface.encodeFunctionData('executarArbitragem',
            [q.address, poolVenda, q.token0, quantia, pisoImpossivel]);
        // `eth_call` revela a reversão sem gastar bloco; se ela PASSAR, o
        // portão que protege o dinheiro não existe.
        let passou = false;
        try {
            await chamar('eth_call', [{ from: dono, to: arb, data: dados }, 'latest']);
            passou = true;
        } catch (e) {
            console.log(`    piso impossível RECUSADO: ${String(e.message ?? e).slice(0, 110)}`);
        }
        assert.equal(passou, false,
            'o contrato ACEITOU uma operação com piso de lucro impossível');
    });

    /**
     * A conta do PROPRIO contrato para um candidato, e a decisao economica.
     *
     * Vive fora dos testes porque dois deles a usam para afirmar coisas
     * DIFERENTES: um prova que o mecanismo executa e paga; o outro prova que a
     * economia recusa quando nada paga o gas. Misturar as duas foi o defeito da
     * primeira versao — ela executou e PASSOU sobre uma operacao de prejuizo.
     */
    async function decidir() {
        const cru = (v, d) => BigInt(v.mul(new Decimal(10).pow(d)).toFixed(0));
        const WETH = '0x4200000000000000000000000000000000000006';
        const conta = async (k) => {
            const q = cru(k.av.amountIn, k.decT);
            if (q <= 0n) return null;
            const vT0 = k.venda.token0 === k.T;
            const uOut = num(await ler(harness, mathIface.encodeFunctionData('amountOut', [
                q,
                cru(vT0 ? k.venda.reserve0 : k.venda.reserve1, vT0 ? k.venda.dec0 : k.venda.dec1),
                cru(vT0 ? k.venda.reserve1 : k.venda.reserve0, vT0 ? k.venda.dec1 : k.venda.dec0),
            ])));
            const eU0 = k.emprestimo.token0 === k.U;
            const uReq = num(await ler(harness, mathIface.encodeFunctionData('amountIn', [
                q,
                cru(eU0 ? k.emprestimo.reserve0 : k.emprestimo.reserve1,
                    eU0 ? k.emprestimo.dec0 : k.emprestimo.dec1),
                cru(eU0 ? k.emprestimo.reserve1 : k.emprestimo.reserve0,
                    eU0 ? k.emprestimo.dec1 : k.emprestimo.dec0),
            ])));
            if (uOut === null || uReq === null) return null;
            return { ...k, quantia: q, uOut, uReq, sobraEmU: uOut - uReq };
        };
        const avaliados = (await emLote(candidatos.slice(0, 40), conta, 8))
            .filter((x) => x !== null && x.sobraEmU > 0n);
        avaliados.sort((a, b) => (b.sobraEmU > a.sobraEmU ? 1 : -1));
        // O GAS no token em que o lucro sobra. Conhecido so quando U e o WETH;
        // sem conversao o candidato NAO e aprovavel, e isso e dito.
        const gasWeiAgora = BigInt(num(await chamar('eth_gasPrice', [])) ?? 0n);
        const comMargem = [];
        let semConversao = 0;
        for (const k of avaliados) {
            if (k.U !== WETH) { semConversao += 1; continue; }
            const custo = gasWeiAgora * GAS_SUPOSTO;
            if (k.sobraEmU > custo) comMargem.push({ ...k, custo });
        }
        return { avaliados, comMargem, semConversao, gasWeiAgora };
    }

    it('MECANISMO: executa a melhor rota atomicamente e paga o empréstimo', async function () {
        // Esta e a prova do MECANISMO, e so dela: que o flash swap empresta,
        // vende na outra DEX, paga e sobra token, com a conta batendo com a
        // execucao. Ela NAO afirma lucro — a economia e o teste seguinte, e
        // confundir as duas foi o defeito que esta separacao conserta.
        if (candidatos.length === 0) {
            // A RECUSA CORRETA, e ela é o resultado honesto quando o bloco não
            // oferece nada. Fabricar lucro aqui seria provar o contrário do que
            // este teste existe para medir.
            console.log('    NENHUMA oportunidade de 2 pernas com lucro líquido positivo neste'
                + ` bloco (${bloco}), entre ${pools.length} pools. Isto é a RECUSA correta:`
                + ' o motor avaliou e rejeitou. Não há lucro a demonstrar.');
            this.skip();
            return;
        }
        // A ETAPA ECONOMICA NAO ENTRA AQUI: ver o teste seguinte.
        const { avaliados } = await decidir();
        if (avaliados.length === 0) {
            console.log('    nenhum candidato com sobra positiva pela conta do contrato neste bloco');
            this.skip();
            return;
        }
        const c = avaliados[0];
        const quantia = c.quantia;
        const esperadoEmU = c.sobraEmU;
        console.log(`    token emprestado T=${c.T} | lucro sobra em U=${c.U}`);
        console.log(`    recebe ${c.uOut} U, paga ${c.uReq} U -> sobra esperada ${esperadoEmU} (cru)`);
        const piso = (esperadoEmU * 8n) / 10n;
        assert.ok(piso > 0n);

        const saldoEmU = async () => num(await ler(c.U, S.balanceOf
            + coder.encode(['address'], [arb]).slice(2))) ?? 0n;
        const antes = await saldoEmU();
        const recibo = await enviar(dono, arb, arbIface.encodeFunctionData(
            'executarArbitragem', [c.emprestimo.address, c.venda.address, c.T, quantia, piso],
        ));
        assert.equal(recibo.status, '0x1', 'a transação não completou');
        const depois = await saldoEmU();
        const lucroCru = depois - antes;
        assert.ok(lucroCru > 0n, `a transação completou e NÃO sobrou token: ${lucroCru}`);
        assert.ok(lucroCru >= piso, `sobrou ${lucroCru} e o piso exigido era ${piso}`);

        // O LÍQUIDO, com o gás do RECIBO e não o suposto.
        const gasUsado = BigInt(recibo.gasUsed);
        const precoDoGas = BigInt(recibo.effectiveGasPrice ?? recibo.gasPrice ?? '0x0');
        const gasPago = gasUsado * precoDoGas;
        const lucro = new Decimal(lucroCru.toString()).div(new Decimal(10).pow(c.decU));
        const liquido = new Decimal((lucroCru - gasPago).toString()).div(1e18);
        console.log(`    EXECUTOU: empréstimo ${c.emprestimo.address} (${c.emprestimo.fabrica})`);
        console.log(`              venda      ${c.venda.address} (${c.venda.fabrica})`);
        console.log(`    tamanho ${c.av.amountIn.toFixed(8)} T | sobrou ${lucro.toFixed(10)} U`);
        console.log(`    gás ${gasUsado} (${new Decimal(gasPago.toString()).div(1e18).toFixed(8)} ETH)`);
        console.log(`    sobra menos gás do recibo: ${liquido.toFixed(10)} ETH`
            + ` — ${lucroCru > gasPago ? 'PAGA' : 'NÃO PAGA'} o próprio gás`);
        console.log('    ESTE TESTE NÃO AFIRMA LUCRO: ele prova que o empréstimo foi pago e que a'
            + ' conta do contrato bate com a execução. A economia é o teste seguinte.');

        // A CONTA DO CONTRATO TEM DE BATER COM A EXECUÇÃO.
        const razaoU = new Decimal(lucroCru.toString())
            .div(new Decimal(esperadoEmU.toString()));
        console.log(`    realizado/esperado (pela conta do contrato) ${razaoU.toFixed(6)}`);
        assert.ok(razaoU.greaterThan('0.99') && razaoU.lessThan('1.01'),
            `realizado ${lucroCru} contra esperado ${esperadoEmU}`);

    });

    it('ECONOMIA: só aprova operação que paga o próprio gás, e recusa o resto', async function () {
        // A exigência dela: *"Rejeição automática de operações sem margem
        // suficiente"*. O portão não pode morar no contrato (ele não conhece
        // gás) nem no avaliador de ciclo em T (o lucro sobra em U). Mora aqui.
        const { avaliados, comMargem, semConversao, gasWeiAgora } = await decidir();
        const custo = gasWeiAgora * GAS_SUPOSTO;
        console.log(`    ${avaliados.length} com sobra positiva | ${comMargem.length} com margem`
            + ` SOBRE O GÁS (${custo} wei) | ${semConversao} sem conversão de gás (U não é WETH:`
            + ' NÃO aprovável)');

        // A REGRA, e ela vale nos dois desfechos: nada passa sem margem.
        for (const k of comMargem) {
            assert.ok(k.sobraEmU > k.custo,
                `aprovado com sobra ${k.sobraEmU} contra gás ${k.custo}`);
        }
        // Token sem conversão de gás NUNCA entra: aprovar sem saber o custo é
        // fabricar o piso econômico.
        for (const k of comMargem) {
            assert.equal(k.U, '0x4200000000000000000000000000000000000006');
        }

        if (comMargem.length === 0 && avaliados.length > 0) {
            const m = avaliados[0];
            const vezes = m.sobraEmU > 0n
                ? (Number(custo) / Number(m.sobraEmU)).toFixed(0) : '?';
            console.log(`    melhor sobra ${m.sobraEmU} contra gás ${custo} — o gás é ${vezes}x`);
            console.log('    RECUSA CORRETA: há ciclo real e executável, e nenhum paga o próprio'
                + ' gás neste bloco. Executar aqui seria prejuízo, e fabricar uma oportunidade'
                + ' para o teste passar provaria o contrário do que este arquivo mede.');
        }
    });
});
