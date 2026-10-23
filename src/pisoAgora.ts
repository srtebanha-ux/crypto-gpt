// Arquivo: src/pisoAgora.ts
//
// Para cada alvo guardado pelo `olharAgora`, ate onde o PRECO consegue derrubar
// a saude — e, para varios deles, a resposta e "nao consegue".
//
//     npx tsx src/pisoAgora.ts
//
// Existe porque o bot publica "precisa cair X%" para TODO alvo, e esse numero
// vem de `quedaAteLiquidar`, que responde "quanto a garantia pode cair com a
// divida parada". Quando a divida esta na MESMA moeda da garantia, os dois
// lados caem juntos e o preco se cancela: a queda pedida nunca chega, por
// preco nenhum. Ver `src/pisoDaSaude.ts` para a conta.
//
// Medido em 2026-09-28, cobertura 100% (35 de 35 alvos vivos):
//
//     8 IMUNES a preco, somando US$ 462,47 de "lucro" que o preco nao entrega
//     27 derrubaveis
//
// Dentro do teto de tiro de US$ 66,78, dos 15 alvos da faixa:
//
//     4 NUNCA caem por preco       US$ 136,71
//     3 so num extremo de preco    US$  51,77   (piso entre 0,85 e 1)
//     8 caem por preco de verdade  US$ 161,85
//
// DUAS ARMADILHAS de leitura, e as duas cortam para lados opostos:
//
// 1. O piso e um limite INFERIOR, porque supoe precos independentes. Para par
//    da mesma familia — cbETH contra WETH, wstETH contra WETH, syrupUSDC contra
//    USDC — ele sai ZERO e esta formalmente certo, mas no mundo real aquele par
//    so se descola num evento de depeg. A baleia `0x67d0938f` (US$ 1,9M de
//    divida em WETH contra cbETH) aparece como "cai" e na pratica esta muito
//    mais perto de imune. Entao: piso >= 1 e conclusao; piso 0 NAO e promessa
//    de que o preco chega la.
//
// 2. E o preco nao e a unica causa. Medido no mesmo dia: `0x43ec917e`, que e
//    USDC contra USDC e portanto IMUNE, andou 2,41 pontos de saude em 70
//    minutos. O juro explicaria 0,000266% — nove mil vezes menos. O dono sacou
//    US$ 400 de garantia e pagou US$ 50 de divida. Posicao imune a preco ainda
//    atravessa quando o DONO mexe, e isso acontece num bloco so.
import { ProxyAgent, fetch as uf } from 'undici';
import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { REDES } from './liquidacoes';
import { codificarUserReserveData, decodificarUserReserveData } from './liquidar';
import { enderecoDaResposta } from './reservas';
import { MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { pisoDaSaudePorPreco, limiaresConferem, type ParteDaPosicao } from './pisoDaSaude';

const RPC = 'https://mainnet.base.org';
const POOL = REDES.base!.pool;
const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
let id = 1;
async function rpc<T>(m: string, p: unknown[]): Promise<T> {
    let ultimo = '';
    for (let i = 0; i < 7; i++) {
        try {
            const r = await uf(RPC, { method: 'POST', dispatcher: agente, headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: m, params: p }) });
            const j = await r.json() as { result?: T; error?: { message: string } };
            if (!j.error) return j.result as T;
            ultimo = j.error.message;
        } catch (e) { ultimo = (e as Error).message; }
        await dormir(800 * (i + 1));
    }
    throw new Error(`${m}: ${ultimo}`);
}
const call = (to: string, data: string) => rpc<string>('eth_call', [{ to, data }, 'latest']);
const lote = async (cs: Array<{ alvo: string; dados: string }>) =>
    decodificarAggregate3(await call(MULTICALL3, codificarAggregate3(cs)));
const pal = (hex: string, i: number) => BigInt('0x' + hex.replace(/^0x/, '').slice(i * 64, (i + 1) * 64));
const end = (hex: string, i: number) => '0x' + hex.replace(/^0x/, '').slice(i * 64 + 24, (i + 1) * 64);

