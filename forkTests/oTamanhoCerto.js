// QUANTO A AAVE DEIXA COBRIR DE VERDADE — e o que o filtro de "metade" descarta.
//
// POR QUE ESTE TESTE EXISTE. `quantoPedirEmprestado` em src/cacarAoVivo.ts:70
// sempre pede METADE, e o comentario da linha 79 diz:
//
//     "Acima da metade a Aave recusa."
//
// Isso e uma AFIRMACAO SOBRE O PROTOCOLO que nunca foi exercitada contra a
// Aave implantada na Base. Ela mandou, em 2026-10-10: *"Nao aplique uma regra
// fixa de 50% sem conferir sua validade para cada caso"*.
//
// Se o fator de fechamento for 100% em algum regime, o bot esta pedindo METADE
// do premio que podia pedir — e isso multiplica por 2 o lado de cima de toda a
// conta da meta, sem mudar o custo por tentativa.
//
// E ha a ponta oposta: se a Aave EXIGE nao deixar residuo, uma cobertura de 50%
// que deixe divida pequena REVERTE — e a reversao chega ao bot como
// `execution reverted` genérico, que ele hoje le como "nao cruzou ainda".
//
// ---------------------------------------------------------------------------
// PREVISOES REGISTRADAS ANTES DE RODAR (item 9 do mandato dela):
//
//   P1. com saude entre 0,95 e 1, cobrir MAIS que metade REVERTE
//   P2. com saude ABAIXO de 0,95, cobrir 100% da divida e ACEITO
//   P3. cobrir um valor que deixe divida PEQUENA (uns US$ 500) REVERTE
//       por regra de residuo
//   P4. quando 100% e aceito, o lucro realizado fica entre 1,5x e 2,5x o
//       lucro da cobertura de 50% no MESMO preco
//
// Qualquer uma que falhar, falha — e eu registro, nao reajusto.
// ---------------------------------------------------------------------------
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const POOL_AAVE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const CACADOR = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const DONO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const POOL_VENDA = '0xcdac0d6c6c59727a65f871236188350531885c43';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ALVOS = [
    '0x66bb6c2949b20503adf3621db9903ee52f92ffb5',
    '0x16b00db74167b7469dda63b674ca9a3b1b70c439',
    '0xda0d95c69d3bdb65bc98e5889025ecbc1a23094f',
    '0x07a145dbbc7e425d0f1b3b9982f955e97abad7a2',
    '0x12f16a0aa0cefea43402ed11cf983cace2014dba',
];

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const cacarIface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)',
]);
// Os erros que importam distinguir. O seletor e a identidade; a prosa nao e.
const ERROS = {};
for (const a of [
    'HealthFactorNotBelowThreshold()', 'CollateralCannotBeLiquidated()',
    'SpecifiedCurrencyNotBorrowedByUser()', 'MustNotLeaveDust()',
    'LucroInsuficiente(uint256,uint256)', 'InsufficientOutputAmount()',
]) ERROS[sel(a)] = a;

