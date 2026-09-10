// Arquivo: src/scalpingLive.ts
//
// Motor de Scalping Direcional no USDT-M Futures.
//
// A regra que organiza tudo aqui: uma posição a 30x sem stop é a única falha
// deste sistema que não tem recuperação. Um sinal perdido custa uma
// oportunidade; uma entrada ruim custa 0,4% da posição; uma posição nua a 30x
// custa a conta. Por isso a sequência de entrada é escrita de trás para a
// frente — a pergunta não é "como entro rápido", é "o que acontece se cada
// passo falhar depois de eu já estar dentro".
//
// Daí as três regras que não são configuráveis:
//
//   1. Se o STOP falhar ao ser colocado depois de a entrada preencher, a
//      posição é fechada a mercado IMEDIATAMENTE. Não há retentativa: cada
//      milissegundo com a posição nua é risco puro, e a taxa de fechar é
//      barata perto do que se está evitando.
//   2. "Uma posição por vez" é verificado NA CORRETORA, não no estado local.
//      O estado local não sobrevive a um restart do Railway, e um restart com
//      posição aberta que o motor não conhece é exatamente como se abre a
//      segunda posição sem querer.
//   3. Alvo e stop saem do preço REALMENTE EXECUTADO, nunca do preço do
//      sinal. A mercado, a 30x, a diferença entre os dois já é uma fração
//      relevante do alvo de 0,3%.
//
// E um guarda que se pode desligar, mas só de propósito: o motor RECUSA ligar
// quando a configuração exige uma taxa de acerto que não existe no mundo real
// (ver scalping.ts). A configuração +0,3% / −0,4% exige 70%.
import { Decimal } from 'decimal.js';
import WebSocket from 'ws';
import { createLogger } from './logger';
import { BinanceFuturesProvider, ErroDeFuturos } from './binanceFuturesProvider';
import { avaliarProntidao } from './futurosDiagnostico';
import {
    alavancagemPermitida,
    fracaoDaBancaEmMargem,
    margemNecessaria,
    quantidadeParaNocional,
    saidasNaGrade,
    stopAntesDaLiquidacao,
} from './futurosMath';
import { veredictoDeScalping } from './scalping';
import { detectarPicoDeVolume, precosDeSaida, Vela1m } from './volumeSpike';
import { selecionarUniverso } from './universo';
import { ControleDeVazao } from './rateLimiter';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const log = createLogger('scalping');

const FRASE_DE_CONFIRMACAO = 'I_UNDERSTAND_THE_RISK';
const FRASE_DE_OVERRIDE = 'EU_ASSUMO_O_PREJUIZO';
/** Quantas velas fechadas guardar por símbolo para calcular a média de volume. */
const VELAS_DE_HISTORICO = 20;

interface Configuracao {
    alavancagem: Decimal;
    alvo: Decimal;
    stop: Decimal;
    taxaPorPerna: Decimal;
    acertoRealista: Decimal;
    nocionalFixo: Decimal;
    fracaoDaBanca: Decimal;
    multiplicadorDeVolume: Decimal;
    variacaoMinima: Decimal;
    tamanhoDoUniverso: number;
    volumeMinimo24h: Decimal;
    tipoDeMargem: 'ISOLATED' | 'CROSSED';
    timeStopMs: number;
    aoVivo: boolean;
}

function lerConfiguracao(): Configuracao {
    return {
        alavancagem: new Decimal(process.env.SCALPING_LEVERAGE ?? '30'),
        alvo: new Decimal(process.env.SCALPING_ALVO_PCT ?? '0.3').dividedBy(100),
        stop: new Decimal(process.env.SCALPING_STOP_PCT ?? '0.4').dividedBy(100),
        // Taker de Futuros: 0,05%; 0,045% com desconto de BNB.
        taxaPorPerna: new Decimal(process.env.SCALPING_TAXA_PERNA ?? '0.0005'),
        acertoRealista: new Decimal(process.env.SCALPING_ACERTO_REALISTA ?? '0.55'),
        nocionalFixo: new Decimal(process.env.SCALPING_NOTIONAL_USDT ?? '0'),
        fracaoDaBanca: new Decimal(process.env.SCALPING_FRACAO_DA_BANCA ?? '0.9'),
        multiplicadorDeVolume: new Decimal(process.env.SCALPING_MULTIPLICADOR_VOLUME ?? '3'),
        variacaoMinima: new Decimal(process.env.SCALPING_VARIACAO_MINIMA_PCT ?? '0.1').dividedBy(100),
        tamanhoDoUniverso: Number(process.env.SCALPING_UNIVERSO ?? '15'),
        volumeMinimo24h: new Decimal(process.env.SCALPING_VOLUME_MINIMO_24H ?? '50000000'),
        tipoDeMargem: (process.env.SCALPING_MARGIN_TYPE as 'ISOLATED' | 'CROSSED') ?? 'ISOLATED',
        timeStopMs: Number(process.env.SCALPING_TIME_STOP_MIN ?? '0') * 60_000,
        aoVivo: process.env.SCALPING_LIVE_CONFIRM === FRASE_DE_CONFIRMACAO,
    };
}

