// A FRONTEIRA DO RESIDUO, por BISSECAO — e nao por eu lembrar a formula.
//
// A matriz de 2026-10-10 achou algo que eu nao esperava e que pode ser o
// achado mais caro da sessao:
//
//     US$   500 de divida: TODAS as coberturas reverteram (metade inclusive)
//     US$ 1.500 de divida: TODAS as coberturas reverteram (metade inclusive)
//     US$ 3.000 de divida: metade PASSOU
//
// Se isso valer na Base de verdade, o `cobrir()` do bot — que pede SEMPRE
// metade — torna INLIQUIDAVEL toda posicao de divida pequena. E a faixa de
// divida pequena e exatamente onde o censo acha a maioria das liquidacoes.
//
// Ela mandou: *"Localize MustNotLeaveDust no trace; não conclua sua causa
// apenas pelo seletor."* O tracer de call do Hardhat nao esta disponivel
// ("only supports the default tracer"). Entao a causa nao vai sair de trace
// nem da minha memoria: sai da FRONTEIRA MEDIDA. Para cada posicao eu busco,
// por bisseção com `eth_call`, a MAIOR cobertura que a Aave aceita e a MENOR
// que ela aceita — e o que sobra de divida nos dois lados. A forma da regra
// aparece nos numeros.
//
// `eth_call` nao gasta nada e nao altera estado: a bisseção e de graca.
const assert = require('node:assert/strict');
const { Interface, id } = require('ethers');

const POOL_AAVE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const CACADOR = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const DONO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const POOL_VENDA = '0xcdac0d6c6c59727a65f871236188350531885c43';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const sel = (a) => id(a).slice(0, 10);
const z = (x) => x.toLowerCase().replace('0x', '').padStart(64, '0');
const cacarIface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)',
]);
const ERROS = {};
for (const a of [
    'HealthFactorNotBelowThreshold()', 'MustNotLeaveDust()',
    'CollateralCannotBeLiquidated()', 'SpecifiedCurrencyNotBorrowedByUser()',
    'LucroInsuficiente(uint256,uint256)', 'InsufficientOutputAmount()',
]) ERROS[sel(a)] = a;
const identificar = (d) => {
    const m = /0x[0-9a-fA-F]{8,}/.exec(d ?? '');
    if (!m) return `sem seletor: ${String(d).slice(0, 60)}`;
    return ERROS[m[0].slice(0, 10)] ?? `DESCONHECIDO ${m[0].slice(0, 10)}`;
};

