import {avaliarEExecutarCpammMegazord} from './titanCpammMegazord';
import { agendaRpc, ehSaturacaoRpc, resumoRpcCoordenado } from './rpcCoordenado';
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
import { iniciarPainelTitan, atualizarTitan, progressoTitan, eventoTitan } from './titanPainel';
import { sobraDoFlashSwap } from './ammMath';
import {
    OuvinteDeBlocos, wsDoHttp, enderecoDeBlocos, esperarBlocoOuTempo,
} from './gatilhoDeBloco';
import { cronometrar, LivroDeTempos, idDeAvaliacao } from './cronometro';
import {
    MULTICALL3, codificarAggregate3, decodificarAggregate3Rapido, partirEmPedacos,
    CHAMADAS_POR_MULTICALL, type ChamadaMulti,
} from './multicall';
import {
    acharRotas, melhorTamanhoDaRota, comoLerARota,
    type Rota, type PoolParaRota, type Retencao,
} from './rotas';
import { Exclusoes, classificar, type EstadoDaOportunidade } from './causaDaFalha';
import {
    lerMemoria, gravarMemoria, memoriaVazia, juntar, paraRotas, deDescoberta, comoLerAMemoria,
} from './memoriaDoUniverso';
import { pernasDaCandidata } from './rotasMistas';
import { executarTitan, simularTitanAoVivo } from './titanExecucao';
import { ExploradorDeRotasTitan, limiteAtomicoSeguro } from './titanExplorador';
import { explorarTriangulos, avaliarTetoTriangulo, capacidadePrimeiroPool, tamanhosTriangulo, sondasTriangulo, rotaExecutavelTriangulo, type TrianguloTitan } from './titanTriangulos';
import { retentarTamanhoPorErroTitan } from './titanTaticas';
import { priorizarCotacoes, MemoriaDeCotacoesNegativas, deveProcessarCotacoes } from './titanPriorizacao';
import { detectarRebotesAave, detectarRebotesMorpho, RadarDeRebotes, priorizarRebotes } from './titanRebote';
import { selecionarRotasComGasComparavel } from './titanSelecaoGas';
import { provarV2Atomico } from './titanV2Prova';
import { executarFlashArbV2, diagnosticarFlashArbV2, habilitacaoV2 } from './titanV2Execucao';
import { politicaDeSondaV2 } from './titanV2Modo';
import { selecionarProximaProvaV2, reprovacaoDePoolTravadoV2 } from './titanV2Selecao';
import {
    candidatasMistas, limitacaoDominante, funilVazio, comoLerOFunilMisto, triarCandidatas,
    type PoolMisto, type CandidataMista, type LeiturasDoEstado, type PernaDescrita,
} from './rotasMistas';
import {
    QUOTER_V2, SELETORES_DA_COTACAO, quoterServeOPool, codificarQuoteV3, codificarGetAmountOut,
    primeiraPalavra, escadaDeTamanhos, podeDescartarTamanhosMaiores,
    LivroDeSinais, EstadoDosPools,
    COTADOR_LOCAL, codificarCotarCiclo, lerRespostaDaCotacao, lerCodigoDoCotador,
    impressaoDoEstado, impressaoDosPools, compararEstados,
    type SinalDeArbitragem,
} from './cotarMista';
import {
    codificarTetoDeL1, ORACULO_DE_GAS_L1, somarCusto, julgar, GORJETA_PADRAO_WEI,
} from './custoDaBase';

/**
 * O gas de um ciclo misto VENCEDOR, medido no recibo da execucao atomica em
 * fork (2026-10-15, `forkTests/aMistaQueFecha.js`): 427.168.
 *
 * E estimativa para um sinal ao vivo, e vai marcada como `'estimativa'` em
 * `somarCusto` — nunca como medicao desta operacao.
 */
const GAS_DO_CICLO_MISTO = 427_168n;

/**
 * O que o cacador aprendeu sobre os pools, e vive entre os ciclos.
 *
 * `TAXAS_V3` e `QUOTER_SERVE` sao lidos UMA vez (fee e fabrica nao mudam);
 * `ESTADOS_DOS_POOLS` e o que diz QUAIS rotas foram afetadas, e `LIVRO_DE_SINAIS`
 * guarda a latencia de OBSERVACAO — nunca a do fork.
 */
const TAXAS_V3 = new Map<string, number>();
const QUOTER_SERVE = new Set<string>();
const ESTADOS_DOS_POOLS = new EstadoDosPools();
const LIVRO_DE_SINAIS = new LivroDeSinais();

/** O bytecode JA COMPILADO do `CacadorV3`, do artefato local. */
const CODIGO_DO_COTADOR = lerCodigoDoCotador();

/** A ultima impressao de estado avaliada, e quantos ciclos a repetiram. */
const ULTIMA_IMPRESSAO = { valor: '', repetidas: 0 };
/** Estados novos vistos com o MESMO bloco confirmado: mudanca INTRABLOCO. */
const INTRABLOCO = { detectadas: 0 };


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

/**
 * A GORJETA que esta decisao supoe, em wei por unidade de gas.
 *
 * ESCOLHA declarada, e pequena de proposito: a Base monta o bloco em fatias e
 * este projeto ja mediu que 95% das transacoes de um bloco pagam menos de 0,02
 * gwei e entram. 0,002 gwei e um decimo disso — suficiente para nao ser
 * rejeitada por lance zero, e barata o bastante para nao distorcer o piso.
 */
/**
 * A GORJETA, uma so.
 *
 * DEFEITO QUE ELA APONTOU: havia DUAS constantes para a mesma coisa, as duas
 * lidas de `ARB_GORJETA_WEI`, com defaults DIFERENTES — 2.000.000 aqui e
 * 20.000.000 em `custoDaBase`. Dez vezes de diferenca para o mesmo conceito, e
 * a REGRA 3 deste projeto diz que uma regra em dois lugares e a mesma regra.
 *
 * Fica a de `custoDaBase`, que e a MAIOR: entre duas estimativas de custo, a
 * conservadora e a que nao subestima.
 */
export const GORJETA_SUPOSTA_WEI = GORJETA_PADRAO_WEI;

/**
 * O PRECO DO GAS, do baseFee do bloco mais a gorjeta suposta.
 *
 * NAO de `eth_gasPrice`, e isto foi MEDIDO: no fork do bloco 52608948 o
 * `eth_gasPrice` devolveu 1,004432434 gwei contra um `baseFeePerGas` real de
 * **0,005 gwei** — **200,9x**. O Hardhat inventa uma gorjeta, e usar aquele
 * numero fazia a economia sair 201 vezes pessimista: o cacador ao vivo achou 3
 * candidatos e o fork do MESMO bloco achou ZERO. A divergencia era o
 * termometro, nao o mercado.
 *
 * E a correcao nao vale so para o fork: `eth_gasPrice` de um RPC publico
 * tambem embute uma gorjeta escolhida pelo provedor, que nao e a nossa.
 */
export async function baseFeeDoBlocoWei(chamar: Transporte): Promise<bigint | null> {
    try {
        const b = await chamar('eth_getBlockByNumber', ['latest', false]) as
            { baseFeePerGas?: string } | null;
        const base = b?.baseFeePerGas;
        if (typeof base !== 'string' || base === '0x') return null;
        return BigInt(base);
    } catch {
        return null;
    }
}

/**
 * O PRECO POR GAS a partir do baseFee. A GORJETA ENTRA AQUI, UMA VEZ.
 *
 * Esta e a UNICA soma de gorjeta no caminho do preco por gas. Ela estava
 * escrita em dois lugares — nesta funcao e a mao dentro do laco do cacador —, e
 * duas copias da mesma regra e a REGRA 3 deste projeto: a copia provaria a
 * copia. Quem monta o custo por COMPONENTES nao passa por aqui: usa
 * `baseFeeDoBlocoWei` e declara a gorjeta no campo dela, e `somarCusto` soma
 * uma vez. Somar nos dois lugares foi a dupla contagem que ela achou.
 */
export function porGasWei(baseFeeWei: bigint): bigint {
    return baseFeeWei + GORJETA_SUPOSTA_WEI;
}

/**
 * O PRECO POR GAS lido da rede, isto e baseFee MAIS gorjeta.
 *
 * ELE NAO E UM `baseFee`, e confundir os dois foi a DUPLA CONTAGEM que ela
 * achou: este valor ja inclui a gorjeta, e o caminho da cotacao o passava para
 * `somarCusto` no campo `baseFeeWei`, que soma a gorjeta OUTRA VEZ. O custo L2
 * saia como `gas × (baseFee + gorjeta + gorjeta)`.
 *
 * QUEM CHAMA, conferido por grep e nao por memoria: as ferramentas de fork
 * (`forkTests/oOpcodeInvalido.js`, `rotasDeDoisATres.js`, `osTresCandidatos.js`)
 * e o teste desta regra. O laco do cacador ao vivo NAO chama: ele le o baseFee
 * puro uma vez, deriva o preco com `porGasWei` para `decidir`/`avaliarRotas` e
 * entrega o baseFee PURO a `cotarAfetadas`. Dizer que `decidir` chama esta
 * funcao era doc falsa — o auditor apontou, e a lista acima e o conserto.
 */
export async function precoDoGasWei(chamar: Transporte): Promise<bigint | null> {
    try {
        const base = await baseFeeDoBlocoWei(chamar);
        if (base === null) return null;
        return porGasWei(base);
    } catch {
        // `null`, nao um padrao: sem o baseFee eu nao sei o custo, e decidir
        // com um numero inventado e fabricar o piso economico.
        return null;
    }
}

const SELETORES = {
    allPairsLength: sel('allPairsLength()'),
    allPairs: sel('allPairs(uint256)'),
    getPair: sel('getPair(address,address)'),
    token0: sel('token0()'),
    token1: sel('token1()'),
    getReserves: sel('getReserves()'),
    // `factory()` diz de que tipo o pool e. E ele que separa um pool que
    // sabemos emprestar de um de liquidez concentrada, cuja conta nao e esta.
    factory: sel('factory()'),
    // O ESTADO que o filtro de spread precisa, e so ele: `slot0()` traz o
    // `sqrtPriceX96` do V3 e `getReserves()` traz as reservas CRUAS do
    // Aerodrome, de onde sai o teto demonstrado do invariante `x·y = k`.
    slot0: sel('slot0()'),
    // `stable()` diz QUAL invariante o pool usa. So `false` autoriza descarte.
    estavel: sel('stable()'),
    /** O `fee` do pool V3, que o QuoterV2 exige. Lido do pool, nunca suposto. */
    fee: sel('fee()'),
    /**
     * A LIQUIDEZ ATIVA do pool V3.
     *
     * Ela entra na impressao do estado porque `sqrtPriceX96` sozinho NAO
     * detecta mudanca de liquidez — e liquidez mudada muda o resultado de um
     * swap no mesmo preco. Sem esta leitura nao se pode afirmar que nada
     * mudou, e a rota fica NAO VALIDADA.
     */
    liquidity: sel('liquidity()'),
};

/**
 * O ESTADO DE UM BLOCO para as rotas mistas — `slot0` dos V3 e `getReserves`
 * dos Aerodrome, em LOTE.
 *
 * Ele existe aqui, e nao em `rotasMistas.ts`, porque e leitura de corrente: a
 * TRIAGEM mora la e e a mesma nos dois caminhos (`triarCandidatas`). Duplicar a
 * triagem seria a REGRA 3; duplicar a leitura e inevitavel, porque o transporte
 * do fork e outro.
 *
 * ELA DERRUBOU A VERSAO ANTERIOR desta funcao, 2026-10-15: ela lia
 * `getAmountOut(epsilon, X)` e usava `saida/epsilon` como razao maxima. Duas
 * coisas estavam erradas, e as duas podiam DESCARTAR ARBITRAGEM LUCRATIVA — uma
 * cotacao de tamanho finito nao e teto dos tamanhos menores, e o `epsilon` era
 * o MESMO inteiro cru para tokens de decimais diferentes. Reserva nao tem
 * epsilon, e o teto dela esta demonstrado.
 */
export async function lerEstadoMisto(
    chamar: Transporte,
    candidatas: ReadonlyArray<{pernas:readonly PernaDescrita[]}>,
    bloco: number,
    etiqueta: 'latest' | 'pending' = 'latest',
): Promise<LeiturasDoEstado> {
    const pernas = candidatas.flatMap((c) => c.pernas);
    const v3 = [...new Set(
        pernas.filter((p) => p.protocolo === 'v3').map((p) => p.pool.toLowerCase()),
    )];
    const aero = [...new Set(
        pernas.filter((p) => p.protocolo === 'aerodrome').map((p) => p.pool.toLowerCase()),
    )];
    // O SALDO DA BASE no pool V3 entra aqui porque e a capacidade de
    // EMPRESTIMO dele — e na direcao B e o V3 que empresta.
    const pedidos: ChamadaMulti[] = [
        ...v3.map((q) => ({ alvo: q, dados: SELETORES.slot0 })),
        ...aero.map((q) => ({ alvo: q, dados: SELETORES.getReserves })),
        ...v3.map((q) => ({
            alvo: WETH_DA_BASE,
            dados: SELETORES_DA_COTACAO.balanceOf + q.replace('0x', '').padStart(64, '0'),
        })),
        ...v3.map((q) => ({ alvo: q, dados: SELETORES.liquidity })),
    ];
    const r = pedidos.length === 0 ? [] : await lerEmLote(chamar, pedidos, etiqueta);
    const sqrtPorPoolV3 = new Map<string, bigint | null>();
    const token0PorPool = new Map<string, string>();
    const reservasAerodrome = new Map<string, { r0: bigint; r1: bigint } | null>();
    for (let i = 0; i < v3.length; i += 1) {
        const resp = r[i];
        // `slot0` devolve 7 campos; o primeiro e o `sqrtPriceX96`. Resposta
        // curta ou falha vira `null` — NAO zero: zero recusaria a rota, e
        // ausencia nao descarta.
        const bom = resp !== undefined && resp.ok && resp.dados.length >= 66;
        sqrtPorPoolV3.set(v3[i]!, bom ? BigInt(resp.dados.slice(0, 66)) : null);
    }
    for (let i = 0; i < aero.length; i += 1) {
        const resp = r[v3.length + i];
        // `getReserves()` do Velodrome V2 devolve tres palavras; as duas
        // primeiras sao as reservas. Menos que isso e ausencia, nao zero.
        const bom = resp !== undefined && resp.ok && resp.dados.length >= 130;
        reservasAerodrome.set(aero[i]!, bom
            ? { r0: BigInt(resp.dados.slice(0, 66)), r1: BigInt(`0x${resp.dados.slice(66, 130)}`) }
            : null);
    }
    // `token0` dos V3 ja veio da descoberta: as candidatas conhecem o token do
    // meio, e quem diz de que lado ele esta e o pool. Sem ele o filtro inverte
    // o lado da razao, entao `null` manda cotar em vez de recusar.
    for (const p of pernas) token0PorPool.set(p.pool.toLowerCase(), p.token0.toLowerCase());
    const saldoDaBaseNoV3 = new Map<string, bigint | null>();
    for (let i = 0; i < v3.length; i += 1) {
        const resp = r[v3.length + aero.length + i];
        const bom = resp !== undefined && resp.ok && resp.dados.length >= 66;
        saldoDaBaseNoV3.set(v3[i]!, bom ? BigInt(resp.dados.slice(0, 66)) : null);
    }
    const liquidezDoV3 = new Map<string, bigint | null>();
    for (let i = 0; i < v3.length; i += 1) {
        const resp = r[v3.length + aero.length + v3.length + i];
        const bom = resp !== undefined && resp.ok && resp.dados.length >= 66;
        liquidezDoV3.set(v3[i]!, bom ? BigInt(resp.dados.slice(0, 66)) : null);
    }
    return {
        sqrtPorPoolV3, token0PorPool, reservasAerodrome, bloco, saldoDaBaseNoV3, liquidezDoV3,
    };
}

/**
 * A RESPOSTA DE UM PEDIDO DO LOTE, nos TRES desfechos possiveis.
 *
 * MEDIDO em 2026-10-16, e e o defeito que este tipo conserta: na observacao ao
 * vivo, 443 de 1.332 requisicoes voltaram HTTP 429 e o transporte NAO olhava o
 * status. Corpo JSON que nao fosse array devolvia `{ok:false, dados:null}`
 * para TODOS os pedidos do lote, e `cotarAfetadas` publicava isso como
 * "REVERSÃO OPACA" — falha de rede com cara de falha de contrato, em 4.516
 * cotacoes. O terceiro estado existe para que as duas nunca mais se misturem.
 *
 *   ok: true                       o no EXECUTOU e devolveu resultado
 *   ok: false, dados: '0x…'        o no EXECUTOU e a EVM REVERTEU com dados
 *   falhaDeTransporte: '…'         o no NAO executou: 429, 5xx, timeout, corpo
 *                                  nao-JSON, JSON-RPC torto, id sem resposta
 */
/** A contabilidade de rede, por desfecho. Sem URL, sem credencial. */
export interface ContabilidadeRpc {
    requisicoes: number;
    operacoes: number;
    maiorLote: number;
    http200: number;
    http429: number;
    http5xx: number;
    httpOutro: number;
    /** Corpo que nao e JSON (HTML de portal, texto de limite). */
    corpoNaoJson: number;
    /** JSON valido que nao e resposta JSON-RPC, ou lote que nao e array. */
    jsonrpcMalformado: number;
    /** Resposta com `error` do JSON-RPC (o no respondeu, a chamada falhou). */
    errosJsonRpc: number;
    /** Reversoes com `data` — e delas que sai a cotacao. */
    revertesComDados: number;
    /** Id pedido que nao voltou no lote. */
    semResposta: number;
    /** Timeout ou erro de socket. */
    falhasDeRede: number;
    tentativasExtras: number;
    desistencias: number;
    retryAfterRespeitado: number;
    recusadasPeloTeto: number;
    bytesEnviados: number;
    bytesRecebidos: number;
    msTotal: number;
    porMetodo: Record<string, number>;
}

/** O que `fetch` precisa oferecer. Em teste entra um simulador. */
export type Fetchador = (url: string, init: unknown) => Promise<{
    status: number;
    text: () => Promise<string>;
    headers?: { get: (nome: string) => string | null };
}>;

const contabilidadeVazia = (): ContabilidadeRpc => ({
    requisicoes: 0,
    operacoes: 0,
    maiorLote: 0,
    http200: 0,
    http429: 0,
    http5xx: 0,
    httpOutro: 0,
    corpoNaoJson: 0,
    jsonrpcMalformado: 0,
    errosJsonRpc: 0,
    revertesComDados: 0,
    semResposta: 0,
    falhasDeRede: 0,
    tentativasExtras: 0,
    desistencias: 0,
    retryAfterRespeitado: 0,
    recusadasPeloTeto: 0,
    bytesEnviados: 0,
    bytesRecebidos: 0,
    msTotal: 0,
    porMetodo: {},
});

/**
 * O `Retry-After`, em ms, quando o no diz quanto esperar.
 *
 * Aceita segundos (o formato que os nos de RPC usam) e recusa qualquer coisa
 * que nao seja numero finito e positivo — cabecalho torto nao vira espera
 * inventada. O teto existe para o recuo nao virar espera indefinida.
 */
export function esperaDoRetryAfter(valor: string | null, tetoMs = 10_000): number | null {
    if (valor === null) return null;
    // STRING VAZIA NAO E ZERO: `Number('')` da 0, e aceitar isso trataria
    // cabecalho ausente como "pode tentar de novo agora". Ausencia nao e valor.
    if (valor.trim() === '') return null;
    const seg = Number(valor.trim());
    if (!Number.isFinite(seg) || seg < 0) return null;
    return Math.min(seg * 1000, tetoMs);
}

/**
 * O QUE ESTE STATUS SIGNIFICA: executou, nao executou, ou nao se sabe.
 *
 * 429 e 5xx sao SATURACAO ou falha do provedor — o no nao executou a chamada.
 * 200 e a unica porta para interpretar o corpo. Qualquer outro status tambem e
 * falha de transporte: interpretar corpo de 4xx como resposta economica seria
 * exatamente a confusao que esta rodada conserta.
 */
export function desfechoDoStatus(status: number): 'corpo' | 'saturado' | 'provedor' | 'outro' {
    if (status === 200) return 'corpo';
    if (status === 429) return 'saturado';
    if (status >= 500 && status <= 599) return 'provedor';
    return 'outro';
}

export interface RespostaDeLote {
    ok: boolean;
    dados: string | null;
    /**
     * Preenchido SO quando nao houve execucao no no.
     *
     * Enquanto este campo estiver preenchido, NADA pode ser classificado como
     * reversao opaca: reversao opaca exige evidencia de que a chamada rodou.
     */
    falhaDeTransporte?: string;
}

