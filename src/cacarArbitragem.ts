/**
 * ENTREGA 2 — O CACADOR DE ARBITRAGEM CONTINUO.
 *
 * Liga o motor que a ENTREGA 1 provou em fork ao monitoramento de blocos da
 * Base. Nao e um segundo monitoramento: reusa `OuvinteDeBlocos`
 * (`gatilhoDeBloco.ts`), `AvaliacaoEmCurso`/`LivroDeTempos` (`cronometro.ts`) e
 * a aritmetica de `ammMath.ts` — a MESMA que o contrato executa, espelhada em
 * BigInt e conferida contra o `MathHarness` implantado.
 *
 * O QUE A ENTREGA 1 DEIXOU PROVADO e este arquivo nao reabre:
 *
 *   - uma fabrica V2 tem UM pool por par: arbitragem de 2 pernas exige DUAS
 *     DEXs, e procurar dentro de uma so da "0 candidatos" por construcao
 *   - quatro fabricas na Base tem o callback `uniswapV2Call` deste contrato
 *   - o lucro sobra no token DEVOLVIDO (U), nao no emprestado (T)
 *   - o portao economico nao pode morar no contrato (ele nao conhece gas) nem
 *     no avaliador de ciclo em T (o lucro sobra em U)
 *
 * O QUE ESTE ARQUIVO NAO AFIRMA: lucro. Ele mede, decide e registra. Com
 * `ARB_ENVIAR` inexistente — e ele nem le essa variavel — nada e transmitido.
 * Nao existe caminho de envio aqui, e isso e de desenho: a ENTREGA 2 e
 * observacao continua, e um caminho de envio que ninguem pediu seria risco de
 * capital sem autorizacao.
 */
import Decimal from 'decimal.js';
import { AbiCoder, id } from 'ethers';
import { createLogger } from './logger';
import { sobraDoFlashSwap } from './ammMath';
import {
    OuvinteDeBlocos, wsDoHttp, enderecoDeBlocos, esperarBlocoOuTempo,
} from './gatilhoDeBloco';
import { cronometrar, LivroDeTempos, idDeAvaliacao } from './cronometro';
import {
    MULTICALL3, codificarAggregate3, decodificarAggregate3Rapido, partirEmPedacos,
    CHAMADAS_POR_MULTICALL, type ChamadaMulti,
} from './multicall';

const log = createLogger('arb');
const coder = AbiCoder.defaultAbiCoder();
const sel = (a: string): string => id(a).slice(0, 10);

/**
 * As fabricas com o callback `uniswapV2Call`, MEDIDAS na corrente em
 * 2026-10-14 pelo par WETH/USDC (ver `forkTests/aArbitragemDePontaAPonta.js`).
 *
 * FORA, declarado: PancakeSwap e BaseSwap devolvem pool com `swap` e
 * `getReserves` mas SEM `uniswapV2Call` — usam outro nome de callback, e este
 * contrato nao as atende. Aerodrome sao proxies de 45 bytes: o seletor nao
 * aparece no bytecode e descobrir o callback dela exige EXECUCAO. As duas
 * continuam no escopo do projeto, como PENDENTES, e nao entram aqui por
 * suposicao.
 */
export const FABRICAS_COM_FLASH_SWAP = [
    '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', // Uniswap V2
    '0x71524b4f93c58fcbf659783284e38825f0622859', // SushiSwap V2
    '0x04c9f118d21e8b767d2e50c946f0cc9f6c367300', // SwapBased
    '0x3e84d913803b02a4a7f027165e8ca42c14c0fde7', // Alien Base
] as const;

/** O WETH da Base. E o unico token em que eu sei converter gas sem preco. */
export const WETH_DA_BASE = '0x4200000000000000000000000000000000000006';

/**
 * Gas de uma arbitragem de duas pernas.
 *
 * MEDIDO, nao escolhido: os recibos da ENTREGA 1 em fork deram 202.617 e
 * 202.629. O teto aqui e folgado para cima porque errar para cima encarece a
 * decisao (recusa alvo magro) e errar para baixo aprova operacao que nao paga o
 * proprio gas — e este projeto ja registra que os dois lados seguros sao
 * opostos conforme a pergunta.
 */
export const GAS_DE_UMA_ARBITRAGEM = 260_000n;

const SELETORES = {
    allPairsLength: sel('allPairsLength()'),
    allPairs: sel('allPairs(uint256)'),
    getPair: sel('getPair(address,address)'),
    token0: sel('token0()'),
    token1: sel('token1()'),
    getReserves: sel('getReserves()'),
};

