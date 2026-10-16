// A reversão 0xb629b0e4 pelo TRACER PADRÃO: qual CAMADA reverteu.
// Não localiza a linha; localiza o ENDEREÇO que executou o REVERT.
const { Interface, id } = require('ethers');
const POOL = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const CACADOR = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const DONO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const POOL_VENDA = '0xcdac0d6c6c59727a65f871236188350531885c43';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const sel = (a) => id(a).slice(0, 10);
const z = (x) => x.toLowerCase().replace('0x', '').padStart(64, '0');
const iface = new Interface(['function cacar(address,address,address,uint256,address,uint256)']);
describe('o tracer PADRÃO: que camada reverteu', function () {
    this.timeout(900000);
    it('localiza a profundidade e o endereço do REVERT', async function () {
        const p = hre.network.provider;
        const ch = (m, ps) => p.send(m, ps);
        const call = (to, data) => ch('eth_call', [{ to, data }, 'latest']);
        const prov = `0x${(await call(POOL, sel('ADDRESSES_PROVIDER()'))).slice(26)}`;
        const orac = `0x${(await call(prov, sel('getPriceOracle()'))).slice(26)}`;
        const fonte = `0x${(await call(orac, sel('getSourceOfAsset(address)') + z(WETH))).slice(26)}`;
        const preco = BigInt(await call(orac, sel('getAssetPrice(address)') + z(WETH)));
        const art = await hre.artifacts.readArtifact('OraculoFalso');
        const [c0] = await ch('eth_accounts', []);
        const tx = await ch('eth_sendTransaction', [{ from: c0, data: art.bytecode, gas: '0x500000' }]);
        const rec = await ch('eth_getTransactionReceipt', [tx]);
        await ch('hardhat_setCode', [fonte, await ch('eth_getCode', [rec.contractAddress, 'latest'])]);
        const quem = '0x0000000000000000000000000000000074726163';
        await ch('hardhat_impersonateAccount', [quem]);
        await ch('hardhat_setBalance', [quem, '0x152d02c7e14af6800000']);
        const weth = (150000000000n * 10n ** 18n * 22n) / (preco * 10n);
        await ch('eth_sendTransaction', [{ from: quem, to: WETH, value: `0x${weth.toString(16)}`, data: sel('deposit()'), gas: '0x30000' }]);
        await ch('eth_sendTransaction', [{ from: quem, to: WETH, data: sel('approve(address,uint256)') + z(POOL) + 'f'.repeat(64), gas: '0x30000' }]);
        await ch('eth_sendTransaction', [{ from: quem, to: POOL, data: sel('supply(address,uint256,address,uint16)') + z(WETH) + weth.toString(16).padStart(64, '0') + z(quem) + z('0x0'), gas: '0x200000' }]);
        await ch('eth_sendTransaction', [{ from: quem, to: POOL, data: sel('borrow(address,uint256,uint256,uint16,address)') + z(USDC) + (1500000000n).toString(16).padStart(64, '0') + (2n).toString(16).padStart(64, '0') + z('0x0') + z(quem), gas: '0x300000' }]);
        for (let q = 1; q <= 400; q++) {
            const v = (preco * BigInt(10000 - q * 20)) / 10000n;
            await ch('hardhat_setStorageAt', [fonte, '0x0', `0x${v.toString(16).padStart(64, '0')}`]);
            const r = await call(POOL, sel('getUserAccountData(address)') + z(quem));
            if (BigInt(`0x${r.slice(2 + 5 * 64, 2 + 6 * 64)}`) <= 999000000000000000n) break;
        }
        await ch('hardhat_impersonateAccount', [DONO]);
        await ch('hardhat_setBalance', [DONO, '0x56bc75e2d63100000']);
        const envio = iface.encodeFunctionData('cacar', [WETH, USDC, quem, 750000000n, POOL_VENDA, 1n]);
        let hash = null;
        try {
            // AUTOMINE DESLIGADO: o no devolve o hash ANTES de executar, entao
            // a transacao que reverte fica tracavel. Era isso que faltava.
            await ch('evm_setAutomine', [false]);
            hash = await ch('eth_sendTransaction', [{ from: DONO, to: CACADOR, data: envio, gas: '0x5b8d80' }]);
            await ch('evm_mine', []);
            await ch('evm_setAutomine', [true]);
        } catch (e) {
            // A transação reverte: o Hardhat guarda o hash mesmo assim.
            const m = /0x[0-9a-f]{64}/i.exec(e.message ?? '');
            hash = m ? m[0] : null;
            console.log(`    reverteu no envio: ${String(e.message).slice(0, 80)}`);
        }
        if (hash === null) { console.log('    sem hash: não dá para tracear'); return; }
        const t = await ch('debug_traceTransaction', [hash, { disableMemory: true, disableStack: false, disableStorage: true }]);
        const logs = t.structLogs ?? [];
        console.log(`    structLogs: ${logs.length} passos | gas ${t.gas} | failed ${t.failed}`);
        // O ultimo REVERT e quem abortou; a profundidade diz a CAMADA.
        const reverts = logs.filter((l) => l.op === 'REVERT');
        console.log(`    REVERTs no trace: ${reverts.length}`);
        for (const r of reverts.slice(-6)) {
            console.log(`      pc ${r.pc} depth ${r.depth} gas ${r.gas}`);
        }
        // As CALLs, para mapear profundidade -> endereco.
        const chamadas = logs.filter((l) => ['CALL', 'STATICCALL', 'DELEGATECALL'].includes(l.op));
        console.log(`    chamadas no trace: ${chamadas.length}`);
        // A CADEIA: para cada profundidade, o endereco chamado. O REVERT mais
        // PROFUNDO e a origem; os de cima sao a propagacao.
        const porProf = new Map();
        for (const l of logs) {
            if (!['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE'].includes(l.op)) continue;
            const st = l.stack ?? [];
            if (st.length < 2) continue;
            porProf.set(l.depth + 1, { op: l.op, para: `0x${st[st.length - 2].slice(-40)}` });
        }
        const maisProfundo = reverts.reduce((a2, b2) => (b2.depth > a2.depth ? b2 : a2), reverts[0]);
        console.log(`\n    A CADEIA do REVERT (o mais profundo é a ORIGEM):`);
        for (const r of [...reverts].sort((a2, b2) => b2.depth - a2.depth)) {
            const q = porProf.get(r.depth);
            console.log(`      depth ${r.depth} pc ${r.pc}  <- ${q ? `${q.op} para ${q.para}` : 'sem chamada mapeada'}`
                + (r === maisProfundo ? '   <<< ORIGEM' : '   (propagação)'));
        }
        const ultimo = reverts.at(-1);
        if (ultimo) {
            const antes = chamadas.filter((c) => c.depth === ultimo.depth - 1 || c.depth === ultimo.depth);
            const alvo = antes.at(-1);
            const pilha = alvo?.stack ?? [];
            const endereco = pilha.length >= 2 ? `0x${pilha[pilha.length - 2].slice(-40)}` : null;
            console.log(`\n    >>> o REVERT final está na profundidade ${ultimo.depth}`);
            console.log(`        a última chamada antes dele foi ${alvo?.op ?? '—'} para ${endereco ?? 'não extraí'}`);
            console.log('        (profundidade e endereço são MEDIDOS; o NOME do erro continua hipótese)');
        }
    });
});
