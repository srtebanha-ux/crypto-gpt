/**
 * COTACAO DE BAIXA LATENCIA para a rota mista V3 + Aerodrome — sem fork.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Ela cortou a conclusao anterior por nome:
 * *"36/36 EXPIRADAS NO FORK HISTORICO NAO PROVAM QUE 36 OPORTUNIDADES
 * EXPIRARAM NO MERCADO. Voce mede tempo de `hardhat_reset`, implantacao
 * efemera, leitura e cotacao. O bloco historico ja estava fechado antes de seu
 * experimento comecar. Isso demonstra custo do laboratorio, nao a latencia do
 * cacador em condicoes reais."* Esta certa, e a conclusao esta RETIRADA.
 *
 * Aqui nao ha fork, nao ha implantacao e nao ha `hardhat_reset`: duas
 * requisicoes de `eth_call` contra o no, no estado de AGORA.
 *
 * O QUE FOI VALIDADO ANTES DE ESCREVER UMA LINHA DISTO (2026-10-15,
 * `mainnet.base.org`):
 *
 *   QuoterV2 0x3d4e44Eb…B76a   8.273 bytes
 *   quoter.factory()           0x33128a8fc17869897dce68ed026d694621f6fdfd
 *   pool.factory() (WETH/USDC) 0x33128a8fc17869897dce68ed026d694621f6fdfd
 *   >>> IGUAIS: a compatibilidade e CONFERIDA, nunca suposta
 *   quote 0,01 WETH -> USDC    24.534699 em `latest`, 24.534776 em `pending`
 *   custo da cotacao           82,9ms (latest), 87,5ms (pending)
 *
 * E o pool veio da FABRICA (`getPool(WETH, USDC, 500)`), nao da minha memoria.
 *
 * A COMPATIBILIDADE E POR POOL. Um pool de outra fabrica NAO e cotado por este
 * quoter: `quoterServeOPool` devolve `false` e a rota fica NAO VALIDADA. Ela
 * proibiu o contrario por escrito — *"Nao invente compatibilidade."*
 */

import { keccak256, toUtf8Bytes } from 'ethers';

const sel = (assinatura: string): string => keccak256(toUtf8Bytes(assinatura)).slice(0, 10);

/** O QuoterV2 oficial da Uniswap V3 na Base, dado por ela. */
export const QUOTER_V2 = '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a';

export const SELETORES_DA_COTACAO = {
    factory: sel('factory()'),
    fee: sel('fee()'),
    quoteExactInputSingle: sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))'),
    getAmountOut: sel('getAmountOut(uint256,address)'),
    balanceOf: sel('balanceOf(address)'),
};

const palavra = (v: bigint): string => v.toString(16).padStart(64, '0');
const palavraEnd = (e: string): string => e.toLowerCase().replace('0x', '').padStart(64, '0');

/**
 * O quoter serve ESTE pool?
 *
 * A pergunta nao e "o quoter existe" nem "o pool responde": e se os dois
 * apontam para a MESMA fabrica. Um quoter de outra fabrica responderia numero
 * de um pool que nao e o nosso, e seria numero errado com cara de cotacao.
 *
 * `null` em qualquer um dos dois devolve `false`: sem as duas fabricas lidas
 * nao existe prova de compatibilidade, e ausencia nao autoriza cotar.
 */
export function quoterServeOPool(
    fabricaDoQuoter: string | null, fabricaDoPool: string | null,
): boolean {
    if (fabricaDoQuoter === null || fabricaDoPool === null) return false;
    return fabricaDoQuoter.toLowerCase() === fabricaDoPool.toLowerCase();
}

/** `quoteExactInputSingle` codificado. O `fee` vem do PROPRIO pool. */
export function codificarQuoteV3(e: {
    tokenEntra: string; tokenSai: string; quantia: bigint; taxa: number;
}): string {
    // Tupla estatica de 5 palavras: nao ha offset dinamico aqui, e foi
    // justamente um offset mal lido que fez este projeto publicar 10 medicoes
    // erradas de limiar da Aave.
    return SELETORES_DA_COTACAO.quoteExactInputSingle
        + palavraEnd(e.tokenEntra)
        + palavraEnd(e.tokenSai)
        + palavra(e.quantia)
        + palavra(BigInt(e.taxa))
        + palavra(0n); // sqrtPriceLimitX96 = 0: sem limite de preco
}

