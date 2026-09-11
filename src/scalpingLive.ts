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
import { avaliarGrade, CaminhoDeSinal, CelulaDaGrade, gradePadrao, melhorDaGrade } from './excursao';
import { EstadoDeRicochete, parametrosPadrao, passoDoRicochete } from './ricochete';
import { VarreduraDeMercado } from './varredura';
import { classificarRegime, medirTensao, quedaOperavel } from './tensao';
import { detectarPicoDeVolume, precosDeSaida, Vela1m } from './volumeSpike';
import { selecionarUniverso } from './universo';
import { ControleDeVazao } from './rateLimiter';
import {
    EstadoDoDisjuntor,
    LIMITES_PADRAO,
    ajustarPorTransferencia,
    estadoInicial,
    podeOperar,
    registrarResultado,
    virarODia,
} from './disjuntor';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const log = createLogger('scalping');

const FRASE_DE_CONFIRMACAO = 'I_UNDERSTAND_THE_RISK';
const FRASE_DE_OVERRIDE = 'EU_ASSUMO_O_PREJUIZO';
/** Quantas velas fechadas guardar por símbolo para calcular a média de volume. */
const VELAS_DE_HISTORICO = 20;
/**
 * Por quantos minutos seguir o preço depois de um sinal.
 *
 * É o teto do que qualquer alvo pode capturar: um alvo de 1,5% que só é
 * alcançado no minuto 40 não aparece numa janela de 30. Trinta minutos é a
 * escala de um scalp — mais que isso já é outra estratégia.
 */
const JANELA_DE_MEDICAO = 30;
/** Abaixo disto, a melhor célula da grade é ruído de amostra pequena. */
const MINIMO_PARA_RECOMENDAR = 30;

/** Taxas por perna: taker na entrada e no stop, maker no alvo, com desconto BNB. */
const TAXAS_DA_OPERACAO = {
    entrada: new Decimal('0.00045'),
    alvo: new Decimal('0.00018'),
    stop: new Decimal('0.00045'),
};

interface Configuracao {
    alavancagem: Decimal;
    alvo: Decimal;
    stop: Decimal;
    /** Operar CONTRA a direção do sinal. É onde a vantagem foi medida. */
    inverterSinal: boolean;
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
        // O padrão é 1x, e isto não é timidez: o disjuntor para de vez em -30% do
        // pico, e com parede absorvente a alavancagem ótima desaba muito abaixo
        // de Kelly. Medido, indo de R$283 até a banca-alvo: 1x chega em 95% dos
        // casos, 3x em 17%, 10x em 1,6% — e a 10x quase toda morte acontece
        // ANTES de qualquer meta ser atingida. Um padrão perigoso escondido num
        // fallback é a pior forma de perder dinheiro: a silenciosa.
        alavancagem: new Decimal(process.env.SCALPING_LEVERAGE ?? '1'),
        // 0,7% e 1,0% são a célula da HIPÓTESE, não um chute. A antiga 0,3%/0,4%
        // era estreita demais: 40% dos desfechos dela eram decididos pela regra
        // do empate — a vela de 1 minuto atravessa os dois lados — então ela
        // media a régua em vez do mercado. Na célula larga a ambiguidade cai
        // para 8%.
        alvo: new Decimal(process.env.SCALPING_ALVO_PCT ?? '0.7').dividedBy(100),
        stop: new Decimal(process.env.SCALPING_STOP_PCT ?? '1.0').dividedBy(100),
        // O padrão é operar CONTRA o sinal, e isto é o achado central da
        // medição. Seguir o pico de volume acerta 23,2% onde o acaso dá 57,1%;
        // inverter na célula larga acerta 75,6% onde o acaso dá 58,8%. O pico
        // marca DISPUTA, não direção — e o preço tende a voltar.
        //
        // O padrão fica em inverter porque é o único lado com vantagem medida.
        // Deixar o padrão no lado perdedor, esperando alguém lembrar de virar
        // uma variável no dia de ligar, é como o padrão de 30x de alavancagem:
        // uma armadilha silenciosa.
        inverterSinal: (process.env.SCALPING_INVERTER_SINAL ?? '1') === '1',
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
    private coletando = false;
    private varrendo = false;
    private readonly varredura = new VarreduraDeMercado({
        janelaMs: 90_000,
        quedaMinima: new Decimal(process.env.SCALPING_QUEDA_MINIMA_PCT ?? '8').dividedBy(100),
    });
    /** Estatística da auditoria de cascatas — a resposta da pergunta 3. */
    private readonly auditoria = {
        varreduras: 0,
        quedasBrutas: 0,
        semOi: 0,
        distribuicao: 0,
        cascataFraca: 0,
        semTensao: 0,
        ladoErrado: 0,
        cascatasLimpas: 0,
        desdeMs: Date.now(),
    };
    private readonly ultimaCascataMs = new Map<string, number>();
    // ------------------------------------------------------------------
    // Histograma de quedas
    // ------------------------------------------------------------------
    // Um gatilho que nunca dispara ensina uma coisa só: que ele é alto demais.
    // O valor seguinte volta a ser chute, e cada chute custa uma noite. O
    // histograma responde a pergunta certa — quantos eventos por dia existem
    // em CADA profundidade — e o corte seguinte sai daí em vez de sair de mim.
    private readonly FAIXAS = [1, 2, 3, 4, 5, 6, 8, 10, 15].map((n) => new Decimal(n).dividedBy(100));
    private readonly histograma: number[] = new Array(9).fill(0);
    /**
     * Episódio em curso por símbolo, para não contar a mesma queda a cada
     * varredura. Termina 30 min depois da última observação: como a janela é
     * de 90s, um par que parou de cair some da lista sozinho, e o que sobra é
     * um evento por queda de verdade.
     */
    private readonly episodio = new Map<string, { faixa: number; ateMs: number }>();
    /**
     * Saldo relido a cada ciclo.
     *
     * Antes era lido só no boot. Em observação o motor nunca chama entrar(),
     * então nunca relia — e o log seguia dizendo "0.00 USDT" horas depois de
     * o dinheiro ter chegado na carteira. O operador não tinha como saber, do
     * log, se a transferência funcionou.
     */
    private saldoAtual: Decimal | null = null;
    private tentativasDeReconexao = 0;
    /** Trava de reentrância: mensagens de kline chegam várias por segundo. */
    private ocupado = false;
    private posicao: PosicaoViva | null = null;
    private placar = { entradas: 0, alvos: 0, stops: 0, emergencias: 0 };
    // ------------------------------------------------------------------
    // Disjuntor
    // ------------------------------------------------------------------
    // Nasce nulo de propósito: sem saber a banca não existe referência de
    // pico nem de perda diária, e um disjuntor sem referência é um enfeite.
    // Ele é armado na primeira leitura de saldo que der certo.
    private disjuntor: EstadoDoDisjuntor | null = null;
    private readonly limites = LIMITES_PADRAO;
    /** Banca no primeiro instante do dia corrente — referência da perda diária. */
    private bancaNoInicioDoDia: Decimal | null = null;
    /** Saldo lido no instante da entrada, para medir o resultado ao fechar. */
    private saldoAoEntrar: Decimal | null = null;
    /** Motivo do último bloqueio já anunciado, para não repetir a cada ciclo. */
    private bloqueioAnunciado: string | null = null;
    private paradoDeVez = false;
    /**
     * Caminhos completos, SEPARADOS POR GATILHO.
     *
     * Misturar as duas fontes numa amostra só destruiria a única coisa que
     * interessa: saber qual gatilho presta. Um gatilho ruim com muitos eventos
     * afogaria um bom com poucos, e a média não seria de nenhum dos dois.
     */
    private readonly caminhos = new Map<string, CaminhoDeSinal[]>();
    private gravando: Array<{ gatilho: string; caminho: CaminhoDeSinal; restantes: number }> = [];
    /** Estado da máquina de ricochete, por símbolo. */
    private readonly ricochete = new Map<string, EstadoDeRicochete | null>();
    private readonly ultimoRicocheteMs = new Map<string, number>();
    private sinaisVistos = 0;
    /**
     * Último sinal por símbolo. Existe porque o mesmo pico é detectado a cada
     * coleta enquanto a vela não fecha: aos 13s e aos 23s do mesmo minuto, o
     * PUMPUSDT disparou duas vezes. Dois caminhos quase idênticos gravados
     * como se fossem observações independentes inflam a amostra com CÓPIAS —
     * e uma grade calculada sobre cópias parece sólida sem ser. É o pior tipo
     * de erro de medição, porque aumenta a confiança em vez de derrubá-la.
     */
    private readonly ultimoSinalMs = new Map<string, number>();
    // ------------------------------------------------------------------
    // Custo do atraso
    // ------------------------------------------------------------------
    // A grade mede o caminho a partir do preço do SINAL. Uma ordem de verdade
    // sai depois: o motor lê por REST, e entre ver o pico e conseguir entrar
    // passam segundos. Num pico de volume o preço anda justamente nesses
    // segundos, e ele anda contra quem entra depois.
    //
    // Uma vantagem de +0,08% por operação não sobrevive a 0,10% de atraso.
    // Então este número não é um detalhe de execução: é o que decide se o
    // achado da grade existe fora da planilha.
    private readonly aguardandoAtraso = new Map<string, { preco: Decimal; direcao: 'alta' | 'baixa' }>();
    /** Deslocamento no sentido do sinal, em pontos percentuais, por amostra. */
    private readonly atrasos: number[] = [];
    /**
     * Telemetria crua do stream. Existe porque "comHistorico: 0" tem três
     * causas indistinguíveis sem ela: o WebSocket não está entregando nada,
     * está entregando mas nada fecha, ou fecha e o histórico ainda é novo.
     * Um contador separa as três em dez segundos.
     */
    private recebidas = 0;
    private fechadasVistas = 0;
    /** Mensagens CRUAS, contadas antes de qualquer parsing. Ver processarKline. */


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

