import { ProxyAgent, fetch as uf } from 'undici';
import { Decimal } from 'decimal.js';
import { REDES } from '../src/liquidacoes';
import { SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from '../src/posicoes';
const RPC = 'https://mainnet.base.org';
const POOL = REDES.base!.pool;
const ALVO = '0x4015e52c5c5186121931c08650575a78df98fab2';
const BL = 51903901;
const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
let id = 1;
async function rpc<T>(m: string, p: unknown[]): Promise<T | null> {
    for (let i = 0; i < 5; i++) {
        try {
            const r = await uf(RPC, { method: 'POST', dispatcher: agente,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: m, params: p }) });
            const j = await r.json() as { result?: T; error?: { message: string } };
            if (!j.error) return j.result as T;
        } catch {}
        await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
    return null;
}
(async () => {
    console.log(`saúde CRUA de ${ALVO.slice(0, 10)}… antes do bloco ${BL}`);
    console.log('(1e18 = exatamente 1.0; quedaAteLiquidar devolve 0 para saúde <= 1)\n');
    for (const d of [60, 30, 15, 10, 8, 6, 5, 4, 3, 2, 1]) {
        const bruto = await rpc<string>('eth_call', [{ to: POOL,
            data: SELETOR_CONTA_DO_USUARIO + ALVO.replace(/^0x/, '').padStart(64, '0') },
            `0x${(BL - d).toString(16)}`]);
        if (bruto === null) { console.log(`  -${String(d).padStart(2)}: sem arquivo`); continue; }
        try {
            const c = decodificarContaDoUsuario(bruto);
            const q = quedaAteLiquidar(c.saude);
            console.log(`  -${String(d).padStart(2)} (${String(d * 2).padStart(3)}s): saúde crua ${c.saude.toString()}`
                + `  queda ${q === null ? 'null' : q.toFixed(8) + '%'}`
                + `  ${q !== null && q.isZero() ? '>>> LIQUIDÁVEL' : ''}`);
        } catch (e) { console.log(`  -${d}: erro ${(e as Error).message}`); }
        await new Promise((r) => setTimeout(r, 220));
    }
})();
