// Arquivo: src/leadLagSniffer.ts
//
// Escuta cruzada Futuros → Spot, em modo MEDIÇÃO. Não envia ordem nenhuma:
// não existe caminho de execução neste arquivo, nem variável que o ligue.
//
// A pergunta que ele responde é uma só, e ela decide se vale construir o
// motor de execução: DEPOIS de descontar a nossa latência, ainda sobra
// movimento no Spot para pagar o spread?
//
// COMO O PROCESSAMENTO FICA LEVE
//
// O caminho quente é o tick do Spot, que chega dezenas de vezes por segundo, e
// o `@aggTrade` do Futuros, que chega centenas. Três decisões mantêm isso
// barato:
//
//   1. Nada de Decimal aqui. `number` para detectar, e o custo de alocar um
//      objeto por mensagem some.
//   2. O estado do Spot é UM par de números sobrescrito a cada tick, não uma
//      série. Guardar histórico seria pagar memória por dado que só interessa
//      durante os poucos segundos após um evento.
//   3. As janelas abertas vivem num array minúsculo, varrido a cada tick.
//      Eventos são raros (alguns por hora), então esse array tem zero ou um
//      elemento quase sempre — varrer é mais barato que indexar.
import WebSocket from 'ws';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import {
    DetectorDeRajada,
    EstatisticaDeAtraso,
    direcaoDaLiquidacao,
    liquidacaoRelevante,
    medirJanela,
    type JanelaDeEvento,
    type Liquidacao,
} from './leadLag';

const log = createLogger('leadlag');

const SIMBOLO_FUTUROS = (process.env.LEADLAG_FUTURES_SYMBOL ?? 'BTCUSDT').toUpperCase();
const SIMBOLO_SPOT = (process.env.LEADLAG_SPOT_SYMBOL ?? 'BTCFDUSD').toUpperCase();

/**
 * Endpoints configuráveis pelo mesmo motivo do sniffer triangular: a Binance
 * responde 451 conforme a região do container, e isso não é resolvível em
 * código. `fstream` (Futuros) e `stream` (Spot) são domínios diferentes e
 * podem estar bloqueados de forma independente.
 */
const WS_FUTUROS = process.env.LEADLAG_FUTURES_WS ?? 'wss://fstream.binance.com/stream';
const WS_SPOT = process.env.LEADLAG_SPOT_WS ?? 'wss://stream.binance.com:9443/ws';

/** Liquidação mínima, em nocional, para contar como evento. */
const NOCIONAL_MINIMO = Number(process.env.LEADLAG_MIN_LIQUIDATION_USD ?? '100000');

/**
 * A latência que estamos simulando: quanto tempo depois do evento
 * conseguiríamos ter uma ordem executada no Spot.
 *
 * Chutar baixo aqui é a forma mais fácil de produzir um resultado bonito e
 * falso — todo o movimento entre o evento e a entrada real apareceria como
 * lucro nosso. 150ms é a estimativa conservadora para Railway.
 */
const LATENCIA_MS = Number(process.env.LEADLAG_LATENCY_MS ?? '150');

/** Horizontes de saída avaliados, em ms após o evento. */
const HORIZONTES = (process.env.LEADLAG_HORIZONS_MS ?? '500,1000,2000,5000')
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isFinite(h) && h > LATENCIA_MS)
    .sort((a, b) => a - b);

const RELATORIO_MS = Number(process.env.LEADLAG_REPORT_MS ?? '30000');

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** Último tick do Spot. Sobrescrito, nunca acumulado. */
let spotBid = 0;
let spotAsk = 0;
let spotTsMs = 0;

interface JanelaAberta {
    tsEventoMs: number;
    direcao: 'alta' | 'baixa';
    precoFuturosT0: number;
    origem: 'liquidacao' | 'rajada';
    /** Preenchido no primeiro tick do Spot após a latência simulada. */
    precoSpotT1: number | null;
    melhor: number | null;
    pior: number | null;
    /** Horizontes ainda não fechados, em ordem crescente. */
    pendentes: number[];
}

const janelas: JanelaAberta[] = [];
const estatistica = new EstatisticaDeAtraso();
const porOrigem = { liquidacao: 0, rajada: 0 };
const resultados: Array<{ apossMs: number; capturavel: number; contraria: number; perdido: number; origem: string }> = [];

const detector = new DetectorDeRajada({
    janelaMs: Number(process.env.LEADLAG_BURST_WINDOW_MS ?? '300'),
    volumeMinimo: Number(process.env.LEADLAG_BURST_MIN_USD ?? '500000'),
    unanimidadeMinima: Number(process.env.LEADLAG_BURST_UNANIMITY ?? '0.85'),
    silencioMs: Number(process.env.LEADLAG_SILENCE_MS ?? '3000'),
});