        // O veredicto barra DINHEIRO, não observação. Em modo observação nada
        // é enviado, e é justamente aí que se coleta o dado que responde se a
        // taxa de acerto assumida existe neste mercado. Barrar isso seria
        // impedir a única medição capaz de resolver a discussão.
        if (!this.cfg.aoVivo) {
            log.warn('Configuração reprovada, mas o modo é OBSERVAÇÃO: segue medindo sem enviar ordem.', {});
            return;
        }

        log.error(
            'Motor NÃO vai operar com dinheiro nesta configuração. Ajuste o alvo, ou defina ' +
                `SCALPING_IGNORAR_VEREDICTO=${FRASE_DE_OVERRIDE} para assumir o prejuízo esperado.`,
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
            log.error('Pré-requisitos de Futuros não atendidos.', {});
            prontidao.pendencias.forEach((p, i) => log.error(`  ${i + 1}. ${p}`, {}));
            // Mesma regra do veredicto: o que falta aqui impede ORDEM, não
            // medição. Observar não gasta saldo — e é justamente enquanto o
            // dinheiro não chegou que sai de graça o dado que decide se a
            // configuração presta. Bloquear a partida desperdiçaria essas horas.
            if (this.cfg.aoVivo) process.exit(1);
            log.warn('Modo OBSERVAÇÃO: subindo mesmo assim para medir os sinais.', {});
        }

        await this.provider.carregarModoDePosicao();
        await this.adotarPosicaoExistente();

