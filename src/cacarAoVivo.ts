// Arquivo: src/cacarAoVivo.ts
import { Decimal } from 'decimal.js';
import { Wallet, JsonRpcProvider } from 'ethers';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import { REDES, RPCS_PARA_TENTAR, SELETOR_GET_RESERVES_LIST, decodificarListaDeEnderecos, faixasDeBlocos, TOPIC_LIQUIDATION_CALL, decodificarLiquidacao } from './liquidacoes';
import { emDolar, lucroEstimado, ondeEuEstava, montarPlacar, oQueIssoQuerDizer, type Perdida } from './perdidas';
import { posturaPorMargem, ritmoDaPostura, dormirDeOlho, DESVIO_TIPICO_PCT, type Postura } from './adiantar';
import { SELETOR_BASEFEE, LIMITE_DE_GAS, gorjetaPorGas, tetoPorGas, lerBasefee, fracaoAdaptativa, sobraDepoisDaGorjeta, TETO_DA_FRACAO } from './prontidao';
import { lerRecibo, placarVazio, contarTiro, comoEstaIndo } from './tiros';
import { wsDoHttp, esperarBlocoOuTempo, OuvinteDeBlocos } from './gatilhoDeBloco';
import { SELETOR_SYMBOL, lerSymbol, simboloDaBinance, cotacoesDaBinance, quedaDoMercado } from './precoDeMercado';
import { abrirConexoes, buscar, CONEXOES_POR_SERVIDOR } from './conexoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from './posicoes';
import { CHAMADAS_POR_MULTICALL, MULTICALL3, codificarAggregate3, decodificarAggregate3, decodificarAggregate3Rapido, partirEmPedacos } from './multicall';
import { codificarUserReserveData, decodificarUserReserveData, COBRIR_O_MAXIMO, ehLimiteDoProvedor } from './liquidar';
import { enderecoDaResposta, escolherParPorValor, type SaldoNaMoeda } from './reservas';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL, isDevedorIgnorado, julgarCofre, podeCacarComDinheiroReal, SELETOR_COFRE, SELETOR_DONO, COFRE_ESPERADO } from './caca';
import { POOLS } from './contratos';

/**
 * Quanto pedir emprestado, em unidades cruas.
 *
 * `COBRIR_O_MAXIMO` ia direto para `flashLoanSimple` como o TAMANHO do
 * emprestimo. Valor "maximo" ali nao significa "o quanto der": significa pedir
 * 1e44 unidades emprestadas, e nenhum pool do mundo tem isso. Toda caçada real
 * reverteria, sempre — e os ensaios nunca denunciaram porque batiam na recusa
 * da Aave (posicao saudavel) antes de chegar ao emprestimo.
 *
 * A Aave so deixa cobrir metade da divida enquanto a saude esta entre 0,95 e 1.
 * Pedir mais que isso e emprestar dinheiro que sera devolvido sem uso, pagando
 * premio a toa; pedir menos e deixar agio na mesa.
 */
export const FATIA_COBRIVEL = 2n;
export function quantoPedirEmprestado(dividaCrua: bigint): bigint {
    return dividaCrua / FATIA_COBRIVEL;
}

/**
 * Quanto o preco caiu, em porcento, desde a ultima varredura completa.
 *
 * O ponto de comparacao e a varredura, nao o bloco anterior. Comparar com o
 * bloco anterior parece certo e nao e: uma queda de 0,02% por bloco repetida
 * vinte vezes e 0,4% de queda que nunca dispara nada, porque cada bloco
 * isolado ficou abaixo do gatilho. A fragilidade que estamos comparando foi
 * medida na varredura; a queda tem que ser contada do mesmo instante.
 *
 * So queda conta. Preco subindo nao derruba ninguem que esteja de pe.
 */
export function maiorQuedaDesdeABase(base: Map<string, Decimal>, agora: Map<string, Decimal>): Decimal {
    let maior = new Decimal(0);
    for (const [moeda, precoAgora] of agora) {
        const precoBase = base.get(moeda);
        if (!precoBase || precoBase.lessThanOrEqualTo(0)) continue;
        const queda = precoBase.minus(precoAgora).dividedBy(precoBase).mul(100);
        if (queda.greaterThan(maior)) maior = queda;
    }
    return maior;
}

/** Uma posicao medida: quem e, e a que distancia de ser liquidada. */
export interface Medida { devedor: string; queda: Decimal }

/** As tres camadas, e a regua do gatilho que separa a primeira da segunda. */
export interface Camadas {
    brasa: string[];
    quentes: string[];
    margemDaBrasa: Decimal;
    /** A menor distancia ate liquidar de TODAS: quem cai primeiro no mundo. */
    menorMargem: Decimal | null;
}

/**
 * Reparte os devedores em brasa / quentes / resto, por fragilidade.
 *
 * A brasa sao os mais frageis de todos, e ela existe por uma medicao: a
 * posicao mais fragil da conta estava a 0,037% de cair. Preco de cripto anda
 * 0,037% o tempo todo, entao um gatilho armado nesse valor dispara em quase
 * todo ciclo — e reler 1.166 posicoes em todo ciclo custa 42M CUs/mes, o dobro
 * do teto da conta.
 *
 * A saida nao e ler menos: e ler de graca. Um multicall cabe 250 chamadas e o
 * ciclo usa 16 (o bloco e os 15 precos). As outras 234 vagas iam vazias no
 * mesmo `eth_call`, que custa 26 CUs cheio ou vazio. A brasa viaja nelas.
 *
 * A regua do gatilho passa a ser a margem do PRIMEIRO que ficou de fora da
 * brasa: todos os mais frageis que ele ja estao sendo lidos a cada ciclo, e
 * nao precisam de gatilho nenhum.
 *
 * A ordenacao e explicita e por queda. Fatiar uma lista que veio ordenada por
 * outra coisa — ordem de descoberta, atividade — e o defeito que este projeto
 * ja encontrou umas quinze vezes: vira uma amostra com cara de ranking.
 */
export function repartirPorFragilidade(
    medidos: Medida[],
    vagasNaBrasa: number,
    margemQuente: number,
): Camadas {
    const ordenados = [...medidos].sort((a, b) => a.queda.comparedTo(b.queda));
    const brasa = ordenados.slice(0, Math.max(0, vagasNaBrasa));
    const resto = ordenados.slice(brasa.length);
    const quentes = resto.filter((m) => m.queda.lessThanOrEqualTo(margemQuente));
    // Se a brasa cobre todo mundo que esta dentro da margem, nao ha ninguem
    // entre uma camada e outra: o proximo alvo do gatilho e a propria margem.
    const margemDaBrasa = resto.length > 0 ? resto[0].queda : new Decimal(margemQuente);
    return {
        brasa: brasa.map((m) => m.devedor),
        quentes: quentes.map((m) => m.devedor),
        margemDaBrasa,
        menorMargem: ordenados.length > 0 ? ordenados[0].queda : null,
    };
}

export type Varredura = 'nenhuma' | 'quentes' | 'completa';

/**
 * Qual varredura este ciclo merece.
 *
 * A ordem importa, e o caso do meio e o que fecha o buraco: quem esta longe de
 * cair NAO esta na lista quente, entao uma queda grande o bastante para
 * alcancar os de fora tem que forcar a varredura completa. Sem isso um tombo
 * de 30% no mercado seria respondido lendo so os que ja estavam por um fio.
 */
