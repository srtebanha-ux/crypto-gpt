/**
 * VARRE a Base e monta o BENCHMARK de arbitragens REAIS e lucrativas.
 *
 * Item 8 dela: *"Construa um benchmark reproduzível contendo operações
 * históricas bem-sucedidas de terceiros."*
 *
 * Saida: `.tmp/benchmarkDeArbitragem.json` — a lista auditavel, com bloco,
 * hash, pools, DEXs, lucro medido por saldo e custo lido do recibo. E dela que
 * o replay em fork parte, sem informacao do futuro.
 *
 * O TRANSPORTE e `eth_getBlockReceipts`, UM pedido por bloco, e a escolha e
 * medida: `eth_getLogs` no `mainnet.base.org` devolveu `request limit reached`
 * em 2026-10-15 ate para uma janela de DEZ blocos — e, como este CLAUDE.md
 * registra, isso e limite de rajada e nao prova nada sobre frequencia.
 * `eth_getBlockReceipts` nao tem limite de faixa, e traz de graca o que o
 * `eth_getLogs` nao traz: `gasUsed`, `effectiveGasPrice` e `l1Fee` de CADA
 * transacao. Um pedido por bloco entrega os logs E o custo real.
 */
import { ProxyAgent, fetch } from 'undici';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
    TOPICO_DE_SWAP, TOPICO_TRANSFER, candidatasDosLogs, deltasDosTransfers,
    quemLevouLucro, custoDoRecibo, liquidoEmWeth, comoLerACandidata,
    type Log, type Candidata,
} from './quemGanha';

const WETH = '0x4200000000000000000000000000000000000006';
const RPC = process.env.QG_RPC_URL ?? process.env.CACA_RPC_URL ?? 'https://mainnet.base.org';
const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;

let pedidos = 0;
async function chamar(metodo: string, params: unknown[]): Promise<unknown> {
    pedidos += 1;
    for (let tentativa = 0; tentativa < 4; tentativa += 1) {
        try {
            const r = await fetch(RPC, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: pedidos, method: metodo, params }),
                ...(agente ? { dispatcher: agente } : {}),
            });
            const j = await r.json() as { result?: unknown; error?: { message?: string } };
            if (j.error !== undefined) throw new Error(j.error.message ?? 'erro sem mensagem');
            return j.result;
        } catch (e) {
            if (tentativa === 3) throw e;
            await new Promise((s) => { setTimeout(s, 500 * 2 ** tentativa); });
        }
    }
    throw new Error('inalcançável');
}

