// Arquivo: src/olharAgora.ts
//
// Le a Base AGORA e mostra os alvos vigiados, com o quanto andaram desde a
// ultima olhada. Roda daqui, sem deploy, desde que a rede esteja liberada.
//
//     npx tsx src/olharAgora.ts            olha os alvos guardados
//     npx tsx src/olharAgora.ts --varrer   refaz a lista varrendo a Base
import { ProxyAgent, fetch as uf } from 'undici';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Decimal } from 'decimal.js';
import { REDES } from './liquidacoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from './posicoes';
import { MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { lucroEstimado } from './perdidas';
import { faixaQueAtira, politicaDoTiro, comoLerAPolitica } from './prontidao';
import { compararLeituras, naoForamLidos, leituraDeAgora, comoLerOMovimento, resumir, comoLerACobertura, type Alvo, type Leitura } from './olhoNosAlvos';

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

/**
 * Todo devedor que eu JA conheco, de qualquer leitura guardada em `.olho/`.
 *
 * A varredura so acha quem pediu emprestado DENTRO da janela (~7,4 dias no
 * padrao). Quem pegou o emprestimo antes disso nao emite evento nenhum agora e
 * fica invisivel. Em 2026-09-27 isso apagou os dois alvos que mais importam:
 * `0x9ff24fd4` a 1,1551% e a baleia `0x67d0938f` a 2,1251% com US$ 1,93M de
 * divida — as duas confirmadas vivas por `eth_call` direto no mesmo minuto em
 * que a varredura dizia ter lido 100%.
 *
 * Ler de novo quem eu ja vi custa um lugar num multicall de 150. E barato, e e
 * a diferenca entre a lista certa e uma lista que perde a baleia.
 */
function sementes(pasta: string): string[] {
    const vistos = new Set<string>();
    if (!existsSync(pasta)) return [];
    for (const nome of readdirSync(pasta)) {
        if (!nome.endsWith('.json')) continue;
        try {
            const j = JSON.parse(readFileSync(`${pasta}/${nome}`, 'utf8')) as { alvos?: Array<{ devedor?: string }> };
            for (const a of j.alvos ?? []) if (a.devedor) vistos.add(a.devedor.toLowerCase());
        } catch { /* um arquivo estragado nao derruba a leitura */ }
    }
    return [...vistos];
}

/** Varre a Base atras de quem esta perto de cair. Declara a cobertura. */
async function varrer(topo: number, ateQuedaPct: number, semente: string[]): Promise<
    { alvos: Alvo[]; lidos: number; daJanela: number; daMemoria: number; blocos: number;
      janelas: number; janelasQueFalharam: number }> {
    // O RPC publico recusa eth_getLogs acima de 2.000 blocos. Medido.
    const JANELA = 2_000, QUANTAS = Number(process.env.OLHO_JANELAS ?? '160');
    // Contadas, nao engolidas: uma varredura que falhou inteira dizia 100%.
    let falharam = 0;
    const vistos = new Set<string>();
    for (let i = 0; i < QUANTAS; i++) {
        const ate = topo - i * JANELA;
        try {
            const logs = await rpc<Array<{ topics: string[] }>>('eth_getLogs', [{
                address: POOL, fromBlock: `0x${(ate - JANELA + 1).toString(16)}`, toBlock: `0x${ate.toString(16)}`,
                topics: [TOPIC_BORROW],
            }]);
            for (const d of devedoresDosEventos(logs)) vistos.add(d.toLowerCase());
        } catch { falharam++; }
        if (i % 40 === 39) process.stderr.write(`.${vistos.size}`);
        await dormir(150);
    }
    const daJanela = vistos.size;
    // A memoria entra no universo, nunca o substitui: um alvo conhecido que a
    // janela nao acha continua sendo lido.
    for (const d of semente) vistos.add(d.toLowerCase());
    const lista = [...vistos];
    // Os SEMEADOS sao lidos SEM o corte de distancia. `lerContas` so devolve quem
    // esta dentro de `ateQuedaPct`, e o arquivo e reescrito so com o que voltou:
    // a baleia semeada justamente porque a janela de `Borrow` nao a enxerga sumia
    // da memoria na primeira vez que ficasse a 5,1%, e a varredura seguinte voltava
    // ao estado que a semente existe para evitar. Filtrar depois nao resolvia,
    // porque ela nunca chegava a estar na lista.
    const conhecidos = new Set(semente.map((d) => d.toLowerCase()));
    const novos = lista.filter((d) => !conhecidos.has(d));
    const deSemente = lista.filter((d) => conhecidos.has(d));
    const a = await lerContas(novos, ateQuedaPct);
    const b = deSemente.length > 0 ? await lerContas(deSemente, 1e9) : { alvos: [], lidos: 0 };
    const alvos = [...a.alvos, ...b.alvos];
    const lidos = a.lidos + b.lidos;
    return { alvos, lidos, daJanela, daMemoria: lista.length - daJanela, blocos: JANELA * QUANTAS,
        janelas: QUANTAS, janelasQueFalharam: falharam };
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
    let alvos: Alvo[], lidos: number, daJanela: number, daMemoria: number, blocos: number;
    let janelas = 0, janelasQueFalharam = 0;
    if (varreu || antes === null) {
        ({ alvos, lidos, daJanela, daMemoria, blocos, janelas, janelasQueFalharam } =
            await varrer(topo, ATE, sementes(dirname(ONDE))));
    } else {
        // Releitura: a lista guardada AQUI mais tudo que outras leituras viram.
        const lista = [...new Set([...antes.alvos.map((a) => a.devedor.toLowerCase()), ...sementes(dirname(ONDE))])];
        // Sem filtro de distancia na releitura: um alvo vigiado que se afastou
        // tem de aparecer "afastou", nunca desaparecer em silencio.
        ({ alvos, lidos } = await lerContas(lista, 1e9));
        daJanela = 0; daMemoria = lista.length; blocos = 0;
    }

    const agora: Leitura = { em: Date.now(), alvos };
    console.log(`\nbloco ${topo}  |  ${comoLerACobertura({
        lidos, daJanela, daMemoria, blocos, janelas, janelasQueFalharam })}`);

    // A MESMA politica do cacador, dos MESMOS nomes de ambiente. Passar cinco
    // campos dos nove fez esta ferramenta publicar "faixa do bot: até US$ 66,78"
    // enquanto o bot dizia US$ 45,80 — e com isso ela chamou de "o melhor que ele
    // atira hoje" um alvo que o bot recusa.
    const politica = politicaDoTiro();
    const faixa = faixaQueAtira({
        precoDoEthUsd: new Decimal(process.env.OLHO_ETH ?? '2690'),
        saldoWei: BigInt(process.env.OLHO_SALDO_WEI ?? '3341111000000000'),
        baseFeeWei: BigInt(process.env.OLHO_BASEFEE_WEI ?? '20000000'),
        ...politica,
        tiroDeProva: process.env.CACA_TIRO_DE_PROVA === '1',
    });
    // Daqui nao se ve o ambiente do Railway. Entao a faixa sai com os botoes ao
    // lado, para ela poder comparar com o log em vez de acreditar.
    const teto = faixa?.ate ?? null;
    console.log(`faixa calculada AQUI: até ${teto === null ? 'SEM TETO' : `US$ ${teto.toFixed(2)}`}`);
    console.log(`  com: ${comoLerAPolitica(politica)}`);
    console.log('  >>> confira com o `atiroNaFaixaDe` do log: se não bater, o Railway tem outros valores\n');

    // UMA lista para os dois: montar `vivos` aqui e passar so eles matava o
    // ramo `saiu` de `compararLeituras` e jogava quem pagou a divida em
    // `naoForamLidos`, que anuncia o contrario. Ver `leituraDeAgora`.
    const lidosAgora = leituraDeAgora(agora.em, alvos);
    const vivos = lidosAgora.alvos.filter((a) => a.queda !== null);
    const movs = compararLeituras(antes, lidosAgora);
    for (const m of movs) {
        const alvo = m.tipo === 'saiu' ? null : m.alvo;
        const dentro = alvo && alvo.lucroUsd.greaterThan(0) && (teto === null || alvo.lucroUsd.lessThanOrEqualTo(teto));
        console.log(`${dentro ? '>> ATIRA  ' : '   fora   '}${comoLerOMovimento(m)}`);
    }
    const faltaram = naoForamLidos(antes, lidosAgora);
    if (faltaram.length > 0) console.log(`\n${faltaram.length} não foram lidos agora (NÃO quer dizer que sumiram): ${faltaram.slice(0, 5).map((d) => d.slice(0, 10) + '…').join(', ')}`);

    // O resumo, porque a lista ordenada por PROXIMIDADE enterra a resposta:
    // o alvo de R$ 359 e o de 12 centavos saem com a mesma marca, a seis
    // linhas de distancia.
    const BRL = Number(process.env.OLHO_BRL ?? '5.4');
    const r = resumir(vivos, teto);
    const emReais = (d: Decimal) => `R$ ${d.mul(BRL).toFixed(0)}`;
    console.log('\n--- RESUMO ---');
    if (r.naFaixa.length === 0) {
        console.log('O bot não atiraria em NENHUM destes hoje.');
    } else {
        const m = r.naFaixa[0]!;
        console.log(`MELHOR que ele atira hoje: ${m.devedor.slice(0, 10)}… vale US$ ${m.lucroUsd.toFixed(2)} (${emReais(m.lucroUsd)}), precisa cair ${m.queda!.toFixed(3)}%`);
        console.log(`Na faixa: ${r.naFaixa.length} alvos somando US$ ${r.somaNaFaixa.toFixed(2)} (${emReais(r.somaNaFaixa)}) — mas cai UM por vez`);
    }
    if (r.melhorForaDaFaixa) {
        const f = r.melhorForaDaFaixa;
        console.log(`FORA do alcance, o maior: ${f.devedor.slice(0, 10)}… vale US$ ${f.lucroUsd.toFixed(2)} (${emReais(f.lucroUsd)}) a ${f.queda!.toFixed(3)}%`);
        console.log(`  para alcançar esse, o teto teria de ir de ${teto === null ? 'sem teto' : `US$ ${teto.toFixed(2)}`} para US$ ${f.lucroUsd.toFixed(2)}`);
    }

    // A MEMORIA nao pode ser apagada pelo filtro de distancia. `varrer` le os
    // semeados com o corte de OLHO_ATE_PCT, e depois so os sobreviventes eram
    // gravados — no unico arquivo que `sementes()` tem para ler. Resultado: a
    // baleia `0x67d0938f`, semeada justamente porque a janela de `Borrow` nao a
    // enxerga, sumia da memoria na primeira vez que ficasse a 5,1%, e a proxima
    // varredura voltava ao estado que a semente existe para evitar.
    //
    // Entao quem ja foi semeado continua guardado, mesmo fora do corte.
    const jaConhecidos = new Set(sementes(dirname(ONDE)));
    const guardar = [
        ...vivos,
        ...alvos.filter((a) => !vivos.includes(a) && jaConhecidos.has(a.devedor.toLowerCase())),
    ];
    const foraDoCorte = guardar.length - vivos.length;
    mkdirSync(dirname(ONDE), { recursive: true });
    writeFileSync(ONDE, JSON.stringify({ em: agora.em, alvos: guardar.map((a) => ({
        devedor: a.devedor, queda: a.queda?.toString() ?? null, dividaUsd: a.dividaUsd.toString(), lucroUsd: a.lucroUsd.toString(),
    })) }, null, 1));
    console.log(`\n${guardar.length} alvos guardados em ${ONDE}`
        + `${foraDoCorte > 0 ? ` (${foraDoCorte} mantidos porque já eram conhecidos)` : ''}`
        + '. Rode de novo para ver o quanto andaram.');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