/** `getAmountOut(quantia, tokenEntra)` do pool Aerodrome — a conta DELE. */
export function codificarGetAmountOut(quantia: bigint, tokenEntra: string): string {
    return SELETORES_DA_COTACAO.getAmountOut + palavra(quantia) + palavraEnd(tokenEntra);
}

/**
 * A primeira palavra de uma resposta, ou `null`.
 *
 * `null` e NAO zero, de proposito: zero e uma cotacao valida de "nao sai nada",
 * e confundir as duas e a assinatura do defeito que este projeto persegue.
 */
export function primeiraPalavra(dados: string | null): bigint | null {
    if (dados === null || !dados.startsWith('0x') || dados.length < 66) return null;
    try { return BigInt(dados.slice(0, 66)); } catch { return null; }
}

/**
 * A ESCADA DE TAMANHOS, do mais promissor para o menos.
 *
 * Em AMM a razao `saida/entrada` e MAXIMA no tamanho infinitesimal e so cai.
 * Entao o tamanho MENOR e o que tem a melhor chance de sobra BRUTA, e se ele
 * nao tem sobra nenhum maior tem — e esse e o corte que evita cotar a escada
 * inteira. O lucro LIQUIDO e outra coisa: ele precisa de tamanho para cobrir o
 * gas, e por isso a escada sobe quando o pequeno mostra sobra.
 */
export function escadaDeTamanhos(liquidezDaBase: bigint): bigint[] {
    if (liquidezDaBase <= 0n) return [];
    return [10_000n, 2_000n, 500n, 100n, 20n]
        .map((d) => liquidezDaBase / d)
        .filter((q) => q > 0n);
}

/** Um sinal, com tudo o que ela pediu registrado por sinal. */
export interface SinalDeArbitragem {
    rota: string;
    protocolo: string;
    /** O bloco do estado lido, e a etiqueta (`latest` ou `pending`). */
    bloco: number;
    etiqueta: 'latest' | 'pending';
    /** `Date.now()` do instante em que o estado foi observado. */
    observadoEm: number;
    /** Do estado observado ate a decisao, em ms. */
    msAteADecisao: number;
    /** Idade do estado usado na decisao, em ms. */
    idadeDoEstadoMs: number;
    melhorTamanho: bigint | null;
    lucroBrutoEstimado: bigint | null;
    custoTotalEstimado: bigint | null;
    lucroLiquidoEstimado: bigint | null;
    /** `null` quando nao houve simulacao — e isso nunca vira "falhou". */
    simulacao: 'completa' | 'revertida' | null;
    /** Por que foi recusado, ou por que expirou. Nunca vazio. */
    motivo: string;
}

export interface Percentis { p50: number | null; p95: number | null; p99: number | null }

/**
 * Percentis por interpolacao nenhuma: o elemento no indice, que e o que uma
 * amostra pequena permite afirmar.
 */
export function percentis(amostras: number[]): Percentis {
    if (amostras.length === 0) return { p50: null, p95: null, p99: null };
    const o = amostras.slice().sort((a, b) => a - b);
    const em = (p: number): number => o[Math.min(o.length - 1, Math.floor(p * o.length))]!;
    return { p50: em(0.5), p95: em(0.95), p99: em(0.99) };
}

/**
 * O LIVRO DOS SINAIS — e as DUAS velocidades, separadas por ordem dela.
 *
 * *"LATENCIA REAL DE OBSERVACAO: do recebimento de uma atualizacao de estado
 * ate a conclusao da decisao. LATENCIA DO FORK: tempo necessario para validar
 * uma hipotese em laboratorio. Nao misture as duas."*
 *
 * Aqui so entra a primeira. A do fork vive em `forkTests/`, e nenhuma soma com
 * a outra — foi misturar as duas que produziu a conclusao que ela retirou.
 */
export class LivroDeSinais {
    private readonly sinais: SinalDeArbitragem[] = [];

    private readonly observacao: number[] = [];

    private readonly cotacoes: number[] = [];

    private readonly idades: number[] = [];

    registrar(s: SinalDeArbitragem): void {
        this.sinais.push(s);
        this.observacao.push(s.msAteADecisao);
        this.idades.push(s.idadeDoEstadoMs);
    }

