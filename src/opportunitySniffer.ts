// Arquivo: src/opportunitySniffer.ts
//
// Ferramenta de MEDIÇÃO EMPÍRICA, não de execução: descobre dinamicamente
// todos os triângulos USDT→base→alt→USDT realmente listados na Binance
// (via REST /api/v3/exchangeInfo) e assina o book em tempo real de cada
// símbolo envolvido, registrando com que frequência e de que tamanho
// ineficiências líquidas de taxa realmente aparecem — em vez de assumir um
// número e calcular pra trás.
//
// Nenhuma ordem é enviada aqui. É só leitura de mercado + estatística.
//
// Precisa de acesso de rede real à Binance (não roda em sandboxes com
// egress restrito) — rode local (`npm run sniff`) ou como um segundo
// serviço no mesmo projeto Railway.
import { Decimal } from 'decimal.js';
import WebSocket from 'ws';
import { createLogger } from './logger';
import { buildTriangles, RawTriangle as Triangle, SymbolInfo } from './triangleTopology';
import {
    brutoNecessario,
    custoDoTriangulo,
    montarTabelaDeTaxas,
    pernasIsentas,
    retencaoDoTriangulo,
    type TabelaDeTaxas,
} from './taxaPorPar';

const log = createLogger('sniffer');

/**
 * Endpoints configuráveis.
 *
 * A Binance responde HTTP 451 ("Unavailable For Legal Reasons") quando o IP
 * de origem está numa região bloqueada — e isso depende de onde o container
 * roda, não do código. Dois serviços do mesmo projeto, em regiões diferentes,
 * dão resultados diferentes contra a mesma URL.
 *
 * Deixar configurável evita ter que reescrever e reimplantar para testar um
 * espelho: `data-api.binance.vision` serve os mesmos dados públicos de
 * mercado por outro caminho.
 */
const BINANCE_REST_URL = `${process.env.SNIFFER_REST_BASE ?? 'https://api.binance.com'}/api/v3/exchangeInfo`;
const BINANCE_WS_URL = process.env.SNIFFER_WS_BASE ?? 'wss://stream.binance.com:9443/ws';
const SUBSCRIBE_BATCH_SIZE = 200; // limite de streams por conexão é 1024; batching evita payloads gigantes
const SUBSCRIBE_BATCH_DELAY_MS = 250; // espaçamento entre lotes — a Binance limita ~5 msgs de controle/s por conexão
/**
 * Idade máxima de CADA perna para a avaliação contar como simultânea.
 *
 * Três segundos é generoso demais para arbitragem, e o motivo de ser
 * configurável é este: num par cruzado fino como DOTBTC o book pode ficar
 * parado por segundos enquanto BTCUSDT e DOTUSDT se movem. A comparação entre
 * uma cotação velha e duas frescas produz um desalinhamento que NUNCA existiu
 * ao mesmo tempo no mercado — e ele aparece grande justamente porque o preço
 * andou nesse intervalo.
 *
 * Quanto menor este número, mais honesta a medição e menos "oportunidades"
 * sobram. Se todas somem a 500ms, todas eram fantasma.
 */
const MAX_LEG_AGE_MS = Number(process.env.SNIFFER_MAX_LEG_AGE_MS ?? '3000');

const TAKER_FEE = new Decimal(process.env.SNIFFER_TAKER_FEE ?? '0.001');
const TARGET_NET_PROFIT = new Decimal(process.env.SNIFFER_TARGET_NET_PROFIT ?? '0.0002'); // 0.02% líquido

/**
 * Pares com taxa ZERO, separados por vírgula.
 *
 * É a variável que reabre este motor. A conclusão anterior — arbitragem
 * triangular morta, melhor desalinhamento 0,124% contra custo de 0,225% —
 * dependia de assumir a mesma taxa nas três pernas. Com os pares FDUSD
 * isentos, um ciclo USDT → cripto → FDUSD → USDT paga taxa em UMA perna, e o
 * custo desce para 0,075%.
 */
