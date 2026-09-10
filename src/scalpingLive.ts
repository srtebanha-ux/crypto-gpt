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
                  `z=${c.z.toFixed(2)}) ${c.alvos}A/${c.stops}S/${c.abertos}ab, EV ${c.evPorOperacao.mul(100).toFixed(4)}%`
                : 'fora da grade';

        log.info(`GRADE [${gatilho}].`, {
            completos: caminhos.length,
            seguindo: resumo(naConfig(seguindo)),
            contra: resumo(naConfig(contra)),
            acasoSeria: '57.1%',
        });

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
            });
        }
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
            this.varredura.registrar(agora);
            this.auditoria.varreduras += 1;

            for (const q of quedas) {
                const anterior = this.ultimaCascataMs.get(q.symbol) ?? Number.NEGATIVE_INFINITY;
                if (agora.emMs - anterior < 30 * 60_000) continue; // uma cascata por par por meia hora
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
        // Todo sinal vira caminho medido, ao vivo ou não. Medir é o que
        // transforma a escolha de alvo e stop em resultado em vez de opinião.
        this.gravando.push({
            gatilho: 'volume',
            caminho: { symbol, direcao: sinal.direcao, entrada: sinal.preco, velas: [] },
            restantes: JANELA_DE_MEDICAO,
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
                if (this.saldoAtual === null || !saldo.equals(this.saldoAtual)) {
                    log.info('Saldo do Futures mudou.', {
                        de: this.saldoAtual ? `${this.saldoAtual.toFixed(2)} USDT` : 'desconhecido',
                        para: `${saldo.toFixed(2)} USDT`,
                    });
                }
                this.saldoAtual = saldo;
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
                caminhosCompletos: [...this.caminhos.entries()].map(([g, c]) => `${g}:${c.length}`).join(' '),
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
