// Arquivo: src/binanceFuturesProvider.ts
//
// Conector do USDT-M Futures (/fapi). É um provider separado do Spot/Margem
// de propósito: o Futures não compartilha praticamente nada com eles além da
// assinatura HMAC. Carteira diferente, saldo diferente, filtros diferentes,
// endpoints diferentes, e — o que mais importa — uma noção de posição que o
// Spot não tem. No Spot "vender" é entregar o que se tem; aqui vender é
// ABRIR uma posição contrária, que existe até alguém fechá-la.
//
// Três decisões deste arquivo que não são óbvias:
//
//   * O STOP dispara por MARK PRICE, não por LAST PRICE. A Binance liquida
//     pelo mark price. Um stop no last price pode nunca disparar enquanto o
//     mark price cruza a liquidação — a posição morre pela corretora, com
//     taxa de liquidação por cima, e a ordem de stop fica lá, pendurada,
//     sem nunca ter sido acionada. Casar o gatilho do stop com o gatilho da
//     liquidação elimina essa janela inteira.
//
//   * Alvo e stop usam `closePosition=true` em vez de `reduceOnly` com
//     quantidade. Com quantidade, um preenchimento parcial na entrada deixa
//     as saídas dimensionadas para uma posição que não existe. Com
//     closePosition, a corretora fecha o que houver — e cancela a ordem
//     sozinha quando a posição zera, o que evita a ordem órfã que reabriria
//     posição na direção contrária.
//
//   * O modo de posição (one-way vs hedge) é LIDO, não presumido. Em hedge
//     mode toda ordem precisa de `positionSide`, e sem ele a Binance devolve
//     -4061 — um erro que não menciona hedge em lugar nenhum.
import { Decimal } from 'decimal.js';
import * as crypto from 'crypto';
import { createLogger } from './logger';
import { FaixaDeAlavancagem, FiltrosDeFuturos } from './futurosMath';
import { diagnosticarFalhaDeFuturos } from './futurosDiagnostico';
import { Vela1m } from './volumeSpike';

const log = createLogger('futuros');

/** Erro que já vem traduzido: quem captura não precisa reinterpretar códigos. */
export class ErroDeFuturos extends Error {
    constructor(
        message: string,
        public readonly codigo: number | undefined,
        public readonly httpStatus: number | undefined,
        public readonly comoResolver: string,
    ) {
        super(message);
        this.name = 'ErroDeFuturos';
    }
}

export interface OpcoesDoProviderDeFuturos {
    apiKey: string;
    apiSecret: string;
    /** Padrão: https://fapi.binance.com. Configurável porque o 451 por região existe. */
    restBaseUrl?: string;
    recvWindowMs?: number;
}

export interface SaldoDeFuturos {
    asset: string;
    saldo: Decimal;
    /** O que sobra depois da margem já trancada — é este que dimensiona a próxima ordem. */
    disponivel: Decimal;
}

export interface PosicaoDeFuturos {
    symbol: string;
    /** Positivo = comprado, negativo = vendido, zero = sem posição. */
    quantidade: Decimal;
    entrada: Decimal;
    marcacao: Decimal;
    lucroNaoRealizado: Decimal;
    precoDeLiquidacao: Decimal;
    alavancagem: Decimal;
}

export interface RespostaDeOrdem {
    orderId: number;
    status: string;
    quantidadeExecutada: Decimal;
    precoMedio: Decimal;
}

export class BinanceFuturesProvider {
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly restBaseUrl: string;
    private readonly recvWindowMs: number;
    private offsetDoRelogioMs = 0;
    private filtros = new Map<string, FiltrosDeFuturos>();
    /** null até o boot ler. Em hedge mode toda ordem precisa de positionSide. */
    private modoHedge: boolean | null = null;

    constructor(opcoes: OpcoesDoProviderDeFuturos) {
        this.apiKey = opcoes.apiKey;
        this.apiSecret = opcoes.apiSecret;
        this.restBaseUrl = opcoes.restBaseUrl ?? 'https://fapi.binance.com';
        this.recvWindowMs = opcoes.recvWindowMs ?? 5000;
    }

