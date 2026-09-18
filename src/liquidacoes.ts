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
    /**
     * Segue o preço do ETH? (WETH e cbETH seguem; cbETH com um ágio pequeno
     * que ignoramos de propósito.)
     *
     * Marcar não basta para virar dólar: é preciso ALGUÉM informar o preço do
     * ETH. Sem ele a liquidação continua caindo em "sem cotação", que é a
     * resposta honesta. Com ele, vira um número aproximado e ROTULADO como
     * aproximado — porque o preço de hoje aplicado a uma liquidação de cinco
     * meses atrás está errado, e o relatório tem obrigação de dizer isso.
     */
    emEth?: boolean;
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
    '0x4200000000000000000000000000000000000006': { simbolo: 'WETH', decimais: 18, estavel: false, emEth: true },
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { simbolo: 'cbETH', decimais: 18, estavel: false, emEth: true },
};

/**
 * Valor da dívida em dólares — ou null quando não dá para saber.
 *
 * Null é uma resposta legítima e importante: significa "dívida em token que eu
 * não sei cotar". Some do histograma de dólares e aparece contado à parte, em
 * vez de entrar com um valor inventado.
 */
export function valorEmDolares(
    l: Liquidacao,
    tokens: Record<string, Token> = TOKENS_BASE,
    precoEth?: Decimal | null,
): Decimal | null {
    const t = tokens[l.ativoDaDivida.toLowerCase()];
    if (!t) return null;
    const cru = fromRawUnits(l.dividaCrua, t.decimais);
    if (t.estavel) return cru;
    if (t.emEth && precoEth && precoEth.greaterThan(0)) return cru.mul(precoEth);
    return null;
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
    /**
     * A SOMA de tudo que deu para cotar, em dólares — o buraco que a contagem
     * escondia.
     *
     * `porFaixa` responde "quantas são grandes?". Não responde "onde está o
     * dinheiro?", e as duas perguntas têm respostas diferentes: 3.082 migalhas
     * de US$200 são 88% das liquidações e podem ser 4% do bolo. Quem olha só a
     * contagem conclui que o negócio é volume; quem soma descobre que o
     * negócio são treze eventos por semestre.
     */
    somaCotada: Decimal;
    /** A soma em dólares de cada faixa, para cima. Chave = piso da faixa. */
    somaAcimaDe: Record<number, Decimal>;
    /**
     * O tamanho do meio. A MÉDIA aqui mentiria: uma de US$255 mil no meio de
     * milhares de US$200 puxa a média para um valor que nenhuma liquidação
     * real tem. A mediana diz como é a liquidação TÍPICA — que é a que se
     * pegaria num dia comum.
     */
    medianaCotada: Decimal | null;
    /**
     * As MAIORES liquidações, uma por uma, com quem ficou com cada bônus.
     *
     * O ranking por CONTAGEM esconde a única coisa que decide se há espaço
     * para quem chega agora. Em 180 dias na Base, um endereço capturou 3.166
     * de 5.043 — 63% —, e desse número não se conclui nada: ele pode estar
     * catando milhares de migalhas de US$200 e nem disputar as sete acima de
     * US$100 mil, ou pode estar levando as sete também.
     *
     * São situações opostas. Uma diz "tem espaço nas grandes"; a outra diz
     * "o lugar está tomado". Contar quantas cada um pegou não separa as duas;
     * olhar QUEM pegou as maiores separa.
     */
    maioresLiquidacoes: Array<{
        usd: Decimal;
        liquidante: string;
        bloco: number;
        transacao: string;
        /** O bônus é configurado na GARANTIA, então ela precisa viajar junto. */
        garantia: string;
    }>;
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
    precoEth?: Decimal | null,
): ResumoDoHistorico {
    const porFaixa: Record<number, number> = {};
    const somaAcimaDe: Record<number, Decimal> = {};
    for (const f of FAIXAS_USD) {
        porFaixa[f] = 0;
        somaAcimaDe[f] = new Decimal(0);
    }
    let somaCotada = new Decimal(0);

    const contagem = new Map<string, number>();
    const comValor: Array<{ l: Liquidacao; usd: Decimal }> = [];
    let semCotacao = 0;
    let maior: Decimal | null = null;

    for (const l of liquidacoes) {
        contagem.set(l.liquidante, (contagem.get(l.liquidante) ?? 0) + 1);
        const usd = valorEmDolares(l, tokens, precoEth);
        if (usd === null) {
            semCotacao += 1;
            continue;
        }
        comValor.push({ l, usd });
        if (maior === null || usd.greaterThan(maior)) maior = usd;
        somaCotada = somaCotada.plus(usd);
        for (const f of FAIXAS_USD) {
            if (usd.greaterThanOrEqualTo(f)) {
                porFaixa[f] += 1;
                somaAcimaDe[f] = somaAcimaDe[f].plus(usd);
            }
        }
    }

    const maiores = [...contagem.entries()]
        .map(([endereco, quantas]) => ({ endereco, quantas }))
        .sort((a, b) => b.quantas - a.quantas)
        .slice(0, 5);

    const maioresLiquidacoes = comValor
        .sort((a, b) => b.usd.comparedTo(a.usd))
        .slice(0, 10)
        .map((x) => ({
            usd: x.usd,
            liquidante: x.l.liquidante,
            bloco: x.l.bloco,
            transacao: x.l.transacao,
            garantia: x.l.ativoDaGarantia,
        }));

    // `comValor` ficou ordenado do MAIOR para o menor pelo sort acima, e o
    // meio de uma lista ordenada é o meio em qualquer direção.
    const medianaCotada = comValor.length > 0 ? comValor[Math.floor(comValor.length / 2)].usd : null;

    return {
        total: liquidacoes.length,
        semCotacao,
        porFaixa,
        liquidantesDistintos: contagem.size,
        maioresLiquidantes: maiores,
        maior,
        somaCotada,
        somaAcimaDe,
        medianaCotada,
        maioresLiquidacoes,
    };
}

