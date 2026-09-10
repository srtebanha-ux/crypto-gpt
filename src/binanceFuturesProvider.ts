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
        return String(Date.now() + this.offsetDoRelogioMs);
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
        const { serverTime } = await this.publico<{ serverTime: number }>('/fapi/v1/time');
        const rtt = Date.now() - antes;
        this.offsetDoRelogioMs = serverTime - (antes + rtt / 2);
        log.info('Relógio sincronizado com a Binance Futures.', { offsetMs: Math.round(this.offsetDoRelogioMs), rttMs: rtt });
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
    public async colocarSaida(params: {
        symbol: string;
        direcao: 'alta' | 'baixa';
        tipo: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
        precoGatilho: Decimal;
    }): Promise<number> {
        const r = await this.assinado<{ orderId: number }>('POST', '/fapi/v1/order', {
            symbol: params.symbol,
            // A saída é sempre o lado oposto ao da posição.
            side: params.direcao === 'alta' ? 'SELL' : 'BUY',
            type: params.tipo,
            stopPrice: params.precoGatilho.toString(),
            closePosition: 'true',
            workingType: 'MARK_PRICE',
            ...this.ladoDaPosicao(params.direcao),
        });
        return r.orderId;
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