    // ------------------------------------------------------------------
    // Infraestrutura
    // ------------------------------------------------------------------
    private timestamp(): string {
        // Defesa em profundidade: se o offset virar NaN, o relógio local
        // sozinho ainda funciona. Um timestamp NaN faz a Binance responder
        // "malformed" em TODA chamada assinada, e essa mensagem não aponta
        // para o relógio — aponta para lugar nenhum.
        const offset = Number.isFinite(this.offsetDoRelogioMs) ? this.offsetDoRelogioMs : 0;
        return String(Date.now() + offset);
    }

    private assinar(params: Record<string, string>): string {
        const query = new URLSearchParams({ ...params, recvWindow: String(this.recvWindowMs) }).toString();
        const assinatura = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
        return `${query}&signature=${assinatura}`;
    }

    /**
     * Converte qualquer recusa da Binance num ErroDeFuturos já traduzido.
     * Centralizado porque a alternativa é cada chamada reinterpretar -2015
     * à sua maneira — e foi assim que o -3006 do motor de margem sobreviveu
     * a duas correções.
     */
    private async lancarTraduzido(res: Response, contexto: string): Promise<never> {
        let codigo: number | undefined;
        let mensagem: string | undefined;
        try {
            const corpo = (await res.json()) as { code?: number; msg?: string };
            codigo = corpo.code;
            mensagem = corpo.msg;
        } catch {
            mensagem = res.statusText;
        }
        const d = diagnosticarFalhaDeFuturos({ httpStatus: res.status, codigo, mensagem });
        throw new ErroDeFuturos(`${contexto}: ${mensagem ?? res.statusText}`, codigo, res.status, d.comoResolver);
    }

    private async publico<T>(rota: string, params?: Record<string, string>): Promise<T> {
        const query = params ? `?${new URLSearchParams(params).toString()}` : '';
        const res = await fetch(`${this.restBaseUrl}${rota}${query}`);
        if (!res.ok) await this.lancarTraduzido(res, `GET ${rota}`);
        return (await res.json()) as T;
    }

