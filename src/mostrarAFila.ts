// Arquivo: src/mostrarAFila.ts
//
// A FILA DE VERDADE, contra a Base de verdade, daqui — sem deploy.
//
//     npx tsx src/mostrarAFila.ts
//
// Existe por uma regra que a dona do bot escreveu em 2026-09-28 depois de
// servir de QA no Railway a tarde inteira: é PROIBIDO pedir deploy com base só
// em `npm test`. Teste unitário não pega ordem de leitura, não pega estado do
// modo prova, e não pega etiqueta que mente — os três defeitos daquele dia.
//
// Então esta ferramenta roda as FUNÇÕES REAIS do caçador — `repartirPorFragilidade`,
// `montarAlvos`, `oPrecoCancela`, `oQueUmaQuedaRenderia`, `codificarCacaV1/V2`,
// `lerRespostaDaCaca` — contra os dados reais, e imprime o mesmo JSON que o log
// do Railway imprimiria. O que ela lê aqui é o que vai acontecer lá.
//
// A ORDEM importa e é o ponto do arquivo: os pares (garantia/dívida) são
// descobertos ANTES de ordenar, ANTES de `maisPerto`, ANTES de `seOMercadoCair`
// e ANTES de escolher o alvo do ensaio.
import { ProxyAgent, fetch as uf } from 'undici';
import { Decimal } from 'decimal.js';
import { REDES } from './liquidacoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from './posicoes';
import { MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { enderecoDaResposta } from './reservas';
import { codificarUserReserveData, decodificarUserReserveData, ehLimiteDoProvedor } from './liquidar';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL } from './caca';
import { lucroEstimado, coberturaOtima } from './perdidas';
import {
    repartirPorFragilidade, oPrecoCancela, oQueUmaQuedaRenderia, oQueUmaAltaRenderia, comoLerAsQuedas,
    viaDeQuebra, contarVias, comoLerABussola, altaEquivalente,
    quantoPedirEmprestado, poolParaVender, pisoDoLucroEmUnidadesCruas,
    margemQueDecideORitmo, montarAlvos, tamanhosASondar, PEDACO_MINIMO, type Medida,
} from './cacarAoVivo';
import { POOLS } from './contratos';

const RPC = process.env.FILA_RPC ?? 'https://mainnet.base.org';
const POOL = REDES.base!.pool;
const V1 = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const V2 = '0xb91c634fb23934ED178b5116fCbFbF195B127F32';
const CONTA_BOT = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rid = 1;

async function rpc<T>(metodo: string, params: unknown[]): Promise<{ result?: T; error?: { message: string; data?: unknown } }> {
    let ultimo = '';
    for (let i = 0; i < 8; i++) {
        try {
            const r = await uf(RPC, { method: 'POST', dispatcher: agente,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method: metodo, params }) });
            const j = await r.json() as { result?: T; error?: { message: string; data?: unknown } };
            // Limite do provedor nao e resposta: e a rede pedindo espera.
            if (j.error && ehLimiteDoProvedor(j.error.message)) ultimo = j.error.message;
            else return j;
        } catch (e) { ultimo = (e as Error).message; }
        await dormir(1200 * (i + 1));
    }
    throw new Error(`${metodo}: ${ultimo}`);
}
const call = async (to: string, data: string): Promise<string> => {
    const r = await rpc<string>('eth_call', [{ to, data }, 'latest']);
    if (r.error) throw new Error(r.error.message);
    return r.result!;
};
const lote = async (cs: Array<{ alvo: string; dados: string }>) =>
    decodificarAggregate3(await call(MULTICALL3, codificarAggregate3(cs)));
const pal = (h: string, i: number) => BigInt('0x' + h.replace(/^0x/, '').slice(i * 64, (i + 1) * 64));
const end = (h: string, i: number) => '0x' + h.replace(/^0x/, '').slice(i * 64 + 24, (i + 1) * 64);
const j = (o: unknown) => JSON.stringify(o, null, 2);

/** O transporte que `montarAlvos` usa aqui: multicall em pedaços, com espera. */
async function lerParaMontar(cs: Array<{ alvo: string; dados: string }>): Promise<Array<string | null>> {
    const fora: Array<string | null> = [];
    for (const pedaco of partirEmPedacos(cs, 120)) {
        try {
            const rs = await lote(pedaco);
            for (let i = 0; i < pedaco.length; i++) fora.push(rs[i]?.ok ? rs[i]!.dados : null);
        } catch { for (let i = 0; i < pedaco.length; i++) fora.push(null); }
        await dormir(800);
    }
    return fora;
}

