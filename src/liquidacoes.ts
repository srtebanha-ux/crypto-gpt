// Leitura do histórico de liquidações em protocolos de empréstimo on-chain.
//
// A pergunta que este arquivo existe para responder é uma só, e ela decide se
// vale construir qualquer coisa depois:
//
//   Nos últimos meses, quantas liquidações GRANDES aconteceram, e sobrou
//   alguma para quem não tem servidor colado no validador?
//
// Liquidação é o alvo certo — e não arbitragem — por causa de onde vem o
// tamanho. Numa arbitragem o lucro tem teto na profundidade da piscina: o
// próprio trade empurra o preço e fecha a diferença no meio do caminho, o que
// `getAmountOut` em ammMath.ts calcula. Numa liquidação o tamanho vem da
// DÍVIDA DE OUTRA PESSOA. O bônus é uma fração dela, e quem liquida pode pegar
// o valor emprestado por flash loan. Capital próprio vira gás, não limite.
//
// Nada aqui envia transação, assina, ou precisa de chave privada. É leitura.
import { Decimal } from 'decimal.js';
import { decodeAddressWord, decodeUintWord, fromRawUnits, stripHexPrefix } from './evmAbi';

/**
 * Assinatura do evento que o Aave V3 emite ao liquidar:
 *
 *   LiquidationCall(address,address,address,uint256,uint256,address,bool)
 *
 * O valor é o keccak-256 dessa string, e ele está AQUI COMO PALPITE: o
 * ambiente onde este código foi escrito não alcança a rede (403 no proxy) e a
 * pasta não tem keccak — os seletores em evmAbi.ts são constantes pelo mesmo
 * motivo. Conferir exigiria uma chamada que eu não posso fazer.
 *
 * Por isso o leitor tem MODO DESCOBERTA: sem tópico configurado, ele busca os
 * eventos do contrato sem filtro nenhum e devolve quantos de cada tipo
 * apareceram. A primeira rodada real vira a verificação que eu não consegui
 * fazer — e se este palpite estiver errado, o log mostra o certo em vez de
 * devolver zero em silêncio.
 */
export const TOPIC_LIQUIDATION_CALL =
    '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';

export interface LogCru {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
}

export interface Liquidacao {
    bloco: number;
    transacao: string;
    /** Quem tomou emprestado e não pagou. */
    devedor: string;
    /** O token da dívida que foi quitada. */
    ativoDaDivida: string;
    /** O token que o liquidante levou como prêmio. */
    ativoDaGarantia: string;
    /** Quanto da dívida foi coberto, em unidades CRUAS do token. */
    dividaCrua: Decimal;
    /** Quanto de garantia o liquidante levou, em unidades CRUAS. */
    garantiaCrua: Decimal;
    /** Quem executou — o endereço que ficou com o bônus. */
    liquidante: string;
}

/** Endereço de 32 bytes (como vem em `topics`) para os 20 bytes de verdade. */
export function enderecoDoTopico(topico: string): string {
    const sem = stripHexPrefix(topico);
    if (sem.length < 40) throw new Error(`Tópico curto demais para conter endereço: ${topico}`);
    return `0x${sem.slice(-40).toLowerCase()}`;
}

/**
 * Decodifica um log de LiquidationCall.
 *
 * Os três endereços vêm em `topics` porque são `indexed`; os números e o
 * endereço do liquidante vêm em `data`, em palavras de 32 bytes:
 *
 *   data[0] = debtToCover
 *   data[1] = liquidatedCollateralAmount
 *   data[2] = liquidator
 *   data[3] = receiveAToken
 */
export function decodificarLiquidacao(log: LogCru): Liquidacao {
    if (log.topics.length < 4) {
        throw new Error(`LiquidationCall precisa de 4 tópicos, veio com ${log.topics.length}`);
    }
    return {
        bloco: Number.parseInt(log.blockNumber, 16),
        transacao: log.transactionHash,
        ativoDaGarantia: enderecoDoTopico(log.topics[1]),
        ativoDaDivida: enderecoDoTopico(log.topics[2]),
        devedor: enderecoDoTopico(log.topics[3]),
        dividaCrua: decodeUintWord(log.data, 0),
        garantiaCrua: decodeUintWord(log.data, 1),
        liquidante: decodeAddressWord(log.data, 2),
    };
}

export interface Token {
    simbolo: string;
    decimais: number;
    /** Vale ~1 dólar? Só para esses dá para dizer o valor sem consultar preço. */
    estavel: boolean;
}

/**
 * Tokens conhecidos na Base.
 *
 * Deliberadamente curto e deliberadamente sem chute: um token fora desta lista
 * NÃO vira dólar por aproximação. Ele aparece no relatório como "não
 * convertido", com o número cru. Inventar uma cotação para caber na tabela
 * seria o mesmo erro do `acasoSeria` fixo — número certo de aparência,
 * conclusão errada.
 */
export const TOKENS_BASE: Record<string, Token> = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { simbolo: 'USDC', decimais: 6, estavel: true },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { simbolo: 'USDbC', decimais: 6, estavel: true },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { simbolo: 'DAI', decimais: 18, estavel: true },
    '0x4200000000000000000000000000000000000006': { simbolo: 'WETH', decimais: 18, estavel: false },
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { simbolo: 'cbETH', decimais: 18, estavel: false },
};

/**
 * Valor da dívida em dólares — ou null quando não dá para saber.
 *
 * Null é uma resposta legítima e importante: significa "dívida em token que eu
 * não sei cotar". Some do histograma de dólares e aparece contado à parte, em
 * vez de entrar com um valor inventado.
 */