function abrirJanela(params: {
    tsMs: number;
    direcao: 'alta' | 'baixa';
    preco: number;
    origem: 'liquidacao' | 'rajada';
}): void {
    // Uma janela por evento, e só se não houver outra aberta do mesmo instante.
    // Sem isso, liquidação e rajada disparando juntas contariam o mesmo evento
    // duas vezes e inflariam a amostra com dado duplicado.
    if (janelas.some((j) => Math.abs(j.tsEventoMs - params.tsMs) < 250)) return;
    porOrigem[params.origem] += 1;
    janelas.push({
        tsEventoMs: params.tsMs,
        direcao: params.direcao,
        precoFuturosT0: params.preco,
        origem: params.origem,
        precoSpotT1: null,
        melhor: null,
        pior: null,
        pendentes: [...HORIZONTES],
    });
    log.info('Evento detectado — janela aberta.', {
        origem: params.origem,
        direcao: params.direcao,
        precoFuturos: params.preco,
        spotAgora: spotBid > 0 ? (spotBid + spotAsk) / 2 : 'sem tick',
        janelasAbertas: janelas.length,
    });
}

/** Atualiza as janelas abertas com o tick de Spot que acabou de chegar. */
function atualizarJanelas(agora: number, meio: number): void {
    for (let i = janelas.length - 1; i >= 0; i -= 1) {
        const j = janelas[i];
        const decorrido = agora - j.tsEventoMs;

        // T1: o primeiro tick DEPOIS da latência simulada. Usar um tick
        // anterior seria fingir que somos mais rápidos do que somos.
        if (j.precoSpotT1 === null) {
            if (decorrido >= LATENCIA_MS) {
                j.precoSpotT1 = meio;
                j.melhor = meio;
                j.pior = meio;
            }
            continue;
        }

        const sinal = j.direcao === 'alta' ? 1 : -1;
        if (j.melhor === null || sinal * (meio - j.melhor) > 0) j.melhor = meio;
        if (j.pior === null || sinal * (meio - j.pior) < 0) j.pior = meio;

        // Fecha os horizontes vencidos, do menor para o maior.
        while (j.pendentes.length > 0 && decorrido >= j.pendentes[0]) {
            const horizonte = j.pendentes.shift()!;
            const janela: JanelaDeEvento = {
                tsEventoMs: j.tsEventoMs,
                direcao: j.direcao,
                precoFuturosT0: j.precoFuturosT0,
                precoSpotT1: j.precoSpotT1,
                melhorSpotT2: j.melhor,
                piorSpotT2: j.pior,
            };
            const r = medirJanela(janela);
            if (r) {
                estatistica.registrar({ apossMs: horizonte, aFavor: r.capturavel });
                resultados.push({
                    apossMs: horizonte,
                    capturavel: r.capturavel,
                    contraria: r.excursaoContraria,
                    perdido: r.perdidoNaLatencia,
                    origem: j.origem,
                });
            }
        }
        if (j.pendentes.length === 0) janelas.splice(i, 1);
    }
}

// ---------------------------------------------------------------------------
// Conexões
// ---------------------------------------------------------------------------

function conectarFuturos(): void {
    const streams = `${SIMBOLO_FUTUROS.toLowerCase()}@forceOrder/${SIMBOLO_FUTUROS.toLowerCase()}@aggTrade`;
    const url = `${WS_FUTUROS}?streams=${streams}`;
    const ws = new WebSocket(url);

    ws.on('open', () => log.info('Futuros conectado.', { url, streams }));
    ws.on('error', (err) => log.error('Erro no WS de Futuros.', { erro: String(err), url }));
    ws.on('close', () => {
        log.warn('WS de Futuros caiu; reconectando em 3s.');
        setTimeout(conectarFuturos, 3000);
    });

    ws.on('message', (raw) => {
        let msg: { stream?: string; data?: Record<string, unknown> };
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        const d = msg.data;
        if (!d) return;

        if (typeof msg.stream === 'string' && msg.stream.includes('forceorder')) {
            const o = d.o as Record<string, string> | undefined;
            if (!o) return;
            const liq: Liquidacao = {
                tsMs: Number(d.E),
                symbol: String(o.s),
                lado: o.S === 'SELL' ? 'SELL' : 'BUY',
                preco: Number(o.ap ?? o.p),
                quantidade: Number(o.q),
            };
            if (!Number.isFinite(liq.preco) || !Number.isFinite(liq.quantidade)) return;
            if (!liquidacaoRelevante(liq, NOCIONAL_MINIMO)) return;
            log.warn('LIQUIDAÇÃO relevante.', {
                lado: liq.lado,
                nocional: Math.round(liq.preco * liq.quantidade),
                preco: liq.preco,
                empurraPara: direcaoDaLiquidacao(liq),
            });
            abrirJanela({
                tsMs: liq.tsMs,
                direcao: direcaoDaLiquidacao(liq),
                preco: liq.preco,
                origem: 'liquidacao',
            });
            return;
        }

        // aggTrade
        const preco = Number(d.p);
        const quantidade = Number(d.q);
        if (!Number.isFinite(preco) || !Number.isFinite(quantidade)) return;
        const evento = detector.registrar({
            tsMs: Number(d.T),
            preco,
            quantidade,
            // `m` = o comprador é o market maker, ou seja: foi uma VENDA agressiva.
            compradorPassivo: d.m === true,
        });
        if (evento) {
            abrirJanela({
                tsMs: evento.tsMs,
                direcao: evento.direcao,
                preco: evento.preco,
                origem: 'rajada',
            });
        }
    });
}

