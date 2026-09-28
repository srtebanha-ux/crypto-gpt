import { ProxyAgent, fetch as uf } from 'undici';
import { Decimal } from 'decimal.js';
import { REDES, TOPIC_LIQUIDATION_CALL } from '../src/liquidacoes';
import { SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from '../src/posicoes';
import { lucroEstimado } from '../src/perdidas';
const RPC = 'https://mainnet.base.org';
const POOL = REDES.base!.pool;
const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
let id = 1;
async function rpc<T>(m: string, p: unknown[]): Promise<T | null> {
    for (let i = 0; i < 6; i++) {
        try {
            const r = await uf(RPC, { method: 'POST', dispatcher: agente,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: m, params: p }) });
            const j = await r.json() as { result?: T; error?: { message: string } };
            if (!j.error) return j.result as T;
        } catch {}
        await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
    return null;
}
(async () => {
    const topo = Number.parseInt((await rpc<string>('eth_blockNumber', []))!, 16);
    // As ultimas 6 janelas de 2000 = ~6,7 horas. Cobre o boot das 11:39 e o das 12:17.
    for (let i = 0; i < 6; i++) {
        const ate = topo - i * 2000;
        const logs = await rpc<Array<{ topics: string[]; data: string; blockNumber: string; transactionHash: string }>>(
            'eth_getLogs', [{ address: POOL, fromBlock: `0x${(ate - 1999).toString(16)}`,
                toBlock: `0x${ate.toString(16)}`, topics: [TOPIC_LIQUIDATION_CALL] }]);
        if (logs === null) { console.log(`janela ${i}: FALHOU`); continue; }
        for (const l of logs) {
            const devedor = '0x' + l.topics[3]!.slice(26);
            const bloco = Number.parseInt(l.blockNumber, 16);
            const min = ((topo - bloco) * 2) / 60;
            const liq = '0x' + l.data.replace(/^0x/, '').slice(64 * 2 + 24, 64 * 3);
            console.log(`\n${devedor}  bloco ${bloco}  (${min.toFixed(0)} min atrás)`);
            console.log(`  quem levou: ${liq}`);
            for (const d of [3, 2, 1]) {
                const bruto = await rpc<string>('eth_call', [{ to: POOL,
                    data: SELETOR_CONTA_DO_USUARIO + devedor.replace(/^0x/, '').padStart(64, '0') },
                    `0x${(bloco - d).toString(16)}`]);
                if (bruto === null) { console.log(`  -${d} bloco: sem arquivo`); continue; }
                try {
                    const c = decodificarContaDoUsuario(bruto);
                    const q = quedaAteLiquidar(c.saude);
                    const dividaUsd = c.dividaBase.dividedBy(1e8);
                    console.log(`  -${d} bloco (${d * 2}s antes): saúde `
                        + `${new Decimal(c.saude.toString()).dividedBy('1e18').toFixed(5)}`
                        + `  dívida US$ ${dividaUsd.toFixed(2)}  lucro US$ ${lucroEstimado(dividaUsd).toFixed(2)}`
                        + `  ${q !== null && q.isZero() ? '>>> JÁ LIQUIDÁVEL: HAVIA JANELA' : ''}`);
                } catch { console.log(`  -${d} bloco: não decodifiquei`); }
                await new Promise((r) => setTimeout(r, 250));
            }
            console.log(`  https://basescan.org/tx/${l.transactionHash}`);
        }
        await new Promise((res) => setTimeout(res, 200));
    }
})();
