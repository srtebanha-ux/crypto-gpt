// Arquivo: src/cacarAoVivo.ts
import { Decimal } from 'decimal.js';
import { Wallet, JsonRpcProvider } from 'ethers';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import { REDES, RPCS_PARA_TENTAR, SELETOR_GET_RESERVES_LIST, decodificarListaDeEnderecos, faixasDeBlocos, TOPIC_LIQUIDATION_CALL, decodificarLiquidacao } from './liquidacoes';
import { contarPorEndereco, quemTemDono, comoLerAContagem, repartirPorFaixa } from './concentracao';
import { emDolar, lucroEstimado, comparaPremio, dividaMinimaQueVale, coberturaOtima, lucroMaximo, PROFUNDIDADE_DA_VENDA, ondeEuEstava, montarPlacar, oQueIssoQuerDizer, type Perdida } from './perdidas';
import { posturaPorMargem, posturaPorChegada, posturaMaisForte, ritmoDaPostura, dormirDeOlho, quemArmar, valeArmar, atirarAntesDoCruzamento, DESVIO_TIPICO_PCT, type Postura } from './adiantar';
import { SELETOR_BASEFEE, LIMITE_DE_GAS, PISO_DA_GORJETA_WEI, gorjetaPorGas, tetoPorGas, lerBasefee, fracaoAdaptativa, sobraDepoisDaGorjeta, custoDeUmaDerrota, gorjetaQueCabeNoSaldo, derrotasQueAguenta, fracaoDoSaldoQueValeArriscar, adiantadoExigido, maxFeeQueOSaldoAdianta, custoDoTiroUsd, valeATentativa, numeroDoAmbiente, lanceAmordacado, mataACacaDeMigalhas, decidirTiro, faixaQueAtira, politicaDoTiro, comoLerAPolitica, tiroDeProvaArmado, GAS_TIPICO_DE_UMA_CACADA, TETO_DA_FRACAO, limiteDeGasDoTiro } from './prontidao';
import { lerRecibo, placarVazio, contarTiro, comoEstaIndo } from './tiros';
import { wsDoHttp, esperarBlocoOuTempo, OuvinteDeBlocos } from './gatilhoDeBloco';
import { registrar as registrarDeriva, blocosAteCruzar, esquecerQuemSaiu, oQueVemPorAi, projetar, emQuantoTempo, type Amostra } from './deriva';
import { SELETOR_SYMBOL, lerSymbol, simboloDaBinance, cotacoesDeQualquerFonte, quedaDoMercado } from './precoDeMercado';
import { abrirConexoes, buscar, CONEXOES_POR_SERVIDOR } from './conexoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from './posicoes';
import { CHAMADAS_POR_MULTICALL, MULTICALL3, codificarAggregate3, decodificarAggregate3, decodificarAggregate3Rapido, partirEmPedacos } from './multicall';
import { naoCruzouAinda, codificarUserReserveData, decodificarUserReserveData, COBRIR_O_MAXIMO, ehLimiteDoProvedor } from './liquidar';
import { enderecoDaResposta, escolherParPorValor, type SaldoNaMoeda } from './reservas';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL, isDevedorIgnorado, julgarCofre, podeCacarComDinheiroReal, SELETOR_COFRE, SELETOR_DONO, COFRE_ESPERADO } from './caca';
import { POOLS } from './contratos';
import { EscadaDeRpc, listaDeRpcs, ehFalhaDeTransporte } from './escadaDeRpc';
import {
    NASCIMENTO_DO_POOL, CAMINHO_DO_CACHE, VERSAO_DO_CACHE,
    lerCache, gravarCache, deOndeComecar, ateOndeSemBuraco, deOndeSemBuraco,
    juntarDevedoresDoCache, esquecerQuemNaoDeveMais, comoEstaACobertura,
} from './cacheDeDevedores';

/**
 * Quanto pedir emprestado, em unidades cruas.
 *
 * `COBRIR_O_MAXIMO` ia direto para `flashLoanSimple` como o TAMANHO do
 * emprestimo. Valor "maximo" ali nao significa "o quanto der": significa pedir
 * 1e44 unidades emprestadas, e nenhum pool do mundo tem isso. Toda caçada real
 * reverteria, sempre — e os ensaios nunca denunciaram porque batiam na recusa
 * da Aave (posicao saudavel) antes de chegar ao emprestimo.
 *
 * A Aave so deixa cobrir METADE da divida enquanto a saude esta entre 0,95 e 1.
 * Pedir mais que isso e emprestar dinheiro que sera devolvido sem uso, pagando
 * premio a toa.
 *
 * Mas "pedir menos e deixar agio na mesa" — o que estava escrito aqui — e
 * verdade para posicao pequena e FALSO para baleia. A Aave nao obriga a cobrir
 * metade: `debtToCover` pode ser qualquer valor ate esse limite. E numa divida
 * de US$ 95 milhoes, cobrir metade significa vender US$ 50 milhoes de garantia
 * num pool de US$ 4,4 milhoes — o agio inteiro fica dentro do escorregamento e
 * sobra prejuizo.
 *
 * Entao o teto e o MENOR de dois: metade da divida, e a fatia que o pool
 * aguenta com lucro maximo. Divida grande deixa de ser prejuizo e passa a ser
 * premio com teto.
 *
 * A conversao para unidades cruas e uma regra de tres na propria divida: a
 * razao cobertura/divida nao tem unidade, entao nao preciso de casas decimais
 * nem de preco aqui — so dos dois numeros que o alvo ja carrega.
 *
 * Sem `dividaUsd` (falta cotacao) volta a metade, que e o comportamento antigo:
 * na duvida, quem barra o tiro ruim e a simulacao, nao um palpite meu.
 */
