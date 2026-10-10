// A GRADE DO TAMANHO — sem bisseção, porque monotonicidade não foi demonstrada.
//
// Ela recusou o método anterior: *"não use bisseção global sem demonstrar
// monotonicidade. Teste separadamente valores parciais, regiões próximas dos
// limites e quitação total. Registre dívida e garantia remanescentes,
// quantidade solicitada e efetivamente liquidada."*
//
// Está certa: bisseção supõe que o conjunto aceito é um intervalo. Se ele for
// um intervalo com buraco, a bisseção devolve uma fronteira que não existe.
// Aqui a grade é VARRIDA inteira e o padrão aceita/recusa é impresso — a
// monotonicidade passa a ser OBSERVAÇÃO, não premissa.
//
// E troca "1,6x o prêmio" por LUCRO LÍQUIDO SIMULADO por tamanho: o que chega
// ao cofre menos o gás da própria transação.
const assert = require('node:assert/strict');
const { Interface, id } = require('ethers');

const POOL = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const CACADOR = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const DONO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const POOL_VENDA = '0xcdac0d6c6c59727a65f871236188350531885c43';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PRECO_ETH = 2486.50; // ENTRADA declarada, para o gás em dólar

const sel = (a) => id(a).slice(0, 10);
const z = (x) => x.toLowerCase().replace('0x', '').padStart(64, '0');
const iface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)',
]);
const liqIface = new Interface([
    'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
]);
const TOPICO = liqIface.getEvent('LiquidationCall').topicHash;
const ERROS = {};
for (const a of ['HealthFactorNotBelowThreshold()', 'MustNotLeaveDust()',
    'CollateralCannotBeLiquidated()', 'SpecifiedCurrencyNotBorrowedByUser()',
    'LucroInsuficiente(uint256,uint256)', 'InsufficientOutputAmount()']) ERROS[sel(a)] = a;
const identificar = (d) => {
    const m = /0x[0-9a-fA-F]{8,}/.exec(d ?? '');
    if (!m) return `sem seletor: ${String(d).slice(0, 50)}`;
    return ERROS[m[0].slice(0, 10)] ?? `DESCONHECIDO ${m[0].slice(0, 10)}`;
};