(async () => {
    const alvos = (JSON.parse(readFileSync(process.env.OLHO_ARQUIVO ?? '.olho/alvos.json', 'utf8')) as
        { alvos: Array<{ devedor: string; queda: string | null; lucroUsd: string }> }).alvos;

    const prov = enderecoDaResposta(await call(POOL, '0x0542975c'))!;
    const dataProvider = enderecoDaResposta(await call(prov, '0xe860accb'))!;
    const oraculo = enderecoDaResposta(await call(prov, '0xfca513a8'))!;
    const listaHex = await call(POOL, '0xd1946dbc');
    const n = Number(pal(listaHex, 1));
    const moedas = Array.from({ length: n }, (_, i) => end(listaHex, 2 + i));

    // precos, casas, limiar BASE de cada moeda
    const precos = new Map<string, Decimal>(), casas = new Map<string, number>();
    const ltBase = new Map<string, Decimal>(), simbolo = new Map<string, string>();
    for (const pedaco of partirEmPedacos(moedas, 5)) {
        const rs = await lote(pedaco.flatMap((m) => [
            { alvo: oraculo, dados: '0xb3596f07' + m.replace(/^0x/, '').padStart(64, '0') },
            { alvo: dataProvider, dados: '0x3e150141' + m.replace(/^0x/, '').padStart(64, '0') },
            { alvo: m, dados: '0x95d89b41' },
        ]));
        pedaco.forEach((m, k) => {
            const [p, cfg, sym] = [rs[k * 3], rs[k * 3 + 1], rs[k * 3 + 2]];
            if (p?.ok) precos.set(m.toLowerCase(), new Decimal(pal(p.dados, 0).toString()));
            if (cfg?.ok) {
                casas.set(m.toLowerCase(), Number(pal(cfg.dados, 0)));
                ltBase.set(m.toLowerCase(), new Decimal(pal(cfg.dados, 2).toString()).div(10000));
            }
            simbolo.set(m.toLowerCase(), sym?.ok
                ? Buffer.from(sym.dados.replace(/^0x/, ''), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '').trim() || m.slice(0, 8)
                : m.slice(0, 8));
        });
        await dormir(400);
    }

    // limiares dos E-Modes usados
    const ltEmode = new Map<number, Decimal>();
    for (let cat = 1; cat <= 16; cat++) {
        try {
            const r = await call(POOL, '0x6c6f6ae1' + cat.toString(16).padStart(64, '0'));
            const lt = new Decimal(pal(r, 2).toString()).div(10000);
            if (lt.greaterThan(0)) ltEmode.set(cat, lt);
        } catch { /* categoria inexistente */ }
        await dormir(200);
    }
    console.log('E-Modes:', [...ltEmode].map(([k, v]) => `${k}=${v.mul(100).toFixed(0)}%`).join(' ') || 'nenhum');

    let imunes = 0, derrubaveis = 0, semMedir = 0, imunesComLucro = new Decimal(0);
    const linhas: string[] = [];

    for (const a of alvos) {
        if (a.queda === null) continue;
        const d = a.devedor;
        try {
            const conta = await call(POOL, '0xbf92857c' + d.replace(/^0x/, '').padStart(64, '0'));
            const ltMisturado = new Decimal(pal(conta, 3).toString()).div(10000);
            const saude = new Decimal(pal(conta, 5).toString()).div('1e18');
            const emode = Number(pal(await call(POOL, '0xeddf1b79' + d.replace(/^0x/, '').padStart(64, '0')), 0));

            const partes: Array<ParteDaPosicao & { crua: boolean }> = [];
            for (const pedaco of partirEmPedacos(moedas, 8)) {
                const rs = await lote(pedaco.map((m) => ({ alvo: dataProvider, dados: codificarUserReserveData(m, d) })));
                pedaco.forEach((m, k) => {
                    if (!rs[k]?.ok) return;
                    const u = decodificarUserReserveData(rs[k]!.dados);
                    if (u.garantiaCrua === 0n && u.dividaCrua === 0n) return;
                    const key = m.toLowerCase();
                    const pr = precos.get(key), dc = casas.get(key);
                    if (pr === undefined || dc === undefined) return;
                    const usd = (c: bigint) => new Decimal(c.toString()).div(new Decimal(10).pow(dc)).mul(pr).div(1e8);
                    partes.push({
                        ativo: simbolo.get(key)!, crua: true,
                        garantiaUsd: u.usadaComoGarantia ? usd(u.garantiaCrua) : new Decimal(0),
                        dividaUsd: usd(u.dividaCrua),
                        limiar: ltBase.get(key) ?? new Decimal(0),
                    });
                });
                await dormir(350);
            }
            if (partes.length === 0) { semMedir++; continue; }

            // Qual combinacao de limiares (base ou E-Mode) reproduz o numero da
            // Aave? Nao modelo as regras do E-Mode: testo e confiro.
            const ltE = ltEmode.get(emode);
            const comGarantia = partes.filter((p) => p.garantiaUsd.greaterThan(0));
            let escolhida: ParteDaPosicao[] | null = null;
            const combos = ltE === undefined ? 1 : 1 << comGarantia.length;
            for (let mask = 0; mask < combos && escolhida === null; mask++) {
                const tentativa = partes.map((p) => {
                    const i = comGarantia.indexOf(p as never);
                    return i >= 0 && (mask >> i) & 1 ? { ...p, limiar: ltE! } : p;
                });
                if (limiaresConferem(tentativa, ltMisturado).confere) escolhida = tentativa;
            }
            if (escolhida === null) {
                semMedir++;
                linhas.push(`  ? ${d.slice(0, 10)}…  não deu para medir (limiar da Aave ${ltMisturado.mul(100).toFixed(2)}%, E-Mode ${emode})`);
                continue;
            }

            const r = pisoDaSaudePorPreco(escolhida);
            const lucro = new Decimal(a.lucroUsd);
            const marca = r.imuneAPreco ? 'IMUNE' : 'cai  ';
            if (r.imuneAPreco) { imunes++; imunesComLucro = imunesComLucro.plus(lucro.greaterThan(0) ? lucro : 0); } else derrubaveis++;
            linhas.push(`  ${marca} ${d.slice(0, 10)}…  saúde ${saude.toFixed(6)}  piso ${r.piso === null ? '—' : r.piso.toFixed(6)}`
                + `  diz "precisa cair ${new Decimal(a.queda).toFixed(3)}%"  vale US$ ${lucro.toFixed(2)}`
                + `  [${escolhida.map((p) => `${p.ativo} g${p.garantiaUsd.toFixed(2)}/d${p.dividaUsd.toFixed(2)}`).join(' ')}]`);
        } catch (e) {
            semMedir++;
            linhas.push(`  ! ${d.slice(0, 10)}…  falhou: ${(e as Error).message.slice(0, 60)}`);
        }
    }

    console.log(linhas.sort().join('\n'));
    const total = imunes + derrubaveis + semMedir;
    console.log(`\n=== ${imunes} IMUNES a preço, ${derrubaveis} derrubáveis, ${semMedir} não medidos, de ${total} alvos vivos`);
    console.log(`=== os imunes somam US$ ${imunesComLucro.toFixed(2)} de "lucro" que o preço nunca entrega`);
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