/**
 * Onde está o dinheiro: nas migalhas ou nas poucas grandes?
 *
 * A pergunta veio dela, e ela estava certa em fazê-la: "a gente não pode ser o
 * louco que pega todas?". O relatório até aqui não tinha como responder, porque
 * só sabia CONTAR. Contando, as migalhas são 88% e a resposta parece óbvia.
 * Somando, pode ser o contrário.
 *
 * As duas respostas pedem bots opostos. Se o bolo está nas migalhas, o negócio
 * é volume: estar sempre ligada, gastar pouco de gás, pegar o que aparecer. Se
 * o bolo está em treze eventos por semestre, volume é só o plantão que te
 * mantém presente — e o dinheiro está em ganhar disputas raras.
 */
export function repartirOBolo(
    r: ResumoDoHistorico,
    pisoGrande = 50_000,
): { fracaoNasGrandes: Decimal | null; leitura: string } {
    if (r.somaCotada.lessThanOrEqualTo(0)) {
        return { fracaoNasGrandes: null, leitura: 'sem dado suficiente' };
    }
    const nasGrandes = r.somaAcimaDe[pisoGrande] ?? new Decimal(0);
    const fracao = nasGrandes.dividedBy(r.somaCotada);
    const pct = fracao.mul(100).toFixed(0);
    const quantas = r.porFaixa[pisoGrande] ?? 0;
    const resto = r.total - r.semCotacao - quantas;

    if (fracao.greaterThanOrEqualTo(0.5)) {
        return {
            fracaoNasGrandes: fracao,
            leitura: `${pct}% do dinheiro está em ${quantas} liquidações, e os outros ${100 - Number(pct)}% espalhados em ${resto}. Pegar todas é PLANTÃO, não é o negócio: o negócio são essas ${quantas}.`,
        };
    }
    if (fracao.lessThanOrEqualTo(0.2)) {
        return {
            fracaoNasGrandes: fracao,
            leitura: `só ${pct}% do dinheiro está nas ${quantas} grandes — o resto está espalhado em ${resto} liquidações. Aqui volume É o negócio, e ser "o louco que pega todas" é a estratégia certa.`,
        };
    }
    return {
        fracaoNasGrandes: fracao,
        leitura: `${pct}% do dinheiro nas ${quantas} grandes e o resto em ${resto}. Os dois negócios valem parecido — dá para começar pelo volume e subir.`,
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

export interface Rede {
    nome: string;
    rpc: string;
    /** Endereço do Pool da Aave V3 nessa rede. */
    pool: string;
    segPorBloco: number;
    /** Blocos que cobrem ~180 dias, já calculado. */
    blocos180d: number;
}

/**
 * Redes prontas, para a varredura não depender de acertar três variáveis.
 *
 * A Aave V3 usa o MESMO endereço de Pool em várias redes porque foi implantada
 * de forma determinística; Ethereum e Base fogem disso e têm os seus.
 *
 * Todos os endereços aqui são melhor-esforço de quem não conseguia alcançar a
 * rede para conferir. Isso não é problema: endereço errado aparece como "zero
 * eventos com zero falhas", e o modo descoberta mostra o que o contrato emite
 * de verdade. O palpite do tópico da Base foi confirmado exatamente assim.
 */
export const REDES: Record<string, Rede> = {
    base: {
        nome: 'Base',
        rpc: 'https://mainnet.base.org',
        pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
        segPorBloco: 2,
        blocos180d: 7_776_000,
    },
    ethereum: {
        nome: 'Ethereum',
        rpc: 'https://eth.drpc.org',
        pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        segPorBloco: 12,
        blocos180d: 1_296_000,
    },
    arbitrum: {
        nome: 'Arbitrum',
        rpc: 'https://arb1.arbitrum.io/rpc',
        pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        segPorBloco: 0.25,
        // 180 dias dariam 62 milhões de blocos e horas de leitura. Aqui a
        // janela é menor de propósito: ~30 dias, que já mostra o tamanho.
        blocos180d: 10_368_000,
    },
    optimism: {
        nome: 'Optimism',
        rpc: 'https://mainnet.optimism.io',
        pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        segPorBloco: 2,
        blocos180d: 7_776_000,
    },
    polygon: {
        nome: 'Polygon',
        rpc: 'https://polygon-rpc.com',
        pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        segPorBloco: 2,
        blocos180d: 7_776_000,
    },
    avalanche: {
        nome: 'Avalanche',
        rpc: 'https://api.avax.network/ext/bc/C/rpc',
        pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        segPorBloco: 2,
        blocos180d: 7_776_000,
    },
};

/**
 * Quanto o vencedor pagou ACIMA do obrigatório, em múltiplos da taxa base.
 *
 * É esta razão que separa as duas formas de disputa, e elas pedem estratégias
 * opostas:
 *
 *   ~1x   → CORRIDA. Todo mundo paga o mínimo e quem chega primeiro leva.
 *           Quem não tem servidor colado no sequenciador não entra.
 *   >>1x  → LEILÃO. Está sendo pago um prêmio para passar na frente, e
 *           quem aceita lucro menor pode dar lance maior e ganhar.
 *
 * Deliberadamente em múltiplos da base, e não em dólares: a razão responde a
 * pergunta sem precisar da cotação do ETH, que eu não tenho e não vou
 * inventar.
 */
export function multiploDaBase(params: {
    /** Preço efetivo pago por gás, em wei. */
    efetivoWei: Decimal;
    /** Taxa base do bloco, em wei. */
    baseWei: Decimal;
}): Decimal | null {
    if (params.baseWei.lessThanOrEqualTo(0)) return null;
    return params.efetivoWei.dividedBy(params.baseWei);
}

/** O que foi de fato entregue ao validador como gorjeta, em wei. */
export function gorjetaWei(params: {
    efetivoWei: Decimal;
    baseWei: Decimal;
    gasUsado: Decimal;
}): Decimal {
    const prioridade = Decimal.max(params.efetivoWei.minus(params.baseWei), 0);
    return prioridade.mul(params.gasUsado);
}

/** A leitura em português do que a razão significa. */
export function lerDisputa(multiploMediano: Decimal | null): string {
    if (multiploMediano === null) return 'sem dado suficiente';
    if (multiploMediano.lessThan(1.5)) {
        return 'CORRIDA: os vencedores pagaram quase a taxa mínima. Quem leva é quem chega primeiro, e dar lance não adianta.';
    }
    if (multiploMediano.lessThan(5)) {
        return 'MISTO: pagaram acima do mínimo, mas pouco. Há alguma disputa por prioridade.';
    }
    return 'LEILÃO: pagaram MUITO acima do mínimo para passar na frente. Aqui quem aceita lucro menor consegue dar lance maior e ganhar.';
}

/**
 * A leitura pela CONTAGEM de quem pagou perto do mínimo — não pela mediana.
 *
 * A mediana foi um erro meu e a primeira medição real mostrou por quê. Os oito
 * maiores prêmios da Base pagaram, em múltiplos da taxa base:
 *
 *     1,3x · 1,9x · 1,9x · 2,2x · 4,2x · 16,8x · 69,6x · 2.651,3x
 *
 * A mediana disso é 4,2x e `lerDisputa` a chamou de "MISTO: há alguma disputa
 * por prioridade". Mas metade dos vencedores pagou MENOS DE 2,5x, ou seja,
 * ganhou um prêmio de seis dígitos pagando quase nada. Isso não é disputa: é
 * ausência de disputa. Um único maluco pagando 2.651x puxa a mediana para cima
 * e apaga o fato que decide tudo.
 *
 * O que separa corrida de leilão não é o quanto o VENCEDOR MEDIANO pagou. É
 * quantos vencedores conseguiram NÃO PAGAR. Num leilão de verdade isso não
 * acontece: se dava para levar $156.899 pagando 1,9x, alguém teria oferecido
 * 2x. Ninguém ofereceu — logo o lance não era o que decidia.
 */
export function lerDisputaPorPiso(multiplos: Decimal[], pisoAte = 2.5): string {
    if (multiplos.length < 4) return 'sem dado suficiente';
    const noPiso = multiplos.filter((m) => m.lessThanOrEqualTo(pisoAte)).length;
    const fracao = noPiso / multiplos.length;
    const quantos = `${noPiso} de ${multiplos.length} vencedores pagaram até ${pisoAte}x a taxa base`;
    if (fracao >= 0.5) {
        return `CORRIDA: ${quantos} — levaram prêmios grandes sem pagar por prioridade. Se dar lance adiantasse, alguém teria dado. Aceitar lucro menor NÃO ajuda aqui: não há leilão para ganhar, e sim chegada para vencer.`;
    }
    if (fracao <= 0.2) {
        return `LEILÃO: só ${quantos} — o resto pagou caro para passar na frente. Aqui quem aceita lucro menor pode pagar mais e ganhar.`;
    }
    return `MISTO: ${quantos}. Parte das disputas se decide no lance e parte na chegada.`;
}

/**
 * Onde no bloco o vencedor caiu — e o que a mediana escondeu aqui também.
 *
 * Esta é a TERCEIRA vez neste projeto que eu escolhi uma estatística do meio
 * para um dado que não tem meio, e vale escrever por quê: a mediana só
 * descreve bem uma pilha com um monte no centro. Liquidação grande não é
 * assim. Ela é disputada de dois jeitos opostos, e o resultado são dois
 * montes com um vazio entre eles. A mediana cai no vazio e descreve um
 * vencedor que não existe.
 *
 * As oito maiores da Base, em fração do bloco:
 *
 *     0,1% · 0,7% · 12,6% · 16,7% · 16,7% · 86,1% · 89,5% · 92,9%
 *
 * A mediana é 16,7% e a leitura antiga chamou de "INTERMEDIÁRIA: nem
 * privilégio de chegada, nem caminho comum". Mas não existe nenhum vencedor
 * intermediário ali. Existem cinco na frente e TRÊS NO FUNDO — inclusive a
 * maior de todas, US$255.485 na transação 6.494 de 6.990.
 *
 * E é o fundo que importa, porque é prova de existência. Ganhar um prêmio de
 * seis dígitos na transação 6.494 significa que 6.493 transações passaram
 * antes sem levar. Quem levou não chegou primeiro nem pagou para passar na
 * frente: simplesmente ninguém disputou. Uma vez seria sorte; três de oito é
 * espaço.
 *
 * Contar o fundo, então, e não medir o meio.
 */
export function lerPosicao(fracoes: Decimal[]): string {
    if (fracoes.length < 4) return 'sem dado suficiente';
    const fundo = fracoes.filter((f) => f.greaterThan(0.5)).length;
    const frente = fracoes.filter((f) => f.lessThan(0.15)).length;
    const n = fracoes.length;

    if (fundo === 0) {
        return `NINGUÉM GANHOU DO FUNDO (${frente} de ${n} vencedores na frente do bloco): toda vez que houve prêmio grande, quem levou estava na cabeça. Chegar tarde nunca deu certo — e chegar cedo é infraestrutura, não código.`;
    }
    return `TEM ESPAÇO: ${fundo} de ${n} vencedores levaram prêmios grandes estando na METADE DE TRÁS do bloco — passaram milhares de transações antes sem ninguém pegar. Não foi velocidade nem lance: foi ninguém ter disputado. É aqui que programar melhor ganha de chegar primeiro.`;
}

/**
 * A grande caiu sozinha ou no meio de um monte?
 *
 * As duas situações são boas para ela, mas por motivos opostos, e pedem bots
 * diferentes — por isso não dá para deixar as duas juntas num número só.
 *
 * SOZINHA significa que o evento passou despercebido: ninguém estava olhando
 * aquela posição. Ganha quem tiver a lista mais completa de posições vigiadas,
 * e isso é trabalho de código, feito com calma, antes do dia.
 *
 * NO MEIO DE UM MONTE significa pânico: abriu mais coisa do que os robôs
 * conseguiram processar e sobrou para quem estava por perto. Ganha quem
 * aguentar o tranco — e quem estiver ligado naquele minuto.
 *
 * Não custa chamada nenhuma de rede: os blocos já vieram na varredura.
 */
export function aglomeracao(
    todas: Liquidacao[],
    alvos: Array<{ usd: Decimal; bloco: number }>,
    janelaBlocos = 30,
): { sozinhas: number; emMonte: number; leitura: string; detalhe: string[] } {
    const blocos = todas.map((l) => l.bloco).sort((a, b) => a - b);
    let sozinhas = 0;
    let emMonte = 0;
    const detalhe: string[] = [];

    for (const alvo of alvos) {
        // -1 para não contar a própria.
        const vizinhas =
            blocos.filter((b) => Math.abs(b - alvo.bloco) <= janelaBlocos).length - 1;
        if (vizinhas >= 3) emMonte += 1;
        else sozinhas += 1;
        detalhe.push(`$${alvo.usd.toFixed(0)}: ${vizinhas} outras em ±${janelaBlocos} blocos`);
    }

    const n = alvos.length;
    const leitura =
        emMonte > sozinhas
            ? `PÂNICO: ${emMonte} de ${n} das grandes caíram no meio de um monte. Abre mais do que os robôs dão conta e sobra. O bot precisa estar LIGADO no minuto certo e aguentar várias de uma vez.`
            : `DESPERCEBIDAS: ${sozinhas} de ${n} das grandes caíram sozinhas, sem outras por perto. Ninguém estava olhando aquela posição. Ganha quem tiver a lista de posições mais completa — e isso se faz com calma, antes.`;

    return { sozinhas, emMonte, leitura, detalhe };
}

// ---------------------------------------------------------------------------
// O BÔNUS — o número que eu vinha chutando e que decide quanto uma vitória paga.
// ---------------------------------------------------------------------------

/**
 * `getConfiguration(address)` no contrato da Aave. Conferido com ethers:
 * os quatro primeiros bytes de keccak("getConfiguration(address)").
 */
export const SELETOR_GET_CONFIGURATION = '0xc44b11f7';

/** A chamada pronta para `eth_call`: seletor + o ativo em palavra de 32 bytes. */
export function chamadaDeConfiguracao(ativo: string): string {
    return SELETOR_GET_CONFIGURATION + ativo.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/**
 * O bônus de liquidação daquele ativo, como fração — 0.05 para 5%.
 *
 * Eu vinha escrevendo "uns 5% a 10%, depende da moeda" e isso era chute. A
 * diferença entre 5% e 10% dobra o que ela ganha, então o chute não era um
 * detalhe: era metade da resposta.
 *
 * A Aave guarda a configuração de cada ativo empacotada num único número de
 * 256 bits, cada pedaço num intervalo de bits. O bônus está nos bits 32 a 47 e
 * vem em centésimos de por cento, com 100% embutido: 10500 quer dizer que o
 * liquidante recebe 105% do valor da dívida em garantia. O lucro é o que passa
 * de 100% — 5%.
 *
 * Importante: o bônus é configurado na GARANTIA, não na dívida. Quem decide
 * quanto se ganha é a moeda que se leva, não a que se paga.
 */
export function bonusDeLiquidacao(dataHex: string): Decimal | null {
    const limpo = dataHex.replace(/^0x/, '');
    if (limpo.length < 64) return null;
    const bruto = (BigInt(`0x${limpo.slice(0, 64)}`) >> 32n) & 0xffffn;
    // Zero = ativo sem configuração de garantia. Não existe bônus de 0%: o que
    // existe é ativo que não serve de garantia, e aí a resposta é "não sei".
    if (bruto === 0n) return null;
    return new Decimal(bruto.toString()).dividedBy(10_000).minus(1);
}

/**
 * O que sobra para ela, antes do gás.
 *
 * Não é a dívida. A dívida é de quem quebrou; ela só a paga e leva a garantia
 * com o ágio. Confundir as duas infla o resultado por vinte vezes — e foi
 * exatamente o erro de ordem de grandeza que eu já cometi uma vez hoje.
 */
export function lucroBruto(dividaUsd: Decimal, bonus: Decimal): Decimal {
    return dividaUsd.mul(bonus);
}
