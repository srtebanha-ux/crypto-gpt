// Arquivo: src/olharAgora.ts
//
// Le a Base AGORA e mostra os alvos vigiados, com o quanto andaram desde a
// ultima olhada. Roda daqui, sem deploy, desde que a rede esteja liberada.
//
//     npx tsx src/olharAgora.ts            olha os alvos guardados
//     npx tsx src/olharAgora.ts --varrer   refaz a lista varrendo a Base
import { ProxyAgent, fetch as uf } from 'undici';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Decimal } from 'decimal.js';
import { REDES } from './liquidacoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from './posicoes';
import { MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { lucroEstimado } from './perdidas';
import { faixaQueAtira, LIMITE_DE_GAS } from './prontidao';
import { compararLeituras, naoForamLidos, comoLerOMovimento, type Alvo, type Leitura } from './olhoNosAlvos';

const RPC = process.env.OLHO_RPC ?? 'https://mainnet.base.org';
const ONDE = process.env.OLHO_ARQUIVO ?? '.olho/alvos.json';
const POOL = REDES.base!.pool;
// O `fetch` do Node ignora HTTPS_PROXY e cai numa politica de rede mais
// estreita: devolve "Host not in allowlist" enquanto o curl passa, no MESMO
// instante. Medido em 2026-09-27.
const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
let id = 1;

async function rpc<T>(metodo: string, params: unknown[], tentativas = 6): Promise<T> {
    let ultimo = '';
    for (let i = 0; i < tentativas; i++) {
        try {
            const r = await uf(RPC, { method: 'POST', dispatcher: agente, headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: metodo, params }) });
            const j = await r.json() as { result?: T; error?: { message: string } };
            if (!j.error) return j.result as T;
            ultimo = j.error.message;
        } catch (e) { ultimo = (e as Error).message; }
        await dormir(700 * (i + 1));
    }
    throw new Error(ultimo);
}

/** Varre a Base atras de quem esta perto de cair. Declara a cobertura. */
async function varrer(topo: number, ateQuedaPct: number): Promise<{ alvos: Alvo[]; lidos: number; total: number }> {
    // O RPC publico recusa eth_getLogs acima de 2.000 blocos. Medido.
    const JANELA = 2_000, QUANTAS = Number(process.env.OLHO_JANELAS ?? '160');
    const vistos = new Set<string>();
    for (let i = 0; i < QUANTAS; i++) {
        const ate = topo - i * JANELA;
        try {
            const logs = await rpc<Array<{ topics: string[] }>>('eth_getLogs', [{
                address: POOL, fromBlock: `0x${(ate - JANELA + 1).toString(16)}`, toBlock: `0x${ate.toString(16)}`,
                topics: [TOPIC_BORROW],
            }]);
            for (const d of devedoresDosEventos(logs)) vistos.add(d.toLowerCase());
        } catch { /* declarado na cobertura abaixo */ }
        if (i % 40 === 39) process.stderr.write(`.${vistos.size}`);
        await dormir(150);
    }
    const lista = [...vistos];
    const { alvos, lidos } = await lerContas(lista, ateQuedaPct);
    return { alvos, lidos, total: lista.length };
}