export interface PoolDaFabrica {
    endereco: string;
    fabrica: string;
    token0: string;
    token1: string;
    /** Reservas CRUAS. Nao normalizadas: a decisao roda em unidade crua. */
    reserva0: bigint;
    reserva1: bigint;
    /** `Date.now()` da leitura. Sem isto "atualizado" nao tem como ser dito. */
    lidoEm: number;
    /** O bloco em que a reserva foi lida. */
    bloco: number;
}

export interface Candidato {
    emprestimo: PoolDaFabrica;
    venda: PoolDaFabrica;
    /** O token emprestado. */
    T: string;
    /** O token devolvido — e onde o lucro sobra. */
    U: string;
    quantia: bigint;
    recebido: bigint;
    devido: bigint;
    /** Sobra em unidades cruas de U. Pode ser negativa: e resposta. */
    sobra: bigint;
}

export type MotivoDaRecusa =
    | 'semSobra'
    | 'gasDesconhecido'
    | 'naoPagaOGas'
    | 'reservaVelha';

export interface Decisao {
    candidato: Candidato;
    aprovado: boolean;
    motivo: MotivoDaRecusa | null;
    /** Custo do gas em unidades de U. `null` quando U nao e o WETH. */
    custoEmU: bigint | null;
    /** Sobra menos o custo. `null` quando o custo nao e conhecido. */
    liquido: bigint | null;
}

/**
 * O TAMANHO OTIMO, por busca ternaria em unidade CRUA.
 *
 * Por que ternaria e nao a formula fechada: a sobra do flash swap de duas
 * pernas e unimodal em `quantia` (sobe, tem maximo, desce), mas a conta inclui
 * a divisao inteira com `+1` do pagamento — e a formula fechada ignora esse
 * arredondamento. Buscar sobre a FUNCAO REAL, a mesma que decide, evita
 * aprovar um tamanho que a conta do contrato recusa.
 *
 * O teto e uma fracao da reserva do token emprestado: nao se empresta o que o
 * pool nao tem, e passar de um terco move o preco contra a propria operacao.
 */
export function melhorTamanho(
    e: Omit<Parameters<typeof sobraDoFlashSwap>[0], 'quantia'>,
    teto: bigint,
    passos = 60,
): { quantia: bigint; sobra: bigint; recebido: bigint; devido: bigint } | null {
    if (teto <= 0n) return null;
    const em = (q: bigint): bigint => {
        if (q <= 0n) return -1n;
        const r = sobraDoFlashSwap({ ...e, quantia: q });
        return r === null ? -1n : r.sobra;
    };
    let baixo = 1n;
    let alto = teto;
    for (let i = 0; i < passos && alto - baixo > 1n; i += 1) {
        const a = baixo + (alto - baixo) / 3n;
        const b = alto - (alto - baixo) / 3n;
        if (em(a) < em(b)) baixo = a + 1n; else alto = b;
    }
    let melhor = baixo;
    let melhorSobra = em(baixo);
    for (const q of [alto, (baixo + alto) / 2n]) {
        const s = em(q);
        if (s > melhorSobra) { melhor = q; melhorSobra = s; }
    }
    const r = sobraDoFlashSwap({ ...e, quantia: melhor });
    if (r === null) return null;
    return { quantia: melhor, ...r };
}

/**
 * Monta os candidatos de duas pernas a partir dos pools lidos.
 *
 * So pares presentes em DOIS pools de fabricas DIFERENTES: dentro de uma
 * fabrica so ha um pool por par, e cruzar o pool com ele mesmo produz a
 * reversao `UniswapV2: LOCKED` em vez de arbitragem — medido na ENTREGA 1.
 */
export function montarCandidatos(pools: PoolDaFabrica[]): Candidato[] {
    const porPar = new Map<string, PoolDaFabrica[]>();
    for (const p of pools) {
        const k = [p.token0, p.token1].sort().join('|');
        const l = porPar.get(k);
        if (l === undefined) porPar.set(k, [p]); else l.push(p);
    }
    const fora: Candidato[] = [];
    for (const lista of porPar.values()) {
        if (lista.length < 2) continue;
        for (const emprestimo of lista) {
            for (const venda of lista) {
                if (emprestimo.endereco === venda.endereco) continue;
                // FABRICAS DIFERENTES: o mesmo par na mesma DEX nao existe, e o
                // mesmo pool duas vezes trava no guard de reentrancia do pool.
                if (emprestimo.fabrica === venda.fabrica) continue;
                for (const qualT of [0, 1] as const) {
                    const T = qualT === 0 ? emprestimo.token0 : emprestimo.token1;
                    const U = qualT === 0 ? emprestimo.token1 : emprestimo.token0;
                    const vT = venda.token0 === T ? venda.reserva0 : venda.reserva1;
                    const vU = venda.token0 === T ? venda.reserva1 : venda.reserva0;
                    const eU = emprestimo.token0 === U ? emprestimo.reserva0 : emprestimo.reserva1;
                    const eT = emprestimo.token0 === U ? emprestimo.reserva1 : emprestimo.reserva0;
                    if (vT <= 0n || vU <= 0n || eU <= 0n || eT <= 0n) continue;
                    const melhor = melhorTamanho(
                        {
                            vendaReservaT: vT, vendaReservaU: vU,
                            emprestimoReservaU: eU, emprestimoReservaT: eT,
                        },
                        eT / 3n,
                    );
                    if (melhor === null) continue;
                    fora.push({ emprestimo, venda, T, U, ...melhor });
                }
            }
        }
    }
    return fora.sort((a, b) => (b.sobra > a.sobra ? 1 : b.sobra < a.sobra ? -1 : 0));
}

