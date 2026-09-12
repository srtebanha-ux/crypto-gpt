// Arquivo: src/leadLag.ts
//
// Lead-lag entre Futuros e Spot: o Futuros descobre preço primeiro, o Spot
// segue. A pergunta que este módulo existe para responder NÃO é se o efeito
// existe — existe e é documentado — mas se ele sobrevive à nossa latência.
//
// A CONTA QUE DECIDE TUDO
//
//     evento no Futuros → mensagem chega:   20-80ms
//     processamento:                          ~1ms
//     ordem REST chega no Spot:              20-80ms
//                                            ─────────
//     agimos 50-160ms DEPOIS do evento
//
// O market maker da Binance corrige distorção em milissegundos de um dígito.
// Numa corrida de velocidade nós perdemos por um fator de 10 a 50, e nenhuma
// otimização de código muda isso — a distância física até o datacenter não é
// negociável.
//
// Então este módulo NÃO tenta chegar primeiro. Ele mede outra coisa: quanto o
// Spot ainda anda DEPOIS de já termos chegado. Em evento pequeno a resposta é
// zero — o book já corrigiu. Em cascata de liquidação de verdade o preço
// continua andando por SEGUNDOS, porque os market makers puxam as ofertas em
// vez de corrigi-las, e aí chegar 100ms atrasado ainda pega movimento.
//
// POR QUE AQUI SE USA `number` E NÃO `Decimal`
//
// O resto deste projeto usa Decimal em tudo, de propósito: dinheiro não
// admite erro de ponto flutuante. Aqui o compromisso inverte. Este código roda
// no caminho quente, com milhares de mensagens por segundo, e alocar um
// Decimal por mensagem custa mais que o sinal vale.
//
// A regra que separa os dois casos: `number` para DETECTAR, Decimal para
// DECIDIR quanto comprar. Errar na décima casa decimal de "o preço subiu
// 0,3%?" não muda a resposta; errar na quantidade de uma ordem custa dinheiro.

/** Um negócio agregado do stream de Futuros. */
export interface NegocioDeFuturos {
    tsMs: number;
    preco: number;
    quantidade: number;
    /** true quando o COMPRADOR é o passivo, ou seja: foi uma VENDA agressiva. */
    compradorPassivo: boolean;
}

export interface EventoDetectado {
    tsMs: number;
    preco: number;
    direcao: 'alta' | 'baixa';
    /** Volume nocional da rajada, na moeda de cotação. */
    volumeNocional: number;
    /** Fração do volume que veio do lado dominante. 1 = unânime. */
    unanimidade: number;
    negocios: number;
}

/**
 * Detector de rajada por janela deslizante.
 *
 * Uma rajada é volume grande, concentrado em pouco tempo, e do MESMO LADO. Os
 * três critérios juntos importam, e cada um sozinho produz falso positivo:
 *
 * - só volume: um negócio grande e isolado não move nada se o outro lado
 *   absorveu;
 * - só tempo: mercado agitado tem muitos negócios pequenos que se cancelam;
 * - só direção: uma sequência unânime de negócios minúsculos não é sinal.
 *
 * A janela é um buffer circular de tamanho fixo, sem alocação por mensagem.
 * Com milhares de mensagens por segundo, alocar um array por tick é o tipo de
 * custo que só aparece quando o evento acontece — justamente o pior momento
 * para o processo estar coletando lixo.
 */
export class DetectorDeRajada {
    private readonly tsMs: Float64Array;
    private readonly nocional: Float64Array;
    private readonly ehVenda: Uint8Array;
    private readonly preco: Float64Array;
    private inicio = 0;
    private fim = 0;
    private tamanho = 0;

    /**
     * Instante do último evento emitido, para o período de silêncio.
     *
     * Começa em -infinito, não em zero. Com zero, a checagem de silêncio
     * (`agora − ultimoEvento < silencioMs`) bloquearia o PRIMEIRO evento
     * sempre que o relógio da mensagem fosse menor que o silêncio — invisível
     * em produção, onde o timestamp é epoch e tem 13 dígitos, e fatal em
     * qualquer teste ou replay com relógio começando do zero. O silêncio só
     * pode valer depois de existir um evento para silenciar.
     */
    private ultimoEventoMs = Number.NEGATIVE_INFINITY;