let p;
const chamar = (m, ps) => p.send(m, ps);
const call = async (to, data, b = 'latest') => chamar('eth_call', [{ to, data }, b]);
const pal = (h, i) => BigInt(`0x${h.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
const saldoDe = async (t, q) => BigInt(await call(t, sel('balanceOf(address)') + z(q)));
async function conta(d) {
    const r = await call(POOL, sel('getUserAccountData(address)') + z(d));
    return { garantia: pal(r, 0), divida: pal(r, 1), saude: pal(r, 5) };
}

describe('A GRADE DO TAMANHO: aceita/recusa varrida, e lucro líquido por tamanho', function () {
    this.timeout(3_000_000);

    it('a grade inteira, com dívida e garantia remanescentes', async function () {
        p = hre.network.provider;
        const bloco = parseInt(await chamar('eth_blockNumber', []), 16);
        const prov = `0x${(await call(POOL, sel('ADDRESSES_PROVIDER()'))).slice(26)}`;
        const oraculo = `0x${(await call(prov, sel('getPriceOracle()'))).slice(26)}`;
        const fonte = `0x${(await call(oraculo, sel('getSourceOfAsset(address)') + z(WETH))).slice(26)}`;
        const precoWeth = BigInt(await call(oraculo, sel('getAssetPrice(address)') + z(WETH)));

        // ---- A ORIGEM DA REVERSAO, pelo CODIGO e nao pelo seletor ----
        // Ela mandou: "Confira o código da implementação da Aave nesse bloco e
        // a origem da reversão... Não invente causalidade a partir do seletor."
        const codigoCacador = await chamar('eth_getCode', [CACADOR, 'latest']);
        const codigoPool = await chamar('eth_getCode', [POOL, 'latest']);
        const selDust = sel('MustNotLeaveDust()').slice(2);
        console.log(`    bloco ${bloco}`);
        console.log(`    ONDE O SELETOR ${sel('MustNotLeaveDust()')} EXISTE NO CÓDIGO:`);
        console.log(`      nosso Cacador (${codigoCacador.length / 2 - 1} bytes): `
            + `${codigoCacador.includes(selDust) ? 'PRESENTE' : 'AUSENTE'}`);
        console.log(`      Pool proxy   (${codigoPool.length / 2 - 1} bytes): `
            + `${codigoPool.includes(selDust) ? 'PRESENTE' : 'AUSENTE'}`);
        // O proxy delega: a implementacao e quem tem a logica.
        let impl = null;
        for (const s of ['implementation()', 'POOL_REVISION()']) {
            try { const r = await call(POOL, sel(s)); if (r && r !== '0x') impl = r; } catch {}
        }
        // EIP-1967: o slot da implementacao.
        const slot1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
        const bruto = await chamar('eth_getStorageAt', [POOL, slot1967, 'latest']);
        const implAddr = bruto && bruto !== '0x' && BigInt(bruto) !== 0n ? `0x${bruto.slice(26)}` : null;
        if (implAddr) {
            const codImpl = await chamar('eth_getCode', [implAddr, 'latest']);
            console.log(`      implementação ${implAddr} (${codImpl.length / 2 - 1} bytes): `
                + `${codImpl.includes(selDust) ? 'PRESENTE' : 'AUSENTE'}`);
            console.log(`      >>> o seletor está no código do protocolo, não no nosso: `
                + `${codImpl.includes(selDust) && !codigoCacador.includes(selDust) ? 'SIM' : 'NÃO/indeterminado'}`);
        } else {
            console.log('      implementação: slot EIP-1967 vazio — não localizei (declarado)');
        }
        console.log(`    POOL_REVISION/implementation(): ${impl ?? 'não respondeu'}`);

        // ---- O FALSO ORACULO ----
        const art = await hre.artifacts.readArtifact('OraculoFalso');
        const [c0] = await chamar('eth_accounts', []);
        const txD = await chamar('eth_sendTransaction', [{ from: c0, data: art.bytecode, gas: '0x500000' }]);
        const recD = await chamar('eth_getTransactionReceipt', [txD]);
        await chamar('hardhat_setCode', [fonte, await chamar('eth_getCode', [recD.contractAddress, 'latest'])]);
        const porPreco = (v) => chamar('hardhat_setStorageAt', [fonte, '0x0', `0x${v.toString(16).padStart(64, '0')}`]);
        await chamar('hardhat_impersonateAccount', [DONO]);
        await chamar('hardhat_setBalance', [DONO, '0x56bc75e2d63100000']);

        async function montar(usd, apelido) {
            const quem = `0x${Buffer.from(apelido).toString('hex').padStart(40, '0')}`;
            await chamar('hardhat_impersonateAccount', [quem]);
            await chamar('hardhat_setBalance', [quem, '0x152d02c7e14af6800000']);
            const weth = (BigInt(Math.round(usd * 1e8)) * 10n ** 18n * 22n) / (precoWeth * 10n);
            await chamar('eth_sendTransaction', [{ from: quem, to: WETH, value: `0x${weth.toString(16)}`, data: sel('deposit()'), gas: '0x30000' }]);
            await chamar('eth_sendTransaction', [{ from: quem, to: WETH, data: sel('approve(address,uint256)') + z(POOL) + 'f'.repeat(64), gas: '0x30000' }]);
            await chamar('eth_sendTransaction', [{ from: quem, to: POOL, data: sel('supply(address,uint256,address,uint16)') + z(WETH) + weth.toString(16).padStart(64, '0') + z(quem) + z('0x0'), gas: '0x200000' }]);
            const cru = BigInt(Math.round(usd * 1e6));
            await chamar('eth_sendTransaction', [{ from: quem, to: POOL, data: sel('borrow(address,uint256,uint256,uint16,address)') + z(USDC) + cru.toString(16).padStart(64, '0') + (2n).toString(16).padStart(64, '0') + z('0x0') + z(quem), gas: '0x300000' }]);
            return { quem, cru };
        }
        async function levarA(quem, alvo) {
            for (let q = 1; q <= 400; q++) {
                const v = (precoWeth * BigInt(10_000 - q * 20)) / 10_000n;
                if (v <= 0n) return null;
                await porPreco(v);
                if ((await conta(quem)).saude <= alvo) return v;
            }
            return null;
        }
        /** Envia de verdade (com snapshot) e mede o LUCRO LIQUIDO. */
        async function enviar(quem, cobrir) {
            const snap = await chamar('evm_snapshot', []);
            const antes = await saldoDe(USDC, COFRE);
            const envio = iface.encodeFunctionData('cacar', [WETH, USDC, quem, cobrir, POOL_VENDA, 1n]);
            const r = { cobrir, ok: false, bruto: 0n, gasUsd: 0, liquido: 0,
                liquidado: null, garantiaTomada: null, erro: null,
                restoDivida: null, restoGarantia: null, gas: null };
            try {
                const tx = await chamar('eth_sendTransaction', [{ from: DONO, to: CACADOR, data: envio, gas: '0x5b8d80' }]);
                const rec = await chamar('eth_getTransactionReceipt', [tx]);
                r.ok = rec.status === '0x1';
                r.gas = parseInt(rec.gasUsed, 16);
                const preco = BigInt(rec.effectiveGasPrice);
                r.gasUsd = (Number(BigInt(r.gas) * preco) / 1e18) * PRECO_ETH;
                const ev = (rec.logs ?? []).find((l) => l.topics[0] === TOPICO);
                if (ev) {
                    const d = liqIface.decodeEventLog('LiquidationCall', ev.data, ev.topics);
                    r.liquidado = d.debtToCover; r.garantiaTomada = d.liquidatedCollateralAmount;
                }
                r.bruto = (await saldoDe(USDC, COFRE)) - antes;
                r.liquido = Number(r.bruto) / 1e6 - r.gasUsd;
                const c = await conta(quem);
                r.restoDivida = c.divida; r.restoGarantia = c.garantia;
            } catch (e) { r.erro = identificar(e.data ?? e.message); }
            await chamar('evm_revert', [snap]);
            return r;
        }

        // Fracoes da grade: parciais, perto dos limites, e quitacao total.
        const FRACOES = [1, 5, 10, 20, 30, 33, 40, 45, 49, 50, 51, 55, 60, 66, 70, 75, 80, 90, 95, 99, 100];
        for (const [usd, saudeAlvo, nomeS] of [
            [1500, 999_000_000_000_000_000n, '0,999'],
            [1500, 930_000_000_000_000_000n, '0,93'],
            [5000, 999_000_000_000_000_000n, '0,999'],
            [5000, 930_000_000_000_000_000n, '0,93'],
        ]) {
            const snapB = await chamar('evm_snapshot', []);
            await porPreco(precoWeth);
            let dev;
            try { dev = await montar(usd, `g${usd}${nomeS.replace(',', '')}`); } catch (e) {
                console.log(`\n    US$ ${usd}: não montei`); await chamar('evm_revert', [snapB]); continue;
            }
            const preco = await levarA(dev.quem, saudeAlvo);
            if (preco === null) { await chamar('evm_revert', [snapB]); continue; }
            const c0c = await conta(dev.quem);
            console.log(`\n    ==== DÍVIDA US$ ${usd} | saúde ${(Number(c0c.saude) / 1e18).toFixed(6)} `
                + `| dívida US$ ${(Number(c0c.divida) / 1e8).toFixed(2)} `
                + `| garantia US$ ${(Number(c0c.garantia) / 1e8).toFixed(2)} ====`);
            console.log('      %da dívida   pedido    liquidado   garantia tomada   ok   bruto USDC   gás US$   LÍQUIDO USD   resto dív US$   resto gar US$   erro');
            const aceitos = [];
            for (const f of FRACOES) {
                const cobrir = (dev.cru * BigInt(f)) / 100n;
                if (cobrir === 0n) continue;
                const r = await enviar(dev.quem, cobrir);
                aceitos.push({ f, ok: r.ok });
                console.log(`      ${String(f).padStart(9)}%   ${String(r.cobrir).padStart(9)}  `
                    + `${String(r.liquidado ?? '—').padStart(10)}   ${String(r.garantiaTomada ?? '—').padStart(16)}   `
                    + `${r.ok ? 'SIM' : 'não'}  ${(Number(r.bruto) / 1e6).toFixed(2).padStart(10)}   `
                    + `${r.gasUsd.toFixed(4).padStart(7)}   ${r.ok ? r.liquido.toFixed(2).padStart(11) : '—'.padStart(11)}   `
                    + `${r.restoDivida === null ? '—'.padStart(13) : (Number(r.restoDivida) / 1e8).toFixed(2).padStart(13)}   `
                    + `${r.restoGarantia === null ? '—'.padStart(13) : (Number(r.restoGarantia) / 1e8).toFixed(2).padStart(13)}   ${r.erro ?? ''}`);
            }
            // MONOTONICIDADE: o conjunto aceito é um intervalo, ou tem buraco?
            const padrao = aceitos.map((a) => (a.ok ? '#' : '.')).join('');
            const trocas = aceitos.reduce((n, a, i) => n + (i > 0 && a.ok !== aceitos[i - 1].ok ? 1 : 0), 0);
            console.log(`      padrão aceita(#)/recusa(.) na grade: ${padrao}`);
            console.log(`      trocas de estado: ${trocas} -> ${trocas <= 1 ? 'MONÓTONO nesta grade'
                : trocas === 2 ? 'INTERVALO (um bloco contíguo de aceitos)' : 'NÃO É intervalo: a bisseção teria mentido'}`);
            await chamar('evm_revert', [snapB]);
        }
        assert.ok(true, 'a grade e o padrão ficam no log — o teste não crava o resultado');
    });
});