        const fracao = fracaoDaBancaEmMargem({ nocional, alavancagem: this.cfg.alavancagem, banca: disponivel });
        log.info('Motor de scalping pronto.', {
            modo: this.cfg.aoVivo ? 'AO VIVO (ordens reais)' : 'OBSERVAÇÃO (nenhuma ordem)',
            lado: this.cfg.inverterSinal ? 'CONTRA o sinal (onde a vantagem foi medida)' : 'SEGUINDO o sinal',
            alvoStop: `${this.cfg.alvo.mul(100).toFixed(1)}% / ${this.cfg.stop.mul(100).toFixed(1)}%`,
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
        const varreduraMs = Number(process.env.SCALPING_VARREDURA_MS ?? '5000');
        log.info('Varredura de mercado iniciada.', {
            intervaloMs: varreduraMs,
            simbolos: this.provider.simbolosDisponiveis().length,
            quedaMinima: `${new Decimal(process.env.SCALPING_QUEDA_MINIMA_PCT ?? '8').toFixed(1)}%`,
        });
        setInterval(() => void this.varrer(), varreduraMs);
        const intervalo = Number(process.env.SCALPING_POLL_MS ?? '10000');
        log.info('Coleta por REST iniciada.', { intervaloMs: intervalo, simbolos: this.universo.length });
        void this.coletar();
        setInterval(() => void this.coletar(), intervalo);
        setInterval(() => void this.rotinaPeriodica(), 15_000);
        setInterval(() => this.relatarGrade(), 5 * 60_000);
        setInterval(() => this.relatarAuditoria(), 10 * 60_000);
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

    /**
     * Coleta por REST.
     *
     * O WebSocket deste ambiente entrega handshake, responde ping, aceita
     * SUBSCRIBE — e nunca entrega um frame de dado. Foram descartados um a um
     * o formato do nome do stream, o endpoint combinado versus simples, o
     * mecanismo de assinatura e a compressão. Insistir era gastar deploy em
     * teoria.
     *
     * O REST custa latência e não custa qualidade de MEDIÇÃO: a grade avalia
     * caminhos a partir de velas FECHADAS, e uma vela fechada é idêntica
     * venha de onde vier. Para operar de verdade a latência importa; para
     * descobrir se existe vantagem, não.
     */
    private async coletar(): Promise<void> {
        if (this.coletando) return; // um ciclo por vez: 15 símbolos levam segundos
        this.coletando = true;
        try {
            for (const symbol of this.universo) {
                try {
                    await this.vazao.aguardarVaga(1);
                    const { fechadas, emFormacao } = await this.provider.klines(symbol, VELAS_DE_HISTORICO + 1);
                    this.recebidas += 1;

                    const anterior = this.janelas.get(symbol);
                    const ultimaConhecida = anterior?.fechadas.at(-1)?.aberturaMs ?? 0;
                    // Velas novas alimentam as gravações em curso. Comparar por
                    // aberturaMs em vez de contar: o REST devolve a janela
                    // inteira a cada chamada, e reprocessar as antigas
                    // duplicaria o caminho medido.
                    for (const v of fechadas) {
                        if (v.aberturaMs > ultimaConhecida) {
                            this.fechadasVistas += 1;
                            this.alimentarGravacoes(symbol, v);
                        }
                    }

                    if (emFormacao) this.medirAtraso(symbol, emFormacao.fechamento);

                    const janela: JanelaDoSimbolo = { fechadas, emFormacao, eventoMs: Date.now() };
                    this.janelas.set(symbol, janela);
                    if (emFormacao) {
                        this.avaliarRicochete(symbol, emFormacao);
                        await this.avaliar(symbol, janela);
                    }
                } catch (err) {
                    this.reportarErro(`Falha ao coletar ${symbol}`, err);
                }
            }
        } finally {
            this.coletando = false;
        }
    }

    /**
     * Estende os caminhos em curso com a vela recém-fechada.
     *
     * Só velas FECHADAS entram: uma vela em formação tem máxima e mínima
     * provisórias, e medir desfecho com extremos que ainda podem crescer
     * anteciparia stops que talvez nunca acontecessem.
     */
    private alimentarGravacoes(symbol: string, vela: Vela1m): void {
        if (this.gravando.length === 0) return;
        const aindaGravando: typeof this.gravando = [];
        for (const g of this.gravando) {
            if (g.caminho.symbol !== symbol) {
                aindaGravando.push(g);
                continue;
            }
            g.caminho.velas.push(vela);
            g.restantes -= 1;
            if (g.restantes > 0) {
                aindaGravando.push(g);
            } else {
                const lista = this.caminhos.get(g.gatilho) ?? [];
                lista.push(g.caminho);
                this.caminhos.set(g.gatilho, lista);
            }
        }
        this.gravando = aindaGravando;
    }

    /**
     * O relatório que substitui a discussão sobre parâmetros.
     *
     * Percorre TODAS as combinações de alvo e stop contra os caminhos reais
     * medidos e mostra as que tiveram lucro esperado positivo. Se nenhuma
     * teve, diz isso — e essa é uma resposta tão útil quanto a outra: nenhum
     * ajuste de alvo salva um sinal que não antecipa nada.
     */
    /** Uma linha de relatório para um conjunto de caminhos. */
    private relatarUm(gatilho: string, caminhos: CaminhoDeSinal[]): void {
        if (caminhos.length === 0) return;

        const grade = gradePadrao();
        const seguindo = avaliarGrade({ caminhos, ...grade, taxas: TAXAS_DA_OPERACAO });
        // O MESMO caminho na direção oposta. Um sinal que acerta menos que o
        // acaso não é ruído, é informação invertida — e testar isso não custa
        // dado novo, só reinterpretar o preço já gravado.
        const invertidos = caminhos.map((c) => ({
            ...c,
            direcao: (c.direcao === 'alta' ? 'baixa' : 'alta') as 'alta' | 'baixa',
        }));
        const contra = avaliarGrade({ caminhos: invertidos, ...grade, taxas: TAXAS_DA_OPERACAO });

        const naConfig = (cs: CelulaDaGrade[]) =>
            cs.find((c) => c.alvo.equals(this.cfg.alvo) && c.stop.equals(this.cfg.stop));
        const resumo = (c: CelulaDaGrade | undefined) =>
            c
                ? `acerto ${c.taxaDeAcerto.mul(100).toFixed(1)}% (acaso ${c.acaso.mul(100).toFixed(1)}%, ` +
                  `z=${c.z.toFixed(2)}) ${c.alvos}A/${c.stops}S/${c.abertos}ab, EV ${c.evPorOperacao.mul(100).toFixed(4)}%` +
                  `, ambiguos ${this.pctAmbiguo(c)}`
                : 'fora da grade';

        log.info(`GRADE [${gatilho}].`, {
            completos: caminhos.length,
            seguindo: resumo(naConfig(seguindo)),
            contra: resumo(naConfig(contra)),
            acasoSeria: '57.1%',
        });

        this.relatarHipotese(gatilho, contra);

        for (const [nome, cs] of [
            ['seguindo', seguindo],
            ['contra', contra],
        ] as const) {
            const melhor = melhorDaGrade({ celulas: cs, minimoResolvidos: MINIMO_PARA_RECOMENDAR });
            if (!melhor) continue;
            log.info(`  VANTAGEM REAL [${gatilho}/${nome}]`, {
                alvo: `${melhor.alvo.mul(100).toFixed(1)}%`,
                stop: `${melhor.stop.mul(100).toFixed(1)}%`,
                acerto: `${melhor.taxaDeAcerto.mul(100).toFixed(1)}%`,
                acaso: `${melhor.acaso.mul(100).toFixed(1)}%`,
                desviosAcimaDoAcaso: melhor.z.toFixed(2),
                equilibrio: `${melhor.acertoDeEquilibrio.mul(100).toFixed(1)}%`,
                ev: `${melhor.evPorOperacao.mul(100).toFixed(4)}%`,
                amostra: `${melhor.alvos}A/${melhor.stops}S`,
                decididosPelaRegra: this.pctAmbiguo(melhor),
                custoDoAtraso: this.resumoDoAtraso(melhor.evPorOperacao.mul(100)),
            });
        }
    }

    /**
     * Fecha uma amostra de atraso: quanto o preço andou NO SENTIDO do sinal
     * entre o pico e a leitura seguinte.
     *
     * Positivo é continuação. Como a vantagem medida está em operar CONTRA o
     * sinal, continuação é exatamente o movimento adverso — o preço fugindo
     * antes de a ordem existir.
     */
    private medirAtraso(symbol: string, precoAgora: Decimal): void {
        const pendente = this.aguardandoAtraso.get(symbol);
        if (!pendente) return;
        this.aguardandoAtraso.delete(symbol);
        if (pendente.preco.lessThanOrEqualTo(0)) return;
        const variacao = precoAgora.minus(pendente.preco).dividedBy(pendente.preco);
        const noSentidoDoSinal = pendente.direcao === 'alta' ? variacao : variacao.negated();
        this.atrasos.push(noSentidoDoSinal.mul(100).toNumber());
        if (this.atrasos.length > 5000) this.atrasos.shift();
    }

    /** Mediana e cauda do custo de atraso, com o veredicto contra a vantagem. */
    private resumoDoAtraso(evPorOperacaoPct?: Decimal): string {
        if (this.atrasos.length < 20) return `poucas amostras (${this.atrasos.length})`;
        const ord = [...this.atrasos].sort((a, b) => a - b);
        const q = (f: number) => ord[Math.min(ord.length - 1, Math.floor(ord.length * f))];
        const mediana = q(0.5);
        const p75 = q(0.75);
        // A MÉDIA é o que desconta, não a mediana. O atraso incide em toda
        // operação, então o custo por operação é a média — e a distribuição é
        // torta: mediana zero com cauda positiva dá média bem acima de zero.
        // Descontar pela mediana mostrava "EV depois do atraso" idêntico ao EV
        // bruto, o que é falso sempre que existe cauda.
        const media = ord.reduce((a, b) => a + b, 0) / ord.length;
        const base = `media ${media.toFixed(4)}pp · mediana ${mediana.toFixed(4)}pp · p75 ${p75.toFixed(4)}pp · n=${ord.length}`;
        if (!evPorOperacaoPct) return base;
        const sobra = evPorOperacaoPct.minus(media);
        return `${base} · EV depois do atraso ${sobra.toFixed(4)}%`;
    }

    /**
     * Quanto tempo cada operação ocupa a banca, e quantas cabem num dia.
     *
     * O motor opera UMA posição por vez. Então o que limita o ganho diário não
     * é a oferta de sinais — aparecem mais de mil por dia — e sim quanto tempo
     * cada operação segura a banca. Toda projeção de renda multiplica por
     * "operações por dia", e até agora esse número era suposição minha (40).
     * Se forem 20, todo o cronograma dobra.
     *
     * O teto é otimista de propósito: assume que existe sinal disponível no
     * instante em que a posição anterior fecha. Na prática há espera, então o
     * número real fica abaixo deste.
     */
    private resumoDoRitmo(c: CelulaDaGrade): string {
        const tempos = c.minutosParaResolver;
        if (tempos.length < 10) return `poucas amostras (${tempos.length})`;
        const ord = [...tempos].sort((a, b) => a - b);
        const mediana = ord[Math.floor(ord.length / 2)];
        const media = ord.reduce((a, b) => a + b, 0) / ord.length;
        // A MÉDIA é a que dita o ritmo: num dia inteiro o que importa é o tempo
        // total gasto, e é a média que soma. A mediana só descreve a operação
        // típica.
        const porDia = media > 0 ? (24 * 60) / media : 0;
        return `mediana ${mediana}min · media ${media.toFixed(1)}min · teto ${porDia.toFixed(0)} ops/dia`;
    }

    /** Quanto desta célula foi decidido pela regra do empate, não pelo preço. */
    private pctAmbiguo(c: CelulaDaGrade): string {
        const resolvidos = c.alvos + c.stops;
        if (resolvidos === 0) return '—';
        return `${((c.ambiguos / resolvidos) * 100).toFixed(0)}%`;
    }

    /**
     * A célula da HIPÓTESE, reportada sempre, passe ou não passe.
     *
     * A vantagem de ontem (contra o sinal, alvo 0,7%, stop 1,0%, z=3,55) saiu
     * do MÁXIMO de 252 células. O máximo de 252 testes correlacionados fica
     * acima do acaso quase sempre, exista vantagem ou não — por isso aquele z
     * precisava de Bonferroni e passou por 0,008.
     *
     * Reencontrar o máximo numa amostra nova não responde nada: seria minerar
     * de novo. O que responde é fixar a célula ANTES de olhar e testar só ela.
     * Aí não há 252 testes, há um — e o z vale de cara, sem correção nenhuma.
     *
     * Por isso esta linha é separada de VANTAGEM REAL e sai mesmo quando o
     * resultado é ruim. Uma hipótese que só aparece no log quando confirma não
     * está sendo testada, está sendo torcida.
     */
    private relatarHipotese(gatilho: string, contra: CelulaDaGrade[]): void {
        const alvo = new Decimal(process.env.SCALPING_HIPOTESE_ALVO_PCT ?? '0.7').dividedBy(100);
        const stop = new Decimal(process.env.SCALPING_HIPOTESE_STOP_PCT ?? '1.0').dividedBy(100);
        const c = contra.find((x) => x.alvo.equals(alvo) && x.stop.equals(stop));
        if (!c) return;
        const resolvidos = c.alvos + c.stops;
        const ev = c.evPorOperacao.mul(100);
        log.info(`  HIPOTESE [${gatilho}/contra ${alvo.mul(100).toFixed(1)}%/${stop.mul(100).toFixed(1)}%]`, {
            acerto: `${c.taxaDeAcerto.mul(100).toFixed(1)}%`,
            acaso: `${c.acaso.mul(100).toFixed(1)}%`,
            z: c.z.toFixed(2),
            ev: `${ev.toFixed(4)}%`,
            amostra: `${c.alvos}A/${c.stops}S`,
            decididosPelaRegra: this.pctAmbiguo(c),
            custoDoAtraso: this.resumoDoAtraso(ev),
            ritmo: this.resumoDoRitmo(c),
            // Sem correção de comparações múltiplas: a célula foi fixada antes
            // de a amostra existir, então 2,0 já é um resultado de verdade.
            veredicto:
                resolvidos < 100
                    ? `aguardando (${resolvidos}/100 resolvidos)`
                    : c.z.greaterThanOrEqualTo(2) && ev.greaterThan(0)
                      ? 'CONFIRMA'
                      : 'NAO CONFIRMA',
        });
    }

    private relatarGrade(): void {
        for (const [gatilho, caminhos] of this.caminhos) this.relatarUm(gatilho, caminhos);
        const total = [...this.caminhos.values()].reduce((n, c) => n + c.length, 0);
        if (total === 0) {
            log.info('GRADE: nenhum caminho completo ainda.', { gravando: this.gravando.length });
        }
    }

    /**
     * Varredura do mercado inteiro: 528 pares por peso 2.
     *
     * Detecta a queda pelo preço e confirma pelo Open Interest. A confirmação
     * é o que separa cascata de fluxo vendedor novo — e a proposta de baixar
     * o gatilho para 4,5% morria exatamente por não ter como fazer essa
     * separação. Cada recusa é contada por MOTIVO, porque "poucos eventos" e
     * "muitos eventos que não passam no filtro" pedem correções opostas.
     */
    private async varrer(): Promise<void> {
        if (this.varrendo) return;
        this.varrendo = true;
        try {
            await this.vazao.aguardarVaga(2);
            const precos = await this.provider.precosDeTodos();
            const agora = { emMs: Date.now(), precos };
            const quedas = this.varredura.quedas(agora);
            this.contarNoHistograma(agora);
            this.varredura.registrar(agora);
            this.auditoria.varreduras += 1;

            for (const q of quedas) {
                const anterior = this.ultimaCascataMs.get(q.symbol) ?? Number.NEGATIVE_INFINITY;
                if (agora.emMs - anterior < 30 * 60_000) continue; // uma cascata por par por meia hora
                // A carência passa a valer JÁ, antes do veredicto. Antes ela só
                // era marcada quando a cascata era confirmada, então uma queda
                // recusada voltava a contar a cada varredura enquanto durasse:
                // o mesmo evento virava dezenas de "quedasBrutas" e gastava
                // duas chamadas de API por repetição. Cinco minutos, e não
                // trinta, porque uma queda que se APROFUNDA é evento novo e
                // precisa poder ser reexaminada.
                this.ultimaCascataMs.set(q.symbol, agora.emMs - 25 * 60_000);
                this.auditoria.quedasBrutas += 1;

                let oi: Array<{ emMs: number; oi: Decimal }>;
                let funding: Decimal;
                try {
                    await this.vazao.aguardarVaga(2);
                    [oi, funding] = await Promise.all([
                        this.provider.historicoDeOpenInterest(q.symbol),
                        this.provider.fundingAtual(q.symbol),
                    ]);
                } catch {
                    this.auditoria.semOi += 1;
                    continue;
                }
                if (oi.length < 2) {
                    this.auditoria.semOi += 1;
                    continue;
                }

                const classificacao = classificarRegime({
                    antes: { emMs: oi[0].emMs, preco: q.de, openInterest: oi[0].oi, funding },
                    agora: { emMs: oi[1].emMs, preco: q.para, openInterest: oi[1].oi, funding },
                });
                const tensao = medirTensao({ funding });
                const veredicto = quedaOperavel({ classificacao, tensao });

                if (!veredicto.operavel) {
                    if (classificacao.regime !== 'cascata') this.auditoria.distribuicao += 1;
                    else if (veredicto.motivo.includes('fraca')) this.auditoria.cascataFraca += 1;
                    else if (veredicto.motivo.includes('não estava torto')) this.auditoria.semTensao += 1;
                    else this.auditoria.ladoErrado += 1;
                    log.info('Queda RECUSADA.', {
                        symbol: q.symbol,
                        queda: `${q.queda.mul(100).toFixed(2)}%`,
                        emSegundos: (q.idadeMs / 1000).toFixed(0),
                        regime: classificacao.regime,
                        motivo: veredicto.motivo,
                    });
                    continue;
                }

                this.auditoria.cascatasLimpas += 1;
                this.ultimaCascataMs.set(q.symbol, agora.emMs);
                log.info('CASCATA LIMPA CONFIRMADA.', {
                    symbol: q.symbol,
                    queda: `${q.queda.mul(100).toFixed(2)}%`,
                    emSegundos: (q.idadeMs / 1000).toFixed(0),
                    oi: `${classificacao.variacaoDeOi.mul(100).toFixed(2)}%`,
                    intensidade: classificacao.intensidade.toFixed(2),
                    fundingAnual: `${tensao.fundingAnualizado.mul(100).toFixed(1)}%`,
                });
                // Arma o ricochete: daqui em diante o par é seguido até
                // confirmar a volta ou a janela expirar.
                this.ricochete.set(q.symbol, {
                    fase: 'caindo',
                    fundo: q.para,
                    fundoEmMs: agora.emMs,
                    referencia: q.de,
                });
                if (!this.janelas.has(q.symbol)) this.janelas.set(q.symbol, { fechadas: [], emFormacao: null, eventoMs: agora.emMs });
            }
        } catch (err) {
            this.reportarErro('Falha na varredura', err);
        } finally {
            this.varrendo = false;
        }
    }

    /** Em que faixa cai esta queda. -1 se estiver abaixo do piso. */
    private faixaDe(queda: Decimal): number {
        let idx = -1;
        for (let i = 0; i < this.FAIXAS.length; i++) if (queda.greaterThanOrEqualTo(this.FAIXAS[i])) idx = i;
        return idx;
    }

    /** Conta cada queda uma vez, na maior profundidade que ela alcançar. */
    private contarNoHistograma(agora: { emMs: number; precos: Map<string, Decimal> }): void {
        const todas = this.varredura.quedasAcimaDe(agora, this.FAIXAS[0]);
        for (const q of todas) {
            const faixa = this.faixaDe(q.queda);
            if (faixa < 0) continue;
            const ep = this.episodio.get(q.symbol);

            if (!ep || agora.emMs > ep.ateMs) {
                this.histograma[faixa] += 1;
            } else if (faixa > ep.faixa) {
                // Mesmo episódio, ficou mais fundo: move a contagem de faixa
                // em vez de somar outra. Uma queda que passa por 3% a caminho
                // de 7% é um evento de 7%, não dois eventos.
                this.histograma[ep.faixa] -= 1;
                this.histograma[faixa] += 1;
            }
            this.episodio.set(q.symbol, { faixa: Math.max(faixa, ep && agora.emMs <= ep.ateMs ? ep.faixa : 0), ateMs: agora.emMs + 30 * 60_000 });
        }
    }

    /** O relatório que responde: o mercado entrega cascatas limpas suficientes? */
    private relatarAuditoria(): void {
        const horas = (Date.now() - this.auditoria.desdeMs) / 3_600_000;
        if (horas <= 0) return;
        const a = this.auditoria;
        log.info('AUDITORIA DE CASCATAS.', {
            horas: horas.toFixed(1),
            varreduras: a.varreduras,
            quedasBrutas: a.quedasBrutas,
            recusadas: `distribuicao:${a.distribuicao} fraca:${a.cascataFraca} semTensao:${a.semTensao} ladoErrado:${a.ladoErrado} semOi:${a.semOi}`,
            CASCATAS_LIMPAS: a.cascatasLimpas,
            porDia: (a.cascatasLimpas / horas * 24).toFixed(1),
            precisaPorDia: '3.0',
        });

        // A pergunta prática não é "quantas passaram no gatilho de hoje", e sim
        // "qual gatilho entrega os 3 por dia". A acumulada responde isso de uma
        // vez, sem precisar de outra noite para testar o valor seguinte.
        const porDia = (n: number) => (n / horas) * 24;
        const faixas = this.FAIXAS.map((f, i) => `${f.mul(100).toFixed(0)}%:${this.histograma[i]}`);
        const acumulada = this.FAIXAS.map((f, i) => {
            const soma = this.histograma.slice(i).reduce((x, y) => x + y, 0);
            return `${f.mul(100).toFixed(0)}%:${porDia(soma).toFixed(1)}`;
        });
        const suficiente = this.FAIXAS.map((f, i) => ({
            f,
            porDia: porDia(this.histograma.slice(i).reduce((x, y) => x + y, 0)),
        }))
            .filter((x) => x.porDia >= 3)
            .pop();
        log.info('HISTOGRAMA DE QUEDAS.', {
            horas: horas.toFixed(1),
            eventosPorFaixa: faixas.join(' '),
            seOGatilhoFosse: acumulada.join(' '),
            maiorGatilhoCom3PorDia: suficiente ? `${suficiente.f.mul(100).toFixed(0)}%` : 'nenhum ainda',
        });
    }

    /**
     * Gatilho de ricochete, medido em paralelo ao de volume.
     *
     * Os dois convivem porque respondem a perguntas diferentes e nenhum dos
     * dois foi respondido ainda. O de volume dispara dezenas de vezes por hora
     * sobre movimentos de 0,15%; este espera uma queda de 8% e a confirmação
     * da volta. Um vai fechar amostra hoje; o outro pode levar dias — e é
     * exatamente por isso que ele precisa começar a contar agora.
     */
    private avaliarRicochete(symbol: string, vela: Vela1m): void {
        const cfg = parametrosPadrao({ alavancagem: this.cfg.alavancagem });
        const agora = Date.now();
        const r = passoDoRicochete({ estado: this.ricochete.get(symbol) ?? null, vela, agoraMs: agora, cfg });
        this.ricochete.set(symbol, r.estado);
        if (!r.sinal) return;

        const anterior = this.ultimoRicocheteMs.get(symbol) ?? Number.NEGATIVE_INFINITY;
        if (agora - anterior < 15 * 60_000) return;
        this.ultimoRicocheteMs.set(symbol, agora);

        log.info('RICOCHETE CONFIRMADO.', {
            symbol,
            queda: `${r.sinal.queda.mul(100).toFixed(2)}%`,
            fundo: r.sinal.fundo.toString(),
            entrada: r.sinal.entrada.toString(),
            repique: `${r.sinal.repique.mul(100).toFixed(2)}%`,
            liquidacaoVsFundo: `${r.sinal.liquidacaoVsFundo.mul(100).toFixed(2)}%`,
        });

        this.gravando.push({
            gatilho: 'ricochete',
            caminho: { symbol, direcao: 'alta', entrada: r.sinal.entrada, velas: [] },
            restantes: JANELA_DE_MEDICAO,
        });
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

        const agora = Date.now();
        const anterior = this.ultimoSinalMs.get(symbol) ?? Number.NEGATIVE_INFINITY;
        const carencia = Number(process.env.SCALPING_CARENCIA_MS ?? '300000'); // 5 min
        if (agora - anterior < carencia) return;
        this.ultimoSinalMs.set(symbol, agora);

        log.info('PICO DE VOLUME.', {
            symbol,
            direcao: sinal.direcao,
            volume: `${sinal.multiploDoVolume.toFixed(2)}x`,
            variacao: `${sinal.variacao.mul(100).toFixed(3)}%`,
            preco: sinal.preco.toString(),
            segundosDaVela: decorridos.toFixed(0),
        });

        this.sinaisVistos += 1;
        // Fica pendente até a leitura seguinte deste símbolo. Não se mede aqui:
        // aqui o atraso é zero por construção.
        this.aguardandoAtraso.set(symbol, { preco: sinal.preco, direcao: sinal.direcao });
        // Todo sinal vira caminho medido, ao vivo ou não. Medir é o que
        // transforma a escolha de alvo e stop em resultado em vez de opinião.
        this.gravando.push({
            gatilho: 'volume',
            caminho: { symbol, direcao: sinal.direcao, entrada: sinal.preco, velas: [] },
            restantes: JANELA_DE_MEDICAO,
        });

        if (!this.cfg.aoVivo) return; // modo observação: registra e não envia nada
        // A vantagem medida está no lado OPOSTO ao do sinal. Inverter aqui, e
        // não na detecção, mantém o caminho GRAVADO na direção do sinal — a
        // grade continua comparando "seguindo" e "contra" com a mesma base.
        const direcao = this.cfg.inverterSinal
            ? ((sinal.direcao === 'alta' ? 'baixa' : 'alta') as 'alta' | 'baixa')
            : sinal.direcao;
        await this.entrar(symbol, direcao);
    }

    // ------------------------------------------------------------------
    // Disjuntor
    // ------------------------------------------------------------------
    /** Arma o disjuntor na primeira banca conhecida. Idempotente. */
    private armarDisjuntor(banca: Decimal): void {
        if (this.disjuntor !== null) return;
        const agora = Date.now();
        this.disjuntor = estadoInicial(banca, agora);
        this.bancaNoInicioDoDia = banca;
        log.info('DISJUNTOR ARMADO.', {
            banca: `${banca.toFixed(2)} USDT`,
            perdasSeguidasMaximas: this.limites.perdasSeguidasMaximas,
            pausa: `${(this.limites.pausaMs / 60_000).toFixed(0)} min`,
            perdaDiariaMaxima: `${this.limites.perdaDiariaMaxima.mul(100).toFixed(0)}%`,
            quedaDoPicoMaxima: `${this.limites.quedaDoPicoMaxima.mul(100).toFixed(0)}%`,
        });
    }

    /**
     * Vira o dia depois de 24h corridas desde a última virada.
     *
     * Vinte e quatro horas corridas, e não meia-noite de algum fuso: o limite
     * diário existe para separar uma sequência ruim da seguinte, e uma
     * fronteira que cai no meio da sessão asiática cortaria uma sequência ao
     * meio sem motivo nenhum.
     */
    private virarODiaSePassou(banca: Decimal): void {
        if (this.disjuntor === null) return;
        const agora = Date.now();
        if (agora - this.disjuntor.diaComecouEmMs < 24 * 60 * 60_000) return;
        log.info('DIA VIRADO NO DISJUNTOR.', {
            resultadoDoDiaAnterior: `${this.disjuntor.resultadoDoDia.toFixed(4)} USDT`,
            bancaAgora: `${banca.toFixed(2)} USDT`,
        });
        this.disjuntor = virarODia(this.disjuntor, agora);
        this.bancaNoInicioDoDia = banca;
    }

    /**
     * Deixa entrar? Só responde sim com o disjuntor armado e dentro dos
     * limites. Sem disjuntor a resposta é NÃO: preferir não operar a operar
     * sem freio é a única ordem que faz sentido com dinheiro de verdade.
     */
    private freioLiberado(): boolean {
        if (this.paradoDeVez) return false;
        if (this.disjuntor === null || this.bancaNoInicioDoDia === null) {
            if (this.bloqueioAnunciado !== 'sem-banca') {
                this.bloqueioAnunciado = 'sem-banca';
                log.warn('Entrada barrada: disjuntor ainda não armado (banca desconhecida).');
            }
            return false;
        }

        const v = podeOperar({
            estado: this.disjuntor,
            limites: this.limites,
            agoraMs: Date.now(),
            bancaNoInicioDoDia: this.bancaNoInicioDoDia,
        });
        if (v.podeOperar) {
            if (this.bloqueioAnunciado !== null) {
                log.info('DISJUNTOR RELIGADO. Voltando a caçar.');
                this.bloqueioAnunciado = null;
            }
            return true;
        }

        if (v.permanente) this.paradoDeVez = true;
        // Anuncia uma vez por motivo. O bloqueio dura uma hora e o ciclo roda
        // a cada quinze segundos: sem isto seriam duzentas linhas iguais.
        if (this.bloqueioAnunciado !== v.motivo) {
            this.bloqueioAnunciado = v.motivo;
            log.warn(v.permanente ? 'DISJUNTOR DESARMADO — PARADA DEFINITIVA.' : 'DISJUNTOR DESARMADO.', {
                motivo: v.motivo,
                religaEm: v.religaEmMs ? `${(v.religaEmMs / 60_000).toFixed(0)} min` : 'não religa sozinho',
            });
        }
        return false;
    }

    /**
     * Percebe saque ou depósito e reconcilia o disjuntor.
     *
     * O `banca` do disjuntor só anda por resultado de operação. Sem isto, um
     * saque apareceria como queda contra o pico — sacar R$1.000 de R$2.800
     * viraria uma "queda de 35,7%" e dispararia a parada permanente por causa
     * de um saque planejado.
     *
     * Só compara com a posição FECHADA: com posição aberta o saldo disponível
     * está reduzido pela margem, e a diferença não seria transferência.
     */
    private reconciliarTransferencia(saldo: Decimal): void {
        if (this.disjuntor === null || this.posicao !== null || this.ocupado) return;
        const diferenca = saldo.minus(this.disjuntor.banca);
        // Meio dólar: acima do ruído de arredondamento da corretora e muito
        // abaixo de qualquer transferência que uma pessoa faria de propósito.
        if (diferenca.abs().lessThan('0.5')) return;

        const antes = this.disjuntor;
        this.disjuntor = ajustarPorTransferencia({ estado: antes, bancaReal: saldo });
        if (this.bancaNoInicioDoDia !== null) this.bancaNoInicioDoDia = this.bancaNoInicioDoDia.plus(diferenca);
        log.info(diferenca.isPositive() ? 'DEPÓSITO DETECTADO.' : 'SAQUE DETECTADO.', {
            valor: `${diferenca.toFixed(2)} USDT`,
            bancaAgora: `${saldo.toFixed(2)} USDT`,
            picoDe: `${antes.pico.toFixed(2)}`,
            picoPara: `${this.disjuntor.pico.toFixed(2)} USDT`,
            nota: 'o pico acompanha a banca — transferência não conta como queda',
        });
    }

    /** Uma linha curta com o estado do freio, para o log de rotina. */
    private resumoDoFreio(): string {
        if (this.paradoDeVez) return 'PARADO DE VEZ';
        if (this.disjuntor === null) return 'desarmado (sem banca)';
        const d = this.disjuntor;
        const falta = d.bloqueadoAteMs - Date.now();
        if (falta > 0) return `pausado ${(falta / 60_000).toFixed(0)}min (${d.perdasSeguidas} perdas seguidas)`;
        const queda = d.pico.greaterThan(0) ? d.pico.minus(d.banca).dividedBy(d.pico).mul(100) : new Decimal(0);
        return `ok · seguidas ${d.perdasSeguidas}/${this.limites.perdasSeguidasMaximas} · dia ${d.resultadoDoDia.toFixed(2)} · doPico -${queda.toFixed(1)}%`;
    }

    /** Fecha a conta de uma operação: o que a banca fez do início ao fim. */
    private async encerrarNoDisjuntor(symbol: string): Promise<void> {
        if (this.disjuntor === null || this.saldoAoEntrar === null) return;
        let saldo: Decimal;
        try {
            saldo = await this.provider.disponivelEmUsdt();
        } catch {
            // Sem leitura não há resultado confiável, e inventar zero
            // esconderia uma perda do disjuntor — que é o oposto do trabalho
            // dele. Mantém a sequência e tenta de novo no próximo ciclo.
            return;
        }
        const resultado = saldo.minus(this.saldoAoEntrar);
        this.saldoAoEntrar = null;
        this.disjuntor = registrarResultado({
            estado: this.disjuntor,
            limites: this.limites,
            resultadoUsdt: resultado,
            agoraMs: Date.now(),
        });
        log.info('RESULTADO REGISTRADO.', {
            symbol,
            resultado: `${resultado.toFixed(4)} USDT`,
            perdasSeguidas: this.disjuntor.perdasSeguidas,
            dia: `${this.disjuntor.resultadoDoDia.toFixed(4)} USDT`,
            banca: `${this.disjuntor.banca.toFixed(2)} USDT`,
            pico: `${this.disjuntor.pico.toFixed(2)} USDT`,
        });
    }

    // ------------------------------------------------------------------
    // Execução
    // ------------------------------------------------------------------
    private async entrar(symbol: string, direcao: 'alta' | 'baixa'): Promise<void> {
        // O freio vem antes de tudo, inclusive de gastar peso de API. Este é o
        // único caminho que abre posição, então é o único lugar que precisa
        // perguntar.
        if (!this.freioLiberado()) return;
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
            // Referência do resultado: o que a banca era antes desta operação.
            // Medir pelo saldo, e não pelo preço de saída, é o que faz taxa e
            // derrapagem entrarem na conta do disjuntor em vez de sumirem.
            this.saldoAoEntrar = disponivel;
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

        // Primeiro como MAKER (0,018% em vez de 0,045%). Se a Binance recusar
        // por não poder ser maker (-5022: o preço já passou), cai para
        // mercado: taxa maior é melhor que alvo nenhum.
        try {
            const qtd = this.posicao?.quantidade ?? new Decimal(0);
            await this.provider.colocarAlvoMaker({ symbol, direcao, preco: saidas.alvo, quantidade: qtd });
            log.info('Alvo colocado (MAKER).', {
                symbol,
                alvo: saidas.alvo.toString(),
                distancia: `${saidas.distanciaDoAlvo.mul(100).toFixed(3)}%`,
            });
            return;
        } catch (err) {
            this.reportarErro('Alvo maker recusado; caindo para mercado', err);
        }

        for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
            try {
                await this.provider.colocarSaida({ symbol, direcao, tipo: 'TAKE_PROFIT_MARKET', precoGatilho: saidas.alvo });
                log.info('Alvo colocado (mercado).', { symbol, alvo: saidas.alvo.toString(), distancia: `${saidas.distanciaDoAlvo.mul(100).toFixed(3)}%` });
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
            try {
                const saldo = await this.provider.disponivelEmUsdt();
                // Compara na MESMA precisão em que se mostra. O availableBalance
                // da Binance oscila em casas decimais invisíveis a cada leitura,
                // e comparar na precisão cheia fazia o log anunciar "mudou" a
                // cada quinze segundos com o mesmo número dos dois lados.
                // Numa noite inteira isso são milhares de linhas que enterram os
                // eventos que se quer encontrar de manhã.
                const mudou = this.saldoAtual === null || saldo.minus(this.saldoAtual).abs().greaterThanOrEqualTo('0.01');
                if (mudou) {
                    log.info('Saldo do Futures mudou.', {
                        de: this.saldoAtual ? `${this.saldoAtual.toFixed(2)} USDT` : 'desconhecido',
                        para: `${saldo.toFixed(2)} USDT`,
                    });
                }
                this.saldoAtual = saldo;
                this.armarDisjuntor(saldo);
                this.reconciliarTransferencia(saldo);
                this.virarODiaSePassou(saldo);
            } catch {
                // Falha de leitura não derruba o ciclo: o saldo antigo é
                // melhor que interromper a medição por causa de um timeout.
            }
            if (this.posicao) {
                const abertas = await this.provider.posicoesAbertas();
                const ainda = abertas.find((a) => a.symbol === this.posicao?.symbol);

                if (!ainda) {
                    const p = this.posicao;
                    this.posicao = null;
                    // A saída que não disparou continua pendurada: cancelar é o
                    // que impede a ordem órfã de reabrir posição contrária.
                    await this.provider.cancelarTudo(p.symbol);
                    await this.encerrarNoDisjuntor(p.symbol);
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

            const profundidades = [...this.janelas.values()].map((j) => j.fechadas.length);
            log.info('CAÇANDO.', {
                banca: this.saldoAtual ? `${this.saldoAtual.toFixed(2)} USDT` : 'lendo...',
                universo: this.universo.length,
                simbolosVistos: this.janelas.size,
                coletasFeitas: this.recebidas,
                velasFechadas: this.fechadasVistas,
                historicoMax: profundidades.length > 0 ? Math.max(...profundidades) : 0,
                comHistorico: profundidades.filter((n) => n >= 3).length,
                sinaisVistos: this.sinaisVistos,
                gravando: this.gravando.length,
                caminhosCompletos:
                    [...this.caminhos.entries()].map(([g, c]) => `${g}:${c.length}`).join(' ') || 'nenhum',
                placar: JSON.stringify(this.placar),
                freio: this.resumoDoFreio(),
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

/**
 * Sobe o motor, insistindo diante de falha TRANSITÓRIA de partida.
 *
 * Antes, qualquer erro no boot chamava process.exit(1) — e no Railway isso
 * virou um ciclo de cinco quedas seguidas ("timestamp malformed" numa chamada
 * assinada) até a sexta tentativa pegar. Só o reinício automático da
 * plataforma salvou.
 *
 * Isso é inaceitável quando houver posição aberta: o processo morre segurando
 * risco, e o stop fica sozinho na corretora sem ninguém para reagir se ele
 * falhar. Insistir aqui não conserta a causa — mas transforma uma queda
 * definitiva numa pausa de segundos.
 *
 * Desiste depois de seis tentativas: se nem assim subiu, o problema é de
 * configuração e reiniciar para sempre só esconderia isso do log.
 */
async function subirComInsistencia(): Promise<void> {
    const MAXIMO = 6;
    for (let tentativa = 1; tentativa <= MAXIMO; tentativa += 1) {
        try {
            await main();
            return;
        } catch (err) {
            const erro = err instanceof Error ? err.message : String(err);
            if (tentativa === MAXIMO) {
                log.error('Motor de scalping abortou depois de insistir.', { tentativas: MAXIMO, erro });
                process.exit(1);
            }
            const esperaMs = Math.min(30_000, 2 ** tentativa * 1000);
            log.warn('Falha ao subir; tentando de novo.', { tentativa, de: MAXIMO, esperaMs, erro });
            await new Promise((r) => setTimeout(r, esperaMs));
        }
    }
}

if (require.main === module) {
    void subirComInsistencia();
}
