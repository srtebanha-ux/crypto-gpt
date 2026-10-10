// Arquivo: src/precoDeMercado.ts
//
// O preco real, em tempo real, de graca.
//
// O oraculo da Aave e uma copia atrasada disto. Ler aqui custa zero Unidades
// de Computacao, porque nao passa pela blockchain — e e por isso que da para
// olhar o tempo todo, enquanto olhar a blockchain o tempo todo estouraria o
// orcamento do mes em horas.
import { Decimal } from 'decimal.js';
import { buscar } from './conexoes';

export const BINANCE = process.env.CACA_BINANCE_REST ?? 'https://api.binance.com';

/** `symbol()` — o simbolo do token, lido da propria blockchain. */
export const SELETOR_SYMBOL = '0x95d89b41';

/**
 * De que par da Binance este token segue o preco.
 *
 * O mapa e por SIMBOLO, lido on-chain, e nao por endereco escrito aqui. Uma
 * lista de enderecos decorados envelhece em silencio e e exatamente o tipo de
 * coisa que este projeto ja errou; o simbolo vem do proprio contrato.
 *
 * `null` quer dizer "nao acompanho", e e uma resposta legitima: stablecoin nao
 * derruba ninguem por variacao de preco, e token sem par liquido na Binance
 * daria um preco pior que o do oraculo.
 */
export function simboloDaBinance(simboloDoToken: string): string | null {
    const s = simboloDoToken.trim().toUpperCase();
    // So os que valem o MESMO que a moeda do par. wstETH, cbETH e weETH
    // rendem juros e valem MAIS que um ETH — comparar o preco deles com
    // ETHUSDT daria uma "queda" permanente de uns 17%, e o bot ficaria preso
    // em 'dedo no gatilho' para sempre, lendo a blockchain a 200ms sem motivo.
    // Seguir o preco deles exige a taxa de conversao, que a gente nao le.
    if (s === 'WETH' || s === 'ETH') return 'ETHUSDT';
    if (s === 'CBBTC' || s === 'WBTC' || s === 'BTC') return 'BTCUSDT';
    return null;
}

/** Le a resposta de `symbol()`, que vem como string ABI. */
export function lerSymbol(hex: string): string | null {
    const sem = hex.replace(/^0x/, '');
    if (sem.length < 128) return null;
    try {
        const tamanho = Number.parseInt(sem.slice(64, 128), 16);
        if (!Number.isFinite(tamanho) || tamanho <= 0 || tamanho > 64) return null;
        const bytes = sem.slice(128, 128 + tamanho * 2);
        return Buffer.from(bytes, 'hex').toString('utf8');
    } catch {
        return null;
    }
}

/** O que a Binance devolve em /api/v3/ticker/price. */
export interface CotacaoCrua { symbol: string; price: string }

/**
 * Le as cotacoes, tolerando resposta estranha em vez de derrubar o cacador.
 *
 * Preco de mercado e acelerador, nao motor: se a Binance nao responder, o bot
 * volta ao ritmo normal e continua cacando pelo oraculo. Por isso aqui nada
 * lanca — devolve o que deu para ler.
 */
export function lerCotacoes(corpo: unknown): Map<string, Decimal> {
    const fora = new Map<string, Decimal>();
    if (!Array.isArray(corpo)) return fora;
    for (const item of corpo as CotacaoCrua[]) {
        if (typeof item?.symbol !== 'string' || typeof item?.price !== 'string') continue;
        try {
            const p = new Decimal(item.price);
            if (p.greaterThan(0)) fora.set(item.symbol, p);
        } catch { /* cotacao ilegivel nao vira zero, vira ausencia */ }
    }
    return fora;
}

/**
 * Quanto o MERCADO ja caiu em relacao ao que esta escrito na blockchain.
 *
 * Este e o numero que adianta o futuro. O feed Chainlink so escreve quando se
 * afasta de um limiar, entao enquanto ele nao escreve este valor cresce — e
 * quem esta a menos disso de ser liquidado ja caiu de fato, so que a Aave
 * ainda nao sabe.
 *
 * So queda conta: preco subindo nao derruba ninguem de pe.
 */
export function quedaDoMercado(
    doMercado: Map<string, Decimal>,
    doOraculo: Map<string, Decimal>,
): Decimal {
    let maior = new Decimal(0);
    for (const [par, mercado] of doMercado) {
        const oraculo = doOraculo.get(par);
        if (!oraculo || oraculo.lessThanOrEqualTo(0)) continue;
        const queda = oraculo.minus(mercado).dividedBy(oraculo).mul(100);
        if (queda.greaterThan(maior)) maior = queda;
    }
    return maior;
}