/** Quando uma reserva lida deixa de servir para decidir. */
export const RESERVA_VENCE_EM_MS = 6_000;

/**
 * A DECISAO ECONOMICA, no token em que o lucro sobra.
 *
 * A exigencia e dela: *"Rejeição automática de operações sem margem
 * suficiente"*. E cada recusa tem um MOTIVO nomeado, porque "nao aprovei" sem
 * motivo e indistinguivel de "nao avaliei" — o defeito que este projeto
 * persegue desde a primeira pagina.
 */
export function decidir(
    c: Candidato, gasWei: bigint, agora: number, gasDaArbitragem = GAS_DE_UMA_ARBITRAGEM,
): Decisao {
    const velha = agora - Math.min(c.emprestimo.lidoEm, c.venda.lidoEm) > RESERVA_VENCE_EM_MS;
    if (velha) {
        return { candidato: c, aprovado: false, motivo: 'reservaVelha', custoEmU: null, liquido: null };
    }
    if (c.sobra <= 0n) {
        return { candidato: c, aprovado: false, motivo: 'semSobra', custoEmU: null, liquido: null };
    }
    // O GAS EM U. Conhecido so quando U e o WETH: para qualquer outro token eu
    // nao sei a conversao sem um preco, e inventa-la seria fabricar o piso
    // economico. Sem conversao o candidato NAO e aprovavel, e o motivo e dito.
    if (c.U !== WETH_DA_BASE) {
        return {
            candidato: c, aprovado: false, motivo: 'gasDesconhecido',
            custoEmU: null, liquido: null,
        };
    }
    const custoEmU = gasWei * gasDaArbitragem;
    const liquido = c.sobra - custoEmU;
    return {
        candidato: c,
        aprovado: liquido > 0n,
        motivo: liquido > 0n ? null : 'naoPagaOGas',
        custoEmU,
        liquido,
    };
}

export function comoLerARecusa(m: MotivoDaRecusa): string {
    switch (m) {
        case 'semSobra':
            return 'a conta do contrato diz que a operação devolve menos do que recebe: não há '
                + 'ciclo, em tamanho nenhum';
        case 'gasDesconhecido':
            return 'o lucro sobraria num token que não é o WETH, e sem preço eu NÃO sei converter '
                + 'o gás: não aprovo o que não sei custear';
        case 'naoPagaOGas':
            return 'há ciclo real, e ele não paga o próprio gás. Executar seria prejuízo';
        case 'reservaVelha':
            return 'a reserva lida venceu antes de a decisão sair: decidir sobre estado velho é '
                + 'aprovar o que a cadeia já mudou';
    }
}

// ---------------------------------------------------------------------------
// O LACO. Daqui para baixo e integracao, e nada disto e chamado por teste
// unitario: `principal()` abre WebSocket e fala com a rede.
// ---------------------------------------------------------------------------

interface Transporte {
    (metodo: string, params: unknown[]): Promise<unknown>;
}

async function emLote<A, B>(
    itens: A[], trabalho: (a: A) => Promise<B>, concorrencia = 4,
): Promise<B[]> {
    const fora = new Array<B>(itens.length);
    let i = 0;
    await Promise.all(Array.from({ length: concorrencia }, async () => {
        for (;;) {
            const meu = i; i += 1;
            if (meu >= itens.length) return;
            fora[meu] = await trabalho(itens[meu]!);
        }
    }));
    return fora;
}

const numDe = (hex: unknown): bigint | null => (
    typeof hex === 'string' && hex !== '0x' ? BigInt(hex) : null
);
const endDe = (hex: unknown): string | null => (
    typeof hex === 'string' && hex.length >= 42 ? `0x${hex.slice(-40)}`.toLowerCase() : null
);

/**
 * Descobre o universo UMA vez: pares das fabricas menores, cruzados contra
 * todas as outras. E a etapa caras, e ela nao repete a cada bloco.
 */