async function lerContas(lista: string[], ateQuedaPct: number): Promise<{ alvos: Alvo[]; lidos: number }> {
    const alvos: Alvo[] = [];
    let lidos = 0;
    for (const pedaco of partirEmPedacos(lista, 150)) {
        try {
            const bruto = await rpc<string>('eth_call', [{ to: MULTICALL3, data: codificarAggregate3(
                pedaco.map((d) => ({ alvo: POOL, dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0') })),
            ) }, 'latest']);
            const resp = decodificarAggregate3(bruto);
            for (let i = 0; i < pedaco.length; i++) {
                if (!resp[i]?.ok) continue;
                lidos += 1;
                try {
                    const c = decodificarContaDoUsuario(resp[i]!.dados);
                    const q = quedaAteLiquidar(c.saude);
                    const dividaUsd = c.dividaBase.dividedBy(1e8);
                    if (q === null) { alvos.push({ devedor: pedaco[i]!, queda: null, dividaUsd, lucroUsd: new Decimal(0) }); continue; }
                    if (q.lessThanOrEqualTo(ateQuedaPct)) {
                        alvos.push({ devedor: pedaco[i]!, queda: q, dividaUsd, lucroUsd: lucroEstimado(dividaUsd) });
                    }
                } catch { /* um registro estranho nao derruba a leitura */ }
            }
        } catch { /* declarado na cobertura */ }
        await dormir(1400);
    }
    return { alvos, lidos };
}

(async () => {
    const varreu = process.argv.includes('--varrer');
    const topo = Number.parseInt(await rpc<string>('eth_blockNumber', []), 16);
    const antes: Leitura | null = existsSync(ONDE)
        ? (() => { const j = JSON.parse(readFileSync(ONDE, 'utf8')) as { em: number; alvos: Array<{ devedor: string; queda: string | null; dividaUsd: string; lucroUsd: string }> };
            return { em: j.em, alvos: j.alvos.map((a) => ({ devedor: a.devedor, queda: a.queda === null ? null : new Decimal(a.queda), dividaUsd: new Decimal(a.dividaUsd), lucroUsd: new Decimal(a.lucroUsd) })) }; })()
        : null;

    const ATE = Number(process.env.OLHO_ATE_PCT ?? '5');
    let alvos: Alvo[], lidos: number, total: number;
    if (varreu || antes === null) {
        ({ alvos, lidos, total } = await varrer(topo, ATE));
    } else {
        const lista = antes.alvos.map((a) => a.devedor);
        ({ alvos, lidos } = await lerContas(lista, 1e9));
        total = lista.length;
    }

    const cobertura = total === 0 ? 100 : (lidos / total) * 100;
    const agora: Leitura = { em: Date.now(), alvos };
    console.log(`\nbloco ${topo}  |  li ${lidos} de ${total} (${cobertura.toFixed(1)}%)${cobertura < 99 ? '  >>> COBERTURA BAIXA: não conclua daqui' : ''}`);

    const faixa = faixaQueAtira({
        precoDoEthUsd: new Decimal(process.env.OLHO_ETH ?? '2690'),
        saldoWei: BigInt(process.env.OLHO_SALDO_WEI ?? '3341111000000000'),
        baseFeeWei: 20_000_000n, limiteGas: LIMITE_DE_GAS,
        fracaoBaseDoLucro: Number(process.env.CACA_FRACAO_GORJETA ?? '0.15'),
        tiroDeProva: process.env.CACA_TIRO_DE_PROVA === '1',
    });
    const teto = faixa?.ate ?? null;
    console.log(`faixa do bot: até ${teto === null ? 'SEM TETO' : `US$ ${teto.toFixed(2)}`}\n`);

    const vivos = alvos.filter((a) => a.queda !== null).sort((a, b) => a.queda!.comparedTo(b.queda!));
    const movs = compararLeituras(antes, { em: agora.em, alvos: vivos });
    for (const m of movs) {
        const alvo = m.tipo === 'saiu' ? null : m.alvo;
        const dentro = alvo && alvo.lucroUsd.greaterThan(0) && (teto === null || alvo.lucroUsd.lessThanOrEqualTo(teto));
        console.log(`${dentro ? '>> ATIRA  ' : '   fora   '}${comoLerOMovimento(m)}`);
    }
    const faltaram = naoForamLidos(antes, { em: agora.em, alvos: vivos });
    if (faltaram.length > 0) console.log(`\n${faltaram.length} não foram lidos agora (NÃO quer dizer que sumiram): ${faltaram.slice(0, 5).map((d) => d.slice(0, 10) + '…').join(', ')}`);

    mkdirSync(dirname(ONDE), { recursive: true });
    writeFileSync(ONDE, JSON.stringify({ em: agora.em, alvos: vivos.map((a) => ({
        devedor: a.devedor, queda: a.queda?.toString() ?? null, dividaUsd: a.dividaUsd.toString(), lucroUsd: a.lucroUsd.toString(),
    })) }, null, 1));
    console.log(`\n${vivos.length} alvos guardados em ${ONDE}. Rode de novo para ver o quanto andaram.`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