/** Busca as cotacoes dos pares pedidos. Devolve mapa vazio se falhar. */
export async function cotacoesDaBinance(
    pares: string[],
    timeoutMs = 2000,
    /** Injetavel para o teste nao bater na rede real. */
    pedir: typeof buscar = buscar,
    /**
     * O SINAL DE FORA, e ele conserta um defeito de producao.
     *
     * Esta funcao montava o proprio `AbortSignal.timeout(timeoutMs)` e nunca
     * via o PODAO do orcamento de `cotacoesDeQualquerFonte`. Como lá o
     * `Promise.allSettled` espera as TRES casas, a perna da Binance segurava
     * a volta inteira ate o timeout DELA — o orcamento nao a cortava.
     *
     * E isso morde em producao todo ciclo: o cabecalho da secao do orcamento,
     * neste mesmo arquivo, registra que **na Railway a Binance bloqueia IP de
     * nuvem**. Ou seja, a casa que nunca responde era exatamente a que o teto
     * nao alcancava. O orcamento de 400ms voltava em ~2000ms.
     *
     * ACHADO POR UM TESTE QUE PISCAVA. `o orçamento é um TETO, e uma casa
     * pendurada não segura o ciclo` cancelava em 2 de 3 rodadas com
     * "Promise resolution is still pending" em vez de reprovar limpo — e foi
     * essa piscada que me deixou dar push com a suite vermelha. Teste
     * intermitente nao e chateacao: e a suite perdendo a capacidade de
     * responder "quebrou?".
     *
     * O padrao mantem o comportamento de quem chama sem o sinal.
     */
    sinal: () => AbortSignal = () => AbortSignal.timeout(timeoutMs),
): Promise<Map<string, Decimal>> {
    if (pares.length === 0) return new Map();
    const lista = encodeURIComponent(JSON.stringify([...new Set(pares)]));
    try {
        const r = await pedir(`${BINANCE}/api/v3/ticker/price?symbols=${lista}`, {
            signal: sinal(),
        });
        return lerCotacoes(await r.json());
    } catch {
        return new Map();
    }
}

// ---------------------------------------------------------------------------
// Quando a Binance nao responde.
// ---------------------------------------------------------------------------
//
// Ela bloqueia IP de nuvem, e o Railway e nuvem. O log denunciou isso no
// primeiro boot — "MERCADO MUDO" — e sem preco de mercado o bot perde a
// vantagem inteira de antecipar o oraculo e volta ao ritmo fixo.
//
// Uma fonte so era ponto unico de falha para a parte mais valiosa do desenho.
// Agora sao tres, e a primeira que responder ganha.

/** Le a cotacao unica da Coinbase: { price: "2646.93" }. */
export function lerCoinbase(corpo: unknown): Decimal | null {
    const p = (corpo as { price?: string })?.price;
    if (typeof p !== 'string') return null;
    try {
        const d = new Decimal(p);
        return d.greaterThan(0) ? d : null;
    } catch { return null; }
}

/** Le a cotacao da Kraken: { result: { XETHZUSD: { c: ["2646.93", ...] } } }. */
export function lerKraken(corpo: unknown): Decimal | null {
    const r = (corpo as { result?: Record<string, { c?: string[] }> })?.result;
    if (!r) return null;
    for (const par of Object.values(r)) {
        const v = par?.c?.[0];
        if (typeof v !== 'string') continue;
        try {
            const d = new Decimal(v);
            if (d.greaterThan(0)) return d;
        } catch { /* proxima */ }
    }
    return null;
}

/** De que produto de cada casa vem o preco de um par da Binance. */
export const EQUIVALENTES: Record<string, { coinbase: string; kraken: string }> = {
    ETHUSDT: { coinbase: 'ETH-USD', kraken: 'ETHUSD' },
    BTCUSDT: { coinbase: 'BTC-USD', kraken: 'XBTUSD' },
};

export const COINBASE = process.env.CACA_COINBASE_REST ?? 'https://api.exchange.coinbase.com';
export const KRAKEN = process.env.CACA_KRAKEN_REST ?? 'https://api.kraken.com';

/**
 * O ORCAMENTO total desta funcao, em milissegundos.
 *
 * Ela roda no `finally` de TODO ciclo do cacador, entao o tempo dela entra
 * inteiro na latencia do bot. Um teto aqui e a unica coisa que impede uma casa
 * lenta de segurar a cacada.
 */
export const ORCAMENTO_DO_MERCADO_MS = 2500;

/**
 * As cotacoes, de onde der — TODAS as casas ao mesmo tempo.
 *
 * MEDIDO EM 2026-09-30, e e a causa de um ciclo de 11,4 segundos que ela viu em
 * producao e eu tinha atribuido ao RPC.
 *
 * A versao anterior era sequencial em DOIS niveis: primeiro a Binance inteira,
 * depois cada casa, e dentro de cada casa um `await` por par. Com 3 pares e
 * timeout de 2s por chamada o teto era
 *
 *     binance 2s + coinbase 3x2s + kraken 3x2s = 14.000 ms
 *
 * e na Railway a Binance bloqueia IP de nuvem (o comentario acima ja
 * registrava isso), entao TODO ciclo pagava a falha dela antes de comecar. Os
 * 11,4 s medidos caem exatamente dentro dessa escada.
 *
 * Agora as tres casas e todos os pares saem JUNTOS, e o teto passa a ser UM
 * timeout em vez da soma de sete. A preferencia continua sendo binance ->
 * coinbase -> kraken, mas entre as que RESPONDERAM: preferir uma casa nao pode
 * custar o tempo de esperar por ela.
 *
 *     antes, pior caso .... 14.000 ms
 *     agora, pior caso .....  2.500 ms (o orcamento)
 *
 * `Promise.allSettled` e nao `Promise.all`: uma casa que estoura nao pode
 * derrubar as outras duas, e a diferenca entre "ninguem respondeu" e "uma
 * falhou" e o que o log precisa dizer.
 */
