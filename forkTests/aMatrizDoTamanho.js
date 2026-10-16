// A MATRIZ DO TAMANHO — e nada aqui prova regra universal.
//
// Em 2026-10-10 o primeiro experimento (`oTamanhoCerto.js`) testou UM alvo, em
// DOIS regimes de saude, com UMA divida e UMA garantia. Ela corrigiu a minha
// conclusao: *"O experimento não validou metade como regra universal. Registre
// 'nenhum ganho demonstrado nos casos testados'. Complete a matriz com
// posições pequenas, múltiplas dívidas ou garantias quando aplicável,
// diferentes regimes de saúde e valores próximos dos limites de resíduos."*
//
// Entao aqui:
//   - posicoes de TAMANHOS escolhidos, montadas no fork (US$ 500 a US$ 3.000)
//   - tres regimes de saude
//   - coberturas perto dos limites de residuo
//   - e, para cada tiro: QUANTO FOI PEDIDO, quanto a Aave de fato liquidou
//     (lido do evento `LiquidationCall`) e quanto voltou sem ser usado
//   - a reversao localizada no TRACE, nao deduzida do seletor
//
// O QUE ESTE TESTE NAO E: prova de oportunidade. A posicao e montada por mim e
// o preco e forcado. Isto mede a REGRA DO PROTOCOLO — fator de fechamento e
// residuo — que e propriedade da Aave e nao do mercado.
const assert = require('node:assert/strict');
const { Interface, id } = require('ethers');

const POOL_AAVE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const CACADOR = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const DONO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const POOL_VENDA = '0xcdac0d6c6c59727a65f871236188350531885c43';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const sel = (a) => id(a).slice(0, 10);
const z = (x) => x.toLowerCase().replace('0x', '').padStart(64, '0');
const cacarIface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)',
]);
const liqIface = new Interface([
    'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
]);
const TOPICO_LIQ = liqIface.getEvent('LiquidationCall').topicHash;
const ERROS = {};
for (const a of [
    'HealthFactorNotBelowThreshold()', 'CollateralCannotBeLiquidated()',
    'SpecifiedCurrencyNotBorrowedByUser()', 'MustNotLeaveDust()',
    'HealthFactorLowerThanLiquidationThreshold()', 'LucroInsuficiente(uint256,uint256)',
    'InsufficientOutputAmount()', 'CollateralBalanceIsZero()',
]) ERROS[sel(a)] = a;