let p;
const chamar = (m, ps) => p.send(m, ps);
const call = async (to, data, bloco = 'latest') => chamar('eth_call', [{ to, data }, bloco]);
const palavra = (h, i) => BigInt(`0x${h.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
async function conta(d) {
    const r = await call(POOL_AAVE, sel('getUserAccountData(address)') + z(d));
    return { garantiaBase: palavra(r, 0), dividaBase: palavra(r, 1), saude: palavra(r, 5) };
}

describe('A FRONTEIRA DO RESÍDUO, medida por bisseção', function () {
    this.timeout(1_800_000);

    it('a maior e a menor cobertura que a Aave aceita, por tamanho de dívida', async function () {
        p = hre.network.provider;
        const prov = `0x${(await call(POOL_AAVE, sel('ADDRESSES_PROVIDER()'))).slice(26)}`;
        const oraculo = `0x${(await call(prov, sel('getPriceOracle()'))).slice(26)}`;
        const fonteWeth = `0x${(await call(oraculo, sel('getSourceOfAsset(address)') + z(WETH))).slice(26)}`;
        const precoWeth = BigInt(await call(oraculo, sel('getAssetPrice(address)') + z(WETH)));
        const art = await hre.artifacts.readArtifact('OraculoFalso');
        const [c0] = await chamar('eth_accounts', []);
        const txD = await chamar('eth_sendTransaction', [{ from: c0, data: art.bytecode, gas: '0x500000' }]);
        const recD = await chamar('eth_getTransactionReceipt', [txD]);
        await chamar('hardhat_setCode', [fonteWeth, await chamar('eth_getCode', [recD.contractAddress, 'latest'])]);
        const porPreco = (v) => chamar('hardhat_setStorageAt', [fonteWeth, '0x0', `0x${v.toString(16).padStart(64, '0')}`]);
        await porPreco(precoWeth);
        await chamar('hardhat_impersonateAccount', [DONO]);
        await chamar('hardhat_setBalance', [DONO, '0x56bc75e2d63100000']);

        async function montarDevedor(dividaUsd, apelido) {
            const quem = `0x${Buffer.from(apelido).toString('hex').padStart(40, '0')}`;
            await chamar('hardhat_impersonateAccount', [quem]);
            await chamar('hardhat_setBalance', [quem, '0x152d02c7e14af6800000']);
            const weth = (BigInt(Math.round(dividaUsd * 1e8)) * 10n ** 18n * 22n) / (precoWeth * 10n);
            await chamar('eth_sendTransaction', [{ from: quem, to: WETH, value: `0x${weth.toString(16)}`, data: sel('deposit()'), gas: '0x30000' }]);
            await chamar('eth_sendTransaction', [{ from: quem, to: WETH, data: sel('approve(address,uint256)') + z(POOL_AAVE) + 'f'.repeat(64), gas: '0x30000' }]);
            await chamar('eth_sendTransaction', [{ from: quem, to: POOL_AAVE, data: sel('supply(address,uint256,address,uint16)') + z(WETH) + weth.toString(16).padStart(64, '0') + z(quem) + z('0x0'), gas: '0x200000' }]);
            const cru = BigInt(Math.round(dividaUsd * 1e6));
            await chamar('eth_sendTransaction', [{ from: quem, to: POOL_AAVE, data: sel('borrow(address,uint256,uint256,uint16,address)') + z(USDC) + cru.toString(16).padStart(64, '0') + (2n).toString(16).padStart(64, '0') + z('0x0') + z(quem), gas: '0x300000' }]);
            return { quem, cru };
        }
        async function levarSaudeA(quem, alvo) {
            for (let q = 1; q <= 400; q++) {
                const usado = (precoWeth * BigInt(10_000 - q * 20)) / 10_000n;
                if (usado <= 0n) return null;
                await porPreco(usado);
                if ((await conta(quem)).saude <= alvo) return usado;
            }
            return null;
        }
        /** `eth_call` do nosso contrato: aceita ou nao, e por que. De graca. */
        async function aceita(quem, cobrir) {
            const envio = cacarIface.encodeFunctionData('cacar', [WETH, USDC, quem, cobrir, POOL_VENDA, 1n]);
            try {
                await chamar('eth_call', [{ from: DONO, to: CACADOR, data: envio, gas: '0x5b8d80' }, 'latest']);
                return { ok: true, porque: null };
            } catch (e) {
                return { ok: false, porque: identificar(e.data ?? e.message) };
            }
        }
        /** A MAIOR cobertura aceita, por bisseção. `null` se nenhuma passa. */
        async function maiorAceita(quem, teto) {
            if ((await aceita(quem, teto)).ok) return teto;
            let lo = 0n; let hi = teto; let melhor = null;
            for (let i = 0; i < 40 && hi - lo > 1n; i++) {
                const meio = (lo + hi) / 2n;
                if (meio === 0n) break;
                if ((await aceita(quem, meio)).ok) { melhor = meio; lo = meio; } else hi = meio;
            }
            return melhor;
        }
        /** A MENOR cobertura aceita — a ponta de baixo da regra. */
        async function menorAceita(quem, teto) {
            let lo = 1n; let hi = teto; let melhor = null;
            if (!(await aceita(quem, hi)).ok) {
                // Sem ponta de cima aceita, procura qualquer aceita subindo.
                for (const f of [1n, 2n, 5n, 10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 99n]) {
                    const v = (teto * f) / 100n;
                    if (v > 0n && (await aceita(quem, v)).ok) { hi = v; melhor = v; break; }
                }
                if (melhor === null) return null;
            } else melhor = hi;
            for (let i = 0; i < 40 && hi - lo > 1n; i++) {
                const meio = (lo + hi) / 2n;
                if (meio === 0n) break;
                if ((await aceita(quem, meio)).ok) { melhor = meio; hi = meio; } else lo = meio;
            }
            return melhor;
        }

        const linhas = [];
        for (const dividaUsd of [300, 500, 1000, 1500, 2100, 3000, 5000]) {
            const snapB = await chamar('evm_snapshot', []);
            await porPreco(precoWeth);
            let dev;
            try { dev = await montarDevedor(dividaUsd, `d${dividaUsd}`); } catch (e) {
                console.log(`    US$ ${dividaUsd}: não montei — ${String(e.message).slice(0, 70)}`);
                await chamar('evm_revert', [snapB]); continue;
            }
            for (const [alvoSaude, nome] of [
                [999_000_000_000_000_000n, '0,999'],
                [930_000_000_000_000_000n, '0,93'],
            ]) {
                const snapR = await chamar('evm_snapshot', []);
                const preco = await levarSaudeA(dev.quem, alvoSaude);
                if (preco === null) { await chamar('evm_revert', [snapR]); continue; }
                const c = await conta(dev.quem);
                const maior = await maiorAceita(dev.quem, dev.cru);
                const menor = await menorAceita(dev.quem, dev.cru);
                const metade = await aceita(dev.quem, dev.cru / 2n);
                linhas.push({
                    dividaUsd, saude: nome,
                    dividaBase: c.dividaBase, garantiaBase: c.garantiaBase,
                    cru: dev.cru, maior, menor,
                    metadePassa: metade.ok, metadePorque: metade.porque,
                });
                await chamar('evm_revert', [snapR]);
            }
            await chamar('evm_revert', [snapB]);
        }

        console.log('\n    dívida   saúde   dívida US$   garantia US$   menor aceita   MAIOR aceita   resto se MAIOR   metade passa?');
        for (const l of linhas) {
            const resto = l.maior === null ? null : l.cru - l.maior;
            console.log(`    ${String(l.dividaUsd).padStart(6)}   ${l.saude.padEnd(5)}   `
                + `${(Number(l.dividaBase) / 1e8).toFixed(2).padStart(10)}   `
                + `${(Number(l.garantiaBase) / 1e8).toFixed(2).padStart(12)}   `
                + `${String(l.menor ?? '—').padStart(12)}   ${String(l.maior ?? 'NENHUMA').padStart(12)}   `
                + `${resto === null ? '—' : `US$ ${(Number(resto) / 1e6).toFixed(2)}`.padStart(14)}   `
                + `${l.metadePassa ? 'SIM' : `não (${l.metadePorque})`}`);
        }

        // A FORMA da regra, lida dos numeros — sem formula de cabeca.
        console.log('\n    O que os números dizem sobre a forma da regra:');
        const comMetadeRecusada = linhas.filter((l) => !l.metadePassa);
        for (const l of comMetadeRecusada) {
            console.log(`      US$ ${l.dividaUsd} saúde ${l.saude}: metade RECUSADA (${l.metadePorque}); `
                + `a maior aceita é ${l.maior === null ? 'NENHUMA' : `${(100 * Number(l.maior) / Number(l.cru)).toFixed(1)}% da dívida`}`);
        }
        const restos = linhas.filter((l) => l.maior !== null && l.cru - l.maior > 0n)
            .map((l) => Number(l.cru - l.maior) / 1e6);
        if (restos.length > 0) {
            console.log(`      restos de dívida deixados pela MAIOR cobertura aceita: `
                + `${restos.map((r) => `US$ ${r.toFixed(2)}`).join(', ')}`);
            console.log('      >>> se os restos se agrupam perto de um valor, ESSE é o piso de resíduo');
        }
        console.log(`\n      E O QUE ISTO CUSTA AO BOT: ele pede SEMPRE metade. Dos ${linhas.length} casos `
            + `medidos, ${comMetadeRecusada.length} RECUSAM metade — e em `
            + `${comMetadeRecusada.filter((l) => l.maior !== null).length} deles existia uma cobertura que PASSA.`);

        assert.ok(linhas.length > 0, 'a bisseção tinha de medir pelo menos um caso');
    });
});