    registrarCotacao(ms: number): void { this.cotacoes.push(ms); }

    get todos(): readonly SinalDeArbitragem[] { return this.sinais; }

    get quantasCotacoes(): number { return this.cotacoes.length; }

    get latenciaDeObservacao(): Percentis { return percentis(this.observacao); }

    get latenciaDaCotacao(): Percentis { return percentis(this.cotacoes); }

    get idadeDoEstado(): Percentis { return percentis(this.idades); }

    /** Positivos BRUTOS, positivos LIQUIDOS e EXPIRADOS, nunca somados. */
    contar(): { brutosPositivos: number; liquidosPositivos: number; expirados: number } {
        return {
            brutosPositivos: this.sinais.filter(
                (s) => s.lucroBrutoEstimado !== null && s.lucroBrutoEstimado > 0n,
            ).length,
            liquidosPositivos: this.sinais.filter(
                (s) => s.lucroLiquidoEstimado !== null && s.lucroLiquidoEstimado > 0n,
            ).length,
            expirados: this.sinais.filter((s) => s.motivo.startsWith('EXPIRADO')).length,
        };
    }

    comoLer(): string {
        const c = this.contar();
        const o = this.latenciaDeObservacao;
        const q = this.latenciaDaCotacao;
        const i = this.idadeDoEstado;
        const n = (x: number | null): string => (x === null ? 'sem amostra' : `${x.toFixed(1)}ms`);
        if (this.sinais.length === 0) {
            return 'LIVRO DE SINAIS VAZIO — nenhum sinal avaliado. Isto NÃO é "não há spread": '
                + 'é ausência de sinal avaliado, e as duas pedem conclusões diferentes';
        }
        return `LIVRO DE SINAIS — ${this.sinais.length} sinal(is) | `
            + `${c.brutosPositivos} com lucro BRUTO positivo, `
            + `${c.liquidosPositivos} com lucro LÍQUIDO positivo, ${c.expirados} EXPIRADO(S) | `
            + `LATÊNCIA DE OBSERVAÇÃO (estado→decisão) p50 ${n(o.p50)} p95 ${n(o.p95)} `
            + `p99 ${n(o.p99)} | COTAÇÃO p50 ${n(q.p50)} p95 ${n(q.p95)} p99 ${n(q.p99)} `
            + `em ${this.cotacoes.length} cotação(ões) | IDADE DO ESTADO NA DECISÃO `
            + `p50 ${n(i.p50)} p95 ${n(i.p95)} p99 ${n(i.p99)} | `
            + 'nenhum destes números é latência de FORK, e nenhum prova INCLUSÃO: cotar antes de '
            + 'dois segundos não é capturar, e competição é prova separada';
    }
}

/**
 * MUDOU O ESTADO DESTE POOL?
 *
 * A comparacao e da resposta CRUA inteira. Comparar prefixo foi defeito medido
 * neste projeto: 48 caracteres de `slot0` sao quase todos zero, e "o pool nao
 * mudou" era propriedade do meu instrumento, nao do pool.
 */
/**
 * A IMPRESSAO de um estado — o que diz se houve mudanca DENTRO do mesmo bloco.
 *
 * Ela cortou o gatilho anterior por nome: *"Nao dependa exclusivamente de
 * `eth_blockNumber` para decidir quando avaliar `pending`. Demonstre que o
 * sistema reconhece estados pre-confirmados diferentes mesmo quando o numero do
 * ultimo bloco confirmado e o mesmo."*
 *
 * Esta certa, e era defeito: o caçador avaliava UMA vez por bloco confirmado
 * (`blocoAgora !== blocoDaTriagem`), entao toda mudanca intrabloco — e a Base
 * monta o bloco em fatias de ~200ms — era invisivel por construcao.
 *
 * O provedor publico NAO expoe versao de estado: `eth_getBlockByNumber('pending')`
 * devolve hash zerado (medido). Entao a identificacao e por FINGERPRINT dos
 * proprios pools, e a limitacao fica declarada: duas mudancas que se cancelem
 * exatamente leem como uma; e uma mudanca em pool que nao vigiamos nao aparece.
 */