export function qualVarredura(
    maiorQueda: Decimal,
    menorQueda: Decimal,
    margemQuente: number,
    msDesdeACompleta: number,
    msEntreCompletas: number,
): Varredura {
    if (msDesdeACompleta >= msEntreCompletas) return 'completa';
    if (maiorQueda.greaterThanOrEqualTo(margemQuente)) return 'completa';
    if (maiorQueda.greaterThanOrEqualTo(menorQueda)) return 'quentes';
    return 'nenhuma';
}

/**
 * Quanto custa um mes deste desenho, em Unidades de Computacao da Alchemy.
 *
 * Existe porque "acho que cabe" ja nos custou dois dias de orcamento. O teto
 * e um numero; o gasto tem que ser um numero tambem, conferivel por teste.
 */
export const CU_POR_CHAMADA = 26;
export function custoMensalEmCUs(entrada: {
    intervaloMs: number;
    devedores: number;
    quentes: number;
    chamadasPorMulticall: number;
    minutosEntreCompletas: number;
    fracaoQueDisparaQuentes: number;
}): number {
    const ciclosNoMes = (30 * 24 * 60 * 60 * 1000) / entrada.intervaloMs;
    const multicalls = (n: number) => Math.ceil(n / entrada.chamadasPorMulticall);
    // O ciclo e UM `eth_call`: bloco, precos e a brasa cabem todos nele. Um
    // multicall custa o mesmo cheio ou vazio.
    const ciclo = ciclosNoMes * CU_POR_CHAMADA;
    const completas = ((30 * 24 * 60) / entrada.minutosEntreCompletas) * multicalls(entrada.devedores) * CU_POR_CHAMADA;
    const quentes = ciclosNoMes * entrada.fracaoQueDisparaQuentes * multicalls(entrada.quentes) * CU_POR_CHAMADA;
    return Math.round(ciclo + completas + quentes);
}
const log = createLogger('caca');

const SELETOR_DECIMALS = '0x313ce567';
const SELETOR_ADDRESSES_PROVIDER = '0x0542975c';
const SELETOR_GET_POOL_DATA_PROVIDER = '0xe860accb';
const SELETOR_GET_PRICE_ORACLE = '0xfca513a8';
const SELETOR_GET_ASSET_PRICE = '0xb3596f07';
/** Multicall3.getBlockNumber() — vem de carona no mesmo eth_call dos preços. */
const SELETOR_BLOCO_DO_MULTICALL = '0x42cbb15c';

const REDE_ESCOLHIDA = (process.env.CACA_REDE ?? 'base').toLowerCase();
const REDE = REDES[REDE_ESCOLHIDA] ?? REDES.base;
const ENVIAR = process.env.CACA_ENVIAR === '1';
const BLOCOS = Number(process.env.CACA_BLOCOS ?? '1296000');
const PEDACO = Number(process.env.CACA_PEDACO ?? '2000');
const MIN_COLETA = Number(process.env.CACA_MIN_COLETA ?? '37');
const TIMEOUT_MS = Number(process.env.CACA_TIMEOUT_MS ?? '20000');
const PAUSA_MS = Number(process.env.CACA_PAUSA_MS ?? '600');
const MAX_POR_ALVO = Number(process.env.CACA_MAX_POR_ALVO ?? '3');
const MAX_ENVIOS = Number(process.env.CACA_MAX_ENVIOS ?? '25');

// Configuração dos dois contratos em paralelo
const CONTRATOS_ATIVOS = [
    { nome: 'V1 (WETH)', endereco: '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78', tipo: 'V1' as const },
    { nome: 'V2 (Multi-Ativo)', endereco: process.env.CACA_CONTRATO ?? '0xd87AeEcCb5969BA28C49581736cD2c0b58B117A8', tipo: 'V2' as const }
];

let rpc = process.env.CACA_RPC_URL ?? REDE.rpc;
let rpcId = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Gerenciador de Nonce Atômico para evitar conflitos em alta velocidade
class LocalNonceManager {
    private currentNonce: number | null = null;
    private provider: JsonRpcProvider;
    private address: string;

    constructor(provider: JsonRpcProvider, address: string) {
        this.provider = provider;
        this.address = address;
    }

    public async sync(): Promise<number> {
        const networkNonce = await this.provider.getTransactionCount(this.address, "pending");
        if (this.currentNonce === null || networkNonce > this.currentNonce) {
            this.currentNonce = networkNonce;
        }
        return this.currentNonce;
    }

    public async getNextNonce(): Promise<number> {
        if (this.currentNonce === null) {
            await this.sync();
        } else {
            this.currentNonce++;
        }
        return this.currentNonce!;
    }

    public rollback() {
        if (this.currentNonce !== null && this.currentNonce > 0) {
            this.currentNonce--;
        }
    }
}