/**
 * O TRANSPORTE EM LOTE: N pedidos JSON-RPC numa ida e volta.
 *
 * Uma RODADA por degrau da escada, cada rodada num lote JSON-RPC com as rotas
 * que ainda interessam. O custo de N rotas e UM lote por degrau avaliado, nao
 * N requisicoes — e a rota que fecha negativo com monotonicidade demonstrada
 * sai da busca no primeiro degrau.
 *
 * A BUSCA COMECA no menor tamanho porque a razao `saida/entrada` e maxima no
 * tamanho infinitesimal e so cai: se o menor nao tem sobra bruta, nenhum maior
 * tem — e SO nesse caso a busca para ali. Com sobra POSITIVA ela SOBE, porque o
 * lucro LIQUIDO precisa de tamanho para cobrir o gas. Parar com sobra positiva
 * era o defeito que ela apontou.
 */
export type TransporteEmLote = (
    pedidos: Array<{ metodo: string; params: unknown[] }>,
) => Promise<RespostaDeLote[]>;

/**
 * O TRANSPORTE, com os tres desfechos separados e recuo LIMITADO.
 *
 * Ele e montado por uma fabrica, e nao escrito a mao dentro de `principal()`,
 * por uma razao so: assim da para exercita-lo com respostas HTTP SIMULADAS —
 * 429 com JSON, 429 com HTML, 503, timeout, JSON torto, lote parcial, id fora
 * de ordem — sem tocar RPC externo nenhum. O defeito que ele conserta foi
 * demonstrado por codigo e nao por suposicao: o transporte anterior nunca lia
 * `r.status`.
 *
 * O QUE ELE NAO FAZ: nao tenta para sempre (teto de tentativas), nao inventa
 * espera (so respeita `Retry-After` legivel), nao transforma lote recusado em N
 * reversoes de contrato, e nao mexe em nada economico — um pedido que nao foi
 * executado continua sem cotacao, so passa a dizer POR QUE.
 */
export function montarTransporteRpc(opcoes: {
    rpc: string;
    fetchar: Fetchador;
    /** Tentativas TOTAIS por requisicao (1 = sem repetir). */
    tentativas?: number;
    /** Espera entre tentativas. Em teste, instantanea. */
    esperar?: (ms: number) => Promise<void>;
    recuoBaseMs?: number;
    /** Maximo de pedidos por requisicao HTTP; acima disso, parte em pedacos. */
    loteMaximo?: number;
    /** Teto de requisicoes HTTP na execucao. 0 = sem teto. */
    tetoDeRequisicoes?: number;
    timeoutMs?: number;
    coordenarEndpoint?: boolean;
    /** Teto fisico de inicio de requisicoes HTTP por segundo (0 desliga). */
    requisicoesPorSegundo?: number;
    /** Quota dura de HTTP por janela de 1h; ao esgotar dorme ate renovar. */
    requisicoesPorHora?: number;
    agora?: () => number;
}): {
        chamar: Transporte;
        chamarEmLote: TransporteEmLote;
        contabilidade: () => ContabilidadeRpc;
        comoLerAContabilidade: () => string;
    } {
    const conta = contabilidadeVazia();
    const tentativas = Math.max(1, Math.floor(opcoes.tentativas ?? 3));
    const recuoBase = Math.max(0, opcoes.recuoBaseMs ?? 400);
    const loteMaximo = Math.max(1, Math.floor(opcoes.loteMaximo ?? 200));
    const tetoDeRequisicoes = Math.max(0, Math.floor(opcoes.tetoDeRequisicoes ?? 0));
    const timeoutMs = Math.max(0, Math.floor(opcoes.timeoutMs ?? 8_000));
    const rps = opcoes.requisicoesPorSegundo ?? 0;
    const porHora = opcoes.requisicoesPorHora ?? 0;
    if (!Number.isFinite(rps) || rps < 0 || !Number.isFinite(porHora) || porHora < 0) {
        throw new Error('Limites de vazao RPC invalidos');
    }
    const intervaloMinimoMs = rps > 0 ? Math.ceil(1000 / rps) : 0;
    const tetoHora = Math.floor(porHora);
    const agora = opcoes.agora ?? (() => Date.now());
    const esperar = opcoes.esperar
        ?? ((ms: number) => new Promise<void>((s) => { setTimeout(s, ms); }));

    // Um unico agendador PARA TODAS as chamadas concorrentes. Contar depois
    // do fetch deixaria N concorrentes passar pelo mesmo limite. Aqui a vaga
    // e reservada antes da chamada de rede e nao existe corrida.
    let fila: Promise<void> = Promise.resolve();
    let proximaEm = 0;
    let janelaEm = 0;
    let usadasNaHora = 0;
    const reservarVaga = (): Promise<void> => {
        const passo = fila.then(async () => {
            let t = agora();
            if (janelaEm === 0) janelaEm = t;
            if (tetoHora > 0 && t - janelaEm >= 3_600_000) {
                janelaEm = t;
                usadasNaHora = 0;
            }
            if (tetoHora > 0 && usadasNaHora >= tetoHora) {
                await esperar(Math.max(1, 3_600_000 - (t - janelaEm)));
                t = agora();
                janelaEm = t;
                usadasNaHora = 0;
            }
            const pausa = Math.max(0, proximaEm - t);
            if (pausa > 0) await esperar(pausa);
            t = agora();
            proximaEm = Math.max(t, proximaEm) + intervaloMinimoMs;
            usadasNaHora += 1;
        });
        fila = passo.catch(() => {});
        return passo;
    };

    /** Uma ida e volta, com o status JA classificado. Nunca lanca. */
    const umaIda = async (corpo: string, metodos: string[]): Promise<
    { tipo: 'corpo'; texto: string } | { tipo: 'falha'; porque: string; esperarMs: number | null }
    > => {
        await reservarVaga();
        if (tetoDeRequisicoes > 0 && conta.requisicoes >= tetoDeRequisicoes) {
            conta.recusadasPeloTeto += 1;
            return {
                tipo: 'falha',
                porque: `teto de ${tetoDeRequisicoes} requisição(ões) HTTP atingido nesta execução`,
                esperarMs: null,
            };
        }
        conta.requisicoes += 1;
        conta.bytesEnviados += corpo.length;
        for (const m of metodos) conta.porMetodo[m] = (conta.porMetodo[m] ?? 0) + 1;
        const t0 = agora();
        try {
            const r = await opcoes.fetchar(opcoes.rpc, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: corpo,
                ...(timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
                    ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
            });
            const desfecho = desfechoDoStatus(r.status);
            if (desfecho !== 'corpo') {
                if (desfecho === 'saturado') conta.http429 += 1;
                else if (desfecho === 'provedor') conta.http5xx += 1;
                else conta.httpOutro += 1;
                conta.msTotal += agora() - t0;
                const ra = esperaDoRetryAfter(r.headers?.get('retry-after') ?? null);
                if (ra !== null) conta.retryAfterRespeitado += 1;
                return {
                    tipo: 'falha',
                    porque: `HTTP ${r.status} (${desfecho === 'saturado' ? 'saturação do nó'
                        : (desfecho === 'provedor' ? 'falha do provedor' : 'status inesperado')})`,
                    esperarMs: ra,
                };
            }
            conta.http200 += 1;
            const texto = await r.text();
            // Only the live runtime enables endpoint-wide coordination.
            if(opcoes.coordenarEndpoint){
                try{const json=JSON.parse(texto);
                    const itens=Array.isArray(json)?json:[json];
                    if(itens.some(x=>x?.error&&ehSaturacaoRpc(x.error)))agendaRpc(opcoes.rpc).recusar();
                }catch{ /* normal parser below reports malformed responses */ }
            }
            conta.bytesRecebidos += texto.length;
            conta.msTotal += agora() - t0;
            return { tipo: 'corpo', texto };
        } catch (e) {
            conta.msTotal += agora() - t0;
            conta.falhasDeRede += 1;
            const msg = String(e).slice(0, 80);
            return {
                tipo: 'falha',
                porque: `falha de rede ou timeout (${msg})`,
                esperarMs: null,
            };
        }
    };

    /** Tenta, recua e DESISTE. Nunca lanca, nunca repete sem limite. */
    const comRecuo = async (corpo: string, metodos: string[]): Promise<
    { tipo: 'corpo'; texto: string } | { tipo: 'falha'; porque: string }
    > => {
        // Unknown broadcasts must NOT be repeated after a network timeout:
        // the chain could have accepted the transaction before the timeout.
        const limiteTentativas=metodos.some(m=>/^(?:eth_send|personal_send|eth_submit)/i.test(m))
            ? 1 : tentativas;
        let ultima = 'nenhuma tentativa';
        for (let t = 0; t < limiteTentativas; t += 1) {
            // eslint-disable-next-line no-await-in-loop
            const r = await umaIda(corpo, metodos);
            if (r.tipo === 'corpo') return r;
            ultima = r.porque;
            if (t + 1 >= limiteTentativas) break;
            conta.tentativasExtras += 1;
            // eslint-disable-next-line no-await-in-loop
            await esperar(r.esperarMs ?? recuoBase * 2 ** t);
        }
        conta.desistencias += 1;
        return { tipo: 'falha', porque: `${ultima} — desisti após ${limiteTentativas} tentativa(s)` };
    };

    /** O corpo veio: e JSON-RPC de verdade? */
    const lerJson = (texto: string): unknown | null => {
        try { return JSON.parse(texto) as unknown; } catch { return null; }
    };

    const chamar: Transporte = async (metodo, params) => {
        const corpo = JSON.stringify({ jsonrpc: '2.0', id: 1, method: metodo, params });
        conta.operacoes += 1;
        conta.maiorLote = Math.max(conta.maiorLote, 1);
        const r = await comRecuo(corpo, [metodo]);
        if (r.tipo === 'falha') throw new Error(`TRANSPORTE: ${r.porque}`);
        const j = lerJson(r.texto);
        if (j === null) {
            conta.corpoNaoJson += 1;
            throw new Error('TRANSPORTE: corpo HTTP 200 que não é JSON');
        }
        const o = j as Record<string, unknown>;
        if (typeof o !== 'object' || Array.isArray(j)
            || (o.result === undefined && o.error === undefined)) {
            conta.jsonrpcMalformado += 1;
            throw new Error('TRANSPORTE: resposta sem `result` nem `error`');
        }
        if (o.error !== undefined) {
            conta.errosJsonRpc += 1;
            throw new Error(JSON.stringify(o.error).slice(0, 160));
        }
        return o.result;
    };

    /** Um lote, com UMA resposta por id pedido. */
    const umLote = async (
        pedidos: Array<{ metodo: string; params: unknown[] }>,
        divisao=0,
    ): Promise<RespostaDeLote[]> => {
        const corpo = JSON.stringify(pedidos.map((q, i) => ({
            jsonrpc: '2.0', id: i + 1, method: q.metodo, params: q.params,
        })));
        conta.operacoes += pedidos.length;
        conta.maiorLote = Math.max(conta.maiorLote, pedidos.length);
        const r = await comRecuo(corpo, pedidos.map((q) => q.metodo));
        if (r.tipo === 'falha') {
            // Salvage a timed-out READ-ONLY batch with at most one split.
            // Never duplicate broadcasts, and never amplify provider 429/5xx.
            // Each half is still subject to the same HTTP/RPS/hour caps.
            if (divisao===0 && pedidos.length>1
                &&pedidos.every(p=>p.metodo==='eth_call')
                &&/falha de rede ou timeout/i.test(r.porque)
                &&!/(?:teto de|HTTP 429|HTTP 5\\d\\d)/i.test(r.porque)) {
                const meio=Math.floor(pedidos.length/2);
                const esquerda=await umLote(pedidos.slice(0,meio),1);
                const direita=await umLote(pedidos.slice(meio),1);
                return [...esquerda,...direita];
            }
            // No proof of EVM execution: never call this a contract revert.
            return pedidos.map(() => ({ ok: false, dados: null, falhaDeTransporte: r.porque }));
        }
        const j = lerJson(r.texto);
        if (j === null) {
            conta.corpoNaoJson += 1;
            return pedidos.map(() => ({
                ok: false, dados: null, falhaDeTransporte: 'corpo HTTP 200 que não é JSON',
            }));
        }
        if (!Array.isArray(j)) {
            conta.jsonrpcMalformado += 1;
            return pedidos.map(() => ({
                ok: false,
                dados: null,
                falhaDeTransporte: 'resposta de lote que não é array JSON-RPC',
            }));
        }
        // UMA RESPOSTA POR ID PEDIDO: o que nao voltar fica marcado como SEM
        // RESPOSTA, nao como reversao. Lote parcial era lido como N opacas.
        const fora: RespostaDeLote[] = pedidos.map(() => ({
            ok: false, dados: null, falhaDeTransporte: 'o nó não respondeu este id do lote',
        }));
        for (const resp of j as Array<Record<string, unknown>>) {
            // O ID e que casa pedido com resposta — a ORDEM nao, e um lote fora
            // de ordem desalinharia a leitura de todos.
            const i = Number(resp.id) - 1;
            if (!Number.isInteger(i) || i < 0 || i >= fora.length) continue;
            if (typeof resp.result === 'string') {
                fora[i] = { ok: true, dados: resp.result };
                continue;
            }
            const err = resp.error as Record<string, unknown> | undefined;
            // O `data` da reversao E a cotacao: perde-lo faria o numero que
            // estava na resposta virar "sem dado". O decodificador de seletores
            // continua o mesmo, e e ele que decide se o dado e legivel.
            const d = err === undefined ? undefined : err.data;
            const dados = typeof d === 'string'
                ? d
                : (typeof (d as Record<string, unknown> | undefined)?.data === 'string'
                    ? String((d as Record<string, unknown>).data) : null);
            if (dados !== null) {
                conta.revertesComDados += 1;
                fora[i] = { ok: false, dados };
                continue;
            }
            // O NO EXECUTOU e devolveu erro SEM dados: isto e reversao sem
            // seletor — a unica coisa que pode ser chamada de opaca.
            conta.errosJsonRpc += 1;
            fora[i] = { ok: false, dados: null };
        }
        conta.semResposta += fora.filter((x) => x.falhaDeTransporte !== undefined).length;
        return fora;
    };

    const chamarEmLote: TransporteEmLote = async (pedidos) => {
        if (pedidos.length === 0) return [];
        if (pedidos.length <= loteMaximo) return umLote(pedidos);
        const fora: RespostaDeLote[] = [];
        for (let i = 0; i < pedidos.length; i += loteMaximo) {
            // eslint-disable-next-line no-await-in-loop
            fora.push(...await umLote(pedidos.slice(i, i + loteMaximo)));
        }
        return fora;
    };

    const comoLerAContabilidade = (): string => {
        const metodos = Object.entries(conta.porMetodo)
            .sort((a, b) => b[1] - a[1])
            .map(([m, n]) => `${m}=${n}`)
            .join(' ');
        return `RPC — ${conta.requisicoes} requisição(ões) HTTP, ${conta.operacoes} operação(ões) `
            + `JSON-RPC (maior lote ${conta.maiorLote}) | HTTP 200=${conta.http200} `
            + `429=${conta.http429} 5xx=${conta.http5xx} outro=${conta.httpOutro} | `
            + `corpo não-JSON ${conta.corpoNaoJson}, JSON-RPC torto ${conta.jsonrpcMalformado}, `
            + `erro JSON-RPC ${conta.errosJsonRpc}, revert COM dados ${conta.revertesComDados}, `
            + `id sem resposta ${conta.semResposta}, falha de rede/timeout `
            + `${conta.falhasDeRede} | recuos ${conta.tentativasExtras}, desistências `
            + `${conta.desistencias}, Retry-After respeitado ${conta.retryAfterRespeitado}, `
            + `recusadas pelo teto ${conta.recusadasPeloTeto} | enviados `
            + `${conta.bytesEnviados} B, recebidos ${conta.bytesRecebidos} B, rede `
            + `${conta.msTotal}ms | métodos: ${metodos === '' ? '—' : metodos}`;
    };

    return { chamar, chamarEmLote, contabilidade: () => ({ ...conta }), comoLerAContabilidade };
}

/**
 * A COTACAO DO CICLO INTEIRO, para todas as rotas afetadas — UM LOTE POR
 * DEGRAU avaliado, nao uma requisicao para tudo.
 *
 * Cada rota e UM `eth_call` ao cotador local por override de estado. As
 * chamadas de um MESMO degrau vao juntas num lote JSON-RPC; o degrau seguinte e
 * outra ida e volta, e so leva as rotas que ainda interessam. O custo e
 * portanto UM lote por degrau, no maximo `ARB_TAMANHOS` deles. Nenhum fork,
 * nenhuma implantacao, nenhum `hardhat_reset` e nenhum ETH.
 *
 * O caminho esta VALIDADO contra o QuoterV2 oficial, ao wei, em duas pernas V3
 * da fabrica que ele serve — e e por isso que pode ser usado nos pools que
 * nenhum quoter oficial serve, que medido sao 4 de 4 das rotas reais.
 *
 * A BUSCA COMECA no menor degrau porque a razao `saida/entrada` e maxima no
 * tamanho infinitesimal e so cai: se o menor nao tem sobra bruta, nenhum maior
 * tem — e SO nesse caso, e so com a monotonicidade das duas pernas demonstrada,
 * a busca para ali. Com sobra POSITIVA ela SOBE, porque o lucro LIQUIDO precisa
 * de tamanho para cobrir o gas. Parar com sobra positiva era o defeito que ela
 * apontou, e dizer que o tamanho cotado e "o MENOR da escada" era a descricao
 * dele sobrevivendo ao conserto.
 *
 * O QUE ELA DEVOLVE NAO E OTIMO GLOBAL: e o melhor entre os degraus
 * EFETIVAMENTE avaliados, e a frase de cada sinal diz isso.
 */
