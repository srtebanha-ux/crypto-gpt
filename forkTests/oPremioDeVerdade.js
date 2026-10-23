// O PREMIO DE VERDADE — lucro REALIZADO contra `lucroEstimado`, em fork.
//
// POR QUE. O piso da aposta compara o PREMIO contra o custo medido. O custo
// agora e medido (recibos das 39). O premio nao era: ele vem de
// `lucroEstimado`, que supoe AGIO de 5% e usa a curva de escorregamento do
// pool. "Nao aceite um piso matematicamente correto alimentado por estimativas
// sem fundamento" — e a estimativa do premio era o lado sem fundamento.
//
// O primeiro teste em fork ja mostrou a estimativa errando 2,7x PARA BAIXO num
// alvo (previa US$ 1.932, realizou US$ 5.308). Aqui a conta e feita nos cinco
// alvos reais que ainda tem divida, cada um derrubado pelo MENOR passo de preco
// que o faz cruzar, e o lucro lido no COFRE.
const assert = require('node:assert/strict');
const { Interface, id } = require('ethers');

const POOL_AAVE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const CACADOR = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const DONO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const POOL_VENDA = '0xcdac0d6c6c59727a65f871236188350531885c43';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ALVOS = [
    ['0x66bb6c2949b20503adf3621db9903ee52f92ffb5', 75831589122n],
    ['0x16b00db74167b7469dda63b674ca9a3b1b70c439', 30463031728n],
    ['0xda0d95c69d3bdb65bc98e5889025ecbc1a23094f', 10233347683n],
    ['0x07a145dbbc7e425d0f1b3b9982f955e97abad7a2', 7009420648n],
    ['0x12f16a0aa0cefea43402ed11cf983cace2014dba', 3913824359n],
];

const cacarIface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)',
]);
const sel = (a) => id(a).slice(0, 10);
const palavra = (h, i) => BigInt(`0x${h.slice(2 + i * 64, 2 + (i + 1) * 64)}`);