interface JanelaDoSimbolo {
    fechadas: Vela1m[];
    emFormacao: Vela1m | null;
    /** Momento do último evento recebido — define quantos segundos a vela em formação já viveu. */
    eventoMs: number;
}

interface PosicaoViva {
    symbol: string;
    direcao: 'alta' | 'baixa';
    quantidade: Decimal;
    entrada: Decimal;
    abertaEmMs: number;
}

class MotorDeScalping {
    private readonly cfg: Configuracao;
    private readonly provider: BinanceFuturesProvider;
    private readonly janelas = new Map<string, JanelaDoSimbolo>();
    private readonly vazao = new ControleDeVazao({ capacidade: 2400, janelaMs: 60_000, nome: 'fapi' });
    private universo: string[] = [];
    private ws: WebSocket | null = null;
    private tentativasDeReconexao = 0;
    /** Trava de reentrância: mensagens de kline chegam várias por segundo. */
    private ocupado = false;
    private posicao: PosicaoViva | null = null;
    private placar = { entradas: 0, alvos: 0, stops: 0, emergencias: 0 };

    constructor(cfg: Configuracao, provider: BinanceFuturesProvider) {
        this.cfg = cfg;
        this.provider = provider;
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------
    /**
     * O veredicto vem ANTES de qualquer conexão. Descobrir que a configuração
     * é inviável depois de trinta operações é caro; descobrir agora é grátis.
     */
    private conferirViabilidade(): void {
        const v = veredictoDeScalping({
            configuracao: { alvo: this.cfg.alvo, stop: this.cfg.stop, taxaPorPerna: this.cfg.taxaPorPerna },
            acertoRealista: this.cfg.acertoRealista,
        });

        if (v.viavel) {
            log.info('Aritmética aprovada.', { motivo: v.motivo });
            return;
        }

        log.error('CONFIGURAÇÃO REPROVADA NA ARITMÉTICA.', {
            motivo: v.motivo,
            acertoExigido: `${v.aritmetica.acertoMinimo.mul(100).toFixed(1)}%`,
            acertoAssumido: `${this.cfg.acertoRealista.mul(100).toFixed(1)}%`,
            alvoQueFecharia: v.alvoQueFecharia ? `${v.alvoQueFecharia.mul(100).toFixed(3)}%` : 'nenhum',
            stopAtual: `${this.cfg.stop.mul(100).toFixed(3)}%`,
        });

        if (process.env.SCALPING_IGNORAR_VEREDICTO === FRASE_DE_OVERRIDE) {
            log.warn('Veredicto ignorado por SCALPING_IGNORAR_VEREDICTO. Decisão consciente do operador.', {});
            return;
        }

        log.error(
            'Motor NÃO vai ligar. Para operar assim mesmo, defina ' +
                `SCALPING_IGNORAR_VEREDICTO=${FRASE_DE_OVERRIDE}.`,
            {},
        );
        process.exit(1);
    }

    public async iniciar(): Promise<void> {
        this.conferirViabilidade();

        await this.provider.sincronizarRelogio();
        await this.provider.carregarFiltros();

        const temPermissao = await this.provider.temPermissaoDeFuturos();
        const disponivel = temPermissao ? await this.provider.disponivelEmUsdt() : new Decimal(0);
        const nocional = this.dimensionarNocional(disponivel);

        const prontidao = avaliarProntidao({
            permissaoDeFuturos: temPermissao,
            saldoDisponivel: disponivel.toNumber(),
            margemNecessaria: margemNecessaria({ nocional, alavancagem: this.cfg.alavancagem }).toNumber(),
        });

        if (!prontidao.pronto) {
            log.error('Pré-requisitos de Futuros não atendidos. Nada será enviado.', {});
            prontidao.pendencias.forEach((p, i) => log.error(`  ${i + 1}. ${p}`, {}));
            process.exit(1);
        }

        await this.provider.carregarModoDePosicao();
        await this.adotarPosicaoExistente();

        const fracao = fracaoDaBancaEmMargem({ nocional, alavancagem: this.cfg.alavancagem, banca: disponivel });
        log.info('Motor de scalping pronto.', {
            modo: this.cfg.aoVivo ? 'AO VIVO (ordens reais)' : 'OBSERVAÇÃO (nenhuma ordem)',
            saldoDisponivel: `${disponivel.toFixed(2)} USDT`,
            nocional: `${nocional.toFixed(2)} USDT`,
            alavancagem: `${this.cfg.alavancagem.toFixed(0)}x`,
            margemTrancada: `${margemNecessaria({ nocional, alavancagem: this.cfg.alavancagem }).toFixed(2)} USDT`,
            fracaoDaBanca: `${fracao.mul(100).toFixed(1)}%`,
            tipoDeMargem: this.cfg.tipoDeMargem,
        });

        if (fracao.greaterThanOrEqualTo(1)) {
            log.warn(
                'A margem consome a banca INTEIRA. Não sobra nada para taxa nem para uma segunda posição, ' +
                    'e uma liquidação zera a conta.',
                {},
            );
        }

        await this.reescolherUniverso();
        this.conectar();
        setInterval(() => void this.rotinaPeriodica(), 15_000);
    }

    /**
     * Uma posição aberta na corretora que o motor não conhece existe depois de
     * todo restart. Adotá-la é a diferença entre gerenciá-la e abrir uma
     * segunda por cima.
     */
    private async adotarPosicaoExistente(): Promise<void> {
        const abertas = await this.provider.posicoesAbertas();
        if (abertas.length === 0) return;

        const p = abertas[0];
        this.posicao = {
            symbol: p.symbol,
            direcao: p.quantidade.isPositive() ? 'alta' : 'baixa',
            quantidade: p.quantidade.abs(),
            entrada: p.entrada,
            abertaEmMs: Date.now(),
        };
        log.warn('Posição JÁ ABERTA adotada da corretora.', {
            symbol: p.symbol,
            lado: this.posicao.direcao,
            quantidade: p.quantidade.toString(),
            entrada: p.entrada.toString(),
            liquidacao: p.precoDeLiquidacao.toString(),
        });
        if (abertas.length > 1) {
            log.error('MAIS DE UMA posição aberta na conta. O modo sniper assume uma; gerencie as outras à mão.', {
                simbolos: abertas.map((x) => x.symbol).join(','),
            });
        }
    }

    private dimensionarNocional(disponivel: Decimal): Decimal {
        if (this.cfg.nocionalFixo.greaterThan(0)) return this.cfg.nocionalFixo;
        // Sem nocional fixo, o tamanho sai do que a conta REALMENTE tem — é o
        // que impede a ordem de US$ 750 numa carteira de US$ 8.
        return disponivel.mul(this.cfg.fracaoDaBanca).mul(this.cfg.alavancagem);
    }

    // ------------------------------------------------------------------
    // Universo e WebSocket
    // ------------------------------------------------------------------
    private async reescolherUniverso(): Promise<void> {
        const tickers = await this.provider.tickers24h();
        const novo = selecionarUniverso({
            candidatos: tickers.map((t) => ({ symbol: t.symbol, variacao24h: t.variacaoPct, volumeQuote: t.volumeUsdt })),
            quantidade: this.cfg.tamanhoDoUniverso,
            volumeMinimo: this.cfg.volumeMinimo24h,
            comPosicao: this.posicao ? [this.posicao.symbol] : [],
        });
        const mudou = novo.join(',') !== this.universo.join(',');
        this.universo = novo;
        if (mudou) log.info('Universo atualizado.', { simbolos: novo.join(',') });
    }

    private conectar(): void {
        const base = process.env.FUTURES_WS_URL ?? 'wss://fstream.binance.com';
        const streams = this.universo.map((s) => `${s.toLowerCase()}@kline_1m`).join('/');
        const url = `${base}/stream?streams=${streams}`;

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            this.tentativasDeReconexao = 0;
            log.info('WebSocket de klines conectado.', { simbolos: this.universo.length });
        });