export function impressaoDoEstado(cru: Map<string, string | null>): string {
    // Ordenado para a impressao nao depender da ordem de iteracao.
    return [...cru.entries()]
        .map(([k, v]) => `${k}=${v ?? '?'}`)
        .sort()
        .join('|');
}

export class EstadoDosPools {
    private readonly ultimo = new Map<string, string>();

    /** Devolve os pools cuja resposta mudou, e guarda a nova. */
    mudaram(lido: Map<string, string | null>): string[] {
        const fora: string[] = [];
        for (const [pool, dados] of lido) {
            if (dados === null) continue; // leitura que nao veio nao e mudanca
            if (this.ultimo.get(pool) !== dados) {
                // Primeira leitura TAMBEM conta como mudanca: e a primeira vez
                // que existe estado para avaliar.
                fora.push(pool);
                this.ultimo.set(pool, dados);
            }
        }
        return fora;
    }

    get quantosConhecidos(): number { return this.ultimo.size; }

    /** A impressao do que esta guardado, para comparar estados inteiros. */
    impressao(): string { return impressaoDoEstado(this.ultimo as Map<string, string | null>); }
}

/**
 * O ESTADO MUDOU ENTRE A LEITURA E A COTACAO?
 *
 * *"Nao combine indiscriminadamente reservas, precos e cotacoes de snapshots
 * diferentes. Se o estado mudar durante a avaliacao, revalide a oportunidade ou
 * marque ESTADO_INCONSISTENTE."*
 *
 * Compara SO os pools da rota avaliada: um pool alheio ter mudado nao torna
 * esta cotacao inconsistente, e tratar como se tornasse jogaria fora cotacao
 * boa.
 */
export function estadoInconsistente(
    antes: Map<string, string | null>, depois: Map<string, string | null>, poolsDaRota: string[],
): boolean {
    for (const p of poolsDaRota) {
        const k = p.toLowerCase();
        if (!depois.has(k)) continue; // nao reli: nao afirmo mudanca
        if (antes.get(k) !== depois.get(k)) return true;
    }
    return false;
}

/**
 * O COTADOR LOCAL por OVERRIDE DE ESTADO — o ciclo inteiro numa chamada, sem
 * implantar nada e sem gastar ETH.
 *
 * POR QUE ELE EXISTE, e nao e capricho: medido ao vivo em 2026-10-15, dos
 * pools V3 que de fato pareiam com um pool Aerodrome no WETH, QUATRO DE QUATRO
 * sao de uma fabrica que o QuoterV2 oficial NAO serve — `poolsQueEleServe: 0`.
 * Cotar aqueles pools com o quoter oficial seria responder sobre outro pool.
 * Ela deu a saida por escrito: *"Para pools V3 de outras fábricas, identifique
 * um quoter realmente compatível ou utilize uma alternativa local comprovada...
 * Não faça deploy real apenas para descobrir preços."*
 *
 * COMO: `eth_call` aceita um terceiro parametro que SUBSTITUI o codigo de um
 * endereco. Conferido no `mainnet.base.org` com um contrato de 10 bytes que
 * devolve 42 — aceito. Entao o codigo JA COMPILADO do `CacadorV3` (6.775
 * bytes, do artefato local) e injetado num endereco de rascunho e `cotar`
 * responde pelo padrao Quoter: executa o ciclo e REVERTE com o numero.
 *
 * VALIDADO CONTRA O QUOTER OFICIAL, e nao suposto. Duas pernas V3 da mesma
 * fabrica (WETH/USDC 500 e 3000), 0,01 WETH, no mesmo estado:
 *
 *   QuoterV2 composto (2 chamadas)  0,01 WETH -> 24.489.870 -> 9.939.992.138.238.505
 *   override `cotar` (1 chamada)    PagamentoCurto(9.939.992.138.238.505, 10^16)
 *   >>> IGUAIS AO WEI, e 76,3ms contra 106,3ms
 *
 * O `dono` do contrato fica ZERO no override (nao ha storage), entao a chamada
 * sai de `from: 0x0` e passa o portao `soDono`. Por isso ela NAO vai por
 * Multicall3: ali o `msg.sender` seria o Multicall3 e o portao recusaria. O
 * paralelismo vem do LOTE JSON-RPC, que este no aceita (conferido: 3 respostas
 * numa requisicao).
 */