async function principal(): Promise<void> {
    const topo = Number(await chamar('eth_blockNumber', []) as string);
    const quantos = Number(process.env.QG_BLOCOS ?? 300);
    const inicio = topo - quantos + 1;
    console.log(`topo ${topo} | varrendo ${quantos} bloco(s) por eth_getBlockReceipts`);

    interface Recibo {
        transactionHash: string;
        gasUsed: string;
        effectiveGasPrice?: string;
        l1Fee?: string;
        logs: Log[];
    }

    // 1. UM pedido por bloco: logs e custo juntos, sem limite de faixa.
    const logs: Log[] = [];
    const recibos = new Map<string, Recibo>();
    let blocosOk = 0;
    let blocosFalhos = 0;
    for (let b = inicio; b <= topo; b += 1) {
        try {
            const r = await chamar('eth_getBlockReceipts', [`0x${b.toString(16)}`]) as Recibo[];
            if (r === null) { blocosFalhos += 1; continue; }
            for (const rec of r) {
                recibos.set(rec.transactionHash, rec);
                for (const l of rec.logs ?? []) logs.push(l);
            }
            blocosOk += 1;
        } catch (e) {
            blocosFalhos += 1;
            if (blocosFalhos <= 3) {
                console.log(`  bloco ${b} FALHOU: ${String(e).slice(0, 70)}`);
            }
        }
    }
    const cobertura = blocosOk + blocosFalhos === 0
        ? 0 : (blocosOk / (blocosOk + blocosFalhos)) * 100;
    console.log(`${logs.length} log(s) | ${recibos.size} recibo(s) | cobertura `
        + `${cobertura.toFixed(1)}% (${blocosOk} ok, ${blocosFalhos} falhas)`);
    if (blocosFalhos > 0) {
        console.log('ATENCAO: cobertura abaixo de 100% — o resultado e PISO, nao total');
    }

    // 2. Candidatas: duas ou mais trocas atomicas.
    const candidatas = candidatasDosLogs(logs);
    console.log(`${candidatas.length} transacao(oes) com 2+ trocas atomicas`);

    // 3. Para cada candidata: os Transfer da transacao, o lucro e o custo.
    //    Orcamento: so as primeiras `QG_TETO`, porque cada uma custa 2 pedidos.
    const teto = Number(process.env.QG_TETO ?? 400);
    const pools = new Set(logs.map((l) => l.address.toLowerCase()));
    const achados: {
        tx: string; bloco: number; trocas: number; dexes: string[]; pools: string[];
        beneficiario: string; ganhoWeth: string | null; ganhos: { token: string; quanto: string }[];
        gasUsado: string; custoWei: string; liquidoWei: string | null;
    }[] = [];

    for (const c of candidatas.slice(0, teto)) {
        // SEM PEDIDO NOVO: o recibo ja veio com o bloco.
        const recibo = recibos.get(c.tx);
        if (recibo === undefined) continue;
        const custo = custoDoRecibo(recibo);
        if (custo === null) continue;
        const deltas = deltasDosTransfers(recibo.logs ?? []);
        const ganhos = quemLevouLucro(deltas, pools);
        if (ganhos.length === 0) continue;
        // O MAIOR ganho em WETH e o beneficiario mais provavel. Quando nenhum
        // ganho e em WETH, o lucro fica sem conversao e DECLARADO assim.
        let melhor: { g: typeof ganhos[number]; liq: bigint | null } | null = null;
        for (const g of ganhos) {
            const liq = liquidoEmWeth(g, custo.totalWei, WETH);
            if (melhor === null) { melhor = { g, liq }; continue; }
            if (liq !== null && (melhor.liq === null || liq > melhor.liq)) melhor = { g, liq };
        }
        if (melhor === null) continue;
        achados.push({
            tx: c.tx,
            bloco: c.bloco,
            trocas: c.trocas.length,
            dexes: c.dexes,
            pools: [...new Set(c.trocas.map((t) => t.pool))],
            beneficiario: melhor.g.endereco,
            ganhoWeth: melhor.g.ganhos.find((x) => x.token === WETH)?.quanto.toString() ?? null,
            ganhos: melhor.g.ganhos.map((x) => ({ token: x.token, quanto: x.quanto.toString() })),
            gasUsado: custo.gasUsado.toString(),
            custoWei: custo.totalWei.toString(),
            liquidoWei: melhor.liq === null ? null : melhor.liq.toString(),
        });
    }

    const lucrativas = achados.filter((a) => a.liquidoWei !== null && BigInt(a.liquidoWei) > 0n);
    lucrativas.sort((a, b) => (BigInt(b.liquidoWei!) > BigInt(a.liquidoWei!) ? 1 : -1));

    console.log(`\n${achados.length} com beneficiario identificavel`);
    console.log(`${lucrativas.length} LUCRATIVAS em WETH depois do custo real do recibo`);
    const semWeth = achados.filter((a) => a.ganhoWeth === null).length;
    console.log(`${semWeth} com ganho em token que NAO e WETH — sem preco, nao converto`);

    console.log('\nAS DEZ MAIORES (lucro liquido em WETH, custo do recibo descontado):');
    for (const a of lucrativas.slice(0, 10)) {
        const eth = Number(BigInt(a.liquidoWei!)) / 1e18;
        console.log(`  ${a.tx.slice(0, 12)}… bloco ${a.bloco} | ${a.trocas} trocas `
            + `[${a.dexes.join('+')}] | liquido ${eth.toFixed(8)} WETH | gas ${a.gasUsado}`
            + ` | ${a.beneficiario.slice(0, 10)}…`);
    }

    // POR DEX e POR NUMERO DE TROCAS: e disto que sai a decisao de universo.
    const porDex = new Map<string, number>();
    const porTrocas = new Map<number, number>();
    const porBeneficiario = new Map<string, number>();
    for (const a of lucrativas) {
        porDex.set(a.dexes.join('+'), (porDex.get(a.dexes.join('+')) ?? 0) + 1);
        porTrocas.set(a.trocas, (porTrocas.get(a.trocas) ?? 0) + 1);
        porBeneficiario.set(a.beneficiario, (porBeneficiario.get(a.beneficiario) ?? 0) + 1);
    }
    console.log('\nCOMBINACAO DE DEX das lucrativas:');
    for (const [d, n] of [...porDex.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${n}x  ${d}`);
    }
    console.log('NUMERO DE TROCAS das lucrativas:');
    for (const [t, n] of [...porTrocas.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`  ${n}x  ${t} trocas`);
    }
    console.log(`OPERADORES DISTINTOS: ${porBeneficiario.size}`);
    for (const [b, n] of [...porBeneficiario.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 5)) {
        console.log(`  ${n}x  ${b}`);
    }

    mkdirSync('.tmp', { recursive: true });
    const saida = {
        gerado: new Date().toISOString(),
        rpc: RPC.replace(/\/\/.*@/, '//'),
        topo,
        primeiroBloco: inicio,
        blocosVarridos: quantos,
        coberturaPct: Number(cobertura.toFixed(2)),
        logs: logs.length,
        candidatas: candidatas.length,
        examinadas: Math.min(candidatas.length, teto),
        comBeneficiario: achados.length,
        lucrativas: lucrativas.length,
        pedidosDeRpc: pedidos,
        operacoes: lucrativas,
    };
    writeFileSync('.tmp/benchmarkDeArbitragem.json', JSON.stringify(saida, null, 2));
    console.log(`\n${pedidos} pedido(s) de RPC | benchmark em .tmp/benchmarkDeArbitragem.json`);
}

if (process.env.ATIVAR_QUEMGANHA === '1') {
    void principal().catch((e) => {
        console.error('falhou:', e);
        process.exit(1);
    });
}

export { principal, chamar };