        this.ws.on('message', (bruto: WebSocket.RawData) => {
            try {
                this.processarKline(JSON.parse(bruto.toString()));
            } catch (err) {
                log.warn('Mensagem de kline malformada.', { erro: err instanceof Error ? err.message : String(err) });
            }
        });

        this.ws.on('error', (err) => log.warn('Erro no WebSocket.', { erro: err.message }));
        this.ws.on('close', () => {
            const espera = Math.min(30_000, 1000 * 2 ** this.tentativasDeReconexao++);
            log.warn('WebSocket caiu; reconectando.', { emMs: espera });
            setTimeout(() => this.conectar(), espera);
        });
    }

    private processarKline(msg: unknown): void {
        const envelope = msg as { data?: { E?: number; k?: Record<string, string | number | boolean> } };
        const k = envelope.data?.k;
        if (!k) return;

        const symbol = String(k.s);
        const vela: Vela1m = {
            aberturaMs: Number(k.t),
            abertura: new Decimal(String(k.o)),
            maxima: new Decimal(String(k.h)),
            minima: new Decimal(String(k.l)),
            fechamento: new Decimal(String(k.c)),
            volume: new Decimal(String(k.v)),
        };

        const janela = this.janelas.get(symbol) ?? { fechadas: [], emFormacao: null, eventoMs: 0 };
        janela.eventoMs = Number(envelope.data?.E ?? Date.now());

        if (k.x === true) {
            janela.fechadas.push(vela);
            if (janela.fechadas.length > VELAS_DE_HISTORICO) janela.fechadas.shift();
            janela.emFormacao = null;
        } else {
            janela.emFormacao = vela;
        }
        this.janelas.set(symbol, janela);

        if (janela.emFormacao) void this.avaliar(symbol, janela);
    }

    // ------------------------------------------------------------------
    // Detecção
    // ------------------------------------------------------------------
    private async avaliar(symbol: string, janela: JanelaDoSimbolo): Promise<void> {
        if (this.posicao !== null || this.ocupado) return; // modo sniper: uma por vez
        if (!janela.emFormacao) return;

        const decorridos = Math.min(60, Math.max(0, (janela.eventoMs - janela.emFormacao.aberturaMs) / 1000));
        const sinal = detectarPicoDeVolume({
            velasFechadas: janela.fechadas,
            emFormacao: janela.emFormacao,
            segundosDecorridos: decorridos,
            multiplicador: this.cfg.multiplicadorDeVolume,
            variacaoMinima: this.cfg.variacaoMinima,
        });
        if (!sinal) return;

        log.info('PICO DE VOLUME.', {
            symbol,
            direcao: sinal.direcao,
            volume: `${sinal.multiploDoVolume.toFixed(2)}x`,
            variacao: `${sinal.variacao.mul(100).toFixed(3)}%`,
            preco: sinal.preco.toString(),
            segundosDaVela: decorridos.toFixed(0),
        });

        if (!this.cfg.aoVivo) return; // modo observação: registra e não envia nada
        await this.entrar(symbol, sinal.direcao);
    }

    // ------------------------------------------------------------------
    // Execução
    // ------------------------------------------------------------------
    private async entrar(symbol: string, direcao: 'alta' | 'baixa'): Promise<void> {
        this.ocupado = true;
        try {
            // A verificação que vale é a da corretora, não a variável local.
            const abertas = await this.provider.posicoesAbertas();
            if (abertas.length > 0) {
                log.warn('Entrada abortada: já existe posição na corretora.', { symbol: abertas[0].symbol });
                await this.adotarPosicaoExistente();
                return;
            }

            const filtros = this.provider.filtrosDe(symbol);
            if (!filtros) {
                log.warn('Sem filtros para o símbolo; entrada abortada.', { symbol });
                return;
            }

            const disponivel = await this.provider.disponivelEmUsdt();
            const nocional = this.dimensionarNocional(disponivel);

            const faixas = await this.provider.faixasDeAlavancagem(symbol);
            const faixa = alavancagemPermitida({ faixas, nocional });
            if (!faixa) {
                log.warn('Nocional acima de qualquer faixa de alavancagem do par.', { symbol, nocional: nocional.toFixed(2) });
                return;
            }
            const alavancagem = Decimal.min(this.cfg.alavancagem, faixa.alavancagemMaxima);

            const tickers = await this.provider.tickers24h();
            const preco = tickers.find((t) => t.symbol === symbol)?.ultimo;
            if (!preco || preco.lessThanOrEqualTo(0)) {
                log.warn('Sem preço para dimensionar; entrada abortada.', { symbol });
                return;
            }

            const q = quantidadeParaNocional({ nocional, preco, filtros });
            if (!q.ok) {
                log.warn('Nocional não vira ordem válida neste par.', {
                    symbol,
                    motivo: q.motivo,
                    nocionalReal: q.nocionalReal.toFixed(2),
                    minNotional: filtros.minNotional.toString(),
                });
                return;
            }

            await this.vazao.aguardarVaga(3);
            await this.provider.definirTipoDeMargem(symbol, this.cfg.tipoDeMargem);
            await this.provider.definirAlavancagem(symbol, alavancagem.toNumber());
            await this.provider.cancelarTudo(symbol);

            const ordem = await this.provider.entrarAMercado({ symbol, direcao, quantidade: q.quantidade });
            if (ordem.quantidadeExecutada.lessThanOrEqualTo(0)) {
                log.warn('Ordem de entrada não preencheu nada.', { symbol, status: ordem.status });
                return;
            }

            // O preço que dimensiona as saídas é o EXECUTADO, nunca o do sinal.
            const entrada = ordem.precoMedio.greaterThan(0) ? ordem.precoMedio : preco;
            this.posicao = {
                symbol,
                direcao,
                quantidade: ordem.quantidadeExecutada,
                entrada,
                abertaEmMs: Date.now(),
            };
            this.placar.entradas += 1;
            log.info('ENTRADA PREENCHIDA.', {
                symbol,
                lado: direcao,
                quantidade: ordem.quantidadeExecutada.toString(),
                entrada: entrada.toString(),
                alavancagem: `${alavancagem.toFixed(0)}x`,
            });

            await this.protegerPosicao(symbol, direcao, entrada, filtros.tickSize, faixa.manutencao, alavancagem);
        } catch (err) {
            this.reportarErro('Falha na sequência de entrada', err);
        } finally {
            this.ocupado = false;
        }
    }

    /**
     * O passo que justifica todo o resto. O STOP vai primeiro porque é ele que
     * limita a perda; se ele falhar, a posição é fechada na hora, sem
     * retentativa. O alvo vem depois: se ELE falhar, ainda existe stop, então
     * há uma retentativa antes de desistir.
     */
    private async protegerPosicao(
        symbol: string,
        direcao: 'alta' | 'baixa',
        entrada: Decimal,
        tickSize: Decimal,
        manutencao: Decimal,
        alavancagem: Decimal,
    ): Promise<void> {
        const brutos = precosDeSaida({ entrada, direcao, alvo: this.cfg.alvo, stop: this.cfg.stop });
        const saidas = saidasNaGrade({ entrada, alvo: brutos.alvo, stop: brutos.stop, tickSize });

        if (saidas.distanciaDoStop.isZero() || saidas.distanciaDoAlvo.isZero()) {
            log.error('Grade de preço grossa demais para este alvo: alvo ou stop colapsaram na entrada.', {
                symbol,
                tickSize: tickSize.toString(),
            });
            await this.fecharPorEmergencia('grade grossa demais para o alvo configurado');
            return;
        }

        if (!stopAntesDaLiquidacao({ entrada, stop: saidas.stop, direcao, alavancagem, manutencao })) {
            log.error('O stop cai DEPOIS da liquidação: seria ficção.', { symbol, stop: saidas.stop.toString() });
            await this.fecharPorEmergencia('stop além do preço de liquidação');
            return;
        }

        try {
            await this.provider.colocarSaida({ symbol, direcao, tipo: 'STOP_MARKET', precoGatilho: saidas.stop });
            log.info('Stop colocado.', { symbol, stop: saidas.stop.toString(), distancia: `${saidas.distanciaDoStop.mul(100).toFixed(3)}%` });
        } catch (err) {
            this.reportarErro('STOP FALHOU — fechando a posição agora', err);
            await this.fecharPorEmergencia('stop não pôde ser colocado');
            return;
        }

        for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
            try {
                await this.provider.colocarSaida({ symbol, direcao, tipo: 'TAKE_PROFIT_MARKET', precoGatilho: saidas.alvo });
                log.info('Alvo colocado.', { symbol, alvo: saidas.alvo.toString(), distancia: `${saidas.distanciaDoAlvo.mul(100).toFixed(3)}%` });
                return;
            } catch (err) {
                this.reportarErro(`Alvo falhou (tentativa ${tentativa}/2)`, err);
            }
        }
        // Com stop no lugar a perda está limitada, mas uma posição sem alvo não
        // é a estratégia — é uma aposta pendurada. Fecha.
        await this.fecharPorEmergencia('alvo não pôde ser colocado');
    }

    private async fecharPorEmergencia(motivo: string): Promise<void> {
        const p = this.posicao;
        if (!p) return;
        this.placar.emergencias += 1;
        log.error('FECHAMENTO DE EMERGÊNCIA.', { symbol: p.symbol, motivo });
        try {
            await this.provider.fecharAMercado({ symbol: p.symbol, direcao: p.direcao, quantidade: p.quantidade });
            await this.provider.cancelarTudo(p.symbol);
            log.info('Posição fechada a mercado.', { symbol: p.symbol });
        } catch (err) {
            this.reportarErro('FECHAMENTO DE EMERGÊNCIA FALHOU — POSIÇÃO PODE ESTAR NUA', err);
        } finally {
            this.posicao = null;
        }
    }

    // ------------------------------------------------------------------
    // Rotina periódica
    // ------------------------------------------------------------------
    private async rotinaPeriodica(): Promise<void> {
        if (this.ocupado) return;
        try {
            if (this.posicao) {
                const abertas = await this.provider.posicoesAbertas();
                const ainda = abertas.find((a) => a.symbol === this.posicao?.symbol);

                if (!ainda) {
                    const p = this.posicao;
                    this.posicao = null;
                    // A saída que não disparou continua pendurada: cancelar é o
                    // que impede a ordem órfã de reabrir posição contrária.
                    await this.provider.cancelarTudo(p.symbol);
                    log.info('Posição encerrada.', { symbol: p.symbol, placar: JSON.stringify(this.placar) });
                    await this.reescolherUniverso();
                    return;
                }

                if (this.cfg.timeStopMs > 0 && Date.now() - this.posicao.abertaEmMs > this.cfg.timeStopMs) {
                    log.info('Time stop atingido.', { symbol: this.posicao.symbol });
                    await this.fecharPorEmergencia('time stop');
                    return;
                }

                log.info('EM POSIÇÃO.', {
                    symbol: ainda.symbol,
                    entrada: ainda.entrada.toString(),
                    marcacao: ainda.marcacao.toString(),
                    pnl: `${ainda.lucroNaoRealizado.toFixed(4)} USDT`,
                    liquidacao: ainda.precoDeLiquidacao.toString(),
                });
                return;
            }

            log.info('CAÇANDO.', {
                universo: this.universo.length,
                comHistorico: [...this.janelas.values()].filter((j) => j.fechadas.length >= 3).length,
                placar: JSON.stringify(this.placar),
            });
        } catch (err) {
            this.reportarErro('Falha na rotina periódica', err);
        }
    }

    private reportarErro(contexto: string, err: unknown): void {
        if (err instanceof ErroDeFuturos) {
            log.error(contexto, { erro: err.message, codigo: err.codigo, comoResolver: err.comoResolver });
            return;
        }
        log.error(contexto, { erro: err instanceof Error ? err.message : String(err) });
    }
}

async function main(): Promise<void> {
    const apiKey = process.env.BINANCE_FUTURES_API_KEY;
    const apiSecret = process.env.BINANCE_FUTURES_API_SECRET;
    if (!apiKey || !apiSecret) {
        log.error('BINANCE_FUTURES_API_KEY e BINANCE_FUTURES_API_SECRET são obrigatórias.', {});
        process.exit(1);
    }

    const cfg = lerConfiguracao();
    if (!cfg.aoVivo) {
        log.warn(
            `Modo OBSERVAÇÃO: sinais serão registrados e NENHUMA ordem enviada. ` +
                `Para operar de verdade, defina SCALPING_LIVE_CONFIRM=${FRASE_DE_CONFIRMACAO}.`,
            {},
        );
    }

    const provider = new BinanceFuturesProvider({
        apiKey,
        apiSecret,
        restBaseUrl: process.env.FUTURES_REST_URL,
    });

    const motor = new MotorDeScalping(cfg, provider);
    await motor.iniciar();
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Motor de scalping abortou.', { erro: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