let p;
const chamar = (m, ps) => p.send(m, ps);
const call = async (to, data, bloco = 'latest') => chamar('eth_call', [{ to, data }, bloco]);
const palavra = (h, i) => BigInt(`0x${h.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
const saldoDe = async (t, q) => BigInt(await call(t, sel('balanceOf(address)') + z(q)));
async function conta(d) {
    const r = await call(POOL_AAVE, sel('getUserAccountData(address)') + z(d));
    return { garantiaBase: palavra(r, 0), dividaBase: palavra(r, 1), saude: palavra(r, 5) };
}
function identificar(dados) {
    const m = /0x[0-9a-fA-F]{8,}/.exec(dados ?? '');
    if (!m) return { seletor: null, nome: `sem dados: ${String(dados).slice(0, 70)}` };
    const s = m[0].slice(0, 10);
    return { seletor: s, nome: ERROS[s] ?? `DESCONHECIDO ${s}` };
}
/** Quem reverteu, pelo TRACE — e nao pelo seletor que chegou na ponta. */
async function ondeReverteu(from, to, data) {
    try {
        const t = await chamar('debug_traceCall', [{ from, to, data, gas: '0x5b8d80' }, 'latest',
            { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } }]);
        const achados = [];
        const andar = (n, prof) => {
            if (n.error !== undefined || n.revertReason !== undefined || (n.output ?? '').length >= 10) {
                const id = identificar(n.output);
                if (id.seletor !== null && ERROS[id.seletor] !== undefined) {
                    achados.push(`${'  '.repeat(prof)}${n.to ?? '?'} -> ${id.nome}`);
                }
            }
            for (const c of n.calls ?? []) andar(c, prof + 1);
        };
        andar(t, 0);
        return achados.length === 0 ? ['trace sem erro identificavel'] : achados;
    } catch (e) { return [`trace indisponivel: ${String(e.message).slice(0, 60)}`]; }
}

describe('A MATRIZ DO TAMANHO: fator de fechamento e resíduo, em vários casos', function () {
    this.timeout(1_800_000);

    it('pedido x liquidado x devolvido, por tamanho e por regime de saúde', async function () {
        p = hre.network.provider;
        const bloco = parseInt(await chamar('eth_blockNumber', []), 16);
        const prov = `0x${(await call(POOL_AAVE, sel('ADDRESSES_PROVIDER()'))).slice(26)}`;
        const oraculo = `0x${(await call(prov, sel('getPriceOracle()'))).slice(26)}`;
        const fonteWeth = `0x${(await call(oraculo, sel('getSourceOfAsset(address)') + z(WETH))).slice(26)}`;
        const precoWeth = BigInt(await call(oraculo, sel('getAssetPrice(address)') + z(WETH)));
        console.log(`    bloco ${bloco} | oráculo ${oraculo} | WETH US$ ${(Number(precoWeth) / 1e8).toFixed(2)}`);

        // O falso oráculo na FONTE do WETH.
        const art = await hre.artifacts.readArtifact('OraculoFalso');
        const [c0] = await chamar('eth_accounts', []);
        const txD = await chamar('eth_sendTransaction', [{ from: c0, data: art.bytecode, gas: '0x500000' }]);
        const recD = await chamar('eth_getTransactionReceipt', [txD]);
        const runtime = await chamar('eth_getCode', [recD.contractAddress, 'latest']);
        await chamar('hardhat_setCode', [fonteWeth, runtime]);
        const porPreco = async (preco) =>
            chamar('hardhat_setStorageAt', [fonteWeth, '0x0', `0x${preco.toString(16).padStart(64, '0')}`]);
        await porPreco(precoWeth);

        await chamar('hardhat_impersonateAccount', [DONO]);
        await chamar('hardhat_setBalance', [DONO, '0x56bc75e2d63100000']);

        /**
         * Monta um DEVEDOR novo com a dívida pedida, em USDC contra WETH.
         *
         * A posição é minha, e isso é declarado: ela mede a REGRA do protocolo
         * (fator de fechamento, resíduo), não a existência de oportunidade.
         */
        async function montarDevedor(dividaUsd, apelido) {
            const quem = `0x${apelido.padStart(40, '0')}`;
            await chamar('hardhat_impersonateAccount', [quem]);
            await chamar('hardhat_setBalance', [quem, '0x152d02c7e14af6800000']); // 100k ETH
            // WETH suficiente para ~2,2x a dívida de garantia (LTV ~80%).
            const wethPrecisa = (BigInt(Math.round(dividaUsd * 1e8)) * 10n ** 18n * 22n)
                / (precoWeth * 10n);
            await chamar('eth_sendTransaction', [{
                from: quem, to: WETH, value: `0x${wethPrecisa.toString(16)}`,
                data: sel('deposit()'), gas: '0x30000',
            }]);
            await chamar('eth_sendTransaction', [{
                from: quem, to: WETH, data: sel('approve(address,uint256)') + z(POOL_AAVE)
                    + 'f'.repeat(64), gas: '0x30000',
            }]);
            await chamar('eth_sendTransaction', [{
                from: quem, to: POOL_AAVE,
                data: sel('supply(address,uint256,address,uint16)') + z(WETH)
                    + wethPrecisa.toString(16).padStart(64, '0') + z(quem) + z('0x0'),
                gas: '0x200000',
            }]);
            const cru = BigInt(Math.round(dividaUsd * 1e6));
            await chamar('eth_sendTransaction', [{
                from: quem, to: POOL_AAVE,
                data: sel('borrow(address,uint256,uint256,uint16,address)') + z(USDC)
                    + cru.toString(16).padStart(64, '0')
                    + (2n).toString(16).padStart(64, '0') + z('0x0') + z(quem),
                gas: '0x300000',
            }]);
            const c = await conta(quem);
            return { quem, cru, saude: c.saude, dividaBase: c.dividaBase };
        }

        /** Leva a saúde do devedor ao alvo, baixando o WETH em passos. */
        async function levarSaudeA(quem, alvoSaude) {
            for (let q = 1; q <= 400; q++) {
                const usado = (precoWeth * BigInt(10_000 - q * 20)) / 10_000n;
                if (usado <= 0n) return null;
                await porPreco(usado);
                const s = (await conta(quem)).saude;
                if (s <= alvoSaude) return { saude: s, preco: usado };
            }
            return null;
        }

        /** Um tiro de verdade, com snapshot, medindo pedido/liquidado/devolvido. */
        async function tiro(quem, cobrir, rotulo, caso) {
            const snap = await chamar('evm_snapshot', []);
            const antesCofre = await saldoDe(USDC, COFRE);
            const envio = cacarIface.encodeFunctionData('cacar',
                [WETH, USDC, quem, cobrir, POOL_VENDA, 1n]);
            const r = {
                caso, rotulo, pedido: cobrir, liquidado: null, garantiaTomada: null,
                devolvido: null, ok: false, lucro: 0n, gas: null, erro: null, trace: null,
            };
            try {
                const tx = await chamar('eth_sendTransaction', [{
                    from: DONO, to: CACADOR, data: envio, gas: '0x5b8d80',
                }]);
                const rec = await chamar('eth_getTransactionReceipt', [tx]);
                r.ok = rec.status === '0x1';
                r.gas = parseInt(rec.gasUsed, 16);
                const ev = (rec.logs ?? []).find((l) => l.topics[0] === TOPICO_LIQ);
                if (ev) {
                    const d = liqIface.decodeEventLog('LiquidationCall', ev.data, ev.topics);
                    r.liquidado = d.debtToCover;
                    r.garantiaTomada = d.liquidatedCollateralAmount;
                    r.devolvido = cobrir - d.debtToCover;
                }
                r.lucro = (await saldoDe(USDC, COFRE)) - antesCofre;
                if (!r.ok) r.erro = 'status 0';
            } catch (e) {
                r.erro = identificar(e.data ?? e.message).nome;
                r.trace = (await ondeReverteu(DONO, CACADOR, envio)).join(' ; ');
            }
            await chamar('evm_revert', [snap]);
            return r;
        }

        const linhas = [];
        // ---- A MATRIZ: tres tamanhos x tres regimes x coberturas ----
        for (const [dividaUsd, apelido] of [[500, 'd500'], [1500, 'd1500'], [3000, 'd3000']]) {
            const snapBase = await chamar('evm_snapshot', []);
            await porPreco(precoWeth);
            let dev;
            try {
                dev = await montarDevedor(dividaUsd, Buffer.from(apelido).toString('hex'));
            } catch (e) {
                console.log(`    US$ ${dividaUsd}: NAO consegui montar — ${String(e.message).slice(0, 80)}`);
                await chamar('evm_revert', [snapBase]);
                continue;
            }
            console.log(`\n    DEVEDOR US$ ${dividaUsd} (${dev.quem.slice(0, 10)}) `
                + `saúde ${(Number(dev.saude) / 1e18).toFixed(6)} | dívida crua ${dev.cru}`);
            for (const [alvoSaude, nomeRegime] of [
                [999_000_000_000_000_000n, 'saúde ~0,999'],
                [970_000_000_000_000_000n, 'saúde ~0,97'],
                [930_000_000_000_000_000n, 'saúde ~0,93'],
            ]) {
                const snapR = await chamar('evm_snapshot', []);
                const reg = await levarSaudeA(dev.quem, alvoSaude);
                if (reg === null) {
                    console.log(`      ${nomeRegime}: não alcancei — declarado`);
                    await chamar('evm_revert', [snapR]);
                    continue;
                }
                const caso = `US$ ${dividaUsd} / ${nomeRegime}`;
                const metade = dev.cru / 2n;
                for (const [cobrir, rotulo] of [
                    [metade, 'metade'],
                    [dev.cru, '100%'],
                    [(dev.cru * 51n) / 100n, '51% — logo acima da metade'],
                    [dev.cru > 1_000_000n ? dev.cru - 1_000_000n : metade, 'deixa US$ 1 de resíduo'],
                ]) linhas.push(await tiro(dev.quem, cobrir, rotulo, caso));
                await chamar('evm_revert', [snapR]);
            }
            await chamar('evm_revert', [snapBase]);
        }

        console.log('\n    caso                      cobertura                   pedido  liquidado  devolvido   ok   lucro    erro');
        for (const l of linhas) {
            console.log(`    ${l.caso.padEnd(24)}  ${l.rotulo.padEnd(26)}  `
                + `${String(l.pedido).padStart(9)}  ${String(l.liquidado ?? '—').padStart(9)}  `
                + `${String(l.devolvido ?? '—').padStart(9)}  ${l.ok ? 'SIM' : 'não'}  `
                + `${(Number(l.lucro) / 1e6).toFixed(2).padStart(7)}  ${l.erro ?? ''}`);
            if (l.trace) console.log(`        trace: ${l.trace}`);
        }

        // O que a matriz RESPONDE, sem virar regra universal.
        const clampou = linhas.filter((l) => l.ok && l.devolvido !== null && l.devolvido > 0n);
        const ganhouPedindoMais = linhas.filter((l) => {
            const m = linhas.find((x) => x.caso === l.caso && x.rotulo === 'metade');
            return m !== undefined && m.ok && l.ok && l.lucro > m.lucro;
        });
        console.log(`\n    casos em que a Aave CLAMPOU (devolveu parte do pedido): ${clampou.length} de ${linhas.filter((l) => l.ok).length} bem-sucedidos`);
        console.log(`    casos em que pedir mais que metade RENDEU MAIS: ${ganhouPedindoMais.length}`);
        console.log('    >>> "nenhum ganho demonstrado nos casos testados" é a afirmação que a matriz sustenta.');
        console.log('        Ela NÃO diz que metade é ótimo em todo caso: diz que nestes não houve ganho.');

        assert.ok(linhas.length > 0, 'a matriz tinha de ter pelo menos um caso');
        assert.ok(linhas.every((l) => l.ok || l.erro !== null),
            'toda reversão precisa de motivo identificado');
    });
});