export async function cotarAfetadas(
    emLote: TransporteEmLote,
    chamar: Transporte,
    afetadas: CandidataMista[],
    L: LeiturasDoEstado,
    etiqueta: 'latest' | 'pending',
    blocoObservado: number,
    observadoEm: number,
    /** baseFee PURO do bloco. NAO é preço por gás: a gorjeta é somada à parte. */
    baseFeeWei: bigint | null,
    codigoDoCotador: string | null,
): Promise<SinalDeArbitragem[]> {
    const base = WETH_DA_BASE.toLowerCase();
    const fora: SinalDeArbitragem[] = [];
    const sinal = (
        c: CandidataMista, quantia: bigint | null, motivo: string,
        bruto: bigint | null = null, custo: bigint | null = null,
    ): SinalDeArbitragem => ({
        rota: c.chave,
        protocolo: 'V3+Aerodrome',
        bloco: blocoObservado,
        etiqueta,
        observadoEm,
        msAteADecisao: Date.now() - observadoEm,
        idadeDoEstadoMs: Date.now() - observadoEm,
        melhorTamanho: quantia,
        lucroBrutoEstimado: bruto,
        custoTotalEstimado: custo,
        lucroLiquidoEstimado: bruto === null || custo === null ? null : bruto - custo,
        simulacao: null,
        motivo,
    });
    if (codigoDoCotador === null) {
        // SEM O CODIGO nao se cota, e isto NAO e "nao ha spread": e falta de
        // instrumento, e as duas pedem acoes opostas.
        return afetadas.map((c) => sinal(
            c, null,
            'SEM COTADOR: não li o bytecode do CacadorV3 do artefato local, então não há como '
            + 'cotar por override. Isto é falta de instrumento, não falta de spread',
        ));
    }

    // O TAMANHO sai da LIQUIDEZ do pool que empresta, nunca de numero meu.
    interface EmBusca {
        c: CandidataMista;
        escada: bigint[];
        /** Proximo degrau a cotar. */
        idx: number;
        /** A monotonicidade das duas pernas esta demonstrada? */
        podeParar: boolean;
        porque: string;
        /** O melhor LIQUIDO entre os tamanhos JA avaliados. */
        melhor: {
            quantia: bigint;
            /** Qual seletor respondeu. Os dois medem coisas diferentes. */
            desfecho: 'fechou' | 'nao fechou';
            /** O que estava EM MAOS. `null` em 'fechou': o cotador nao informa. */
            emMaos: bigint | null;
            /** O que faltava pagar. `null` em 'fechou': o pagamento aconteceu. */
            devido: bigint | null;
            sobra: bigint;
            custo: bigint | null;
            /** `null` quando o custo e desconhecido: sem custo nao ha liquido. */
            liquido: bigint | null;
        } | null;
        /** Quantos degraus foram de fato cotados. */
        avaliados: number;
    }
    const emBusca: EmBusca[] = [];
    for (const c of afetadas) {
        // A CAPACIDADE DE EMPRESTIMO E DO POOL QUE EMPRESTA.
        //
        // Direcao A: o Aerodrome empresta -> a reserva de base DELE.
        // Direcao B: o V3 empresta -> o saldo de base DELE.
        //
        // A versao anterior usava a reserva do Aerodrome nas DUAS, e ela cortou
        // isso por nome: *"Nao reutilize a liquidez de um pool como se fosse a
        // capacidade de emprestimo de outro."*
        const empresta = c.pernas[0];
        let rBase: bigint | null = null;
        if (empresta.protocolo === 'aerodrome') {
            const res = L.reservasAerodrome.get(empresta.pool.toLowerCase()) ?? null;
            rBase = res === null ? null : (empresta.token0 === base ? res.r0 : res.r1);
        } else {
            rBase = L.saldoDaBaseNoV3?.get(empresta.pool.toLowerCase()) ?? null;
        }
        const escada = rBase === null ? [] : escadaDeTamanhos(rBase);
        if (escada.length === 0) {
            fora.push(sinal(
                c, null,
                `SEM DADO: não sei a liquidez de base do pool que EMPRESTA (${empresta.protocolo
                    === 'aerodrome' ? 'reserva do Aerodrome' : 'saldo de base do pool V3'}), e o `
                + 'tamanho sai dela — nunca de um número meu, e nunca da liquidez do outro pool',
            ));
            continue;
        }
        const aeroDaRota = c.pernas.find((p) => p.protocolo === 'aerodrome');
        const corte = podeDescartarTamanhosMaiores({
            aeroEstavel: aeroDaRota === undefined ? false : (aeroDaRota.estavel ?? null),
            tokenNaoConvencional: false,
            temAerodrome: aeroDaRota !== undefined,
        });
        emBusca.push({
            c, escada, idx: 0, podeParar: corte.pode, porque: corte.porque,
            melhor: null, avaliados: 0,
        });
    }
    if (emBusca.length === 0) return fora;

    // O L1 por TETO, uma vez: o calldata do `cacar` tem tamanho fixo, e o gas
    // estimado nao muda com o tamanho — entao o CUSTO e o mesmo em todo degrau.
    const l1 = numDe(await lerComPaciencia(
        chamar, ORACULO_DE_GAS_L1, codificarTetoDeL1(196),
    ));
    const custo = somarCusto({
        gasUsado: GAS_DO_CICLO_MISTO,
        // ESTIMATIVA, e marcada: o 427.168 e recibo de uma execucao em FORK,
        // nao desta operacao.
        gasUsadoVeioDe: 'estimativa',
        baseFeeWei,
        // UMA vez, e aqui: `baseFeeWei` e o baseFee PURO. Somar gorjeta duas
        // vezes foi a dupla contagem que ela achou.
        gorjetaWei: GORJETA_SUPOSTA_WEI,
        custoL1Wei: l1,
        taxaDoEmprestimoWei: 0n,
    });
    // O CUSTO E O MESMO EM TODO DEGRAU, logo a chave de ordenacao entre degraus
    // tambem e. Decidir isso aqui, uma vez, e o que tira a condicao morta de
    // dentro do laco.
    const ordenaPorLiquido = custo.totalWei !== null;

    // A BUSCA PROGRESSIVA DE TAMANHO.
    //
    // DEFEITO QUE ELA APONTOU: quando o PRIMEIRO tamanho tinha sobra bruta
    // positiva, a busca paraVA ali. O atalho de monotonicidade so autoriza
    // DESCARTAR (sobra <= 0 no menor tamanho implica <= 0 em todos), e eu o
    // estava usando para parar com sobra POSITIVA — que e o caso em que subir
    // a escada e justamente o que pode achar lucro liquido.
    //
    // Agora: uma RODADA por degrau, so com as rotas que ainda interessam, todas
    // num lote JSON-RPC. Economia de RPC: a rota que fecha no negativo com
    // monotonicidade demonstrada sai da busca no primeiro degrau, e nenhuma
    // passa de `ARB_TAMANHOS` degraus.
    //
    // E O QUE ISTO NAO E: nao e otimo global. E o melhor liquido entre os
    // tamanhos EFETIVAMENTE AVALIADOS, e a frase do sinal diz isso.
    // `ARB_TAMANHOS` TORTO NAO VIRA ZERO RODADA.
    //
    // `Math.max(1, Number('auto'))` e `NaN`, e `0 < NaN` e falso: o laco nao
    // rodava nenhuma vez e TODA rota saia como "SEM COTAÇÃO legivel", contada
    // como falta de instrumento — sem uma unica chamada de RPC. Falta de spread
    // publicada como falta de cotador, que e a assinatura de defeito deste
    // projeto. Valor torto cai no padrao e DIZ que caiu.
    const cru = process.env.ARB_TAMANHOS;
    const pedido = cru === undefined ? 4 : Number(cru);
    const tetoDeDegraus = Number.isFinite(pedido) && pedido >= 1
        ? Math.floor(pedido)
        : 4;
    if (cru !== undefined && tetoDeDegraus !== Number(cru)) {
        log.warn('[ARB-N] ARB_TAMANHOS inválido: uso o padrão.', {
            recebido: cru,
            usando: tetoDeDegraus,
            porque: 'um valor não numérico viraria NaN e zeraria a busca — nenhuma cotação '
                + 'aconteceria e o funil diria "sem cotador" sem ter tentado',
        });
    }
    const opacas = new Map<string, string>();
    for (let rodada = 0; rodada < tetoDeDegraus; rodada += 1) {
        const nesta = emBusca.filter((e) => e.idx < e.escada.length && e.idx <= rodada);
        if (nesta.length === 0) break;
        const pedidos = nesta.map((e) => ({
            metodo: 'eth_call',
            params: [
                {
                    // `from: 0x0` de proposito: no override o `dono` do
                    // contrato fica zero, e e assim que o portao `soDono` passa.
                    from: '0x0000000000000000000000000000000000000000',
                    to: COTADOR_LOCAL,
                    data: codificarCotarCiclo(
                        pernasDaCandidata(e.c, WETH_DA_BASE, e.escada[e.idx]!), e.escada[e.idx]!,
                    ),
                    gas: '0xB71B00',
                },
                etiqueta,
                { [COTADOR_LOCAL]: { code: codigoDoCotador } },
            ] as unknown[],
        }));
        // eslint-disable-next-line no-await-in-loop
        const r = await emLote(pedidos);
        for (let k = 0; k < nesta.length; k += 1) {
            const e = nesta[k]!;
            const quantia = e.escada[e.idx]!;
            const resp = r[k];
            e.idx += 1;
            // INFRAESTRUTURA PRIMEIRO, e isto e a ordem que importa.
            //
            // Sem evidencia de que o no EXECUTOU a chamada, nada pode ser
            // chamado de reversao — opaca ou nao. `resp === undefined` e id sem
            // resposta; `falhaDeTransporte` e 429, 5xx, timeout, corpo
            // nao-JSON ou lote torto. MEDIDO em 2026-10-16: 443 recusas HTTP
            // apareceram no funil como 4.516 "REVERSÃO OPACA".
            if (resp === undefined || resp.falhaDeTransporte !== undefined) {
                opacas.set(e.c.chave, 'NÃO COTADO POR INFRAESTRUTURA: o nó não executou a chamada '
                    + `(${resp === undefined ? 'nenhuma resposta para este pedido do lote'
                        : resp.falhaDeTransporte}). Isto NÃO é reversão de contrato e NÃO é falta `
                    + 'de spread: é ausência de medição');
                e.idx = e.escada.length;
                continue;
            }
            if (resp.ok) {
                // O padrao Quoter EXIGE reversao. Resposta sem reversao nao e
                // cotacao, e tratar como zero inventaria uma medicao.
                opacas.set(e.c.chave, 'SEM COTAÇÃO: a chamada não reverteu, e o padrão Quoter '
                    + 'responde revertendo com o número. Sem a reversão não há número para ler');
                e.idx = e.escada.length;
                continue;
            }
            const lido = lerRespostaDaCotacao(resp.dados);
            if (lido === null) {
                // AQUI SIM e opaca: o no executou (nao ha falha de transporte)
                // e a EVM reverteu sem seletor reconhecivel.
                opacas.set(e.c.chave, 'REVERSÃO OPACA: nenhum dos dois seletores com número veio. '
                    + `Reversão sem identificação não é cotação (dado: `
                    + `${String(resp.dados).slice(0, 10)})`);
                e.idx = e.escada.length;
                continue;
            }
            e.avaliados += 1;
            // SEM CUSTO CONHECIDO NAO EXISTE LIQUIDO.
            //
            // A versao anterior fazia `liquido = sobra` quando o custo era
            // `null` (falha do oraculo L1), e a frase do sinal imprimia
            // "LIQUIDO <bruto>" — subestimando o custo em 100% na linha que o
            // operador le. Agora o liquido fica `null` e o ranking cai para a
            // sobra BRUTA, dizendo que e isso que esta ordenando.
            const liquido = custo.totalWei === null ? null : lido.sobra - custo.totalWei;
            // A CHAVE DA ORDENACAO E ESCOLHIDA UMA VEZ, e por uma razao de
            // estrutura: `custo` e calculado FORA do laco, entao ou TODO degrau
            // tem liquido ou NENHUM tem. O caso misto nao existe.
            //
            // A versao anterior escrevia a escolha como um ternario por degrau
            // (`liquido !== null && melhor.liquido !== null ? ... : sobra`), e o
            // auditor mostrou que o ramo da sobra era morto no caso normal e
            // ERRADO se alguem movesse `somarCusto` para dentro do laco: ali ele
            // compararia sobra bruta com liquido e adotaria a pior cotacao.
            const anterior = e.melhor;
            // `ordenaPorLiquido` sai do custo, que e o MESMO em todo degrau — e
            // nao do degrau, que era a condicao morta. Com custo conhecido a
            // chave e o liquido; sem custo e a sobra bruta, e a frase diz isso.
            const melhorQueOAtual = anterior === null
                || (ordenaPorLiquido
                    ? liquido! > anterior.liquido!
                    : lido.sobra > anterior.sobra);
            if (melhorQueOAtual) {
                e.melhor = {
                    quantia,
                    desfecho: lido.desfecho,
                    emMaos: lido.emMaos,
                    devido: lido.devido,
                    sobra: lido.sobra,
                    custo: custo.totalWei,
                    liquido,
                };
            }
            // PARA quando a sobra bruta nao e positiva E a monotonicidade das
            // duas pernas esta demonstrada: ai nenhum tamanho maior fecha.
            // Com sobra POSITIVA a busca CONTINUA — era exatamente isso que
            // faltava.
            if (lido.sobra <= 0n && e.podeParar) e.idx = e.escada.length;
        }
    }

    for (const e of emBusca) {
        const opaca = opacas.get(e.c.chave);
        if (e.melhor === null) {
            fora.push(sinal(
                e.c, e.escada[0]!,
                opaca ?? 'SEM COTAÇÃO legível em nenhum degrau avaliado',
            ));
            continue;
        }
        const m = e.melhor;
        const comoFoi = `${e.avaliados} de ${e.escada.length} tamanho(s) avaliado(s)`;
        // NAO E OTIMO GLOBAL, e a ressalva vale nos DOIS ramos: a escada e
        // discreta e a busca para no teto de degraus. O ramo sem custo era
        // justamente o de menor informacao e saia sem ela.
        const naoEOtimo = `melhor entre os tamanhos AVALIADOS (${comoFoi}), não ótimo global: `
            + 'a escada é discreta e a busca para no teto de degraus';
        // O ROTULO SEGUE O SELETOR.
        //
        // "o ciclo produziu X contra Y que entraram" so e verdade no
        // `PagamentoCurto`, onde `emMaos` e `devido` vem na reversao. Em
        // `LucroInsuficiente` o ciclo FECHOU e o unico numero e a sobra — dizer
        // "produziu 0" sobre um ciclo que pagou tudo e sobrou zero era o rotulo
        // falso que o auditor achou, e inventar o total seria pior.
        const semSpread = m.desfecho === 'nao fechou'
            ? `SEM SPREAD neste estado: o ciclo NÃO FECHOU — tinha ${m.emMaos} em mãos contra `
                + `${m.devido} devidos na perna que cobrou (sobra ${m.sobra}, entraram `
                + `${m.quantia}). `
            : `SEM SPREAD neste estado: o ciclo FECHOU e sobrou ${m.sobra} na moeda da base, `
                + `com ${m.quantia} de entrada. O cotador não informa o total recebido nem o `
                + 'total pago neste seletor, então não há o que afirmar sobre eles. ';
        const comSpread = `SOBRA BRUTA ${m.sobra} wei, `
            + (m.liquido === null
                ? 'LÍQUIDO NÃO CALCULÁVEL: o custo total é desconhecido '
                    + `(falta ${custo.faltam.join(', ')}), então a escolha do tamanho foi pela `
                    + `sobra BRUTA e não há líquido para afirmar — ${naoEOtimo}`
                : `LÍQUIDO ${m.liquido} wei — ${naoEOtimo}`)
            + ` — ${julgar(m.sobra, custo).veredicto}`;
        fora.push(sinal(
            e.c, m.quantia,
            // OS PARENTESES SAO O CONSERTO: `+` liga mais forte que `?:`, entao
            // a nota do degrau ilegivel grudava no ramo `:` e NUNCA aparecia
            // quando a sobra era <= 0. Defeito pre-existente, achado pelo
            // auditor na expressao que eu reescrevi em volta.
            (m.sobra <= 0n
                ? semSpread
                    + (e.podeParar
                        ? `Nenhum tamanho maior fecha: ${e.porque}`
                        : `Isto vale para os tamanhos avaliados — ${e.porque}`)
                    + ` [${comoFoi}]`
                : comSpread)
            + (opaca === undefined ? '' : ` | um degrau ficou ilegível: ${opaca.slice(0, 40)}`),
            m.sobra,
            m.custo,
        ));
    }
    return fora;
}

/**
 * O QUOTER SERVE CADA POOL? Conferido pool por pool, uma vez.
 *
 * *"Antes de utilizar qualquer quoter, valide que ele realmente atende à
 * fábrica do pool... Não invente compatibilidade."* Entao: le
 * `quoter.factory()` e `pool.factory()` e guarda SO os pools em que os dois
 * batem. Pool de outra fabrica nao e cotado por este quoter e fica NAO
 * VALIDADO — nunca cotado por um quoter que nao e dele.
 */
export async function conferirQuoter(
    chamar: Transporte, poolsV3: string[],
): Promise<{ servem: Set<string>; fabricaDoQuoter: string | null; recusados: number }> {
    const fabricaDoQuoter = endDe(
        await lerComPaciencia(chamar, QUOTER_V2, SELETORES_DA_COTACAO.factory),
    );
    const servem = new Set<string>();
    let recusados = 0;
    if (fabricaDoQuoter === null || poolsV3.length === 0) {
        return { servem, fabricaDoQuoter, recusados: poolsV3.length };
    }
    const r = await lerEmLote(
        chamar, poolsV3.map((q) => ({ alvo: q, dados: SELETORES.factory })),
    );
    for (let i = 0; i < poolsV3.length; i += 1) {
        const resp = r[i];
        const fab = resp !== undefined && resp.ok ? endDe(resp.dados) : null;
        if (quoterServeOPool(fabricaDoQuoter, fab)) servem.add(poolsV3[i]!); else recusados += 1;
    }
    return { servem, fabricaDoQuoter, recusados };
}