describe('O PREMIO DE VERDADE, em fork da Base', function () {
    this.timeout(1800000);

    it('mede o lucro REALIZADO de cada alvo e compara com lucroEstimado', async function () {
        const p = hre.network.provider;
        const call = async (to, data) => p.send('eth_call', [{ to, data }, 'latest']);
        const conta = async (d) => {
            const r = await call(POOL_AAVE, sel('getUserAccountData(address)') + d.slice(2).padStart(64, '0'));
            return { dividaBase: palavra(r, 1), saude: palavra(r, 5) };
        };
        const saldoDe = async (t, q) => BigInt(await call(t, sel('balanceOf(address)') + q.slice(2).padStart(64, '0')));

        const { Decimal } = require('decimal.js');
        // `lucroEstimado` do projeto, a MESMA funcao que decide a aposta.
        require('ts-node/register');
        const { lucroEstimado } = require('../src/perdidas');

        const fabrica = await hre.artifacts.readArtifact('OraculoFalso');
        const linhas = [];

        for (const [devedor, cobrir] of ALVOS) {
            // Fork limpo por alvo: um tiro nao pode contaminar o proximo.
            await p.send('hardhat_reset', [{ forking: { jsonRpcUrl: 'https://mainnet.base.org' } }]);
            const prov = `0x${(await call(POOL_AAVE, sel('ADDRESSES_PROVIDER()'))).slice(26)}`;
            const oraculo = `0x${(await call(prov, sel('getPriceOracle()'))).slice(26)}`;
            const fonte = `0x${(await call(oraculo, sel('getSourceOfAsset(address)') + WETH.slice(2).padStart(64, '0'))).slice(26)}`;
            const preco = BigInt(await call(oraculo, sel('getAssetPrice(address)') + WETH.slice(2).padStart(64, '0')));

            const c0 = await conta(devedor);
            if (c0.dividaBase < 100_000_000n) { linhas.push({ devedor, nota: 'sem divida no fork' }); continue; }

            const [conta0] = await p.send('eth_accounts', []);
            const tx = await p.send('eth_sendTransaction', [{ from: conta0, data: fabrica.bytecode, gas: '0x500000' }]);
            const rec = await p.send('eth_getTransactionReceipt', [tx]);
            const runtime = await p.send('eth_getCode', [rec.contractAddress, 'latest']);
            await p.send('hardhat_setCode', [fonte, runtime]);

            // o MENOR passo de 0,1% que faz cruzar
            let saude = c0.saude; let usado = preco; let queda = 0;
            for (let q = 1; q <= 400 && saude > 10n ** 18n; q++) {
                usado = (preco * BigInt(10_000 - q * 10)) / 10_000n;
                await p.send('hardhat_setStorageAt', [fonte, '0x0', `0x${usado.toString(16).padStart(64, '0')}`]);
                saude = (await conta(devedor)).saude;
                queda = q / 10;
            }
            if (saude > 10n ** 18n) { linhas.push({ devedor, nota: 'nao cruzou nem com -40%' }); continue; }
            const dividaNoCruzamento = (await conta(devedor)).dividaBase;

            await p.send('hardhat_impersonateAccount', [DONO]);
            await p.send('hardhat_setBalance', [DONO, '0x2386f26fc10000']);
            const antes = await saldoDe(USDC, COFRE);
            const piso = (cobrir * 150n) / 10_000n;
            let status = 'ERRO'; let gas = null; let erro = null;
            try {
                const t = await p.send('eth_sendTransaction', [{
                    from: DONO, to: CACADOR, gas: '0x4c4b40',
                    data: cacarIface.encodeFunctionData('cacar', [WETH, USDC, devedor, cobrir, POOL_VENDA, piso]),
                }]);
                const r = await p.send('eth_getTransactionReceipt', [t]);
                status = r.status === '0x1' ? 'SUCESSO' : 'REVERTIDA';
                gas = parseInt(r.gasUsed, 16);
            } catch (e) { erro = e.message.slice(0, 90); }
            const realizado = Number(await saldoDe(USDC, COFRE) - antes) / 1e6;
            const dividaUsd = new Decimal(dividaNoCruzamento.toString()).dividedBy(1e8);
            const estimado = Number(lucroEstimado(dividaUsd).toFixed(2));

            linhas.push({
                devedor: devedor.slice(0, 10),
                quedaParaCruzar: `${queda.toFixed(1)}%`,
                dividaUsd: Number(dividaUsd.toFixed(2)),
                cobriuUsdc: Number(cobrir) / 1e6,
                estimado, realizado, status, gas, erro,
                realizadoSobreEstimado: estimado > 0 ? Number((realizado / estimado).toFixed(2)) : null,
                agioImplicito: realizado > 0 ? `${(100 * realizado / (Number(cobrir) / 1e6)).toFixed(2)}%` : null,
            });
            console.log('   ', JSON.stringify(linhas[linhas.length - 1]));
        }

        const bons = linhas.filter((l) => l.status === 'SUCESSO');
        console.log(`\n    completaram: ${bons.length} de ${ALVOS.length}`);
        if (bons.length > 0) {
            const razoes = bons.map((l) => l.realizadoSobreEstimado).filter((x) => x !== null);
            console.log(`    realizado/estimado: ${razoes.join(' | ')}`);
            console.log(`    ágio implícito: ${bons.map((l) => l.agioImplicito).join(' | ')}`);
            console.log(`    gás de um vencedor: ${bons.map((l) => l.gas).join(' | ')}`);
        }
        // A afirmação que este teste guarda: o caminho vencedor completa, e a
        // estimativa do prêmio NÃO é otimista (se fosse, o piso autorizaria
        // aposta que não se paga).
        assert.ok(bons.length >= 3, 'ao menos três dos cinco alvos reais têm de completar');
        for (const l of bons) {
            assert.ok(l.realizado > 0, `${l.devedor} completou sem lucro`);
            assert.ok(l.realizadoSobreEstimado >= 0.9,
                `${l.devedor}: realizado ${l.realizado} contra estimado ${l.estimado} — `
                + 'a estimativa do prêmio está OTIMISTA, e é ela que autoriza a aposta');
        }
    });
});