function conectarSpot(): void {
    const url = `${WS_SPOT}/${SIMBOLO_SPOT.toLowerCase()}@bookTicker`;
    const ws = new WebSocket(url);

    ws.on('open', () => log.info('Spot conectado.', { url }));
    ws.on('error', (err) => log.error('Erro no WS de Spot.', { erro: String(err), url }));
    ws.on('close', () => {
        log.warn('WS de Spot caiu; reconectando em 3s.');
        setTimeout(conectarSpot, 3000);
    });

    ws.on('message', (raw) => {
        let d: Record<string, string>;
        try {
            d = JSON.parse(raw.toString());
        } catch {
            return;
        }
        const bid = Number(d.b);
        const ask = Number(d.a);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
        spotBid = bid;
        spotAsk = ask;
        spotTsMs = Date.now();
        if (janelas.length > 0) atualizarJanelas(spotTsMs, (bid + ask) / 2);
    });
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

function relatar(): void {
    const spread = spotBid > 0 ? (spotAsk - spotBid) / ((spotAsk + spotBid) / 2) : 0;
    const resumo = estatistica.resumo();

    log.info('Relatório de lead-lag.', {
        eventos: `${porOrigem.liquidacao} liquidações + ${porOrigem.rajada} rajadas`,
        janelasAbertas: janelas.length,
        spreadSpotAtual: `${(spread * 100).toFixed(4)}%`,
        // O custo a ser batido. Com taxa zero no par FDUSD, sobra o spread.
        precisaBater: `${(spread * 100).toFixed(4)}% (spread, taxa zero)`,
        amostrasPorHorizonte: resumo.length === 0 ? 'nenhuma ainda' : undefined,
    });

    for (const r of resumo) {
        const acima = r.mediana > spread;
        log.info(`  ${r.apossMs}ms após o evento`, {
            amostras: r.amostras,
            // A mediana manda. A média pode ser levantada por um único evento
            // gigante que não se repete.
            medianaCapturavel: `${(r.mediana * 100).toFixed(4)}%`,
            mediaCapturavel: `${(r.media * 100).toFixed(4)}%`,
            acertoDeDirecao: `${(r.acertosDeDirecao * 100).toFixed(1)}%`,
            veredicto: acima ? 'PAGA o spread' : 'não paga o spread',
        });
    }

    if (resultados.length > 0) {
        const perdidos = resultados.map((r) => r.perdido).sort((a, b) => a - b);
        const meio = Math.floor(perdidos.length / 2);
        log.info('  Movimento que a latência come antes de conseguirmos entrar.', {
            medianaPerdida: `${(perdidos[meio] * 100).toFixed(4)}%`,
            latenciaSimulada: `${LATENCIA_MS}ms`,
        });
    }
}

async function main(): Promise<void> {
    log.info('*** MODO MEDIÇÃO — nenhuma ordem é enviada por este processo. ***');
    log.info('Escuta cruzada Futuros -> Spot iniciada.', {
        futuros: SIMBOLO_FUTUROS,
        spot: SIMBOLO_SPOT,
        liquidacaoMinima: `$${NOCIONAL_MINIMO.toLocaleString('en-US')}`,
        latenciaSimulada: `${LATENCIA_MS}ms`,
        horizontes: HORIZONTES.join(',') || 'NENHUM — todos menores que a latência',
    });
    if (HORIZONTES.length === 0) {
        throw new Error(
            `Nenhum horizonte maior que a latência de ${LATENCIA_MS}ms. ` +
                'Medir uma saída antes da entrada não produz número, produz ilusão.',
        );
    }
    conectarFuturos();
    conectarSpot();
    setInterval(relatar, RELATORIO_MS);
}

// Só roda com ATIVAR_LEADLAGSNIFFER=1. Sem isso o processo anuncia que está
// desligado e fica ocioso — ver src/ativacao.ts.
if (require.main === module && exigirAtivacao('leadLagSniffer')) {
    main().catch((err) => {
        log.error('Falha fatal na escuta cruzada.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