/** O `fee` de cada pool V3, lido do PROPRIO pool — nunca suposto. */
export async function lerTaxasV3(
    chamar: Transporte, poolsV3: string[],
): Promise<Map<string, number>> {
    const fora = new Map<string, number>();
    if (poolsV3.length === 0) return fora;
    const r = await lerEmLote(chamar, poolsV3.map((q) => ({ alvo: q, dados: SELETORES.fee })));
    for (let i = 0; i < poolsV3.length; i += 1) {
        const resp = r[i];
        const v = resp !== undefined && resp.ok ? primeiraPalavra(resp.dados) : null;
        if (v !== null && v > 0n) fora.set(poolsV3[i]!, Number(v));
    }
    return fora;
}

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
    if (c.U.toLowerCase() !== WETH_DA_BASE) {
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
    chamar: Transporte, chamadas: ChamadaMulti[], etiqueta: 'latest' | 'pending' = 'latest',
): Promise<Array<{ ok: boolean; dados: string }>> {
    const fora: Array<{ ok: boolean; dados: string }> = [];
    for (const pedaco of partirEmPedacos(chamadas, CHAMADAS_POR_MULTICALL)) {
        let crua: unknown = null;
        for (let i = 0; i < 3 && crua === null; i += 1) {
            try {
                crua = await chamar('eth_call', [
                    { to: MULTICALL3, data: codificarAggregate3(pedaco) }, etiqueta,
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
        // UM RESULTADO POR CHAMADA PEDIDA, sempre.
        //
        // DEFEITO DE ALINHAMENTO, achado em 2026-10-15: o decodificador devolve
        // o array no tamanho que a RESPOSTA declara, e numa resposta cortada
        // esse numero e menor que o pedaco. Com `push` direto, toda leitura
        // seguinte escorregava uma posicao — e `token0` de um pool passava a
        // ser lido como se fosse de OUTRO. Isso e pior que leitura faltando:
        // leitura faltando aparece, par trocado nao.
        //
        // Medido no mesmo dia: 219 pools concentrados e so 70 com tokens lidos.
        try {
            const lido = decodificarAggregate3Rapido(crua);
            for (let k = 0; k < pedaco.length; k += 1) {
                fora.push(lido[k] ?? { ok: false, dados: '0x' });
            }
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
): Promise<{ pools: PoolDaFabrica[]; falhas: number; vazios: number }> {
    const chamadas: ChamadaMulti[] = [];
    for (const a of enderecos) {
        chamadas.push({ alvo: a, dados: SELETORES.token0 });
        chamadas.push({ alvo: a, dados: SELETORES.token1 });
        chamadas.push({ alvo: a, dados: SELETORES.getReserves });
    }
    const respostas = await lerEmLote(chamar, chamadas);

    let falhas = 0;
    // POOL COM RESERVA ZERO E UMA TERCEIRA CATEGORIA, e nao um dos dois lados.
    //
    // O log publicava `cobertura 661/668 (99,0%)` ao lado de `0 leituras que
    // falharam`, e os dois numeros juntos nao fechavam: os 7 que faltavam eram
    // pools VAZIOS, pulados em silencio. "Nao lido" e "lido e vazio" sao coisas
    // diferentes — o primeiro e buraco de cobertura, o segundo e resposta.
    let vazios = 0;
    const pools: PoolDaFabrica[] = [];
    for (let i = 0; i < enderecos.length; i += 1) {
        const [t0, t1, r] = [respostas[i * 3], respostas[i * 3 + 1], respostas[i * 3 + 2]];
        if (t0 === undefined || t1 === undefined || r === undefined
            || !t0.ok || !t1.ok || !r.ok) { falhas += 1; continue; }
        const token0 = endDe(t0.dados); const token1 = endDe(t1.dados);
        if (token0 === null || token1 === null) { falhas += 1; continue; }
        try {
            const [r0, r1] = coder.decode(['uint112', 'uint112', 'uint32'], r.dados);
            if (r0 === 0n || r1 === 0n) { vazios += 1; continue; }
            pools.push({
                endereco: enderecos[i]!, fabrica: porFabrica.get(enderecos[i]!) ?? '?',
                token0, token1, reserva0: r0 as bigint, reserva1: r1 as bigint,
                lidoEm: Date.now(), bloco,
            });
        } catch { falhas += 1; }
    }
    return { pools, falhas, vazios };
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

/**
 * O FUNIL AUDITAVEL, pedido por ela item por item: *"rotas encontradas,
 * estimadas positivas, excluídas com causa comprovada, simuladas integralmente,
 * revertidas, desconhecidas e economicamente validadas."*
 *
 * Os nomes nao sao sinonimos e o desenho depende disso:
 *
 *   excluidasComCausa      uma peca da rota tem exclusao PROVADA por sonda.
 *                          NUNCA por associacao — e `Exclusoes` nao aceita
 *                          registro sem um `EscopoDaExclusao`, que so nasce de
 *                          uma medicao sobre a peca
 *   inviavelComTaxa        a rota TEM taxa medida e foi AVALIADA com o valor
 *                          efetivo; a sobra nao cobre o custo. Nao foi
 *                          descartada por ter taxa: foi reprovada pela conta
 *   estimadasPositivas     a conta diz que sobra. NAO e lucro: e estimativa
 *   simuladasIntegralmente execucao completa tentada em FORK
 *   reverteram             a execucao integral reverteu
 *   desconhecidas          reverteu sem motivo legivel, ou a sonda nao rodou:
 *                          nada condenado
 *   validadasEconomicamente execucao integral BEM-SUCEDIDA em fork com lucro
 *                          liquido positivo depois de todos os custos. E o
 *                          UNICO campo que autoriza a palavra "lucrativa", e o
 *                          cacador ao vivo NUNCA o incrementa: ele nao roda em
 *                          fork, entao aqui ele e sempre 0 e a frase diz isso.
 */
export const FUNIL = {
    rotasEncontradas: 0,
    /**
     * Pares presentes em DUAS fabricas. `null` = NAO MEDIDO neste caminho.
     *
     * Zero e uma resposta forte — "nao existe o que buscar" — e publicar zero
     * onde ninguem mediu seria a etiqueta que nao descreve o conjunto. Foi o
     * que a primeira versao desta linha fez no teste de fork.
     */
    espacoDeBusca: null as number | null,
    excluidasComCausa: 0,
    inviavelComTaxa: 0,
    estimadasPositivas: 0,
    simuladasIntegralmente: 0,
    reverteram: 0,
    desconhecidas: 0,
    validadasEconomicamente: 0,
    /**
     * OS TRES ESTADOS dela, contados separados de proposito.
     *
     * `NAO_VALIDADA` nao e recusa: e buraco do avaliador. Junta-la com
     * `DESCARTADA` transforma limitacao minha em ausencia de mercado, e foi
     * isso que fez o TITAN publicar "0 oportunidades" por um mes.
     */
    estados: {
        DESCARTADA: 0,
        NAO_VALIDADA: 0,
        EXECUTAVEL_EM_SIMULACAO: 0,
    } as Record<EstadoDaOportunidade, number>,
};

export function comoLerOFunil(ondeRodou: 'aoVivo' | 'fork'): string {
    const f = FUNIL;
    const nota = ondeRodou === 'aoVivo'
        ? 'o caçador ao vivo NÃO executa: `validadasEconomicamente` só pode subir em fork, '
            + 'então 0 aqui é propriedade do caminho e não ausência de oportunidade'
        : 'execução integral em fork; lucro líquido positivo depois de todos os custos';
    const espaco = f.espacoDeBusca === null
        ? 'espaço de busca NÃO MEDIDO neste caminho'
        : `espaço de busca ${f.espacoDeBusca} par(es) em duas fábricas`;
    return `FUNIL — encontradas ${f.rotasEncontradas} (${espaco}) | excluídas COM CAUSA PROVADA ${f.excluidasComCausa} | `
        + `inviáveis com a taxa MEDIDA aplicada ${f.inviavelComTaxa} | `
        + `estimadas positivas ${f.estimadasPositivas} | simuladas integralmente `
        + `${f.simuladasIntegralmente} | reverteram ${f.reverteram} | desconhecidas `
        + `${f.desconhecidas} | VALIDADAS ECONOMICAMENTE ${f.validadasEconomicamente} — ${nota}`
        + ` || ESTADOS: ${f.estados.DESCARTADA} descartada(s) com inviabilidade COMPROVADA, `
        + `${f.estados.NAO_VALIDADA} NÃO VALIDADA(S) (limitação do avaliador, e isso NÃO é `
        + `"não há oportunidade"), ${f.estados.EXECUTAVEL_EM_SIMULACAO} executável(is) em `
        + 'simulação';
}

/**
 * AVALIA rotas de 2 a 4 swaps com a classificacao causal ligada.
 *
 * Esta funcao substitui a exclusao por associacao no caminho do cacador: quem
 * decide se uma perna esta barrada e `Exclusoes.cobre(token, remetente)`, que
 * so responde sim a partir de uma sonda sobre a peca — e no MENOR escopo que a
 * evidencia sustenta.
 *
 * E a taxa MEDIDA nao exclui a rota: ela entra na conta por `retencao`, e a
 * rota e reprovada so se o valor EFETIVO nao cobrir o custo. Era o pedido dela:
 * *"Não descarte automaticamente uma rota apenas porque existe taxa."*
 */
export function avaliarRotas(
    pools: PoolDaFabrica[], gasWei: bigint, ex: Exclusoes,
    // `maxHops` e 2 | 3 | 4 e nao `number` de proposito: `TAMANHOS_DE_ROTA`
    // declara a entrega, e um 5 vindo de variavel de ambiente passaria calado
    // por um `number` — o tipo e o portao.
    opcoes: { maxHops?: 2 | 3 | 4; teto?: number; executor?: string; gasDaArbitragem?: bigint } = {},
): {
    rotas: number;
    estimadas: { rota: Rota; quantia: bigint; sobra: bigint; liquido: bigint; comTaxa: boolean }[];
    excluidasComCausa: number;
    inviavelComTaxa: number;
    semSobra: number;
} {
    const paraRota: PoolParaRota[] = pools.map((q) => ({
        endereco: q.endereco, token0: q.token0, token1: q.token1,
        reserva0: q.reserva0, reserva1: q.reserva1,
        tipo: 'v2', taxaPorDezMil: 30, fabrica: q.fabrica,
    }));
    const rotas = acharRotas(paraRota, WETH_DA_BASE, {
        maxHops: opcoes.maxHops ?? 4,
        podeEmprestar: (q) => q.tipo === 'v2',
        teto: opcoes.teto ?? 40_000,
    });
    const retencao: Retencao = (token, remetente) => ex.retencaoDe(token, remetente);
    const custo = gasWei * (opcoes.gasDaArbitragem ?? GAS_DE_UMA_ARBITRAGEM);
    const estimadas: {
        rota: Rota; quantia: bigint; sobra: bigint; liquido: bigint; comTaxa: boolean;
    }[] = [];
    let excluidasComCausa = 0;
    let inviavelComTaxa = 0;
    let semSobra = 0;

    for (const r of rotas) {
        // 1. EXCLUSAO PROVADA: uma perna cujo token esta barrado SAINDO DAQUELE
        //    pool (ou em qualquer rota, quando a transferencia reverte).
        const barrada = r.hops.some((h) => ex.cobre(h.para, h.pool.endereco) !== null
            && ex.cobre(h.para, h.pool.endereco)!.reverteu);
        if (barrada) { excluidasComCausa += 1; continue; }

        // 2. A TAXA MEDIDA entra na CONTA, nao no descarte.
        const temTaxa = r.hops.some((h) => {
            const t = ex.retencaoDe(h.para, h.pool.endereco);
            return t !== null && t > 0;
        });
        const m = melhorTamanhoDaRota(r, 40, undefined, retencao, opcoes.executor);
        if (m === null || m.sobra <= 0n) {
            if (temTaxa) inviavelComTaxa += 1; else semSobra += 1;
            continue;
        }
        const liquido = m.sobra - custo;
        if (liquido <= 0n) {
            if (temTaxa) inviavelComTaxa += 1; else semSobra += 1;
            // DESCARTADA: a conta fechada diz que nao paga, com o custo
            // conhecido. Isto e inviabilidade comprovada, nao limitacao.
            FUNIL.estados.DESCARTADA += 1;
            continue;
        }
        // NAO VALIDADA: a conta diz que sobra, e NADA executou. Estimativa nao
        // e execucao — so `EXECUTAVEL_EM_SIMULACAO`, que vem do fork, conta.
        FUNIL.estados[classificar({
            limitacaoDoAvaliador: {
                porque: 'a estimativa é positiva e nenhuma execução integral rodou neste '
                    + 'caminho (o caçador ao vivo não executa)',
            },
        }).estado] += 1;
        estimadas.push({ rota: r, quantia: m.quantia, sobra: m.sobra, liquido, comTaxa: temTaxa });
    }
    return { rotas: rotas.length, estimadas, excluidasComCausa, inviavelComTaxa, semSobra };
}

export const PLACAR = {
    blocos: 0,
    ciclos: 0,
    avaliados: 0,
    estimadosPositivos: 0,
    recusas: { semSobra: 0, gasDesconhecido: 0, naoPagaOGas: 0, reservaVelha: 0 },
    leiturasQueFalharam: 0,
    /** Pools lidos com reserva ZERO: resposta, nao buraco de cobertura. */
    poolsVazios: 0,
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
        + `avaliada(s), ${PLACAR.estimadosPositivos} ESTIMADO(S) POSITIVO(S) — execução NÃO `
        + `comprovada | recusas: semSobra ${r.semSobra}, `
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
export async function iniciarArbitragem(): Promise<void> {
    // O painel usa os eventos do MESMO motor, sem processo concorrente ou
    // leitura de logs. Nenhum caminho HTTP permite assinar ou enviar operacoes.
    iniciarPainelTitan();
    atualizarTitan({
        mode: process.env.TITAN_ENVIAR === '1' ? 'Operacao autorizada' : 'Somente leitura',
        phase: 'Conectando aos mercados',
        description: 'Aguardando os primeiros blocos e preparando os pools na Base.',
    });
    eventoTitan('sistema','Motor TITAN iniciado','Telemetria estruturada, sem acesso a chaves ou funcoes de envio.');
    const rpc = process.env.ARB_RPC_URL ?? process.env.CACA_RPC_URL ?? 'https://mainnet.base.org';
    const tetoPorFabrica = Number(process.env.ARB_POOLS ?? 120);
    const tetoDeCiclos = Number(process.env.ARB_CICLOS ?? 0);
    const tetoDeRotas = Number(process.env.ARB_ROTAS ?? 400);
    // `ARB_HOPS` fora de 2|3|4 MORRE aqui em vez de virar outra coisa em
    // silencio. `Number('quatro')` e NaN, e NaN passaria por um `number`.
    const hopsCrus = Number(process.env.ARB_HOPS ?? 4);
    if (hopsCrus !== 2 && hopsCrus !== 3 && hopsCrus !== 4) {
        throw new Error(`ARB_HOPS=${process.env.ARB_HOPS} não é 2, 3 nem 4. A entrega é de rotas `
            + 'de 2 a 4 swaps; um valor fora disso não tem comportamento definido');
    }
    const hopsPedidos: 2 | 3 | 4 = hopsCrus;

    const { ProxyAgent, fetch } = await import('undici');
    const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
    // O TRANSPORTE, pela fabrica que separa os TRES desfechos.
    //
    // Era escrito a mao aqui, e nao lia `r.status`: HTTP 429 virava
    // `{ok:false, dados:null}` para todo o lote e o funil publicava "REVERSÃO
    // OPACA". Medido em 2026-10-16: 443 recusas, 4.516 cotacoes rotuladas como
    // reversao de contrato. A fabrica e testada com respostas SIMULADAS.
    const TRANSPORTE = montarTransporteRpc({
        rpc,
        coordenarEndpoint: true,
        fetchar: (async (url: string, init: {body:string}) => {
            const corpo=JSON.parse(init.body);
            const agenda=agendaRpc(url);
            await agenda.reservar(Array.isArray(corpo)?corpo.length:1);
            const resposta=await fetch(url, {
                ...(agente ? { dispatcher: agente } : {}),
                ...init,
                signal: Number(process.env.ARB_TIMEOUT_MS??8000)>0
                    ? AbortSignal.timeout(Number(process.env.ARB_TIMEOUT_MS??8000)) : undefined,
            } as Parameters<typeof fetch>[1]);
            if(resposta.status===429){
                const segundos=Number(resposta.headers.get('retry-after'));
                agenda.recusar(Number.isFinite(segundos)?segundos*1000:0);
            }
            return resposta;
        }) as unknown as Fetchador,
        tentativas: Number(process.env.ARB_TENTATIVAS ?? 3),
        loteMaximo: Math.min(16, Number(process.env.ARB_LOTE_MAX ?? 16)),
        tetoDeRequisicoes: Number(process.env.ARB_TETO_RPC ?? 0),
        timeoutMs: Number(process.env.ARB_TIMEOUT_MS ?? 8000),
        requisicoesPorSegundo: Number(process.env.ARB_HTTP_RPS ?? 0),
        requisicoesPorHora: Number(process.env.ARB_HTTP_POR_HORA ?? 0),
    });
    const { chamar, chamarEmLote } = TRANSPORTE;

    log.info('[ARB] TITAN — observador com executor CacadorV3 opcional.', {
        rpc: new URL(rpc).host,
        fabricas: FABRICAS_COM_FLASH_SWAP.length,
        tetoPorFabrica,
        ciclos: tetoDeCiclos > 0 ? tetoDeCiclos : 'sem limite',
        envioReal: process.env.TITAN_ENVIAR === '1'
            ? 'SOLICITADO — ainda depende de nonce exclusivo, cofre, chave, '
                + 'simulação, custo total e lucro líquido'
            : 'DESLIGADO — nenhum ETH é enviado; monitoramento e cotações reais',
        autorizacao: process.env.TITAN_AUTORIZACAO_CONTINUA === '1'
            ? 'SEM PRAZO — com diario persistente, teto de gas e transacoes por dia'
            : 'TEMPORARIA — envio interrompido quando a janela expira',
        protecaoDiaria: process.env.TITAN_AUTORIZACAO_CONTINUA === '1'
            ? { maxTxDia: process.env.TITAN_MAX_TX_DIA ?? 'NAO CONFIGURADO',
                tetoGasWei: process.env.TITAN_GAS_DIA_WEI ?? 'NAO CONFIGURADO' }
            : null,
        custoRpc: `maximo ${process.env.ARB_HTTP_RPS ?? 'sem limite'} HTTP/s, `
            + `${process.env.ARB_HTTP_POR_HORA ?? 'sem limite'} HTTP/h`,
    });

    // Solicitar envio V2 automaticamente inicia primeiro sua prova somente-leitura.
    // Mesmo com a sonda ativa, o envio pago exige TODOS os gates financeiros e a
    // prova atomica concluir 'executavel-em-override', com nova prova antes do broadcast.
    const politicaV2 = politicaDeSondaV2(process.env);
    const bloqueioV2 = habilitacaoV2(process.env);
    if (politicaV2.habilitada || process.env.TITAN_V2_CONTRATO) {
        log[bloqueioV2 === null ? 'info' : 'warn']('[TITAN/V2-PRONTIDAO] Diagnostico das autorizacoes.', {
            envioSolicitado: politicaV2.envioSolicitado,
            sondaAtiva: politicaV2.habilitada,
            sondaAtivadaAutomaticamente: politicaV2.ativadaPorEnvio,
            envioProntoPelasVariaveis: bloqueioV2 === null,
            bloqueio: bloqueioV2 ?? 'nenhum no ambiente; ainda exige prova atomica e contrato',
        });
    }

    // Checagem de implantacao sem assinar ou gastar gas, antes de procurar ordens.
    // A permissao de envio NAO basta quando o deploy manual foi feito por outra conta.
    if (process.env.TITAN_V2_CONTRATO) {
        const diagnostico = await diagnosticarFlashArbV2(
            process.env.TITAN_EXECUTOR_RPC_URL ?? rpc,
        );
        atualizarTitan({ contractReady: diagnostico.pronto });
        eventoTitan(diagnostico.pronto ? 'sistema' : 'alerta',
            diagnostico.pronto ? 'Contrato FlashArb verificado' : 'Contrato com pendencia',
            diagnostico.motivo);
        if (diagnostico.pronto) {
            log.info('[TITAN/V2-IMPLANTACAO] Executor V2 confere onchain.', diagnostico);
        } else {
            log.warn('[TITAN/V2-IMPLANTACAO] Executor V2 NAO pronto para envio.', diagnostico);
        }
    }

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

    // O UNIVERSO: por ATIVIDADE, com o por INDICE como complemento.
    //
    // MEDIDO em 2026-10-15, e e o motivo pelo qual o TITAN nunca capturou nada:
    // varri 120 blocos da Base, achei 33 arbitragens REAIS de ciclo fechado (79
    // pools envolvidos), e o universo por indice — `allPairs[0..N]` de cada
    // fabrica — cobria ZERO deles. O replay em fork confirmou nas seis maiores:
    // 6 de 6 FORA DO UNIVERSO, inclusive uma de V2 puro cujos DOIS pools sao da
    // fabrica `0x8909…8ec6`, que o TITAN varre. Ele tinha a fabrica certa e
    // lia o pedaco errado dela: indice de criacao nao tem relacao com onde ha
    // volume.
    //
    // O por atividade entra PRIMEIRO porque e o que tem evidencia; o por indice
    // continua, somado, para nao PERDER cobertura que ja existia — trocar um
    // pelo outro seria apostar tudo numa medicao de 120 blocos.
    const porAtividade = await universoPorAtividade(chamar, {
        blocos: Number(process.env.ARB_ATIVIDADE_BLOCOS ?? 30),
        tetoDePools: Number(process.env.ARB_ATIVIDADE_TETO ?? 300),
    });
    const porIndice = await descobrirUniverso(chamar, tetoPorFabrica);
    const universo = {
        pools: [...new Set([...porAtividade.pools, ...porIndice.pools])],
        porFabrica: new Map([...porIndice.porFabrica, ...porAtividade.porFabrica]),
        falhas: porAtividade.falhas + porIndice.falhas,
    };
    PLACAR.leiturasQueFalharam += universo.falhas;
    log.info('[ARB] Universo descoberto UMA vez, por ATIVIDADE + índice.', {
        poolsTotal: universo.pools.length,
        porAtividade: `${porAtividade.pools.length} (de ${porAtividade.poolsVistos} vistos `
            + `negociando em ${porAtividade.blocosLidos} bloco(s); `
            + `${porAtividade.recusadosPorFabrica} recusados por fábrica)`,
        porIndice: `${porIndice.pools.length} (allPairs[0..${tetoPorFabrica}])`,
        soNoAtividade: porAtividade.pools.filter(
            (x) => !porIndice.pools.includes(x),
        ).length,
        fabricas: [...new Set(universo.porFabrica.values())].length,
        porque: 'índice de criação não diz onde há volume: medido em 2026-10-15, o universo por '
            + 'índice cobria ZERO dos 79 pools que alimentaram 33 arbitragens reais',
        porVenue: `${porAtividade.porVenue.v2} V2, ${porAtividade.porVenue.v3} V3, `
            + `${porAtividade.porVenue.aerodrome} Aerodrome negociaram`,
        // POOL NAO E OPORTUNIDADE. Esta linha dizia "N pools de liquidez
        // concentrada ficam NAO VALIDADOS", e ela cortou isso por nome: *"Não
        // confunda quantidade de pools observados com quantidade de
        // oportunidades."* A contagem de ROTA sai na linha `[ARB-N] rotas
        // MISTAS`, que roda a mesma `candidatasMistas` do avaliador em fork.
        tokensDosConcentrados: `${porAtividade.tokensPedidos - porAtividade.tokensQueFalharam} `
            + `de ${porAtividade.tokensPedidos} com token0/token1 lidos `
            + `(${porAtividade.tokensQueFalharam} falharam). Medido FORA do caçador no mesmo `
            + 'universo: 194 de 194 respondem e dão 30 rotas mistas — então um número alto aqui '
            + 'é perda do LEITOR, não do mercado',
        osConcentradosViramRota: `${porAtividade.concentrados.length} pool(s) concentrado(s) `
            + 'com tokens lidos entram na descoberta de ROTA mista — a contagem de rotas sai '
            + 'na linha [ARB-N], e não é esta',
        oQueIssoNaoE: porAtividade.metodoIndisponivel
            ? 'o nó NÃO SUPORTA eth_getBlockReceipts: a parte por ATIVIDADE não rodou, e o '
                + 'universo é só o por índice — o que tem cobertura MEDIDA de ZERO nos pools '
                + 'dos vencedores. Isto NÃO é "não há pool ativo"'
            : (porAtividade.blocosLidos === 0
                ? 'a parte por ATIVIDADE não leu bloco nenhum. Isto NÃO é "não há pool ativo"'
                : 'nenhuma ressalva: as duas partes responderam'),
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

    // AS EXCLUSOES PROVADAS, lidas do disco.
    //
    // Elas nascem no fork (`forkTests/aCausaIsolada.js`), onde uma
    // transferencia de verdade mede a retencao peca por peca. O cacador ao vivo
    // NAO condena ninguem: ele so CONSOME prova. Isto e de proposito — condenar
    // a partir de uma reversao ao vivo seria exatamente a condenacao por
    // associacao que esta entrega existe para remover.
    //
    // Arquivo ausente ou torto da registro VAZIO, e a frase do log diz
    // "nenhuma sonda comprovou uma ainda" — nao "nao ha peca ruim".
    const exclusoes = new Exclusoes();
    const caminhoDasExclusoes = process.env.ARB_EXCLUSOES ?? '.tmp/exclusoesProvadas.json';
    try {
        const fs = await import('node:fs');
        if (fs.existsSync(caminhoDasExclusoes)) {
            const cru = JSON.parse(fs.readFileSync(caminhoDasExclusoes, 'utf8')) as unknown;
            const lista = Array.isArray(cru) ? cru : [];
            for (const e of lista) {
                const x = e as Record<string, unknown>;
                if (typeof x.token !== 'string') continue;
                exclusoes.registrar({
                    token: x.token,
                    remetente: typeof x.remetente === 'string' ? x.remetente : null,
                    destinatario: typeof x.destinatario === 'string' ? x.destinatario : null,
                    retidoPorMil: typeof x.retidoPorMil === 'number' ? x.retidoPorMil : null,
                    reverteu: x.reverteu === true,
                    porque: typeof x.porque === 'string' ? x.porque : 'sem frase no arquivo',
                });
            }
        }
    } catch (e) {
        log.warn('[ARB] não consegui ler as exclusões provadas — sigo SEM nenhuma.', {
            caminho: caminhoDasExclusoes,
            erro: String(e),
            oQueIssoNaoE: 'não é "nada está excluído": é "não li o arquivo". Sem ele a conta '
                + 'não desconta taxa nenhuma e as rotas taxadas voltam a parecer lucrativas',
        });
    }
    log.info(`[ARB] ${exclusoes.comoLer()}`, { caminho: caminhoDasExclusoes });

    // AS ROTAS MISTAS: descobertas UMA vez (a descoberta e a parte caras) e
    // TRIADAS a cada estado distinto. O funil atravessa os ciclos, senao
    // `estadosAvaliados` seria sempre 1 — que e exatamente o defeito que ela
    // apontou no relatorio ("250 blocos observados não são 250 estados
    // avaliados"), só do outro lado.
    // A MEMORIA DO UNIVERSO: o que a descoberta de hoje achou, UNIDO ao que
    // ciclos e execucoes anteriores ja tinham visto negociar.
    //
    // MEDIDO em 2026-10-16, e e por isso que isto existe: dos dois pools da
    // vencedora `0x6966a108…`, NENHUM emitiu `Swap` nos 60 blocos anteriores
    // (cobertura 100%, 0 blocos falhos) — e os dois NASCERAM 14,5 milhoes de
    // blocos antes. Janela maior nao os acha e evento de fabrica em janela
    // curta nao os acha; o que os acha e lembrar de quando negociaram.
    //
    // A memoria guarda IDENTIDADE e METADADO. Preco nenhum: `lerEstadoMisto` e
    // `cotarAfetadas` leem o bloco, sempre.
    const redeDaCorrente = Number(numDe(await chamar('eth_chainId', [])) ?? 0n);
    const caminhoDaMemoria = process.env.ARB_MEMORIA ?? '.tmp/universoConhecido.json';
    const doDisco = redeDaCorrente === 0
        ? null : lerMemoria(caminhoDaMemoria, redeDaCorrente);
    if (redeDaCorrente === 0) {
        log.warn('[UNIVERSO] NÃO li o `chainId`: sigo sem memória nesta execução.', {
            oQueIssoNaoE: 'não é "a memória está vazia": é "não sei em que rede estou", e '
                + 'lembrar pool da rede errada seria mirar endereço que não existe aqui',
        });
    }
    let memoria = doDisco ?? memoriaVazia(redeDaCorrente);
    const primeiraJuncao = juntar(
        memoria,
        deDescoberta(porAtividade.concentrados, redeDaCorrente, porAtividade.blocosLidos > 0
            ? Number(numDe(await chamar('eth_blockNumber', [])) ?? 0n) : 0),
        { teto: Number(process.env.ARB_MEMORIA_TETO ?? 5_000) },
    );
    memoria = primeiraJuncao.memoria;
    atualizarTitan({ phase: 'Universo de mercados atualizado',
        description: 'Identificando pools por atividade e memoria persistente.',
        pools: porAtividade.pools.length,
    });
    eventoTitan('descoberta','Mercados mapeados',
        String(porAtividade.pools.length)+' pools V2 conhecidos no inicio da sessao.');
    log.info('[UNIVERSO] A memória dos pools conhecidos.', {
        doDisco: doDisco === null
            ? `NÃO havia memória em ${caminhoDaMemoria} (ou estava torta/de outra rede) — isto `
                + 'NÃO é "não há pool": é "não li"'
            : comoLerAMemoria(doDisco),
        depoisDeJuntar: comoLerAMemoria(memoria),
        novosNestaDescoberta: primeiraJuncao.novas.length,
        descartadosPorTeto: primeiraJuncao.descartadosPorTeto,
        porque: 'pool que ficou quieto na janela de atividade continua conhecido — era isso que '
            + 'faltava, e está medido nas duas vencedoras compatíveis',
    });
    if (doDisco !== null || primeiraJuncao.novas.length > 0) {
        // GRAVA NO INSTANTE EM QUE APRENDE, nao num temporizador: o processo
        // reinicia varias vezes por dia e a coleta de 37 em 37 minutos ja fez
        // este projeto perder tudo o que havia aprendido.
        await gravarMemoria(caminhoDaMemoria, memoria);
    }
    let ultimoEnsaioAtomicoEm=0;
    let atomicasExecutaveis=0;
    let atomicasInviaveis=0;
    let atomicasDesconhecidas=0;
    let ultimoTrianguloEm=0;
    let trianguloEmCurso=false;
    let indiceTriangular=0;
    let triangulosComSpread=0;
    let triangulosSemSpread=0;
    let triangulosAtomicos=0;
    const exploradorTitan = new ExploradorDeRotasTitan();
    let MISTAS = candidatasMistas(paraRotas(memoria), WETH_DA_BASE);
    let triangulosConhecidos:TrianguloTitan[]=[];
    if(process.env.TITAN_EXPLORAR_TRIANGULOS==='1') {
        const triangulos=explorarTriangulos(paraRotas(memoria),WETH_DA_BASE,2000);
        triangulosConhecidos=triangulos;
        log.warn('[TITAN/TRIANGULOS] Descoberta de ciclos de 3 swaps; SOMENTE OBSERVACAO.',{
            total:triangulos.length,
            amostras:triangulos.slice(0,3).map(x=>({
                tokens:x.tokens,pools:x.pools,venues:x.venues,prova:x.prova
            })),
            bloqueio:'sem simulador de tres hops no funil atual; NAO enviar',
        });
    }
    const FM = funilVazio();
    FM.blocosVarridosParaDescoberta = porAtividade.blocosLidos;
    FM.poolsVistos = {
        v3: porAtividade.porVenue.v3, aerodrome: porAtividade.porVenue.aerodrome,
    };
    FM.rotasDistintas = MISTAS.length;
    if (MISTAS.length === 0) FM.limitacaoDeCobertura += 1;
    let blocoDaTriagem = -1;

    // O QUOTER E AS TAXAS, uma vez: `fee` e `factory` nao mudam de bloco para
    // bloco. E a compatibilidade e CONFERIDA pool por pool antes de qualquer
    // cotacao — ela proibiu supor isso por escrito.
    if (MISTAS.length > 0) {
        const poolsV3 = [...new Set(MISTAS.flatMap(
            (c) => c.pernas.filter((x) => x.protocolo === 'v3').map((x) => x.pool.toLowerCase()),
        ))];
        const q = await conferirQuoter(chamar, poolsV3);
        for (const x of q.servem) QUOTER_SERVE.add(x);
        const taxas = await lerTaxasV3(chamar, [...q.servem]);
        for (const [k, v] of taxas) TAXAS_V3.set(k, v);
        log.info('[ARB-N] QuoterV2 conferido contra a fábrica de CADA pool.', {
            quoter: QUOTER_V2,
            fabricaDoQuoter: q.fabricaDoQuoter ?? 'NÃO LI — sem ela não coto nada',
            poolsQueEleServe: q.servem.size,
            poolsRecusados: `${q.recusados} (fábrica diferente ou não lida: NÃO são cotados por `
                + 'ESTE quoter — seria responder sobre outro pool. São cotados pelo COTADOR '
                + 'LOCAL por override de estado, que é a alternativa validada ao wei contra o '
                + 'próprio QuoterV2)',
            paraQueServeOQuoterEntao: 'ele é a CONFERÊNCIA independente: onde ele serve o pool, '
                + 'a resposta dele e a do cotador local podem ser comparadas, e foi assim que o '
                + 'cotador local deixou de ser suposição',
            taxasLidas: `${taxas.size} de ${q.servem.size} (o \`fee\` sai do próprio pool)`,
            oQueIssoNaoE: 'não é "o quoter funciona": é "o quoter e o pool apontam para a MESMA '
                + 'fábrica". Sem isso a cotação seria de outro pool',
            cotadorLocal: CODIGO_DO_COTADOR === null
                ? 'SEM BYTECODE do CacadorV3 no artefato local: não há como cotar por override, '
                    + 'e isto é falta de instrumento, não falta de spread'
                : `${(CODIGO_DO_COTADOR.length - 2) / 2} bytes injetados por override de estado `
                    + 'em `eth_call` (conferido: este nó aceita override). NADA é implantado e '
                    + 'nenhum ETH é gasto',
        });
    }
    log.info(`[ARB-N] ${comoLerOFunilMisto(FM)}`, {
        direcoes: `${MISTAS.filter((x) => x.direcao === 'A').length} com o Aerodrome `
            + `emprestando, ${MISTAS.filter((x) => x.direcao === 'B').length} com o V3`,
        oQueIssoNaoE: 'estas são as rotas DESCOBERTAS. Nenhuma foi avaliada ainda: a triagem '
            + 'por estado sai na linha [ARB-N] de cada bloco',
    });

    let ciclo = 0;
    let blocoAnterior: number | null = null;
    // Nunca mais de uma transmissao por sessao sem uma nova autorizacao explicita.
    let tentativasTitan = 0;
    let ultimoEnsaioTitanEm = 0;
    const pendentesCotacao = new Set<string>();
    let rodadaCotacoes = 0;
    const radarRebote=new RadarDeRebotes();
    let ultimoBlocoReboteSolicitado=0;
    let leituraReboteEmAndamento=false;
    let falhasRebote=0;
    let liquidacoesObservadas=0;
    let poolsVinculadosRebote=0;
    let liquidacoesMorphoObservadas=0;
    let liquidacoesViaAtlasObservadas=0;
    let piscinasMorphoAssociadas=0;
    let transacoesAtlasObservadas=0;
    const memoriaDeCotacoesNegativas = new MemoriaDeCotacoesNegativas(
        Math.max(1_000,Math.min(600_000,
            Number(process.env.TITAN_RECHECK_NEGATIVAS_MS??120_000)||120_000)),
    );
    // Gas-free V2 checks are limited and diverse. Never hammer a toxic
    // token/pool or mistake an old estimate for a current arbitrage.
    const ultimaProvaV2=new Map<string,number>();
    // Um pool que reverteu UniswapV2: LOCKED durante callback atomico nao deve
    // monopolizar uma prova a cada quatro minutos. Outras rotas ganham chance.
    const bloqueiosV2Ate=new Map<string,number>();
    let ultimoEnsaioV2Em=0;
    const tetoCotarRotas = Number(process.env.ARB_COTAR_MAX_ROTAS ?? 12);
    const ultimaTentativaCotacao=new Map<string,number>();
    const tetoTentativasCru = Number(process.env.TITAN_TX_POR_SESSAO ?? 1);
    // O modo continuo nao herda o teto de UMA tentativa por sessao:
    // a trava persistente do executor ja limita contagem + gas POR DIA.
    const tetoTentativasTitan = process.env.TITAN_AUTORIZACAO_CONTINUA === '1'
        ? Number.MAX_SAFE_INTEGER
        : Number.isInteger(tetoTentativasCru) && tetoTentativasCru >= 0
            ? Math.min(10, tetoTentativasCru) : 0;
    // O relogio da redescoberta comeca AGORA: a descoberta do boot acabou de
    // rodar, e reler a mesma janela no primeiro ciclo gastaria RPC para receber
    // a resposta que acabou de chegar.
    let ultimaRedescoberta = Date.now();
    // Busca de pools em paralelo ao loop de cotacao: uma varredura de 150
    // blocos pode levar > 1 minuto com RPC de 2 requests/s.
    // O MESMO transporte e orçamento são compartilhados com o scanner.
    let redescobertaEmAndamento = false;
    let redescobertaPronta: Awaited<ReturnType<typeof universoPorAtividade>> | null = null;
    let redescobertaFalha: string | null = null;

    // O ORCAMENTO DO EXPERIMENTO, por ordem dela: *"observação em tempo real,
    // sem envios, com orçamento limitado de chamadas RPC e duração máxima de 20
    // minutos ou 300 atualizações relevantes, o que ocorrer primeiro."*
    //
    // ATUALIZACAO RELEVANTE e estado DISTINTO avaliado, nao ciclo: um ciclo que
    // acorda no mesmo bloco nao traz atualizacao nenhuma, e contar ciclos
    // mediria a postura em vez do mercado.
    const minutosDoTeto = Number(process.env.ARB_MINUTOS ?? 0);
    const tetoDeAtualizacoes = Number(process.env.ARB_ATUALIZACOES ?? 0);
    const comecouEm = Date.now();
    const porqueParou = (): string | null => {
        if (minutosDoTeto > 0 && Date.now() - comecouEm >= minutosDoTeto * 60_000) {
            return `o teto de ${minutosDoTeto} minuto(s) de observação`;
        }
        if (tetoDeAtualizacoes > 0 && FM.estadosAvaliados >= tetoDeAtualizacoes) {
            return `o teto de ${tetoDeAtualizacoes} atualização(ões) relevante(s)`;
        }
        return null;
    };

    for (;;) {
        const parar = porqueParou();
        if (parar !== null) {
            log.warn('[ARB-N] OBSERVAÇÃO ENCERRADA pelo orçamento — e isto não é conclusão.', {
                porque: parar,
                duracao: `${((Date.now() - comecouEm) / 60_000).toFixed(1)} min`,
                atualizacoesRelevantes: FM.estadosAvaliados,
                livro: LIVRO_DE_SINAIS.comoLer(),
                funil: comoLerOFunilMisto(FM),
                // A CONTABILIDADE DE REDE, por desfecho: sem ela, 33% de
                // recusa HTTP ficava invisível no relatório econômico.
                rpc: TRANSPORTE.comoLerAContabilidade(),
                rpcCoordenado: resumoRpcCoordenado(),
                porSinal: LIVRO_DE_SINAIS.todos.map((sn) => ({
                    rota: sn.rota,
                    protocolo: sn.protocolo,
                    estado: `bloco ${sn.bloco} (${sn.etiqueta})`,
                    msAteADecisao: sn.msAteADecisao,
                    idadeDoEstadoMs: sn.idadeDoEstadoMs,
                    melhorTamanho: sn.melhorTamanho === null ? null : String(sn.melhorTamanho),
                    bruto: sn.lucroBrutoEstimado === null ? null : String(sn.lucroBrutoEstimado),
                    custo: sn.custoTotalEstimado === null ? null : String(sn.custoTotalEstimado),
                    liquido: sn.lucroLiquidoEstimado === null
                        ? null : String(sn.lucroLiquidoEstimado),
                    simulacao: sn.simulacao ?? 'não houve',
                    motivo: sn.motivo,
                })).slice(0, 40),
                oQueIssoNaoE: 'o fim do orçamento NÃO é "não há arbitragem": é o fim da amostra. '
                    + 'Zero spread positivo nesta amostra é zero NESTA amostra',
            });
            break;
        }
        if (tetoDeCiclos > 0 && ciclo >= tetoDeCiclos) break;
        ciclo += 1;
        PLACAR.ciclos = ciclo;

        const av = cronometrar(idDeAvaliacao(), 'real', null, null);

        // A REDESCOBERTA INCREMENTAL, sem reiniciar o processo.
        //
        // O universo era descoberto UMA vez, no boot: um pool que comecasse a
        // negociar depois disso ficava invisivel ate o proximo deploy. Agora a
        // janela de atividade e relida de tempo em tempo, o que ela achar e
        // UNIDO a memoria, e as rotas sao refeitas SO quando entra endereco
        // novo — refazer a cada ciclo seria gastar CPU para repetir a resposta
        // de antes.
        //
        // O ORCAMENTO E DECLARADO e e por tempo, nao por ciclo: no 'dedo no
        // gatilho' o ciclo dura 200ms, e redescobrir a cada N ciclos faria o
        // custo seguir a postura em vez do mercado. Custo de cada rodada: 1
        // `eth_blockNumber` + N `eth_getBlockReceipts` (N = ARB_ATIVIDADE_BLOCOS)
        // + ~3 multicalls de token/taxa. `ARB_REDESCOBRIR_MIN=0` desliga.
        const minutosDaRedescoberta = Number(process.env.ARB_REDESCOBRIR_MIN ?? 5);
        if (minutosDaRedescoberta > 0 && !redescobertaEmAndamento
            && Date.now() - ultimaRedescoberta >= minutosDaRedescoberta * 60_000) {
            ultimaRedescoberta = Date.now();
            redescobertaEmAndamento = true;
            // Sem await: continuar cotando enquanto os logs de swap são lidos.
            // O mesmo transporte continua impondo o teto global de RPC.
            void universoPorAtividade(chamar, {
                blocos: Number(process.env.ARB_ATIVIDADE_BLOCOS ?? 30),
                tetoDePools: Number(process.env.ARB_ATIVIDADE_TETO ?? 300),
            }).then((nova) => { redescobertaPronta = nova; })
              .catch((e) => { redescobertaFalha = String(e).slice(0, 160); })
              .finally(() => { redescobertaEmAndamento = false; });
            log.info('[UNIVERSO] Redescoberta em paralelo (sem bloquear cotacoes).', {
                blocos: Number(process.env.ARB_ATIVIDADE_BLOCOS ?? 30),
                observacao: 'sem broadcast e com o mesmo limite RPC',
            });
        }
        if (redescobertaFalha !== null) {
            log.warn('[UNIVERSO] Redescoberta em paralelo falhou; scanner segue.', {
                erro: redescobertaFalha,
            });
            redescobertaFalha = null;
        }
        // A conclusão ocorre em callback assíncrono. A anotação explícita
        // evita que o fluxo síncrono do TypeScript a estreite para 'never'.
        const novaPronta = redescobertaPronta as
            Awaited<ReturnType<typeof universoPorAtividade>> | null;
        if (novaPronta !== null) {
            const nova = novaPronta;
            redescobertaPronta = null;
            const fimRe = av.etapa('leitura');
            try {
                fimRe();
                if (nova.metodoIndisponivel) {
                    log.warn('[UNIVERSO] Redescoberta NÃO rodou: o nó não tem '
                        + '`eth_getBlockReceipts`.', {
                        oQueIssoNaoE: 'não é "nenhum pool novo": é "não consegui olhar". O '
                            + 'universo continua o de antes, e isso está dito em vez de '
                            + 'publicado como ausência',
                    });
                } else {
                    // Entra no universo V2 efetivo, nao apenas na memoria dos concentrados.
                    // Nao presumimos lucro: o scanner e as provas atomicas continuam
                    // fazendo todas as validacoes economicas antes de qualquer envio.
                    const novosV2 = nova.pools.filter((pool) => !universo.porFabrica.has(pool));
                    for (const pool of novosV2) {
                        const fabrica = nova.porFabrica.get(pool);
                        if (fabrica === undefined) continue;
                        universo.pools.push(pool);
                        universo.porFabrica.set(pool, fabrica);
                    }
                    if (novosV2.length > 0) {
                        log.info('[UNIVERSO/V2] Pools ativos incorporados sem reiniciar.', {
                            novos: novosV2.length, totalV2: universo.pools.length,
                            regra: 'somente fabrica reconhecida; nenhuma ordem sem prova atomica',
                        });
                    }
                    const antesDeRotas = MISTAS.length;
                    const j = juntar(
                        memoria,
                        deDescoberta(nova.concentrados, redeDaCorrente, blocoAnterior ?? 0),
                        { teto: Number(process.env.ARB_MEMORIA_TETO ?? 5_000) },
                    );
                    memoria = j.memoria;
                    if (j.novas.length > 0) {
                        // ROTAS REFEITAS, e SO as afetadas importam: o gerador
                        // de producao roda sobre o universo inteiro, e a
                        // triagem e a cotacao do ciclo seguinte ja leem o
                        // estado NOVO — nenhum preco velho atravessa.
                        MISTAS = candidatasMistas(paraRotas(memoria), WETH_DA_BASE);
                        if(process.env.TITAN_EXPLORAR_TRIANGULOS==='1')
                            triangulosConhecidos=explorarTriangulos(paraRotas(memoria),WETH_DA_BASE,2000);
                        FM.rotasDistintas = MISTAS.length;
                        // eslint-disable-next-line no-await-in-loop
                        await gravarMemoria(caminhoDaMemoria, memoria);
                        log.info('[UNIVERSO] Pool NOVO entrou — rotas refeitas sem reiniciar.', {
                            novos: j.novas.length,
                            jaConhecidosRevistos: j.atualizadas,
                            descartadosPorTeto: j.descartadosPorTeto,
                            rotas: `${antesDeRotas} -> ${MISTAS.length}`,
                            memoria: comoLerAMemoria(memoria),
                        });
                    }
                }
            } catch (e) {
                fimRe({ comoCorreu: 'falhou' });
                log.warn('[UNIVERSO] A redescoberta FALHOU neste ciclo.', {
                    erro: String(e).slice(0, 120),
                    oQueIssoNaoE: 'não é "não há pool novo": é leitura que não voltou. O '
                        + 'universo segue o de antes e a próxima rodada tenta de novo',
                });
            }
        }

        const fimSinal = av.etapa('sinal');
        const blocoAgora = Number(numDe(await chamar('eth_blockNumber', [])) ?? 0n);
        fimSinal(blocoAgora > 0 ? undefined : { comoCorreu: 'falhou' });
        if (blocoAnterior === null || blocoAgora > blocoAnterior) PLACAR.blocos += 1;
        blocoAnterior = blocoAgora;

        // O rebote nao exige ganhar o leilao da LIQUIDACAO: observa, na
        // mesma transacao, swaps ligados a uma LiquidationCall da Aave.
        // Sao recibos CONFIRMADOS e correlacao, nao prova de venda nem lucro.
        // Uma leitura curta por bloco que o scanner efetivamente alcança.
        // Nao bloqueia a leitura de reservas e usa o MESMO limite de RPC.
        if(process.env.TITAN_MONITORAR_REBOTE!=='0'&&blocoAgora>0
            &&blocoAgora>ultimoBlocoReboteSolicitado&&!leituraReboteEmAndamento){
            const blocoDoPedido=blocoAgora;
            ultimoBlocoReboteSolicitado=blocoDoPedido;
            leituraReboteEmAndamento=true;
            void chamar('eth_getBlockReceipts',[`0x${blocoDoPedido.toString(16)}`])
              .then(recibos=>{
                  if(!Array.isArray(recibos)){falhasRebote++;return;}
                  const observacao=detectarRebotesAave(recibos);
                  const morpho=detectarRebotesMorpho(recibos);
                  // Ambos compartilham EXATAMENTE os mesmos recibos. Nenhum
                  // RPC extra e nenhum caminho de envio novo.
                  radarRebote.registrar(blocoDoPedido,{
                      liquidacoes:observacao.liquidacoes+morpho.liquidacoes,
                      transacoesComSwaps:observacao.transacoesComSwaps+morpho.transacoesComSwaps,
                      pools:[...new Set([...observacao.pools,...morpho.pools])],
                  });
                  liquidacoesObservadas+=observacao.liquidacoes;
                  poolsVinculadosRebote+=observacao.pools.length;
                  liquidacoesMorphoObservadas+=morpho.liquidacoes;
                  liquidacoesViaAtlasObservadas+=morpho.liquidacoesViaAtlas;
                  piscinasMorphoAssociadas+=morpho.pools.length;
                  transacoesAtlasObservadas+=morpho.transacoesAtlas;
                  if(morpho.liquidacoes>0){
                      log.info('[TITAN/REBOTE-MORPHO] Liquidacao Morpho confirmada.',{
                          bloco:blocoDoPedido,
                          liquidacoes:morpho.liquidacoes,
                          liquidacoesViaAtlas:morpho.liquidacoesViaAtlas,
                          transacoesAtlas:morpho.transacoesAtlas,
                          swapsNaMesmaTransacao:morpho.transacoesComSwaps,
                          piscinas:morpho.pools,
                          nota:'observacao onchain; swap correlacionado nao comprova lucro',
                      });
                      if(morpho.pools.length>0){
                          eventoTitan('descoberta','Rebote Morpho identificado',
                            morpho.liquidacoes+' liquidacao(oes), '
                            +morpho.pools.length+' pool(s) com Swap na mesma transacao.');
                      }
                  }
                  if(observacao.liquidacoes>0){
                      log.info('[TITAN/REBOTE] Liquidacao Aave confirmada: swaps da MESMA transacao.',{
                          bloco:blocoDoPedido,liquidacoes:observacao.liquidacoes,
                          transacoesComSwap:observacao.transacoesComSwaps,
                          pools:observacao.pools,
                          significado:'pista para cotar apos a liquidacao; nenhuma venda ou lucro presumido',
                      });
                      eventoTitan('descoberta','Liquidacao Aave detectada',
                        observacao.pools.length+' piscina(s) com swap na mesma transacao. '
                        +'Verificando se sobrou diferenca de preco.');
                  }
              })
              .catch(()=>{falhasRebote++;})
              .finally(()=>{leituraReboteEmAndamento=false;});
        }

        const fimLeitura = av.etapa('leitura');
        const { pools, falhas, vazios } = await lerPools(
            chamar, universo.pools, universo.porFabrica, blocoAgora,
        );
        PLACAR.leiturasQueFalharam += falhas;
        PLACAR.poolsVazios = vazios;
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
        const v2Montadas=montarCandidatos(pools);
        const custoComparavel=selecionarRotasComGasComparavel(
            v2Montadas,WETH_DA_BASE,tetoDeRotas);
        const candidatos=custoComparavel.selecionados;
        // The old top-50 was sorted by raw numbers across token decimals.
        // It routinely selected ONLY tokens without any gas conversion.
        // A candidate whose profit unit is unknown must never be "approved".
        if(ciclo===1||ciclo%30===0){
            log.info('[TITAN/GAS-FUNIL] V2 route units verified before profit ranking.',{
                montadas:v2Montadas.length,
                comparaveisEmWeth:custoComparavel.comConversao,
                selecionadas:candidatos.length,
                semPrecoEmWeth:custoComparavel.semConversao,
                razao:'semPrecoEmWeth nao e nenhuma oportunidade; rotas seguem sem custo medido',
            });
        }
        // O BASEFEE PURO, lido UMA vez, e o preco por gas DERIVADO dele.
        //
        // Antes eu lia `precoDoGasWei` (base + gorjeta) e devolvia o baseFee
        // por subtracao — `gasWei - GORJETA_SUPOSTA_WEI`. O auditor apontou que
        // isso e ida-e-volta, nao separacao: `baseFeeDoBlocoWei` ficava sem
        // nenhum chamador de producao, e se a fonte do preco mudar para
        // `eth_gasPrice` (que embute gorjeta do provedor) a subtracao fica
        // negativa e o custo ENCOLHE.
        const baseFeeWei = await baseFeeDoBlocoWei(chamar);
        // A derivacao mora em `porGasWei`, num lugar so. Repeti-la aqui a mao
        // era a mesma regra em dois lugares.
        const gasWei = baseFeeWei === null ? null : porGasWei(baseFeeWei);
        const agora = Date.now();
        if (gasWei === null) {
            log.warn('[ARB] NÃO decido neste ciclo: o baseFee do bloco não veio.', {
                oQueIssoNaoE: 'não é "nenhuma oportunidade": é "não sei o custo". Decidir sem o '
                    + 'preço do gás seria aprovar sem saber o piso',
            });
            fimDecisao({ comoCorreu: 'falhou' });
            continue;
        }
        const decisoes = candidatos.map((c) => decidir(c, gasWei, agora));

        // ROTAS DE 2 A 4 SWAPS, com a classificacao causal ligada. O caminho de
        // duas pernas acima continua porque e ele que esta provado de ponta a
        // ponta em fork na ENTREGA 1; este avalia o resto do espaco, e e o que
        // usa `Exclusoes` no lugar da condenacao por associacao.
        const aN = avaliarRotas(pools, gasWei, exclusoes, {
            maxHops: hopsPedidos,
            teto: tetoDeRotas,
            executor: process.env.ARB_EXECUTOR ?? undefined,
        });
        // AS ROTAS MISTAS, TRIADAS NO ESTADO DESTE BLOCO.
        //
        // Antes isto rodava UMA vez, no ciclo 1, e despejava todas as rotas em
        // NAO_VALIDADA. Ela cortou isso: *"O caçador ao vivo ainda monta rotas
        // mistas e as deixa como NÃO VALIDADAS. Unifique efetivamente a lógica
        // de seleção e os critérios econômicos."* Agora o MESMO filtro que o
        // avaliador em fork usa (`triarCandidatas` -> `semSpreadEmTamanhoNenhum`)
        // roda aqui, a cada estado distinto, e separa DESCARTADA de NAO_VALIDADA
        // com prova valida em todo tamanho.
        //
        // SO AS ROTAS AFETADAS por mudanca de estado, por ordem dela: um pool
        // cujo estado nao mudou nao precisa de leitura nova no mesmo bloco.
        // O GATILHO E A MUDANCA DE ESTADO, nao o numero do bloco.
        //
        // DEFEITO CORRIGIDO: era `blocoAgora !== blocoDaTriagem`, entao o
        // cacador avaliava UMA vez por bloco confirmado e toda mudanca
        // INTRABLOCO — a Base monta o bloco em fatias de ~200ms — era invisivel
        // por construcao. Agora quem decide e a IMPRESSAO do estado dos pools.
        // AMOSTRAS DE `pending` DENTRO DO MESMO CICLO.
        //
        // MEDIDO em 2026-10-15: o ciclo inteiro custa ~3,6s (300 estados em
        // 18,1 min) e o bloco da Base dura ~2s. Entao uma amostra por ciclo NAO
        // consegue ver duas versoes do mesmo bloco — o gatilho por impressao
        // deixou de barrar, e a CADENCIA passou a ser o limite. Amostrar aqui,
        // espacado, e o menor conserto: nao cria laco novo nem bot novo, e cada
        // amostra custa UM multicall.
        const amostras = Math.max(1, Number(process.env.ARB_AMOSTRAS_PENDING ?? 3));
        const espacoMs = Math.max(0, Number(process.env.ARB_ESPACO_AMOSTRA_MS ?? 450));
        for (let amostra = 0; amostra < amostras && MISTAS.length > 0 && blocoAgora > 0;
            amostra += 1) {
            if (amostra > 0) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise<void>((r) => { setTimeout(r, espacoMs); });
            }
            // O bloco pode ter virado entre amostras: quem decide o INTRABLOCO
            // e o bloco DESTA amostra, nao o do comeco do ciclo.
            // eslint-disable-next-line no-await-in-loop
            const blocoDaAmostra = Number(numDe(await chamar('eth_blockNumber', [])) ?? 0n);
            if (blocoDaAmostra === 0) continue;
            // O ESTADO E `pending`, e isso foi PROVADO antes de ser usado
            // (2026-10-15, `mainnet.base.org`): `eth_getBlockByNumber('pending')`
            // devolve o bloco `latest + 1` com 1 a 182 transacoes JA dentro, e a
            // cotacao em `pending` difere da de `latest` (24.534776 contra
            // 24.534699 para 0,01 WETH). E estado pre-confirmado de verdade,
            // nao um molde vazio. `ARB_ETIQUETA=latest` volta ao confirmado.
            const etiqueta: 'latest' | 'pending' = process.env.ARB_ETIQUETA === 'latest'
                ? 'latest' : 'pending';
            const t0 = Date.now();
            const fimTri = av.etapa('prefiltro');
            const L = await lerEstadoMisto(chamar, MISTAS, blocoDaAmostra, etiqueta);
            const tri = triarCandidatas(MISTAS, WETH_DA_BASE, L);
            fimTri();
            // AMOSTRA LIDA sempre; o resto so depois de saber se o estado e
            // novo. Contar triagem de um estado repetido inflaria a amostra.
            FM.amostrasLidas += 1;

            // SO AS ROTAS AFETADAS POR MUDANCA DE ESTADO. Um pool cujo `slot0`
            // ou cujas reservas nao mudaram nao produz rota nova, e recotar o
            // mesmo estado e gastar RPC para repetir a resposta de antes.
            // UMA funcao para os dois lados. Ver `impressaoDosPools`: duas
            // serializacoes escritas a mao divergiram e produziram
            // `ESTADO_INCONSISTENTE` em 5.819 de 5.823 sinais.
            const cru = impressaoDosPools(L);
            // A IMPRESSAO decide se ha o que avaliar. Estado identico ao
            // anterior nao e reavaliado, MESMO no mesmo bloco; e estado
            // diferente E avaliado, mesmo com o bloco confirmado igual.
            //
            // ESTE BLOCO FOI APAGADO POR MIM ao trocar a serializacao a mao
            // pela funcao pura, e o funil denunciou na mesma corrida: "0
            // ESTADO(S) DISTINTO(S)" ao lado de "136 com pool de rota
            // alterado" — dois numeros do mesmo log discordando sobre o mesmo
            // estado. Sem ele nao havia deduplicacao e a corrida gastou 4.598
            // cotacoes em 5 minutos.
            const impressao = impressaoDoEstado(cru);
            const estadoMudou = impressao !== ULTIMA_IMPRESSAO.valor;
            if (!deveProcessarCotacoes(estadoMudou,tri.valem,pendentesCotacao,
                memoriaDeCotacoesNegativas,cru,Date.now())) {
                ULTIMA_IMPRESSAO.repetidas += 1;
                continue;
            }
            if (estadoMudou && blocoDaAmostra === blocoDaTriagem) INTRABLOCO.detectadas += 1;
            ULTIMA_IMPRESSAO.valor = impressao;
            if (estadoMudou) FM.estadosDistintos += 1;
            FM.estadosAvaliados = FM.estadosDistintos;
            FM.rotasTriadas += tri.valem.length;
            FM.faltaDeDados += tri.semDados;
            FM.semProvaMatematica += tri.semProvaDoInvariante;
            FM.faltaDeSpread += tri.recusadasPorSpread.length;
            FUNIL.estados.DESCARTADA += tri.recusadasPorSpread.length;
            const poolsQueMudaram = new Set(ESTADOS_DOS_POOLS.mudaram(cru));
            // Carrega a pequena fila adiada do ciclo anterior: sem isso, uma rota
            // nao selecionada desaparece se os pools nao mudarem novamente.
            const selecionaveisPeloEstado=tri.valem.filter(
                (c) => pendentesCotacao.has(c.chave)
                    || c.pernas.some((p) => poolsQueMudaram.has(p.pool.toLowerCase()))
                    || memoriaDeCotacoesNegativas.venceu(c,cru,Date.now()),
            );
            const afetadasPotenciais=selecionaveisPeloEstado.filter(
                (c)=>memoriaDeCotacoesNegativas.deveCotar(c,cru,Date.now()),
            );
            const repetidasEvitadas=selecionaveisPeloEstado.length-afetadasPotenciais.length;
            const escolha = priorizarCotacoes(
                afetadasPotenciais, tri, tetoCotarRotas, ++rodadaCotacoes,
                process.env.TITAN_ROTACIONAR_COTACOES!=='0',
                ultimaTentativaCotacao,
            );
            const destaqueRebote=radarRebote.ativos(blocoDaAmostra);
            const afetadas=priorizarRebotes(
                escolha.selecionadas,afetadasPotenciais,destaqueRebote,
                Math.max(1,Math.floor(tetoCotarRotas/4)),
            );
            const rotasPromovidas=afetadas.filter(
                r=>!escolha.selecionadas.some(q=>q.chave===r.chave)).length;
            atualizarTitan({
                phase: 'Avaliando rotas em tempo real',
                description: 'O scanner compara precos e custos antes da simulacao completa.',
                block: blocoDaAmostra, quotes: afetadas.length,
                queue: escolha.adiadas, mixed: MISTAS.length,
            });
            const escolhidas = new Set(afetadas.map((c) => c.chave));
            for(const c of afetadas)ultimaTentativaCotacao.set(c.chave,rodadaCotacoes);
            if(ultimaTentativaCotacao.size>10_000){
                const ativas=new Set(MISTAS.map(c=>c.chave));
                for(const k of ultimaTentativaCotacao.keys())if(!ativas.has(k))ultimaTentativaCotacao.delete(k);
            }
            pendentesCotacao.clear();
            for (const c of afetadasPotenciais) {
                if (!escolhidas.has(c.chave)) pendentesCotacao.add(c.chave);
            }

            // EXPLORACAO TRIANGULAR (3 hops). Nao reutiliza a cotacao de 2
            // swaps nem seus tamanhos. Cada plano deriva a capacidade do
            // PROPRIO pool inicial e vai primeiro para o contrato real via
            // eth_call; so uma simulacao economicamente positiva permite
            // chamar o executor de transacao (que valida tudo novamente).
            if(triangulosConhecidos.length>0
                && !trianguloEmCurso
                && process.env.TITAN_EXPLORAR_TRIANGULOS==='1'
                && Date.now()-ultimoTrianguloEm>=75_000) {
                ultimoTrianguloEm=Date.now();
                trianguloEmCurso=true;
                const explorarAmostra=async()=>{
                // Rotacao com limite: nao repetir o mesmo prefixo de 2000
                // caminhos no boot, nem carregar 2000 pools em cada bloco.
                const tamanhoAmostra=Number(process.env.TITAN_TRIANGULOS_POR_RODADA??'4');
                const amostraSegura=Number.isSafeInteger(tamanhoAmostra)
                    ? Math.max(1,Math.min(8,tamanhoAmostra)):4;
                const amostra:TrianguloTitan[]=[];
                for(let k=0;k<Math.min(amostraSegura,triangulosConhecidos.length);k++){
                    amostra.push(triangulosConhecidos[(indiceTriangular+k)%triangulosConhecidos.length]!);
                }
                indiceTriangular=(indiceTriangular+amostra.length)%triangulosConhecidos.length;
                // O leitor de estado recebe so as pernas tipadas. Para os
                // triângulos, sao tres em vez das duas de CandidataMista.
                const lTri=await lerEstadoMisto(chamar,amostra,blocoDaAmostra,etiqueta);
                const avaliadas=amostra.map(t=>({
                    t,veredicto:avaliarTetoTriangulo(t,lTri),
                    liquidez:capacidadePrimeiroPool(t,lTri),
                }));
                triangulosSemSpread+=avaliadas.filter(x=>x.veredicto.estado==='sem-spread').length;
                triangulosComSpread+=avaliadas.filter(x=>x.veredicto.estado==='vale-simular').length;
                let tentativasTriangulares=0;
                for(const item of avaliadas) {
                    if(item.veredicto.estado==='sem-spread')continue;
                    // Nao abre mao de dados completos. A falta de teto
                    // economico manda SIMULAR, mas sem capacidade conhecida
                    // do lender nao inventa tamanho nem dinheiro.
                    const tamanhos=tamanhosTriangulo(item.liquidez);
                    // O deficit pode diminuir em OUTRO tamanho, mas isso
                    // nunca prova lucro. Cada proposta passa no executor real
                    // por eth_call, sem gas on-chain.
                    const sondas=sondasTriangulo(tamanhos,indiceTriangular,3);
                    if(sondas.length===0)continue;
                    let escolhido:{
                        tamanho:bigint;
                        sinal:ReturnType<typeof rotaExecutavelTriangulo> extends infer R
                            ? {rota:R;quantia:bigint;bloco:number;
                                brutoEstimado:bigint;liquidoEstimado:bigint;
                                estadoConsistente:boolean}
                            : never;
                        resultado:Awaited<ReturnType<typeof simularTitanAoVivo>>;
                    }|null=null;
                    const feitos=new Set<string>();
                    const testar=async(tamanho:bigint)=>{
                        if(tamanho<=0n||feitos.has(tamanho.toString()))return null;
                        feitos.add(tamanho.toString());
                        const sinal={
                            rota:rotaExecutavelTriangulo(item.t,tamanho),
                            quantia:tamanho,bloco:blocoDaAmostra,
                            brutoEstimado:0n,liquidoEstimado:0n,estadoConsistente:true
                        };
                        const resultado=await simularTitanAoVivo(sinal,
                            process.env.TITAN_EXECUTOR_RPC_URL??rpc);
                        tentativasTriangulares++;
                        triangulosAtomicos++;
                        return{tamanho,sinal,resultado};
                    };
                    let ultimaSituacao:'executavel'|'inviavel'|'desconhecido'='desconhecido';
                    // Maximo 3 chamadas completas por triangulo nesta rodada.
                    // Repete escalas de liquidez DIFERENTES, sem presumir
                    // monotonicidade da curva entre ticks e DEXs.
                    for(const tamanho of sondas){
                        const tentativa=await testar(tamanho);
                        if(!tentativa)continue;
                        ultimaSituacao=tentativa.resultado.situacao;
                        log.info('[TITAN/SONDA] Variacao de tamanho simulada.',{
                            pools:item.t.pools,
                            tamanho:tamanho.toString(),
                            resultado:tentativa.resultado.situacao,
                            motivo:tentativa.resultado.motivo,
                            blocoDaProva:tentativa.resultado.bloco,
                            erro:tentativa.resultado.erroContrato??null,
                            deficitBps:tentativa.resultado.deficitBps??null,
                            gasGastoOnchain:'zero: eth_call, sem broadcast',
                        });
                        if(tentativa.resultado.situacao==='executavel'){
                            const atual=BigInt(tentativa.resultado.liquidoConservadorWei??'0');
                            const melhor=escolhido===null?-1n:
                                BigInt(escolhido.resultado.liquidoConservadorWei??'0');
                            if(atual>melhor)escolhido=tentativa;
                        }
                    }
                    log.warn('[TITAN/TRIANGULO-ATOMICO] Busca de tamanhos conferida.',{
                        pools:item.t.pools,
                        sondasFeitas:feitos.size,
                        executavel:escolhido!==null,
                        melhorTamanho:escolhido?.tamanho.toString()??null,
                        ultimaSituacao,
                        razao:item.veredicto.estado,
                        triados:triangulosComSpread,semSpread:triangulosSemSpread,
                        simulados:triangulosAtomicos,
                    });
                    if(escolhido===null)continue;
                    const {tamanho,sinal,resultado}=escolhido;
                    if(resultado.situacao!=='executavel')continue;
                    if(process.env.TITAN_ENVIAR!=='1'
                        ||tentativasTitan>=tetoTentativasTitan
                        ||Date.now()-ultimoEnsaioTitanEm<60_000)continue;
                    // Somente lucro verificado no executor, nao suposto
                    // por produto de precos marginais.
                    const bruto=BigInt(resultado.brutoWei??'0');
                    const liquido=BigInt(resultado.liquidoConservadorWei??'0');
                    if(bruto<=0n||liquido<=0n)continue;
                    ultimoEnsaioTitanEm=Date.now();
                    const envio=await executarTitan({...sinal,
                        // The proof ran against latest. Paid execution must
                        // still revalidate state and nonce before broadcast.
                        bloco:resultado.bloco??sinal.bloco,
                        brutoEstimado:bruto,liquidoEstimado:liquido},
                        process.env.TITAN_EXECUTOR_RPC_URL??rpc);
                    if(['enviado','confirmado','revertido','desconhecido']
                        .includes(envio.estado))tentativasTitan++;
                    eventoTitan('envio','Executor triangular: '+envio.estado,
                        envio.hash ? 'Transacao '+envio.hash+'; '+envio.motivo : envio.motivo);
                    log.warn('[TITAN/TRIANGULO-EXECUTOR] Decisao financeira de 3 hops.',{
                        pools:item.t.pools,tamanho:tamanho.toString(),
                        resultado:envio,validacao:resultado,
                        tentativasNestaSessao:tentativasTitan,
                    });
                    // Uma unica candidata com potencial de envio por rodada;
                    // o controle duravel ainda limita 1/dia.
                    break;
                }
                if(tentativasTriangulares===0 && amostra.length>0
                    && FM.estadosAvaliados%30===0) {
                    log.info('[TITAN/TRIANGULOS] Nao houve simulacao nesta amostra.',{
                        analisadas:amostra.length,semSpread:triangulosSemSpread,
                        capacidadeDesconhecida:avaliadas.filter(x=>x.liquidez===null).length,
                    });
                }
                };
                const tarefa=explorarAmostra().finally(()=>{trianguloEmCurso=false;});
                // Observation never holds the live quote loop behind 12 probes.
                // Financial execution retains its original serialized lifecycle.
                if(process.env.TITAN_ENVIAR==='1')await tarefa;
                else void tarefa.catch(e=>{
                    log.warn('[TITAN/TRIANGULOS] Explorar amostra falhou.',{
                        motivo:e instanceof Error?e.message.slice(0,160):'falha de leitura',
                    });
                });
            }

            // A COTACAO: UM LOTE JSON-RPC POR DEGRAU da escada, com as rotas
            // afetadas que ainda interessam naquele degrau — no maximo
            // `ARB_TAMANHOS` idas e voltas, e a rota sem spread com
            // monotonicidade demonstrada sai no primeiro. Nenhum fork, nenhuma
            // implantacao e nenhum `hardhat_reset` no caminho critico — ela
            // cortou os tres por nome.
            let cotadasAgora = 0;
            let brutosPositivos = 0;
            if (afetadas.length > 0) {
                FM.estadosComRotaAfetada += 1;
                const fimCot = av.etapa('cotacao');
                const tc = Date.now();
                const sinais = await cotarAfetadas(
                    chamarEmLote, chamar, afetadas, L, etiqueta, blocoDaAmostra, t0,
                    // O baseFee PURO, como foi lido. A gorjeta entra uma vez,
                    // dentro de `somarCusto`.
                    baseFeeWei,
                    CODIGO_DO_COTADOR,
                );
                LIVRO_DE_SINAIS.registrarCotacao(Date.now() - tc);
                fimCot();
                // A RECONCILIACAO que ela pediu: sinal nao e cotacao. Cada
                // sinal cai em exatamente uma destas caixas, e a contagem roda
                // ANTES da reclassificacao por estado — senao o sinal que vira
                // `ESTADO_*` nao cai em caixa nenhuma e a soma nao fecha.
                for (const sn of sinais) {
                    if (sn.motivo.startsWith('SEM DADO')) FM.sinaisSemTamanho += 1;
                    else if (sn.motivo.startsWith('NÃO COTADO POR INFRAESTRUTURA')) {
                        FM.cotacoesSemInfra += 1;
                    } else if (sn.motivo.startsWith('REVERSÃO OPACA')) FM.cotacoesOpacas += 1;
                    else if (sn.motivo.startsWith('SEM COTAÇÃO')) FM.semCotador += 1;
                    else if (sn.lucroBrutoEstimado !== null) FM.cotacoesLegiveis += 1;
                    else FM.sinaisSemTamanho += 1;
                }
                // O ESTADO AINDA E O MESMO? Releitura dos pools das rotas
                // cotadas. Se mudou, a cotacao combinou leitura de um snapshot
                // com preco de outro, e isso NAO vira lucro: vira
                // ESTADO_INCONSISTENTE.
                const Ldepois = await lerEstadoMisto(chamar, afetadas, blocoDaAmostra, etiqueta);
                const cruDepois = impressaoDosPools(Ldepois);
                for (const sn of sinais) {
                    const rota = afetadas.find((c) => c.chave === sn.rota);
                    if (rota === undefined) continue;
                    const poolsDaRota = rota.pernas.map((p) => p.pool);
                    const v = compararEstados(cru, cruDepois, poolsDaRota);
                    if (v === 'CONSISTENTE') {
                        FM.estadosConsistentes += 1;
                        if(!sn.motivo.startsWith('EXPIRADO')){
                            memoriaDeCotacoesNegativas.registrar(
                                rota,cru,sn.lucroLiquidoEstimado,true,Date.now(),
                            );
                        }
                        continue;
                    }
                    if (v === 'NAO_VALIDADA') {
                        FM.estadoNaoValidado += 1;
                        sn.motivo = 'ESTADO_NAO_VALIDADO: não li algum pool desta rota na '
                            + 'releitura, então não posso afirmar que mudou NEM que ficou igual '
                            + `(era: ${sn.motivo.slice(0, 60)})`;
                        sn.lucroLiquidoEstimado = null;
                        continue;
                    }
                    FM.estadosInconsistentes += 1;
                    sn.motivo = 'ESTADO_INCONSISTENTE: o estado dos pools desta rota MUDOU entre '
                        + 'a leitura e a cotação. Declarar lucro aqui seria somar reserva de um '
                        + `snapshot com preço de outro (era: ${sn.motivo.slice(0, 60)})`;
                    // O numero nao e apagado — ele existiu —, mas deixa de
                    // contar como oportunidade: a conta nao e sobre um estado.
                    sn.lucroLiquidoEstimado = null;
                }
                // O executor nunca deve receber apenas o melhor valor da
                // ESTIMATIVA. Esse foi o funil que gerou falsas oportunidades:
                // 11 de 11 chamadas atomicas recentes eram inviaveis.
                // Explorar os 2 melhores por lucro LIQUIDO estimado, com
                // memoria de recusa e rotas alternativas em lugar de insistir
                // sempre na mesma rota aparentemente positiva.
                const validar = process.env.TITAN_VALIDAR_AO_VIVO === '1';
                const intervaloEnsaio=Math.max(10_000,Math.min(60_000,
                    Number(process.env.TITAN_ATOMICA_INTERVALO_MS??'20000')||20_000));
                const chanceDeNovoEnsaio = Date.now()-ultimoEnsaioAtomicoEm>=intervaloEnsaio;
                if (validar && chanceDeNovoEnsaio) {
                    const candidatos = exploradorTitan.selecionar(
                        sinais,afetadas,
                        limiteAtomicoSeguro(process.env.TITAN_ATOMICA_MAX_CANDIDATAS),
                        Date.now(),true, // read-only probes may quantify previously unknown gas
                    );
                    if(candidatos.length>0) {
                        log.info('[TITAN/ATOMICA/FILA] Candidatos para prova integral onchain sem broadcast.',{
                            elegiveis:candidatos.length,
                            permitiuCustoDesconhecido:true,
                            teto:limiteAtomicoSeguro(process.env.TITAN_ATOMICA_MAX_CANDIDATAS),
                            brutosPositivos:sinais.filter(x=>x.lucroBrutoEstimado!==null&&x.lucroBrutoEstimado>0n).length,
                            custoConhecido:sinais.filter(x=>x.lucroLiquidoEstimado!==null).length,
                            nota:'nenhum sinal autoriza envio sem lucro real positivo medido em eth_call',
                        });
                        ultimoEnsaioAtomicoEm=Date.now();
                        let melhorExecutavel:(typeof candidatos)[number]|null=null;
                        let melhorGanhoReal:bigint=0n;
                        let melhorBrutoReal:bigint=0n;
                        let melhorBlocoDaProva:number|null=null;
                        for(const c of candidatos){
                            const sn=c.sinal;
                            // Simular separadamente cada rota no executor real,
                            // SEM transmitir; o RPC pode recusar a chamada, o
                            // que tambem conta como desconhecido, nao como lucro.
                            const resultado=await simularTitanAoVivo({
                                rota:pernasDaCandidata(c.rota,WETH_DA_BASE,sn.melhorTamanho!),
                                quantia:sn.melhorTamanho!,bloco:blocoDaAmostra,
                                brutoEstimado:sn.lucroBrutoEstimado!,
                                // Only for the READ-ONLY eth_call. The real
                                // profit is independently measured by the
                                // contract and its L1/L2 gas preflight.
                                liquidoEstimado:sn.lucroLiquidoEstimado??0n,
                                estadoConsistente:true,
                            },process.env.TITAN_EXECUTOR_RPC_URL??rpc);
                            exploradorTitan.registrar(sn.rota,resultado.situacao);
                            if(resultado.situacao==='executavel'){
                                atomicasExecutaveis++;
                                const ganho=BigInt(resultado.liquidoConservadorWei??'0');
                                if(ganho>melhorGanhoReal){
                                    melhorGanhoReal=ganho;
                                    melhorBrutoReal=BigInt(resultado.brutoWei??'0');
                                    melhorBlocoDaProva=resultado.bloco;
                                    melhorExecutavel=c;
                                }
                            }else if(resultado.situacao==='inviavel')atomicasInviaveis++;
                            else atomicasDesconhecidas++;
                            log.warn('[TITAN/ATOMICA] Resultado por candidato no executor real.',{
                                rota:sn.rota,bloco:blocoDaAmostra,resultado,
                                indiceCandidato:candidatos.indexOf(c)+1,
                                totalCandidatos:candidatos.length,
                                nota:'simulacao eth_call; nao e lucro realizado',
                                contadores:{executaveis:atomicasExecutaveis,
                                    inviaveis:atomicasInviaveis,
                                    desconhecidas:atomicasDesconhecidas},
                            });
                        }
                        // Transmitir somente um candidato JA executavel no
                        // contrato, e REVALIDAR tudo dentro de executarTitan:
                        // nonce, liquidez, gas, imposto L1, piso e recibo.
                        // Nunca transmite so por spread ou cotacao de quoter.
                        if (process.env.TITAN_ENVIAR === '1' && melhorExecutavel
                            && tentativasTitan<tetoTentativasTitan
                            && Date.now()-ultimoEnsaioTitanEm>=60_000) {
                            ultimoEnsaioTitanEm=Date.now();
                            const sn=melhorExecutavel.sinal;
                            const resultado=await executarTitan({
                                rota:pernasDaCandidata(melhorExecutavel.rota,
                                    WETH_DA_BASE,sn.melhorTamanho!),
                                // Send candidate carries the block of the actual
                                // current-state proof, not stale pool discovery.
                                // The paid path repeats eth_call and price checks.
                                quantia:sn.melhorTamanho!,bloco:melhorBlocoDaProva??blocoDaAmostra,
                                // The only approval comes from the
                                // complete EVM simulation, NOT from the
                                // possibly missing gas-aware quote.
                                brutoEstimado:melhorBrutoReal,
                                liquidoEstimado:melhorGanhoReal,
                                estadoConsistente:true,
                            },process.env.TITAN_EXECUTOR_RPC_URL??rpc);
                            if(['enviado','confirmado','revertido','desconhecido']
                                .includes(resultado.estado))tentativasTitan++;
                            eventoTitan('envio','Executor multi-rota: '+resultado.estado,
                                resultado.hash
                                    ? 'Transacao '+resultado.hash+'; '+resultado.motivo
                                    : resultado.motivo);
                            log.warn('[TITAN/EXECUTOR] So enviou candidata atomica validada.',{
                                bloco:blocoDaAmostra,rota:sn.rota,resultado,
                                candidatosExplorados:candidatos.length,
                                tentativasNestaSessao:tentativasTitan,
                                limite:tetoTentativasTitan,
                            });
                        }
                    }
                } else if (process.env.TITAN_ENVIAR === '1' && !validar) {
                    // Falha fechada: ligar TITAN_ENVIAR sem a certificacao
                    // integral nunca autoriza uma arbitragem.
                    if(Date.now()-ultimoEnsaioTitanEm>=60_000){
                        ultimoEnsaioTitanEm=Date.now();
                        log.error('[TITAN/EXECUTOR] Envio bloqueado: TITAN_VALIDAR_AO_VIVO nao habilitado.');
                    }
                }
                cotadasAgora = sinais.length;
                FM.cotacoesTentadas += sinais.length;
                FM.sinaisCotados += sinais.filter(
                    (sn) => sn.lucroBrutoEstimado !== null,
                ).length;
                for (const sn of sinais) {
                    LIVRO_DE_SINAIS.registrar(sn);
                    if (sn.motivo.startsWith('ESTADO_')) continue;
                    if (sn.lucroBrutoEstimado !== null && sn.lucroBrutoEstimado > 0n) {
                        brutosPositivos += 1;
                        FM.cotacoesComSobra += 1;
                    }
                    if (sn.motivo.startsWith('EXPIRADO')) FM.expirado += 1;
                }
            }
            FUNIL.estados.NAO_VALIDADA += afetadas.length - cotadasAgora;

            log.warn('[ARB-N] rotas MISTAS V3+Aerodrome: estado, triagem e COTAÇÃO AO VIVO.', {
                bloco: blocoDaAmostra,
                amostraDoCiclo: `${amostra + 1} de ${amostras} (espaçadas ${espacoMs}ms: o ciclo `
                    + 'custa ~3,6s e o bloco da Base ~2s, então uma amostra por ciclo não vê '
                    + 'duas versões do mesmo bloco)',
                etiqueta: `${etiqueta} (pré-confirmado: provado com 1–182 txs dentro e cotação `
                    + 'diferente da de `latest`)',
                estadosAvaliados: FM.estadosAvaliados,
                rotasDistintas: MISTAS.length,
                triadasQuePassaram: tri.valem.length,
                afetadasPorMudancaDeEstado: `${afetadasPotenciais.length} de ${tri.valem.length} — as `
                    + 'outras têm os dois pools no MESMO estado já avaliado, e recotar repetiria '
                    + 'a resposta',
                cotacoesExecutadas: cotadasAgora,
                repeticoesNegativasEvitadas: repetidasEvitadas,
                reboteAave:{
                    liquidacoesObservadas,poolsComSwapAssociado:poolsVinculadosRebote,
                    poolsAtivos:destaqueRebote.size,rotasPromovidas,leiturasQueFalharam:falhasRebote,
                    nota:'swaps na mesma tx de liquidacao; spread so existe apos cotacao atual',
                },
                reboteMorpho:{
                    liquidacoesObservadas:liquidacoesMorphoObservadas,
                    liquidacoesViaAtlas:liquidacoesViaAtlasObservadas,
                    transacoesAtlasObservadas,
                    piscinasComSwapNaMesmaTx:piscinasMorphoAssociadas,
                    regra:'somente eventos em recibo confirmado, sem criar cotacao ficticia',
                },
                cotacoesAdiadasPorCapacidade: escolha.adiadas,
                pendentesCotacao: pendentesCotacao.size,
                candidatasSemTentativaDesdeBoot: afetadasPotenciais.filter(
                    c=>!ultimaTentativaCotacao.has(c.chave)).length,
                rotasComTentativaDesdeBoot: ultimaTentativaCotacao.size,
                mudancasIntrabloco: `${INTRABLOCO.detectadas} estado(s) novo(s) detectado(s) com `
                    + 'o MESMO bloco confirmado — é o que o gatilho por número de bloco não via',
                estadosRepetidosIgnorados: `${ULTIMA_IMPRESSAO.repetidas} ciclo(s) com estado `
                    + 'IDÊNTICO não foram reavaliados (recotar repetiria a resposta)',
                estados: `${FM.estadosConsistentes} CONSISTENTE, `
                    + `${FM.estadosInconsistentes} INCONSISTENTE, `
                    + `${FM.estadoNaoValidado} NÃO VALIDADO`,
                sinais: `${FM.sinaisSemTamanho} sem tamanho, ${FM.cotacoesLegiveis} cotação `
                    + `legível, ${FM.cotacoesOpacas} opaca (revert sem seletor), `
                    + `${FM.cotacoesSemInfra} NÃO COTADA POR INFRAESTRUTURA, `
                    + `${FM.semCotador} sem cotador`,
                rpc: TRANSPORTE.comoLerAContabilidade(),
                comSobraBruta: brutosPositivos,
                descartadasComProva: tri.recusadasPorSpread.length,
                semDadoParaDecidir: tri.semDados,
                semProvaDoInvariante: `${tri.semProvaDoInvariante} (pool stable: o teto só está `
                    + 'demonstrado para `x·y = k`, então não descarto — fica NÃO VALIDADA)',
                quoterConferido: `${QUOTER_SERVE.size} pool(s) V3 com a fábrica do QuoterV2 `
                    + 'CONFERIDA; pool de outra fábrica não é cotado por ele',
                latencia: LIVRO_DE_SINAIS.comoLer(),
                limitacao: limitacaoDominante(FM),
            });
            blocoDaTriagem = blocoDaAmostra;
        }
        FUNIL.rotasEncontradas += aN.rotas;
        FUNIL.espacoDeBusca = paresCruzados;
        FUNIL.excluidasComCausa += aN.excluidasComCausa;
        FUNIL.inviavelComTaxa += aN.inviavelComTaxa;
        FUNIL.estimadasPositivas += aN.estimadas.length;
        fimDecisao();

        if (aN.estimadas.length > 0) {
            const melhorN = aN.estimadas.reduce((a, b) => (b.liquido > a.liquido ? b : a));
            log.warn('[ARB-N] ESTIMADA POSITIVA em rota de 2–4 swaps — execução NÃO comprovada.', {
                bloco: blocoAgora,
                rota: comoLerARota(melhorN.rota),
                swaps: melhorN.rota.hops.length,
                quantia: melhorN.quantia.toString(),
                sobra: melhorN.sobra.toString(),
                liquidoDepoisDoGas: melhorN.liquido.toString(),
                taxaMedidaNaConta: melhorN.comTaxa
                    ? 'SIM: alguma perna tem retenção MEDIDA, e ela está descontada no valor '
                        + 'efetivo — a rota não foi descartada por ter taxa, foi avaliada com ela'
                    : 'nenhuma perna tem retenção medida',
                oQueIssoNaoE: 'NÃO é lucro e NÃO é oportunidade validada: só execução integral '
                    + 'bem-sucedida em fork, com lucro líquido positivo, vira '
                    + '`validadasEconomicamente` — e este caminho não executa',
            });
        }
        log.info('[ARB-N] ' + comoLerOFunil('aoVivo'), { exclusoes: exclusoes.comoLer() });

        PLACAR.avaliados += decisoes.length;
        for (const d of decisoes) {
            if (d.aprovado) PLACAR.estimadosPositivos += 1;
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
        if(politicaV2.habilitada && aprovadas.length>0
            &&Date.now()-ultimoEnsaioV2Em>=25_000){
            const agoraV2=Date.now();
            for(const [rota,expira] of bloqueiosV2Ate){
                if(expira<=agoraV2)bloqueiosV2Ate.delete(rota);
            }
            const proximo=selecionarProximaProvaV2(
                aprovadas,ultimaProvaV2,agoraV2,240_000,bloqueiosV2Ate);
            const pendente=proximo.oportunidade;
            if(pendente){
                const k=pendente.candidato.emprestimo.endereco+'>'+
                    pendente.candidato.venda.endereco;
                ultimaProvaV2.set(k,Date.now());
                ultimoEnsaioV2Em=Date.now();
                if(process.env.TITAN_CPAMM_ATOMICO==='1'){
                    const resultado=await avaliarEExecutarCpammMegazord(pendente.candidato,
                        process.env.TITAN_EXECUTOR_RPC_URL??rpc);
                    log.info('[TITAN/CPAMM-MEGAZORD] Prova e emissor unificados.',{rota:k,resultado});
                }else{
                const prova=await provarV2Atomico(pendente.candidato,
                    process.env.TITAN_EXECUTOR_RPC_URL??rpc);
                if(prova.estado==='inviavel'&&reprovacaoDePoolTravadoV2(prova.motivo)){
                    const bloqueadoAte=Date.now()+30*60_000;
                    bloqueiosV2Ate.set(k,bloqueadoAte);
                    log.warn('[TITAN/V2-LOCK] Rota V2 reprovada por lock atomico; teste outra.',{
                        rota:k,bloqueadoAte:new Date(bloqueadoAte).toISOString(),
                        motivo:prova.motivo,
                        nota:'bloqueio temporario so para esta rota; nenhuma transacao paga',
                    });
                }
                eventoTitan('prova',
                    prova.estado === 'executavel-em-override'
                        ? 'Prova V2 passou' : 'Prova V2 recusada',
                    'Rota '+k.slice(0,13)+'…: '+String(prova.motivo??prova.estado).slice(0,130));
                log.warn('[TITAN/V2-PROVA] Flash swap V2 integral sem transacao paga.',{
                    rota:k,tokenEmprestado:pendente.candidato.T,
                    quantidade:pendente.candidato.quantia.toString(),
                    resultado:prova,
                    decisaoFinanceira:prova.estado==='executavel-em-override'
                       ? 'prova virtual passou; executor IMPLANTADO deve revalidar tudo'
                       : 'NAO ENVIAR; sinal teorico nao foi validado',
                });
                if(prova.estado==='executavel-em-override'
                    &&process.env.TITAN_V2_ENVIAR==='1'){
                    const resultadoPago=await executarFlashArbV2(
                        pendente.candidato,process.env.TITAN_EXECUTOR_RPC_URL??rpc);
                    eventoTitan('envio','Executor V2: '+resultadoPago.status,
                        resultadoPago.hash
                            ? 'Transacao '+resultadoPago.hash+'; '+resultadoPago.motivo
                            : resultadoPago.motivo);
                    log.warn('[TITAN/V2-EXECUTOR] Operacao na Base somente apos prova dupla.',{
                        rota:k,resultado:resultadoPago,
                        nota:'somente recibo confirma operacao; gas sempre tem risco residual',
                    });
                }
                }
            }
        }
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
            log.warn('[ARB] ESTIMADO POSITIVO — execução NÃO comprovada.', {
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
                oQueIssoNaoE: 'não é APROVADO e não é ordem. É ESTIMADO POSITIVO: cálculo '
                    + 'econômico favorável, execução NÃO comprovada',
                porqueNaoEAprovado: 'MEDIDO em 2026-10-14: os 3 "aprovados" do bloco 52608948 '
                    + 'foram reproduzidos no fork daquele bloco e os TRÊS reverteram — o token da '
                    + 'rota tem 48% de TAXA DE TRANSFERÊNCIA, então o pagamento do flash swap '
                    + 'chega curto e o pool recusa com UniswapV2: K. Ver '
                    + 'forkTests/osTresCandidatos.js',
                oQueFaltaProvar: 'o único portão confiável é simular a rota INTEIRA por eth_call, '
                    + 'e isso exige o FlashArb implantado. O sinal barato (reserva declarada '
                    + 'contra balanceOf) foi medido e NÃO discrimina: 0,09% no token taxado',
            });
        }

        livro.guardar(av.fechar('ok'));

        atualizarTitan({
            phase: 'Varredura de oportunidades',
            description: 'Analisando pools, validando precos e preparando provas atomicas.',
            block: blocoAgora,cycles: ciclo,
            routes: PLACAR.avaliados,positives:PLACAR.estimadosPositivos,
            pools: pools.length,mixed:MISTAS.length,
        });
        progressoTitan(ciclo,candidatos.length);
        if(ciclo===1||ciclo%4===0){
            eventoTitan('ciclo','Bloco '+blocoAgora+' analisado',
                candidatos.length+' rotas avaliadas neste ciclo; '
                +PLACAR.estimadosPositivos+' sinais teóricos desde o inicio.');
        }
        log.info(`[ARB ${blocoAgora}] ciclo ${ciclo}.`, {
            cobertura: (() => {
                const total = Math.max(1, universo.pools.length);
                // TRES categorias, e a soma fecha: usáveis + vazios + falhas.
                const naoLidos = total - pools.length - vazios;
                const f = (pools.length + vazios) / total;
                return `${pools.length} usável(eis) + ${vazios} com reserva ZERO`
                    + ` + ${naoLidos} NÃO lido(s) = ${total}`
                    + ` | leitura cobriu ${(f * 100).toFixed(1)}%`
                    + (naoLidos > 0
                        ? ' — COBERTURA INCOMPLETA: "nenhuma rota" pode ser leitura que faltou'
                        : ' (pool vazio é RESPOSTA, não buraco)');
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
            + `com motivo. Tentativas de execução nesta sessão: ${tentativasTitan}. `
            + 'Lucro realizado depende de recibo e aumento confirmado no cofre.',
    });
    ouvinte?.fechar();
}

if (require.main === module && process.env.ATIVAR_CACARARBITRAGEM === '1') {
    void iniciarArbitragem().catch((e) => {
        log.error('[ARB] O laço morreu.', { erro: e instanceof Error ? e.message : String(e) });
        process.exitCode = 1;
    });
}

/**
 * O UNIVERSO PELA ATIVIDADE — os pools que de fato NEGOCIAM.
 *
 * DEFEITO MEDIDO em 2026-10-15, e ele e o segundo motivo pelo qual o TITAN
 * nunca capturou nada. `descobrirUniverso` enumera `allPairs[0..N]` de cada
 * fabrica: um PREFIXO POR INDICE DE CRIACAO, que nao tem relacao nenhuma com
 * onde ha liquidez ou volume. A fabrica V2 da Uniswap na Base tem milhares de
 * pares; o TITAN lia os primeiros 100 por ordem de nascimento.
 *
 * A varredura de `src/varrerQuemGanha.ts` mediu 48 arbitragens REAIS e
 * lucrativas em 120 blocos, e TRES dos pools que as alimentaram pertencem a
 * `0x8909…8ec6` — a fabrica V2 da Uniswap, que o TITAN JA varre. Ele tinha a
 * fabrica certa e estava lendo o pedaco errado dela.
 *
 * Aqui o universo nasce do que a corrente mostrou negociando: os pools que
 * emitiram `Swap` nos ultimos blocos. Nao e heuristica de liquidez minha — e a
 * atividade medida, e um pool sem troca nenhuma nao oferece arbitragem.
 *
 * O TRANSPORTE e `eth_getBlockReceipts`, UM pedido por bloco: medido em
 * 2026-10-15, `eth_getLogs` no `mainnet.base.org` devolve `request limit
 * reached` ate com janela de dez blocos, e isso e limite de rajada — nao prova
 * nada sobre frequencia.
 *
 * `fabricasAceitas` decide quem entra. Um pool de fabrica que este contrato nao
 * sabe emprestar NAO e adicionado: ele viraria rota que reverte, e gastar gas
 * para descobrir o que o tipo ja diz e desperdicio.
 */
export async function universoPorAtividade(
    chamar: Transporte,
    opcoes: { blocos?: number; fabricasAceitas?: string[]; tetoDePools?: number } = {},
): Promise<{
    pools: string[];
    porFabrica: Map<string, string>;
    falhas: number;
    blocosLidos: number;
    blocosFalhos: number;
    poolsVistos: number;
    recusadosPorFabrica: number;
    /**
     * Quantos pools de cada venue NEGOCIARAM, antes de qualquer filtro.
     *
     * E o numero que diz onde o dinheiro esta: `avaliarRotas` so sabe emprestar
     * em pool V2, entao os de V3 e Aerodrome ficam como NAO VALIDADOS — com o
     * motivo — em vez de desaparecerem do relatorio como se nao existissem.
     */
    porVenue: { v2: number; v3: number; aerodrome: number };
    /**
     * Os pools de liquidez concentrada com os TOKENS lidos, prontos para
     * `candidatasMistas`.
     *
     * Antes esta funcao devolvia so a CONTAGEM deles, e o cacador publicava
     * "125 NAO VALIDADOS" — que confunde quantidade de pool com quantidade de
     * oportunidade, exatamente o que ela proibiu. Com os tokens, a descoberta
     * de ROTA roda aqui mesmo.
     */
    concentrados: PoolMisto[];
    /**
     * Pools concentrados que NAO responderam `token0`/`token1`.
     *
     * Medido fora do cacador, no MESMO universo: 194 de 194 respondem, 0
     * perdidos, e dao 30 rotas mistas. Se este numero for alto aqui, a perda e
     * do leitor do cacador — nao do mercado e nao do no. Sem o contador, "2
     * rotas" era indistinguivel de "o mercado so tem 2".
     */
    tokensQueFalharam: number;
    tokensPedidos: number;
    /**
     * O no NAO SUPORTA `eth_getBlockReceipts`.
     *
     * MEDIDO em 2026-10-15: o fork do Hardhat responde "Method
     * eth_getBlockReceipts is not supported", e `eth_getLogs` por ele cai no
     * upstream e volta 429. Sem este campo a funcao devolvia ZERO pools, e
     * "0 pools ativos" lido como medicao e ausencia com cara de resposta — o
     * defeito que da nome a este projeto, no codigo que eu acabei de escrever.
     */
    metodoIndisponivel: boolean;
}> {
    const blocos = opcoes.blocos ?? 30;
    const aceitas = new Set(
        (opcoes.fabricasAceitas ?? FABRICAS_COM_FLASH_SWAP).map((x) => x.toLowerCase()),
    );
    const topo = Number(numDe(await chamar('eth_blockNumber', [])) ?? 0n);
    if (topo === 0) {
        return {
            pools: [], porFabrica: new Map(), falhas: 1, blocosLidos: 0,
            blocosFalhos: 0, poolsVistos: 0, recusadosPorFabrica: 0,
            tokensQueFalharam: 0, tokensPedidos: 0,
            metodoIndisponivel: false, porVenue: { v2: 0, v3: 0, aerodrome: 0 },
            concentrados: [],
        };
    }
    // O `topic0` do `Swap` da V2, CALCULADO. Endereco e assinatura de cabeca
    // sao o defeito que a REGRA 0 deste projeto persegue.
    const TOPICO_SWAP_V2 = id('Swap(address,uint256,uint256,uint256,uint256,address)');
    // OS OUTROS DOIS VENUES, pelo `topic0` CALCULADO.
    //
    // MEDIDO em 2026-10-15: das 306 arbitragens reais de ciclo fechado, 99% do
    // lucro passa por liquidez concentrada, e as unicas verificaveis so por log
    // sao V3 + Aerodrome. Varrer so o `Swap` da V2 deixava o universo cego
    // justamente onde o dinheiro esta.
    const TOPICO_SWAP_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)');
    const TOPICO_SWAP_AERO = id('Swap(address,address,uint256,uint256,uint256,uint256)');
    const quantasVezes = new Map<string, number>();
    const tipoVisto = new Map<string, 'v2' | 'v3' | 'aerodrome'>();
    let blocosLidos = 0;
    let blocosFalhos = 0;
    let metodoIndisponivel = false;
    for (let b = topo - blocos + 1; b <= topo; b += 1) {
        if (metodoIndisponivel) break;
        try {
            const r = await chamar('eth_getBlockReceipts', [`0x${b.toString(16)}`]) as
                { logs?: { address: string; topics: string[] }[] }[] | null;
            if (r === null) { blocosFalhos += 1; continue; }
            for (const rec of r) {
                for (const l of rec.logs ?? []) {
                    const t0 = (l.topics[0] ?? '').toLowerCase();
                    const tipo = t0 === TOPICO_SWAP_V2 ? 'v2'
                        : (t0 === TOPICO_SWAP_V3 ? 'v3'
                            : (t0 === TOPICO_SWAP_AERO ? 'aerodrome' : null));
                    if (tipo === null) continue;
                    const k = l.address.toLowerCase();
                    quantasVezes.set(k, (quantasVezes.get(k) ?? 0) + 1);
                    tipoVisto.set(k, tipo);
                }
            }
            blocosLidos += 1;
        } catch (e) {
            blocosFalhos += 1;
            // "nao suportado" nao e falha passageira: nao adianta tentar os
            // outros blocos, e o resultado NAO e uma medicao de zero.
            const m = String(e).toLowerCase();
            if (m.includes('not supported') || m.includes('method not found')) {
                metodoIndisponivel = true;
            }
        }
    }
    if (metodoIndisponivel) {
        return {
            pools: [], porFabrica: new Map(), falhas: 0, blocosLidos,
            blocosFalhos, poolsVistos: 0, recusadosPorFabrica: 0,
            metodoIndisponivel: true, porVenue: { v2: 0, v3: 0, aerodrome: 0 },
            concentrados: [], tokensQueFalharam: 0, tokensPedidos: 0,
        };
    }
    // OS MAIS ATIVOS primeiro: se o teto cortar, corta o que negocia menos.
    const candidatos = [...quantasVezes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([pool]) => pool);
    const porFabrica = new Map<string, string>();
    const pools: string[] = [];
    let recusadosPorFabrica = 0;
    let falhas = 0;
    const teto = opcoes.tetoDePools ?? 300;
    // `factory()` em lote: e ele que diz se o pool e de um tipo que sabemos
    // emprestar. Sem isso o universo entraria com pool de liquidez concentrada,
    // cuja conta nao e esta.
    // OS CONCENTRADOS, com os tokens lidos: e deles que sai a ROTA mista.
    const concentrados: PoolMisto[] = [];
    const deConcentrado = candidatos.filter((x) => {
        const t = tipoVisto.get(x);
        return t === 'v3' || t === 'aerodrome';
    }).slice(0, teto);
    // OS TOKENS EM MULTICALL, e nao uma chamada por pool por token.
    //
    // MEDIDO em 2026-10-15, dentro e fora do cacador, no MESMO universo:
    //
    //   per-call (`lerComPaciencia` por token)  89 de 286 pools lidos
    //   multicall (`lerEmLote`)                194 de 194, e 30 ROTAS mistas
    //
    // Com o caminho per-call a varredura publicava universo cheio e rota vazia:
    // "2 rotas" era limitacao do LEITOR com cara de ausencia de mercado. E nao
    // e o no que recusa — 601 leituras em tres pedacos devolveram 601.
    //
    // Isto NAO amplia o universo: le o MESMO conjunto ja descoberto, em ~3
    // requisicoes em vez de 600. Gasta MENOS RPC, nao mais.
    //
    // `stable()` SO no Aerodrome: no V3 ele nao existe, e pedir leitura que nao
    // pode responder gastaria um terco do orcamento para receber falha.
    const pedidosDeToken: ChamadaMulti[] = [];
    const pedeEstavel = new Map<string, number>();
    const pedeFabrica = new Map<string, number>();
    for (const pool of deConcentrado) {
        pedidosDeToken.push({ alvo: pool, dados: SELETORES.token0 });
        pedidosDeToken.push({ alvo: pool, dados: SELETORES.token1 });
    }
    // FABRICA e FEE dos concentrados: a perna tem de carregar os dois, por
    // ordem dela. E e a FABRICA que diz se o par cruza venue — 131 dos 156
    // pares medidos cruzam, e e dai que vem a rota dos vencedores.
    for (const pool of deConcentrado) {
        if (tipoVisto.get(pool) === 'aerodrome') continue;
        pedeFabrica.set(pool, pedidosDeToken.length);
        pedidosDeToken.push({ alvo: pool, dados: SELETORES.factory });
        pedidosDeToken.push({ alvo: pool, dados: SELETORES.fee });
    }
    for (const pool of deConcentrado) {
        if (tipoVisto.get(pool) !== 'aerodrome') continue;
        pedeEstavel.set(pool, pedidosDeToken.length);
        pedidosDeToken.push({ alvo: pool, dados: SELETORES.estavel });
    }
    const lidosEmLote = pedidosDeToken.length === 0
        ? []
        : await lerEmLote(chamar, pedidosDeToken);
    let tokensQueFalharam = 0;
    for (let i = 0; i < deConcentrado.length; i += 1) {
        const pool = deConcentrado[i]!;
        const r0 = lidosEmLote[i * 2];
        const r1 = lidosEmLote[i * 2 + 1];
        const iEst = pedeEstavel.get(pool);
        const rs = iEst === undefined ? undefined : lidosEmLote[iEst];
        const iFab = pedeFabrica.get(pool);
        const rFab = iFab === undefined ? undefined : lidosEmLote[iFab];
        const rFee = iFab === undefined ? undefined : lidosEmLote[iFab + 1];
        const t0 = r0 !== undefined && r0.ok ? endDe(r0.dados) : null;
        const t1 = r1 !== undefined && r1.ok ? endDe(r1.dados) : null;
        if (t0 === null || t1 === null) { tokensQueFalharam += 1; continue; }
        const ehAero = tipoVisto.get(pool) === 'aerodrome';
        const est = rs !== undefined && rs.ok ? primeiraPalavra(rs.dados) : null;
        concentrados.push({
            endereco: pool,
            token0: t0,
            token1: t1,
            venue: ehAero ? 'aerodrome' : 'v3',
            taxa: (() => {
                const v = rFee !== undefined && rFee.ok ? primeiraPalavra(rFee.dados) : null;
                return v === null || v <= 0n ? null : Number(v);
            })(),
            estavel: ehAero && est !== null ? est !== 0n : null,
            fabrica: rFab !== undefined && rFab.ok ? endDe(rFab.dados) : null,
        });
    }

    // Os V2 nao concorrem por posicao com V3/Aerodrome no corte global.
    // No universo anterior, os concentrados mais ativos podiam consumir
    // candidatos.slice(0, teto*2) antes de verificar um unico V2.
    // E factory() passa pelo mesmo MULTICALL que ja le tokens, sem centenas
    // de eth_call individuais no caminho de descoberta.
    const ativosV2 = candidatos.filter((pool) => tipoVisto.get(pool) === 'v2')
        .slice(0, teto * 2);
    const lidosDaFabrica = await lerEmLote(chamar, ativosV2.map((pool) => ({
        alvo: pool, dados: SELETORES.factory,
    })));
    for (let i = 0; i < ativosV2.length; i += 1) {
        const pool = ativosV2[i]!;
        const resposta = lidosDaFabrica[i];
        if (resposta === undefined || !resposta.ok) { falhas += 1; continue; }
        const fabrica = endDe(resposta.dados);
        if (fabrica === null) { falhas += 1; continue; }
        if (!aceitas.has(fabrica.toLowerCase())) {
            recusadosPorFabrica += 1;
            continue;
        }
        if (pools.length >= teto) break;
        pools.push(pool);
        porFabrica.set(pool, fabrica);
    }
    return {
        pools,
        porFabrica,
        falhas,
        blocosLidos,
        blocosFalhos,
        poolsVistos: quantasVezes.size,
        recusadosPorFabrica,
        metodoIndisponivel: false,
        porVenue: {
            v2: [...tipoVisto.values()].filter((x) => x === 'v2').length,
            v3: [...tipoVisto.values()].filter((x) => x === 'v3').length,
            aerodrome: [...tipoVisto.values()].filter((x) => x === 'aerodrome').length,
        },
        concentrados,
        tokensQueFalharam,
        tokensPedidos: deConcentrado.length,
    };
}