export function valorEmDolares(l: Liquidacao, tokens: Record<string, Token> = TOKENS_BASE): Decimal | null {
    const t = tokens[l.ativoDaDivida.toLowerCase()];
    if (!t || !t.estavel) return null;
    return fromRawUnits(l.dividaCrua, t.decimais);
}

/** As faixas do histograma, em dólares. A última é aberta para cima. */
export const FAIXAS_USD = [1_000, 10_000, 50_000, 100_000, 500_000];

export interface ResumoDoHistorico {
    total: number;
    /** Quantas não deu para cotar, por falta do token na tabela. */
    semCotacao: number;
    /** Chave = piso da faixa em dólares. */
    porFaixa: Record<number, number>;
    /** Quantos endereços diferentes capturaram alguma. */
    liquidantesDistintos: number;
    /** Os maiores capturadores, do maior para o menor. */
    maioresLiquidantes: Array<{ endereco: string; quantas: number }>;
    maior: Decimal | null;
}

/**
 * O relatório que decide se a ideia vive.
 *
 * `liquidantesDistintos` é a linha mais importante e é fácil não perceber por
 * quê: ela mede se o lugar está tomado. Trezentas liquidações gordas capturadas
 * por três endereços significam três robôs profissionais dividindo tudo — e
 * qualquer um que chegar agora disputa com eles em milissegundos. As mesmas
 * trezentas espalhadas por duzentos endereços significam que sobra.
 */
export function resumirHistorico(
    liquidacoes: Liquidacao[],
    tokens: Record<string, Token> = TOKENS_BASE,
): ResumoDoHistorico {
    const porFaixa: Record<number, number> = {};
    for (const f of FAIXAS_USD) porFaixa[f] = 0;

    const contagem = new Map<string, number>();
    let semCotacao = 0;
    let maior: Decimal | null = null;

    for (const l of liquidacoes) {
        contagem.set(l.liquidante, (contagem.get(l.liquidante) ?? 0) + 1);
        const usd = valorEmDolares(l, tokens);
        if (usd === null) {
            semCotacao += 1;
            continue;
        }
        if (maior === null || usd.greaterThan(maior)) maior = usd;
        for (const f of FAIXAS_USD) {
            if (usd.greaterThanOrEqualTo(f)) porFaixa[f] += 1;
        }
    }

    const maiores = [...contagem.entries()]
        .map(([endereco, quantas]) => ({ endereco, quantas }))
        .sort((a, b) => b.quantas - a.quantas)
        .slice(0, 5);

    return {
        total: liquidacoes.length,
        semCotacao,
        porFaixa,
        liquidantesDistintos: contagem.size,
        maioresLiquidantes: maiores,
        maior,
    };
}

/**
 * Parte um intervalo de blocos em pedaços.
 *
 * Existe porque `eth_getLogs` tem teto de intervalo em todo provedor, e o teto
 * varia. Pedir seis meses de uma vez leva erro em qualquer um deles; pedir de
 * mil em mil leva uma eternidade num RPC público. O tamanho é parâmetro para
 * a primeira rodada poder responder qual cabe.
 */
export function faixasDeBlocos(de: number, ate: number, tamanho: number): Array<[number, number]> {
    if (tamanho < 1) throw new Error('tamanho de faixa precisa ser >= 1');
    if (ate < de) return [];
    const faixas: Array<[number, number]> = [];
    for (let inicio = de; inicio <= ate; inicio += tamanho) {
        faixas.push([inicio, Math.min(inicio + tamanho - 1, ate)]);
    }
    return faixas;
}

/**
 * Conta quantos eventos de cada tipo apareceram — o MODO DESCOBERTA.
 *
 * Sem poder calcular keccak nem alcançar a rede, a assinatura do evento é um
 * palpite. Esta função troca o palpite por medição: roda sem filtro de tópico e
 * mostra o que o contrato realmente emite, ordenado por frequência. O tópico
 * certo é reconhecível pela contagem e confere contra a constante lá em cima.
 */
export function contarPorTopico(logs: LogCru[]): Array<{ topico: string; quantos: number }> {
    const c = new Map<string, number>();
    for (const l of logs) {
        if (l.topics.length === 0) continue;
        const t = l.topics[0].toLowerCase();
        c.set(t, (c.get(t) ?? 0) + 1);
    }
    return [...c.entries()]
        .map(([topico, quantos]) => ({ topico, quantos }))
        .sort((a, b) => b.quantos - a.quantos);
}

/**
 * O erro é do tipo "sua faixa de blocos é grande demais"?
 *
 * Cada provedor recusa com uma frase diferente, e o número muda por plano: a
 * Alchemy no plano grátis responde "up to a 10 block range", outros falam em
 * "query returned more than N results" ou "range is too large". Tentar
 * adivinhar o teto certo de cada um pela documentação é trabalho que envelhece;
 * reconhecer a recusa e partir a faixa ao meio resolve para todos, inclusive
 * os que ainda não existem.
 *
 * Visto em 18/09: os 101 pedaços de 2.000 blocos falharam, e o relatório final
 * anunciou "o endereço do contrato provavelmente está errado" — o endereço
 * estava certo, nenhuma leitura tinha acontecido.
 */
export function ehLimiteDeFaixa(mensagem: string): boolean {
    const m = mensagem.toLowerCase();
    return (
        m.includes('block range') ||
        m.includes('range is too large') ||
        m.includes('returned more than') ||
        m.includes('query timeout') ||
        m.includes('too many results') ||
        m.includes('limit exceeded')
    );
}