const PARES_ISENTOS = (process.env.SNIFFER_ZERO_FEE_PAIRS ?? '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0);
const INTERMEDIATE_BASES = (process.env.SNIFFER_BASES ?? 'BTC,ETH,BNB,FDUSD').split(',').map((s) => s.trim().toUpperCase());

// ============================================================================
// [1] FUNÇÕES PURAS (testadas isoladamente em triangleTopology.test.ts e
// opportunitySniffer.test.ts, sem rede) — mapeamento topológico (compartilhado
// com engine.ts/BinanceExchangeProvider via triangleTopology.ts) e avaliação
// de triângulo.
// ============================================================================
export interface BookTick {
    bid: Decimal;
    ask: Decimal;
    timestamp: number;
}

export interface TriangleEvaluation {
    triangleId: string;
    grossReturn: Decimal;
    netProfitPct: Decimal;
    isOpportunity: boolean;
}

/**
 * Avalia um triângulo dado o estado em cache de suas 3 pernas. Retorna
 * `null` quando algum preço é inválido (<=0) — mesmo kill switch de
 * sanidade usado no RiskManager do motor de execução.
 */
export function evaluateTriangle(
    triangle: Triangle,
    leg1: BookTick,
    leg2: BookTick,
    leg3: BookTick,
    /**
     * Retenção DESTE triângulo — o produto de (1 − taxa) das três pernas.
     *
     * Era `(1 − taxa)³`, uma taxa só para o motor inteiro. Deixou de ser
     * elevado ao cubo porque as pernas não custam a mesma coisa: com FDUSD
     * isento, duas das três não custam nada.
     */
    retencaoDoCiclo: Decimal,
    requiredGrossSpread: Decimal
): TriangleEvaluation | null {
    if (!leg1.ask.greaterThan(0) || !leg2.ask.greaterThan(0) || !leg3.bid.greaterThan(0)) return null;

    const grossReturn = new Decimal(1).dividedBy(leg1.ask).dividedBy(leg2.ask).mul(leg3.bid);
    const netProfitPct = grossReturn.mul(retencaoDoCiclo).minus(1).mul(100);

    return {
        triangleId: triangle.id,
        grossReturn,
        netProfitPct,
        isOpportunity: grossReturn.greaterThanOrEqualTo(requiredGrossSpread),
    };
}

// ============================================================================
// [2] MOTOR DE ESTADO: descoberta de topologia + ingestão WS + avaliação O(k)
// ============================================================================
class OpportunitySniffer {
    private readonly tabelaDeTaxas: TabelaDeTaxas;
    private readonly lucroAlvo: Decimal;
    /**
     * Retenção e bruto exigido POR TRIÂNGULO, calculados uma vez na montagem
     * da topologia. As taxas não mudam a cada tick, e recalcular no laço
     * quente custaria três buscas em Set por avaliação, milhares de vezes por
     * segundo, para sempre devolver o mesmo número.
     */
    private readonly custoPorTriangulo = new Map<string, { retencao: Decimal; brutoExigido: Decimal }>();

    private triangles: Triangle[] = [];
    /** Índice símbolo -> triângulos afetados, construído uma vez — evita re-varrer todos os triângulos a cada tick (O(k), não O(N)). */
    private trianglesBySymbol = new Map<string, Triangle[]>();
    private orderBook = new Map<string, BookTick>();

    private ws: WebSocket | null = null;
    private isShuttingDown = false;

    private metrics = {
        ticksProcessed: 0,
        avaliacoes: 0,
        opportunitiesFound: 0,
        /**
         * Melhor líquido visto entre TODAS as avaliações, incluindo as
         * negativas — e começa em -infinito por isso.
         *
         * A versão anterior só atualizava este número dentro do ramo de
         * oportunidade, então ele ficava em 0,0000 para sempre enquanto não
         * houvesse nenhuma. E 0,0000 é indistinguível entre dois mundos
         * opostos: "o melhor ciclo ficou a 0,03% de valer" e "o melhor ficou
         * a 5% de distância". O primeiro pede paciência, o segundo pede
         * desistir — e o log dizia a mesma coisa nos dois.
         */
        melhorLiquidoPct: new Decimal(Number.NEGATIVE_INFINITY),
        melhorLiquidoTriangulo: '',
        melhorBruto: new Decimal(0),
        /** Idade da perna mais velha em cada oportunidade encontrada. */
        oportunidadesPorIdade: [] as number[],
        startTime: Date.now(),
    };

    /**
     * Histograma do lucro líquido, em faixas de 0,01 ponto percentual.
     *
     * O "melhor visto" sozinho não distingue duas situações opostas: uma cauda
     * que encosta na linha o tempo todo, e um pico único que nunca se repete.
     * A primeira diz "espere e afine"; a segunda diz "desista". Sem a
     * distribuição, as duas aparecem como o mesmo número.
     *
     * A chave é o líquido em CENTÉSIMOS de ponto percentual, truncado — um
     * inteiro, para o Map não crescer com ruído de ponto flutuante.
     */
    private readonly histograma = new Map<number, number>();

    private registrarNoHistograma(netPct: Decimal): void {
        // Faixas fora de [-1%, +1%] são agrupadas nos extremos: o que interessa
        // é a vizinhança da linha do custo, e um ciclo a -40% é dado de book
        // quebrado, não informação sobre viabilidade.
        const centesimos = Math.max(-100, Math.min(100, Math.trunc(netPct.toNumber() * 100)));
        this.histograma.set(centesimos, (this.histograma.get(centesimos) ?? 0) + 1);
    }

    constructor(feeRate: Decimal, targetNetProfit: Decimal, paresIsentos: string[] = []) {
        this.tabelaDeTaxas = montarTabelaDeTaxas({ padrao: feeRate, isentos: paresIsentos });
        this.lucroAlvo = targetNetProfit;
    }

    public async initialize(): Promise<void> {
        log.info('Iniciando mapeamento topológico real da Binance...', {
            bases: INTERMEDIATE_BASES.join(','),
            lucroAlvo: `${this.lucroAlvo.mul(100).toFixed(4)}%`,
        });
        await this.buildTopologyGraph();
        this.connectWebSocket();
        setInterval(() => this.printReport(), 10_000);
    }

    public shutdown(): void {
        this.isShuttingDown = true;
        this.ws?.close();
    }

    private async buildTopologyGraph(): Promise<void> {
        const res = await fetch(BINANCE_REST_URL);
        if (!res.ok) {
            // 451 não é erro de código nem de chave: é a Binance recusando o
            // IP de origem. Dizer isso explicitamente evita horas procurando
            // bug onde não tem, que é o custo real de uma mensagem genérica.
            const explicacao =
                res.status === 451
                    ? ' — a Binance BLOQUEIA esta região. Mude a região do serviço no Railway para uma ' +
                      'não bloqueada, ou aponte SNIFFER_REST_BASE/SNIFFER_WS_BASE para um espelho.'
                    : '';
            throw new Error(`Falha ao buscar exchangeInfo: HTTP ${res.status}${explicacao} (${BINANCE_REST_URL})`);
        }
        const data = (await res.json()) as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string }> };

        const activeSymbols: SymbolInfo[] = data.symbols
            .filter((s) => s.status === 'TRADING')
            .map((s) => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset }));

        this.triangles = buildTriangles(activeSymbols, INTERMEDIATE_BASES);
        this.trianglesBySymbol = new Map();
        this.custoPorTriangulo.clear();
        for (const t of this.triangles) {
            const pernas: [string, string, string] = [t.leg1, t.leg2, t.leg3];
            this.custoPorTriangulo.set(t.id, {
                retencao: retencaoDoTriangulo(pernas, this.tabelaDeTaxas),
                brutoExigido: brutoNecessario({ pernas, tabela: this.tabelaDeTaxas, lucroAlvo: this.lucroAlvo }),
            });
            for (const leg of [t.leg1, t.leg2, t.leg3]) {
                const list = this.trianglesBySymbol.get(leg) ?? [];
                list.push(t);
                this.trianglesBySymbol.set(leg, list);
            }
        }

        // Quais triângulos ficaram baratos, e por quê. Sem isto, um custo
        // menor apareceria como um número sem explicação — e um número sem
        // explicação é indistinguível de um erro de configuração.
        const comIsencao = this.triangles
            .map((t) => ({
                id: t.id,
                isentas: pernasIsentas([t.leg1, t.leg2, t.leg3], this.tabelaDeTaxas),
                custo: custoDoTriangulo([t.leg1, t.leg2, t.leg3], this.tabelaDeTaxas),
            }))
            .filter((t) => t.isentas.length > 0)
            .sort((a, b) => (a.custo.lessThan(b.custo) ? -1 : 1));

        log.info('Topologia real construída a partir dos pares de fato listados na Binance.', {
            triangulosOperaveis: this.triangles.length,
            simbolosUnicos: this.trianglesBySymbol.size,
            paresIsentosConfigurados: Array.from(this.tabelaDeTaxas.isentos).join(',') || 'nenhum',
            triangulosComPernaIsenta: comIsencao.length,
            custoCheio: `${custoDoTriangulo(['X', 'Y', 'Z'], this.tabelaDeTaxas).mul(100).toFixed(4)}%`,
            maisBaratos: comIsencao
                .slice(0, 5)
                .map((t) => `${t.id} (${t.custo.mul(100).toFixed(4)}%, isentas: ${t.isentas.join('+')})`)
                .join(' | ') || 'nenhum',
        });
    }

    private connectWebSocket(): void {
        const streams = Array.from(this.trianglesBySymbol.keys()).map((s) => `${s.toLowerCase()}@bookTicker`);
        this.ws = new WebSocket(BINANCE_WS_URL);

        this.ws.on('open', () => {
            log.info(`Conexão WS estabelecida. Inscrevendo em ${streams.length} streams em lotes de ${SUBSCRIBE_BATCH_SIZE}...`);
            let batchIndex = 0;
            for (let i = 0; i < streams.length; i += SUBSCRIBE_BATCH_SIZE) {
                const batch = streams.slice(i, i + SUBSCRIBE_BATCH_SIZE);
                const delay = batchIndex * SUBSCRIBE_BATCH_DELAY_MS;
                batchIndex += 1;
                setTimeout(() => {
                    this.ws?.send(JSON.stringify({ method: 'SUBSCRIBE', params: batch, id: i }));
                }, delay);
            }
        });

        this.ws.on('message', (raw: WebSocket.RawData) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.u && msg.s && msg.b && msg.a) {
                    this.metrics.ticksProcessed += 1;
                    this.updateStateAndEvaluate(msg.s, msg.b, msg.a);
                }
            } catch {
                // mensagens de controle (resultado de SUBSCRIBE, ping/pong) não são bookTicker — ignoradas.
            }
        });

        this.ws.on('close', () => {
            if (this.isShuttingDown) return;
            log.warn('Conexão WS perdida. Reconectando em 3s...');
            setTimeout(() => this.connectWebSocket(), 3000);
        });

        this.ws.on('error', (err: Error) => {
            log.error('Erro de WebSocket.', { error: err.message });
        });
    }

    private updateStateAndEvaluate(symbol: string, bidRaw: string, askRaw: string): void {
        const now = Date.now();
        this.orderBook.set(symbol, { bid: new Decimal(bidRaw), ask: new Decimal(askRaw), timestamp: now });

        const affected = this.trianglesBySymbol.get(symbol) ?? []; // O(k): só os triângulos que usam este símbolo
        for (const t of affected) {
            const ob1 = this.orderBook.get(t.leg1);
            const ob2 = this.orderBook.get(t.leg2);
            const ob3 = this.orderBook.get(t.leg3);
            if (!ob1 || !ob2 || !ob3) continue; // ainda não temos as 3 pernas em cache

            // Kill switch de simultaneidade: sem isso, uma perna desatualizada
            // (par pouco líquido, book quase parado) pode ser comparada com
            // pernas frescas e gerar uma "ineficiência" que nunca coexistiu
            // de verdade no mercado — um falso positivo estatístico.
            if (now - ob1.timestamp > MAX_LEG_AGE_MS || now - ob2.timestamp > MAX_LEG_AGE_MS || now - ob3.timestamp > MAX_LEG_AGE_MS) {
                continue;
            }

            const custo = this.custoPorTriangulo.get(t.id);
            // Triângulo sem custo pré-calculado é triângulo que não passou pela
            // montagem da topologia. Avaliar com um padrão inventado aqui seria
            // operar com número que ninguém conferiu.
            if (!custo) continue;
            const evaluation = evaluateTriangle(t, ob1, ob2, ob3, custo.retencao, custo.brutoExigido);
            if (!evaluation) continue;

            // Registrado ANTES do filtro, de propósito: o que interessa quando
            // não há oportunidade nenhuma é QUÃO LONGE ela ficou. Medir só o
            // que já passou do limiar é medir só o que a gente já sabia.
            this.metrics.avaliacoes += 1;
            if (evaluation.netProfitPct.greaterThan(this.metrics.melhorLiquidoPct)) {
                this.metrics.melhorLiquidoPct = evaluation.netProfitPct;
                this.metrics.melhorLiquidoTriangulo = evaluation.triangleId;
            }
            if (evaluation.grossReturn.greaterThan(this.metrics.melhorBruto)) {
                this.metrics.melhorBruto = evaluation.grossReturn;
            }
            this.registrarNoHistograma(evaluation.netProfitPct);

            if (!evaluation.isOpportunity) continue;
            this.metrics.opportunitiesFound += 1;

            // A idade de cada perna no instante da detecção. É o número que
            // separa oportunidade real de comparação entre cotação velha e
            // cotações frescas — e sem ele as duas aparecem idênticas.
            const idades = [now - ob1.timestamp, now - ob2.timestamp, now - ob3.timestamp];
            const idadeMaxima = Math.max(...idades);
            this.metrics.oportunidadesPorIdade.push(idadeMaxima);
            log.info('Ineficiência líquida encontrada.', {
                idadeDasPernasMs: idades.join('/'),
                pernaMaisVelhaMs: idadeMaxima,
                suspeita:
                    idadeMaxima > 500
                        ? 'PROVÁVEL FANTASMA: uma perna está velha, o desalinhamento pode nunca ter existido simultaneamente'
                        : 'pernas frescas',
                triangulo: evaluation.triangleId,
                grossReturn: evaluation.grossReturn.toFixed(6),
                lucroLiquidoPct: evaluation.netProfitPct.toFixed(4),
                leg1: `${t.leg1} ask=${ob1.ask.toString()}`,
                leg2: `${t.leg2} ask=${ob2.ask.toString()}`,
                leg3: `${t.leg3} bid=${ob3.bid.toString()}`,
            });
        }
    }

    private printReport(): void {
        const uptimeSeconds = Math.floor((Date.now() - this.metrics.startTime) / 1000);
        const houveAvaliacao = this.metrics.avaliacoes > 0 && this.metrics.melhorLiquidoPct.isFinite();
        // A distância que falta para o melhor ciclo virar oportunidade. É o
        // número que transforma "zero oportunidades" em informação: faltando
        // 0,01% a resposta é esperar, faltando 5% a resposta é desistir.
        const faltam = houveAvaliacao ? this.metrics.melhorLiquidoPct.negated() : null;
        log.info('Relatório periódico.', {
            uptimeSegundos: uptimeSeconds,
            ticksProcessados: this.metrics.ticksProcessed,
            avaliacoesDeTriangulo: this.metrics.avaliacoes,
            oportunidadesLiquidas: this.metrics.opportunitiesFound,
            oportunidadesPorHora: uptimeSeconds > 0 ? ((this.metrics.opportunitiesFound / uptimeSeconds) * 3600).toFixed(2) : '0',
            melhorLiquidoVistoPct: houveAvaliacao ? this.metrics.melhorLiquidoPct.toFixed(4) : 'nenhuma avaliação ainda',
            melhorTriangulo: this.metrics.melhorLiquidoTriangulo || '—',
            faltaramPct:
                faltam === null ? '—' : faltam.greaterThan(0) ? faltam.toFixed(4) : 'JÁ PASSOU DO CUSTO',
            melhorBrutoVisto: this.metrics.melhorBruto.greaterThan(0) ? this.metrics.melhorBruto.toFixed(6) : '—',
            idadeMaximaAceita: `${MAX_LEG_AGE_MS}ms`,
            // Quantas oportunidades sobrevivem a exigências de simultaneidade
            // mais duras. Se todas somem a 500ms, todas eram fantasma.
            sobrevivemA: (() => {
                const idades = this.metrics.oportunidadesPorIdade;
                if (idades.length === 0) return 'nenhuma oportunidade ainda';
                return [200, 500, 1000]
                    .map((lim) => `${lim}ms: ${idades.filter((i) => i <= lim).length}/${idades.length}`)
                    .join(' | ');
            })(),
        });

        // As faixas mais próximas da linha, do melhor para o pior. É aqui que
        // se vê se existe cauda encostando ou se tudo está longe demais.
        const faixas = Array.from(this.histograma.entries())
            .sort((a, b) => b[0] - a[0])
            .slice(0, 8);
        if (faixas.length > 0) {
            const total = this.metrics.avaliacoes || 1;
            log.info('  Distribuição do lucro líquido (faixas mais próximas da linha).', {
                faixas: faixas
                    .map(([c, n]) => `${(c / 100).toFixed(2)}%: ${n} (${((n / total) * 100).toFixed(3)}%)`)
                    .join(' | '),
                acimaDeZero: (this.histograma.get(0) ?? 0) + faixas.filter(([c]) => c > 0).reduce((a, [, n]) => a + n, 0),
            });
        }
    }
}

async function main() {
    const sniffer = new OpportunitySniffer(TAKER_FEE, TARGET_NET_PROFIT, PARES_ISENTOS);
    await sniffer.initialize();

    const shutdown = () => {
        log.info('Encerrando sniffer...');
        sniffer.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha fatal no sniffer.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
