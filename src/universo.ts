// Arquivo: src/universo.ts
//
// QUAIS moedas o motor vigia — e por que isso importa mais que os parâmetros.
//
// A lista de ativos era fixa, escolhida uma vez e nunca revista. O custo disso
// não aparece em nenhum log: o motor nunca reclama das moedas que NÃO está
// olhando. Ele diz "sem sinal" para vinte ativos parados enquanto, fora da
// lista, uma moeda anda 40% no dia.
//
// Nenhum ajuste de RSI, stop ou alavancagem resolve isso. Uma estratégia que
// busca movimento e olha só para ativos parados não tem o que encontrar.
//
// A REGRA QUE NÃO PODE SER QUEBRADA: moeda com posição aberta continua no
// universo, sempre, mesmo que pare de se mover. Uma posição fora do universo é
// uma posição que o motor deixa de avaliar — sem stop, sem saída, sem
// ninguém olhando. É a receita exata da posição órfã, e trocar o universo
// dinamicamente multiplicaria as chances de criá-la.
import { Decimal } from 'decimal.js';

/** O que a corretora informa sobre cada par nas últimas 24h. */
export interface CandidatoDeUniverso {
    symbol: string;
    /** Variação percentual em 24h (5.2 = +5,2%). */
    variacao24h: Decimal;
    /** Volume negociado na moeda de cotação (USDT). Serve de filtro de liquidez. */
    volumeQuote: Decimal;
}

/**
 * Sufixos e nomes que NUNCA entram, por motivos diferentes.
 *
 * Tokens alavancados (UP/DOWN/BULL/BEAR) parecem candidatos perfeitos: eles
 * lideram qualquer lista de maiores variações, porque são alavancados por
 * construção. Mas eles têm decaimento embutido — carregar um por dias custa
 * dinheiro mesmo com o preço parado — e o motor não modela isso em lugar
 * nenhum. Entrariam no topo da lista todo dia e sangrariam em silêncio.
 *
 * Stablecoins entram pelo motivo oposto: elas não se movem, e quando aparecem
 * com variação alta é ruído de dado, não oportunidade.
 */
const SUFIXOS_ALAVANCADOS = ['UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT'];
const STABLES = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'DAIUSDT', 'EURUSDT', 'USDPUSDT'];

/** O par é elegível para o universo? */
export function parElegivel(symbol: string): boolean {
    if (!symbol.endsWith('USDT')) return false;
    if (STABLES.includes(symbol)) return false;
    return !SUFIXOS_ALAVANCADOS.some((sufixo) => symbol.endsWith(sufixo));
}

/**
 * Escolhe as moedas que MAIS SE MOVERAM, em qualquer direção.
 *
 * Direção não entra na conta, e isso é deliberado: `reversion` compra queda
 * forte e `momentum` compra alta forte. As duas precisam da mesma coisa —
 * movimento —, e ordenar por variação com sinal daria a uma delas uma lista
 * de candidatos que a outra descarta inteira.
 *
 * O filtro de volume é o que impede a lista de virar uma coleção de moedas
 * mortas: variação alta com volume baixo é preço de uma ordem solitária, não
 * mercado. Entrar nelas significa atravessar um spread enorme na entrada e
 * outro na saída, e essa conta come qualquer movimento capturado.
 */
export function selecionarUniverso(params: {
    candidatos: CandidatoDeUniverso[];
    quantidade: number;
    volumeMinimo: Decimal;
    /** Moedas com posição aberta: entram SEMPRE, fora da contagem. */
    comPosicao?: string[];
}): string[] {
    const comPosicao = (params.comPosicao ?? []).filter(parElegivel);
    const jaDentro = new Set(comPosicao);

    const ordenados = params.candidatos
        .filter((c) => parElegivel(c.symbol))
        .filter((c) => c.volumeQuote.greaterThanOrEqualTo(params.volumeMinimo))
        .filter((c) => !jaDentro.has(c.symbol))
        .sort((a, b) => {
            const diff = b.variacao24h.abs().minus(a.variacao24h.abs());
            // Empate resolvido pelo nome, não pela ordem de chegada da API: um
            // universo que muda sozinho entre dois ciclos idênticos faria o
            // motor abrir e largar posição por ruído de ordenação.
            if (!diff.isZero()) return diff.isPositive() ? 1 : -1;
            return a.symbol.localeCompare(b.symbol);
        });

    const escolhidos = ordenados.slice(0, Math.max(0, Math.trunc(params.quantidade)));
    // As com posição vêm primeiro: se algum limite cortar a lista adiante, o
    // que sobrevive é o que precisa de gestão, não o que parece promissor.
    return [...comPosicao, ...escolhidos.map((c) => c.symbol)];
}
