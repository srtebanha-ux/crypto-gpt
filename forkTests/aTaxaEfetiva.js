// A TAXA EFETIVA DE CADA FABRICA, medida pelo PROPRIO pool — nao assumida.
//
// Ponto 6 dela: *"Confirme se as taxas da Aerodrome, o retorno efetivo de cada
// hop e os custos completos na Base correspondem à execução simulada."*
//
// O motor monta TODA rota V2 com `taxaPorDezMil: 30` — o numero do Uniswap V2.
// Se uma fabrica cobra MAIS, a conta da rota superestima a saida de cada hop, o
// pagamento do flash swap chega curto e o pool recusa pelo invariante
// ('UniswapV2: K'). Isso seria ERRO_DO_EXECUTOR — defeito NOSSO —, e condenar o
// token ali esconderia o nosso bug. Duas rotas do bloco 52612934 reverteram com
// 'UniswapV2: K' e TODOS os tokens medidos limpos: e exatamente a assinatura.
//
// O METODO nao depende de eu lembrar a taxa de ninguem. O pool V2 aceita uma
// saida `out` para uma entrada `in` quando
//
//     (r_in + in*(10000-taxa)/10000) * (r_out - out)  >=  r_in * r_out
//
// Entao a MAIOR `out` que o pool aceita determina a taxa. A busca e por
// bisseccao com `eth_call` (nao gasta nada) e a taxa sai da desigualdade no
// ponto de aceite. Zero numero meu na conta: reservas lidas do pool, aceite
// lido do pool.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const {
    descobrirUniverso, lerPools, WETH_DA_BASE, FABRICAS_COM_FLASH_SWAP,
} = require('../dist/cacarArbitragem.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const erc20 = new Interface(['function transfer(address to, uint256 v) returns (bool)']);
const pIface = new Interface([
    'function swap(uint256 a0, uint256 a1, address to, bytes data)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);
const num = (h) => (h && h !== '0x' ? BigInt(h) : null);

/** A taxa, em por dez mil, que a desigualdade do pool exige para aceitar `out`. */
function taxaImplicada(rIn, rOut, entrada, out, paraCima) {
    // (rIn + entrada*(10000-t)/10000) * (rOut - out) >= rIn*rOut
    // => entrada*(10000-t) >= 10000 * (rIn*rOut/(rOut-out) - rIn)
    //
    // As duas divisoes sao INTEIRAS, e o arredondamento delas vale cerca de UM
    // ponto por dez mil — a ordem da propria grandeza que se quer medir. Entao
    // a funcao calcula as DUAS pontas e quem chama publica a faixa: um unico
    // numero aqui seria o arredondamento vestido de medicao.
    const n = rIn * rOut;
    const d = rOut - out;
    const q = paraCima ? (n + d - 1n) / d : n / d;
    const precisaIn = q - rIn;
    const m = precisaIn * 10_000n;
    const comTaxa = paraCima ? (m + entrada - 1n) / entrada : m / entrada;
    return 10_000n - comTaxa;
}

describe('a taxa efetiva de cada fábrica, medida no pool', function () {
    this.timeout(1_800_000);

    let pools;

    before(async function () {
        p = hre.network.provider;
        const bloco = Number(await chamar('eth_blockNumber', []));
        const u = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 100));
        const lido = await lerPools(chamar, u.pools, u.porFabrica, bloco);
        pools = lido.pools;
        console.log(`    bloco ${bloco} | ${pools.length} pools lidos`);
    });

    it('a taxa de CADA fábrica sai do pool, e o motor assume 30', async function () {
        const contas = await chamar('eth_accounts', []);
        const eu = contas[0];
        const destino = contas[1];

        const porFabrica = new Map();
        // O MAIOR pool de WETH de cada fabrica, nao o primeiro: o primeiro pode
        // ter reserva de poeira, e `rIn/1000` dela da ZERO — a fabrica sairia
        // como "NÃO MEDIDA" por escolha minha, nao por falta de dado.
        for (const q of pools) {
            if (q.token0 !== WETH_DA_BASE && q.token1 !== WETH_DA_BASE) continue;
            if (q.reserva0 <= 0n || q.reserva1 <= 0n) continue;
            const weth = q.token0 === WETH_DA_BASE ? q.reserva0 : q.reserva1;
            const atual = porFabrica.get(q.fabrica);
            const wAtual = atual === undefined
                ? -1n
                : (atual.token0 === WETH_DA_BASE ? atual.reserva0 : atual.reserva1);
            if (weth > wAtual) porFabrica.set(q.fabrica, q);
        }

        const medidas = [];
        for (const [fabrica, q] of porFabrica) {
            const wethEh0 = q.token0 === WETH_DA_BASE;
            const rIn = wethEh0 ? q.reserva0 : q.reserva1;
            const rOut = wethEh0 ? q.reserva1 : q.reserva0;
            const entrada = rIn / 1000n;
            if (entrada <= 0n) {
                medidas.push({ fabrica, pool: q.endereco, taxa: null, porque: 'reserva de WETH pequena demais para medir' });
                continue;
            }

            // O WETH e comprado do proprio pool mais fundo para pagar a entrada.
            await chamar('hardhat_setBalance', [eu, '0x3635C9ADC5DEA00000']);
            const dep = await chamar('eth_sendTransaction', [{
                from: eu, to: WETH_DA_BASE, value: `0x${entrada.toString(16)}`,
                data: sel('deposit()'), gas: '0x100000',
            }]);
            const rd = await chamar('eth_getTransactionReceipt', [dep]);
            if (rd === null || rd.status !== '0x1') {
                medidas.push({ fabrica, pool: q.endereco, taxa: null, porque: 'não consegui WETH no fork' });
                continue;
            }
            const rt = await chamar('eth_sendTransaction', [{
                from: eu, to: WETH_DA_BASE, gas: '0x100000',
                data: erc20.encodeFunctionData('transfer', [q.endereco, entrada]),
            }]);
            const rr = await chamar('eth_getTransactionReceipt', [rt]);
            if (rr === null || rr.status !== '0x1') {
                medidas.push({ fabrica, pool: q.endereco, taxa: null, porque: 'a transferência ao pool falhou' });
                continue;
            }

            // BISSECCAO na saida: a maior que o pool aceita.
            const tenta = async (out) => {
                const dados = pIface.encodeFunctionData('swap', wethEh0
                    ? [0n, out, destino, '0x'] : [out, 0n, destino, '0x']);
                try {
                    await chamar('eth_call', [{ from: eu, to: q.endereco, data: dados }, 'latest']);
                    return true;
                } catch { return false; }
            };
            let lo = 0n; let hi = rOut / 2n;
            if (!(await tenta(1n))) {
                medidas.push({ fabrica, pool: q.endereco, taxa: null, porque: 'o pool recusou QUALQUER saída: não é a interface V2 esperada' });
                continue;
            }
            while (hi - lo > 1n) {
                const meio = (lo + hi) / 2n;
                // eslint-disable-next-line no-await-in-loop
                if (await tenta(meio)) lo = meio; else hi = meio;
            }
            // UM BRACKET, nao um numero: `taxaImplicada` usa divisao INTEIRA,
            // entao ela carrega +-1 de artefato. A taxa decresce com a saida,
            // `lo` e aceita e `lo+1` e recusada, logo a taxa verdadeira esta
            // ENTRE as duas implicadas. Publicar `taxaImplicada(lo)` sozinha
            // seria publicar o arredondamento como medicao.
            const cantos = [
                taxaImplicada(rIn, rOut, entrada, lo, false),
                taxaImplicada(rIn, rOut, entrada, lo, true),
                taxaImplicada(rIn, rOut, entrada, lo + 1n, false),
                taxaImplicada(rIn, rOut, entrada, lo + 1n, true),
            ];
            const baixo = cantos.reduce((a, b) => (b < a ? b : a));
            const alto = cantos.reduce((a, b) => (b > a ? b : a));
            medidas.push({
                fabrica, pool: q.endereco, taxa: alto, faixa: [baixo, alto], maiorSaida: lo,
                porque: 'medido por bissecção do aceite do pool',
            });
        }

        console.log('\n    TAXA EFETIVA (por dez mil) — o motor assume 30 para TODAS');
        let divergentes = 0;
        let maisCaras = 0;
        for (const m of medidas) {
            if (m.taxa === null) {
                console.log(`    ${m.fabrica}  pool ${m.pool}  taxa NÃO MEDIDA`);
                console.log(`        ${m.porque}`);
                continue;
            }
            const [b, a] = m.faixa;
            // O 30 assumido cabe na faixa medida? Se cabe, nao ha divergencia:
            // ha o artefato da divisao inteira.
            const contem = b <= 30n && 30n <= a;
            if (!contem) divergentes += 1;
            // O que decide RISCO nao e divergir: e divergir para CIMA. Taxa
            // real MAIOR que a assumida faz a conta superestimar a saida de
            // cada hop, e o pagamento chega curto. Taxa real MENOR e o lado
            // seguro: a saida real vem acima do previsto.
            const maisCara = b > 30n;
            if (maisCara) maisCaras += 1;
            const nota = contem
                ? '  o 30 assumido CABE na faixa'
                : (maisCara
                    ? '  >>> MAIS CARA que o assumido: a conta superestima a saída'
                    : '  >>> mais BARATA que o assumido (lado seguro)');
            console.log(`    ${m.fabrica}  pool ${m.pool}  taxa entre ${b} e ${a}${nota}`);
            console.log(`        ${m.porque} | maior saída aceita ${m.maiorSaida}`);
        }
        console.log(`\n    fábricas medidas: ${medidas.filter((m) => m.taxa !== null).length} de ${medidas.length}`);
        console.log(`    faixa medida NÃO contém o 30 assumido: ${divergentes}`);
        console.log(`    MAIS CARAS que o assumido (risco de pagamento curto): ${maisCaras}`);
        console.log('    COBERTURA: uma fábrica entra aqui só com pool de WETH e reserva viva;'
            + ' fábrica sem isso sai como NÃO MEDIDA, não como "igual a 30"');

        // A unica afirmacao deste teste: a taxa saiu do POOL, nao da minha
        // memoria. Ele NAO exige que seja 30 — se divergir, o achado e o
        // divergente, e quem conserta e o motor.
        assert.ok(medidas.some((m) => m.taxa !== null),
            'nenhuma fábrica pôde ser medida: o resultado não diz nada sobre taxa');
    });
});