export async function cotacoesDeQualquerFonte(
    pares: string[],
    timeoutMs = 2000,
    orcamentoMs = ORCAMENTO_DO_MERCADO_MS,
    /**
     * Injetavel para o teste poder provar o PARALELISMO e o TETO sem rede.
     * Sem isto os dois consertos deste commit seriam indemonstraveis, e
     * "otimizei a latencia" ficaria sendo uma afirmacao minha em vez de um
     * numero — que e exatamente o que a regra 1 deste projeto proibe.
     */
    pedir: typeof buscar = buscar,
): Promise<{ precos: Map<string, Decimal>; fonte: string }> {
    if (pares.length === 0) return { precos: new Map(), fonte: 'nenhuma' };
    // Nenhuma chamada pode durar mais que o orcamento inteiro: sem este corte,
    // `timeoutMs` maior que o orcamento faria o teto ser letra morta.
    const porChamada = Math.max(1, Math.min(timeoutMs, orcamentoMs));

    /**
     * O corte do orcamento ABORTA as chamadas, nao so desiste de esperar.
     *
     * A primeira versao deste conserto cortava com `Promise.race` contra um
     * `setTimeout` e seguia em frente — e o TESTE pegou: as promessas das casas
     * ficavam PENDURADAS para sempre. Em producao isso vaza a cada ciclo que
     * estoura o orcamento: tres promessas e os sockets debaixo delas, de 200ms
     * em 200ms, por horas.
     *
     * Trocar espera por vazamento nao e otimizar latencia. Agora o orcamento
     * derruba o `fetch` de verdade, e toda promessa resolve.
     */
    const podao = new AbortController();
    // SEM `unref`, de proposito. Um timer sem ref nao segura o event loop, e o
    // abort simplesmente NAO DISPARAVA quando nada mais estava pendente — o
    // teste do orcamento acusou "Promise resolution is still pending". O
    // `clearTimeout` no `finally` abaixo e que garante que ele nao sobrevive a
    // chamada, entao manter a ref e seguro e e o que faz o teto existir.
    const relogio = setTimeout(() => podao.abort(new Error('estourou o orçamento do mercado')), orcamentoMs);
    /** O sinal de cada chamada: o teto dela OU o podão, o que vier primeiro. */
    const sinal = (): AbortSignal => AbortSignal.any([podao.signal, AbortSignal.timeout(porChamada)]);

    const umaCasa = async (
        nome: string,
        buscarUm: (par: string) => Promise<Decimal | null>,
    ): Promise<{ nome: string; precos: Map<string, Decimal> }> => {
        // Os pares em PARALELO. Era aqui que cada par custava um timeout.
        const resultados = await Promise.allSettled(pares.map(async (par) => [par, await buscarUm(par)] as const));
        const precos = new Map<string, Decimal>();
        for (const r of resultados) {
            if (r.status === 'fulfilled' && r.value[1] !== null) precos.set(r.value[0], r.value[1]);
        }
        return { nome, precos };
    };

    try {
        // A ORDEM desta lista e a preferencia, e ela vale entre as que
        // RESPONDERAM: preferir uma casa nao pode custar o tempo de esperar
        // por ela, que era o defeito.
        const assentados = await Promise.allSettled([
            // O `sinal` entra aqui: sem ele a perna da Binance so obedecia ao
            // timeout dela e o orcamento nao a cortava — ver a docstring do
            // parametro em `cotacoesDaBinance`.
            umaCasa('binance', async (par) => (
                await cotacoesDaBinance([par], porChamada, pedir, sinal)).get(par) ?? null),
            umaCasa('coinbase', async (par) => {
                const eq = EQUIVALENTES[par]?.coinbase;
                if (!eq) return null;
                const r = await pedir(`${COINBASE}/products/${eq}/ticker`, { signal: sinal() });
                return lerCoinbase(await r.json());
            }),
            umaCasa('kraken', async (par) => {
                const eq = EQUIVALENTES[par]?.kraken;
                if (!eq) return null;
                const r = await pedir(`${KRAKEN}/0/public/Ticker?pair=${eq}`, { signal: sinal() });
                return lerKraken(await r.json());
            }),
        ]);
        for (const r of assentados) {
            if (r.status === 'fulfilled' && r.value.precos.size > 0) {
                return { precos: r.value.precos, fonte: r.value.nome };
            }
        }
        // "ninguem respondeu" e "o orcamento cortou" sao coisas diferentes, e
        // publicar as duas com a mesma etiqueta seria ausencia com cara de
        // resposta na linha que o log usa para decidir o ritmo.
        return { precos: new Map(), fonte: podao.signal.aborted ? 'estourou o orçamento' : 'nenhuma' };
    } finally {
        clearTimeout(relogio);
    }
}