    private async assinado<T>(
        metodo: 'GET' | 'POST' | 'DELETE' | 'PUT',
        rota: string,
        params: Record<string, string> = {},
    ): Promise<T> {
        const query = this.assinar({ ...params, timestamp: this.timestamp() });
        const res = await fetch(`${this.restBaseUrl}${rota}?${query}`, {
            method: metodo,
            headers: { 'X-MBX-APIKEY': this.apiKey },
        });
        if (!res.ok) await this.lancarTraduzido(res, `${metodo} ${rota}`);
        return (await res.json()) as T;
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------
    /** Sincroniza o relógio. Sem isto, -1021 aparece em máquinas com drift. */
    public async sincronizarRelogio(): Promise<void> {
        const antes = Date.now();
        const resposta = await this.publico<{ serverTime?: number }>('/fapi/v1/time');
        const rtt = Date.now() - antes;

        // Valida ANTES de usar. Sem isto, uma resposta fora do formato — um
        // erro transitório, uma página de proxy, um campo renomeado — faz
        // `undefined - número` virar NaN e envenenar o offset de forma
        // permanente. O sintoma aparece longe daqui: toda chamada assinada
        // passa a falhar com "timestamp malformed", que não menciona relógio.
        const serverTime = Number(resposta?.serverTime);
        if (!Number.isFinite(serverTime) || serverTime <= 0) {
            log.warn('Resposta de /fapi/v1/time sem serverTime utilizável; mantendo relógio local.', {
                recebido: JSON.stringify(resposta).slice(0, 200),
            });
            this.offsetDoRelogioMs = 0;
            return;
        }

        const offset = serverTime - (antes + rtt / 2);
        // Um offset absurdo é sinal de resposta errada, não de relógio errado:
        // nenhuma máquina razoável está horas fora, e adotar o número faria
        // todas as ordens caírem fora da recvWindow.
        if (Math.abs(offset) > 60_000) {
            log.warn('Offset de relógio implausível; ignorando.', { offsetMs: Math.round(offset), rttMs: rtt });
            this.offsetDoRelogioMs = 0;
            return;
        }

        this.offsetDoRelogioMs = offset;
        log.info('Relógio sincronizado com a Binance Futures.', { offsetMs: Math.round(offset), rttMs: rtt });
    }

    /** Carrega os filtros de TODOS os símbolos USDT perpétuos negociáveis. */
    public async carregarFiltros(): Promise<void> {
        interface Simbolo {
            symbol: string;
            status: string;
            contractType: string;
            quoteAsset: string;
            filters: Array<Record<string, string>>;
        }
        const info = await this.publico<{ symbols: Simbolo[] }>('/fapi/v1/exchangeInfo');
        this.filtros.clear();
        for (const s of info.symbols) {
            if (s.status !== 'TRADING' || s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT') continue;
            const preco = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
            const lote = s.filters.find((f) => f.filterType === 'LOT_SIZE');
            const nocional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
            if (!preco || !lote) continue;
            this.filtros.set(s.symbol, {
                tickSize: new Decimal(preco.tickSize),
                stepSize: new Decimal(lote.stepSize),
                minQty: new Decimal(lote.minQty),
                minNotional: new Decimal(nocional?.notional ?? '5'),
            });
        }
        log.info('Filtros de Futuros carregados.', { simbolos: this.filtros.size });
    }

    public filtrosDe(symbol: string): FiltrosDeFuturos | undefined {
        return this.filtros.get(symbol);
    }

    public simbolosDisponiveis(): string[] {
        return [...this.filtros.keys()];
    }

    /**
     * Lê o modo de posição. Em hedge mode toda ordem precisa de positionSide,
     * e a ausência dele devolve -4061 sem citar a palavra "hedge".
     */
    public async carregarModoDePosicao(): Promise<boolean> {
        const r = await this.assinado<{ dualSidePosition: boolean }>('GET', '/fapi/v1/positionSide/dual');
        this.modoHedge = r.dualSidePosition === true;
        if (this.modoHedge) {
            log.warn('Conta em HEDGE MODE: toda ordem carrega positionSide.', {});
        }
        return this.modoHedge;
    }

    // ------------------------------------------------------------------
    // Conta
    // ------------------------------------------------------------------
    public async saldos(): Promise<SaldoDeFuturos[]> {
        interface Cru {
            asset: string;
            balance: string;
            availableBalance: string;
        }
        const cru = await this.assinado<Cru[]>('GET', '/fapi/v2/balance');
        return cru.map((c) => ({
            asset: c.asset,
            saldo: new Decimal(c.balance),
            disponivel: new Decimal(c.availableBalance),
        }));
    }

    /** O que sobra em USDT para dimensionar a próxima posição. */
    public async disponivelEmUsdt(): Promise<Decimal> {
        const s = (await this.saldos()).find((x) => x.asset === 'USDT');
        return s ? s.disponivel : new Decimal(0);
    }

    /**
     * Posições ABERTAS de verdade, lidas da corretora.
     *
     * "Uma posição por vez" tem de ser verificado aqui, não no estado local:
     * o estado local não sobrevive a um restart do Railway, e um restart com
     * posição aberta que o motor não conhece é exatamente como se abre a
     * segunda posição sem querer.
     */
    public async posicoesAbertas(): Promise<PosicaoDeFuturos[]> {
        interface Cru {
            symbol: string;
            positionAmt: string;
            entryPrice: string;
            markPrice: string;
            unRealizedProfit: string;
            liquidationPrice: string;
            leverage: string;
        }
        const cru = await this.assinado<Cru[]>('GET', '/fapi/v2/positionRisk');
        return cru
            .filter((p) => !new Decimal(p.positionAmt).isZero())
            .map((p) => ({
                symbol: p.symbol,
                quantidade: new Decimal(p.positionAmt),
                entrada: new Decimal(p.entryPrice),
                marcacao: new Decimal(p.markPrice),
                lucroNaoRealizado: new Decimal(p.unRealizedProfit),
                precoDeLiquidacao: new Decimal(p.liquidationPrice),
                alavancagem: new Decimal(p.leverage),
            }));
    }

    /**
     * Velas de 1 minuto por REST.
     *
     * Existe porque o WebSocket deste ambiente entrega o handshake, responde
     * ping, aceita SUBSCRIBE — e nunca entrega um frame de dado. Foram
     * descartados, um a um: formato do nome do stream, endpoint combinado
     * versus simples, mecanismo de assinatura e compressão de frames. O que
     * resta é o transporte, e nenhuma linha de código nosso conserta isso.
     *
     * O REST custa latência (segundos em vez de milissegundos) e não custa
     * nada em qualidade de MEDIÇÃO: a grade avalia caminhos a partir de velas
     * FECHADAS, e uma vela fechada é idêntica venha de onde vier. Para operar
     * de verdade a latência importa; para descobrir se existe vantagem, não.
     *
     * A última vela do retorno é a EM FORMAÇÃO quando o seu fechamento ainda
     * está no futuro — a mesma distinção que o campo `x` faz no stream.
     */
    public async klines(symbol: string, limite = 21): Promise<{ fechadas: Vela1m[]; emFormacao: Vela1m | null }> {
        const cru = await this.publico<Array<[number, string, string, string, string, string, number, ...unknown[]]>>(
            '/fapi/v1/klines',
            { symbol, interval: '1m', limit: String(limite) },
        );
        const agora = Date.now();
        const fechadas: Vela1m[] = [];
        let emFormacao: Vela1m | null = null;

        for (const linha of cru) {
            const vela: Vela1m = {
                aberturaMs: Number(linha[0]),
                abertura: new Decimal(linha[1]),
                maxima: new Decimal(linha[2]),
                minima: new Decimal(linha[3]),
                fechamento: new Decimal(linha[4]),
                volume: new Decimal(linha[5]),
            };
            if (Number(linha[6]) > agora) emFormacao = vela;
            else fechadas.push(vela);
        }
        return { fechadas, emFormacao };
    }

    /**
     * Preço de TODOS os perpétuos numa chamada. Peso 2 — duas velas.
     *
     * É o que torna a varredura do mercado inteiro mais barata que vigiar
     * quinze pares um a um, e é onde a frequência de eventos deixa de ser o
     * gargalo da estratégia.
     */
    public async precosDeTodos(): Promise<Map<string, Decimal>> {
        const cru = await this.publico<Array<{ symbol: string; price: string }>>('/fapi/v1/ticker/price');
        const mapa = new Map<string, Decimal>();
        for (const t of cru) {
            if (!this.filtros.has(t.symbol)) continue;
            const p = new Decimal(t.price);
            if (p.greaterThan(0)) mapa.set(t.symbol, p);
        }
        return mapa;
    }

    /**
     * Preço de MARCAÇÃO de um símbolo só — para o vigia rápido do stop.
     *
     * É o mesmo preço com que a corretora dispararia o stop dela, e não o
     * último negócio: um negócio solto fora do livro não deve fechar posição.
     *
     * Vem do endereço PÚBLICO (peso 1, sem assinatura) em vez de sair do
     * positionRisk (peso 5, assinado) porque o vigia roda de dois em dois
     * segundos enquanto houver posição sem stop na corretora. Peso 5 a cada
     * 2s seriam 150 por minuto para ler um número que o público entrega por
     * 30 — e, sem assinatura, ainda fica imune à falha intermitente de
     * timestamp que aparece no boot.
     */
    public async marcacaoDe(symbol: string): Promise<Decimal> {
        const r = await this.publico<{ markPrice: string }>('/fapi/v1/premiumIndex', { symbol });
        return new Decimal(r.markPrice);
    }

    /**
     * Histórico curto de Open Interest — a impressão digital da liquidação.
     *
     * Vem por REST porque o stream !forceOrder@arr, que mostraria as
     * liquidações uma a uma, é WebSocket — e o WebSocket deste ambiente não
     * entrega dado (ver a nota em klines). O OI é a mesma informação com
     * granularidade mais grossa: se posições SUMIRAM enquanto o preço caía,
     * alguém foi fechado à força. Não diz quem nem quanto de cada vez; diz o
     * que importa, que é se houve destruição de posição ou criação dela.
     *
     * period '5m' com limit 2 devolve o antes e o agora — o suficiente para
     * classificar o regime sem carregar histórico de símbolo nenhum.
     */
    public async historicoDeOpenInterest(symbol: string, limite = 2): Promise<Array<{ emMs: number; oi: Decimal }>> {
        const cru = await this.publico<Array<{ sumOpenInterest: string; timestamp: number }>>(
            '/futures/data/openInterestHist',
            { symbol, period: '5m', limit: String(limite) },
        );
        return cru.map((c) => ({ emMs: Number(c.timestamp), oi: new Decimal(c.sumOpenInterest) }));
    }

    /** Funding corrente do par — o combustível da cascata (ver tensao.ts). */
    public async fundingAtual(symbol: string): Promise<Decimal> {
        const cru = await this.publico<{ lastFundingRate: string }>('/fapi/v1/premiumIndex', { symbol });
        return new Decimal(cru.lastFundingRate ?? '0');
    }

    /** Estatísticas 24h de todos os perpétuos — a base para escolher o universo. */
    public async tickers24h(): Promise<Array<{ symbol: string; variacaoPct: Decimal; volumeUsdt: Decimal; ultimo: Decimal }>> {
        interface Cru {
            symbol: string;
            priceChangePercent: string;
            quoteVolume: string;
            lastPrice: string;
        }
        const cru = await this.publico<Cru[]>('/fapi/v1/ticker/24hr');
        return cru
            .filter((t) => this.filtros.has(t.symbol))
            .map((t) => ({
                symbol: t.symbol,
                variacaoPct: new Decimal(t.priceChangePercent),
                volumeUsdt: new Decimal(t.quoteVolume),
                ultimo: new Decimal(t.lastPrice),
            }));
    }

    public async faixasDeAlavancagem(symbol: string): Promise<FaixaDeAlavancagem[]> {
        interface Cru {
            symbol: string;
            brackets: Array<{ notionalCap: number; initialLeverage: number; maintMarginRatio: number }>;
        }
        const cru = await this.assinado<Cru[]>('GET', '/fapi/v1/leverageBracket', { symbol });
        const doSimbolo = cru.find((c) => c.symbol === symbol) ?? cru[0];
        if (!doSimbolo) return [];
        return doSimbolo.brackets.map((b) => ({
            nocionalMaximo: new Decimal(b.notionalCap),
            alavancagemMaxima: new Decimal(b.initialLeverage),
            manutencao: new Decimal(b.maintMarginRatio),
        }));
    }

    public async definirAlavancagem(symbol: string, alavancagem: number): Promise<void> {
        await this.assinado('POST', '/fapi/v1/leverage', { symbol, leverage: String(alavancagem) });
    }

    /**
     * ISOLATED limita a liquidação à margem daquela posição; CROSSED expõe a
     * carteira inteira. A Binance devolve -4046 quando já está no modo
     * pedido — isso é sucesso, não falha.
     */
    public async definirTipoDeMargem(symbol: string, tipo: 'ISOLATED' | 'CROSSED'): Promise<void> {
        try {
            await this.assinado('POST', '/fapi/v1/marginType', { symbol, marginType: tipo });
        } catch (err) {
            if (err instanceof ErroDeFuturos && err.codigo === -4046) return; // já estava assim
            throw err;
        }
    }

    // ------------------------------------------------------------------
    // Ordens
    // ------------------------------------------------------------------
    private ladoDaPosicao(direcao: 'alta' | 'baixa'): Record<string, string> {
        if (this.modoHedge !== true) return {};
        return { positionSide: direcao === 'alta' ? 'LONG' : 'SHORT' };
    }

    /** Entrada a mercado. Taker por definição: a especificação pede velocidade, não preço. */
    public async entrarAMercado(params: {
        symbol: string;
        direcao: 'alta' | 'baixa';
        quantidade: Decimal;
    }): Promise<RespostaDeOrdem> {
        const r = await this.assinado<{ orderId: number; status: string; executedQty: string; avgPrice: string }>(
            'POST',
            '/fapi/v1/order',
            {
                symbol: params.symbol,
                side: params.direcao === 'alta' ? 'BUY' : 'SELL',
                type: 'MARKET',
                quantity: params.quantidade.toString(),
                newOrderRespType: 'RESULT',
                ...this.ladoDaPosicao(params.direcao),
            },
        );
        return {
            orderId: r.orderId,
            status: r.status,
            quantidadeExecutada: new Decimal(r.executedQty ?? '0'),
            precoMedio: new Decimal(r.avgPrice ?? '0'),
        };
    }

    /**
     * Uma das duas ordens de saída. `closePosition=true` fecha o que houver e
     * se cancela sozinha quando a posição zera — nunca vira ordem órfã capaz
     * de reabrir posição na direção contrária.
     *
     * `workingType: MARK_PRICE` casa o gatilho com o da liquidação. Ver o
     * cabeçalho deste arquivo.
     */
    /**
     * Alvo como ordem LIMITADA parada no livro — ou seja, MAKER.
     *
     * Taker custa 0,05% (0,045% com BNB); maker custa 0,02% (0,018%). Numa
     * perna, isso é 60% menos taxa; na ida e volta de um scalp, derruba o
     * custo total de 0,090% para 0,063%. Como a taxa entra DUAS vezes na
     * conta — encolhe o ganho e engorda a perda —, esses 0,027pp movem o
     * acerto exigido em torno de 2 pontos percentuais. É a melhoria mais
     * barata que existe: não depende de acertar mais nada.
     *
     * `reduceOnly` é o que torna isso seguro: uma ordem limitada pendurada
     * jamais pode ABRIR posição contrária se a posição já tiver fechado pelo
     * stop — ela só reduz, e vira no-op quando não há o que reduzir.
     *
     * O stop continua a mercado, e continua tendo de ser: uma ordem limitada
     * de stop pode não preencher, e não sair de uma posição a 30x é pior do
     * que sair caro.
     */
    public async colocarAlvoMaker(params: {
        symbol: string;
        direcao: 'alta' | 'baixa';
        preco: Decimal;
        quantidade: Decimal;
    }): Promise<number> {
        const r = await this.assinado<{ orderId: number }>('POST', '/fapi/v1/order', {
            symbol: params.symbol,
            side: params.direcao === 'alta' ? 'SELL' : 'BUY',
            type: 'LIMIT',
            price: params.preco.toString(),
            quantity: params.quantidade.abs().toString(),
            // GTX = post-only: a Binance RECUSA a ordem se ela fosse executar
            // na hora. Sem isso, um preço já ultrapassado viraria taker e
            // pagaria justamente a taxa que esta função existe para evitar.
            timeInForce: 'GTX',
            reduceOnly: 'true',
            ...this.ladoDaPosicao(params.direcao),
        });
        return r.orderId;
    }

    public async colocarSaida(params: {
        symbol: string;
        direcao: 'alta' | 'baixa';
        tipo: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
        precoGatilho: Decimal;
        /** Necessária para o plano B, quando closePosition é recusado. */
        quantidade?: Decimal;
    }): Promise<number> {
        const comuns = {
            symbol: params.symbol,
            // A saída é sempre o lado oposto ao da posição.
            side: (params.direcao === 'alta' ? 'SELL' : 'BUY') as 'SELL' | 'BUY',
            type: params.tipo,
            stopPrice: params.precoGatilho.toString(),
            workingType: 'MARK_PRICE',
            ...this.ladoDaPosicao(params.direcao),
        };

        try {
            // Preferido: closePosition fecha o que houver e se cancela sozinho
            // quando a posição zera, então nunca vira ordem órfã.
            const r = await this.assinado<{ orderId: number }>('POST', '/fapi/v1/order', {
                ...comuns,
                closePosition: 'true',
            });
            return r.orderId;
        } catch (err) {
            // Plano B para contas que recusam closePosition.
            //
            // Alguns modos de conta respondem -4120 ("use the Algo Order API
            // endpoints") a uma ordem condicional com closePosition — e o
            // resultado prático é catastrófico: a entrada preenche, o stop não
            // entra, e o motor precisa fechar de emergência a cada sinal,
            // pagando taxa sem nunca poder ganhar.
            //
            // reduceOnly com quantidade explícita faz o mesmo trabalho e passa
            // onde closePosition não passa. É pior num aspecto: não se cancela
            // sozinha, então depende do cancelarTudo que já roda antes de cada
            // entrada e no fechamento. Pior que o ideal, muito melhor que não
            // ter stop.
            const codigo = err instanceof ErroDeFuturos ? err.codigo : undefined;
            if (codigo !== -4120 || !params.quantidade || params.quantidade.lessThanOrEqualTo(0)) throw err;

            log.warn('closePosition recusado; recolocando a saída com reduceOnly.', {
                symbol: params.symbol,
                tipo: params.tipo,
                codigo,
            });
            const r = await this.assinado<{ orderId: number }>('POST', '/fapi/v1/order', {
                ...comuns,
                quantity: params.quantidade.abs().toString(),
                reduceOnly: 'true',
            });
            return r.orderId;
        }
    }

    /**
     * O modo de margem da conta, dito pela própria Binance.
     *
     * Sai no boot para não ter de adivinhar: erros como -4168 e -4120 mudam de
     * causa conforme o modo, e olhar um painel de configuração é lento e
     * falível. Uma linha no log resolve.
     */
    public async modoMultiAtivos(): Promise<boolean | null> {
        try {
            const r = await this.assinado<{ multiAssetsMargin: boolean }>('GET', '/fapi/v1/multiAssetsMargin');
            return Boolean(r.multiAssetsMargin);
        } catch {
            return null;
        }
    }

    /**
     * Fecha a mercado agora. É o caminho de emergência: se o stop falhar ao
     * ser colocado depois de a entrada preencher, a posição a 30x fica nua, e
     * posição nua a 30x é a única falha sem recuperação possível.
     */
    public async fecharAMercado(params: { symbol: string; direcao: 'alta' | 'baixa'; quantidade: Decimal }): Promise<RespostaDeOrdem> {
        const r = await this.assinado<{ orderId: number; status: string; executedQty: string; avgPrice: string }>(
            'POST',
            '/fapi/v1/order',
            {
                symbol: params.symbol,
                side: params.direcao === 'alta' ? 'SELL' : 'BUY',
                type: 'MARKET',
                quantity: params.quantidade.abs().toString(),
                reduceOnly: 'true',
                newOrderRespType: 'RESULT',
                ...this.ladoDaPosicao(params.direcao),
            },
        );
        return {
            orderId: r.orderId,
            status: r.status,
            quantidadeExecutada: new Decimal(r.executedQty ?? '0'),
            precoMedio: new Decimal(r.avgPrice ?? '0'),
        };
    }

    /** Limpa ordens pendentes do símbolo — chamado antes de entrar e depois de sair. */
    public async cancelarTudo(symbol: string): Promise<void> {
        try {
            await this.assinado('DELETE', '/fapi/v1/allOpenOrders', { symbol });
        } catch (err) {
            // -2011 "Unknown order sent" quando não havia nada: não é falha.
            if (err instanceof ErroDeFuturos && err.codigo === -2011) return;
            throw err;
        }
    }

    /** Testa a permissão de Futuros da chave sem enviar ordem nenhuma. */
    public async temPermissaoDeFuturos(): Promise<boolean> {
        try {
            await this.saldos();
            return true;
        } catch (err) {
            if (err instanceof ErroDeFuturos && (err.codigo === -2015 || err.codigo === -2014)) return false;
            throw err;
        }
    }
}