export const COTADOR_LOCAL = '0x00000000000000000000000000000000c0ad0012';

/** O que o `cotar` devolveu, lido do DADO da reversao — nunca da prosa. */
export interface RespostaDaCotacao {
    /** Quanto o ciclo produziu, na moeda da base. */
    produziu: bigint;
    /** Quanto era devido para fechar o ciclo. */
    devido: bigint;
    /** `produziu - devido`. Negativo e resposta: o ciclo nao fecha. */
    sobra: bigint;
}

/**
 * Os seletores das duas reversoes, CALCULADOS da assinatura.
 *
 * Eu havia escrito `0x8f4eb604` e `0xd0d0b1a6` de cabeca. Os verdadeiros sao
 * `0x9612b7e0` e `0xba64f239` — os dois estavam errados, e nenhum dos dois
 * teria casado com reversao nenhuma: a cotacao devolveria `null` para sempre e
 * o log diria "sem dado" sobre um numero que estava na resposta. Seletor de
 * cabeca e o defeito do `0x80d1e0f4…` em quatro bytes, e a regra deste
 * projeto e nao escrever nenhum deles a mao.
 */
export const SELETOR_LUCRO_INSUFICIENTE = sel('LucroInsuficiente(uint256,uint256)');
export const SELETOR_PAGAMENTO_CURTO = sel('PagamentoCurto(uint256,uint256)');

/**
 * Le a reversao do `cotar`.
 *
 * As duas reversoes que trazem numero dizem coisas DIFERENTES:
 *
 *   PagamentoCurto(tem, devido)      o ciclo nao fechou: sobra = tem - devido
 *   LucroInsuficiente(obtido, piso)  o ciclo FECHOU e sobrou `obtido`
 *
 * Trata-las como a mesma coisa publicaria prejuizo como lucro. Qualquer outra
 * reversao devolve `null`: reversao opaca nao e cotacao, e foi exatamente
 * aceitar reversao opaca que custou a este projeto o capitulo do
 * `naoCruzouAinda`.
 */
export function lerRespostaDaCotacao(dados: string | null): RespostaDaCotacao | null {
    if (dados === null || !dados.startsWith('0x') || dados.length < 10 + 128) return null;
    const sl = dados.slice(0, 10).toLowerCase();
    let a: bigint;
    let b: bigint;
    try {
        a = BigInt(`0x${dados.slice(10, 74)}`);
        b = BigInt(`0x${dados.slice(74, 138)}`);
    } catch { return null; }
    if (sl === SELETOR_PAGAMENTO_CURTO.toLowerCase()) {
        return { produziu: a, devido: b, sobra: a - b };
    }
    if (sl === SELETOR_LUCRO_INSUFICIENTE.toLowerCase()) {
        // Aqui o ciclo FECHOU: `a` e o que sobrou depois de pagar.
        return { produziu: a, devido: 0n, sobra: a };
    }
    return null;
}

/**
 * `cotar(Perna[] rota, uint256 quantia)` codificado.
 *
 * O array de tuplas e DINAMICO: a primeira palavra e o offset do array, depois
 * vem o tamanho e depois as pernas, cada uma com quatro palavras. Offset mal
 * lido foi o defeito que fez este projeto publicar dez medicoes erradas de
 * limiar da Aave, entao a montagem esta escrita passo a passo.
 */
export function codificarCotarCiclo(
    rota: Array<{ pool: string; tokenEntra: string; tipo: number; pagamento: bigint }>,
    quantia: bigint,
): string {
    const cabeca = [
        palavra(64n), // offset do array: dois argumentos de cabeca x 32 bytes
        palavra(quantia),
        palavra(BigInt(rota.length)),
    ];
    const corpo = rota.map((p) => palavraEnd(p.pool)
        + palavraEnd(p.tokenEntra)
        + palavra(BigInt(p.tipo))
        + palavra(p.pagamento));
    return sel('cotar((address,address,uint8,uint256)[],uint256)') + cabeca.join('') + corpo.join('');
}

/**
 * O bytecode JA COMPILADO do `CacadorV3`, do artefato local.
 *
 * `null` quando o artefato nao existe — e `null` nao vira cotacao: sem o codigo
 * a rota fica sem cotar DIZENDO que falta o instrumento. Nada e implantado:
 * este codigo so existe dentro do override de um `eth_call`.
 */