let p;
const chamar = (m, ps) => p.send(m, ps);
const call = async (to, data, bloco = 'latest') => chamar('eth_call', [{ to, data }, bloco]);
const palavra = (h, i) => BigInt(`0x${h.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
async function conta(devedor) {
    const r = await call(POOL_AAVE, sel('getUserAccountData(address)') + devedor.slice(2).padStart(64, '0'));
    return { garantiaBase: palavra(r, 0), dividaBase: palavra(r, 1), saude: palavra(r, 5) };
}
const saldoDe = async (token, quem) =>
    BigInt(await call(token, sel('balanceOf(address)') + quem.slice(2).padStart(64, '0')));
/** O que a reversao DIZ, pelo seletor. `execution reverted` nao identifica nada. */
function porQueReverteu(msg) {
    const m = /0x[0-9a-fA-F]{8,}/.exec(msg ?? '');
    if (!m) return `sem dados: ${String(msg).slice(0, 90)}`;
    const s = m[0].slice(0, 10);
    return ERROS[s] ?? `seletor DESCONHECIDO ${s}`;
}

describe('QUANTO a Aave deixa cobrir, medido na implantacao da Base', function () {
    this.timeout(900000);

    it('o fator de fechamento e a regra de residuo, exercitados', async function () {
        p = hre.network.provider;
        const bloco = parseInt(await chamar('eth_blockNumber', []), 16);
        const prov = `0x${(await call(POOL_AAVE, sel('ADDRESSES_PROVIDER()'))).slice(26)}`;
        const oraculo = `0x${(await call(prov, sel('getPriceOracle()'))).slice(26)}`;
        const fonteWeth = `0x${(await call(oraculo, sel('getSourceOfAsset(address)') + WETH.slice(2).padStart(64, '0'))).slice(26)}`;
        const precoWeth = BigInt(await call(oraculo, sel('getAssetPrice(address)') + WETH.slice(2).padStart(64, '0')));
        console.log(`    bloco ${bloco} | oraculo ${oraculo} | WETH US$ ${(Number(precoWeth) / 1e8).toFixed(2)}`);

        // A divida CRUA em USDC (6 casas), que e a unidade de `debtToCover`.
        const dividaCrua = async (devedor) => {
            const dp = `0x${(await call(prov, sel('getPoolDataProvider()'))).slice(26)}`;
            const r = await call(dp, sel('getUserReserveData(address,address)')
                + USDC.slice(2).padStart(64, '0') + devedor.slice(2).padStart(64, '0'));
            return palavra(r, 2); // currentVariableDebt
        };

        let alvo = null;
        for (const d of ALVOS) {
            const c = await conta(d);
            const cru = await dividaCrua(d);
            console.log(`    ${d.slice(0, 10)} saude ${(Number(c.saude) / 1e18).toFixed(6)} `
                + `divida US$ ${(Number(c.dividaBase) / 1e8).toFixed(2)} | USDC cru ${cru}`);
            if (alvo === null && cru > 1_000_000n) alvo = { devedor: d, cru, ...c };
        }
        assert.ok(alvo !== null, 'nenhum alvo real com divida em USDC — refaca a lista');
        console.log(`    >>> alvo ${alvo.devedor} | divida USDC crua ${alvo.cru}`);

        // O falso oraculo na FONTE do WETH, e so nela.
        const art = await hre.artifacts.readArtifact('OraculoFalso');
        const [conta0] = await chamar('eth_accounts', []);
        const txD = await chamar('eth_sendTransaction', [{ from: conta0, data: art.bytecode, gas: '0x500000' }]);
        const recD = await chamar('eth_getTransactionReceipt', [txD]);
        await chamar('hardhat_setCode', [fonteWeth, await chamar('eth_getCode', [recD.contractAddress, 'latest'])]);
        await chamar('hardhat_impersonateAccount', [DONO]);
        await chamar('hardhat_setBalance', [DONO, '0x2386f26fc10000']);

        /** Põe o preco do WETH no valor que leva a saude ao alvo pedido. */
        async function levarSaudeA(alvoSaude) {
            let melhor = precoWeth; let achou = null;
            for (let q = 1; q <= 200; q++) {
                const usado = (precoWeth * BigInt(10_000 - q * 25)) / 10_000n;
                await chamar('hardhat_setStorageAt', [fonteWeth, '0x0', `0x${usado.toString(16).padStart(64, '0')}`]);
                const s = (await conta(alvo.devedor)).saude;
                if (s <= alvoSaude) { achou = { saude: s, preco: usado }; melhor = usado; break; }
            }
            return achou === null ? null : { ...achou, preco: melhor };
        }

        /** Um tiro de verdade pelo contrato publicado, com snapshot/rollback. */
        async function tiro(cobrir, rotulo) {
            const snap = await chamar('evm_snapshot', []);
            const antes = await saldoDe(USDC, COFRE);
            const envio = cacarIface.encodeFunctionData('cacar',
                [WETH, USDC, alvo.devedor, cobrir, POOL_VENDA, 1n]);
            let r = { rotulo, cobrir, ok: false, lucro: 0n, porque: null, gas: null };
            try {
                const tx = await chamar('eth_sendTransaction', [{ from: DONO, to: CACADOR, data: envio, gas: '0x5b8d80' }]);
                const rec = await chamar('eth_getTransactionReceipt', [tx]);
                r.ok = rec.status === '0x1';
                r.gas = parseInt(rec.gasUsed, 16);
                r.lucro = (await saldoDe(USDC, COFRE)) - antes;
                if (!r.ok) r.porque = 'status 0 sem motivo legivel';
            } catch (e) { r.porque = porQueReverteu(e.data ?? e.message); }
            await chamar('evm_revert', [snap]);
            return r;
        }

        const linhas = [];
        // ---- REGIME A: saude entre 0,95 e 1 (o que uma escrita de oraculo faz) ----
        const a = await levarSaudeA(999_000_000_000_000_000n); // 0,999
        assert.ok(a !== null, 'nao consegui levar a saude a 0,999');
        console.log(`\n    REGIME A: saude ${(Number(a.saude) / 1e18).toFixed(6)} `
            + `(WETH US$ ${(Number(a.preco) / 1e8).toFixed(2)}, -${(100 - Number(a.preco) * 100 / Number(precoWeth)).toFixed(2)}%)`);
        const metade = alvo.cru / 2n;
        for (const [cobrir, rotulo] of [
            [metade, 'METADE (o que o bot pede hoje)'],
            [alvo.cru, '100% da dívida'],
            [(alvo.cru * 6n) / 10n, '60% — logo acima da metade'],
            [alvo.cru > 500_000_000n ? alvo.cru - 500_000_000n : metade, 'deixando ~US$ 500 de resíduo'],
        ]) linhas.push({ regime: 'A (saúde ~0,999)', ...(await tiro(cobrir, rotulo)) });

        // ---- REGIME B: saude ABAIXO de 0,95 ----
        const b = await levarSaudeA(940_000_000_000_000_000n); // 0,94
        if (b !== null) {
            console.log(`    REGIME B: saude ${(Number(b.saude) / 1e18).toFixed(6)} `
                + `(WETH US$ ${(Number(b.preco) / 1e8).toFixed(2)}, -${(100 - Number(b.preco) * 100 / Number(precoWeth)).toFixed(2)}%)`);
            for (const [cobrir, rotulo] of [
                [metade, 'METADE'],
                [alvo.cru, '100% da dívida'],
            ]) linhas.push({ regime: 'B (saúde ~0,94)', ...(await tiro(cobrir, rotulo)) });
        } else {
            console.log('    REGIME B: nao consegui levar a saude abaixo de 0,95 — declarado, nao suposto');
        }

        console.log('\n    regime                rótulo                              cobriu  ok   lucro USDC   gás      motivo');
        for (const l of linhas) {
            console.log(`    ${l.regime.padEnd(20)}  ${l.rotulo.padEnd(34)}  `
                + `${String(l.cobrir).padStart(12)}  ${l.ok ? 'SIM' : 'não'}  `
                + `${(Number(l.lucro) / 1e6).toFixed(2).padStart(10)}  ${String(l.gas ?? '—').padStart(7)}  ${l.porque ?? ''}`);
        }

        // ---- AS PREVISOES, conferidas ----
        const achar = (reg, rot) => linhas.find((l) => l.regime.startsWith(reg) && l.rotulo.startsWith(rot));
        const a100 = achar('A', '100%'); const a60 = achar('A', '60%');
        const a50 = achar('A', 'METADE'); const aDust = achar('A', 'deixando');
        const b100 = achar('B', '100%'); const b50 = achar('B', 'METADE');
        const veredicto = (nome, previsto, real, detalhe) =>
            console.log(`    ${nome}: previ ${previsto} | real ${real} -> ${previsto === real ? 'PASSOU' : 'FALHOU'}${detalhe ? ` (${detalhe})` : ''}`);
        console.log('');
        veredicto('P1 (>metade reverte com saúde 0,95–1)', 'reverte',
            a100.ok || a60.ok ? 'ACEITOU' : 'reverte', `100%: ${a100.porque ?? 'ok'} | 60%: ${a60.porque ?? 'ok'}`);
        veredicto('P3 (resíduo pequeno reverte)', 'reverte',
            aDust.ok ? 'ACEITOU' : 'reverte', aDust.porque ?? 'ok');
        if (b100) {
            veredicto('P2 (100% aceito com saúde <0,95)', 'aceito',
                b100.ok ? 'aceito' : 'REVERTEU', b100.porque ?? 'ok');
            if (b100.ok && b50.ok && b50.lucro > 0n) {
                const razao = Number(b100.lucro) / Number(b50.lucro);
                console.log(`    P4 (lucro 100% / lucro 50%): ${razao.toFixed(2)}x -> `
                    + `${razao >= 1.5 && razao <= 2.5 ? 'PASSOU' : 'FALHOU'}`);
            }
        }

        // O teste NAO afirma o veredicto: ele afirma que a MEDICAO aconteceu.
        // Cravar aqui o resultado que eu previ seria o erro que este projeto
        // persegue — e as previsoes acima ficam no log, conferiveis.
        assert.ok(a50 !== undefined && a100 !== undefined, 'os dois regimes tinham de ser exercitados');
        assert.ok(linhas.every((l) => l.ok || l.porque !== null),
            'toda reversao tem de ter motivo legivel — `execution reverted` sem seletor nao mede nada');
    });
});