async function umaChamada<T>(metodo: string, params: unknown[]): Promise<T> {
    const res = await buscar(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: metodo, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = (await res.json()) as { result?: T; error?: { message?: string } };
    if (corpo.error) throw new Error(corpo.error.message ?? 'erro sem mensagem');
    return corpo.result as T;
}

async function chamar<T>(metodo: string, params: unknown[], tentativas = 4): Promise<T> {
    let espera = 1000;
    for (let i = 0; ; i += 1) {
        try {
            return await umaChamada<T>(metodo, params);
        } catch (e) {
            const msg = (e as Error).message;
            if (i >= tentativas - 1 || !ehLimiteDoProvedor(msg)) throw e;
            log.warn('O provedor pediu calma; esperando.', { erro: msg, esperandoMs: espera });
            await dormir(espera);
            espera *= 2;
        }
    }
}

async function chamarCru(
    params: unknown[],
): Promise<{ ok: true; dados: string } | { ok: false; mensagem: string; dados?: string }> {
    const res = await buscar(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = (await res.json()) as { result?: string; error?: { message?: string; data?: string } };
    if (corpo.error) {
        return { ok: false, mensagem: corpo.error.message ?? 'erro sem mensagem', dados: corpo.error.data };
    }
    return { ok: true, dados: corpo.result ?? '0x' };
}

async function chamarCruComPaciencia(
    params: unknown[],
    tentativas = 4,
): Promise<{ ok: true; dados: string } | { ok: false; mensagem: string; dados?: string }> {
    let espera = 1000;
    for (let i = 0; ; i += 1) {
        const r = await chamarCru(params);
        if (r.ok || r.dados || i >= tentativas - 1 || !ehLimiteDoProvedor(r.mensagem)) return r;
        log.warn('O provedor pediu calma no meio da caçada; esperando.', { esperandoMs: espera });
        await dormir(espera);
        espera *= 2;
    }
}

/** Quantos multicalls voam juntos. O mesmo numero que a varredura ja usa. */
// Igual ao tamanho do pool, e nao menos. Com 5 aqui e 12 conexoes abertas, o
// bot estrangulava a si mesmo: a medicao deu 5.840ms de rede somados dentro de
// 1.225ms de rede real — 4,8x de paralelismo, exatamente o 5 daqui.
const MULTICALLS_EM_PARALELO = Number(process.env.CACA_PARALELO ?? String(CONEXOES_POR_SERVIDOR));

/**
 * De quanto em quanto tempo o bot acorda.
 *
 * O orçamento manda aqui. O teto da conta e de 20M CUs/mes, o que da 15,4 CUs
 * por bloco da Base — menos que UM `eth_call`, que custa 26. Acordar todo
 * bloco e impossivel por definicao, nao por desempenho.
 *
 * A 8 segundos sao 324 mil ciclos no mes: 8,4M CUs so de preco, e o resto
 * cabe. O preco disso e ate 8 segundos de atraso para ver alguem cair — o que
 * nao muda a chance real de ganhar. Quem leva 3.166 das 5.043 liquidacoes da
 * Base nao e batido por milissegundos; o que sobra para os pequenos e a
 * liquidacao grande que os grandes nao conseguem vender.
 */
const INTERVALO_MS = Number(process.env.CACA_INTERVALO_MS ?? '8000');

/**
 * De quanto o mercado precisa se afastar para o feed Chainlink escrever.
 *
 * Varia por feed e pode mudar sem aviso. Errar para MENOS faz acordar cedo
 * (gasta um pouco de CU); errar para MAIS faz perder a janela inteira.
 */
const DESVIO_DE_ESCRITA = new Decimal(process.env.CACA_DESVIO_FEED ?? DESVIO_TIPICO_PCT.toString());

/**
 * De quanto em quanto tempo o bot olha o MERCADO enquanto dorme.
 *
 * Nao e o mesmo que o ciclo. Ler a blockchain e caro e precisa ser raro; olhar
 * o preco nao passa pela blockchain e custa zero — entao nao ha razao para as
 * duas frequencias serem iguais. Eram, e isso anulava boa parte da vantagem:
 * dormindo 8 segundos, o preco podia cair, o feed escrever e a liquidacao
 * sumir antes do bot piscar.
 *
 * 1 segundo deixa o peso na API publica da Binance folgado.
 */
const OLHAR_MERCADO_MS = Number(process.env.CACA_OLHAR_MERCADO_MS ?? '1000');

/** De quanto em quanto tempo TODAS as posicoes sao relidas, custe o que custar. */
const MINUTOS_ENTRE_COMPLETAS = Number(process.env.CACA_MINUTOS_COMPLETA ?? '60');

/**
 * De quanto em quanto tempo o sinal de vida aparece no log.
 *
 * Era `blocoAtual % 150 === 0`, escrito quando o laco acordava a cada bloco.
 * Com o laco no relogio de 8s o bot so ve 1 bloco a cada 4, e mdc(4,150) = 2:
 * ele enxerga blocos de uma paridade so. Caindo na paridade errada, NENHUM
 * bloco visto seria multiplo de 150 e o sinal de vida sumiria para sempre, sem
 * erro nenhum — e um log mudo e indistinguivel de um bot morto.
 *
 * Relogio nao tem paridade.
 */
const MS_ENTRE_SINAIS_DE_VIDA = Number(process.env.CACA_MS_SINAL ?? '300000');

/**
 * Quem esta a menos disso de ser liquidado entra na lista quente.
 *
 * A varredura completa le 8.368 posicoes (34 multicalls, 884 CUs). A lista
 * quente le algumas centenas (2 a 4 multicalls). A esmagadora maioria dos
 * devedores dos ultimos 30 dias esta longe demais para cair na proxima hora.
 */
const MARGEM_QUENTE = Number(process.env.CACA_MARGEM_QUENTE ?? '25');

/**
 * Le tudo em multicalls, varios ao mesmo tempo.
 *
 * Eram 17 chamadas em fila, uma esperando a outra, e isso custava 1,4 segundo
 * por bloco — 70% de um bloco da Base, que dura 2 segundos. Sobrava pouco para
 * decidir e quase nada para enviar, e numa liquidacao quem chega depois nao
 * chega.
 *
 * A ORDEM importa e por isso nao e um `Promise.all` solto: quem chama indexa o
 * resultado por posicao (os precos primeiro, os devedores depois), e embaralhar
 * faria o bot ler a saude de uma pessoa achando que e de outra. Entao os
 * pedacos vao em ondas, e cada onda devolve seus resultados no lugar certo.
 */
/** O ultimo relogio da varredura, para o log do bloco dizer onde o tempo foi. */
export let ultimaMedicao = { total: 0, msRede: 0, msDecode: 0, pedacos: 0 };

async function lerEmLote(chamadas: Array<{ alvo: string; dados: string }>): Promise<Array<string | null>> {
    const pedacos = partirEmPedacos(chamadas, CHAMADAS_POR_MULTICALL);
    const porPedaco: Array<Array<string | null>> = new Array(pedacos.length);
    // Dois relogios separados. O pool de conexoes nao mudou nada (3.440ms ->
    // 3.415ms), e "nao mudou nada" e uma pista: se o tempo fosse de rede,
    // doze conexoes teriam mudado. Medir REDE e DECODIFICACAO em separado
    // responde de uma vez, em vez de eu chutar um terceiro conserto.
    let msRede = 0;
    let msDecode = 0;
    const inicioTotal = Date.now();

    for (let i = 0; i < pedacos.length; i += MULTICALLS_EM_PARALELO) {
        const onda = pedacos.slice(i, i + MULTICALLS_EM_PARALELO);
        await Promise.all(
            onda.map(async (pedaco, j) => {
                const posicao = i + j;
                const t0 = Date.now();
                try {
                    const bruto = await chamar<string>('eth_call', [
                        { to: MULTICALL3, data: codificarAggregate3(pedaco) },
                        'latest',
                    ]);
                    msRede += Date.now() - t0;
                    const t1 = Date.now();
                    const rs = decodificarAggregate3Rapido(bruto);
                    porPedaco[posicao] = pedaco.map((_, k) => (rs[k]?.ok ? rs[k].dados : null));
                    msDecode += Date.now() - t1;
                } catch (e) {
                    // Um pedaco que falha vira buracos, nao uma lista curta:
                    // lista curta desalinharia todas as posicoes seguintes.
                    //
                    // E precisa GRITAR. Sao ate 250 posicoes que somem de uma
                    // vez, e sumir em silencio significa nao ver quem caiu
                    // enquanto o log mostra uma varredura completa.
                    porPedaco[posicao] = pedaco.map(() => null);
                    log.warn('Um pedaço da varredura não foi lido.', {
                        posicoesPerdidas: pedaco.length,
                        de: chamadas.length,
                        erro: (e as Error).message.slice(0, 120),
                        consequencia: 'quem estiver nessas posições não é visto neste bloco',
                    });
                }
            }),
        );
    }

    const total = Date.now() - inicioTotal;
    // Somados dao mais que o total quando as chamadas correm juntas — e isso
    // mesmo e a resposta: se `msRede` somar muito acima do total, a rede esta
    // paralela e o gargalo e outro.
    ultimaMedicao = { total, msRede, msDecode, pedacos: pedacos.length };
    return porPedaco.flat();
}

async function juntarDevedores(topo: number, blocoInicial?: number): Promise<string[]> {
    const vistos = new Set<string>();
    const inicio = blocoInicial !== undefined ? Math.max(0, blocoInicial) : Math.max(0, topo - BLOCOS + 1);
    const faixas = faixasDeBlocos(inicio, topo, PEDACO);
    let falhas = 0;
    const CONCORRENCIA = 5; 

    if (faixas.length > 10) {
        const lotes = Math.ceil(faixas.length / CONCORRENCIA);
        const minutos = ((lotes * (PAUSA_MS + 700)) / 60_000).toFixed(1);
        log.info('Juntando histórico de devedores (Modo Turbo - Multithread).', {
            faixas: faixas.length,
            estimativa: `~${minutos} minutos`,
            velocidade: `${CONCORRENCIA} chamadas em paralelo`
        });
    }

    let lidas = 0;
    for (let i = 0; i < faixas.length; i += CONCORRENCIA) {
        const lote = faixas.slice(i, i + CONCORRENCIA);
        
        await Promise.all(lote.map(async ([a, b]) => {
            try {
                const logs = await chamar<Array<{ topics: string[] }>>('eth_getLogs', [
                    {
                        address: REDE.pool,
                        fromBlock: `0x${a.toString(16)}`,
                        toBlock: `0x${b.toString(16)}`,
                        topics: [TOPIC_BORROW],
                    },
                ]);
                for (const d of devedoresDosEventos(logs)) vistos.add(d);
            } catch {
                falhas += 1;
            }
        }));
        
        lidas += lote.length;
        if (faixas.length > 10 && (lidas % (CONCORRENCIA * 5) === 0 || lidas === faixas.length)) {
            log.info('Progresso da varredura acelerada.', {
                lidas: `${lidas} de ${faixas.length}`,
                devedoresAteAgora: vistos.size
            });
        }
        if (i + CONCORRENCIA < faixas.length) {
            await dormir(PAUSA_MS);
        }
    }
    return [...vistos];
}

interface Alvo {
    devedor: string;
    quedaPct: Decimal | null;
    garantia: string;
    divida: string;
    garantiaUsd?: Decimal;
    dividaUsd?: Decimal;
    /**
     * A divida em unidades cruas da moeda. Sem ela nao da para pedir um
     * emprestimo de tamanho real — e era isso que estava quebrado.
     */
    dividaCrua?: bigint;
}

async function montarAlvos(
    devedores: string[],
    moedas: string[],
    dataProvider: string,
    precos: Map<string, Decimal>,
    casas: Map<string, number>,
): Promise<Alvo[]> {
    const chamadas = devedores.flatMap((d) =>
        moedas.map((m) => ({ alvo: dataProvider, dados: codificarUserReserveData(m, d) })),
    );
    const rs = await lerEmLote(chamadas);

    const valorDe = (ativo: string, cru: Decimal): Decimal | null => {
        const preco = precos.get(ativo.toLowerCase());
        const dec = casas.get(ativo.toLowerCase());
        if (preco === undefined || dec === undefined) return null;
        return cru.dividedBy(new Decimal(10).pow(dec)).mul(preco).dividedBy(1e8);
    };

    const fora: Alvo[] = [];
    for (let i = 0; i < devedores.length; i += 1) {
        const saldos: SaldoNaMoeda[] = [];
        for (let j = 0; j < moedas.length; j += 1) {
            const bruto = rs[i * moedas.length + j];
            if (!bruto) continue;
            try {
                const d = decodificarUserReserveData(bruto);
                saldos.push({
                    ativo: moedas[j],
                    garantiaCrua: d.usadaComoGarantia ? new Decimal(d.garantiaCrua.toString()) : new Decimal(0),
                    dividaCrua: new Decimal(d.dividaCrua.toString()),
                });
            } catch { }
        }
        const par = escolherParPorValor(saldos, valorDe);
        const cruDaDivida = par
            ? saldos.find((x) => x.ativo.toLowerCase() === par.divida.toLowerCase())?.dividaCrua
            : undefined;
        if (par) {
            fora.push({
                devedor: devedores[i],
                quedaPct: null,
                garantia: par.garantia,
                divida: par.divida,
                dividaCrua: cruDaDivida ? BigInt(cruDaDivida.toFixed(0)) : undefined,
                garantiaUsd: par.garantiaUsd,
                dividaUsd: par.dividaUsd,
            });
        }
    }
    return fora;
}

async function principal(): Promise<'parar' | void> {
    const poolDeVendaV1 = (process.env.CACA_POOL ?? POOLS.aerodrome.endereco).toLowerCase();

    log.info(ENVIAR ? '*** MODO ENVIO (MEV ELITE + GUERRA DE GÁS) — GASTO REAL. ***' : '*** MODO MEDIÇÃO (MEV ELITE + GUERRA DE GÁS) — NENHUM GÁS GASTO. ***');
    // Sem isto o `Promise.all` e decorativo: o fetch do Node enfileira tudo
    // numa conexao so, e o log diz "paralelo" enquanto a rede faz fila.
    abrirConexoes();
    log.info('Injeção Dinâmica de Bribe Ativada. Bot configurado para atropelar concorrência.', {
        conexoesSimultaneas: CONEXOES_POR_SERVIDOR,
        rede: REDE.nome,
        contratoV1: CONTRATOS_ATIVOS[0].endereco,
        contratoV2: CONTRATOS_ATIVOS[1].endereco
    });

    let carteira: Wallet | null = null;
    let donoCarteira: string | null = null;
    let nonceManager: LocalNonceManager | null = null;

    if (ENVIAR) {
        const chave = process.env.CACA_CHAVE_PRIVADA;
        if (!chave) {
            log.error('Falta a chave privada.', {});
            return 'parar';
        }
        const provider = new JsonRpcProvider(rpc);
        carteira = new Wallet(chave, provider);
        donoCarteira = carteira.address;
        nonceManager = new LocalNonceManager(provider, donoCarteira);
        await nonceManager.sync();
        log.info('Carteira carregada com Nonce Manager atômico.', { endereco: donoCarteira });
    }

    const rpcs = process.env.CACA_RPC_URL ? [process.env.CACA_RPC_URL] : (RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [REDE.rpc]);
    let topo = 0;
    for (const c of rpcs) {
        try {
            rpc = c;
            topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
            break;
        } catch { /* próximo */ }
    }
    if (!topo) return;

    let dataProvider: string | null = null;
    let oraculo: string | null = null;
    try {
        const prov = enderecoDaResposta(
            await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_ADDRESSES_PROVIDER }, 'latest']),
        );
        if (prov) {
            dataProvider = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_POOL_DATA_PROVIDER }, 'latest']),
            );
            oraculo = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_PRICE_ORACLE }, 'latest']),
            );
        }
    } catch (e) {
        log.error('Falha ao descobrir contratos base.', { erro: (e as Error).message });
    }
    
    if (!dataProvider || !oraculo) return 'parar';

    // ---- Conferir o cofre de cada caçador, antes de qualquer caçada. ----
    //
    // Conferir isso na mão, uma vez, numa tela, não é conferir: é lembrar.
    // O contrato 0xd87AeE… rodou dias mandando lucro para o dono — a carteira
    // quente cuja chave mora no Railway — e ninguém viu, porque ele nunca
    // ganhou nada. Aqui acontece sozinho, todo boot, para todo contrato.
    const contratos: typeof CONTRATOS_ATIVOS = [];
    for (const c of CONTRATOS_ATIVOS) {
        let cofre: string | null = null;
        let dono: string | null = null;
        try {
            cofre = enderecoDaResposta(await chamar<string>('eth_call', [{ to: c.endereco, data: SELETOR_COFRE }, 'latest']));
            dono = enderecoDaResposta(await chamar<string>('eth_call', [{ to: c.endereco, data: SELETOR_DONO }, 'latest']));
        } catch (e) {
            log.warn(`Não consegui ler o cofre de ${c.nome}.`, { erro: (e as Error).message });
        }
        const laudo = julgarCofre({ cofre, dono });
        const linha = { contrato: c.nome, endereco: c.endereco, cofre: cofre ?? '—', dono: dono ?? '—', porque: laudo.porque };
        if (podeCacarComDinheiroReal(laudo)) {
            log.info(`[COFRE OK] ${c.nome} paga no cofre certo.`, linha);
            contratos.push(c);
        } else if (ENVIAR) {
            log.error(`[COFRE ${laudo.veredicto.toUpperCase()}] ${c.nome} NÃO vai caçar com dinheiro real.`, linha);
        } else {
            // Sem ENVIAR nada é gasto, então medir um contrato suspeito é útil
            // — desde que o log diga, em toda ronda, que ele não pagaria certo.
            log.warn(`[COFRE ${laudo.veredicto.toUpperCase()}] ${c.nome} entra só para medição.`, linha);
            contratos.push(c);
        }
    }
    if (contratos.length === 0) {
        log.error('Nenhum caçador passou na conferência do cofre. Não vou caçar no escuro.', { cofreEsperado: COFRE_ESPERADO });
        return 'parar';
    }

    const moedas = decodificarListaDeEnderecos(
        await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_GET_RESERVES_LIST }, 'latest']),
    );

    const casas = new Map<string, number>();
    // Qual par da Binance cada moeda segue. O simbolo vem da propria
    // blockchain: lista de enderecos decorada envelhece em silencio.
    const parPorToken = new Map<string, string>();
    try {
        const respSym = await lerEmLote(moedas.map((m) => ({ alvo: m, dados: SELETOR_SYMBOL })));
        for (let i = 0; i < moedas.length; i++) {
            const sim = respSym[i] ? lerSymbol(respSym[i]!) : null;
            const par = sim ? simboloDaBinance(sim) : null;
            if (par) parPorToken.set(moedas[i].toLowerCase(), par);
        }
    } catch (e) {
        log.warn('Não consegui ler os símbolos das moedas; sigo sem preço de mercado.', { erro: (e as Error).message });
    }
    const paresDaBinance = [...new Set(parPorToken.values())];
    log.info('Olho no mercado, fora da blockchain (custo zero em CU).', {
        pares: paresDaBinance,
        moedasAcompanhadas: parPorToken.size,
        deMoedas: moedas.length,
        limiarDoFeed: `${DESVIO_DE_ESCRITA.toFixed(2)}%`,
    });

    const respDec = await lerEmLote(moedas.map((m) => ({ alvo: m, dados: SELETOR_DECIMALS })));
    moedas.forEach((m, i) => {
        if (respDec[i]) {
            try { casas.set(m.toLowerCase(), Number(BigInt(respDec[i]!))); } catch {}
        }
    });
    /** O preco mais recente de cada moeda, usado para valorar a garantia. */
    const precos = new Map<string, Decimal>();
    /** O preco de cada moeda na ultima varredura completa: a regua do gatilho. */
    const precosDaBase = new Map<string, Decimal>();
    /** Quando a ultima varredura completa aconteceu, em relogio e nao em bloco. */
    let ultimoCompleto = 0;
    /** Os que estao perto de cair: a lista que o gatilho de preco relê. */
    let quentes: string[] = [];
    /** Os mais frageis de todos: viajam de graca no multicall dos precos. */
    let brasa: string[] = [];
    /** A margem do primeiro que ficou de fora da brasa: a regua do gatilho. */
    let margemDaBrasa = new Decimal(0);
    let ultimoSinalDeVida = 0;
    /** Ate onde ja se contou quem foi liquidado sem a gente. */
    let ultimoBlocoPerdidas = topo;
    /**
     * O acumulado desde que o bot subiu.
     *
     * Sem isto cada hora reporta zero e some, e "zero nesta hora" nao ensina
     * nada: a taxa historica e de ~1,17 liquidacoes por hora, entao uma hora
     * em branco tem 30% de chance de acontecer sozinha. O que responde a
     * pergunta e o acumulado — quantas passaram em seis horas, em um dia — e
     * essa conta se perde se cada linha so olhar para a propria janela.
     */
    const desdeOBoot = {
        emMs: Date.now(),
        blocos: 0,
        aconteceram: 0,
        valiamAPena: 0,
        lucro: new Decimal(0),
        porCobertura: { brasa: 0, quente: 0, 'na lista': 0, 'nem sabia': 0 } as Record<string, number>,
    };
    /**
     * O preco do ETH em dolar, do oraculo. E a unica unidade em que o lucro de
     * uma divida em USDC e o de uma em WETH sao comparaveis.
     */
    function precoDoEth(): Decimal | null {
        for (const [token, par] of parPorToken) {
            if (par !== 'ETHUSDT') continue;
            const p = precos.get(token);
            if (p && p.greaterThan(0)) return p.dividedBy(1e8);
        }
        return null;
    }

    /** A menor margem de todas, da ultima varredura: quem cai primeiro. */
    let menorMargem: Decimal | null = null;
    let postura: Postura = 'dormindo';
    /** O preco base do bloco, de carona no ciclo. Evita uma ida a rede na hora. */
    let baseFeeAtual: bigint | null = null;
    /**
     * O que o mercado respondeu da ultima vez. `null` quer dizer que a Binance
     * nao respondeu — e isso precisa APARECER.
     *
     * Sem este estado o recurso inteiro morre em silencio: `cotacoesDaBinance`
     * devolve mapa vazio quando falha, o laco nao faz nada com mapa vazio, e o
     * bot volta ao ritmo fixo parecendo saudavel. Um log que nunca diz
     * "[POSTURA]" fica igual a um mercado calmo, e sao coisas opostas.
     */
    let quedaDoMercadoAgora: Decimal | null = null;
    /** Acessores: o TypeScript nao enxerga atribuicao feita dentro de closure. */
    const mercadoAgora = (): Decimal | null => quedaDoMercadoAgora;
    const posturaAgora = (): Postura => postura;
    let avisouMercadoMudo = false;
    /** O que aconteceu com cada tiro depois de sair. */
    let tiros = placarVazio();
    /**
     * Quantas vezes seguidas o bot perdeu a corrida.
     *
     * Numa disputa em que todos chegam no mesmo bloco, quem ganha nao e o mais
     * rapido: e quem paga mais. Perder seguidas vezes e a informacao de que o
     * lance esta baixo, e a resposta certa e subir — nao reescrever o bot.
     */
    let perdasSeguidas = 0;
    const fracaoBase = Number(process.env.CACA_FRACAO_GORJETA ?? '0.4');

    // Ser AVISADO do bloco novo em vez de perguntar. Perguntar a cada 200ms
    // significa que um bloco nascido logo depois da pergunta so e visto na
    // seguinte — e nessa corrida isso e a diferenca entre entrar no bloco N+1
    // e no N+2. Se a conexao nao abrir ou cair, o bot volta a perguntar.
    const urlDeBlocos = wsDoHttp(rpc);
    const ouvinte = urlDeBlocos
        ? new OuvinteDeBlocos(urlDeBlocos, (aviso) => log.warn(`[BLOCOS] ${aviso}`))
        : null;
    ouvinte?.abrir();
    log.info('Aviso de bloco novo por WebSocket.', {
        ligado: ouvinte !== null,
        porQue: ouvinte === null ? 'não consegui derivar o endereço wss do RPC; sigo perguntando' : 'reajo quando o bloco nasce, não quando eu pergunto',
    });
    let posturaAnterior: Postura = 'dormindo';
    /** As vagas que sobram no multicall do ciclo depois do bloco e dos precos. */
    const vagasNaBrasa = Math.max(0, CHAMADAS_POR_MULTICALL - moedas.length - 2);

    let devedores = await juntarDevedores(topo);
    devedores = devedores.filter(d => !isDevedorIgnorado(d));

    let ultimaColeta = Date.now();
    let ultimoBlocoLido = topo; 
    let ultimoBlocoColeta = topo;
    const falhasPorAlvo = new Map<string, number>();
    let enviados = 0;

    log.info('Operação Elite Iniciada. Patrulhando blocos com suborno dinâmico ligado.', { alvosRegistados: devedores.length });

    /**
     * Quem foi liquidado desde a ultima contagem — e se a gente estava olhando.
     *
     * `alvosCaidos: 0` nao distingue "nao teve liquidacao" de "teve varias e
     * voce nao viu". As duas dao zero, e o conserto de cada uma e oposto: uma
     * pede paciencia, a outra pede mudar o desenho. Um `eth_getLogs` por hora
     * (75 CUs, 0,2% do orcamento) separa as duas.
     */
    async function contarAsQuePassaram(ate: number): Promise<void> {
        if (ate <= ultimoBlocoPerdidas) return;
        const de = ultimoBlocoPerdidas + 1;
        let logs: Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }>;
        try {
            logs = await chamar('eth_getLogs', [{
                address: REDE.pool,
                fromBlock: `0x${de.toString(16)}`,
                toBlock: `0x${ate.toString(16)}`,
                topics: [TOPIC_LIQUIDATION_CALL],
            }]);
        } catch (e) {
            // Falhar aqui nao pode parar a cacada: isto e placar, nao motor.
            log.warn('Não consegui contar as liquidações que passaram.', { erro: (e as Error).message });
            return;
        }
        ultimoBlocoPerdidas = ate;

        const naBrasa = new Set(brasa.map((d) => d.toLowerCase()));
        const naQuente = new Set(quentes.map((d) => d.toLowerCase()));
        const naLista = new Set(devedores.map((d) => d.toLowerCase()));

        const perdidas: Perdida[] = [];
        for (const cru of logs) {
            try {
                const l = decodificarLiquidacao(cru);
                const dividaUsd = emDolar(
                    l.dividaCrua,
                    casas.get(l.ativoDaDivida.toLowerCase()),
                    precos.get(l.ativoDaDivida.toLowerCase()),
                );
                perdidas.push({
                    devedor: l.devedor,
                    bloco: l.bloco,
                    liquidante: l.liquidante,
                    dividaUsd,
                    lucroUsd: dividaUsd === null ? null : lucroEstimado(dividaUsd),
                    cobertura: ondeEuEstava(l.devedor, naBrasa, naQuente, naLista),
                });
            } catch { /* log estranho nao derruba o placar */ }
        }

        const placar = montarPlacar(perdidas);
        desdeOBoot.blocos += ate - de + 1;
        desdeOBoot.aconteceram += placar.total;
        desdeOBoot.valiamAPena += placar.valiam.length;
        desdeOBoot.lucro = desdeOBoot.lucro.plus(placar.somaDoLucroPerdido);
        for (const [balde, n] of Object.entries(placar.porCobertura)) desdeOBoot.porCobertura[balde] += n;

        const horas = (Date.now() - desdeOBoot.emMs) / 3_600_000;
        log.info('[PLACAR] Liquidações que aconteceram sem mim.', {
            janela: `blocos ${de}–${ate}`,
            aconteceram: placar.total,
            valiamAPena: placar.valiam.length,
            // O acumulado e o que responde a pergunta. Uma hora em branco tem
            // 30% de chance sozinha; seis horas em branco ja dizem outra coisa.
            desdeOBoot: {
                horas: horas.toFixed(1),
                aconteceram: desdeOBoot.aconteceram,
                porHora: horas > 0 ? (desdeOBoot.aconteceram / horas).toFixed(2) : '—',
                valiamAPena: desdeOBoot.valiamAPena,
                lucroQuePassou: `US$ ${desdeOBoot.lucro.toFixed(2)}`,
                ondeEuEstava: desdeOBoot.porCobertura,
            },
            oQueIssoQuerDizer: oQueIssoQuerDizer(placar),
            asTresMaiores: placar.valiam.slice(0, 3).map((x) => ({
                divida: x.dividaUsd === null ? 'sem cotação' : `US$ ${x.dividaUsd.toFixed(0)}`,
                lucro: `US$ ${x.lucroUsd!.toFixed(2)}`,
                euEstava: x.cobertura,
                levouQuem: x.liquidante,
            })),
        });
    }

    /**
     * Olha o mercado e atualiza a postura. Devolve `true` se ficou mais
     * urgente que estava — que e quando vale acordar antes da hora.
     */
    async function olharMercado(): Promise<boolean> {
        if (paresDaBinance.length === 0) return false;
        const doMercado = await cotacoesDaBinance(paresDaBinance);
        if (doMercado.size === 0) {
            quedaDoMercadoAgora = null;
            if (!avisouMercadoMudo) {
                avisouMercadoMudo = true;
                log.warn('MERCADO MUDO: a Binance não respondeu. Volto ao ritmo fixo e perco a vantagem de antecipar.', {
                    pares: paresDaBinance,
                    oQueIssoCusta: 'sem isto o bot só descobre quem caiu depois que o oráculo escreve',
                });
            }
            return false;
        }
        if (avisouMercadoMudo) {
            avisouMercadoMudo = false;
            log.info('Mercado voltou a responder.');
        }
        const doOraculo = new Map<string, Decimal>();
        for (const [token, par] of parPorToken) {
            const p = precos.get(token);
            if (p && !doOraculo.has(par)) doOraculo.set(par, p.dividedBy(1e8));
        }
        const queda = quedaDoMercado(doMercado, doOraculo);
        quedaDoMercadoAgora = queda;
        const nova = posturaPorMargem(queda, menorMargem, DESVIO_DE_ESCRITA);
        const ficouUrgente = ritmoDaPostura(nova, INTERVALO_MS) < ritmoDaPostura(postura, INTERVALO_MS);
        postura = nova;
        if (postura !== posturaAnterior) {
            log.info(`[POSTURA] ${posturaAnterior} → ${postura}`, {
                mercadoCaiu: `${queda.toFixed(4)}%`,
                feedEscreveEm: `${DESVIO_DE_ESCRITA.toFixed(2)}%`,
                maisFragilA: menorMargem === null ? '—' : `${menorMargem.toFixed(4)}%`,
                proximaLeituraEm: `${ritmoDaPostura(postura, INTERVALO_MS)}ms`,
            });
            posturaAnterior = postura;
        }
        return ficouUrgente;
    }

    for (;;) {
        const inicioDoCiclo = Date.now();
        try {
            if (Date.now() - ultimaColeta > MIN_COLETA * 60_000) {
                const novoTopo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
                if (novoTopo > ultimoBlocoColeta) {
                    const novos = await juntarDevedores(novoTopo, ultimoBlocoColeta + 1);
                    const setDevedores = new Set([...devedores, ...novos]);
                    devedores = [...setDevedores].filter(d => !isDevedorIgnorado(d));
                    ultimoBlocoColeta = novoTopo;
                }
                ultimaColeta = Date.now();
            }

            // UM eth_call por ciclo: o numero do bloco (de carona, no proprio
            // Multicall3) e os 15 precos. 26 CUs. A varredura completa custa
            // 884 e o orcamento do mes da 15,4 por bloco — por isso ela so
            // acontece quando ha motivo, e nao a cada bloco.
            const chamadasDoCiclo = [
                { alvo: MULTICALL3, dados: SELETOR_BLOCO_DO_MULTICALL },
                // De graca no mesmo eth_call: evita um getFeeData justamente no
                // instante em que centenas de milissegundos custam a liquidacao.
                { alvo: MULTICALL3, dados: SELETOR_BASEFEE },
                ...moedas.map((m) => ({
                    alvo: oraculo!,
                    dados: SELETOR_GET_ASSET_PRICE + m.replace(/^0x/, '').padStart(64, '0'),
                })),
                ...brasa.map((d) => ({
                    alvo: REDE.pool,
                    dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
                })),
            ];
            const resp = await lerEmLote(chamadasDoCiclo);

            let blocoAtual = ultimoBlocoLido;
            try { if (resp[0]) blocoAtual = Number(BigInt(resp[0]!)); } catch {}
            ultimoBlocoLido = blocoAtual;
            baseFeeAtual = lerBasefee(resp[1]) ?? baseFeeAtual;

            for (let i = 0; i < moedas.length; i++) {
                const bruto = resp[i + 2];
                if (!bruto) continue;
                try {
                    precos.set(moedas[i].toLowerCase(), new Decimal(BigInt(bruto).toString()));
                } catch {}
            }

            // A brasa e conferida em TODO ciclo, sem gatilho nenhum: ela veio
            // nas vagas que sobravam do mesmo `eth_call`.
            const caidos: string[] = [];
            const inicioDaBrasa = moedas.length + 2;
            for (let i = 0; i < brasa.length; i++) {
                const dadoConta = resp[inicioDaBrasa + i];
                if (!dadoConta) continue;
                try {
                    const queda = quedaAteLiquidar(decodificarContaDoUsuario(dadoConta).saude);
                    if (queda !== null && queda.isZero()) caidos.push(brasa[i]);
                } catch {}
            }

            const maiorQueda = maiorQuedaDesdeABase(precosDaBase, precos);
            const varredura = qualVarredura(
                maiorQueda,
                margemDaBrasa,
                MARGEM_QUENTE,
                Date.now() - ultimoCompleto,
                MINUTOS_ENTRE_COMPLETAS * 60_000,
            );

            if (varredura === 'nenhuma') {
                if (Date.now() - ultimoSinalDeVida >= MS_ENTRE_SINAIS_DE_VIDA) {
                    ultimoSinalDeVida = Date.now();
                    log.info(`[BLOCO ${blocoAtual}] Só a brasa — ninguém mais pode ter caído.`, {
                        naBrasa: brasa.length,
                        // Sem isto, "mercado calmo" e "Binance morta" dao o
                        // mesmo log — e sao coisas opostas.
                        tiros: comoEstaIndo(tiros),
                        avisoDeBloco: ouvinte === null ? 'desligado' : (ouvinte.vivo ? `ligado (último ${ouvinte.ultimoBloco})` : 'CAIU — perguntando'),
                        mercado: mercadoAgora() === null
                            ? 'SEM COTAÇÃO — ritmo fixo'
                            : `${mercadoAgora()!.toFixed(4)}% abaixo do oráculo (${posturaAgora()})`,
                        oraculoJaCaiuPct: `${maiorQueda.toFixed(4)}%`,
                        gatilhoEm: `${margemDaBrasa.toFixed(4)}%`,
                        naListaQuente: quentes.length,
                        custou: `${Date.now() - inicioDoCiclo}ms`,
                    });
                }
            } else {
                const aLer = varredura === 'completa' ? devedores : quentes;
                if (aLer.length > 0) {
                    const loteGigante = await lerEmLote(aLer.map((d) => ({
                        alvo: REDE.pool,
                        dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
                    })));

                    const medidos: Medida[] = [];
                    for (let i = 0; i < aLer.length; i++) {
                        const dadoConta = loteGigante[i];
                        if (!dadoConta) continue;
                        try {
                            const queda = quedaAteLiquidar(decodificarContaDoUsuario(dadoConta).saude);
                            if (queda === null) continue;
                            if (queda.isZero()) { if (!caidos.includes(aLer[i])) caidos.push(aLer[i]); }
                            else medidos.push({ devedor: aLer[i], queda });
                        } catch {}
                    }

                    // A base dos precos anda junto com a leitura: a fragilidade
                    // que acabou de ser medida vale a partir dos precos de
                    // agora. Sem isso o gatilho fica preso e dispara para
                    // sempre — defeito que ja apareceu aqui uma vez.
                    precosDaBase.clear();
                    for (const [moeda, preco] of precos) precosDaBase.set(moeda, preco);

                    // So a varredura COMPLETA pode refazer as camadas: ela e a
                    // unica que olhou todo mundo. Uma varredura quente que
                    // reescrevesse as listas com o que ela mesma viu iria
                    // encolhendo a cada passagem ate sobrar ninguem, e o bot
                    // ficaria cego sem avisar.
                    if (varredura === 'completa') {
                        const camadas = repartirPorFragilidade(medidos, vagasNaBrasa, MARGEM_QUENTE);
                        brasa = camadas.brasa;
                        quentes = camadas.quentes;
                        margemDaBrasa = camadas.margemDaBrasa;
                        menorMargem = camadas.menorMargem;
                        ultimoCompleto = Date.now();
                        await contarAsQuePassaram(blocoAtual);
                        log.info(`[BLOCO ${blocoAtual}] Varredura completa.`, {
                            alvosChecados: aLer.length,
                            naBrasa: brasa.length,
                            naListaQuente: quentes.length,
                            gatilhoEm: `${margemDaBrasa.toFixed(4)}%`,
                            tempoDeResposta: `${Date.now() - inicioDoCiclo}ms`,
                            ondeFoiOTempo:
                                `rede ${ultimaMedicao.msRede}ms somados / decodificação ${ultimaMedicao.msDecode}ms ` +
                                `em ${ultimaMedicao.pedacos} multicalls`,
                            alvosCaidos: caidos.length,
                        });
                    } else {
                        log.info(`[BLOCO ${blocoAtual}] Preço mexeu — reli a lista quente.`, {
                            quedaPct: `${maiorQueda.toFixed(4)}%`,
                            alvosChecados: aLer.length,
                            tempoDeResposta: `${Date.now() - inicioDoCiclo}ms`,
                            alvosCaidos: caidos.length,
                        });
                    }
                }
            }

            if (caidos.length === 0) continue;

            const alvos = await montarAlvos(caidos, moedas, dataProvider, precos, casas);

            for (const alvo of alvos) {
                for (const contrato of contratos) {
                    const dados = contrato.tipo === 'V1'
                        ? codificarCacaV1({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: quantoPedirEmprestado(alvo.dividaCrua!),
                            poolDeVenda: poolDeVendaV1,
                            lucroMinimo: PISO_IMPOSSIVEL,
                          })
                        : codificarCacaV2({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: quantoPedirEmprestado(alvo.dividaCrua!),
                            isStablePool: false,
                            lucroMinimo: PISO_IMPOSSIVEL,
                          });
                
                    const r = await chamarCruComPaciencia([{ from: donoCarteira ?? undefined, to: contrato.endereco, data: dados }, 'latest']);
                    const leitura = lerRespostaDaCaca({
                        ok: r.ok,
                        dados: r.dados ?? '0x',
                        mensagem: 'mensagem' in r ? r.mensagem : undefined
                    });

                    log.info(`[ALERTA] Simulação executada para alvo caído (${contrato.nome}).`, {
                        bloco: blocoAtual,
                        devedor: alvo.devedor,
                        desfecho: leitura.desfecho,
                        lucroCru: leitura.lucroCru?.toString() ?? '-',
                    });

                    if (!ENVIAR || !carteira || !carteira.provider || !nonceManager) continue;
                    if (leitura.desfecho !== 'mediu' || leitura.lucroCru === undefined || leitura.lucroCru === null || leitura.lucroCru === 0n) continue;

                    const lucroCruValido = leitura.lucroCru;
                    const chaveAlvo = `${alvo.devedor}-${contrato.tipo}`;
                    const jaFalhou = falhasPorAlvo.get(chaveAlvo) ?? 0;
                    if (jaFalhou >= MAX_POR_ALVO) continue;
                    if (enviados >= MAX_ENVIOS) continue;

                    const piso = (lucroCruValido * 80n) / 100n;
                    
                    const envio = contrato.tipo === 'V1'
                        ? codificarCacaV1({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: quantoPedirEmprestado(alvo.dividaCrua!),
                            poolDeVenda: poolDeVendaV1,
                            lucroMinimo: piso,
                          })
                        : codificarCacaV2({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: quantoPedirEmprestado(alvo.dividaCrua!),
                            isStablePool: false,
                            lucroMinimo: piso,
                          });
                
                    // Nada de `estimateGas` nem `getFeeData` aqui. As duas sao
                    // idas a rede no unico instante em que centenas de
                    // milissegundos custam a liquidacao — e nenhuma e
                    // necessaria: gas nao usado volta, e o preco base ja veio
                    // de carona no multicall do ciclo.
                    const limiteGas = LIMITE_DE_GAS;
                    const lucroUsd = emDolar(
                        lucroCruValido,
                        casas.get(alvo.divida.toLowerCase()),
                        precos.get(alvo.divida.toLowerCase()),
                    );
                    const fracao = fracaoAdaptativa({ base: fracaoBase, perdasSeguidas });
                    const prioridadePorGas = gorjetaPorGas({
                        lucroUsd: lucroUsd ?? new Decimal(0),
                        precoDoEthUsd: precoDoEth() ?? new Decimal(0),
                        limiteGas,
                        fracaoDoLucro: fracao,
                    });
                    const maxFee = tetoPorGas(baseFeeAtual ?? 20_000_000n, prioridadePorGas);

                    const nonceAtual = await nonceManager.getNextNonce();
                    const msDoTiro = Date.now() - inicioDoCiclo;
                    enviados += 1;

                    try {
                        const tx = await carteira.sendTransaction({ 
                            to: contrato.endereco, 
                            data: envio,
                            nonce: nonceAtual,
                            gasLimit: limiteGas,
                            maxPriorityFeePerGas: prioridadePorGas,
                            maxFeePerGas: maxFee
                        });
                        
                        falhasPorAlvo.set(chaveAlvo, jaFalhou + 1);
                        
                        log.info(`[TIRO SAIU] (${contrato.nome}) — ainda NÃO é acerto.`, {
                            bloco: blocoAtual,
                            devedor: alvo.devedor, 
                            hash: tx.hash,
                            gorjetaOfertadaGwei: (Number(prioridadePorGas) / 1e9).toFixed(3),
                            lucroEstimadoUsd: lucroUsd === null ? 'sem cotação' : `US$ ${lucroUsd.toFixed(2)}`,
                            doCicloAoTiro: `${msDoTiro}ms`,
                            lance: `${(fracao * 100).toFixed(0)}% do lucro (${perdasSeguidas} derrotas seguidas)`,
                            sobrariaParaMim: lucroUsd === null ? 'sem cotação' : `US$ ${sobraDepoisDaGorjeta(lucroUsd, fracao).toFixed(2)}`,
                            verNaBlockchain: `https://basescan.org/tx/${tx.hash}`,
                        });

                        // Acompanhar ate o fim, SEM travar a cacada. Numa
                        // corrida o desfecho mais provavel e reverter: outro
                        // chegou antes e a posicao ja nao esta liquidavel
                        // quando a nossa entra. Sem olhar o recibo, acerto e
                        // erro dao exatamente o mesmo log.
                        const hashDoTiro = tx.hash;
                        const devedorDoTiro = alvo.devedor;
                        const lucroDoTiro = lucroUsd;
                        void (async () => {
                            let desfecho: ReturnType<typeof lerRecibo>;
                            try {
                                desfecho = lerRecibo(await tx.wait(1, 120_000));
                            } catch {
                                desfecho = 'sumiu';
                            }
                            tiros = contarTiro(tiros, desfecho, lucroDoTiro);
                            // Perder sobe o lance; ganhar devolve ele para a
                            // base. Assim o bot nao paga caro para sempre por
                            // uma sequencia ruim que ja passou.
                            perdasSeguidas = desfecho === 'acertou' ? 0 : perdasSeguidas + 1;
                            const dados = {
                                devedor: devedorDoTiro,
                                hash: hashDoTiro,
                                lucro: lucroDoTiro === null ? 'sem cotação' : `US$ ${lucroDoTiro.toFixed(2)}`,
                                placar: comoEstaIndo(tiros),
                                verNaBlockchain: `https://basescan.org/tx/${hashDoTiro}`,
                            };
                            if (desfecho === 'acertou') {
                                log.info('*** ACERTOU! O dinheiro foi para o cofre. ***', {
                                    ...dados,
                                    cofre: `https://basescan.org/address/${COFRE_ESPERADO}`,
                                });
                            } else if (desfecho === 'reverteu') {
                                log.warn('[ERROU] A transação reverteu — quase sempre porque outro liquidou antes.', {
                                    ...dados,
                                    proximoLance: `${(fracaoAdaptativa({ base: fracaoBase, perdasSeguidas }) * 100).toFixed(0)}% do lucro`,
                                    oQueIssoQuerDizer: perdasSeguidas >= 3
                                        ? 'perdendo seguidas vezes: ou o lance ainda está baixo, ou o outro entra no bloco ANTES (aí é outro desenho)'
                                        : 'subo o lance no próximo',
                                });
                            } else {
                                log.warn('[SUMIU] A transação não foi minerada em 2 minutos.', dados);
                            }
                        })();
                    } catch (e) {
                        nonceManager.rollback();
                        falhasPorAlvo.set(chaveAlvo, jaFalhou + 1);
                        log.warn(`Falha ao disparar tiro de elite (${contrato.nome}).`, { erro: String(e) });
                    }
                }
            }
        } catch (err) {
            log.warn('Tropeço rápido na rede, reiniciando milissegundo seguinte.', { erro: err instanceof Error ? err.message : String(err) });
        } finally {
            // Ler a blockchain e caro e precisa ser raro. Olhar o mercado
            // custa zero. Por isso as duas frequencias sao separadas: o ciclo
            // dorme o que a postura mandar, mas de olho aberto — e se o
            // mercado ficar urgente no meio do sono, acorda na hora.
            await olharMercado();
            const ritmo = ritmoDaPostura(posturaAgora(), INTERVALO_MS);
            const resta = ritmo - (Date.now() - inicioDoCiclo);
            if (resta > 0) {
                if (posturaAgora() === 'dedo no gatilho' && ouvinte?.vivo) {
                    // Com o dedo no gatilho, quem acorda o bot e o BLOCO, nao o
                    // relogio: o aviso chega no instante em que ele nasce. O
                    // tempo maximo existe para nunca ficar preso esperando um
                    // aviso que nao vem — WebSocket mudo e indistinguivel de
                    // rede parada, e ficar pendurado seria pior que perguntar.
                    await esperarBlocoOuTempo(
                        (aoBloco) => ouvinte.assinar(aoBloco),
                        Math.max(resta, 2500),
                        (fn, ms) => setTimeout(fn, ms),
                        (id) => clearTimeout(id as NodeJS.Timeout),
                    );
                } else {
                    await dormirDeOlho(resta, OLHAR_MERCADO_MS, olharMercado, async (ms) => { await dormir(ms); });
                }
            }
        }
    }
}

if (require.main === module && exigirAtivacao('cacarAoVivo')) {
    void (async () => {
        for (;;) {
            try {
                if ((await principal()) === 'parar') {
                    log.error('Configuração impede rodar. Não reinicio sozinho — corrija e reimplante.');
                    return;
                }
                log.warn('O laço terminou sem erro, o que não devia acontecer. Reiniciando.');
            } catch (e) {
                log.warn('O caçador tropeçou; reiniciando em 1 segundo.', { erro: (e as Error).message });
            }
            await dormir(1000);
        }
    })();
}