    constructor(
        private readonly params: {
            janelaMs: number;
            /** Volume nocional mínimo na janela para contar como rajada. */
            volumeMinimo: number;
            /** Fração mínima do volume vinda de um lado só. 0.8 = 80%. */
            unanimidadeMinima: number;
            /**
             * Silêncio após um evento. Sem isto, uma cascata de 3 segundos
             * dispara dezenas de vezes e o motor entra várias vezes na mesma
             * distorção — pagando spread em cada uma.
             */
            silencioMs: number;
            capacidade?: number;
        },
    ) {
        const cap = Math.max(64, Math.trunc(params.capacidade ?? 4096));
        this.tsMs = new Float64Array(cap);
        this.nocional = new Float64Array(cap);
        this.ehVenda = new Uint8Array(cap);
        this.preco = new Float64Array(cap);
    }

    private get capacidade(): number {
        return this.tsMs.length;
    }

    /**
     * Registra um negócio e devolve o evento, se este negócio fechou uma
     * rajada. Devolve null na esmagadora maioria das chamadas.
     */
    public registrar(n: NegocioDeFuturos): EventoDetectado | null {
        // Buffer cheio descarta o mais antigo. Preferir descartar dado velho a
        // crescer sem limite: a janela é temporal, e o que saiu dela não
        // deveria influenciar nada mesmo.
        if (this.tamanho === this.capacidade) {
            this.inicio = (this.inicio + 1) % this.capacidade;
            this.tamanho -= 1;
        }
        this.tsMs[this.fim] = n.tsMs;
        this.nocional[this.fim] = n.preco * n.quantidade;
        this.ehVenda[this.fim] = n.compradorPassivo ? 1 : 0;
        this.preco[this.fim] = n.preco;
        this.fim = (this.fim + 1) % this.capacidade;
        this.tamanho += 1;

        // Expira o que saiu da janela temporal.
        const limite = n.tsMs - this.params.janelaMs;
        while (this.tamanho > 0 && this.tsMs[this.inicio] < limite) {
            this.inicio = (this.inicio + 1) % this.capacidade;
            this.tamanho -= 1;
        }

        if (n.tsMs - this.ultimoEventoMs < this.params.silencioMs) return null;

        let compra = 0;
        let venda = 0;
        for (let i = 0; i < this.tamanho; i += 1) {
            const idx = (this.inicio + i) % this.capacidade;
            if (this.ehVenda[idx] === 1) venda += this.nocional[idx];
            else compra += this.nocional[idx];
        }
        const total = compra + venda;
        if (total < this.params.volumeMinimo) return null;

        const dominante = Math.max(compra, venda);
        const unanimidade = dominante / total;
        if (unanimidade < this.params.unanimidadeMinima) return null;

        this.ultimoEventoMs = n.tsMs;
        return {
            tsMs: n.tsMs,
            preco: n.preco,
            direcao: compra >= venda ? 'alta' : 'baixa',
            volumeNocional: total,
            unanimidade,
            negocios: this.tamanho,
        };
    }
}

/**
 * O que aconteceu no Spot DEPOIS do evento — a medição que decide o projeto.
 *
 * Guardada em fração com SINAL relativo à direção prevista: positivo significa
 * que o Spot andou a favor do que o Futuros indicou. Registrar o movimento
 * bruto perderia justamente a informação que interessa, que é acerto de
 * direção, não tamanho.
 */
export interface AmostraDeAtraso {
    /** Milissegundos após o evento em que a leitura foi feita. */
    apossMs: number;
    /** Movimento do Spot a FAVOR da direção prevista, como fração. */
    aFavor: number;
}

export function movimentoAFavor(params: {
    precoAntes: number;
    precoDepois: number;
    direcao: 'alta' | 'baixa';
}): number {
    if (params.precoAntes <= 0) return 0;
    const variacao = (params.precoDepois - params.precoAntes) / params.precoAntes;
    return params.direcao === 'alta' ? variacao : -variacao;
}