/**
 * Varias leituras numa requisicao, com repeticao. UM lugar so.
 *
 * As duas etapas que leem a corrente (descobrir o universo e reler reservas)
 * passam por aqui. Ter duas implementacoes de leitura em lote seria a regra em
 * dois lugares — e foi exatamente isso que deixou a DESCOBERTA perdendo 70
 * leituras enquanto a RELEITURA ja estava em 100%.
 */
export async function lerEmLote(
    chamar: Transporte, chamadas: ChamadaMulti[],
): Promise<Array<{ ok: boolean; dados: string }>> {
    const fora: Array<{ ok: boolean; dados: string }> = [];
    for (const pedaco of partirEmPedacos(chamadas, CHAMADAS_POR_MULTICALL)) {
        let crua: unknown = null;
        for (let i = 0; i < 3 && crua === null; i += 1) {
            try {
                crua = await chamar('eth_call', [
                    { to: MULTICALL3, data: codificarAggregate3(pedaco) }, 'latest',
                ]);
            } catch {
                if (i < 2) await new Promise<void>((r) => { setTimeout(r, 200 * (i + 1)); });
            }
        }
        if (typeof crua !== 'string' || crua === '0x') {
            // O LOTE que falhou conta como falha de CADA leitura dele: assim a
            // cobertura nao some, ela aparece.
            for (let k = 0; k < pedaco.length; k += 1) fora.push({ ok: false, dados: '0x' });
            continue;
        }
        try {
            fora.push(...decodificarAggregate3Rapido(crua));
        } catch {
            for (let k = 0; k < pedaco.length; k += 1) fora.push({ ok: false, dados: '0x' });
        }
    }
    return fora;
}

/**
 * Le com PACIENCIA. O RPC publico recusa requisicao em rajada, e sem repeticao
 * com espera a varredura devolve lista curta — que e resposta falsa com cara de
 * medicao. Na primeira execucao continua 153 leituras falharam e so 6 de 46
 * pools foram lidos: 13% de cobertura publicada sem ressalva.
 */
async function lerComPaciencia(
    chamar: Transporte, to: string, data: string, tentativas = 3,
): Promise<unknown> {
    for (let i = 0; i < tentativas; i += 1) {
        try {
            return await chamar('eth_call', [{ to, data }, 'latest']);
        } catch {
            if (i < tentativas - 1) {
                await new Promise<void>((r) => { setTimeout(r, 150 * (i + 1)); });
            }
        }
    }
    return null;
}

export async function descobrirUniverso(
    chamar: Transporte, tetoPorFabrica: number,
): Promise<{ pools: string[]; porFabrica: Map<string, string>; falhas: number }> {
    const ler = (to: string, data: string): Promise<unknown> => lerComPaciencia(chamar, to, data);
    const porFabrica = new Map<string, string>();
    let falhas = 0;
    const tamanhos = await emLote([...FABRICAS_COM_FLASH_SWAP], async (f) => ({
        fabrica: f, total: numDe(await ler(f, SELETORES.allPairsLength)),
    }));
    const vivas = tamanhos.filter((x) => x.total !== null && x.total > 0n);
    falhas += tamanhos.length - vivas.length;
    if (vivas.length < 2) return { pools: [], porFabrica, falhas };
    vivas.sort((a, b) => (a.total! < b.total! ? -1 : 1));

    // Pools das fabricas MENORES: baratas de varrer.
    const paresVistos = new Map<string, [string, string]>();
    for (const { fabrica, total } of vivas.slice(0, vivas.length - 1)) {
        const quantos = Math.min(tetoPorFabrica, Number(total));
        const indices = Array.from({ length: quantos }, (_, k) => Number(total) - 1 - k);
        // POR MULTICALL tambem. Era o TERCEIRO lugar com leitura simples, e
        // perdia entradas igual aos outros dois: so quando os tres passaram
        // pelo mesmo caminho a cobertura fechou. REGRA 3 do CLAUDE.md — e eu a
        // consertei em tres etapas em vez de uma.
        const rsPares = await lerEmLote(chamar, indices.map((idx) => ({
            alvo: fabrica,
            dados: SELETORES.allPairs + coder.encode(['uint256'], [idx]).slice(2),
        })));
        const achados: string[] = [];
        for (const r of rsPares) {
            if (r.ok !== true) { falhas += 1; continue; }
            const e = endDe(r.dados);
            if (e !== null && !/^0x0+$/.test(e)) achados.push(e);
        }
        for (const e of achados) porFabrica.set(e, fabrica);
        // Os TOKENS de cada pool, POR MULTICALL. Em leitura simples o RPC
        // publico recusava e 70 pares se perdiam — e par perdido aqui e rota
        // que nunca existe, publicada como "0 rotas avaliadas".
        const rs = await lerEmLote(chamar, achados.flatMap((a) => [
            { alvo: a, dados: SELETORES.token0 },
            { alvo: a, dados: SELETORES.token1 },
        ]));
        for (let i = 0; i < achados.length; i += 1) {
            const t0 = rs[i * 2]; const t1 = rs[i * 2 + 1];
            const x = t0?.ok === true ? endDe(t0.dados) : null;
            const y = t1?.ok === true ? endDe(t1.dados) : null;
            if (x === null || y === null) { falhas += 1; continue; }
            paresVistos.set([x, y].sort().join('|'), [x, y]);
        }
    }

    // O CRUZAMENTO, e ele e o que torna o universo capaz de fechar ciclo.
    //
    // DEFEITO MEU, achado na primeira execucao continua: eu enumerava apenas as
    // fabricas menores e NUNCA perguntava o mesmo par as outras. Resultado: 46
    // pools, nenhum par em duas fabricas, e "0 rotas avaliadas" — o MESMO
    // espaco de busca vazio que a ENTREGA 1 diagnosticou, reintroduzido por mim
    // ao portar o codigo. A ENTREGA 1 provou a regra e eu a quebrei na
    // integracao: e a REGRA 3 do CLAUDE.md outra vez.
    const pares = [...paresVistos.values()];
    for (const { fabrica } of vivas) {
        const rs = await lerEmLote(chamar, pares.map(([a, b]) => ({
            alvo: fabrica,
            dados: SELETORES.getPair + coder.encode(['address', 'address'], [a, b]).slice(2),
        })));
        for (let i = 0; i < pares.length; i += 1) {
            const r = rs[i];
            if (r?.ok !== true) { falhas += 1; continue; }
            const pool = endDe(r.dados);
            if (pool === null || /^0x0+$/.test(pool)) continue;
            if (!porFabrica.has(pool)) porFabrica.set(pool, fabrica);
        }
    }
    return { pools: [...porFabrica.keys()], porFabrica, falhas };
}