export function lerCodigoDoCotador(caminho?: string): string | null {
    const alvo = caminho
        ?? process.env.ARB_ARTEFATO_COTADOR
        ?? '.tmp/artifacts/contracts/CacadorV3.sol/CacadorV3.json';
    try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        const fs = require('node:fs') as typeof import('node:fs');
        const cru = JSON.parse(fs.readFileSync(alvo, 'utf8')) as { deployedBytecode?: unknown };
        const b = cru.deployedBytecode;
        if (typeof b !== 'string' || !b.startsWith('0x') || b.length < 100) return null;
        return b;
    } catch { return null; }
}

/**
 * UMA COTACAO NEGATIVA NO MENOR TAMANHO DESCARTA OS MAIORES?
 *
 * SO quando as duas pernas tem a monotonicidade DEMONSTRADA. Ela cortou o atalho
 * por nome: *"Comprove quando uma cotacao negativa nesse tamanho permite
 * descartar tamanhos superiores. Nao aplique essa conclusao a pools stable,
 * tokens nao convencionais ou curvas sem prova da propriedade utilizada."*
 *
 * A DEMONSTRACAO, e ela vale para as duas pernas que sabemos nomear:
 *
 *   Aerodrome VOLATILE (`x·y = k`): `saida(x)/x = rSai·x'/(x·(rEntra+x'))` com
 *   `x' = x(1−taxa)`. O denominador cresce com x e o numerador e linear em x',
 *   entao a razao e NAO-CRESCENTE em x. Medido: 0,99700 em 1e12, 0,99601 em
 *   1e18, 0,90661 em 1e20.
 *
 *   V3: um swap anda o preco numa direcao so. O preco marginal de execucao
 *   piora monotonicamente com o tamanho — cruzar tick com mais liquidez reduz o
 *   quanto piora, nunca melhora o preco ja atravessado. Entao a razao media
 *   tambem e nao-crescente.
 *
 * Com as duas nao-crescentes, o produto e nao-crescente, e razao <= 1 no menor
 * tamanho implica <= 1 em todos os maiores. FORA DISSO — pool stable
 * (`x³y + y³x = k`, sem esta demonstracao aqui), token de comportamento nao
 * convencional (taxa na transferencia, rebase) ou venue que nao sabemos nomear
 * — a escada tem de ser cotada tamanho por tamanho.
 */
export function podeDescartarTamanhosMaiores(e: {
    /** `false` = volatile COMPROVADO. `true` ou `null` nao serve. */
    aeroEstavel: boolean | null;
    /** Alguma perna tem retencao medida (token nao convencional)? */
    tokenNaoConvencional: boolean;
    /** A rota TEM perna Aerodrome? Sem ela a justificativa e so do V3. */
    temAerodrome?: boolean;
}): { pode: boolean; porque: string } {
    if (e.tokenNaoConvencional) {
        return {
            pode: false,
            porque: 'alguma perna tem retenção medida (token não convencional): a saída não é '
                + 'função só da curva, então a monotonicidade não está demonstrada',
        };
    }
    if (e.aeroEstavel !== false) {
        return {
            pode: false,
            porque: e.aeroEstavel === null
                ? 'não li `stable()` do pool Aerodrome: sem saber a curva não há monotonicidade '
                    + 'demonstrada, e a escada tem de ser cotada tamanho por tamanho'
                : 'pool Aerodrome STABLE (`x³y + y³x = k`): a monotonicidade não está demonstrada '
                    + 'para esta curva aqui, então um tamanho não decide os outros',
        };
    }
    return {
        pode: true,
        // A JUSTIFICATIVA SEGUE A ROTA. Numa rota V3<->V3 nao ha perna
        // Aerodrome, e a frase anterior citava `x·y = k` do Aerodrome para uma
        // rota que nao tem nenhum: a conclusao estava certa e o motivo
        // impresso, falso.
        porque: e.temAerodrome === false
            ? 'as duas pernas são V3 e nelas a razão saída/entrada é NÃO-CRESCENTE: o preço '
                + 'marginal de execução só piora com o tamanho, então o produto é não-crescente '
                + 'e razão <= 1 no menor tamanho vale para todos os maiores'
            : 'as duas pernas têm razão saída/entrada NÃO-CRESCENTE demonstrada (Aerodrome '
                + 'volatile por `x·y = k`; V3 porque o preço marginal só piora com o tamanho), '
                + 'então o produto é não-crescente e razão <= 1 no menor tamanho vale para todos '
                + 'os maiores',
    };
}