export interface VeredictoDeExecucao {
    vale: boolean;
    motivo: string;
    margem: number;
}

/**
 * Vale seguir o evento, dado o que custa entrar e sair?
 *
 * Com taxa zero sobra o SPREAD do Spot — pago na entrada e de novo na saída.
 * É a mesma equação da microestrutura, e ela não desaparece por o sinal vir de
 * outro mercado: um sinal que acerta a direção 100% das vezes ainda perde
 * dinheiro se o movimento previsto for menor que o custo de atravessar.
 */
export function valeSeguirOEvento(params: {
    /** Movimento esperado a favor, medido historicamente. */
    movimentoEsperado: number;
    /** Spread do Spot como fração do preço. */
    spreadSpot: number;
    /** Taxa por perna. Zero nos pares FDUSD isentos. */
    taxaPorPerna: number;
    /** Margem exigida sobre o custo. 1.5 = precisa render 50% além. */
    folga?: number;
}): VeredictoDeExecucao {
    const folga = params.folga ?? 1.5;
    const custo = params.spreadSpot + 2 * params.taxaPorPerna;
    const necessario = custo * folga;
    const margem = params.movimentoEsperado - necessario;
    return {
        vale: params.movimentoEsperado > necessario,
        margem,
        motivo:
            `Movimento esperado ${(params.movimentoEsperado * 100).toFixed(4)}% contra custo de ` +
            `${(custo * 100).toFixed(4)}% (spread ${(params.spreadSpot * 100).toFixed(4)}% + taxa ` +
            `${(params.taxaPorPerna * 200).toFixed(4)}%), exigindo ${(necessario * 100).toFixed(4)}% com folga.`,
    };
}

/**
 * Acumula as amostras e devolve a estatística que aprova ou reprova a ideia.
 *
 * A mediana vem junto da média de propósito: um único evento gigante levanta a
 * média e cria a ilusão de um efeito que não se repete. Quando média e mediana
 * discordam muito, o que existe é um outlier, não uma vantagem.
 */
export class EstatisticaDeAtraso {
    private readonly porHorizonte = new Map<number, number[]>();

    public registrar(amostra: AmostraDeAtraso): void {
        const lista = this.porHorizonte.get(amostra.apossMs) ?? [];
        lista.push(amostra.aFavor);
        this.porHorizonte.set(amostra.apossMs, lista);
    }

    public resumo(): Array<{
        apossMs: number;
        amostras: number;
        media: number;
        mediana: number;
        acertosDeDirecao: number;
    }> {
        return Array.from(this.porHorizonte.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([apossMs, valores]) => {
                const ordenados = [...valores].sort((a, b) => a - b);
                const meio = Math.floor(ordenados.length / 2);
                const mediana =
                    ordenados.length % 2 === 0
                        ? (ordenados[meio - 1] + ordenados[meio]) / 2
                        : ordenados[meio];
                return {
                    apossMs,
                    amostras: valores.length,
                    media: valores.reduce((a, b) => a + b, 0) / valores.length,
                    mediana,
                    acertosDeDirecao: valores.filter((v) => v > 0).length / valores.length,
                };
            });
    }
}

// ---------------------------------------------------------------------------
// LIQUIDAÇÕES: o gatilho que não precisa ser inferido
// ---------------------------------------------------------------------------

/**
 * Uma liquidação forçada, do stream `forceOrder` da Binance.
 *
 * É a fonte de sinal mais limpa que existe para este motor, e por um motivo
 * mecânico: quando a corretora liquida alguém, ela NÃO está escolhendo operar.
 * Ela é obrigada a varrer o livro para fechar a posição, ao preço que houver.
 * Não é opinião sobre valor, é execução compulsória.
 *
 * E é por isso que a distorção dura: vendo uma varredura dessas chegando, os
 * market makers PUXAM as ofertas em vez de corrigir o preço. Sem defesa no
 * livro, o movimento não é revertido em milissegundos — ele continua enquanto
 * a liquidação estiver sendo executada.
 *
 * Inferir isso de volume no `@aggTrade` funciona, mas chega depois e com
 * falso positivo. O `forceOrder` avisa direto, e diz o TAMANHO.
 */
