// Arquivo: src/acharPool.ts
//
// Varre a Base atrás dos pools de verdade e diz qual serve para vender.
//
// *** MODO LEITURA. NENHUMA TRANSAÇÃO É ENVIADA. NENHUM GÁS É GASTO. ***
//
// Por que um programa e não um endereço copiado de um site: este é o único
// ponto do projeto onde errar não reverte. A Aave recusa pedido malformado e o
// contrato reverte abaixo do piso, mas um endereço que não é pool ACEITA a
// transferência e some com o dinheiro. Endereço de site é endereço de memória
// de outra pessoa — aqui só vale o que a rede confirmou.
//
// A varredura procura `Sync`, que todo pool de produto constante emite a cada
// troca. Quem emitiu, é. E o tipo do evento separa as famílias sozinho, o que
// importa porque o contrato lê `getReserves()` no formato do Uniswap V2.
import { Decimal } from 'decimal.js';
import { id } from 'ethers';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import { ehLimiteDoProvedor } from './liquidar';
import { REDES, RPCS_PARA_TENTAR, faixasDeBlocos, SELETOR_GET_RESERVES_LIST, decodificarListaDeEnderecos } from './liquidacoes';
import { CHAMADAS_POR_MULTICALL, MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { SELECTORS, decodeAddressWord, decodeReserves, decodeDecimals } from './evmAbi';
import {
    TOPICO_DA_FAMILIA,
    contarAtividade,
    ordenarPorAtividade,
    escolherPoolDeVenda,
    emUnidades,
    profundidadeEmDolar,
    type Familia,
    type Pool,
    type LogDeSync,
} from './pools';
import { poolNecessarioPara, perdaNaVenda } from './venda';

const log = createLogger('acharPool');

const REDE_ESCOLHIDA = (process.env.POOL_REDE ?? 'base').toLowerCase();
const REDE = REDES[REDE_ESCOLHIDA] ?? REDES.base;
const BLOCOS = Number(process.env.POOL_BLOCOS ?? '10000');
const PEDACO = Number(process.env.POOL_PEDACO ?? '2000');
// Alto de propósito. A primeira versão olhava 150 dos 1.044 pools V2 da Base,
// e olhava os 150 MAIS MOVIMENTADOS — que não são os mais fundos. É o mesmo
// defeito que o vigia tinha (`slice(0, 10)` de uma lista na ordem errada),
// repetido aqui. Ler todos custa quatro multicalls a mais e nada de tempo.
const QUANTOS = Number(process.env.POOL_QUANTOS ?? '2000');
const TIMEOUT_MS = Number(process.env.POOL_TIMEOUT_MS ?? '25000');
// 600ms e não 400: o mainnet.base.org é o único RPC da Base que respondeu na
// sondagem, então não há para onde escoar pedido — a folga tem de vir daqui.
const PAUSA_MS = Number(process.env.POOL_PAUSA_MS ?? '600');
const SELETOR_SYMBOL = id('symbol()').slice(0, 10);

let rpc = process.env.POOL_RPC_URL ?? REDE.rpc;
let rpcId = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function umaChamada<T>(metodo: string, params: unknown[]): Promise<T> {
    const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: metodo, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = (await res.json()) as { result?: T; error?: { message?: string } };
    if (corpo.error) throw new Error(corpo.error.message ?? 'erro sem mensagem');
    return corpo.result as T;
}

/**
 * A mesma chamada, com paciência para o limite do provedor.
 *
 * "over rate limit" não é falha da medição, é a rede pedindo para esperar —
 * e tratar isso como erro joga fora tudo que já foi lido. Foi o que aconteceu:
 * a varredura achou 1.059 pools, esbarrou no limite na leitura seguinte, e
 * morreu sem relatar nada. Descobrir e não contar é o pior dos resultados.
 */
async function chamar<T>(metodo: string, params: unknown[], tentativas = 4): Promise<T> {
    let espera = 1000;
    for (let i = 0; ; i += 1) {
        try {
            return await umaChamada<T>(metodo, params);
        } catch (e) {
            const msg = (e as Error).message;
            if (i >= tentativas - 1 || !ehLimiteDoProvedor(msg)) throw e;
            log.warn('O provedor pediu calma; esperando.', { erro: msg, esperandoMs: espera, tentativa: i + 1 });
            await dormir(espera);
            espera *= 2;
        }
    }
}

/** Uma varredura por família — separadas, porque a família é a resposta. */
async function varrer(familia: Familia, de: number, ate: number): Promise<Map<string, number>> {
    const logs: LogDeSync[] = [];
    const faixas = faixasDeBlocos(de, ate, PEDACO);
    let falhas = 0;
    for (const [a, b] of faixas) {
        try {
            const parte = await chamar<LogDeSync[]>('eth_getLogs', [
                { fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}`, topics: [TOPICO_DA_FAMILIA[familia]] },
            ]);
            logs.push(...parte);
        } catch {
            falhas += 1;
        }
        await dormir(PAUSA_MS);
    }
    if (falhas > 0) {
        log.warn('Faixas que não deram para ler — a contagem desta família está por baixo.', {
            familia,
            falharam: `${falhas} de ${faixas.length}`,
            consequencia: 'pools que só trocaram nessas faixas podem não aparecer',
        });
    }
    return contarAtividade(logs);
}

/** Uma leitura por candidato, em lote. Devolve null onde a chamada falhou. */
async function lerEmLote(alvos: string[], dados: (a: string) => string): Promise<Array<string | null>> {
    const fora: Array<string | null> = [];
    let pedacosPerdidos = 0;
    for (const pedaco of partirEmPedacos(alvos, CHAMADAS_POR_MULTICALL)) {
        try {
            const bruto = await chamar<string>('eth_call', [
                { to: MULTICALL3, data: codificarAggregate3(pedaco.map((a) => ({ alvo: a, dados: dados(a) }))) },
                'latest',
            ]);
            const rs = decodificarAggregate3(bruto);
            for (let i = 0; i < pedaco.length; i += 1) fora.push(rs[i]?.ok ? rs[i].dados : null);
        } catch (e) {
            // Perder um pedaço custa alguns pools; perder a varredura custa tudo.
            pedacosPerdidos += 1;
            for (let i = 0; i < pedaco.length; i += 1) fora.push(null);
            log.warn('Um pedaço não foi lido; esses pools ficam de fora.', { erro: (e as Error).message });
        }
        await dormir(PAUSA_MS);
    }
    if (pedacosPerdidos > 0) log.warn('Leitura incompleta.', { pedacosPerdidos, consequencia: 'o ranking pode não ter o pool mais fundo' });
    return fora;
}

function texto(hex: string | null): string | undefined {
    if (!hex || hex === '0x') return undefined;
    try {
        const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
        // Uma string ABI vem com deslocamento e tamanho; um bytes32 vem cru.
        const s = bytes.length > 64 ? bytes.subarray(64).toString('utf8') : bytes.toString('utf8');
        const limpo = s.replace(/\0/g, '').trim();
        return limpo.length > 0 && limpo.length < 32 ? limpo : undefined;
    } catch {
        return undefined;
    }
}

async function principal(): Promise<void> {
    log.info('*** MODO LEITURA — nenhuma transação é enviada por este processo. ***');
    const rpcs = process.env.POOL_RPC_URL ? [process.env.POOL_RPC_URL] : (RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [REDE.rpc]);
    let topo = 0;
    for (const c of rpcs) {
        try {
            rpc = c;
            topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
            break;
        } catch { /* tenta o próximo */ }
    }
    if (!topo) {
        log.error('Nenhum RPC respondeu; sem rede não há varredura.', { tentados: rpcs });
        return;
    }

    const de = topo - BLOCOS + 1;
    log.info('Varrendo atrás de pools vivos.', {
        rede: REDE.nome,
        blocos: `${de} → ${topo}`,
        comoSabeQueEPool: 'só entram endereços que EMITIRAM Sync — comportamento, não lista',
    });

    const v2 = await varrer('v2', de, topo);
    const solidly = await varrer('solidly', de, topo);
    log.info('Quem é quem na rede.', {
        poolsV2: v2.size,
        poolsSolidly: solidly.size,
        usaveis: 'só os V2: o contrato lê getReserves() como (uint112,uint112,uint32)',
    });
    if (v2.size === 0) {
        log.error('Nenhum pool V2 encontrado na janela. Sem pool não há venda.', { janelaDeBlocos: BLOCOS });
        return;
    }

    // As duas famílias são LIDAS; só uma é USÁVEL hoje. Medir a Solidly não
    // custa contrato nenhum — e é o único jeito de saber se vale mudar o
    // contrato para alcançá-la. Contar 594 pools e nunca abri-los era deixar
    // a decisão mais cara do projeto sem o dado que a decide.
    const candidatos: Array<{ pool: string; trocas: number; familia: Familia }> = [
        ...ordenarPorAtividade(v2, QUANTOS).map((c) => ({ ...c, familia: 'v2' as Familia })),
        ...ordenarPorAtividade(solidly, QUANTOS).map((c) => ({ ...c, familia: 'solidly' as Familia })),
    ];
    const enderecos = candidatos.map((c) => c.pool);
    // Uma de cada vez, e não `Promise.all`. Com 150 pools cada leitura era um
    // pedaço só e o paralelo passava despercebido; com 1.059 viraram cinco
    // pedaços cada, quinze pedidos quase simultâneos, e o provedor cortou.
    // As pausas entre pedaços só valem se ninguém estiver correndo ao lado.
    const t0 = await lerEmLote(enderecos, () => SELECTORS.token0);
    const t1 = await lerEmLote(enderecos, () => SELECTORS.token1);
    const res = await lerEmLote(enderecos, () => SELECTORS.getReserves);

    const pools: Pool[] = [];
    let descartados = 0;
    for (let i = 0; i < candidatos.length; i += 1) {
        if (!t0[i] || !t1[i] || !res[i]) { descartados += 1; continue; }
        try {
            const r = decodeReserves(res[i]!);
            pools.push({
                endereco: candidatos[i].pool,
                familia: candidatos[i].familia,
                trocas: candidatos[i].trocas,
                token0: decodeAddressWord(t0[i]!, 0),
                token1: decodeAddressWord(t1[i]!, 0),
                reserva0: r.reserve0,
                reserva1: r.reserve1,
            });
        } catch {
            descartados += 1;
        }
    }
    if (descartados > 0) {
        log.warn('Candidatos descartados por não responderem como par V2.', {
            descartados,
            de: candidatos.length,
            observacao: 'emitir Sync e não responder token0/getReserves é contradição — ficam de fora',
        });
    }

    // Símbolos e casas: sem as casas, reserva é número sem unidade, e supor 18
    // onde a moeda tem 6 erra por um fator de um trilhão.
    const moedas = [...new Set(pools.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()]))];
    const simbolos = await lerEmLote(moedas, () => SELETOR_SYMBOL);
    const casas = await lerEmLote(moedas, () => SELECTORS.decimals);
    const simboloDe = new Map<string, string | undefined>();
    const casasDe = new Map<string, number | undefined>();
    moedas.forEach((m, i) => {
        simboloDe.set(m, texto(simbolos[i]));
        try { casasDe.set(m, casas[i] ? decodeDecimals(casas[i]!) : undefined); } catch { casasDe.set(m, undefined); }
    });
    for (const p of pools) {
        p.simbolo0 = simboloDe.get(p.token0.toLowerCase());
        p.simbolo1 = simboloDe.get(p.token1.toLowerCase());
        p.decimais0 = casasDe.get(p.token0.toLowerCase());
        p.decimais1 = casasDe.get(p.token1.toLowerCase());
    }

    // Quais moedas a Aave realmente aceita aqui: é só nelas que se liquida.
    let daAave = new Set<string>();
    try {
        const bruto = await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_GET_RESERVES_LIST }, 'latest']);
        daAave = new Set(decodificarListaDeEnderecos(bruto).map((a) => a.toLowerCase()));
    } catch (e) {
        log.warn('Não deu para ler a lista de moedas da Aave; o relatório sai sem esse filtro.', {
            erro: (e as Error).message,
        });
    }

    const nome = (p: Pool, qual: 0 | 1) =>
        (qual === 0 ? p.simbolo0 : p.simbolo1) ?? (qual === 0 ? p.token0 : p.token1).slice(0, 10);

    const teto = new Decimal('0.01');
    const doParDaAave = pools.filter(
        (p) => daAave.size === 0 || (daAave.has(p.token0.toLowerCase()) && daAave.has(p.token1.toLowerCase())),
    );

    // Ordenar por profundidade em dólar, não por movimento. Reservas em
    // unidades não se comparam entre moedas — 248 WETH e 648.537 USDC são o
    // mesmo dinheiro — e o pool mais movimentado não é o mais fundo.
    const porProfundidade = (lista: Pool[]) =>
        lista
            .filter((p) => profundidadeEmDolar(p) !== null)
            .sort((a, b) => profundidadeEmDolar(b)!.comparedTo(profundidadeEmDolar(a)!));

    const comDolar = porProfundidade(doParDaAave.filter((p) => p.familia === 'v2'));
    const solidlyFundos = porProfundidade(doParDaAave.filter((p) => p.familia === 'solidly'));
    const semDolar = doParDaAave.filter((p) => profundidadeEmDolar(p) === null);

    // Os dois tamanhos que este projeto mediu e persegue, já em dólares a
    // VENDER: metade da dívida coberta mais 5% de ágio.
    const TAMANHOS: Array<[string, Decimal]> = [
        ['faixa de baixo', new Decimal(2_654).mul('0.5').mul('1.05')],
        ['faixa do meio', new Decimal(20_406).mul('0.5').mul('1.05')],
    ];

    log.info('POOLS QUE SERVEM — ordenados pelo mais fundo, não pelo mais movimentado.', {
        comDolar: comDolar.length,
        semDolarParaComparar: semDolar.length,
        deUmTotalDe: pools.length,
        soVeOQueNegociou: `pool parado nesta janela de ${BLOCOS} blocos não aparece — de propósito`,
        detalhe: comDolar
            .slice(0, 15)
            .map((p) => {
                const d = profundidadeEmDolar(p)!;
                return `${p.endereco} ${nome(p, 0)}/${nome(p, 1)} $${d.toFixed(0)} (${p.trocas} trocas)`;
            })
            .join(' | '),
    });

    // Num pool de produto constante os dois lados valem o mesmo em dólar, então
    // a profundidade do lado em dólar serve para os dois sentidos da venda.
    log.info('QUANTO CUSTARIA VENDER, nos tamanhos que a gente persegue.', {
        detalhe: comDolar
            .slice(0, 10)
            .map((p) => {
                const d = profundidadeEmDolar(p)!;
                const custos = TAMANHOS.map(([rotulo, v]) => {
                    const perda = perdaNaVenda(v, { reserveIn: d, reserveOut: d, feeFraction: new Decimal('0.003') });
                    return `${rotulo} ($${v.toFixed(0)}): ${perda.total.mul(100).toFixed(2)}%`;
                }).join(', ');
                const cabe1pct = d.mul(teto).dividedBy(new Decimal(1).minus(teto));
                return `${nome(p, 0)}/${nome(p, 1)} $${d.toFixed(0)} -> ${custos}; a 1% cabe $${cabe1pct.toFixed(0)}`;
            })
            .join(' | '),
        paraReferencia:
            `para ficar em 1% de empurrão, a faixa do meio pede pool de ` +
            `$${poolNecessarioPara(TAMANHOS[1][1], teto).toFixed(0)} e a de baixo, ` +
            `$${poolNecessarioPara(TAMANHOS[0][1], teto).toFixed(0)}`,
        lembrete: 'o ágio da liquidação é 5% — perda acima disso come o lucro inteiro',
        observacao: 'MODO LEITURA: nada foi enviado. Isto mede o pool, não usa ele.',
    });

    // A conta que decide a obra: o contrato só lê V2, e mudá-lo custa um deploy
    // ($0,03) mais o risco de mexer em código já conferido. Vale se, e só se,
    // a Solidly for materialmente mais funda.
    const maisFundoV2 = comDolar[0] ? profundidadeEmDolar(comDolar[0]) : null;
    const maisFundoSolidly = solidlyFundos[0] ? profundidadeEmDolar(solidlyFundos[0]) : null;
    log.info('VALE MUDAR O CONTRATO PARA ALCANÇAR A OUTRA FAMÍLIA?', {
        melhorV2: maisFundoV2 ? `$${maisFundoV2.toFixed(0)} (usável HOJE)` : 'nenhum',
        melhorSolidly: maisFundoSolidly ? `$${maisFundoSolidly.toFixed(0)} (exigiria mudar o contrato)` : 'nenhum',
        quantasVezesMaisFundo:
            maisFundoV2 && maisFundoSolidly && maisFundoV2.greaterThan(0)
                ? `${maisFundoSolidly.dividedBy(maisFundoV2).toFixed(1)}x`
                : 'não dá para comparar',
        solidlyNoTopo: solidlyFundos
            .slice(0, 8)
            .map((p) => `${p.endereco} ${nome(p, 0)}/${nome(p, 1)} $${profundidadeEmDolar(p)!.toFixed(0)}`)
            .join(' | '),
        porQueNaoDaParaUsarAgora:
            'CacadorDeLiquidacoes lê getReserves() como (uint112,uint112,uint32); Solidly devolve (uint256,uint256,uint256)',
    });

    if (semDolar.length > 0) {
        log.info('Pools sem lado em dólar — não dá para comparar profundidade sem tabela de preço.', {
            quantos: semDolar.length,
            quais: semDolar.slice(0, 5).map((p) => `${p.endereco} ${nome(p, 0)}/${nome(p, 1)}`).join(' | '),
        });
    }

    // Se quem chama já sabe o par, responde direto qual endereço usar.
    const garantia = process.env.POOL_GARANTIA;
    const divida = process.env.POOL_DIVIDA;
    if (garantia && divida) {
        const e = escolherPoolDeVenda(pools, garantia, divida);
        log.info('ESCOLHA PARA O PAR PEDIDO.', {
            garantia,
            divida,
            poolDeVenda: e.pool?.endereco ?? 'NENHUM',
            recebeDoOutroLado: e.recebe?.toFixed(0) ?? '-',
            motivo: e.motivo,
        });
    } else {
        log.info('Para escolher o pool de um par específico, defina POOL_GARANTIA e POOL_DIVIDA.');
    }
}

if (require.main === module && exigirAtivacao('acharPool')) {
    principal().catch((e) => log.error('Varredura tropeçou.', { erro: (e as Error).message }));
}