(async () => {
    const JANELAS = Number(process.env.FILA_JANELAS ?? '205');
    const topo = Number.parseInt((await rpc<string>('eth_blockNumber', [])).result!, 16);
    console.log(`\n=== A FILA DE VERDADE — bloco ${topo} da Base, ${new Date().toISOString()}\n`);

    const prov = enderecoDaResposta(await call(POOL, '0x0542975c'))!;
    const dataProvider = enderecoDaResposta(await call(prov, '0xe860accb'))!;
    const oraculo = enderecoDaResposta(await call(prov, '0xfca513a8'))!;
    const listaHex = await call(POOL, '0xd1946dbc');
    const moedas = Array.from({ length: Number(pal(listaHex, 1)) }, (_, i) => end(listaHex, 2 + i));

    // Preços, casas e símbolos das 15 reservas — num multicall, como o bot faz.
    const precos = new Map<string, Decimal>(), casas = new Map<string, number>();
    const simbolo = new Map<string, string>();
    for (const pedaco of partirEmPedacos(moedas, 5)) {
        const rs = await lote(pedaco.flatMap((m) => [
            { alvo: oraculo, dados: '0xb3596f07' + m.replace(/^0x/, '').padStart(64, '0') },
            { alvo: m, dados: '0x313ce567' },
            { alvo: m, dados: '0x95d89b41' },
        ]));
        pedaco.forEach((m, k) => {
            const [rp, rd, rsy] = [rs[k * 3], rs[k * 3 + 1], rs[k * 3 + 2]];
            if (rp?.ok) precos.set(m.toLowerCase(), new Decimal(pal(rp.dados, 0).toString()));
            if (rd?.ok) casas.set(m.toLowerCase(), Number(pal(rd.dados, 0)));
            simbolo.set(m.toLowerCase(), rsy?.ok
                ? Buffer.from(rsy.dados.replace(/^0x/, ''), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '').trim() || m.slice(0, 8)
                : m.slice(0, 8));
        });
        await dormir(900);
    }

    // 1. O universo de devedores. Cobertura DECLARADA, sempre.
    //
    // O TAMANHO DA JANELA É MEDIDO, NÃO CRAVADO.
    //
    // Era `2000`, o teto do `mainnet.base.org` medido em 02/10. Em 06/10 o mesmo
    // provedor passou a recusar acima de 500, e esta ferramenta devolveu 205 de
    // 205 janelas falhadas, cobertura 0,0% — e imprimiu a tabela inteira de
    // zeros embaixo disso, na ferramenta que existe para pegar exatamente esse
    // tipo de coisa antes do deploy.
    //
    // A escada de tamanhos vem de `tamanhosASondar`, a MESMA que o caçador usa:
    // duas cópias divergiriam no dia em que uma fosse corrigida.
    let JANELA = 0;
    for (const t of tamanhosASondar(10000, PEDACO_MINIMO)) {
        try {
            const r = await rpc<Array<{ topics: string[] }>>('eth_getLogs', [{
                address: POOL, fromBlock: `0x${(topo - t + 1).toString(16)}`, toBlock: `0x${topo.toString(16)}`,
                topics: [TOPIC_BORROW],
            }]);
            if (!r.error) { JANELA = t; break; }
        } catch { /* próximo tamanho */ }
        await dormir(200);
    }
    if (JANELA === 0) {
        console.log('\nPAREI: nenhum tamanho de janela foi aceito por este RPC, nem o menor.');
        console.log('Sem universo de devedores não há fila, e publicar zeros seria inventar uma medição.');
        return;
    }
    console.log(`JANELA MEDIDA: ${JANELA} blocos por eth_getLogs neste RPC`);
    const vistos = new Set<string>();
    let falharam = 0;
    for (let i = 0; i < JANELAS; i++) {
        const ate = topo - i * JANELA;
        try {
            const r = await rpc<Array<{ topics: string[] }>>('eth_getLogs', [{
                address: POOL, fromBlock: `0x${(ate - JANELA + 1).toString(16)}`, toBlock: `0x${ate.toString(16)}`,
                topics: [TOPIC_BORROW],
            }]);
            if (r.error) { falharam++; } else for (const d of devedoresDosEventos(r.result!)) vistos.add(d.toLowerCase());
        } catch { falharam++; }
        if (i % 40 === 39) process.stderr.write(`.${vistos.size}`);
        await dormir(150);
    }
    if (falharam === JANELAS) {
        // O defeito que esta ferramenta cometeu em 06/10: declarou cobertura
        // 0,0% e, logo abaixo, imprimiu `1%: 0 alcanço` como se fosse resposta.
        // Cobertura zero não é "não há ninguém", é "não perguntei".
        console.log(`\nPAREI: TODAS as ${JANELAS} janelas falharam. Cobertura 0%.`);
        console.log('Isto NÃO quer dizer que a fila está vazia — quer dizer que eu não consegui perguntar.');
        return;
    }
    const devedores = [...vistos];
    console.log(`UNIVERSO: ${devedores.length} devedores em ${JANELAS} janelas de ${JANELA} blocos `
        + `(~${(JANELAS * JANELA * 2 / 86400).toFixed(1)} dias). Janelas que falharam: ${falharam}. `
        + `Cobertura das janelas: ${(((JANELAS - falharam) / JANELAS) * 100).toFixed(1)}%\n`);

    // 2. A saúde de cada um — `Medida[]`, exatamente como o caçador monta.
    const medidos: Medida[] = [];
    let lidos = 0;
    for (const pedaco of partirEmPedacos(devedores, 150)) {
        try {
            const rs = await lote(pedaco.map((d) => ({
                alvo: POOL, dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
            })));
            pedaco.forEach((d, k) => {
                if (!rs[k]?.ok) return;
                lidos++;
                try {
                    const c = decodificarContaDoUsuario(rs[k]!.dados);
                    const q = quedaAteLiquidar(c.saude);
                    if (q !== null) medidos.push({ devedor: d, queda: q, dividaUsd: c.dividaBase.dividedBy(1e8) });
                } catch { /* registro estranho nao derruba a leitura */ }
            });
        } catch { /* declarado na cobertura */ }
        await dormir(1400);
    }
    console.log(`SAÚDE LIDA: ${lidos} de ${devedores.length} (${((lidos / devedores.length) * 100).toFixed(1)}%), `
        + `${medidos.length} com dívida viva\n`);

    // 3. OS PARES, ANTES DE ORDENAR. É este o conserto.
    // OS MESMOS BOTOES DO CACADOR, e nao botoes proprios.
    //
    // Esta ferramenta existe para conferir producao, e em 2026-09-28 ela rodou
    // com `margemQuente = 15` enquanto o cacador usava 25 — publicou
    // `naListaQuente: 35` contra os 323 do Railway. Um numero meu que nao confere
    // com producao, na ferramenta que existe para conferir com producao.
    //
    // Aconteceu de novo em 2026-09-30: o cacador passou a resolver pares SEM
    // corte de queda e 600 por varredura, e esta ferramenta continuou em 10% e
    // 150 — mostrando 3.223 desconhecidos e fazendo o conserto parecer que nao
    // funcionou. `FILA_*` fica como atalho para rodar rapido, mas o PADRAO agora
    // e o do cacador.
    const ATE = Number(process.env.FILA_ATE_QUEDA
        ?? process.env.CACA_PARES_ATE_QUEDA_PCT ?? String(Number.POSITIVE_INFINITY));
    const TETO = Number(process.env.FILA_PARES ?? process.env.CACA_PARES_A_RESOLVER ?? '600');
    const candidatos = medidos
        .filter((m) => m.queda.lessThanOrEqualTo(ATE))
        .sort((a, b) => a.queda.comparedTo(b.queda))
        .slice(0, TETO);
    const pares = new Map<string, { garantia: string; divida: string }>();
    for (const pedaco of partirEmPedacos(candidatos.map((m) => m.devedor), 25)) {
        const montados = await montarAlvos(pedaco, moedas, dataProvider, precos, casas, lerParaMontar);
        for (const a of montados) pares.set(a.devedor.toLowerCase(), { garantia: a.garantia, divida: a.divida });
        await dormir(900);
    }
    for (const m of medidos) {
        const p = pares.get(m.devedor.toLowerCase());
        m.via = p === undefined ? undefined : viaDeQuebra(p.garantia, p.divida);
    }
    console.log(`PARES RESOLVIDOS: ${pares.size} de ${candidatos.length} candidatos (queda <= ${ATE}%).`);
    console.log(`BUSSOLA: ${comoLerABussola(contarVias(medidos))}\n`);

    // 4. As camadas, com as funções reais.
    const piso = new Decimal(process.env.FILA_PISO ?? '0.5');
    // A MESMA margem quente do caçador (CACA_MARGEM_QUENTE, padrão 25). Rodar
    // com 15 aqui fez esta ferramenta publicar `naListaQuente: 35` contra os
    // `323` do Railway — um número meu que não confere com produção, na
    // ferramenta que existe para conferir com produção.
    const MARGEM_QUENTE = Number(process.env.CACA_MARGEM_QUENTE ?? '25');
    const camadas = repartirPorFragilidade(medidos, 233, MARGEM_QUENTE, piso, 0);
    const tabela = comoLerAsQuedas(oQueUmaQuedaRenderia(medidos, [1, 2, 3, 5, 10]));
    const tabelaAlta = comoLerAsQuedas(oQueUmaAltaRenderia(medidos, [1, 2, 3, 5, 10]));

    console.log('=== O QUE O LOG IMPRIMIRIA ===');
    console.log(j({
        naBrasa: camadas.brasa.length,
        naListaQuente: camadas.quentes.length,
        valemUmTiro: `${camadas.valemUmTiro} de ${medidos.length} — ${camadas.poEmDemasia} devem menos de US$ ${piso.toFixed(2)}`,
        maisPerto: camadas.menorMargemDaBrasa === null ? 'ninguém' : `precisa cair ${camadas.menorMargemDaBrasa.toFixed(4)}%`,
        maisFragilA: margemQueDecideORitmo(camadas, true)?.toFixed(4) + '%',
        seOMercadoCair: tabela,
        seADividaSubir: tabelaAlta,
        bussola: comoLerABussola(contarVias(medidos)),
    }));

    // 5. O NÚMERO 1 DA FILA, e ele tem de ser sensível a preço.
    const primeiro = camadas.brasa[0];
    if (!primeiro) { console.log('\nFila vazia.'); return; }
    const par = pares.get(primeiro.toLowerCase());
    const m1 = medidos.find((m) => m.devedor === primeiro)!;
    console.log('\n=== O NÚMERO 1 DA FILA ===');
    console.log(j({
        devedor: primeiro,
        garantia: par ? `${simbolo.get(par.garantia.toLowerCase())} (${par.garantia})` : 'não resolvido',
        divida: par ? `${simbolo.get(par.divida.toLowerCase())} (${par.divida})` : 'não resolvido',
        via: m1.via ?? 'não resolvido',
        familiasDiferentes: par ? !oPrecoCancela(par.garantia, par.divida) : null,
        precisaCair: `${m1.queda.toFixed(4)}%` + (m1.via === 'short' ? ' (INALCANÇÁVEL: a garantia é estável)' : ''),
        ouADividaSubir: `${altaEquivalente(m1.queda)?.toFixed(4) ?? '?'}%`,
        dividaUsd: `US$ ${m1.dividaUsd?.toFixed(2) ?? '?'}`,
        lucroEstimado: `US$ ${lucroEstimado(m1.dividaUsd ?? new Decimal(0)).toFixed(2)}`,
    }));

    // 6. O [EM SECO] DE VERDADE nesse alvo, com V1 e V2.
    if (!par) return;
    const montado = (await montarAlvos([primeiro], moedas, dataProvider, precos, casas, lerParaMontar))[0];
    if (!montado) { console.log('\nNão consegui montar o alvo.'); return; }
    const quantoCobrir = quantoPedirEmprestado(montado.dividaCrua!, montado.dividaUsd, coberturaOtima());
    const poolDeVenda = poolParaVender(montado, POOLS.aerodrome.endereco);

    const emSeco: Record<string, unknown> = {
        alvo: primeiro,
        montarAlvos: `garantia ${montado.garantia} / dívida ${montado.divida}`,
        simbolos: `${simbolo.get(montado.garantia.toLowerCase())} contra ${simbolo.get(montado.divida.toLowerCase())}`,
        pediriaEmprestado: quantoCobrir.toString(),
        poolDeVenda,
        margemDoAlvo: `precisa cair ${m1.queda.toFixed(4)}% para virar alvo`,
    };
    for (const [nome, endereco, tipo] of [['V1', V1, 'V1'], ['V2', V2, 'V2']] as const) {
        // O V2 vai com o piso da DECISÃO, nunca com o impossível: ele repassa o
        // piso ao router da Aerodrome, que recusa antes de executar.
        const pisoV2 = pisoDoLucroEmUnidadesCruas(montado, new Decimal(0));
        const dados = tipo === 'V1'
            ? codificarCacaV1({ garantia: montado.garantia, divida: montado.divida, devedor: primeiro,
                quantoCobrir, poolDeVenda, lucroMinimo: PISO_IMPOSSIVEL })
            : codificarCacaV2({ garantia: montado.garantia, divida: montado.divida, devedor: primeiro,
                quantoCobrir, isStablePool: false, lucroMinimo: pisoV2 });
        const r = await rpc<string>('eth_call', [{ from: CONTA_BOT, to: endereco, data: dados }, 'latest']);
        const cru = typeof r.error?.data === 'string' ? r.error.data
            : (r.error?.data as { data?: string } | undefined)?.data ?? '0x';
        const leitura = tipo === 'V2' && r.error === undefined
            ? { desfecho: 'mediu' as const, lucroCru: pisoV2, erro: undefined, dadosCrus: undefined }
            : lerRespostaDaCaca({ ok: r.error === undefined, dados: cru, mensagem: r.error?.message });
        emSeco[`medicao${nome}`] = leitura.desfecho === 'mediu'
            ? `mediu, lucro cru ${leitura.lucroCru}`
            : `${leitura.desfecho}: ${leitura.erro} ${cru.slice(0, 10)}`;
        await dormir(900);
    }
    console.log('\n=== O [EM SECO] DE VERDADE ===');
    console.log(j(emSeco));
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