export interface Liquidacao {
    tsMs: number;
    symbol: string;
    /**
     * Lado da ORDEM DE LIQUIDAÇÃO, não da posição liquidada.
     *
     * A inversão aqui é a fonte de erro mais provável deste módulo inteiro:
     * quem estava COMPRADO e foi liquidado gera uma ordem de VENDA, que
     * empurra o preço para BAIXO. Ler o lado como se fosse o da posição
     * inverteria a direção de toda operação — um erro que não estoura, só
     * perde dinheiro de forma consistente.
     */
    lado: 'BUY' | 'SELL';
    preco: number;
    quantidade: number;
}

/** A direção que o preço tende a tomar. Venda forçada empurra para baixo. */
export function direcaoDaLiquidacao(l: Liquidacao): 'alta' | 'baixa' {
    return l.lado === 'SELL' ? 'baixa' : 'alta';
}

/**
 * A liquidação é grande o bastante para mover o mercado?
 *
 * O limiar é em nocional, não em quantidade: 10 BTC e 10 DOGE não são o mesmo
 * evento, e usar quantidade faria o detector disparar em toda moeda barata.
 */
export function liquidacaoRelevante(l: Liquidacao, nocionalMinimo: number): boolean {
    return l.preco * l.quantidade >= nocionalMinimo;
}

// ---------------------------------------------------------------------------
// A MEDIÇÃO QUE DECIDE: T0 → T1 → T2
// ---------------------------------------------------------------------------

/**
 * A janela de um evento, do disparo até a saída.
 *
 *   T0 — preço no Futuros no instante do evento. Referência, NÃO entrada.
 *   T1 — preço no Spot depois da nossa latência real. É AQUI que entraríamos.
 *   T2 — melhor preço de saída no Spot dentro do horizonte.
 *
 * O que decide o projeto é T1 → T2, e não T0 → T2. A diferença entre os dois
 * é exatamente o movimento que já aconteceu antes de conseguirmos agir — e
 * medir a partir de T0 seria contabilizar como lucro um pedaço do movimento
 * que nunca esteve disponível para nós. É o erro que faz backtest de HFT
 * parecer maravilhoso e produção parecer quebrada.
 */
export interface JanelaDeEvento {
    tsEventoMs: number;
    direcao: 'alta' | 'baixa';
    precoFuturosT0: number;
    /** Preço do Spot na nossa entrada realista. null = não houve tick a tempo. */
    precoSpotT1: number | null;
    /** Melhor preço de saída visto no horizonte, a favor da direção. */
    melhorSpotT2: number | null;
    /** Pior preço visto — o quanto a operação ficaria contra antes de virar. */
    piorSpotT2: number | null;
}

export interface ResultadoDaJanela {
    /** Movimento capturável, de T1 até o melhor T2, como fração. */
    capturavel: number;
    /** Excursão contrária máxima antes disso — o stop que a operação exigiria. */
    excursaoContraria: number;
    /** O quanto do movimento já tinha ido embora antes de podermos entrar. */
    perdidoNaLatencia: number;
}

export function medirJanela(j: JanelaDeEvento): ResultadoDaJanela | null {
    if (j.precoSpotT1 === null || j.melhorSpotT2 === null || j.precoSpotT1 <= 0) return null;
    const sinal = j.direcao === 'alta' ? 1 : -1;

    const capturavel = (sinal * (j.melhorSpotT2 - j.precoSpotT1)) / j.precoSpotT1;
    const excursaoContraria =
        j.piorSpotT2 === null ? 0 : Math.max(0, (sinal * (j.precoSpotT1 - j.piorSpotT2)) / j.precoSpotT1);
    // O movimento que aconteceu entre o evento e a nossa entrada. Não é lucro
    // nosso, e é o número que separa a promessa do resultado.
    const perdidoNaLatencia =
        j.precoFuturosT0 > 0 ? (sinal * (j.precoSpotT1 - j.precoFuturosT0)) / j.precoFuturosT0 : 0;

    return { capturavel, excursaoContraria, perdidoNaLatencia };
}