/**
 * Le token0/token1/getReserves dos pools, por MULTICALL.
 *
 * DEFEITO MEU, medido na segunda execucao continua: uma chamada por leitura
 * dava 261 `eth_call` por ciclo contra o RPC publico, ele recusava em rajada, e
 * a cobertura ficou em **18%** — 293 leituras falhadas em tres ciclos. Publicar
 * "0 rotas avaliadas" com 18% de cobertura e ausencia com cara de resposta.
 *
 * O `multicall.ts` deste projeto ja resolve isso e ja e usado pelo cacador de
 * liquidacoes: 261 leituras viram 2 requisicoes. Reusar em vez de criar um
 * segundo caminho de leitura e a regra que ela pos nesta entrega.
 */
export async function lerPools(
    chamar: Transporte, enderecos: string[], porFabrica: Map<string, string>, bloco: number,
): Promise<{ pools: PoolDaFabrica[]; falhas: number }> {
    const chamadas: ChamadaMulti[] = [];
    for (const a of enderecos) {
        chamadas.push({ alvo: a, dados: SELETORES.token0 });
        chamadas.push({ alvo: a, dados: SELETORES.token1 });
        chamadas.push({ alvo: a, dados: SELETORES.getReserves });
    }
    const respostas = await lerEmLote(chamar, chamadas);

    let falhas = 0;
    const pools: PoolDaFabrica[] = [];
    for (let i = 0; i < enderecos.length; i += 1) {
        const [t0, t1, r] = [respostas[i * 3], respostas[i * 3 + 1], respostas[i * 3 + 2]];
        if (t0 === undefined || t1 === undefined || r === undefined
            || !t0.ok || !t1.ok || !r.ok) { falhas += 1; continue; }
        const token0 = endDe(t0.dados); const token1 = endDe(t1.dados);
        if (token0 === null || token1 === null) { falhas += 1; continue; }
        try {
            const [r0, r1] = coder.decode(['uint112', 'uint112', 'uint32'], r.dados);
            if (r0 === 0n || r1 === 0n) continue;
            pools.push({
                endereco: enderecos[i]!, fabrica: porFabrica.get(enderecos[i]!) ?? '?',
                token0, token1, reserva0: r0 as bigint, reserva1: r1 as bigint,
                lidoEm: Date.now(), bloco,
            });
        } catch { falhas += 1; }
    }
    return { pools, falhas };
}

/** Quantos pools tiveram reserva DIFERENTE da volta anterior. */
export function quantosMudaram(
    antes: Map<string, PoolDaFabrica>, agora: PoolDaFabrica[],
): number {
    let n = 0;
    for (const p of agora) {
        const a = antes.get(p.endereco);
        if (a === undefined || a.reserva0 !== p.reserva0 || a.reserva1 !== p.reserva1) n += 1;
    }
    return n;
}