export const FATIA_COBRIVEL = 2n;
export function quantoPedirEmprestado(
    dividaCrua: bigint,
    dividaUsd?: Decimal,
    coberturaMaximaUsd?: Decimal,
): bigint {
    const metade = dividaCrua / FATIA_COBRIVEL;
    if (dividaUsd === undefined || coberturaMaximaUsd === undefined) return metade;
    if (!dividaUsd.isFinite() || dividaUsd.lessThanOrEqualTo(0)) return metade;
    if (!coberturaMaximaUsd.isFinite() || coberturaMaximaUsd.lessThanOrEqualTo(0)) return metade;
    if (dividaUsd.dividedBy(2).lessThanOrEqualTo(coberturaMaximaUsd)) return metade;
    const cru = new Decimal(dividaCrua.toString()).mul(coberturaMaximaUsd.dividedBy(dividaUsd));
    try {
        const v = BigInt(cru.toFixed(0));
        // Zero significaria mandar uma cacada que nao cobre nada. Acima da
        // metade a Aave recusa. Fora da faixa, metade.
        return v > 0n && v < metade ? v : metade;
    } catch {
        return metade;
    }
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
/**
 * Uma posicao medida. `dividaUsd` vem DE GRACA na mesma palavra do
 * `getUserAccountData` que da a saude, e era jogada no lixo: sem ela a fila de
 * prioridade do bot nao sabe distinguir uma divida de US$ 0,65 de uma de
 * US$ 4.000. `null` quando a resposta nao trouxe o campo.
 */
export interface Medida {
    devedor: string;
    queda: Decimal;
    dividaUsd: Decimal | null;
    /**
     * POR QUAL LADO esta posicao quebra: `imune`, `long`, `short` ou `ambas`.
     * Ver `viaDeQuebra`.
     *
     * `undefined` quer dizer "ainda nao sei", e e diferente de `imune`: o par
     * so e conhecido depois que `montarAlvos` leu as reservas do devedor, e
     * isso so acontece para quem entra na brasa. Quem nao se sabe entra na
     * frente, porque o custo de vigiar um imune por engano e uma vaga, e o
     * custo de deixar um sensivel de fora e o tiro.
     */
    via?: Via;
}

/**
 * Moedas que andam JUNTAS o bastante para o preco nao derrubar a posicao.
 *
 * `pisoDaSaudePorPreco` mede isso exatamente, mas precisa das reservas todas.
 * Aqui e o corte barato do laco quente: mesma moeda nos dois lados, ou as duas
 * na mesma familia. Medido em 2026-09-28 — `0x034a3304` e weETH contra WETH e
 * aparecia como "precisa cair 0,044%", quando so um depeg o derruba.
 */
// AS 15 RESERVAS DA AAVE NA BASE, LIDAS DA REDE em 2026-09-28 com
// `getReservesList()` e `symbol()` de cada uma. A lista anterior tinha um
// endereco que eu INVENTEI — `0x80d1e0f4…`, que nao existe. Endereco escrito de
// cabeca e o mesmo defeito que este projeto persegue, so que em hexadecimal.
const FAMILIAS_POR_NOME = {
    ETH: [
        '0x4200000000000000000000000000000000000006', // WETH
        '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
        '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH
        '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a', // weETH
        '0x2416092f143378750bb29b79ed961ab195cceea5', // ezETH
        '0xedfa23602d0ec14714057867a78d01e94176bea0', // wrsETH
    ],
    BTC: [
        '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC
        '0xecac9c5f704e954931349da37f60e39f515c11c1', // LBTC
        '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b', // tBTC
    ],
    USD: [
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
        '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
        '0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee', // GHO
        '0x660975730059246a68521a3e2fbd4740173100f5', // syrupUSDC
    ],
    // FORA DE PROPOSITO, e os dois merecem o motivo escrito:
    //
    // EURC (`0x60a3e35c…`) e EURO. Contra dolar ele tem risco de CAMBIO de
    // verdade — medido em 2026-09-28, `0x675c8697` tem garantia em USDC e
    // divida em EURC e o piso deu ZERO: o preco derruba aquela posicao. Poe-lo
    // na familia do dolar mandaria um alvo genuinamente sensivel para o fim da
    // fila, que e o defeito deste conserto ao contrario.
    //
    // AAVE (`0x63706e40…`) e token volatil, nao e familia de ninguem.
    //
    // USDT nao entra porque NAO E reserva da Aave na Base: a lista de 15 lida
    // da rede nao tem USDT.
} as const;

export type Familia = keyof typeof FAMILIAS_POR_NOME | 'outro';

/**
 * De que familia e o ativo. `outro` para quem nao esta em nenhuma — EURC, AAVE,
 * e qualquer endereco que este arquivo nao conheca.
 *
 * `outro` conta como VOLATIL de proposito: o euro tem risco de cambio contra o
 * dolar (medido em 2026-09-28 no `0x675c8697`, piso ZERO), o AAVE e volatil, e
 * um endereco desconhecido no lado seguro e o que mantem o alvo na fila do
 * preco em vez de arquiva-lo como imune sem prova.
 */
export function familiaDoAtivo(endereco: string): Familia {
    const e = endereco.toLowerCase();
    for (const [nome, lista] of Object.entries(FAMILIAS_POR_NOME)) {
        if ((lista as readonly string[]).includes(e)) return nome as Familia;
    }
    return 'outro';
}

/** Anda com o dolar? So a familia USD. Todo o resto se move contra ele. */
function ehEstavel(f: Familia): boolean {
    return f === 'USD';
}

/**
 * POR QUAL LADO DA RUA esta posicao quebra.
 *
 * Medido em 2026-09-29, cobertura 100% (205 janelas, 9,5 dias, 60 liquidacoes,
 * 60 com arquivo): das 38 que cruzaram no bloco exato, 28 foram por preco — e
 * em 28 de 28 o preco que se moveu foi o da DIVIDA, para CIMA. Em 20 delas a
 * garantia nao andou nada (+0,0000%).
 *
 * O bot vigiava so a garantia caindo. Montamos o exercito no norte e o inimigo
 * entrou pelo sul.
 *
 *   `imune`  mesma moeda, ou mesma familia conhecida: o preco aparece em cima e
 *            embaixo da conta da saude e se cancela. Nenhum preco derruba.
 *   `long`   garantia volatil contra divida estavel. Quebra quando o oraculo da
 *            GARANTIA CAI. E o unico caso que o codigo antigo modelava.
 *   `short`  garantia estavel contra divida volatil. Quebra quando o oraculo da
 *            DIVIDA SOBE. Era este o caso da maioria das liquidacoes reais, e o
 *            bot publicava "precisa cair X%" sobre ele — um numero que a
 *            garantia, sendo dolar, nunca entrega.
 *   `ambas`  as duas volatis e de familias diferentes (cbBTC contra WETH). O que
 *            quebra e a RAZAO entre as duas, e ela se move pelos dois lados.
 *
 * `outro` contra `outro` NAO e imune: dois ativos desconhecidos nao andam
 * juntos por serem ambos desconhecidos. Isso seria inventar correlacao.
 */
export type Via = 'imune' | 'long' | 'short' | 'ambas';

export function viaDeQuebra(garantia: string, divida: string): Via {
    const g = garantia.toLowerCase(), d = divida.toLowerCase();
    if (g === d) return 'imune';
    const fg = familiaDoAtivo(g), fd = familiaDoAtivo(d);
    if (fg === fd && fg !== 'outro') return 'imune';
    const gVolatil = !ehEstavel(fg), dVolatil = !ehEstavel(fd);
    if (gVolatil && dVolatil) return 'ambas';
    return gVolatil ? 'long' : 'short';
}

/**
 * A alta da DIVIDA que liquida, a partir da queda da GARANTIA que liquida.
 *
 * Exato, e nao precisa reler a saude: com H = (garantia x limiar) / divida,
 *
 *     queda que liquida  q = 1 - 1/H   =>   H = 1/(1-q)
 *     alta que liquida   y = H - 1     =>   y = q / (1-q)
 *
 * Conferido contra `altaDaDividaAteLiquidar`, que faz a conta a partir da saude
 * crua: os dois caminhos tem de dar o mesmo numero, e um teste exige isso.
 * Devolve `null` quando q >= 100%, onde a conversao nao significa nada.
 */
export function altaEquivalente(quedaPct: Decimal): Decimal | null {
    if (!quedaPct.isFinite() || quedaPct.lessThan(0)) return null;
    const q = quedaPct.dividedBy(100);
    if (q.greaterThanOrEqualTo(1)) return null;
    return q.dividedBy(new Decimal(1).minus(q)).mul(100);
}

/**
 * O que ja se sabe sobre cada devedor. Preenchida por `montarAlvos`, que e o
 * unico lugar que le o par — e lida pela ordenacao da brasa no ciclo seguinte.
 */
const viaPorDevedor = new Map<string, Via>();
export function lembrarAVia(devedor: string, via: Via): void {
    viaPorDevedor.set(devedor.toLowerCase(), via);
}
export function oQueSeSabeDaVia(devedor: string): Via | undefined {
    return viaPorDevedor.get(devedor.toLowerCase());
}

/**
 * O preco derruba esta posicao?
 *
 * DERIVADO de `viaDeQuebra`, e nao uma segunda implementacao: a regra 3 deste
 * projeto e que uma regra em dois lugares e a mesma regra, e tres dos dez erros
 * que originaram o CLAUDE.md foram eu consertar uma ponta e deixar a gemea.
 */
export function oPrecoCancela(garantia: string, divida: string): boolean {
    return viaDeQuebra(garantia, divida) === 'imune';
}

/** As tres camadas, e a regua do gatilho que separa a primeira da segunda. */
export interface Camadas {
    brasa: string[];
    quentes: string[];
    margemDaBrasa: Decimal;
    /**
     * A menor distancia ate liquidar entre os que PASSAM o piso de tamanho.
     *
     * E ela que decide o ritmo, de proposito: acelerar o bot inteiro por um alvo
     * de 22 centavos seria trocar um furo por outro.
     */
    menorMargem: Decimal | null;
    /**
     * A menor distancia da BRASA INTEIRA, contando os alvos de PROVA.
     *
     * Existe porque o log publicava `maisPerto` a partir de `menorMargem`, que
     * ignora os de prova — e no modo prova o bot ATIRA neles. Em 2026-09-28 o log
     * dizia `maisPerto: 1.4260%` enquanto uma posicao de poeira estava a 0,98%, e
     * a dona do bot le esse numero para saber o quanto falta. Numero certo para
     * uma pergunta, publicado como resposta de outra.
     */
    menorMargemDaBrasa: Decimal | null;
    /** Quantas foram descartadas por serem pequenas demais para pagar o gas. */
    poEmDemasia: number;
    /** Quantas vagas da brasa foram para alvos de PROVA (abaixo do piso). */
    vagasDeProva: number;
    /** Quantas sobraram: as que valem uma vaga na fila rapida. */
    valemUmTiro: number;
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
    pisoDeDividaUsd: Decimal | null = null,
    /**
     * Vagas reservadas para alvos de PROVA: os mais frageis ENTRE OS QUE O PISO
     * DE TAMANHO CORTOU.
     *
     * Existe por um furo que o log de 17:53 mostrou. A tabela dizia
     * `1%: 3 alcanço/0 valem` — tres posicoes a menos de 1% de cair, nenhuma
     * passando o piso de US$ 22,14. E o `maisPerto` dizia 1,1555%, que e o mais
     * fragil DENTRE OS QUE PASSAM o piso.
     *
     * Ou seja: as tres posicoes que o modo prova existe para atirar estavam
     * FORA da brasa. So seriam relidas na varredura de hora em hora — e quando
     * uma caisse, o bot descobriria com ate uma hora de atraso, depois de outro
     * ja ter levado.
     *
     * O modo prova soltava o portao do TIRO e nao soltava o filtro da SELECAO.
     * Metade do conserto nao conserta nada.
     *
     * As vagas saem de dentro das 233, e nao por cima: o multicall nao tem mais
     * que isso. E `menorMargem` e `margemDaBrasa` continuam saindo dos alvos de
     * verdade, porque sao elas que decidem o ritmo de 200ms — acelerar o bot
     * inteiro por um alvo de 22 centavos seria trocar um furo por outro.
     */
    vagasParaProva = 0,
): Camadas {
    // O filtro de TAMANHO vem antes da ordenacao, e e por isso que existe.
    // A brasa e uma fila de prioridade — as vagas mais rapidas que o bot tem —
    // e ordenar por fragilidade pura entrega essas vagas a quem nunca vai
    // valer um tiro. O tiro em seco provou isso: o mais fragil de 234 devia
    // US$ 0,65, e era nele que o bot apontava.
    //
    // Quem nao tem divida lida (`null`) NAO e descartado: cortar por falta de
    // dado e transformar uma leitura incompleta em decisao, o defeito que este
    // projeto ja encontrou dezenas de vezes.
    const cabem = pisoDeDividaUsd === null
        ? medidos
        : medidos.filter((m) => m.dividaUsd === null || m.dividaUsd.greaterThanOrEqualTo(pisoDeDividaUsd));
    // Os IMUNES A PRECO vao para o fim da fila, e nao para fora dela.
    //
    // Eles continuam sendo vigiados — o dono deles pode sacar garantia e
    // derrubar a posicao num bloco, medido em 2026-09-28 no `0x43ec917e`. Mas
    // nao podem ocupar as vagas da FRENTE, porque a frente e a fila do preco:
    // no log das 16:58 o `[EM SECO]` mirava `0x43ec917e`, que e USDC contra
    // USDC e nunca cai com o mercado, enquanto os sensiveis esperavam atras.
    //
    // `via === undefined` conta como sensivel: nao se sabe, e quem nao se sabe
    // fica na frente.
    //
    // `long`, `short` e `ambas` ficam TODOS na frente, em pe de igualdade. Era
    // aqui que a bussola estava torta: nada distinguia os dois lados, e a fila
    // era ordenada por um numero — `queda` — que so faz sentido para `long`.
    // Medido em 2026-09-29: 28 de 28 liquidacoes por preco foram a DIVIDA
    // subindo, e em 20 delas a garantia nao andou nada.
    const ordenados = [...cabem].sort((a, b) => {
        const ia = a.via === 'imune' ? 1 : 0;
        const ib = b.via === 'imune' ? 1 : 0;
        return ia !== ib ? ia - ib : a.queda.comparedTo(b.queda);
    });

    // Os alvos de prova: os mais frageis entre os que o piso cortou.
    const deProva = vagasParaProva <= 0 || pisoDeDividaUsd === null
        ? []
        : medidos
            .filter((m) => m.dividaUsd !== null && m.dividaUsd.lessThan(pisoDeDividaUsd))
            .sort((a, b) => a.queda.comparedTo(b.queda))
            .slice(0, vagasParaProva);

    const vagasParaOsDeVerdade = Math.max(0, vagesNaBrasaSegura(vagasNaBrasa) - deProva.length);
    const brasa = ordenados.slice(0, vagasParaOsDeVerdade);
    const resto = ordenados.slice(brasa.length);
    const quentes = resto.filter((m) => m.queda.lessThanOrEqualTo(margemQuente));
    // Se a brasa cobre todo mundo que esta dentro da margem, nao ha ninguem
    // entre uma camada e outra: o proximo alvo do gatilho e a propria margem.
    const margemDaBrasa = resto.length > 0 ? resto[0].queda : new Decimal(margemQuente);
    return {
        // Os de prova entram na brasa para serem lidos a cada ciclo, que e o
        // unico jeito de nao descobrir a queda deles uma hora depois.
        brasa: [...brasa.map((m) => m.devedor), ...deProva.map((m) => m.devedor)],
        quentes: quentes.map((m) => m.devedor),
        margemDaBrasa,
        // As reguas do RITMO continuam saindo dos alvos de verdade.
        menorMargem: ordenados.length > 0 ? ordenados[0].queda : null,
        // E o que o log publica como "mais perto" sai da brasa inteira, porque e
        // nela que o bot atira — inclusive nos de prova.
        //
        // Mas so de quem o PRECO alcanca. `maisPerto` responde "quanto o mercado
        // precisa cair", e um imune nao responde a essa pergunta com numero
        // nenhum. A ordenacao acima ja pos os imunes atras, mas isto aqui e um
        // MINIMO sobre a brasa toda: sem o filtro, o imune de 0,0434% voltava a
        // ser publicado como o mais perto. Mesma regra, segundo lugar — e foi
        // ela quem achou.
        //
        // Se TODOS forem imunes, o minimo sai deles mesmo, com o numero que
        // existe: publicar `null` ali viraria "ninguem", que e pior.
        menorMargemDaBrasa: (() => {
            const naBrasa = [...brasa, ...deProva];
            const sensiveis = naBrasa.filter((m) => m.via !== 'imune');
            const fonte = sensiveis.length > 0 ? sensiveis : naBrasa;
            return fonte.reduce<Decimal | null>(
                (menor, m) => (menor === null || m.queda.lessThan(menor) ? m.queda : menor), null);
        })(),
        poEmDemasia: medidos.length - cabem.length,
        valemUmTiro: cabem.length,
        vagasDeProva: deProva.length,
    };
}

/** As vagas nunca podem ser negativas nem fracionarias: o multicall conta inteiro. */
function vagesNaBrasaSegura(n: number): number {
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** O endereco zero: para o contrato, "nao venda nada". */
export const SEM_VENDA = '0x0000000000000000000000000000000000000000';

/**
 * Em qual pool vender a garantia — e ZERO quando nao ha nada a vender.
 *
 * Quando a garantia tomada JA E a moeda que se deve, vender e o erro. Medido em
 * 2026-09-28, e vale para os 8 alvos de moeda unica que o censo achou:
 *
 * O alvo `0xc4d36f95` e WETH contra WETH. O pool de venda configurado e
 * `0xcdac0d6c…` — conferido na rede: token0 = WETH, token1 = USDC. Com o pool
 * passado, `executeOperation` faz:
 *
 *     liquidationCall(WETH, WETH, devedor, quantia)   -> recebe WETH tomado
 *     _venderGarantia(WETH, poolWETH/USDC, TODO o WETH) -> devolve USDC
 *     emCaixa = balanceOf(WETH) ~ 0
 *     lucro = 0  ->  revert LucroInsuficiente(0, piso)
 *
 * Ou seja: ele vende inclusive o WETH que precisa para pagar o emprestimo, fica
 * sem com que pagar, e a transacao inteira reverte. O tiro nunca pode acertar
 * uma posicao de moeda unica, e a MEDICAO desses alvos sai como lucro zero —
 * o que faz `decidirTiro` recusar um alvo que talvez valesse.
 *
 * O contrato ja sabe fazer certo e nao precisa de novo deploy: ele tem
 * `if (poolDeVenda != address(0))`. Com o endereco zero ele pula a venda, e ai
 * `emCaixa` e a garantia tomada, na moeda certa, e o lucro sai correto.
 */
export function poolParaVender(
    alvo: { garantia: string; divida: string },
    poolPadrao: string,
): string {
    return alvo.garantia.toLowerCase() === alvo.divida.toLowerCase() ? SEM_VENDA : poolPadrao;
}

/**
 * Um piso de lucro em DOLARES, convertido para as unidades cruas da divida.
 *
 * A razao `dividaCrua/dividaUsd` ja carrega as casas decimais e a cotacao do
 * ativo, entao nao e preciso mapa de precos nenhum aqui — e o mesmo truque de
 * regra de tres que `quantoPedirEmprestado` usa, pelo mesmo motivo.
 *
 * Devolve `0n` quando falta dado ou quando o piso nao e positivo: na duvida,
 * exigir ZERO e pedir so que o emprestimo seja pago, que e o minimo honesto.
 */
export function pisoDoLucroEmUnidadesCruas(
    alvo: { dividaCrua?: bigint; dividaUsd?: Decimal | null },
    pisoUsd: Decimal | null,
): bigint {
    if (alvo.dividaCrua === undefined || alvo.dividaCrua <= 0n) return 0n;
    if (pisoUsd === null || !pisoUsd.isFinite() || pisoUsd.lessThanOrEqualTo(0)) return 0n;
    const d = alvo.dividaUsd;
    if (d === null || d === undefined || !d.isFinite() || d.lessThanOrEqualTo(0)) return 0n;
    const cru = pisoUsd.dividedBy(d).mul(new Decimal(alvo.dividaCrua.toString()));
    if (!cru.isFinite() || cru.lessThanOrEqualTo(0)) return 0n;
    return BigInt(cru.toFixed(0));
}

/**
 * A margem que decide o RITMO — e o numero que o log chama de `maisFragilA`.
 *
 * Quinta vez que a mesma regra aparece em mais de um lugar neste repositorio, e
 * a terceira vez especificamente com o modo prova: ele soltava o portao do TIRO
 * (`valeATentativa`), depois passou a soltar o filtro da SELECAO (as vagas de
 * prova na brasa) — e continuava sem soltar o RITMO.
 *
 * `menorMargem` e a menor distancia entre os alvos que PASSAM o piso de
 * tamanho. Fora do modo prova ela esta certa e a razao esta escrita em
 * `repartirPorFragilidade`: acelerar o bot inteiro por um alvo de 22 centavos
 * seria trocar um furo por outro.
 *
 * Com o modo prova ARMADO, porem, o bot atira nos de prova — e ai continuar
 * medindo o ritmo pelos outros e prometer um tiro que a cadencia nao alcanca.
 * Medido no log de 2026-09-28: `[BLOCO]` dizia `maisPerto: precisa cair
 * 0.0441% (o mais perto que passa o piso de tamanho esta a 1.4278%)` enquanto
 * `[POSTURA]` dizia `maisFragilA: 1.4279%`. Duas linhas do mesmo log, a mesma
 * pergunta, respostas diferentes — e a que mandava no ritmo era a que ignorava
 * o alvo em que o bot ia atirar.
 *
 * Entao: um lugar so, e o modo prova decide de qual camada sai.
 */
export function margemQueDecideORitmo(
    camadas: Pick<Camadas, 'menorMargem' | 'menorMargemDaBrasa'>,
    tiroDeProvaArmado: boolean,
): Decimal | null {
    if (!tiroDeProvaArmado) return camadas.menorMargem;
    // Brasa vazia nao pode virar "nao ha ninguem": cai de volta no numero com
    // piso, que e o mesmo cuidado que `maisPerto` ja toma duas telas acima.
    return camadas.menorMargemDaBrasa ?? camadas.menorMargem;
}

/** Uma linha da tabela "o que uma queda de X% poria na mesa". */
export interface Degrau {
    quedaPct: number;
    /** Quantas posicoes uma queda desse tamanho alcancaria. */
    quantos: number;
    /** Dessas, quantas pagariam o proprio gas. */
    quantosValem: number;
    /**
     * Dessas, quantas entraram SEM o par resolvido — ou seja, por suposicao.
     *
     * `alcancaNaDirecao` conta o desconhecido como alcancavel de proposito, e o
     * vies esta certo. O que nao pode e a soma publicada nao dizer quanto dela e
     * palpite: depois de um deploy a memoria dos pares volta vazia e a tabela
     * infla sozinha, parecendo oportunidade nova.
     */
    porPalpite: number;
    dividaUsd: Decimal;
    /** Soma do lucro das que valem. NAO e a divida. */
    lucroUsd: Decimal;
    /**
     * O MAIOR premio sozinho dentro do degrau, e a que distancia ele esta.
     *
     * A soma escondia a forma. "2%: 3 valem (US$ 91)" parece tres liquidacoes
     * de US$ 30 — nada. Conferido direto na Base em 2026-09-27, eram DUAS, e
     * uma delas vale US$ 66,44 e esta a 1,44% de cair: um alvo perto, grande e
     * dentro da faixa. A media apagava exatamente a boa noticia.
     *
     * E e o maior sozinho que decide, porque e UM alvo por vez que dispara.
     */
    maior: { lucroUsd: Decimal; quedaPct: Decimal } | null;
}

/**
 * O que uma queda de mercado de X% poria na mesa, hoje.
 *
 * Existe por causa de um numero que nao dava para interpretar: `menorMargem` de
 * 1,1562% diz que o alvo mais perto precisa de 1,16% de queda, mas nao diz se
 * atras dele vem um ou vem cinquenta. "Quanto vale um tombo de 2%" e a pergunta
 * que decide se vale a pena esperar o mercado ou ir procurar caca em outro
 * lugar, e ela nao tinha resposta nenhuma no log.
 *
 * `quantos` e `quantosValem` sao numeros diferentes de proposito: alcancar nao e
 * lucrar. E o lucro somado NAO e a divida somada — e o agio sobre a metade dela
 * menos o custo de vender. Confundir os dois e o erro que este projeto ja
 * cometeu duas vezes, sempre no mesmo sentido: otimista.
 */
export type Direcao = 'queda' | 'alta';

/**
 * Quem um movimento de X% alcança NA DIREÇÃO pedida.
 *
 * `undefined` conta como alcançado, igual ao resto do bot: quem não se sabe
 * fica na frente, porque o custo de contar um imune por engano é uma linha de
 * log e o de deixar um sensível de fora é o tiro.
 */
function alcancaNaDirecao(via: Via | undefined, direcao: Direcao): boolean {
    if (via === undefined) return true;
    if (via === 'imune') return false;
    if (via === 'ambas') return true;
    return direcao === 'queda' ? via === 'long' : via === 'short';
}

/**
 * O que um movimento de X% renderia, para CADA LADO da rua.
 *
 * `queda` alcança `long` e `ambas`; `alta` alcança `short` e `ambas`. E a régua
 * muda com a direção: para `queda` é `m.queda`, para `alta` é a alta da dívida
 * que liquida — `altaEquivalente(m.queda)`, que é exata, não uma aproximação.
 *
 * Antes desta função a tabela contava um `short` como alcançado por uma QUEDA.
 * Medido em 2026-09-29: 20 das 28 liquidações por preço tinham garantia estável,
 * e uma queda de mercado não move nenhuma delas — o número existia, estava na
 * tela, e apontava para o lado errado da rua.
 */
export function oQueUmMovimentoRenderia(medidos: Medida[], degraus: number[], direcao: Direcao): Degrau[] {
    return [...degraus].sort((a, b) => a - b).map((quedaPct) => {
        // Só quem o PREÇO alcança, e só na direção pedida. Uma posição de moeda
        // única não cai porque o mercado caiu X% — ela nem se mexe. Medido em
        // 2026-09-28: o log dizia `1%: 3 alcanço` e os três eram dois WETH/WETH
        // e um weETH/WETH, ou seja ZERO alcançados de verdade.
        const alcancados = medidos.filter((m) => {
            if (!alcancaNaDirecao(m.via, direcao)) return false;
            const regua = direcao === 'queda' ? m.queda : altaEquivalente(m.queda);
            return regua !== null && regua.lessThanOrEqualTo(quedaPct);
        });
        // QUANTOS DESTES SÃO PALPITE.
        //
        // `alcancaNaDirecao` devolve `true` para quem ainda não teve o par
        // resolvido, e o viés está certo: deixar um sensível de fora custa o
        // tiro, vigiar um imune por engano custa uma vaga.
        //
        // Mas a SOMA publicada não pode calar isso. Em 2026-10-06, logo depois
        // de um deploy, a memória dos pares voltou vazia (`57163 ainda não
        // sei`) e a tabela saltou de "1%: 1 alcanço" para "1%: 191 alcanço",
        // com US$ 171.144 a 10%. Parecia o mercado abrindo; era a bússola
        // apagada contando imunes como alcançáveis — e as DUAS tabelas, queda e
        // alta, inflaram juntas, o que é impossível para a mesma posição.
        //
        // Número medido e número suposto na mesma soma, sem etiqueta: é o
        // defeito que este arquivo persegue desde o primeiro dia.
        const porPalpite = alcancados.filter((m) => m.via === undefined).length;
        let dividaUsd = new Decimal(0);
        let lucroUsd = new Decimal(0);
        let quantosValem = 0;
        let maior: { lucroUsd: Decimal; quedaPct: Decimal } | null = null;
        for (const m of alcancados) {
            if (m.dividaUsd === null) continue;
            dividaUsd = dividaUsd.plus(m.dividaUsd);
            const lucro = lucroEstimado(m.dividaUsd);
            // Somar lucro negativo mascararia o po dentro do total: uma
            // posicao que da prejuizo nao subtrai do premio das outras, ela
            // simplesmente nao e atirada.
            if (lucro.greaterThan(0)) {
                lucroUsd = lucroUsd.plus(lucro);
                quantosValem++;
                // A margem publicada segue a DIREÇÃO, senão a etiqueta discorda
                // do conjunto: numa linha de `alta`, dizer "a 1.44%" com o
                // número da queda seria publicar a régua do outro lado da rua.
                const regua = direcao === 'queda' ? m.queda : altaEquivalente(m.queda);
                const candidato = { lucroUsd: lucro, quedaPct: regua ?? m.queda };
                // O desempate vive em `comparaPremio` porque o lucro satura no
                // teto do pool: duas baleias empatam ate a ultima casa, e com
                // `>` estrito quem ganhava era a ordem do multicall.
                if (maior === null || comparaPremio(candidato, maior) < 0) maior = candidato;
            }
        }
        return { quedaPct, quantos: alcancados.length, quantosValem, porPalpite, dividaUsd, lucroUsd, maior };
    });
}

/** A via LONG: o que uma QUEDA da garantia renderia. O nome antigo, intacto. */
export function oQueUmaQuedaRenderia(medidos: Medida[], degraus: number[]): Degrau[] {
    return oQueUmMovimentoRenderia(medidos, degraus, 'queda');
}

/** A via SHORT: o que uma ALTA da dívida renderia — o lado que faltava. */
export function oQueUmaAltaRenderia(medidos: Medida[], degraus: number[]): Degrau[] {
    return oQueUmMovimentoRenderia(medidos, degraus, 'alta');
}

/**
 * Quantos de cada via, para a linha `[BUSSOLA]` do log.
 *
 * Existe porque a medição de 2026-09-29 mostrou que o bot vigiava um lado do
 * mercado e era liquidado o outro, e não havia UMA linha no log que dissesse de
 * que lado estavam os alvos. Sem esta contagem o conserto é invisível.
 */
export function contarVias(medidos: Medida[]): Record<Via | 'naoSeSabe', number> {
    const conta: Record<Via | 'naoSeSabe', number> = { imune: 0, long: 0, short: 0, ambas: 0, naoSeSabe: 0 };
    for (const m of medidos) conta[m.via ?? 'naoSeSabe']++;
    return conta;
}

export function comoLerABussola(c: Record<Via | 'naoSeSabe', number>): string {
    return `${c.long} LONG (cai a garantia) | ${c.short} SHORT (sobe a dívida)`
        + ` | ${c.ambas} AMBAS | ${c.imune} imunes | ${c.naoSeSabe} ainda não sei`;
}

/**
 * A tabela de quedas em uma linha, para o log.
 *
 * Existe separada porque e ISTO que a pessoa le para decidir se continua na
 * Aave da Base ou vai cacar em outro protocolo. Formatacao escondida dentro de
 * um log nao tem teste, e uma tabela que muda de forma em silencio faz a
 * decisao virar adivinhacao.
 */
export function comoLerAsQuedas(degraus: Degrau[]): string {
    if (degraus.length === 0) return 'nada medido';
    // `alcanca` e `valem` sao numeros diferentes, e a diferenca e a resposta
    // para "o tiro de prova tem alvo?". `1%: 0 valem` nao dizia se ali existem
    // zero posicoes ou cinquenta posicoes pequenas demais para a regra normal —
    // e o modo prova atira justamente nessas.
    // O MAIOR sozinho entra na linha porque e UM alvo por vez que dispara, e
    // porque a soma escondia a forma: "3 valem US$ 91" parecia tres de US$ 30,
    // e era uma de US$ 66 a 1,44% de cair.
    return degraus
        .map((d) => `${d.quedaPct}%: ${d.quantos} alcanço/${d.quantosValem} valem (US$ ${d.lucroUsd.toFixed(0)}${
            d.maior === null ? '' : `, maior US$ ${d.maior.lucroUsd.toFixed(0)} a ${d.maior.quedaPct.toFixed(2)}%`}${
            // Sem esta fração, "191 alcanço" com 190 de par desconhecido lê
            // igual a "191 alcanço" medidos um por um.
            d.porPalpite > 0 ? `, mas ${d.porPalpite} de ${d.quantos} são PALPITE: par ainda não resolvido` : ''})`)
        .join(' | ');
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
// A janela do PRIMEIRO boot, quando ainda não existe cache: 30 dias, para o bot
// começar a caçar em minutos em vez de em duas horas.
//
// JÁ FOI o teto da memória do bot, e era o buraco no radar — o placar dela
// acusou 11 liquidações com "nem sabia" porque alvos mais velhos que 30 dias
// nunca tinham sido perguntados. Agora é só o ponto de partida: o cache desce
// daqui até o nascimento do Pool e guarda no volume, então a cobertura cresce
// boot após boot em vez de ser cortada a cada um.
const BLOCOS = Number(process.env.CACA_BLOCOS ?? '1296000');
// 2000 era o teto do `mainnet.base.org`, e virou o teto do bot em qualquer
// provedor. O RPC de produção dela aceita 10.000, e a diferença não é detalhe:
// varrer os 49,7 milhões de blocos do Pool custa 4.972 chamadas a 10.000 e
// 24.860 a 2.000. Pedir 10.000 só é seguro porque `descobrirPedaco` MEDE o teto
// do provedor antes de montar as faixas e cai para 2.000 onde 10.000 não cabe.
const PEDACO = Number(process.env.CACA_PEDACO ?? '10000');
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

/**
 * A ESCADA DE PROVEDORES, viva no caminho quente.
 *
 * `rpc` continua sendo a url em uso — centenas de linhas leem essa variável —
 * mas quem decide qual é ela agora é a escada, e ela decide A CADA FALHA, não só
 * no boot. O failover que existia aqui antes era de uma vez: escolhia no boot e
 * nunca mais olhava.
 */
const ESCADA = new EscadaDeRpc(
    listaDeRpcs(process.env, RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [REDE.rpc]),
    {
        falhasParaTrocar: Number(process.env.CACA_FALHAS_PARA_TROCAR ?? '2'),
        voltarAoPrimarioMs: Number(process.env.CACA_VOLTAR_AO_PRIMARIO_MS ?? '300000'),
    },
);
let rpc = ESCADA.url();
let rpcId = 0;

/**
 * Trata uma falha decidindo se ela é do provedor, e troca de degrau se for.
 *
 * Devolve `true` quando vale repetir a chamada — ou seja, quando o provedor
 * falhou. Uma reversão devolve `false` e sobe como sempre: o nó respondeu, e a
 * resposta é sobre o nosso contrato.
 */
function aEscadaAbsorve(mensagem: string): boolean {
    if (!ehFalhaDeTransporte(mensagem)) return false;
    const r = ESCADA.falhou();
    rpc = r.url;
    if (r.trocou) {
        log.warn('[RPC] TROQUEI DE PROVEDOR — o anterior não respondeu.', {
            de: hostDoRpc(r.de),
            para: hostDoRpc(r.para),
            erro: mensagem.slice(0, 120),
            degrau: `${ESCADA.indice() + 1} de ${ESCADA.quantos()}`,
            porque: 'provedor sobrecarregado e crash de mercado são o MESMO evento: '
                + 'é exatamente aqui que não se pode ficar cego',
        });
    }
    return true;
}

/** Tenta voltar ao primário quando o castigo venceu. Barato: só troca a url. */
function talvezVoltarAoPrimario(): void {
    if (!ESCADA.deveVoltarAoPrimario()) return;
    const de = ESCADA.url();
    ESCADA.voltarAoPrimario();
    rpc = ESCADA.url();
    log.info('[RPC] Voltando ao provedor primário.', {
        de: hostDoRpc(de), para: hostDoRpc(rpc),
        porque: 'ficar no secundário para sempre é degradar em silêncio — ele é mais '
            + 'lento e tem teto de 2.000 blocos no eth_getLogs',
    });
}
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

    private sincronizadoEm = 0;
    /** De quanto em quanto tempo a rede e consultada de novo, sem falha. */
    private readonly validadeMs = Number(process.env.CACA_NONCE_VALIDADE_MS ?? '120000');

    /**
     * A REDE e a verdade — para cima E para baixo.
     *
     * Antes so adotava quando o numero da rede era MAIOR. Isso deixava um jeito
     * de o bot morrer em silencio para sempre: se uma transacao fosse despejada
     * do mempool, o contador local ficava a frente, `sync()` nunca abaixava, e
     * toda transacao seguinte saia com nonce furado. Elas ficam na fila para
     * sempre, todo recibo vira 'sumiu', e o bot nunca mais liquida sem levantar
     * um unico erro.
     */
    public async sync(): Promise<number> {
        this.currentNonce = await this.provider.getTransactionCount(this.address, 'pending');
        this.sincronizadoEm = Date.now();
        return this.currentNonce;
    }

    public async getNextNonce(): Promise<number> {
        // Reperguntar de tempos em tempos custa uma chamada e impede que uma
        // dessincronizacao vire permanente.
        if (this.currentNonce === null || Date.now() - this.sincronizadoEm > this.validadeMs) {
            await this.sync();
        }
        const meu = this.currentNonce!;
        this.currentNonce = meu + 1;
        return meu;
    }

    /**
     * Depois de uma falha, quem decide e a rede.
     *
     * Era um decremento cego. Mas a transacao pode ter CHEGADO ao mempool e a
     * resposta ter estourado o tempo — ai decrementar faz o bot reusar um nonce
     * ja gasto, levar 'replacement underpriced', decrementar de novo, e ficar
     * preso naquele numero para sempre.
     */
    /**
     * O nonce que ele acredita ser o proximo, sem ir a rede.
     *
     * Existe para a trava do tiro de prova poder ser conferida no caminho
     * quente sem uma ida a rede — e `null` virou -1 la, porque "nao sei o
     * nonce" nao pode virar "pode atirar".
     */
    public nonceConhecido(): number {
        return this.currentNonce ?? -1;
    }

    public async aposFalhar(): Promise<void> {
        try {
            await this.sync();
        } catch {
            // Nem a rede respondeu: esquece o que sabia e repergunta no proximo.
            this.currentNonce = null;
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
            const r = await umaChamada<T>(metodo, params);
            ESCADA.deuCerto();
            return r;
        } catch (e) {
            const msg = (e as Error).message;
            if (i >= tentativas - 1) throw e;
            // A ESCADA PRIMEIRO. Antes, só `ehLimiteDoProvedor` autorizava
            // repetir: um timeout puro não era limite de taxa, então a chamada
            // morria na primeira tentativa e o bot ficava cego sem nunca
            // alcançar o failover escrito no boot. Trocar de provedor e repetir
            // na hora é mais rápido que a escada de espera, e não espera nada.
            if (aEscadaAbsorve(msg)) continue;
            if (!ehLimiteDoProvedor(msg)) throw e;
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

/**
 * O que a espera por limite do provedor CUSTOU neste ciclo.
 *
 * Medido/derivado em 2026-09-30, e e a resposta para "por que o ciclo levou
 * 11,4 segundos": a escada de espera abaixo comeca em 1.000ms e DOBRA.
 *
 *     1 recusa .... 1s        3 recusas ... 1+2+4  =  7s
 *     2 recusas ... 1+2 = 3s  4 recusas ... 1+2+4+8 = 15s
 *
 * 11,4s cai exatamente entre a terceira e a quarta. Não foi CPU, não foram os
 * 233 alvos e não foram os logs: foi o provedor pedindo calma três vezes.
 *
 * A linha de aviso existia, mas por chamada e no meio de centenas de outras —
 * ninguém somava. Agora o ciclo publica o TOTAL, ao lado do `custou`, e aí
 * "11.4s" deixa de ser um mistério e passa a ser um número com dono.
 */
let msEsperandoOProvedor = 0;
let recusasDoProvedor = 0;
export function zerarContaDaPaciencia(): void { msEsperandoOProvedor = 0; recusasDoProvedor = 0; }

/**
 * O host do RPC, SEM a chave.
 *
 * A chave da Alchemy mora no CAMINHO da URL
 * (`base-mainnet.g.alchemy.com/v2/<CHAVE>`), e log vira print, print vira
 * conversa: a regra deste projeto e que a chave nunca sai do Railway. So o
 * host, e mais nada — nem caminho, nem query, nem usuario.
 *
 * Existe porque o log nao dizia CONTRA QUEM o bot estava falando. Sem isso,
 * "o ciclo levou 11,4s" nao se distingue de "o RPC publico esta estrangulando o
 * bot", que e o mesmo buraco do `osBotoes`: duas maquinas, dois provedores, e
 * nenhuma linha ligando um ao outro.
 */
export function hostDoRpc(url: string): string {
    try { return new URL(url).host; } catch { return 'não consegui ler a URL'; }
}
export function contaDaPaciencia(): { ms: number; recusas: number } {
    return { ms: msEsperandoOProvedor, recusas: recusasDoProvedor };
}

async function chamarCruComPaciencia(
    params: unknown[],
    tentativas = 4,
): Promise<{ ok: true; dados: string } | { ok: false; mensagem: string; dados?: string }> {
    let espera = 1000;
    for (let i = 0; ; i += 1) {
        let r: Awaited<ReturnType<typeof chamarCru>>;
        try {
            r = await chamarCru(params);
            ESCADA.deuCerto();
        } catch (e) {
            // `chamarCru` LANÇA quando o transporte falha, e aqui isso subia
            // inteiro: a medição do tiro morria por timeout de um provedor
            // enquanto outro, vivo, estava a uma linha de distância.
            const msg = (e as Error).message;
            if (i < tentativas - 1 && aEscadaAbsorve(msg)) continue;
            throw e;
        }
        if (r.ok || r.dados || i >= tentativas - 1 || !ehLimiteDoProvedor(r.mensagem)) return r;
        recusasDoProvedor += 1;
        msEsperandoOProvedor += espera;
        log.warn('O provedor pediu calma no meio da caçada; esperando.', { esperandoMs: espera });
        await dormir(espera);
        espera *= 2;
    }
}

/**
 * O TETO da lista quente lida por ciclo — o adensamento de latencia.
 *
 * Medido em 2026-09-30 contra `mainnet.base.org`, DUAS vezes — e as duas
 * discordam, o que e a parte que importa:
 *
 *     conexao FRIA    233 alvos  559,5 ms   |   50 alvos   98,4 ms   (-461 ms)
 *     conexao QUENTE  166 alvos  241,3 ms   |   50 alvos  160,8 ms   (-80,5 ms)
 *     1 eth_blockNumber vazio, so o round trip ........... 457,8 ms
 *
 * A primeira medicao pegou aperto de conexao e TLS e atribuiu ao tamanho do
 * lote um custo que nao era dele. O numero honesto e o de conexao quente:
 * **80,5 ms, 33% menos**. Util, e longe de resolver um ciclo de 11,4 s.
 *
 * Isso mantem o teto valendo a pena e mata a ilusao de que ele e a cura: o
 * gargalo medido e o ROUND TRIP do RPC publico (457,8 ms para uma chamada
 * vazia) e a espera por limite do provedor, que dobra de 1 s em 1 s. Nenhum
 * corte de lista conserta nenhum dos dois.
 *
 * O custo e real e esta declarado: quem fica de fora do teto nao e visto NESTE
 * ciclo.
 *
 * O corte e seguro para as DUAS vias: a lista chega ordenada por `queda`, e a
 * regua do `short` — `altaEquivalente(queda)` — e monotona crescente em
 * `queda`, entao os 50 mais proximos por queda sao os mesmos 50 mais proximos
 * por alta. Cortar aqui nao esconde um short que estava na frente.
 *
 * `0` ou negativo desliga o teto. O log SEMPRE imprime os dois numeros — quem
 * havia e quantos foram lidos —, porque um corte silencioso que publica
 * `naListaQuente: 166` enquanto le 50 e a etiqueta que nao descreve o conjunto,
 * o defeito mais repetido deste projeto.
 */
export const TETO_DA_LISTA_QUENTE = Math.floor(numeroDoAmbiente('CACA_TETO_QUENTE', process.env.CACA_TETO_QUENTE, 50));

/**
 * Os que cabem no teto, e quantos ficaram fora.
 *
 * Pura e exportada para poder ser testada: um `slice` solto no meio do laco
 * quente e o tipo de corte que ninguem revisa depois.
 */
export function cabemNoCiclo(quentes: string[], teto = TETO_DA_LISTA_QUENTE): { lidos: string[]; ficaramFora: number } {
    if (!Number.isFinite(teto) || teto <= 0 || quentes.length <= teto) {
        return { lidos: quentes, ficaramFora: 0 };
    }
    return { lidos: quentes.slice(0, teto), ficaramFora: quentes.length - teto };
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

/**
 * O resultado da varredura, e a razao de nao ser so a lista.
 *
 * `faixasLidas` sao as faixas que voltaram SEM erro. O cache precisa delas para
 * saber ate onde pode avancar `ultimoBloco` sem gravar um buraco permanente: se
 * a janela do meio falhou e o cache avanca por cima dela, o proximo boot comeca
 * depois do buraco e ninguem volta nunca.
 */
export interface VarreduraDeDevedores {
    devedores: string[];
    faixasLidas: Array<[number, number]>;
    faixasQueFalharam: number;
    de: number;
    ate: number;
    /** Sobrou história por ler porque o orçamento de tempo acabou. */
    cortadaPeloTempo: boolean;
}

/**
 * O menor pedaço que ainda vale tentar antes de desistir de uma faixa.
 *
 * `PEDACO` é o tamanho da PRIMEIRA tentativa. Quando ela falha a faixa é
 * partida ao meio e tentada de novo, até aqui.
 *
 * O número existe porque os dois provedores têm tetos diferentes e MEDIDOS: o
 * RPC de produção dela aceita 10.000 (deduzido do censo rodando com faixas de
 * 10.000 e zero falhas). Um `PEDACO` cravado serve a um e trai o outro — e trai
 * do pior jeito possível: todas as faixas falham, a lista volta VAZIA, e o log
 * diz "varredura concluída, 0 devedores", que é ausência com cara de resposta.
 *
 * E ERA 2000, pelo teto medido do `mainnet.base.org` em 2026-10-02. Em
 * 2026-10-06 o mesmo provedor respondeu `eth_getLogs is limited to a 500 range`:
 * ele APERTOU o teto em quatro dias. Com o piso em 2.000 a descida parava acima
 * do que o provedor aceitava e devolvia zero devedores — exatamente o defeito
 * que a sondagem existe para evitar, criado pelo piso dela.
 *
 * A lição é sobre o número, não sobre o provedor: teto de provedor é coisa que
 * MUDA, então o piso tem de ser baixo o bastante para a descida alcançar
 * qualquer teto plausível. 250 é metade do menor teto que a Base já anunciou.
 *
 * O custo, contado passo a passo a partir de `PEDACO` 10.000 contra um provedor
 * de teto 500: 10.000, 5.000, 2.500, 1.250, 625 falham e 312 passa — SEIS
 * sondagens, uma vez por processo, e depois a varredura inteira já nasce no
 * tamanho certo. Contra o RPC de produção (teto 10.000) é UMA.
 */
export const PEDACO_MINIMO = 250;

/**
 * Os tamanhos a sondar, do pedido ate o piso, partindo ao meio.
 *
 * Exportada porque DOIS lugares precisam dela — o cacador e a ferramenta da
 * REGRA 0 — e porque uma regra em dois lugares e a regra 3 deste projeto. Em
 * 2026-10-06 o `mostrarAFila` tinha o 2.000 cravado e devolveu 205 de 205
 * janelas falhadas, cobertura 0%, na ferramenta que existe justamente para
 * pegar esse tipo de coisa antes do deploy.
 */
export function tamanhosASondar(pedido: number, piso: number): number[] {
    const fora: number[] = [];
    let t = Math.max(piso, pedido);
    for (;;) {
        fora.push(t);
        if (t <= piso) return fora;
        t = Math.max(piso, Math.floor(t / 2));
    }
}

/** O maior tamanho de faixa que ESTE provedor aceitou, medido uma vez por processo. */
let pedacoMedido: number | null = null;

/**
 * Publica o teto medido do provedor. SEMPRE, e nao so quando a varredura e grande.
 *
 * Existe por um buraco achado em 2026-10-06, quando ela perguntou como resolver a
 * falta de um segundo RPC: a sondagem ja media o teto, mas quem imprimia era o log
 * de "Juntando historico", que so sai com mais de 10 faixas. Num boot com cache a
 * varredura e de um punhado de blocos — entao ela plugaria um `RPC_URL_2` novo e
 * NUNCA saberia o que ele aguenta. Trocar de provedor as cegas e exatamente o que
 * a escada existe para nao fazer.
 *
 * E o numero tem de aparecer porque ele MUDA: o `mainnet.base.org` servia 2.000
 * blocos em 02/10 e 500 em 06/10, medido nos dois dias.
 */
function anunciarPedaco(pedaco: number, tentativas: number, bateuNoPiso: boolean): void {
    log.info('[RPC] Teto de eth_getLogs deste provedor, MEDIDO agora.', {
        provedor: hostDoRpc(rpc),
        aceita: `${pedaco.toLocaleString('pt-BR')} blocos por chamada`,
        pedi: PEDACO,
        sondagens: tentativas,
        oQueIssoCusta: pedaco >= PEDACO
            ? 'nenhum desconto: a varredura vai no tamanho que pedi'
            : `${(PEDACO / pedaco).toFixed(1)}x mais chamadas que o pedido para cobrir a mesma história`,
        // Sem esta linha, "o provedor é limitado" fica igual a "o provedor
        // recusou tudo e eu desci até o piso sem nunca ter sucesso".
        atencao: bateuNoPiso
            ? `NENHUMA sondagem passou, nem a de ${PEDACO_MINIMO}: estou usando o piso no escuro. `
              + 'Se as faixas falharem, a lista de devedores volta VAZIA — confira o próximo log'
            : 'medido com resposta boa do provedor',
    });
}

/**
 * Mede o teto de `eth_getLogs` do provedor em vez de adivinhá-lo.
 *
 * Quatro chamadas no pior caso, uma vez por processo, e depois toda a varredura
 * usa o tamanho certo. Sem isto, a varredura profunda de 48 milhões de blocos
 * ou paga 5x mais chamadas do que precisa (faixa de 2.000 num provedor que
 * aceita 10.000) ou falha inteira e devolve zero.
 *
 * Uma falha de rede passageira na sondagem é lida como teto menor, e o erro
 * então é para o lado seguro: mais chamadas, nunca menos cobertura.
 */
async function descobrirPedaco(topo: number): Promise<{ pedaco: number; tentativas: number }> {
    if (pedacoMedido !== null) return { pedaco: pedacoMedido, tentativas: 0 };
    const escada = tamanhosASondar(PEDACO, PEDACO_MINIMO);
    let passo = 0;
    let tamanho = escada[0]!;
    let tentativas = 0;
    for (;;) {
        tentativas += 1;
        const a = Math.max(0, topo - tamanho + 1);
        try {
            await chamar<Array<{ topics: string[] }>>('eth_getLogs', [
                {
                    address: REDE.pool,
                    fromBlock: `0x${a.toString(16)}`,
                    toBlock: `0x${topo.toString(16)}`,
                    topics: [TOPIC_BORROW],
                },
            ]);
            pedacoMedido = tamanho;
            anunciarPedaco(tamanho, tentativas, false);
            return { pedaco: tamanho, tentativas };
        } catch {
            passo += 1;
            if (passo >= escada.length) {
                pedacoMedido = PEDACO_MINIMO;
                anunciarPedaco(PEDACO_MINIMO, tentativas, true);
                return { pedaco: PEDACO_MINIMO, tentativas };
            }
            tamanho = escada[passo]!;
        }
    }
}

async function juntarDevedores(topo: number, blocoInicial?: number): Promise<string[]> {
    return (await varrerDevedores(topo, blocoInicial)).devedores;
}

/**
 * Lê uma faixa, e quando o provedor recusa por tamanho, parte ao meio e insiste.
 *
 * Devolve as SUBFAIXAS que deram certo, e não um "deu certo" só: se metade da
 * faixa foi lida e a outra metade não, o cache tem de saber exatamente qual
 * metade — é disso que depende a fronteira sem buraco.
 */
async function lerFaixaPartindoSePreciso(
    a: number,
    b: number,
    vistos: Set<string>,
): Promise<{ lidas: Array<[number, number]>; falhas: number }> {
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
        return { lidas: [[a, b]], falhas: 0 };
    } catch {
        // Faixa de tamanho mínimo que falha é falha de verdade: partir mais não
        // ajudaria e só gastaria chamadas.
        if (b - a + 1 <= PEDACO_MINIMO) return { lidas: [], falhas: 1 };
        const meio = a + Math.floor((b - a) / 2);
        const esquerda = await lerFaixaPartindoSePreciso(a, meio, vistos);
        const direita = await lerFaixaPartindoSePreciso(meio + 1, b, vistos);
        return {
            lidas: [...esquerda.lidas, ...direita.lidas],
            falhas: esquerda.falhas + direita.falhas,
        };
    }
}

async function varrerDevedores(
    topo: number,
    blocoInicial?: number,
    opcoes: {
        /** Para de ler quando passar disto, salvando o que já leu. 0 = sem teto. */
        orcamentoMs?: number;
        /** 'tras' lê do bloco mais novo para o mais velho (a varredura profunda). */
        ordem?: 'frente' | 'tras';
        /** Silencia os logs de progresso (a coleta periódica não precisa deles). */
        calada?: boolean;
    } = {},
): Promise<VarreduraDeDevedores> {
    const vistos = new Set<string>();
    const faixasLidas: Array<[number, number]> = [];
    const inicio = blocoInicial !== undefined ? Math.max(0, blocoInicial) : Math.max(0, topo - BLOCOS + 1);
    const medida = await descobrirPedaco(topo);
    const todas = faixasDeBlocos(inicio, topo, medida.pedaco);
    const faixas = opcoes.ordem === 'tras' ? [...todas].reverse() : todas;
    const orcamentoMs = opcoes.orcamentoMs ?? 0;
    const comecouEm = Date.now();
    let falhas = 0;
    let cortadaPeloTempo = false;
    const CONCORRENCIA = 5;

    if (faixas.length > 10 && !opcoes.calada) {
        const lotes = Math.ceil(faixas.length / CONCORRENCIA);
        const minutos = ((lotes * (PAUSA_MS + 700)) / 60_000).toFixed(1);
        log.info('Juntando histórico de devedores (Modo Turbo - Multithread).', {
            faixas: faixas.length,
            estimativa: `~${minutos} minutos`,
            velocidade: `${CONCORRENCIA} chamadas em paralelo`,
            pedaco: medida.tentativas > 0
                ? `${medida.pedaco} blocos por chamada (MEDIDO em ${medida.tentativas} sondagem(ns); pedi ${PEDACO})`
                : `${medida.pedaco} blocos por chamada`,
            ordem: opcoes.ordem === 'tras' ? 'do mais NOVO para o mais velho' : 'do mais velho para o mais novo',
            orcamento: orcamentoMs > 0
                ? `${(orcamentoMs / 1000).toFixed(0)}s — o que não couber fica para o próximo boot, do cache`
                : 'sem teto de tempo',
        });
    }

    let lidas = 0;
    for (let i = 0; i < faixas.length; i += CONCORRENCIA) {
        // O teto de tempo é o que impede o boot de ficar uma hora cego. Ele é
        // conferido ANTES do lote, nunca no meio: cortar no meio de um lote
        // deixaria faixas pela metade sem ninguém saber quais.
        if (orcamentoMs > 0 && Date.now() - comecouEm > orcamentoMs) {
            cortadaPeloTempo = true;
            break;
        }
        const lote = faixas.slice(i, i + CONCORRENCIA);

        const resultados = await Promise.all(
            lote.map(([a, b]) => lerFaixaPartindoSePreciso(a, b, vistos)),
        );
        for (const r of resultados) {
            faixasLidas.push(...r.lidas);
            falhas += r.falhas;
        }

        lidas += lote.length;
        if (faixas.length > 10 && !opcoes.calada && (lidas % (CONCORRENCIA * 5) === 0 || lidas === faixas.length)) {
            log.info('Progresso da varredura acelerada.', {
                lidas: `${lidas} de ${faixas.length}`,
                devedoresAteAgora: vistos.size,
                decorrido: `${((Date.now() - comecouEm) / 1000).toFixed(0)}s`,
            });
        }
        if (i + CONCORRENCIA < faixas.length) {
            await dormir(PAUSA_MS);
        }
    }
    return {
        devedores: [...vistos],
        faixasLidas,
        faixasQueFalharam: falhas,
        de: inicio,
        ate: topo,
        cortadaPeloTempo,
    };
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

/**
 * O par a liquidar de cada devedor, lido das reservas.
 *
 * `ler` existe para que `src/mostrarAFila.ts` rode ESTA funcao — a mesma que o
 * cacador roda — contra a Base, com o proprio transporte dele. Sem isso a
 * ferramenta que existe para provar o comportamento reimplementaria o
 * comportamento, e provaria a copia.
 */
export async function montarAlvos(
    devedores: string[],
    moedas: string[],
    dataProvider: string,
    precos: Map<string, Decimal>,
    casas: Map<string, number>,
    ler: (cs: Array<{ alvo: string; dados: string }>) => Promise<Array<string | null>> = lerEmLote,
): Promise<Alvo[]> {
    const chamadas = devedores.flatMap((d) =>
        moedas.map((m) => ({ alvo: dataProvider, dados: codificarUserReserveData(m, d) })),
    );
    const rs = await ler(chamadas);

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

/** O que precisa ser desligado quando `principal()` termina, de que jeito for. */
const processoEncerrando: Array<() => void> = [];
function desligarTudo(): void {
    while (processoEncerrando.length > 0) {
        try { processoEncerrando.pop()!(); } catch { /* desligar nao pode falhar */ }
    }
}

async function principal(): Promise<'parar' | void> {
    // O laco externo recria principal() a cada tropeco. Sem isto, cada
    // reinicio abandonava um WebSocket vivo com cadeia de reconexao eterna:
    // em meses, um socket e um relogio a mais por tropeco de rede.
    desligarTudo();
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

    // A escada já tenta os degraus sozinha dentro de `chamar`, então aqui basta
    // UMA pergunta: se o primário estiver fora, ela troca e responde pelo
    // secundário. O laço que existia aqui era o failover INTEIRO do bot, e só
    // rodava no boot.
    let topo = 0;
    try {
        topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
    } catch { /* a escada já tentou todos; o laço de fora repete */ }
    log.info('[RPC] A escada de provedores.', {
        quantos: ESCADA.quantos(),
        usando: hostDoRpc(rpc),
        emOrdem: `degrau ${ESCADA.indice() + 1}`,
        trocaApos: `${process.env.CACA_FALHAS_PARA_TROCAR ?? '2'} falhas de transporte seguidas`,
        voltaAoPrimarioEm: `${Number(process.env.CACA_VOLTAR_AO_PRIMARIO_MS ?? '300000') / 1000}s`,
        comoAdicionar: ESCADA.quantos() > 1
            ? 'já tem redundância'
            : 'defina RPC_URL_2 no Railway — com um só provedor, ele caindo é o bot cego',
    });
    if (!topo) return;

    // A carteira nasce DEPOIS de saber qual RPC responde.
    //
    // Antes era o contrario, e dava dois jeitos de morrer. Se o primeiro RPC
    // estivesse fora, `sync()` rejeitava, a excecao subia, o laco externo
    // dormia 1s e reiniciava — para sempre, sem NUNCA chegar no failover, que
    // ficava depois do ponto que estourava. E no caso sutil o sync passava e o
    // resto do bot migrava para outro RPC: dai `chamar()` lia de um no vivo
    // enquanto getBalance e sendTransaction falavam com um no morto. O bot
    // media tudo certo e nao enviava nada.
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
    const laudos: Array<{ veredicto: string }> = [];
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
        laudos.push(laudo);
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
        // 'parar' encerra o laco externo PARA SEMPRE. Isso so pode acontecer
        // quando o problema e mesmo de configuracao: um cofre que respondeu, e
        // respondeu errado. Se ninguem respondeu, foi a rede — e rede volta.
        // Antes, dois segundos de RPC fora no boot paravam o bot de vez com
        // uma mensagem mandando o humano procurar no lugar errado.
        if (!laudos.some((l) => l.veredicto !== 'inconclusivo')) {
            log.warn('Não consegui LER o cofre de nenhum caçador. Isso é rede, não configuração — tento de novo.', {
                cofreEsperado: COFRE_ESPERADO,
            });
            return;
        }
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
    /**
     * A saude de cada um da brasa ao longo do tempo.
     *
     * Existe porque o alvo mais fragil que sobrou depois do piso de tamanho tem
     * garantia USDC contra divida USDC, e nesse caso o preco CANCELA na conta da
     * saude: ela cai so por juro, numa reta, sem o mercado fazer nada. Reta da
     * para extrapolar — e ai o alvo deixa de ser surpresa e passa a ter hora.
     * A leitura ja acontece a cada ciclo; guardar nao custa CU nenhum.
     */
    const historicoDeSaude = new Map<string, Amostra[]>();
    /**
     * O ETA da proxima chegada por juro, em ms, ou `null` se nenhuma projeta.
     *
     * Vem com cache porque a postura e reavaliada a cada olhada de mercado — uma
     * por segundo — e ajustar 233 retas a cada segundo queimaria CPU para
     * responder sempre a mesma coisa: o ETA anda em dias, nao em segundos.
     */
    /**
     * A tabela "o que uma queda de X% renderia", da ultima varredura completa.
     *
     * Guardada porque ela so podia ser calculada na varredura completa — que
     * roda de hora em hora — e por isso aparecia numa linha de log sozinha, a
     * cada sessenta minutos. O numero que decide a estrategia (esperar o
     * mercado ou ir cacar em outro protocolo) ficava inalcancavel na pratica:
     * quem le o log copia a linha do ciclo ou a do ensaio, nao uma linha que
     * passou uma hora atras. Um numero que ninguem consegue ler nao informa
     * nada, mesmo estando correto.
     */
    let tabelaDeQuedas = 'ainda não medida';
    /** A gêmea: o que uma ALTA da dívida renderia — a via SHORT, medida em 2026-09-29. */
    let tabelaDeAltas = 'ainda não medida';
    /** De que lado da rua estão os alvos. Sem esta linha o conserto é invisível. */
    let bussola = 'ainda não medida';
    /** Calculado uma vez: depende so da profundidade medida, que nao muda em memoria. */
    let tetoDoPool = '';
    let chegadaEmMs: number | null = null;
    let chegadaCalculadaEm = 0;
    const VALIDADE_DA_CHEGADA_MS = Number(process.env.CACA_VALIDADE_CHEGADA_MS ?? '60000');
    function msAteAProximaChegada(): number | null {
        const agora = Date.now();
        if (agora - chegadaCalculadaEm < VALIDADE_DA_CHEGADA_MS) {
            // O tempo que passou desde a conta ja encurtou a espera. Devolver o
            // valor parado faria o bot ficar 'atento' um minuto a mais do que o
            // devido — e, no fim da contagem, nunca chegar a zero.
            return chegadaEmMs === null ? null : Math.max(0, chegadaEmMs - (agora - chegadaCalculadaEm));
        }
        const fila = oQueVemPorAi(historicoDeSaude, 7 * 86_400_000);
        chegadaEmMs = fila.length > 0 ? fila[0]!.emMs : null;
        chegadaCalculadaEm = agora;
        return chegadaEmMs;
    }
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
    let fonteDoPreco = 'nenhuma';
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
    /**
     * Quantas derrotas seguidas antes de PARAR de gastar.
     *
     * Nao existia nenhum. O lance cravava em 80% a partir da quarta derrota e
     * ficava la para sempre; somado a um nonce furado (que faz todo recibo
     * virar 'sumiu'), o bot ofereceria 80% do lucro em TODO tiro,
     * indefinidamente, drenando a carteira com o log dizendo "subo o lance no
     * proximo". Subir o lance e resposta para perder a corrida; nao e resposta
     * para estar quebrado.
     */
    const DERROTAS_ATE_PARAR = Number(process.env.CACA_DERROTAS_ATE_PARAR ?? '8');
    let disjuntorAberto = false;
    /**
     * O gas que resta, em wei. Lido de tempos em tempos, nao a cada tiro.
     *
     * Precisa existir porque a gorjeta e paga mesmo quando a transacao
     * reverte: um lance de 80% sobre um lucro de US$300 custa US$18 numa
     * derrota, e a carteira tem US$14. Um bot sem gas nao perde uma
     * liquidacao — perde todas as seguintes, e em silencio, porque parar de
     * conseguir enviar nao levanta erro nenhum.
     */
    let saldoDeGasWei = 0n;
    let saldoLidoEm = 0;
    let saldoJaLido = false;
    // Uma politica, lida uma vez. Antes cada montagem relia o ambiente por
    // conta propria, e foi assim que uma delas ficou com cinco campos de nove.
    const POLITICA = politicaDoTiro();
    const FRACAO_DO_SALDO_POR_TIRO = POLITICA.fracaoBaseDoSaldo;
    /** O teto do risco quando o premio e muito maior que o saldo. */
    const FRACAO_MAXIMA_DO_SALDO = POLITICA.fracaoMaximaDoSaldo;
    const fracaoBase = POLITICA.fracaoBaseDoLucro;

    /**
     * O tiro de prova: UM tiro, de proposito no prejuizo, para saber se funciona.
     *
     * A trava mora na BLOCKCHAIN, nao em memoria. O container do Railway
     * reinicia varias vezes por dia, e uma trava em memoria voltaria armada a
     * cada reinicio — tres reinicios e o gas acaba. O nonce da carteira so sobe
     * quando uma transacao sai, nunca volta, e e lido no boot de graca.
     */
    const PROVA_LIGADA = process.env.CACA_TIRO_DE_PROVA === '1';
    const PROVA_ATE_NONCE = process.env.CACA_TIRO_DE_PROVA_ATE_NONCE === undefined
        ? -1
        : Number(process.env.CACA_TIRO_DE_PROVA_ATE_NONCE);
    function provaAgora(): { armado: boolean; porque: string } {
        return tiroDeProvaArmado({
            ligado: PROVA_LIGADA,
            nonceAtual: nonceManager?.nonceConhecido() ?? -1,
            ateNonce: PROVA_ATE_NONCE,
        });
    }

    /**
     * Alvos montados ANTES do oraculo escrever.
     *
     * A Aave nao deixa liquidar antes de o preco on-chain mudar, entao ver
     * antes nao adianta para arrematar antes. Mas adianta para chegar pronto:
     * montar o alvo custa uma ida a rede, e essa ida pode acontecer enquanto o
     * mercado ainda esta caindo. Quando o bloco chega, so resta mandar.
     */
    const alvosArmados = new Map<string, Alvo>();
    let armadoEm = 0;
    /** Quando a ULTIMA tentativa aconteceu, deu certo ou nao. Freia repeticao. */
    let tentouArmarEm = 0;
    /** Impede armar em cima de armar: `void armar()` nao espera o anterior. */
    let armando = false;
    // Base faz um bloco a cada 2 segundos. E daqui que sai "em quantos blocos".
    const MS_POR_BLOCO = numeroDoAmbiente('CACA_MS_POR_BLOCO', process.env.CACA_MS_POR_BLOCO, 2000);
    // Com quantos blocos de antecedencia mandar. Dois blocos sao 4 segundos: o
    // tempo de a transacao entrar. Mais que isso aumenta a chance de reverter.
    const JANELA_DE_BLOCOS = numeroDoAmbiente(
        'CACA_JANELA_DE_BLOCOS', process.env.CACA_JANELA_DE_BLOCOS, 2);
    const QUANTOS_ARMAR = Number(process.env.CACA_QUANTOS_ARMAR ?? '8');
    const VALIDADE_ARMADO_MS = Number(process.env.CACA_VALIDADE_ARMADO_MS ?? '5000');

    async function armar(): Promise<void> {
        if (armando) return;
        const quem = quemArmar(brasa, QUANTOS_ARMAR);
        if (quem.length === 0) return;
        armando = true;
        try {
            const prontos = await montarAlvos(quem, moedas, dataProvider!, precos, casas);
            for (const a of prontos) lembrarAVia(a.devedor, viaDeQuebra(a.garantia, a.divida));
            alvosArmados.clear();
            for (const a of prontos) alvosArmados.set(a.devedor.toLowerCase(), a);
            armadoEm = Date.now();
            tentouArmarEm = armadoEm;
        } catch {
            // Armar e vantagem, nao obrigacao: se falhar, o caminho normal
            // monta o alvo na hora como sempre fez.
            //
            // Mas o mapa velho NAO pode sobreviver: mantê-lo faria o bot usar
            // dividas obsoletas, e `armadoEm` intacto faria o log dizer
            // `armadoHa: ~0ms` sobre um retrato de horas atras.
            alvosArmados.clear();
            // A hora da TENTATIVA e marcada assim mesmo, senao armar() repete
            // a cada segundo em vez de a cada cinco — 67M CUs/mes num teto
            // de 20M, em silencio.
            tentouArmarEm = Date.now();
        } finally {
            armando = false;
        }
    }

    // Ser AVISADO do bloco novo em vez de perguntar. Perguntar a cada 200ms
    // significa que um bloco nascido logo depois da pergunta so e visto na
    // seguinte — e nessa corrida isso e a diferenca entre entrar no bloco N+1
    // e no N+2. Se a conexao nao abrir ou cair, o bot volta a perguntar.
    const urlDeBlocos = wsDoHttp(rpc);
    const ouvinte = urlDeBlocos
        ? new OuvinteDeBlocos(urlDeBlocos, (aviso) => log.warn(`[BLOCOS] ${aviso}`))
        : null;
    ouvinte?.abrir();
    processoEncerrando.push(() => ouvinte?.fechar());
    log.info('Aviso de bloco novo por WebSocket.', {
        ligado: ouvinte !== null,
        porQue: ouvinte === null ? 'não consegui derivar o endereço wss do RPC; sigo perguntando' : 'reajo quando o bloco nasce, não quando eu pergunto',
    });
    let posturaAnterior: Postura = 'dormindo';
    /** As vagas que sobram no multicall do ciclo depois do bloco e dos precos. */
    const vagasNaBrasa = Math.max(0, CHAMADAS_POR_MULTICALL - moedas.length - 2);

    // ========================================================================
    // O CACHE PERSISTENTE, pedido dela em 2026-10-02.
    //
    // O buraco que ele tapa: o placar acusou 11 liquidacoes com "nem sabia" —
    // alvos invisiveis porque a janela de 30 dias (`CACA_BLOCOS`) nunca tinha
    // perguntado por eles.
    //
    // Medido em 2026-10-02: o Pool da Base nasceu no bloco 2.357.134, 3,15 anos
    // atras. Varrer tudo com `PEDACO=10000` custa 4.972 chamadas = 129.272 CUs —
    // 0,65% do teto de 20M/mes. UMA vez e barato; a cada boot, a 10 boots/dia,
    // sao 38,8M e o dobro do teto. Por isso o cache, e por isso ele PRECISA de
    // volume: o sistema de arquivos do Railway e efemero, e cache que o deploy
    // apaga e placebo caro — a varredura volta e o log diz que cacheou.
    // ========================================================================
    const nascimento = NASCIMENTO_DO_POOL[REDE_ESCOLHIDA] ?? 0;
    const estadoDoCache = await lerCache(CAMINHO_DO_CACHE, REDE_ESCOLHIDA, REDE.pool);
    // A VARREDURA ACONTECE EM DUAS PARTES, e a ordem é o que separa um boot de
    // segundos de um boot de uma hora.
    //
    // 1) A FRENTE, bloqueante: os blocos que faltam entre o cache e o topo. Com
    //    cache é um punhado de blocos; sem cache é a janela de 30 dias de antes,
    //    que já era o comportamento aceito. O bot só começa a caçar depois
    //    desta, porque caçar sem a lista recente é caçar o vazio.
    //
    // 2) O FUNDO, para trás e com teto de tempo: do que o cache já cobre em
    //    direção ao nascimento do Pool. É aqui que moram os 3 anos, e é por isso
    //    que ele desce do mais novo para o mais velho — quem tomou emprestado na
    //    semana passada ainda deve; quem tomou em 2023 já pagou ou foi
    //    liquidado, e se voltar a tomar emprestado o `Borrow` novo o traz de
    //    volta pela parte 1.
    //
    // Com `CACA_CACHE_FUNDO_MS=0` o fundo roda inteiro de uma vez: ~21 minutos
    // de boot cego UMA vez, e cobertura total gravada no volume para sempre.
    const ORCAMENTO_DO_FUNDO_MS = numeroDoAmbiente(
        'CACA_CACHE_FUNDO_MS', process.env.CACA_CACHE_FUNDO_MS, 300_000);
    const ORCAMENTO_DO_FUNDO_NA_COLETA_MS = numeroDoAmbiente(
        'CACA_CACHE_COLETA_MS', process.env.CACA_CACHE_COLETA_MS, 30_000);

    const comecaEm = estadoDoCache.usavel
        ? deOndeComecar(estadoDoCache, nascimento)
        : Math.max(nascimento, topo - BLOCOS + 1);
    log.info('[CACHE] A memória de devedores que sobrevive ao deploy.', {
        caminho: CAMINHO_DO_CACHE,
        estado: estadoDoCache.usavel ? 'USÁVEL' : 'NÃO uso',
        porque: estadoDoCache.porque,
        cobertura: comoEstaACobertura(
            estadoDoCache.usavel ? estadoDoCache.cache : null, nascimento, topo),
        nascimentoDoPool: nascimento,
        agoraVarroDe: `${comecaEm} até ${topo} (${(topo - comecaEm + 1).toLocaleString('pt-BR')} blocos)`,
        depoisDesco: ORCAMENTO_DO_FUNDO_MS > 0
            ? `até ${(ORCAMENTO_DO_FUNDO_MS / 1000).toFixed(0)}s descendo para o nascimento (CACA_CACHE_FUNDO_MS)`
            : 'o fundo INTEIRO, sem teto de tempo — este boot vai demorar, e é a última vez',
        seOVolumeNaoEstiverMontado: 'cada boot paga tudo de novo — confira o `gravou` abaixo',
    });

    const varrido = await varrerDevedores(topo, comecaEm);
    // O `ultimoBloco` só avança até onde NÃO há buraco. Avançar por cima de uma
    // janela que falhou gravaria o buraco para sempre.
    let cobertoAte = ateOndeSemBuraco(comecaEm, varrido.faixasLidas);
    if (!estadoDoCache.usavel && varrido.faixasLidas.length > 0) {
        // Sem cache não havia fronteira anterior: o que foi lido agora É a
        // fronteira, e ela começa no primeiro bloco desta varredura.
        cobertoAte = Math.max(cobertoAte, comecaEm - 1);
    }
    let juntos = juntarDevedoresDoCache(
        estadoDoCache.usavel ? estadoDoCache.cache.devedores : {},
        varrido.devedores,
        topo,
    );
    let blocoInicialDoCache = estadoDoCache.usavel ? estadoDoCache.cache.blocoInicial : comecaEm;
    let ultimoBlocoDoCache = Math.max(
        cobertoAte, estadoDoCache.usavel ? estadoDoCache.cache.ultimoBloco : comecaEm - 1);

    // ------------------------------------------------------------------ o fundo
    if (blocoInicialDoCache > nascimento) {
        const antesDeDescer = blocoInicialDoCache;
        const fundo = await varrerDevedores(blocoInicialDoCache - 1, nascimento, {
            orcamentoMs: ORCAMENTO_DO_FUNDO_MS,
            ordem: 'tras',
        });
        // Para trás a fronteira é o MENOR bloco acima do qual tudo foi lido: ela
        // desce de `blocoInicial` em direção ao nascimento, e só desce por cima
        // de faixas contíguas. Uma faixa que falhou no meio para a descida ali.
        const desceuAte = deOndeSemBuraco(blocoInicialDoCache - 1, fundo.faixasLidas);
        blocoInicialDoCache = Math.min(blocoInicialDoCache, desceuAte);
        juntos = juntarDevedoresDoCache(juntos, fundo.devedores, blocoInicialDoCache);
        log.info('[CACHE] Fundo do histórico.', {
            desci: `do bloco ${antesDeDescer} para o ${blocoInicialDoCache} — `
                + `${(antesDeDescer - blocoInicialDoCache).toLocaleString('pt-BR')} blocos `
                + `(~${Math.round(((antesDeDescer - blocoInicialDoCache) * 2) / 86400)} dias) de história nova`,
            achei: `${fundo.devedores.length.toLocaleString('pt-BR')} devedores nesta descida`,
            faixasQueFalharam: fundo.faixasQueFalharam,
            parou: fundo.cortadaPeloTempo
                ? `o orçamento de ${(ORCAMENTO_DO_FUNDO_MS / 1000).toFixed(0)}s acabou — o resto fica para `
                  + `o próximo boot e para as coletas (a cada ${MIN_COLETA} min)`
                : blocoInicialDoCache <= nascimento
                    ? 'CHEGUEI AO NASCIMENTO DO POOL: cobertura total, 100% da história'
                    : 'parei numa faixa que falhou; o próximo boot retoma daqui',
        });
    }

    const gravacao = await gravarCache(CAMINHO_DO_CACHE, {
        versao: VERSAO_DO_CACHE,
        rede: REDE_ESCOLHIDA,
        pool: REDE.pool,
        blocoInicial: blocoInicialDoCache,
        ultimoBloco: ultimoBlocoDoCache,
        devedores: juntos,
    });
    log.info(gravacao.gravou ? '[CACHE] Gravado.' : '[CACHE] NÃO GRAVOU — o próximo boot vai pagar tudo de novo.', {
        resultado: gravacao.porque,
        cobertura: comoEstaACobertura(
            { versao: VERSAO_DO_CACHE, rede: REDE_ESCOLHIDA, pool: REDE.pool,
              blocoInicial: blocoInicialDoCache, ultimoBloco: ultimoBlocoDoCache, devedores: juntos },
            nascimento, topo),
        faixasQueFalharam: varrido.faixasQueFalharam,
        cobertoSemBuracoAte: cobertoAte,
        // Sem esta linha, "o cache nao avancou porque nada falhou" fica
        // indistinguivel de "o cache nao avancou porque TUDO falhou".
        oQueIssoQuerDizer: varrido.faixasQueFalharam === 0
            ? 'nenhuma janela falhou: a cobertura é contígua'
            : `${varrido.faixasQueFalharam} janelas falharam, e o cache NÃO avançou por cima delas — `
              + 'o próximo boot relê daquele ponto',
    });

    /** O que o cache guarda, vivo na memória — a fonte da lista e do que se grava. */
    let memoriaDoCache = juntos;
    let devedores = Object.keys(juntos).filter(d => !isDevedorIgnorado(d));
    /**
     * Em que bloco cada devedor foi visto tomando emprestado por último.
     *
     * JÁ FOI a régua do esquecimento, por idade, e isso virou contradição no dia
     * em que o cache passou a guardar 3 anos: a regra apagava justamente o que o
     * cache tinha ido buscar, e apagava sem olhar — um devedor de 2024 com
     * dívida viva hoje saía da lista por ser velho.
     *
     * Agora o esquecimento é por ESTADO (`esquecerQuemNaoDeveMais`, alimentado
     * pela varredura completa, que já mede dívida zero de graça), e este mapa
     * serve ao que ele sempre deveria ter servido: dizer QUANDO cada endereço
     * apareceu, para o cache gravar a data certa.
     */
    const vistoEm = new Map<string, number>(Object.entries(juntos));
    /** Grava o que está na memória. Chamado quando a memória muda de verdade. */
    const regravarCache = async (motivo: string): Promise<void> => {
        const g = await gravarCache(CAMINHO_DO_CACHE, {
            versao: VERSAO_DO_CACHE,
            rede: REDE_ESCOLHIDA,
            pool: REDE.pool,
            blocoInicial: blocoInicialDoCache,
            ultimoBloco: ultimoBlocoDoCache,
            devedores: memoriaDoCache,
        });
        (g.gravou ? log.info : log.warn)(
            g.gravou ? '[CACHE] Regravado.' : '[CACHE] NÃO regravei.',
            { motivo, resultado: g.porque },
        );
    };

    let ultimaColeta = Date.now();
    let ultimoBlocoLido = topo; 
    let ultimoBlocoColeta = topo;
    /**
     * Quantas vezes cada alvo ja foi tentado, e QUANDO.
     *
     * Era so um contador que nunca zerava nem expirava — e que era
     * incrementado tambem no SUCESSO. A Aave so deixa cobrir 50% da divida,
     * entao o mesmo devedor e liquidavel varias vezes: tres cacadas BEM
     * SUCEDIDAS no mesmo endereco o bloqueavam para sempre, sem log. O bot ia
     * se auto-paralisando, um devedor lucrativo por vez.
     */
    /**
     * Quando cada MOTIVO de recusa foi dito por último.
     *
     * A chave é motivo + saldo, de propósito: um saldo novo é um fato novo, e um
     * motivo novo também. Só a repetição literal cala.
     */
    const recusaJaDita = new Map<string, number>();
    const REPETIR_RECUSA_MS = numeroDoAmbiente(
        'CACA_REPETIR_RECUSA_MS', process.env.CACA_REPETIR_RECUSA_MS, 600_000);
    let recusasCaladas = 0;
    const falhasPorAlvo = new Map<string, { quantas: number; em: number }>();
    const ESQUECER_FALHA_MS = Number(process.env.CACA_ESQUECER_FALHA_MS ?? '3600000');
    /**
     * Teto de envios por JANELA, nao pela vida do processo.
     *
     * Era vitalicio e sem log: 25 envios que nunca chegaram a nada — nonce
     * furado, RPC morto — esgotavam a cota e o bot nunca mais mandava uma
     * transacao, continuando a escrever que estava cacando. Uma vez em meses,
     * e valia para sempre.
     */
    const JANELA_DE_ENVIOS_MS = Number(process.env.CACA_JANELA_ENVIOS_MS ?? '3600000');
    let enviados = 0;
    let janelaComecouEm = Date.now();

    // O saldo de gas lido AQUI, no boot, e nao so no primeiro tiro.
    //
    // Era lido de forma preguicosa — no ensaio em seco e no caminho quente — e
    // as duas coisas acontecem DEPOIS da primeira varredura completa. Resultado
    // no log de 17:22: o placar rodou com saldo zero, `faixaQueAtira` devolveu
    // `null` ("sem gas nao atira nada"), e o piso caiu no default de US$20 —
    // exatamente o numero que o conserto anterior foi feito para tirar de la.
    //
    // Uma ida a rede no boot, uma vez, para o resto do processo saber quanto
    // tem. Se falhar, `saldoJaLido` fica falso e quem depende dele continua
    // dizendo "nao sei" em vez de assumir zero.
    if (carteira !== null && donoCarteira !== null) {
        try {
            saldoDeGasWei = await (carteira.provider as JsonRpcProvider).getBalance(donoCarteira);
            saldoLidoEm = Date.now();
            saldoJaLido = true;
            log.info('Gás na conta_bot, lido no boot.', {
                saldo: `${new Decimal(saldoDeGasWei.toString()).dividedBy(1e18).toFixed(6)} ETH`,
                porQueAgora: 'sem isto o placar e a faixa de tiro nasciam sem saber quanto há',
            });
        } catch (e) {
            log.warn('Não consegui ler o gás no boot. Sigo sem saber, e quem depende disso vai dizer que não sabe.', {
                erro: (e as Error).message,
            });
        }
    }

    log.info('Operação Elite Iniciada. Patrulhando blocos com suborno dinâmico ligado.', { alvosRegistados: devedores.length });
    void quandoFoiAUltimaLiquidacao(topo);
    // O tiro em seco NAO pode sair daqui: a brasa so existe depois da primeira
    // varredura completa, e chamado aqui ele achava a lista vazia e desistia
    // dois segundos antes de ela ser preenchida.
    let jaEnsaiou = false;

    /**
     * Percorre o caminho de tiro INTEIRO, parando um passo antes de enviar.
     *
     * Existe porque em tres dias de producao esse caminho nunca rodou: sem
     * ninguem caindo, `montarAlvos`, a medicao, a leitura de saldo, a conta da
     * gorjeta e o freio do gas adiantado ficaram todos sem exercicio. Codigo
     * que nunca rodou nao e codigo que funciona — e o dia de descobrir isso
     * seria justamente o dia em que aparecesse a liquidacao que paga o mes.
     *
     * O alvo e o mais fragil da brasa, que NAO esta liquidavel: a Aave recusa
     * a cacada, o que e exatamente o que se quer. O que se testa e todo o
     * resto — e nada e enviado.
     */
    /**
     * Quanto cobrir deste alvo, em unidades cruas.
     *
     * Um lugar so. Eram seis chamadas espalhadas de `quantoPedirEmprestado`, e
     * seis lugares para esquecer o teto da fatia em um deles — exatamente o
     * tipo de coisa que passa em teste e falha no dia do tiro.
     */
    function cobrir(alvo: Alvo): bigint {
        return quantoPedirEmprestado(alvo.dividaCrua!, alvo.dividaUsd, coberturaOtima());
    }

    /**
     * Descobre o par (garantia/divida) dos candidatos do TOPO.
     *
     * Le so quem AINDA NAO SE SABE e esta dentro do degrau mais largo da tabela
     * de quedas — nao adianta saber o par de quem precisa cair 40%. O teto
     * existe porque `montarAlvos` custa uma leitura por reserva por devedor, e
     * sem ele uma varredura larga viraria uma rajada que o RPC publico barra.
     */
    async function resolverPares(medidos: Medida[]): Promise<void> {
        if (dataProvider === null) return;
        // O PONTO CEGO, medido no log dela do bloco 51985463:
        //
        //     48 LONG | 15 SHORT | 7 AMBAS | 67 imunes | 6559 AINDA NAO SEI
        //
        // 6.559 de 6.696 sem direcao mapeada — 98% da rede. A simulacao de
        // queda e de alta nao dizia nada sobre eles, e a medicao de 2026-09-29
        // mostrou que 20 das 28 liquidacoes por preco sao SHORT: a massa nao
        // mapeada e exatamente onde mora o lado que de fato morre.
        //
        // A causa era o corte de 10%: quem estava a mais de 10% de cair NUNCA
        // era perguntado. O padrao agora e SEM CORTE, e o teto por varredura
        // sobe de 150 para 600.
        //
        // Por que isto NAO entra nos 107ms do laco quente: `resolverPares` roda
        // dentro da VARREDURA, nao do ciclo. O ciclo quente le `[bloco, 15
        // precos, brasa]` num unico `eth_call` e nao passa por aqui. A varredura
        // ja gasta 34 multicalls; estes vao junto e so para quem ainda nao se
        // sabe, entao o custo cai a zero depois de a memoria encher — o log das
        // 18:18 provou que ela persiste entre varreduras.
        //
        // A 600 por varredura, 6.559 desconhecidos levam 11 varreduras. O log
        // diz quantos faltam a cada volta, para o progresso ser visivel em vez
        // de eu prometer que enche.
        const TETO = numeroDoAmbiente('CACA_PARES_A_RESOLVER', process.env.CACA_PARES_A_RESOLVER, 600);
        const ATE_QUEDA = numeroDoAmbiente(
            'CACA_PARES_ATE_QUEDA_PCT', process.env.CACA_PARES_ATE_QUEDA_PCT, Number.POSITIVE_INFINITY);
        const aResolver = medidos
            .filter((m) => oQueSeSabeDaVia(m.devedor) === undefined && m.queda.lessThanOrEqualTo(ATE_QUEDA))
            .sort((a, b) => a.queda.comparedTo(b.queda))
            .slice(0, Math.max(0, Math.floor(TETO)))
            .map((m) => m.devedor);
        if (aResolver.length === 0) {
            // Silencio NAO e resposta. Sem esta linha, "nada novo para resolver"
            // fica indistinguivel de "resolverPares nem rodou" ou "estourou" —
            // e foi exatamente o que aconteceu no log das 18:18, onde a linha
            // [PARES] simplesmente desapareceu e eu nao tinha como dizer se a
            // memoria estava funcionando ou se a funcao havia morrido.
            const dentro = medidos.filter((m) => m.queda.lessThanOrEqualTo(ATE_QUEDA)).length;
            log.info('[PARES] Nada novo para descobrir.', {
                dentroDoCorte: `${dentro} com queda até ${ATE_QUEDA}%, e o par de todos já é conhecido`,
                foraDoCorte: `${medidos.length - dentro} acima de ${ATE_QUEDA}% e NÃO foram perguntados`,
                porQue: 'a memória dos pares persiste entre varreduras — é isto que prova que ela persiste',
            });
            return;
        }
        // As TRÊS contas separadas, porque elas respondem coisas diferentes.
        //
        // A primeira versão publicou `jaSabia: medidos.length - aResolver.length`
        // e imprimiu `jaSabia: 6575` no log de produção das 17:41 — afirmando
        // conhecer o par de 6.575 devedores quando conhecia 121. Aquele número
        // é "todo o resto", e a maior parte do resto está simplesmente FORA do
        // corte de 10%: nunca foi perguntado, não é sabido. Etiqueta que não
        // descreve o conjunto, no log que eu tinha acabado de criar para
        // consertar exatamente esse tipo de erro.
        const dentroDoCorte = medidos.filter((m) => m.queda.lessThanOrEqualTo(ATE_QUEDA));
        const jaSabia = dentroDoCorte.filter((m) => oQueSeSabeDaVia(m.devedor) !== undefined).length;
        const naoCoubeNoTeto = dentroDoCorte.length - jaSabia - aResolver.length;
        try {
            const montados = await montarAlvos(aResolver, moedas, dataProvider, precos, casas);
            for (const a of montados) lembrarAVia(a.devedor, viaDeQuebra(a.garantia, a.divida));
            log.info('[PARES] Descobri de quem o preço derruba e de quem não derruba.', {
                pedi: aResolver.length,
                respondeu: montados.length,
                bussola: comoLerABussola(contarVias(montados.map((a) => ({
                    devedor: a.devedor, queda: new Decimal(0), dividaUsd: null,
                    via: viaDeQuebra(a.garantia, a.divida),
                })))),
                jaSabia: `${jaSabia} de ${dentroDoCorte.length} dentro do corte de ${ATE_QUEDA}%`,
                naoCoubeNoTeto: naoCoubeNoTeto > 0
                    ? `${naoCoubeNoTeto} ficaram para a próxima volta (teto de ${TETO} por varredura)`
                    : 'nenhum: o corte inteiro foi resolvido',
                foraDoCorte: `${medidos.length - dentroDoCorte.length} estão acima de ${ATE_QUEDA}% e NÃO foram perguntados`,
                porQue: 'sem isto os imunes a preço ocupam a frente da brasa e contaminam o maisPerto',
            });
        } catch (e) {
            // Falhar aqui NAO pode calar a varredura: sem par conhecido a
            // ordem volta a ser a de antes, que e pior mas nao e mentira.
            log.warn('[PARES] Não consegui descobrir os pares agora.', { erro: (e as Error).message });
        }
    }

    /**
     * Com que piso MEDIR o V2 — e nunca com o piso impossivel.
     *
     * Ver o comentario na chamada: o V2 repassa o piso ao router da Aerodrome,
     * que recusa antes de executar. No modo prova o piso e ZERO, que pede
     * apenas que o emprestimo seja pago; fora dele, o custo do tiro mais
     * barato, que e o limiar que `decidirTiro` vai comparar depois.
     */
    function pisoParaMedirV2(alvo: Alvo): bigint {
        if (provaAgora().armado) return 0n;
        return pisoDoLucroEmUnidadesCruas(
            alvo,
            custoDoTiroUsd(PISO_DA_GORJETA_WEI, baseFeeAtual ?? 0n, precoDoEth()),
        );
    }

    async function tiroEmSeco(alvoPedido?: string): Promise<void> {
        const passos: Record<string, string> = {};
        try {
            const alvoDoEnsaio = alvoPedido ?? brasa[0];
            if (!alvoDoEnsaio) { log.warn('[EM SECO] Sem ninguém para ensaiar.'); return; }
            passos.alvo = alvoDoEnsaio;

            const montados = await montarAlvos([alvoDoEnsaio], moedas, dataProvider!, precos, casas);
            const alvo = montados[0];
            if (!alvo || alvo.dividaCrua === undefined) {
                passos.montarAlvos = 'FALHOU: não consegui montar o alvo';
                log.error('[EM SECO] O caminho de tiro PARA aqui.', passos);
                return;
            }
            passos.montarAlvos = `garantia ${alvo.garantia} / dívida ${alvo.divida}`;
            passos.pediriaEmprestado = cobrir(alvo).toString();
            passos.fatia = alvo.dividaUsd === undefined
                ? 'metade (sem cotação da dívida)'
                : `US$ ${alvo.dividaUsd.dividedBy(2).lessThanOrEqualTo(coberturaOtima()) ? alvo.dividaUsd.dividedBy(2).toFixed(2) + ' (metade)' : coberturaOtima().toFixed(0) + ' (fatia ótima — a dívida é maior que o pool aguenta)'}`;

            // A medicao de verdade, contra a Aave real, com piso impossivel.
            const contrato = contratos[0];
            const dados = contrato.tipo === 'V1'
                ? codificarCacaV1({ garantia: alvo.garantia, divida: alvo.divida, devedor: alvo.devedor,
                    quantoCobrir: cobrir(alvo), poolDeVenda: poolParaVender(alvo, poolDeVendaV1), lucroMinimo: PISO_IMPOSSIVEL })
                : codificarCacaV2({ garantia: alvo.garantia, divida: alvo.divida, devedor: alvo.devedor,
                    quantoCobrir: cobrir(alvo), isStablePool: false, lucroMinimo: PISO_IMPOSSIVEL });
            const r = await chamarCruComPaciencia([{ from: donoCarteira ?? undefined, to: contrato.endereco, data: dados }, 'latest']);
            const leitura = lerRespostaDaCaca({ ok: r.ok, dados: r.dados ?? '0x', mensagem: 'mensagem' in r ? r.mensagem : undefined });
            passos.medicao = `${leitura.desfecho}${leitura.erro ? ` (${leitura.erro})` : ''}`;

            if (!ENVIAR || !carteira || !donoCarteira) {
                passos.envio = 'ENVIAR desligado: o resto não se testa';
                log.info('[EM SECO] Caminho conferido até onde dava.', passos);
                return;
            }

            // Saldo: a unica coisa que so era lida dentro do tiro, e por isso
            // aparecia como "ainda não li" para sempre.
            try {
                saldoDeGasWei = await (carteira.provider as JsonRpcProvider).getBalance(donoCarteira);
                saldoLidoEm = Date.now();
                saldoJaLido = true;
                passos.saldo = `${new Decimal(saldoDeGasWei.toString()).dividedBy(1e18).toFixed(6)} ETH`;
            } catch (e) {
                passos.saldo = `FALHOU: ${(e as Error).message}`;
                log.error('[EM SECO] O caminho de tiro PARA aqui: não consigo ler o saldo.', passos);
                return;
            }

            // A conta do tiro, com um lucro de exemplo, para ver se os freios
            // deixariam passar.
            const ethUsd = precoDoEth();
            passos.precoDoEth = ethUsd === null ? 'SEM COTAÇÃO — o piso de lucro barraria tudo' : `US$ ${ethUsd.toFixed(2)}`;
            const base = baseFeeAtual ?? 20_000_000n;
            passos.baseFee = `${(Number(base) / 1e9).toFixed(4)} gwei`;
            // A MESMA regra do caminho quente, nao uma copia dela. A copia
            // que morava aqui conferia tres freios de quatro, e quando entrou o
            // freio que protege a caca de migalhas ela nao soube: o ensaio
            // passou a imprimir "Se alguem cair, o tiro sai" para um premio de
            // US$ 88 que o caminho de verdade RECUSA. O unico teste que existe
            // para dizer se o bot atira estava mentindo.
            const ambiente = {
                precoDoEthUsd: ethUsd,
                saldoWei: saldoDeGasWei,
                baseFeeWei: base,
                ...POLITICA,
                tiroDeProva: provaAgora().armado,
            };
            passos.tiroDeProva = provaAgora().porque;
            // Sem isto ela nao tem como saber, olhando o log, se o bot vai ou nao
            // atirar quando o alvo de poeira aparecer — e a medicao de 2026-09-28
            // diz que poeira e o unico alvo que ele consegue ler a tempo.
            // O que decide se ele atira ANTES do cruzamento, que e a unica forma de
            // ganhar uma liquidacao de juro. Sem esta linha ela nao tem como saber,
            // olhando o log, se o bot vai esperar (e chegar depois, sempre) ou
            // mandar antes.
            passos.antesDoCruzamento = (() => {
                const d = atirarAntesDoCruzamento({
                    blocosAteCruzar: 1, modoProva: provaAgora().armado,
                    aceitaPrejuizo: POLITICA.aceitaPrejuizo, janelaDeBlocos: JANELA_DE_BLOCOS,
                });
                return d.atira
                    ? `LIGADO: mando com até ${JANELA_DE_BLOCOS} blocos de antecedência, mirando o bloco do `
                      + 'cruzamento. Se eu chegar antes, a Aave recusa e o gás é perdido'
                    : `desligado — ${d.porque}. Esperando a saúde cruzar 1 é chegar depois: o bloco do `
                      + 'cruzamento é o mesmo em que o vencedor executa (medido em 32 de 43 liquidações)';
            })();
            passos.aceitaPrejuizo = POLITICA.aceitaPrejuizo
                ? 'LIGADO: atira mesmo dando prejuízo. É o único alvo legível a tempo (medido em 2026-09-28)'
                : 'desligado: só atira com lucro acima de zero — e nenhum alvo legível a tempo tem isso';
            const emEth6 = (w: bigint) => new Decimal(w.toString()).dividedBy(1e18).toFixed(6);
            const d88 = decidirTiro({ ...ambiente, lucroUsd: new Decimal(88) });
            passos.numDeUS$88 = `gorjeta ${(Number(d88.prioridadeWei) / 1e9).toFixed(2)} gwei` +
                (d88.amordaca.amordacado ? ` (AMORDAÇADA — queria ${(Number(d88.desejadaWei) / 1e9).toFixed(2)})` : ' (inteira)') +
                `, adiantaria ${emEth6(d88.adiantadoWei)} ETH`;
            passos.numDeUS$88Atiraria = d88.atira ? 'SIM' : `NÃO — ${d88.porque}`;
            passos.adiantadoCabe = d88.adiantavelWei > base ? 'sim' : 'NÃO — não conseguiria enviar';

            // A fronteira da faixa das migalhas: o maior premio pelo qual este
            // saldo ainda atira. E o numero que a estrategia escolhida pede, e
            // que o log nunca deu.
            const faixa = faixaQueAtira(ambiente);
            // Sem piso NAO e piso zero. O modo prova apaga o piso de lucro, e
            // dizer "US$ 0,00. Abaixo nao paga o gas" era um numero inventado
            // pela propria busca ao lado de uma frase que o contradiz.
            // OS BOTOES, no log.
            //
            // Sem isto a REGRA 0 tem um buraco: o terminal roda `faixaQueAtira`
            // com os padroes do ambiente DAQUI, e o Railway roda com os valores
            // dela. Em 2026-09-28 isso deu `inteiroDe` de US$ 34,63 em producao
            // contra US$ 49,27 no terminal, com o MESMO saldo, MESMO baseFee e
            // MESMO preco — 30% de diferenca que eu nao tinha como explicar
            // porque o log nao dizia com que botoes ele decidiu.
            //
            // Agora diz. Quem for conferir daqui roda com os mesmos numeros.
            passos.osBotoes = comoLerAPolitica(POLITICA);
            passos.atiroNaFaixaDe = faixa === null
                ? 'NENHUM prêmio — algum freio barra tudo'
                : (() => {
                    const topo = faixa.ate === null
                        ? 'SEM TETO (não achei limite: o gás dá conta de qualquer prêmio)'
                        : `US$ ${faixa.ate.toFixed(2)} (R$ ${faixa.ate.mul(5.4).toFixed(2)})`;
                    return faixa.de === null
                        ? `QUALQUER lucro acima de zero até ${topo}. ` +
                          'NÃO existe piso: é o modo prova, e ele atira sabendo que pode dar prejuízo'
                        : `de US$ ${faixa.de.toFixed(2)} (R$ ${faixa.de.mul(5.4).toFixed(2)}) até ${topo}. ` +
                          'Abaixo não paga o gás; acima uma derrota mata a caça';
                })();
            // A frase segue a FORMA da região, e não supõe uma delas.
            //
            // Com o kamikaze a mordaça inverte: amordaçado nas migalhas e
            // inteiro dos ~US$ 66 para cima. Dizer "nenhum prêmio com lance
            // inteiro" na mesma tela em que `numDeUS$88` diz "(inteira)" é a
            // etiqueta contradizendo o número ao lado dela.
            passos.lanceInteiroAte = faixa === null
                ? 'nenhum prêmio com lance inteiro'
                // TRES regioes, e nao duas. Com o resgate all-in de 2026-09-30 o
                // lance sai inteiro nas migalhas (a proporcional cabe),
                // AMORDACADO no meio (nao cabe) e inteiro de novo no premio
                // grande (o resgate paga a carteira toda). Publicar uma fronteira
                // ali seria inventar uma que nao existe.
                : faixa.inteiroTemBuraco
                    ? 'inteiro nas DUAS pontas e amordaçado no MEIO — não há uma fronteira só. '
                      + 'Migalha: a gorjeta proporcional cabe no saldo. Prêmio médio: não cabe, e eu atiro '
                      + 'amordaçada. Prêmio grande: o resgate paga o teto da carteira e volta a ser inteiro'
                : faixa.inteiroDe !== null
                    ? `A PARTIR de US$ ${faixa.inteiroDe.toFixed(2)} (R$ ${faixa.inteiroDe.mul(5.4).toFixed(2)}) o lance sai `
                      + 'inteiro. ABAIXO disso eu atiro amordaçada — a gorjeta é o teto da carteira, mas a fração '
                      + 'de risco corta quando o prêmio é pequeno'
                    : faixa.inteiroAte !== null
                        ? `US$ ${faixa.inteiroAte.toFixed(2)} (R$ ${faixa.inteiroAte.mul(5.4).toFixed(2)}). `
                          + 'Entre este e o topo da faixa eu atiro, mas amordaçada — com desvantagem no leilão'
                        : 'nenhum prêmio com lance inteiro'
            // O ensaio NAO consome nonce. Antes ele chamava `getNextNonce()`,
            // que adianta o contador, e devolvia com um `sync()` sem protecao: se
            // esse `sync()` falhasse — limite de RPC, soluco de rede — o contador
            // ficava em N+1 para sempre, `provaAgora()` passava a responder "ja
            // saiu tiro: nonce N+1 passou de N. A prova foi feita", e o bot
            // desarmava o unico tiro que ele esta configurado para dar, sem nunca
            // ter atirado. Um diagnostico nao pode gastar a municao que ele existe
            // para conferir.
            passos.nonce = String(nonceManager!.nonceConhecido() ?? -1);
            // A pergunta que o log nao respondia: QUANTO FALTA para este alvo.
            // Sai de graca — a varredura acabou de medir a margem dele, e o
            // ensaio mira justamente o primeiro da brasa.
            passos.margemDoAlvo = menorMargem === null
                ? 'ainda não medida'
                : `precisa cair ${menorMargem.toFixed(4)}% para virar alvo`;
            const projecao = projetar(historicoDeSaude.get(alvoDoEnsaio.toLowerCase()) ?? []);
            passos.seOMercadoCair = tabelaDeQuedas;
            passos.seADividaSubir = tabelaDeAltas;
            passos.bussola = bussola;
            passos.tetoDoPool = tetoDoPool;
            passos.chegaPorJuro = projecao.cruza
                ? `em ${emQuantoTempo(projecao.emMs)} (${projecao.taxaAnual.mul(100).toFixed(2)}%/ano, ${projecao.amostras} amostras)`
                : `não projetável: ${projecao.porque}`;

            // O veredicto passa a ser sobre a FAIXA, nao sobre um premio de
            // exemplo. "O tiro sai" testando US$ 88 era falso de duas maneiras:
            // o freio das migalhas recusa esse premio, e nada dizia em que
            // premio ele SAI.
            if (faixa !== null && ethUsd !== null) {
                log.info('[EM SECO] Caminho de tiro INTEIRO conferido. Sai tiro dentro da faixa.', passos);
            } else {
                log.error('[EM SECO] O caminho de tiro tem um bloqueio. NÃO sai tiro em NENHUM prêmio.', passos);
            }
        } catch (e) {
            passos.erro = (e as Error).message;
            log.error('[EM SECO] O ensaio quebrou — o caminho de tiro tem um defeito.', passos);
        }
    }

    /**
     * Ha quanto tempo alguem foi liquidado na Base, seja por quem for.
     *
     * Existe porque "aconteceram: 0" hora apos hora nao distingue duas coisas
     * que pedem decisoes opostas: mercado calmo (e esperar) e faixa que secou
     * (e mudar de estrategia). A conta de 66 liquidacoes por mes foi medida em
     * setembro; se a ultima foi ha duas semanas, ela envelheceu.
     *
     * Roda em segundo plano, uma vez por boot, uns 3.000 CUs — 0,03% do teto.
     */
    async function quandoFoiAUltimaLiquidacao(topo: number): Promise<void> {
        const PASSO = PEDACO * 5;      // ~5,5 horas de blocos por consulta
        const ATE_ONDE_OLHAR = 40;     // ~9 dias para tras

        // ANTES esta funcao parava na PRIMEIRA janela com liquidacao e jogava
        // todo o resto fora. Ela respondia "ha quanto tempo foi a ultima" e mais
        // nada — e a pergunta que decide a estrategia e outra: nos ultimos nove
        // dias, quantas migalhas passaram DENTRO da minha faixa, e valendo
        // quanto?
        //
        // Essa resposta existe no historico da rede, sem esperar ninguem cair e
        // sem mandar transacao nenhuma. Custa uns 3.000 CUs uma vez por boot —
        // 0,008% do teto do mes.
        const achadas: Array<{ bloco: number; ativo: string; cru: bigint | Decimal; hash: string; liquidante: string }> = [];
        let janelasLidas = 0;
        let janelasQueFalharam = 0;
        let blocoMaisAntigoOlhado = topo;

        for (let i = 0; i < ATE_ONDE_OLHAR; i += 1) {
            const ate = topo - i * PASSO;
            const de = Math.max(0, ate - PASSO + 1);
            if (ate <= 0) break;
            try {
                const logs = await chamar<Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }>>('eth_getLogs', [{
                    address: REDE.pool,
                    fromBlock: `0x${de.toString(16)}`,
                    toBlock: `0x${ate.toString(16)}`,
                    topics: [TOPIC_LIQUIDATION_CALL],
                }]);
                janelasLidas += 1;
                blocoMaisAntigoOlhado = de;
                for (const cru of logs) {
                    try {
                        const l = decodificarLiquidacao(cru);
                        achadas.push({ bloco: l.bloco, ativo: l.ativoDaDivida, cru: l.dividaCrua, hash: cru.transactionHash, liquidante: l.liquidante });
                    } catch { /* um log estranho nao invalida o censo */ }
                }
            } catch {
                // Uma janela que falha nao invalida a busca, mas ENTRA NA CONTA:
                // um censo com buracos que se apresenta como completo seria
                // ausencia com cara de resposta.
                janelasQueFalharam += 1;
            }
            await dormir(200);
        }

        const diasOlhados = ((topo - blocoMaisAntigoOlhado) * 2) / 86400;

        if (achadas.length === 0) {
            log.warn('[MERCADO] NENHUMA liquidação encontrada para trás.', {
                olheiPara: `${diasOlhados.toFixed(1)} dias`,
                janelasLidas,
                janelasQueFalharam,
                oQueIssoQuerDizer: janelasQueFalharam > janelasLidas / 4
                    ? 'MAS um quarto das janelas falhou: pode ser o RPC, não o mercado. Não conclua nada daqui'
                    : 'não é o bot dormindo: é a Aave da Base sem liquidar ninguém há mais de uma semana. A estratégia das migalhas precisa ser revista.',
            });
            return;
        }

        // Precificar no FIM, e nao durante a varredura: no comeco do boot o mapa
        // de precos ainda pode estar vazio, e precificar cedo daria `null` nas
        // primeiras janelas — um censo torto por acidente de ordem.
        const comLucro = achadas.map((a) => {
            const dividaUsd = emDolar(a.cru, casas.get(a.ativo.toLowerCase()), precos.get(a.ativo.toLowerCase()));
            return { ...a, dividaUsd, lucroUsd: dividaUsd === null ? null : lucroEstimado(dividaUsd) };
        });

        const faixa = faixaQueAtira({
            precoDoEthUsd: precoDoEth(),
            saldoWei: saldoDeGasWei,
            baseFeeWei: baseFeeAtual ?? 20_000_000n,
            ...POLITICA,
            // O CENSO mede a faixa SUSTENTAVEL, nunca a do tiro de prova. O tiro
            // de prova e UM tiro, pago com o gas inteiro se preciso, para comprar
            // a informacao "o caminho funciona" — nao e como o bot vive. Quando o
            // teto do modo prova entrou aqui, em 2026-09-27, o censo passou a
            // dizer `naSUAFaixa: 57 de 57` e `~US$ 5946/mes`: o dinheiro da faixa
            // de cima, apresentado como renda dela. E a decisao do gas que o
            // CLAUDE.md registra nasce DESTA faixa, entao medir com o teto do tiro
            // unico apagava a medicao que a produziu.
            tiroDeProva: false,
        });

        // Tres grupos, uma implementacao, e uma soma que tem de fechar. A versao
        // anterior tinha o filtro aqui e a NEGACAO dele lá embaixo chamada de
        // "acima da sua faixa" — e a negacao passou a conter a poeira de baixo.
        const partes = repartirPorFaixa(comLucro, faixa);
        const dentroDaFaixa = partes.dentro;
        const somaDaFaixa = dentroDaFaixa.reduce((acc, a) => acc.plus(a.lucroUsd!), new Decimal(0));
        const semCotacao = partes.semCotacao.length;
        const maisRecente = comLucro.reduce((a, b) => (b.bloco > a.bloco ? b : a));
        const horasDaUltima = ((topo - maisRecente.bloco) * 2) / 3600;
        const porDia = diasOlhados > 0 ? achadas.length / diasOlhados : 0;
        const porMes = porDia * 30;
        const naFaixaPorMes = diasOlhados > 0 ? (dentroDaFaixa.length / diasOlhados) * 30 : 0;

        // Contar e descrever a concentracao vive UMA vez e serve os dois
        // campos que precisam dela. Duas copias da mesma regra e o defeito que
        // este projeto achou oito vezes num dia — inclusive em mim.
        const contarLiquidantes = (lista: typeof comLucro) =>
            contarPorEndereco(lista.map((a) => a.liquidante));
        // O veredicto vive em `src/concentracao.ts` e sai da CHANCE DO ACASO, nao
        // de uma fracao escolhida a mao. A regra que morava aqui —
        // `total >= 5 && fatiaDoMaior >= 0.5` — imprimia ">>> ESSA FATIA TEM DONO"
        // para SEIS liquidacoes repartidas 3 e 3 entre DOIS enderecos, que o
        // acaso produz em 100% das vezes. Era esse veredicto que sustentava o
        // argumento "todas as fatias que o gas abre tem dono".
        const descreverLiquidantes = comoLerAContagem;

        log.info('[MERCADO] Censo das liquidações da Aave na Base.', {
            olhei: `${diasOlhados.toFixed(1)} dias (${janelasLidas} janelas, ${janelasQueFalharam} falharam)`,
            aconteceram: `${achadas.length} no total, ${porDia.toFixed(1)} por dia, ~${Math.round(porMes)} por mês`,
            aUltima: horasDaUltima < 1 ? `${Math.round(horasDaUltima * 60)} minutos atrás` : `${horasDaUltima.toFixed(1)} horas atrás`,
            // ESTE e o numero que decide a estrategia — e ele fala da faixa
            // SUSTENTAVEL, de proposito. Dizer QUAL faixa e importa: quando o
            // teto do tiro de prova entrou aqui por engano, o censo publicou
            // "~US$ 5946/mes" sem nada no log avisando que era outra pergunta.
            qualFaixa: provaAgora().armado
                ? 'a faixa SUSTENTÁVEL (regra normal). O tiro de prova está armado e atira SEM TETO, '
                  + 'mas isso é UM tiro para testar — não entra nesta conta'
                : 'a faixa sustentável (regra normal)',
            naSUAFaixa: faixa === null
                ? `${dentroDaFaixa.length} com lucro acima de zero (não sei a faixa agora)`
                : `${dentroDaFaixa.length} de ${achadas.length} — entre ${
                    faixa.de === null ? 'qualquer lucro' : `US$ ${faixa.de.toFixed(2)}`} e ${
                    faixa.ate === null ? 'SEM TETO' : `US$ ${faixa.ate.toFixed(2)}`}`,
            // A soma tem de FECHAR na tela. Quando o piso saiu de zero para
            // US$ 0,45, `naSUAFaixa` caiu de 48 para 10 e nada no log dizia para
            // onde as outras 38 foram — o número apareceu mudado, sem explicação.
            // Ver as três partes somando o total é o que torna a queda legível.
            ondeCairamAsOutras: `${partes.abaixoDoPiso.length} abaixo do piso (não pagam o próprio gás)`
                + ` + ${partes.dentro.length} na faixa`
                + ` + ${partes.acimaDoTeto.length} acima do teto`
                + `${semCotacao === 0 ? '' : ` + ${semCotacao} sem cotação`}`
                + ` = ${partes.abaixoDoPiso.length + partes.dentro.length + partes.acimaDoTeto.length + semCotacao}`
                + ` de ${achadas.length}`,
            lucroQuePassouNaFaixa: `US$ ${somaDaFaixa.toFixed(2)} em ${diasOlhados.toFixed(1)} dias ` +
                `(~US$ ${somaDaFaixa.dividedBy(Math.max(diasOlhados, 0.01)).mul(30).toFixed(2)}/mês, ${Math.round(naFaixaPorMes)} migalhas/mês)`,
            semCotacao: semCotacao === 0 ? 'nenhuma' : `${semCotacao} não consegui precificar (moeda fora do meu mapa)`,
            asTresMaiores: comLucro
                .filter((a) => a.lucroUsd !== null)
                .sort((a, b) => b.lucroUsd!.comparedTo(a.lucroUsd!))
                .slice(0, 3)
                .map((a) => `US$ ${a.lucroUsd!.toFixed(2)} (dívida US$ ${a.dividaUsd!.toFixed(0)}) https://basescan.org/tx/${a.hash}`),
            // O que CADA saldo teria alcançado, medido no historico e nao
            // estimado. "Quanto de gas colocar" era palpite; aqui vira conta.
            oQueCadaSaldoAlcancaria: (() => {
                const comCotacao = comLucro.filter((a) => a.lucroUsd !== null);
                return [0.01, 0.02, 0.05, 0.1].map((eth) => {
                    const f = faixaQueAtira({
                        precoDoEthUsd: precoDoEth(),
                        saldoWei: BigInt(Math.round(eth * 1e18)),
                        baseFeeWei: baseFeeAtual ?? 20_000_000n,
                        ...POLITICA,
                        // Sustentavel, pelo mesmo motivo da faixa do censo acima:
                        // "quanto de gas colocar" e uma pergunta sobre viver
                        // disso, nao sobre um tiro unico de teste.
                        tiroDeProva: false,
                    });
                    if (f === null) return `${eth} ETH: não sei dizer`;
                    const dentro = comCotacao.filter((a) =>
                        (f.de === null || a.lucroUsd!.greaterThanOrEqualTo(f.de))
                        && (f.ate === null || a.lucroUsd!.lessThanOrEqualTo(f.ate)));
                    const soma = dentro.reduce((acc, a) => acc.plus(a.lucroUsd!), new Decimal(0));
                    const usdDoSaldo = precoDoEth() === null ? null : new Decimal(eth).mul(precoDoEth()!);
                    // A fatia NOVA — o que este saldo abre e o atual não alcança.
                    // Sem isto o número "alcançaria US$ 584" parece dinheiro
                    // disponível, quando pode estar todo numa faixa com dono.
                    const novas = dentro.filter((a) => !dentroDaFaixa.includes(a));
                    const somaNova = novas.reduce((acc, a) => acc.plus(a.lucroUsd!), new Decimal(0));
                    const cNovas = contarLiquidantes(novas);
                    return `${eth} ETH${usdDoSaldo === null ? '' : ` (US$ ${usdDoSaldo.toFixed(0)})`}: teto ${
                        f.ate === null ? 'NENHUM (alcança tudo)' : `US$ ${f.ate.toFixed(0)}`} | ` +
                        `alcança ${dentro.length} valendo US$ ${soma.toFixed(2)} ` +
                        `(~US$ ${soma.dividedBy(Math.max(diasOlhados, 0.01)).mul(30).toFixed(0)}/mês) | ` +
                        `ABRE ${novas.length} novas valendo US$ ${somaNova.toFixed(2)} — ${
                            descreverLiquidantes(cNovas)}${(() => {
                            if (novas.length === 0) return '';
                            // ESTE veredicto e a espinha da decisao de nao colocar
                            // dinheiro, e era ele que estava medindo barulho: com
                            // a regra antiga, SEIS liquidacoes repartidas 3 e 3
                            // entre DOIS enderecos saiam como ">>> TEM DONO", e o
                            // acaso produz exatamente isso em 100% das vezes.
                            const d = quemTemDono(cNovas);
                            return d.veredicto === 'tem dono'
                                ? ` >>> ESSA FATIA TEM DONO: o gás compra acesso a uma briga (${d.porque})`
                                : d.veredicto === 'sem dono'
                                    ? ` >>> fatia sem dono: o gás compra oportunidade de verdade (${d.porque})`
                                    : ` >>> NÃO DÁ PARA DIZER se tem dono: ${d.porque}`;
                        })()}`;
                });
            })(),
            // Quem esta levando, e quao concentrado. E o melhor palpite que os
            // dados dao sobre a chance de GANHAR a corrida: um endereco levando
            // quase tudo e concorrencia dedicada; trinta enderecos diferentes e
            // uma faixa que ninguem disputa a serio.
            // Quem esta levando, e — o que importa mais — se quem leva as
            // MIGALHAS e o mesmo que leva as grandes.
            //
            // A primeira versao disto errou o veredicto, e errou para o lado
            // caro: com 17 liquidantes e o maior levando 20% ela imprimiu
            // "CONCENTRADO: ganhar a corrida e mais dificil", o que empurraria a
            // dona do bot a desistir. A regra era `liquidantes < liquidacoes/2`
            // — arbitraria, e nao mede concentracao nenhuma: ela chamaria de
            // concentrado qualquer mercado onde cada um leva mais de duas.
            //
            // 17 jogadores, nenhum acima de 20%, e um mercado ABERTO. O maior
            // tem 3,3x a fatia media, nao 30x.
            //
            // E a pergunta de verdade nem e essa: e se a faixa DELA tem dono.
            // Migalha de US$ 2 bot grande ignora; liquidacao de US$ 1.500 tem
            // bot dedicado. Medir os dois juntos mistura duas corridas
            // diferentes numa media que nao descreve nenhuma.
            quemEstaLevando: (() => {
                const naFaixa = contarLiquidantes(partes.dentro);
                const acima = contarLiquidantes(partes.acimaDoTeto);
                const poeira = contarLiquidantes(partes.abaixoDoPiso);
                const dSua = quemTemDono(naFaixa);
                const dAcima = quemTemDono(acima);
                return {
                    tudo: descreverLiquidantes(contarLiquidantes(comLucro)),
                    naSuaFaixa: `${descreverLiquidantes(naFaixa)} >>> ${dSua.veredicto.toUpperCase()}: ${dSua.porque}`,
                    acimaDaSuaFaixa: `${descreverLiquidantes(acima)} >>> ${dAcima.veredicto.toUpperCase()}: ${dAcima.porque}`,
                    // A frase segue o ESTADO, e nao o caso normal. Com o tiro
                    // de prova armado o piso cai para US$ 0,50
                    // (`CACA_PISO_DA_PROVA_USD`) e o bot ATIRA em parte destas —
                    // e tres linhas acima, no mesmo log, `qualFaixa` ja diz que
                    // a prova esta armada e atira sem teto. Duas linhas do mesmo
                    // log discordando sobre o mesmo estado e o defeito que o
                    // CLAUDE.md persegue desde o primeiro dia, e este era o
                    // ultimo que restava da revisao.
                    abaixoDoPiso: `${descreverLiquidantes(poeira)} — ${provaAgora().armado
                        ? 'não pagam o próprio gás pela regra NORMAL, mas o tiro de prova está ARMADO '
                          + 'e o piso dele é US$ 0,50: o bot atiraria em parte destas'
                        : 'não pagam o próprio gás, o bot não atira nelas'}`,
                    leitura: dSua.veredicto === 'tem dono'
                        ? 'a SUA faixa tem dono: um endereço leva a maior parte das migalhas, e entrar é briga'
                        : dSua.veredicto === 'não dá para dizer'
                            ? 'NÃO DÁ PARA DIZER se a sua faixa tem dono: são poucas liquidações para separar '
                              + 'domínio de sorte. Isto não é "está aberta" — é "ainda não sei"'
                            : dAcima.veredicto === 'tem dono'
                                ? 'a sua faixa é aberta, mas a de cima tem dono: catar migalhas é plausível, '
                                  + 'disputar as grandes provavelmente não'
                                : 'a sua faixa é aberta pelos dados que tenho, e a de cima não dá para afirmar',
                    comoLerIsto: 'o veredicto sai da CHANCE DO ACASO: se endereços igualmente bons sorteassem '
                        + 'estas liquidações entre si, com que frequência o maior levaria tanto? Abaixo de 5% eu '
                        + 'afirmo; acima, digo que não sei. A fração sozinha engana: 50% de 10 o acaso dá em 16% '
                        + 'das vezes, 50% de 20 em 1,3%',
                };
            })(),
            ATENCAO: 'isto é OPORTUNIDADE que passou, não renda perdida: para cada uma dessas eu ainda teria de ' +
                'ganhar a corrida de outro liquidador. É o teto do que a faixa pode dar, não o que ela daria',
            oQueIssoQuerDizer: dentroDaFaixa.length === 0
                ? 'NENHUMA liquidação caiu na sua faixa em todo o período. Esperar não resolve: a faixa é que está no lugar errado'
                : naFaixaPorMes >= 20
                    ? 'a faixa tem movimento de verdade. Esperar é a resposta certa'
                    : 'a faixa tem movimento, mas pouco. Dá para provar que funciona; não dá para viver disso ainda',
        });
    }

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

        // O piso do placar e o piso DO BOT, tirado da faixa que ele atira agora.
        // Estava fixo em US$20 e ficou desatualizado em silencio: com o modo
        // prova o bot atira em qualquer lucro acima de zero, e o placar diria
        // "nao teve" sobre exatamente a liquidacao que ela esta esperando.
        const faixaAgora = faixaQueAtira({
            precoDoEthUsd: precoDoEth(),
            saldoWei: saldoDeGasWei,
            baseFeeWei: baseFeeAtual ?? 20_000_000n,
            ...POLITICA,
            tiroDeProva: provaAgora().armado,
        });
        // Sem faixa (sem cotacao, sem saldo) o piso volta ao default: nesse caso
        // nao se sabe o que o bot atiraria, e inventar zero encheria o placar de
        // poeira com cara de oportunidade perdida.
        // No modo prova NAO existe piso, e `null` aqui quer dizer isso — nao zero.
        // O bot atira em qualquer lucro bruto acima de zero, e o lucro do placar e
        // LIQUIDO do gas: com piso zero, a liquidacao de poeira que o bot atiraria
        // era descartada e o placar dizia "nao teve" sobre ela.
        const semPisoNenhum = provaAgora().armado;
        const pisoDoPlacar = semPisoNenhum
            ? null
            : faixaAgora === null ? new Decimal(20) : (faixaAgora.de ?? new Decimal(0));
        const placar = montarPlacar(perdidas, pisoDoPlacar);
        desdeOBoot.blocos += ate - de + 1;
        desdeOBoot.aconteceram += placar.total;
        desdeOBoot.valiamAPena += placar.valiam.length;
        desdeOBoot.lucro = desdeOBoot.lucro.plus(placar.somaDoLucroPerdido);
        for (const [balde, n] of Object.entries(placar.porCobertura)) desdeOBoot.porCobertura[balde] += n;

        const horas = (Date.now() - desdeOBoot.emMs) / 3_600_000;
        log.info('[PLACAR] Liquidações que aconteceram sem mim.', {
            janela: `blocos ${de}–${ate}`,
            // "sem cotacao OU sem saldo" junta duas causas com consertos
            // diferentes numa frase so. Saber qual e a diferenca entre "espere"
            // e "mande ETH para a conta_bot".
            // A ordem TEM de ser a mesma de `pisoDoPlacar` acima. Testar
            // `faixaAgora === null` primeiro fazia o log dizer "US$ 20,00" sobre um
            // placar que rodou SEM PISO — e `faixaAgora` e null exatamente nos
            // estados que este bot vive em todo boot (saldo nao lido, sem cotação).
            pisoUsado: semPisoNenhum
                ? 'SEM PISO NENHUM (modo prova): conto tudo, inclusive o que dá prejuízo, '
                  + 'porque é nisso que ele atira'
                : faixaAgora === null
                ? `US$ 20,00 — não sei a faixa agora: ${
                    !saldoJaLido ? 'ainda não consegui ler o gás da conta_bot'
                    : saldoDeGasWei === 0n ? 'a conta_bot está sem gás'
                    : precoDoEth() === null ? 'sem cotação do ETH'
                    : 'algum freio barra qualquer prêmio'}`
                : `US$ ${(pisoDoPlacar ?? new Decimal(0)).toFixed(2)}`,
            aconteceram: placar.total,
            valiamAPena: placar.valiam.length,
            // O acumulado e o que responde a pergunta. Uma hora em branco tem
            // 30% de chance sozinha; seis horas em branco ja dizem outra coisa.
            // Sem piso, `valiamAPena` e `lucroQuePassou` contam PREJUIZO junto —
            // "valia a pena" e "lucro" sobre liquidacoes que perdem dinheiro. E o
            // modo prova desarma sozinho quando o nonce passa, entao o acumulado
            // mistura janelas contadas com pisos diferentes sem registrar a troca.
            comoLerOAcumulado: semPisoNenhum
                ? 'ATENÇÃO: sem piso, "valiamAPena" conta tudo que aconteceu, inclusive o que dá '
                  + 'prejuízo — e o modo prova desarma sozinho quando o nonce passa, então o '
                  + 'acumulado pode misturar janelas contadas com pisos diferentes'
                : 'contado contra o piso da faixa de tiro de agora',
            desdeOBoot: {
                horas: horas.toFixed(1),
                aconteceram: desdeOBoot.aconteceram,
                porHora: horas > 0 ? (desdeOBoot.aconteceram / horas).toFixed(2) : '—',
                valiamAPena: desdeOBoot.valiamAPena,
                lucroQuePassou: `US$ ${desdeOBoot.lucro.toFixed(2)}`,
                ondeEuEstava: desdeOBoot.porCobertura,
            },
            oQueIssoQuerDizer: oQueIssoQuerDizer(placar, faixaAgora === null ? new Decimal(20) : pisoDoPlacar),
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
        const { precos: doMercado, fonte } = await cotacoesDeQualquerFonte(paresDaBinance);
        if (fonte !== fonteDoPreco && doMercado.size > 0) {
            // Fonte que troca sozinha em silencio e a armadilha de sempre:
            // funciona, e ninguem sabe como.
            log.info(`[MERCADO] Lendo preço da ${fonte}.`, { antes: fonteDoPreco, pares: paresDaBinance });
            fonteDoPreco = fonte;
        }
        if (doMercado.size === 0) {
            quedaDoMercadoAgora = null;
            if (!avisouMercadoMudo) {
                avisouMercadoMudo = true;
                fonteDoPreco = 'nenhuma';
                log.warn('MERCADO MUDO: nenhuma das três casas respondeu. Volto ao ritmo fixo e perco a vantagem de antecipar.', {
                    tentei: 'binance, coinbase, kraken',
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
        // Duas coisas independentes podem exigir pressa, e a resposta e a mais
        // exigente das duas. O mercado cobre quem cai por PRECO; a chegada por
        // juro cobre quem cai sozinho — e era esse que ia chegar com o bot
        // dormindo e desarmado, porque o preco cancela na conta da saude dele.
        const nova = posturaMaisForte(
            posturaPorMargem(queda, menorMargem, DESVIO_DE_ESCRITA),
            posturaPorChegada(msAteAProximaChegada()),
        );
        // Armar enquanto o preco cai, nao depois que o bloco chega.
        if (valeArmar(nova, Date.now() - tentouArmarEm, VALIDADE_ARMADO_MS)) void armar();
        const ficouUrgente = ritmoDaPostura(nova, INTERVALO_MS) < ritmoDaPostura(postura, INTERVALO_MS);
        postura = nova;
        if (postura !== posturaAnterior) {
            log.info(`[POSTURA] ${posturaAnterior} → ${postura}`, {
                mercadoCaiu: `${queda.toFixed(4)}%`,
                feedEscreveEm: `${DESVIO_DE_ESCRITA.toFixed(2)}%`,
                // Diz de QUAL camada saiu. As duas linhas do log respondiam
                // "o mais frágil está a quanto?" com números diferentes, e
                // nenhuma das duas dizia sobre qual conjunto estava falando.
                maisFragilA: menorMargem === null
                    ? '—'
                    : `${menorMargem.toFixed(4)}%` + (provaAgora().armado
                        ? ' (contando os alvos de prova, que é onde ele atira)'
                        : ' (entre os que pagam o próprio gás)'),
                proximaLeituraEm: `${ritmoDaPostura(postura, INTERVALO_MS)}ms`,
            });
            posturaAnterior = postura;
        }
        return ficouUrgente;
    }

    for (;;) {
        const inicioDoCiclo = Date.now();
        // A conta da paciencia e POR CICLO: somar entre ciclos publicaria um
        // total que nao descreve o ciclo que o `custou` mede, e duas etiquetas
        // discordando sobre a mesma linha e o defeito que este projeto persegue.
        zerarContaDaPaciencia();
        // Conferido uma vez por ciclo, fora do caminho de rede: só troca a url.
        talvezVoltarAoPrimario();
        try {
            if (Date.now() - ultimaColeta > MIN_COLETA * 60_000) {
                const novoTopo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
                if (novoTopo > ultimoBlocoColeta) {
                    // A FRENTE: os blocos novos desde a última coleta. Nada de
                    // esquecer por idade aqui — a lista agora cresce de verdade,
                    // e quem a enxuga é a varredura completa, que vê dívida
                    // ZERO e manda esquecer por estado. Idade apagaria devedor
                    // velho com dívida viva, que é exatamente o buraco que o
                    // placar dela acusou com "nem sabia".
                    const varreduraNova = await varrerDevedores(
                        novoTopo, ultimoBlocoColeta + 1, { calada: true });
                    const novos = varreduraNova.devedores;
                    for (const d of novos) vistoEm.set(d.toLowerCase(), novoTopo);
                    memoriaDoCache = juntarDevedoresDoCache(memoriaDoCache, novos, novoTopo);
                    // A fronteira da frente só avança até onde não há buraco.
                    const frente = ateOndeSemBuraco(ultimoBlocoColeta + 1, varreduraNova.faixasLidas);
                    if (frente > ultimoBlocoDoCache) ultimoBlocoDoCache = frente;

                    // O FUNDO, de pouco em pouco: enquanto faltar história para
                    // trás, cada coleta desce um naco com teto de tempo. Sem
                    // isto a cobertura total dependeria de rebootar o container
                    // várias vezes, o que é pedir ao deploy que faça o trabalho
                    // do bot.
                    if (blocoInicialDoCache > nascimento && ORCAMENTO_DO_FUNDO_NA_COLETA_MS > 0) {
                        const antesDeDescer = blocoInicialDoCache;
                        const fundo = await varrerDevedores(blocoInicialDoCache - 1, nascimento, {
                            orcamentoMs: ORCAMENTO_DO_FUNDO_NA_COLETA_MS,
                            ordem: 'tras',
                            calada: true,
                        });
                        const desceuAte = deOndeSemBuraco(blocoInicialDoCache - 1, fundo.faixasLidas);
                        blocoInicialDoCache = Math.min(blocoInicialDoCache, desceuAte);
                        for (const d of fundo.devedores) {
                            const k = d.toLowerCase();
                            if (!vistoEm.has(k)) vistoEm.set(k, blocoInicialDoCache);
                        }
                        memoriaDoCache = juntarDevedoresDoCache(
                            memoriaDoCache, fundo.devedores, blocoInicialDoCache);
                        if (antesDeDescer !== blocoInicialDoCache) {
                            log.info('[CACHE] Desci mais um naco do histórico.', {
                                desci: `${(antesDeDescer - blocoInicialDoCache).toLocaleString('pt-BR')} blocos `
                                    + `(~${Math.round(((antesDeDescer - blocoInicialDoCache) * 2) / 86400)} dias)`,
                                achei: fundo.devedores.length,
                                cobertura: comoEstaACobertura(
                                    { versao: VERSAO_DO_CACHE, rede: REDE_ESCOLHIDA, pool: REDE.pool,
                                      blocoInicial: blocoInicialDoCache, ultimoBloco: ultimoBlocoDoCache,
                                      devedores: memoriaDoCache },
                                    nascimento, novoTopo),
                            });
                        }
                    }

                    const antes = devedores.length;
                    devedores = [...vistoEm.keys()].filter((d) => !isDevedorIgnorado(d));
                    if (devedores.length !== antes) {
                        log.info('Lista de devedores atualizada.', {
                            antes, agora: devedores.length,
                            entraram: novos.length,
                            esquecerPor: 'ESTADO (dívida zero na varredura completa), não idade',
                        });
                    }
                    ultimoBlocoColeta = novoTopo;
                    await regravarCache(`coleta até o bloco ${novoTopo}`);
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
            // Quem ainda NAO cruzou, mas vai cruzar dentro da janela. Estes sao
            // atirados ANTES, porque o bloco em que a saude cruza 1 e o mesmo em
            // que a transacao do vencedor executa: quem espera para reagir chega
            // sempre depois. Medido em 2026-09-28, em 32 de 43 liquidacoes.
            const vaoCruzar = new Set<string>();
            const inicioDaBrasa = moedas.length + 2;
            for (let i = 0; i < brasa.length; i++) {
                const dadoConta = resp[inicioDaBrasa + i];
                if (!dadoConta) continue;
                try {
                    const saude = decodificarContaDoUsuario(dadoConta).saude;
                    registrarDeriva(historicoDeSaude, brasa[i]!, saude, Date.now());
                    const queda = quedaAteLiquidar(saude);
                    if (queda !== null && queda.isZero()) { caidos.push(brasa[i]); continue; }
                    const b = blocosAteCruzar(
                        historicoDeSaude.get(brasa[i]!.toLowerCase()) ?? [], MS_POR_BLOCO, Date.now());
                    const antes = atirarAntesDoCruzamento({
                        blocosAteCruzar: b?.blocos ?? null,
                        modoProva: provaAgora().armado,
                        aceitaPrejuizo: POLITICA.aceitaPrejuizo,
                        janelaDeBlocos: JANELA_DE_BLOCOS,
                    });
                    if (antes.atira) {
                        vaoCruzar.add(brasa[i]!.toLowerCase());
                        caidos.push(brasa[i]);
                        log.warn('[ANTES DO CRUZAMENTO] Mandando SEM a posição estar liquidável ainda.', {
                            devedor: brasa[i],
                            faltaCair: `${queda?.toFixed(8) ?? '—'}%`,
                            cruzaEm: `${b!.blocos.toFixed(1)} blocos (${(b!.blocos * 2).toFixed(0)}s)`,
                            juroAoAno: `${b!.taxaAnual.mul(100).toFixed(2)}%`,
                            porque: antes.porque,
                            oQuePodeDarErrado: 'se eu chegar antes do cruzamento, a Aave recusa e o gás é perdido',
                        });
                    }
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
                        armados: alvosArmados.size,
                        gas: saldoLidoEm === 0 ? 'ainda não li' : `${new Decimal(saldoDeGasWei.toString()).dividedBy(1e18).toFixed(6)} ETH`,
                        avisoDeBloco: ouvinte === null ? 'desligado' : (ouvinte.vivo ? `ligado (último ${ouvinte.ultimoBloco})` : 'CAIU — perguntando'),
                        mercado: mercadoAgora() === null
                            ? 'SEM COTAÇÃO — ritmo fixo'
                            : `${mercadoAgora()!.toFixed(4)}% abaixo do oráculo (${posturaAgora()}, via ${fonteDoPreco})`,
                        oraculoJaCaiuPct: `${maiorQueda.toFixed(4)}%`,
                        chegandoPorJuro: (() => {
                            const ms = msAteAProximaChegada();
                            return ms === null ? 'nenhuma projetável' : `a mais próxima em ${emQuantoTempo(ms)}`;
                        })(),
                        seOMercadoCair: tabelaDeQuedas,
                        seADividaSubir: tabelaDeAltas,
                        bussola,
                        gatilhoEm: `${margemDaBrasa.toFixed(4)}%`,
                        // ESTE CICLO LEU SÓ A BRASA — é o que o título diz.
                        //
                        // A etiqueta aqui vinha copiada da varredura 'quentes' e
                        // publicava `1324 (todos lidos)` num ciclo que leu ZERO
                        // deles. Achado no log dela de 2026-10-06, e é a forma
                        // exata que este projeto persegue: etiqueta que não
                        // descreve o conjunto. Pior aqui do que em outros
                        // lugares, porque ela estava lendo este log para
                        // entender três dias sem tiro — e ele afirmava cobertura
                        // de 1.324 posições que ninguém tinha olhado.
                        naListaQuente: `${quentes.length} esperando, e NENHUM foi lido neste ciclo — `
                            + `este ciclo é só a brasa (${brasa.length}). Eles entram na varredura 'quentes'`,
                        custou: (() => {
                            const pac = contaDaPaciencia();
                            return `${Date.now() - inicioDoCiclo}ms`
                                + (pac.recusas > 0
                                    ? ` — dos quais ${pac.ms}ms PARADO esperando o provedor (${pac.recusas} recusas). O gargalo é o RPC, não o código.`
                                    : '');
                        })(),
                        rpc: ESCADA.ehOPrimario()
                            ? hostDoRpc(rpc)
                            : `${hostDoRpc(rpc)} — NO SECUNDÁRIO (degrau ${ESCADA.indice() + 1} de `
                              + `${ESCADA.quantos()}, ${ESCADA.trocas} trocas): o primário caiu`,
                    });
                }
            } else {
                // O TETO so vale para a patrulha rapida. Numa varredura
                // completa cortar seria perder o censo, que e outra coisa.
                const corte = varredura === 'completa'
                    ? { lidos: devedores, ficaramFora: 0 }
                    : cabemNoCiclo(quentes);
                const aLer = corte.lidos;
                if (aLer.length > 0) {
                    const loteGigante = await lerEmLote(aLer.map((d) => ({
                        alvo: REDE.pool,
                        dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
                    })));

                    const medidos: Medida[] = [];
                    /**
                     * Quem a corrente acabou de dizer que NÃO DEVE NADA.
                     *
                     * `dividaBase === 0` é o fato, lido direto da Aave, e não uma
                     * inferência: `quedaAteLiquidar` também devolve `null` para
                     * quem deve e não tem garantia, que é outra coisa. Esquecer
                     * pelo fato errado é como a régua de idade errava.
                     */
                    const semDivida: string[] = [];
                    for (let i = 0; i < aLer.length; i++) {
                        const dadoConta = loteGigante[i];
                        if (!dadoConta) continue;
                        try {
                            const conta = decodificarContaDoUsuario(dadoConta);
                            if (varredura === 'completa' && conta.dividaBase.isZero()) {
                                semDivida.push(aLer[i]!);
                            }
                            // A varredura completa le a saude de TODO MUNDO, e
                            // era a unica leitura que nao alimentava a deriva.
                            // Sem isto o ensaio no boot dizia "0 amostras" e a
                            // primeira projecao esperava dez minutos a mais do
                            // que precisava.
                            registrarDeriva(historicoDeSaude, aLer[i]!, conta.saude, Date.now());
                            const queda = quedaAteLiquidar(conta.saude);
                            if (queda === null) continue;
                            if (queda.isZero()) { if (!caidos.includes(aLer[i])) caidos.push(aLer[i]); }
                            // A Aave responde a divida em "moeda base": dolares
                            // com 8 casas. Vem na mesma resposta da saude, de
                            // graca, e era descartada.
                            else medidos.push({
                                devedor: aLer[i],
                                queda,
                                dividaUsd: conta.dividaBase.dividedBy(1e8),
                                via: oQueSeSabeDaVia(aLer[i]),
                            });
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
                        // O ESQUECIMENTO POR ESTADO.
                        //
                        // Esta é a única varredura que olha TODO MUNDO, então é a
                        // única que pode dizer quem não deve mais nada. E ela já
                        // pagou por essa informação: vem na mesma resposta da
                        // saúde, de graça.
                        //
                        // É reversível de propósito: se a pessoa voltar a tomar
                        // emprestado, o `Borrow` novo a traz de volta pela coleta,
                        // porque `Borrow` é exatamente o evento que a varredura lê.
                        // A régua de idade que estava aqui não era reversível —
                        // apagava por velhice e nunca mais ia buscar.
                        if (semDivida.length > 0) {
                            const limpeza = esquecerQuemNaoDeveMais(memoriaDoCache, semDivida);
                            memoriaDoCache = limpeza.devedores;
                            for (const d of semDivida) vistoEm.delete(d.toLowerCase());
                            if (limpeza.esquecidos > 0) {
                                // A lista que a PRÓXIMA varredura completa vai ler
                                // sai daqui. Esquecer só no cache e não aqui faria
                                // o bot continuar pagando leitura por conta zerada
                                // até a próxima coleta — a economia viria 37 min
                                // depois do motivo.
                                devedores = [...vistoEm.keys()].filter((d) => !isDevedorIgnorado(d));
                                log.info('Esqueci quem não deve mais nada.', {
                                    esquecidos: limpeza.esquecidos,
                                    restam: Object.keys(memoriaDoCache).length,
                                    aLerNaProximaVarredura: devedores.length,
                                    porque: 'dívida ZERO na corrente — sem dívida não há liquidação. '
                                        + 'Se voltarem a tomar emprestado, o Borrow novo os traz de volta',
                                    gravoNaProximaColeta: `em até ${MIN_COLETA} min`,
                                });
                            }
                        }
                        // ANTES de trocar as camadas: quem foi liquidado teve a
                        // saude restaurada e sai da brasa na proxima reparticao.
                        // Contando depois, o balde 'brasa' ficaria vazio sempre
                        // e o diagnostico apontaria 'cobertura' quando o
                        // problema era velocidade.
                        await contarAsQuePassaram(blocoAtual);
                        // O piso sai do tiro MAIS BARATO possivel — gorjeta no
                        // piso — e nao do lance de agora: a gorjeta e
                        // proporcional ao premio, entao migalha se persegue com
                        // lance de migalha. Usar o custo do lance atual
                        // excluiria exatamente as migalhas que sao o alvo.
                        // MODO PROVA: o piso de tamanho cai para poeira e a
                        // brasa INTEIRA fica disponivel.
                        //
                        // O censo mediu que 31 das 52 liquidacoes da Base — 60%
                        // — acontecem abaixo do piso normal de US$ 22,13. Com
                        // as 10 vagas reservadas de antes, o bot vigiava dez
                        // desses e deixava 2.374 de fora da patrulha rapida:
                        // justamente o grupo onde a prova tem chance de
                        // acontecer.
                        //
                        // O piso normal NAO esta errado para operar: ele existe
                        // porque uma divida de US$ 1 nao paga o proprio gas. Mas
                        // a prova nao esta atras de lucro, e ela escolheu pagar
                        // por isso.
                        const pisoNormal = dividaMinimaQueVale(
                            custoDoTiroUsd(PISO_DA_GORJETA_WEI, baseFeeAtual ?? 0n, precoDoEth()),
                        );
                        const pisoDeDivida = provaAgora().armado
                            ? new Decimal(numeroDoAmbiente('CACA_PISO_DA_PROVA_USD', process.env.CACA_PISO_DA_PROVA_USD, 0.5))
                            : pisoNormal;
                        // Sem vagas RESERVADAS: com o piso ja em US$ 0,50 nao ha
                        // grupo cortado a resgatar, e reservar vagas agora
                        // tiraria lugar de quem o piso deixou entrar.
                        // O PAR DE CADA CANDIDATO, ANTES DE ORDENAR.
                        //
                        // Ovo e galinha, achado por ela no log das 17:25:
                        // `precoCancela` so era preenchido DEPOIS de
                        // `montarAlvos`, que so roda em alvo caido ou quando a
                        // postura fica urgente. Com a postura "dormindo" ele
                        // nunca rodava, entao TODO alvo tinha par desconhecido,
                        // e "desconhecido conta como sensivel" punha os imunes
                        // na frente da fila. O `[EM SECO]` mirou `0x034a3304`,
                        // que e weETH contra WETH.
                        //
                        // Agora o par e resolvido para os candidatos do TOPO
                        // antes de qualquer publicacao. So na varredura
                        // completa — e ela ja gasta 34 multicalls, entao mais
                        // alguns nao mudam o ritmo — e so para quem ainda nao se
                        // sabe, entao o custo cai a zero depois das primeiras
                        // voltas.
                        await resolverPares(medidos);
                        for (const m of medidos) m.via = oQueSeSabeDaVia(m.devedor);

                        const camadas = repartirPorFragilidade(
                            medidos, vagasNaBrasa, MARGEM_QUENTE, pisoDeDivida, 0,
                        );
                        brasa = camadas.brasa;
                        quentes = camadas.quentes;
                        // Quem saiu da brasa leva o historico embora. Sem isso
                        // uma posicao que voltasse teria amostras de dois
                        // regimes diferentes na mesma reta, e a reta inventaria
                        // uma previsao.
                        esquecerQuemSaiu(historicoDeSaude, brasa);
                        tabelaDeQuedas = comoLerAsQuedas(oQueUmaQuedaRenderia(medidos, [1, 2, 3, 5, 10]));
                        tabelaDeAltas = comoLerAsQuedas(oQueUmaAltaRenderia(medidos, [1, 2, 3, 5, 10]));
                        bussola = comoLerABussola(contarVias(medidos));
                        // O teto era IMPLICITO: o bot sabia recusar uma baleia
                        // (a simulacao reverte, o piso de lucro barra), mas
                        // nada no log dizia que existe um tamanho acima do qual
                        // nao ha o que ganhar. Para quem le, teto implicito e o
                        // mesmo que teto inexistente — e foi assim que eu mesmo
                        // publiquei uma queda de 10% valendo US$ 2,1 milhoes.
                        if (tetoDoPool === '') {
                            tetoDoPool =
                                `pool de US$ ${PROFUNDIDADE_DA_VENDA.toFixed(0)}: cubro no máximo ` +
                                `US$ ${coberturaOtima().toFixed(0)} por caçada, e isso rende ` +
                                `US$ ${lucroMaximo().toFixed(0)}. Dívida maior não é problema — ` +
                                `cubro só a fatia ótima e deixo o resto`;
                        }
                        margemDaBrasa = camadas.margemDaBrasa;
                        // No modo prova o ritmo tem de seguir o alvo em que o
                        // bot ATIRA, e nao o que passa o piso de tamanho.
                        menorMargem = margemQueDecideORitmo(camadas, provaAgora().armado);
                        // O ensaio exercita o CAMINHO, nao ganha dinheiro:
                        // se a brasa ficou vazia porque todo mundo esta abaixo
                        // do piso de tamanho, qualquer devedor nao-liquidavel
                        // serve. Sem esta saida o piso calaria justamente o
                        // unico teste que prova que o tiro sai.
                        //
                        // E o alvo do ensaio TEM de ser um que o preço derruba.
                        // Ensaiar num weETH/WETH exercita o caminho, sim, mas
                        // publica `margemDoAlvo: precisa cair 0.0434%` sobre uma
                        // posição que nenhuma queda alcança — e é essa linha que
                        // ela lê para saber o quanto falta.
                        // O alvo do ensaio tem de ser um que o PRECO derruba,
                        // por qualquer das duas vias: `long`, `short` ou `ambas`.
                        // Antes so `false` passava, e `false` era "nao e imune" —
                        // que agora tem tres formas, nao uma.
                        const sensiveis = brasa.filter((d) => {
                            const v = oQueSeSabeDaVia(d);
                            return v !== undefined && v !== 'imune';
                        });
                        const paraEnsaiar = sensiveis[0]
                            ?? brasa[0]
                            ?? [...medidos].sort((a, b) => a.queda.comparedTo(b.queda))[0]?.devedor;
                        if (!jaEnsaiou && paraEnsaiar) {
                            jaEnsaiou = true;
                            void tiroEmSeco(paraEnsaiar);
                        }
                        ultimoCompleto = Date.now();
                        log.info(`[BLOCO ${blocoAtual}] Varredura completa.`, {
                            alvosChecados: aLer.length,
                            naBrasa: brasa.length,
                            naListaQuente: TETO_DA_LISTA_QUENTE > 0 && quentes.length > TETO_DA_LISTA_QUENTE
                            ? `${quentes.length}, mas LI SÓ ${TETO_DA_LISTA_QUENTE} (teto CACA_TETO_QUENTE) — ${quentes.length - TETO_DA_LISTA_QUENTE} não foram vistos neste ciclo`
                            : `${quentes.length} (todos lidos)`,
                            // A resposta para "por que 23h sem nada": nao e o
                            // bot que esta cego, e a lista que e de po. Sem
                            // este numero "naBrasa 234" parecia 234 alvos.
                            // A etiqueta tem de dizer o ESTADO, e não supor o
                            // motivo. Em 2026-09-28 esta linha imprimiu
                            // `nenhuma (modo prova desligado)` 100ms antes de o
                            // `[EM SECO]` imprimir `tiroDeProva: ARMADO` — duas
                            // linhas do mesmo log se contradizendo sobre o mesmo
                            // estado. Zero vagas RESERVADAS passou a querer
                            // dizer o contrário do que a frase dizia: no modo
                            // prova o piso já é US$ 0,50 e a brasa INTEIRA é
                            // dos alvos de prova, então não há o que reservar.
                            vagasDeProva: provaAgora().armado
                                ? `nenhuma RESERVADA — e não precisa: o modo prova está ARMADO, o piso é `
                                  + `US$ ${pisoDeDivida?.toFixed(2) ?? '?'} e as ${brasa.length} vagas da brasa `
                                  + 'já são todas de alvos que ele atira'
                                : camadas.vagasDeProva === 0
                                    ? 'nenhuma (modo prova desligado)'
                                    : `${camadas.vagasDeProva} das ${brasa.length} vagas da brasa estão vigiando alvos de PROVA (abaixo do piso)`,
                            valemUmTiro: pisoDeDivida === null
                                ? `${medidos.length} (sem cotação do ETH: não filtrei por tamanho)`
                                : `${camadas.valemUmTiro} de ${medidos.length} — ${camadas.poEmDemasia} devem menos de US$ ${pisoDeDivida.toFixed(2)} e não pagariam o próprio gás`,
                            gatilhoEm: `${margemDaBrasa.toFixed(4)}%`,
                            // `maisPerto` sai da BRASA INTEIRA, porque e nela que
                            // o bot atira. Sair de `menorMargem` — que ignora os
                            // alvos de prova — fez o log dizer 1,4260% enquanto
                            // havia poeira a 0,98%, e e este numero que ela le para
                            // saber o quanto falta.
                            // Brasa vazia (orcamento de multicall pequeno, lista de
                            // moedas longa) nao pode virar "ninguém" com um alvo a
                            // 0,5% de cair: e o mesmo defeito invertido.
                            maisPerto: (() => {
                                const daBrasa = camadas.menorMargemDaBrasa ?? camadas.menorMargem;
                                if (daBrasa === null) return 'ninguém';
                                const comPiso = camadas.menorMargem;
                                const diferem = comPiso !== null && !comPiso.equals(daBrasa);
                                return `precisa cair ${daBrasa.toFixed(4)}%`
                                    + (diferem
                                        ? ` (o mais perto que passa o piso de tamanho está a ${comPiso.toFixed(4)}%)`
                                        : '');
                            })(),
                            // A pergunta que decide se vale esperar o mercado ou
                            // ir procurar caça em outro lugar. `menorMargem`
                            // sozinha nao dizia se atras do primeiro vem um ou
                            // vem cinquenta.
                            seOMercadoCair: tabelaDeQuedas,
                            seADividaSubir: tabelaDeAltas,
                            bussola,
                            tetoDoPool,
                            // Para os alvos cujo preco CANCELA na conta da saude
                            // (garantia e divida na mesma moeda), a chegada e
                            // calculavel dias antes. Este e o unico numero do
                            // log que fala do FUTURO, e ele so aparece quando
                            // as tres guardas de `projetar` deixam.
                            chegandoPorJuro: (() => {
                                const fila = oQueVemPorAi(historicoDeSaude, 30 * 86_400_000);
                                if (fila.length === 0) {
                                    return historicoDeSaude.size < 2
                                        ? 'ainda medindo a deriva'
                                        : 'ninguém com deriva de juro projetável em 30 dias';
                                }
                                return fila.slice(0, 3)
                                    .map((c) => `${c.devedor.slice(0, 10)}… em ${emQuantoTempo(c.emMs)} (${c.taxaAnual.mul(100).toFixed(2)}%/ano)`)
                                    .join(' | ');
                            })(),
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

            // Quem ja estava armado nao precisa de ida a rede nenhuma agora.
            // Alvo armado tem PRAZO, e a validade so era conferida na hora de
            // REarmar — nunca na hora de usar. `dividaCrua` velha dimensiona o
            // emprestimo errado: divida que cresceu com juros faz o bot
            // sub-emprestar e deixar agio na mesa dizendo ACERTOU; divida que
            // ja foi parcialmente liquidada faz o pedido passar dos 50%
            // cobriveis, e a Aave reverte com o gas pago.
            const armadoValido = Date.now() - armadoEm <= VALIDADE_ARMADO_MS;
            const jaArmados = armadoValido
                ? caidos.map((d) => alvosArmados.get(d.toLowerCase())).filter((a): a is Alvo => a !== undefined)
                : [];
            const faltando = armadoValido
                ? caidos.filter((d) => !alvosArmados.has(d.toLowerCase()))
                : caidos;
            const alvos = faltando.length === 0
                ? jaArmados
                : [...jaArmados, ...await montarAlvos(faltando, moedas, dataProvider, precos, casas)];
            // O par so e conhecido aqui, depois de ler as reservas. Guardar o
            // veredicto alimenta a ordenacao da brasa no proximo ciclo: quem se
            // sabe imune vai para tras, quem se sabe sensivel vem para a frente.
            for (const a of alvos) lembrarAVia(a.devedor, viaDeQuebra(a.garantia, a.divida));
            if (jaArmados.length > 0) {
                log.info('[PRONTO] Cheguei com o alvo já montado.', {
                    jaArmados: jaArmados.length,
                    tiveQueMontarAgora: faltando.length,
                    armadoHa: `${Date.now() - armadoEm}ms`,
                });
            }

            for (const alvo of alvos) {
                // Duas fases, e a separacao existe por um motivo caro: o laco
                // antigo ENVIAVA dentro dele, uma transacao por contrato no
                // MESMO alvo. Nonces consecutivos da mesma carteira sao
                // minerados em ordem, entao a segunda so entra depois da
                // primeira ter liquidado — e ai a posicao ja nao e liquidavel.
                // Reversao garantida, gas pago, e o placar contava como
                // derrota, subindo a gorjeta como se um concorrente tivesse
                // ganhado.
                //
                // Fase 1: medir todos (eth_call custa CU, nao gas).
                const medicoes: Array<{ contrato: typeof contratos[number]; lucroCru: bigint }> = [];
                for (const contrato of contratos) {
                    const dados = contrato.tipo === 'V1'
                        ? codificarCacaV1({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: cobrir(alvo),
                            poolDeVenda: poolParaVender(alvo, poolDeVendaV1),
                            lucroMinimo: PISO_IMPOSSIVEL,
                          })
                        : codificarCacaV2({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: cobrir(alvo),
                            isStablePool: false,
                            // O V2 NAO pode ser medido com piso impossivel.
                            // Medido em 2026-09-28 com o oraculo forcado: ele
                            // empurra `aDevolver + minProfit` como
                            // `amountOutMin` PARA O ROUTER da Aerodrome, que
                            // recusa antes de executar qualquer coisa com
                            // `InsufficientOutputAmount()` (0x42301c23). O piso
                            // impossivel garantia a recusa SEMPRE — entao o V2
                            // nunca devolvia medicao, e como o bot so atira em
                            // cima de medicao, o V2 estava morto para a decisao.
                            //
                            // Com o piso no LIMIAR DA DECISAO a resposta vira
                            // sim/nao no unico ponto que importa: passou quer
                            // dizer "o lucro cobre o que o tiro custa". Nao da
                            // o valor exato, e nao precisa — quem julga e
                            // `decidirTiro`, e ele compara com este mesmo custo.
                            lucroMinimo: pisoParaMedirV2(alvo),
                          });

                    const r = await chamarCruComPaciencia([{ from: donoCarteira ?? undefined, to: contrato.endereco, data: dados }, 'latest']);
                    // O V2 que PASSA e uma medicao: o lucro e pelo menos o piso
                    // que foi exigido dele. Lido como sucesso comum,
                    // `lerRespostaDaCaca` devolveria `lucroCru: 0n` (resposta
                    // vazia), que e o oposto do que acabou de ser provado.
                    const leitura = contrato.tipo === 'V2' && r.ok
                        ? { desfecho: 'mediu' as const, lucroCru: pisoParaMedirV2(alvo), erro: undefined, dadosCrus: undefined }
                        : lerRespostaDaCaca({
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

                    // `leitura.lucroCru` e um bigint, e `0n` e FALSO em
                    // JavaScript. Com o teste de veracidade, uma medicao de lucro
                    // exatamente zero — que `lerRespostaDaCaca` devolve de
                    // proposito, com `desfecho: 'mediu'` — era jogada fora como
                    // "nao mediu": o alvo era pulado com um `continue` seco e a
                    // linha de recusa, a unica que explica por que o bot nao
                    // atirou, nunca saia. Ausencia com cara de resposta no lugar
                    // mais caro do codigo.
                    //
                    // Quem julga o numero e `decidirTiro`, num lugar so. Aqui so
                    // se pergunta se houve medicao.
                    if (leitura.desfecho === 'mediu' && leitura.lucroCru !== undefined) {
                        medicoes.push({ contrato, lucroCru: leitura.lucroCru });
                    } else if (vaoCruzar.has(alvo.devedor.toLowerCase())
                        && leitura.desfecho === 'revertido'
                        // Os DADOS crus vao junto: a identidade do erro está no
                        // seletor, nunca na mensagem. Medido na Base: o RPC diz
                        // só "execution reverted" e manda `0x930bb771` nos dados.
                        && naoCruzouAinda(leitura.erro, leitura.dadosCrus)) {
                        // Alvo escolhido para atirar ANTES do cruzamento: a medicao
                        // TEM de reverter, porque a Aave recusa uma posicao que
                        // ainda esta saudavel. Barrar aqui seria exigir que o alvo
                        // ja estivesse liquidavel — que e exatamente a espera que
                        // faz o bot chegar sempre depois.
                        //
                        // So vale para quem esta neste conjunto. Aceitar qualquer
                        // reversao viraria tiro no escuro em cima de configuracao
                        // quebrada.
                        log.warn('[ANTES DO CRUZAMENTO] A medição reverteu, como tinha de reverter.', {
                            devedor: alvo.devedor,
                            contrato: contrato.nome,
                            desfecho: leitura.desfecho,
                            erro: leitura.erro ?? '—',
                            oQueIssoQuerDizer: 'a posição ainda não cruzou; mando mirando o bloco em que ela cruza',
                        });
                        medicoes.push({ contrato, lucroCru: 0n });
                    } else if (vaoCruzar.has(alvo.devedor.toLowerCase())) {
                        // Estava escolhido para atirar antes, mas a medicao NAO
                        // reverteu por "ainda nao cruzou". Pode ser falha de rede
                        // (rotina no RPC publico) ou configuracao quebrada — e
                        // fabricar `lucroCru: 0n` nesses casos manda dinheiro de
                        // verdade em cima de uma medicao inventada, o defeito mais
                        // caro possivel. A primeira versao desta ramificacao fazia
                        // exatamente isso, contra o que o proprio comentario dela
                        // dizia.
                        log.error('[ANTES DO CRUZAMENTO] NÃO mando: a medição falhou por outro motivo.', {
                            devedor: alvo.devedor,
                            contrato: contrato.nome,
                            desfecho: leitura.desfecho,
                            erro: leitura.erro ?? '—',
                            oQueIssoQuerDizer: leitura.desfecho === 'falhaDeRede'
                                ? 'a rede falhou, não a Aave. Mandar aqui seria atirar no escuro'
                                : 'a reversão não foi "ainda não cruzou" — pode ser configuração quebrada',
                        });
                    }
                }

                // Fase 2: UM tiro, no contrato que mediu o maior lucro.
                if (!ENVIAR || !carteira || !carteira.provider || !nonceManager) continue;
                if (medicoes.length === 0) continue;
                medicoes.sort((a, b) => (b.lucroCru > a.lucroCru ? 1 : b.lucroCru < a.lucroCru ? -1 : 0));
                const escolhida = medicoes[0];
                const contrato = escolhida.contrato;
                const lucroCruValido = escolhida.lucroCru;
                if (medicoes.length > 1) {
                    log.info('[ESCOLHA] Dois contratos mediram; atiro só no melhor.', {
                        devedor: alvo.devedor,
                        escolhido: contrato.nome,
                        lucros: medicoes.map((m) => `${m.contrato.nome}: ${m.lucroCru}`),
                        porque: 'dois tiros no mesmo alvo = o segundo reverte com o gás pago',
                    });
                }
                {
                    const chaveAlvo = `${alvo.devedor}-${contrato.tipo}`;
                    const registro = falhasPorAlvo.get(chaveAlvo);
                    if (registro && Date.now() - registro.em > ESQUECER_FALHA_MS) falhasPorAlvo.delete(chaveAlvo);
                    const jaFalhou = falhasPorAlvo.get(chaveAlvo)?.quantas ?? 0;
                    if (jaFalhou >= MAX_POR_ALVO) {
                        log.info('[PULEI] Este alvo já falhou demais na última hora.', {
                            devedor: alvo.devedor, tentativas: jaFalhou, voltaEm: `${Math.round(ESQUECER_FALHA_MS / 60000)}min`,
                        });
                        continue;
                    }
                    if (Date.now() - janelaComecouEm > JANELA_DE_ENVIOS_MS) {
                        if (enviados > 0) log.info('[COTA] Janela de envios renovada.', { naJanelaAnterior: enviados });
                        enviados = 0;
                        janelaComecouEm = Date.now();
                    }
                    if (enviados >= MAX_ENVIOS) {
                        log.warn('[COTA] Teto de envios da janela atingido — não atiro até renovar.', {
                            enviados, tetoPorJanela: MAX_ENVIOS,
                            renovaEm: `${Math.round((JANELA_DE_ENVIOS_MS - (Date.now() - janelaComecouEm)) / 60000)}min`,
                        });
                        continue;
                    }

                    const piso = (lucroCruValido * 80n) / 100n;
                    
                    const envio = contrato.tipo === 'V1'
                        ? codificarCacaV1({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: cobrir(alvo),
                            poolDeVenda: poolParaVender(alvo, poolDeVendaV1),
                            lucroMinimo: piso,
                          })
                        : codificarCacaV2({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: cobrir(alvo),
                            isStablePool: false,
                            lucroMinimo: piso,
                          });
                
                    // `estimateGas` ENTROU AQUI em 2026-09-30, e o comentario
                    // anterior dizia o contrario: "gas nao usado volta, entao
                    // teto generoso e de graca". Isso e verdade para quem tem
                    // carteira grande e FALSO no caminho all-in que ela aprovou
                    // hoje — se o saldo inteiro vai para a gorjeta e a cacada usa
                    // uma unidade acima do teto, a transacao reverte sem gas e o
                    // dinheiro vai embora sem liquidacao nenhuma. Foi o pedido
                    // dela, com estas palavras: "NUNCA um limite cravado".
                    //
                    // Por que aqui funciona e nao antes: `eth_estimateGas` sobre
                    // `cacar()` num alvo que AINDA NAO cruzou devolve
                    // `execution reverted` — conferido na rede em 2026-09-30.
                    // Neste ponto a medicao por `eth_call` JA voltou com lucro,
                    // logo o alvo e liquidavel e a estimativa existe.
                    //
                    // O custo e uma ida a rede a mais no pior instante possivel,
                    // e por isso vai com TEMPO MAXIMO. Sem resposta no prazo o bot
                    // NAO atira: perder a liquidacao por RPC lento e ruim, perder
                    // o gas inteiro sem liquidar e pior, e foi ela quem escolheu
                    // essa ordem ("nao aceito um codigo que va atirar com risco
                    // de capotar no meio").
                    // 800ms, subido de 400 a pedido dela em 2026-09-30. A escolha
                    // e dela e tem lado: 800ms de espera custam meio bloco da
                    // Base (2s por bloco), mas perder a estimativa significa NAO
                    // atirar — e ela preferiu esperar mais a perder o alvo por um
                    // RPC lento. Nada abaixo disto muda de comportamento: quem
                    // responde em 300ms continua respondendo em 300ms.
                    const MS_PARA_ESTIMAR = numeroDoAmbiente('CACA_MS_ESTIMAR', process.env.CACA_MS_ESTIMAR, 800);
                    // O SALDO VAI DE CARONA NA ESTIMATIVA, pedido dela em
                    // 2026-10-03: "ler o saldo atual de ETH da carteira do
                    // enviador ANTES de construir o tiro".
                    //
                    // Ele já era lido, mas no máximo uma vez por minuto, porque
                    // uma ida à rede no laço quente custa a liquidação. O buraco
                    // que isso deixava: entre duas leituras o saldo pode ter
                    // caído por fora — ela movendo ETH, outro serviço gastando —
                    // e a trava toda é calculada CONTRA esse número. Saldo velho
                    // alto é o jeito exato de produzir o `insufficient funds` que
                    // ela está tentando evitar.
                    //
                    // E aqui não custa latência: a estimativa já espera até
                    // 800ms, e as duas chamadas correm JUNTAS dentro da mesma
                    // janela. Zero milissegundo a mais no instante do tiro.
                    //
                    // Falha ou atraso devolve `null`, e `null` cai no último
                    // saldo conhecido — nunca em zero. "Não consegui ler" não
                    // pode virar "está sem gás": uma abortaria a caçada por um
                    // soluço de RPC.
                    const [estimado, saldoAgora] = await Promise.all([
                        (async (): Promise<bigint | null> => {
                            try {
                                const resposta = await Promise.race([
                                    chamar<string>('eth_estimateGas', [{
                                        from: await carteira.getAddress(),
                                        to: contrato.endereco,
                                        data: envio,
                                    }]),
                                    new Promise<null>((r) => { const t = setTimeout(() => r(null), MS_PARA_ESTIMAR); t.unref?.(); }),
                                ]);
                                if (resposta === null) return null;
                                const n = BigInt(resposta);
                                return n > 0n ? n : null;
                            } catch { return null; }
                        })(),
                        (async (): Promise<bigint | null> => {
                            try {
                                const resposta = await Promise.race([
                                    (carteira!.provider as JsonRpcProvider).getBalance(donoCarteira!),
                                    new Promise<null>((r) => { const t = setTimeout(() => r(null), MS_PARA_ESTIMAR); t.unref?.(); }),
                                ]);
                                return resposta === null ? null : BigInt(resposta.toString());
                            } catch { return null; }
                        })(),
                    ]);
                    if (saldoAgora !== null) {
                        // Antes de `limiteDeGasDoTiro`, de propósito: é ele o
                        // primeiro a dimensionar pelo saldo, e dimensionar pelo
                        // saldo de um minuto atrás é a trava olhando o número
                        // errado.
                        saldoDeGasWei = saldoAgora;
                        saldoLidoEm = Date.now();
                        saldoJaLido = true;
                    }
                    const doGas = limiteDeGasDoTiro({
                        estimadoGas: estimado,
                        saldoWei: saldoDeGasWei,
                        baseFeeWei: baseFeeAtual ?? 20_000_000n,
                    });
                    if (doGas.limite === null) {
                        log.warn('[TIRO ABORTADO] Não estimei o gás, então não atiro.', {
                            devedor: alvo.devedor,
                            porque: doGas.porque,
                            oQueIssoCusta: 'esta liquidação. O que evita é perder o gás inteiro num revert sem gás',
                            comoDestravar: 'CACA_MS_ESTIMAR maior, ou um RPC que responda eth_estimateGas no prazo',
                        });
                        continue;
                    }
                    const limiteGas = doGas.limite;
                    const lucroUsd = emDolar(
                        lucroCruValido,
                        casas.get(alvo.divida.toLowerCase()),
                        precos.get(alvo.divida.toLowerCase()),
                    );
                    const base = baseFeeAtual ?? 20_000_000n;

                    // O saldo e lido no maximo uma vez por minuto: e uma ida a
                    // rede, e no caminho quente ela custaria a liquidacao.
                    if (Date.now() - saldoLidoEm > 60_000) {
                        try {
                            saldoDeGasWei = await (carteira.provider as JsonRpcProvider).getBalance(donoCarteira!);
                            saldoLidoEm = Date.now();
                            saldoJaLido = true;
                        } catch { /* seguir com o ultimo saldo conhecido */ }
                    }

                    if (!saldoJaLido) {
                        // Nunca conseguiu ler o saldo. Chamar isso de "sem gás"
                        // seria inventar: nao se sabe. E atirar no escuro pode
                        // gastar o que nao existe.
                        log.error('NÃO SEI QUANTO TENHO DE GÁS — não consegui ler o saldo. Não atiro no escuro.', {
                            devedor: alvo.devedor,
                            carteira: donoCarteira,
                        });
                        continue;
                    }

                    // TODA a conta do lance e TODOS os freios vivem em
                    // `decidirTiro`, e o ensaio em seco chama a MESMA funcao.
                    // Isto era uma copia aqui e outra la, e elas divergiram no
                    // mesmo dia em que a segunda ganhou um freio novo: o ensaio
                    // passou a imprimir "o tiro sai" para um premio que este
                    // caminho recusa. Uma regra, um lugar.
                    const ethUsd = precoDoEth();
                    const decisao = decidirTiro({
                        lucroUsd,
                        precoDoEthUsd: ethUsd,
                        saldoWei: saldoDeGasWei,
                        baseFeeWei: base,
                        ...POLITICA,
                        limiteGas,
                        perdasSeguidas,
                        tiroDeProva: provaAgora().armado,
                    });
                    const fracao = decisao.fracaoDoLucro;
                    const risco = decisao.risco;
                    const amordaca = decisao.amordaca;
                    const prioridadePorGas = decisao.prioridadeWei;
                    const maxFee = decisao.maxFeeWei;
                    const custoSePerder = decisao.custoSePerderWei;
                    const aguenta = decisao.aguentaDerrotas;
                    const saldoUsd = ethUsd === null
                        ? null
                        : new Decimal(saldoDeGasWei.toString()).dividedBy(1e18).mul(ethUsd);
                    const emEth = (w: bigint) => new Decimal(w.toString()).dividedBy(1e18).toFixed(6);

                    if (disjuntorAberto) continue;

                    if (!decisao.atira) {
                        // ABORTAR SEM ENCHER O LOG, pedido dela em 2026-10-02:
                        // "se o bot não tiver saldo sequer para cobrir a
                        // transação base, ele deve abortar em silêncio".
                        //
                        // O aborto sempre existiu — o que não existia era o
                        // silêncio. Com a carteira seca, esta linha saía para
                        // CADA alvo de CADA ciclo: centenas de blocos idênticos
                        // por minuto, afogando tudo que importa.
                        //
                        // Mas silêncio de verdade seria pior que a enxurrada, e
                        // é o defeito que este projeto persegue: "não atirei por
                        // falta de gás" calado é indistinguível de "não havia
                        // alvo". Então a linha sai INTEIRA na primeira vez e a
                        // cada mudança de motivo ou de saldo, e cala enquanto
                        // nada mudou — a mesma informação, uma vez.
                        const assinatura = `${decisao.porque}|${saldoDeGasWei}`;
                        const jaDisse = recusaJaDita.get(assinatura);
                        const agora = Date.now();
                        if (jaDisse !== undefined && agora - jaDisse < REPETIR_RECUSA_MS) {
                            recusasCaladas += 1;
                            continue;
                        }
                        recusaJaDita.set(assinatura, agora);
                        log.warn(`NÃO ATIREI: ${decisao.porque}`, {
                            calei: recusasCaladas > 0
                                ? `${recusasCaladas} recusas idênticas desde a última vez que falei (mesmo motivo, mesmo saldo)`
                                : 'nenhuma antes desta',
                            devedor: alvo.devedor,
                            premio: lucroUsd === null ? 'sem cotação' : `US$ ${lucroUsd.toFixed(2)}`,
                            saldo: `${emEth(saldoDeGasWei)} ETH`,
                            precoDoEth: ethUsd === null ? 'SEM COTAÇÃO' : `US$ ${ethUsd.toFixed(2)}`,
                            queriaDar: `${(Number(decisao.desejadaWei) / 1e9).toFixed(2)} gwei`,
                            sóConsigo: `${(Number(prioridadePorGas) / 1e9).toFixed(2)} gwei`,
                            cortado: amordaca.amordacado ? `${(amordaca.cortado * 100).toFixed(0)}%` : 'nada',
                            riscoUsado: `${(risco * 100).toFixed(0)}%`,
                            seEuPerderCusta: `${emEth(custoSePerder)} ETH (aguento ${aguenta})`,
                            oQueFazer: saldoDeGasWei === 0n
                                ? `mandar ETH do cofre 0x3dffA934...1512A7 para a conta_bot ${donoCarteira}`
                                : amordaca.amordacado
                                    ? `${emEth(amordaca.saldoQuePrecisaria)} ETH na conta_bot libera o lance inteiro, ou CACA_ATIRAR_AMORDACADO=1`
                                    : 'me mandar esta linha inteira',
                            oQueEuDeixeiPassar: lucroUsd === null ? 'sem cotação' : `US$ ${lucroUsd.toFixed(2)}`,
                        });
                        recusasCaladas = 0;
                        continue;
                    }

                    if (decisao.soPassouPorSerProva) {
                        // Sem este aviso o primeiro acerto viraria "ele
                        // funciona e da lucro" quando foi "ele funciona e deu
                        // prejuizo de proposito". Comprar informacao e legitimo;
                        // confundir a compra com receita, nao.
                        log.warn('TIRO DE PROVA — este tiro NÃO passaria na regra normal.', {
                            devedor: alvo.devedor,
                            premio: lucroUsd === null ? 'sem cotação' : `US$ ${lucroUsd.toFixed(2)}`,
                            custoDoTiro: decisao.custoUsd === null ? 'sem cotação' : `US$ ${decisao.custoUsd.toFixed(2)}`,
                            oQueIssoE: 'estou comprando a informação de que o caminho funciona, não lucro',
                            aTrava: provaAgora().porque,
                            depoisDisso: 'o nonce sobe e o modo se desarma sozinho, para sempre',
                        });
                    }
                    if (amordaca.amordacado) {
                        log.warn('LANCE AMORDAÇADO POR FALTA DE GÁS. Atiro, mas com a mão amarrada.', {
                            devedor: alvo.devedor,
                            premio: lucroUsd === null ? 'sem cotação' : `US$ ${lucroUsd.toFixed(2)}`,
                            queriaDar: `${(Number(decisao.desejadaWei) / 1e9).toFixed(2)} gwei`,
                            vouDar: `${(Number(prioridadePorGas) / 1e9).toFixed(2)} gwei`,
                            cortado: `${(amordaca.cortado * 100).toFixed(0)}%`,
                            saldo: `${emEth(saldoDeGasWei)} ETH`,
                            precisariaDe: `${emEth(amordaca.saldoQuePrecisaria)} ETH na conta_bot para o lance inteiro`,
                            seEuPerder: 'foi por não ter como cobrir, não por lentidão — o alvo estava na mira',
                        });
                    }

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
                        
                        log.info(`[TIRO SAIU] (${contrato.nome}) — ainda NÃO é acerto.`, {
                            bloco: blocoAtual,
                            devedor: alvo.devedor, 
                            hash: tx.hash,
                            gorjetaOfertadaGwei: (Number(prioridadePorGas) / 1e9).toFixed(3),
                            // Sem isto, um tiro amordaçado tem exatamente a
                            // mesma cara de um tiro inteiro — e a reversão que
                            // vem depois parece lentidão em vez de falta de gás.
                            gorjetaCortada: amordaca.amordacado
                                ? `SIM, ${(amordaca.cortado * 100).toFixed(0)}% — queria ${(Number(decisao.desejadaWei) / 1e9).toFixed(2)} gwei`
                                : 'não, lance inteiro',
                            lucroEstimadoUsd: lucroUsd === null ? 'sem cotação' : `US$ ${lucroUsd.toFixed(2)}`,
                            doCicloAoTiro: `${msDoTiro}ms`,
                            lance: `${(fracao * 100).toFixed(0)}% do lucro (${perdasSeguidas} derrotas seguidas)`,
                            sobrariaParaMim: lucroUsd === null ? 'sem cotação' : `US$ ${sobraDepoisDaGorjeta(lucroUsd, fracao).toFixed(2)}`,
                            seEuPerderCusta: `${new Decimal(custoSePerder.toString()).dividedBy(1e18).toFixed(6)} ETH (aguento mais ${aguenta})`,
                            arrisquei: saldoUsd === null || lucroUsd === null || saldoUsd.lessThanOrEqualTo(0)
                                ? `${(risco * 100).toFixed(0)}% do gás (risco básico: sem cotação para comparar)`
                                : `${(risco * 100).toFixed(0)}% do gás, porque o prêmio é ${lucroUsd.dividedBy(saldoUsd).toFixed(1)}x o saldo`,
                            verNaBlockchain: `https://basescan.org/tx/${tx.hash}`,
                        });

                        // Acompanhar ate o fim, SEM travar a cacada. Numa
                        // corrida o desfecho mais provavel e reverter: outro
                        // chegou antes e a posicao ja nao esta liquidavel
                        // quando a nossa entra. Sem olhar o recibo, acerto e
                        // erro dao exatamente o mesmo log.
                        // Abater o que acabou de ser comprometido. Sem isto,
                        // varios tiros no mesmo minuto dimensionavam o risco
                        // contra o saldo de ANTES de gastar: tres tiros
                        // arriscando 60% do MESMO dinheiro, e os ultimos
                        // morrendo em `insufficient funds`.
                        const comprometido = adiantadoExigido(limiteGas, maxFee);
                        saldoDeGasWei = saldoDeGasWei > comprometido ? saldoDeGasWei - comprometido : 0n;

                        const hashDoTiro = tx.hash;
                        const chaveDoTiro = chaveAlvo;
                        const devedorDoTiro = alvo.devedor;
                        const lucroDoTiro = lucroUsd;
                        void (async () => {
                            let desfecho: ReturnType<typeof lerRecibo>;
                            try {
                                desfecho = lerRecibo(await tx.wait(1, 120_000));
                            } catch (e) {
                                // O ethers REJEITA quando `status === 0`, e o
                                // recibo vem dentro do erro. Sem isto, todo
                                // tiro revertido era contado como "sumiu" e o
                                // placar dizia "não foi minerada" sobre uma
                                // transação minerada — matando justamente a
                                // medicao que separa perder por pouco de nao
                                // achar alvo.
                                const erro = e as { code?: string; receipt?: { status?: number | null; hash?: string } };
                                // TRANSACTION_REPLACED traz o recibo da
                                // transacao SUBSTITUTA. Ler o `status: 1` dela
                                // como acerto faria o bot somar um lucro que
                                // nao e dele, zerar as derrotas e escrever "O
                                // dinheiro foi para o cofre" sobre uma cacada
                                // que nao aconteceu.
                                if (erro?.code === 'TRANSACTION_REPLACED') {
                                    desfecho = 'sumiu';
                                } else {
                                    desfecho = erro?.receipt ? lerRecibo(erro.receipt) : 'sumiu';
                                }
                            }
                            tiros = contarTiro(tiros, desfecho, lucroDoTiro);
                            // Perder sobe o lance; ganhar devolve ele para a
                            // base. Assim o bot nao paga caro para sempre por
                            // uma sequencia ruim que ja passou.
                            perdasSeguidas = desfecho === 'acertou' ? 0 : perdasSeguidas + 1;
                            if (desfecho !== 'acertou') {
                                const r = falhasPorAlvo.get(chaveDoTiro);
                                falhasPorAlvo.set(chaveDoTiro, { quantas: (r?.quantas ?? 0) + 1, em: Date.now() });
                            } else {
                                falhasPorAlvo.delete(chaveDoTiro);
                            }
                            if (desfecho === 'acertou' && disjuntorAberto) {
                                disjuntorAberto = false;
                                log.info('[DISJUNTOR] Religado: um tiro acertou.');
                            }
                            if (!disjuntorAberto && perdasSeguidas >= DERROTAS_ATE_PARAR) {
                                disjuntorAberto = true;
                                log.error(`[DISJUNTOR] ${perdasSeguidas} derrotas seguidas — PAREI de atirar.`, {
                                    oQueIssoQuerDizer: 'perder tanto seguido não é perder a corrida: é alguma coisa quebrada (nonce, RPC, contrato, ou o lucro medido não existe)',
                                    oQueFazer: 'me mandar as últimas linhas [ERROU]/[SUMIU]. Continuo medindo e contando, sem gastar.',
                                    gastoAteAqui: `${tiros.disparados} tiros`,
                                });
                            }
                            const dados = {
                                devedor: devedorDoTiro,
                                hash: hashDoTiro,
                                lucro: lucroDoTiro === null ? 'sem cotação' : `US$ ${lucroDoTiro.toFixed(2)}`,
                                placar: comoEstaIndo(tiros),
                                verNaBlockchain: `https://basescan.org/tx/${hashDoTiro}`,
                            };
                            if (desfecho === 'acertou') {
                                if (decisao.soPassouPorSerProva) {
                                    // Um acerto de prova prova o CAMINHO, e nao
                                    // que a estrategia da dinheiro. O cofre vai
                                    // receber centavos: a evidencia e a
                                    // transacao, nao o saldo.
                                    log.warn('*** A PROVA FOI FEITA. O caminho inteiro funcionou de verdade. ***', {
                                        oQueIssoProva: 'a Aave aceitou a liquidação, o contrato vendeu a garantia e mandou o lucro para o cofre',
                                        oQueIssoNAOProva: 'que a estratégia dá dinheiro — este tiro foi escolhido por ser barato, não por ser lucrativo',
                                        ondeVer: `https://basescan.org/tx/${tx.hash}`,
                                        oCofre: 'vai receber centavos, não um valor visível. A evidência é a transação',
                                        aTravaAgora: 'o nonce subiu: o modo prova se desarmou sozinho, para sempre',
                                        oQueFazerAgora: 'desligar CACA_TIRO_DE_PROVA no Railway e voltar à regra normal',
                                    });
                                }
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
                        await nonceManager.aposFalhar();
                        falhasPorAlvo.set(chaveAlvo, { quantas: jaFalhou + 1, em: Date.now() });
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
            // Com o dedo no gatilho o ciclo quase sempre passa dos 200ms — a
            // ida ao mercado sozinha leva mais que isso. Condicionar a espera a
            // `resta > 0` fazia o galho do WebSocket ser codigo morto
            // exatamente no unico estado para o qual foi construido, e o laco
            // voltava sem espera nenhuma: ~3 ciclos/s, centenas de milhares de
            // CU numa tarde de mercado ruim.
            if (posturaAgora() === 'dedo no gatilho') {
                if (ouvinte?.vivo) {
                    // Com o dedo no gatilho, quem acorda o bot e o BLOCO, nao o
                    // relogio: o aviso chega no instante em que ele nasce. O
                    // tempo maximo existe para nunca ficar preso esperando um
                    // aviso que nao vem — WebSocket mudo e indistinguivel de
                    // rede parada, e ficar pendurado seria pior que perguntar.
                    // Quem acorda o bot aqui e o BLOCO, no instante em que
                    // nasce. O tempo maximo existe so para nunca ficar preso
                    // esperando um aviso que nao vem.
                    await esperarBlocoOuTempo(
                        (aoBloco) => ouvinte.assinar(aoBloco),
                        2500,
                        (fn, ms) => setTimeout(fn, ms),
                        (id) => clearTimeout(id as NodeJS.Timeout),
                    );
                } else {
                    // Sem aviso de bloco, um piso de ritmo impede o laco de
                    // girar na velocidade da rede queimando CU.
                    await dormir(ritmo);
                }
            } else if (resta > 0) {
                await dormirDeOlho(resta, OLHAR_MERCADO_MS, olharMercado, async (ms) => { await dormir(ms); });
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