/**
 * A IMPRESSAO DE CADA POOL — UMA funcao, usada ANTES e DEPOIS da cotacao.
 *
 * DEFEITO QUE ELA ACHOU no `9f08261`, e era fatal para a conclusao: havia DUAS
 * serializacoes escritas a mao, e elas discordavam por construcao —
 *
 *     antes da cotacao:   `v3:${sqrt}/L${liquidez}`
 *     depois da cotacao:  `v3:${sqrt}`
 *
 * Com isso TODO pool V3 comparava diferente mesmo parado, e
 * `ESTADO_INCONSISTENTE` saiu em 5.819 de 5.823 sinais. A conclusao de que a
 * latencia era o impedimento principal veio do meu comparador, nao do mercado,
 * e esta RETIRADA.
 *
 * E a licao e a REGRA 3 deste projeto: uma regra em dois lugares e a mesma
 * regra. Serializar em dois lugares era sincronizar na mao duas copias que
 * ninguem conferia uma contra a outra. Agora ha uma funcao, e os dois lados a
 * chamam — por isso nao da mais para divergirem.
 *
 * `null` quer dizer NAO LIDO, e nao e zero nem "mudou": quem decide o que fazer
 * com ausencia e `compararEstados`.
 */
export function impressaoDosPools(L: {
    sqrtPorPoolV3: Map<string, bigint | null>;
    liquidezDoV3?: Map<string, bigint | null>;
    reservasAerodrome: Map<string, { r0: bigint; r1: bigint } | null>;
}): Map<string, string | null> {
    const fora = new Map<string, string | null>();
    for (const [pool, sqrt] of L.sqrtPorPoolV3) {
        // PRECO **E** LIQUIDEZ: liquidez mudada no mesmo preco muda o resultado
        // de um swap, entao um snapshot so com preco nao detecta a mudanca.
        const liq = L.liquidezDoV3?.get(pool) ?? null;
        fora.set(
            pool.toLowerCase(),
            sqrt === null || liq === null ? null : `v3:${sqrt}/L${liq}`,
        );
    }
    for (const [pool, r] of L.reservasAerodrome) {
        fora.set(pool.toLowerCase(), r === null ? null : `ae:${r.r0}/${r.r1}`);
    }
    return fora;
}

/** O veredicto de consistencia, com TRES respostas e nenhuma inventada. */
export type VeredictoDoEstado = 'CONSISTENTE' | 'INCONSISTENTE' | 'NAO_VALIDADA';

/**
 * O estado dos pools DA ROTA e o mesmo antes e depois da cotacao?
 *
 * Tres respostas, porque sao tres situacoes com acoes diferentes:
 *
 *   CONSISTENTE    os dois lados leram, e os valores batem
 *   INCONSISTENTE  os dois lados leram, e algum valor mudou
 *   NAO_VALIDADA   algum lado NAO LEU aquele pool
 *
 * *"Dados ausentes devem receber classificacao propria. Nao podem ser
 * apresentados como mudanca confirmada nem como estado validado."* A versao
 * anterior tinha duas respostas e empurrava ausencia para "consistente", o que
 * e afirmar estado validado sem ter lido.
 *
 * Pool FORA da rota nao entra: um pool alheio ter mudado nao torna esta cotacao
 * inconsistente, e tratar como se tornasse jogaria fora cotacao boa.
 */
export function compararEstados(
    antes: Map<string, string | null>,
    depois: Map<string, string | null>,
    poolsDaRota: string[],
): VeredictoDoEstado {
    let mudou = false;
    for (const p of poolsDaRota) {
        const k = p.toLowerCase();
        const a = antes.get(k) ?? null;
        const b = depois.get(k) ?? null;
        if (a === null || b === null) return 'NAO_VALIDADA';
        if (a !== b) mudou = true;
    }
    return mudou ? 'INCONSISTENTE' : 'CONSISTENTE';
}