/** O resumo de tempos em UMA linha: ela pediu telemetria que não vira projeto. */
function resumoCurto(livro: LivroDeTempos): string {
    const r = livro.resumo('real');
    return typeof r === 'object' && r !== null
        ? JSON.stringify(r).slice(0, 400)
        : String(r);
}

export const PLACAR = {
    blocos: 0,
    ciclos: 0,
    avaliados: 0,
    aprovados: 0,
    recusas: { semSobra: 0, gasDesconhecido: 0, naoPagaOGas: 0, reservaVelha: 0 },
    leiturasQueFalharam: 0,
    /** A melhor sobra vista, em wei de WETH, e quanto o gás custava então. */
    melhorSobraEmWeth: 0n,
    gasQuandoFoi: 0n,
};

export function comoLerOPlacar(): string {
    const r = PLACAR.recusas;
    // A RAZAO sai como "sobra/gás", nao "gás/sobra": a primeira versao imprimia
    // `(0x)` para uma razao de 0,12 — e `0x` le como prefixo hexadecimal, nao
    // como "zero vezes". Etiqueta ilegivel no numero que decide.
    const melhor = PLACAR.melhorSobraEmWeth > 0n
        ? `melhor sobra ${new Decimal(PLACAR.melhorSobraEmWeth.toString()).div(1e18).toFixed(10)}`
            + ` WETH contra gás de ${new Decimal(PLACAR.gasQuandoFoi.toString()).div(1e18).toFixed(10)}`
            + ` ETH — a sobra é ${PLACAR.gasQuandoFoi > 0n
                ? `${new Decimal(PLACAR.melhorSobraEmWeth.toString())
                    .div(new Decimal(PLACAR.gasQuandoFoi.toString())).toFixed(2)}x o gás`
                : 'o gás não foi medido'}`
        : 'nenhuma sobra positiva';
    return `${PLACAR.blocos} bloco(s), ${PLACAR.ciclos} ciclo(s), ${PLACAR.avaliados} rota(s) `
        + `avaliada(s), ${PLACAR.aprovados} APROVADA(S) | recusas: semSobra ${r.semSobra}, `
        + `naoPagaOGas ${r.naoPagaOGas}, gasDesconhecido ${r.gasDesconhecido}, `
        + `reservaVelha ${r.reservaVelha} | ${melhor} | ${PLACAR.leiturasQueFalharam} leitura(s) `
        + 'que falharam';
}

/**
 * O laco continuo. Nao e importado por teste nenhum — ele abre WebSocket.
 *
 * `ARB_CICLOS` limita a execucao para ela ser REPRODUZIVEL, que e o que ela
 * pediu: *"Uma execução contínua, limitada e reproduzível"*. Sem o limite ele
 * roda indefinidamente.
 */
async function principal(): Promise<void> {
    const rpc = process.env.ARB_RPC_URL ?? process.env.CACA_RPC_URL ?? 'https://mainnet.base.org';
    const tetoPorFabrica = Number(process.env.ARB_POOLS ?? 120);
    const tetoDeCiclos = Number(process.env.ARB_CICLOS ?? 0);
    const tetoDeRotas = Number(process.env.ARB_ROTAS ?? 400);

    const { ProxyAgent, fetch } = await import('undici');
    const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    const chamar: Transporte = async (metodo, params) => {
        const r = await fetch(rpc, {
            ...(agente ? { dispatcher: agente } : {}),
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: metodo, params }),
        } as Parameters<typeof fetch>[1]);
        const j = await r.json() as { result?: unknown; error?: unknown };
        if (j.error !== undefined) throw new Error(JSON.stringify(j.error).slice(0, 160));
        return j.result;
    };

    log.info('[ARB] Caçador de arbitragem contínuo. ENVIO INEXISTENTE neste caminho.', {
        rpc: new URL(rpc).host,
        fabricas: FABRICAS_COM_FLASH_SWAP.length,
        tetoPorFabrica,
        ciclos: tetoDeCiclos > 0 ? tetoDeCiclos : 'sem limite',
        oQueIssoNaoFaz: 'não existe envio de transação neste arquivo: a ENTREGA 2 é observação '
            + 'contínua, e um caminho de envio que ninguém pediu seria risco sem autorização',
    });

    // O AVISO DE BLOCO: reusa o ouvinte que já existe, com a mesma política de
    // endereço (CACA_WS_URL, ou derivar só com CACA_WS_DERIVAR=1).
    const alvo = enderecoDeBlocos(rpc, process.env);
    const ouvinte = alvo.url === null
        ? null
        : new OuvinteDeBlocos(alvo.url, (aviso) => log.warn(`[ARB/BLOCOS] ${aviso}`));
    ouvinte?.abrir();
    log.info('[ARB] Aviso de bloco.', {
        origem: alvo.origem,
        porque: alvo.porque,
        oQueIssoCusta: alvo.url === null
            ? 'sem aviso, o ciclo acorda por TEMPO e o atraso até o bloco fica DESCONHECIDO — é a '
                + 'mesma limitação já medida no caçador de liquidações'
            : 'nenhum: newHeads não gasta CU por bloco',
    });

    const universo = await descobrirUniverso(chamar, tetoPorFabrica);
    PLACAR.leiturasQueFalharam += universo.falhas;
    log.info('[ARB] Universo descoberto UMA vez.', {
        pools: universo.pools.length,
        fabricas: [...new Set(universo.porFabrica.values())].length,
        porque: 'enumerar pools é a etapa cara e não repete a cada bloco; o que repete é a '
            + 'leitura de reserva, que é o que muda',
    });
    if (universo.pools.length === 0) {
        log.error('[ARB] Nenhum pool: não há o que caçar.', {
            oQueIssoNaoE: 'não é "não há arbitragem": é "não consegui enumerar". Ver as falhas',
            falhas: universo.falhas,
        });
        return;
    }

    const livro = new LivroDeTempos();
    const anterior = new Map<string, PoolDaFabrica>();
    let ciclo = 0;
    let blocoAnterior: number | null = null;

    for (;;) {
        if (tetoDeCiclos > 0 && ciclo >= tetoDeCiclos) break;
        ciclo += 1;
        PLACAR.ciclos = ciclo;
        const av = cronometrar(idDeAvaliacao(), 'real', null, null);

        const fimSinal = av.etapa('sinal');
        const blocoAgora = Number(numDe(await chamar('eth_blockNumber', [])) ?? 0n);
        fimSinal(blocoAgora > 0 ? undefined : { comoCorreu: 'falhou' });
        if (blocoAnterior === null || blocoAgora > blocoAnterior) PLACAR.blocos += 1;
        blocoAnterior = blocoAgora;

        const fimLeitura = av.etapa('leitura');
        const { pools, falhas } = await lerPools(
            chamar, universo.pools, universo.porFabrica, blocoAgora,
        );
        PLACAR.leiturasQueFalharam += falhas;
        fimLeitura(pools.length > 0 ? undefined : { comoCorreu: 'vazia' });

        // O NUMERO QUE DECIDE SE EXISTE BUSCA: pares presentes em DUAS
        // fabricas. Sem isto, "0 rotas" e indistinguivel de "espaco vazio" —
        // e foi essa confusao que a ENTREGA 1 diagnosticou e eu repeti.
        const porPar = new Map<string, Set<string>>();
        for (const q of pools) {
            const k = [q.token0, q.token1].sort().join('|');
            const f = porPar.get(k);
            if (f === undefined) porPar.set(k, new Set([q.fabrica])); else f.add(q.fabrica);
        }
        const paresCruzados = [...porPar.values()].filter((f) => f.size >= 2).length;

        const mudaram = quantosMudaram(anterior, pools);
        for (const p of pools) anterior.set(p.endereco, p);

        const fimDecisao = av.etapa('decisao');
        const candidatos = montarCandidatos(pools).slice(0, tetoDeRotas);
        const gasWei = numDe(await chamar('eth_gasPrice', [])) ?? 0n;
        const agora = Date.now();
        const decisoes = candidatos.map((c) => decidir(c, gasWei, agora));
        fimDecisao();

        PLACAR.avaliados += decisoes.length;
        for (const d of decisoes) {
            if (d.aprovado) PLACAR.aprovados += 1;
            else if (d.motivo !== null) PLACAR.recusas[d.motivo] += 1;
            if (d.candidato.U === WETH_DA_BASE && d.candidato.sobra > PLACAR.melhorSobraEmWeth) {
                PLACAR.melhorSobraEmWeth = d.candidato.sobra;
                PLACAR.gasQuandoFoi = gasWei * GAS_DE_UMA_ARBITRAGEM;
            }
        }

        // APROVADO passa pela SIMULAÇÃO antes de ser registrado como aprovado.
        //
        // A simulação possível daqui é reler a reserva no instante da decisão e
        // refazer a conta do contrato sobre o estado fresco: é ela que pega a
        // reserva que mudou entre a leitura e a decisão. O que NÃO dá para
        // fazer sem um contrato implantado é `eth_call` do `executarArbitragem`
        // — e isso fica DECLARADO como pendente, não escondido.
        const aprovadas = decisoes.filter((d) => d.aprovado);
        for (const d of aprovadas.slice(0, 3)) {
            const fimSim = av.etapa('simulacao');
            const frescos = await lerPools(
                chamar,
                [d.candidato.emprestimo.endereco, d.candidato.venda.endereco],
                universo.porFabrica, blocoAgora,
            );
            const refeito = frescos.pools.length === 2
                ? montarCandidatos(frescos.pools).find(
                    (x) => x.T === d.candidato.T
                        && x.emprestimo.endereco === d.candidato.emprestimo.endereco,
                )
                : undefined;
            fimSim(refeito === undefined ? { comoCorreu: 'vazia' } : undefined);
            log.warn('[ARB] CANDIDATO APROVADO pela decisão econômica.', {
                bloco: blocoAgora,
                emprestimo: `${d.candidato.emprestimo.endereco} (${d.candidato.emprestimo.fabrica})`,
                venda: `${d.candidato.venda.endereco} (${d.candidato.venda.fabrica})`,
                tokenEmprestado: d.candidato.T,
                lucroSobraEm: d.candidato.U,
                tamanho: d.candidato.quantia.toString(),
                sobra: d.candidato.sobra.toString(),
                custoDoGasEmU: d.custoEmU?.toString() ?? '—',
                liquido: d.liquido?.toString() ?? '—',
                simulacaoSobreEstadoFRESCO: refeito === undefined
                    ? 'NÃO REFEZ: a releitura não trouxe os dois pools'
                    : `sobra ${refeito.sobra} (antes ${d.candidato.sobra})`
                        + (refeito.sobra > (d.custoEmU ?? 0n)
                            ? ' — ainda paga o gás'
                            : ' — JÁ NÃO paga o gás: a reserva mudou'),
                oQueIssoNaoE: 'não é ordem: não existe envio neste caminho. E simulação não é '
                    + 'lucro realizado',
                oQueFaltaProvar: 'eth_call do executarArbitragem exige o contrato implantado; '
                    + 'sem isso a prova de execução é a do fork (npm run arb:fork)',
            });
        }

        livro.guardar(av.fechar('ok'));

        log.info(`[ARB ${blocoAgora}] ciclo ${ciclo}.`, {
            cobertura: (() => {
                const f = pools.length / Math.max(1, universo.pools.length);
                return `${pools.length} de ${universo.pools.length} pools lidos`
                    + ` (${(f * 100).toFixed(1)}%)`
                    + (f < 0.9
                        ? ' — COBERTURA INCOMPLETA: "nenhuma rota" aqui pode ser leitura que faltou,'
                            + ' e não ausência de oportunidade'
                        : '');
            })(),
            reservasQueMudaram: ciclo === 1 ? 'primeira volta (tudo é novo)' : mudaram,
            espacoDeBusca: `${porPar.size} par(es) distinto(s), ${paresCruzados} em DUAS ou mais `
                + 'fábricas'
                + (paresCruzados === 0
                    ? ' — ESPAÇO DE BUSCA VAZIO: "0 rotas" aqui NÃO é ausência de oportunidade, é '
                        + 'ausência de par cruzado. Arbitragem de 2 pernas exige o mesmo par em '
                        + 'duas DEXs'
                    : ''),
            rotas: `${candidatos.length} avaliada(s)`,
            decisao: comoLerOPlacar(),
            latencia: resumoCurto(livro),
            avisoDeBloco: ouvinte === null
                ? 'não configurado'
                : `${ouvinte.estado}, último bloco ${ouvinte.ultimoBloco}`,
        });

        // Dorme até o próximo bloco, ou 2s. Reusa `esperarBlocoOuTempo`: um
        // segundo mecanismo de espera seria o monitoramento paralelo que ela
        // proibiu.
        if (ouvinte !== null) {
            await esperarBlocoOuTempo(
                (f) => ouvinte.assinar(f), 2_000,
                (fn, ms) => setTimeout(fn, ms),
                (id) => clearTimeout(id as NodeJS.Timeout),
            );
        } else {
            await new Promise<void>((r) => { setTimeout(r, 2_000); });
        }
    }

    log.info('[ARB] Fim da execução limitada.', {
        placar: comoLerOPlacar(),
        latencia: resumoCurto(livro),
        oQueIssoProva: 'blocos acompanhados, pools relidos, rotas avaliadas e decisões tomadas '
            + 'com motivo. NÃO prova lucro: nenhuma operação foi enviada',
    });
    ouvinte?.fechar();
}

if (process.env.ATIVAR_CACARARBITRAGEM === '1') {
    void principal().catch((e) => {
        log.error('[ARB] O laço morreu.', { erro: e instanceof Error ? e.message : String(e) });
        process.exitCode = 1;
    });
}
