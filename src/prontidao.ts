// Arquivo: src/prontidao.ts
//
// Estar pronto ANTES da hora.
//
// Entre ver alguem cair e enviar a transacao, o cacador fazia tres idas a rede:
// `estimateGas`, `getFeeData` e o nonce. Sao centenas de milissegundos jogados
// fora no unico instante em que eles custam a liquidacao — e nenhuma das tres
// precisa acontecer ali.
//
// O nonce ja era local. O limite de gas nao precisa ser estimado: gas nao
// gasto e devolvido, entao um teto generoso e de graca e um teto apertado so
// serve para a transacao morrer sem gas. E o preco base do bloco vem de
// carona no multicall que o ciclo ja faz, por zero requisicao a mais.
import { Decimal } from 'decimal.js';

/** `getBasefee()` do Multicall3 — o preco base do bloco, de graca no ciclo. */
export const SELETOR_BASEFEE = '0x3e64a696';

/**
 * O teto de gas que se manda, sem estimar.
 *
 * "Gas nao usado volta, entao um teto generoso nao custa nada" — era o que eu
 * achava, e esta ERRADO quando a carteira e pequena. O no congela
 * `gasLimit × maxFeePerGas` ADIANTADO, pelo teto e nao pelo consumo. Com 2M
 * de teto e US$14 de saldo, o maior lance possivel cai para 2,41 gwei: dois
 * tercos do poder de lance ficam presos garantindo gas que nunca sera usado.
 *
 * O ensaio da cadeia inteira mostrou isso — numa liquidacao de US$150 mil ela
 * ofereceria 2,41 gwei querendo oferecer 50. Nenhum teste de funcao pegaria,
 * porque cada peca estava certa sozinha.
 *
 * 1,2M da 71% de folga sobre os ~700k que uma cacada usa, e quase DOBRA o
 * lance possivel. Apertado demais seria pior: morrer sem gas custa a
 * transacao inteira, depois de pagar.
 */
export const LIMITE_DE_GAS = BigInt(process.env.CACA_LIMITE_GAS ?? '1200000');

/**
 * O gas que uma cacada REALMENTE usa.
 *
 * Diferente do teto. A gorjeta e dividida por este numero, nao pelo limite:
 * dividir pelo teto de 2M quando a transacao usa ~700k faz o lance efetivo
 * virar 14% do lucro quando o log diz 40% — o bot pagaria menos do que decidiu
 * pagar, e perderia leiloes achando que estava competindo.
 */
export const GAS_TIPICO_DE_UMA_CACADA = 700_000n;

/** Nunca ofereca menos que isso, ou a transacao pode nem ser considerada. */
export const PISO_DA_GORJETA_WEI = 100_000_000n; // 0,1 gwei
/** Nem mais que isso, ou um lucro mal medido vira um gasto absurdo. */
export const TETO_DA_GORJETA_WEI = 50_000_000_000n; // 50 gwei

/** Quanto do lucro vira gorjeta para furar a fila. */
export const FRACAO_DO_LUCRO = 0.4;

/**
 * Quanto oferecer de gorjeta, por unidade de gas.
 *
 * Conserta um defeito que estava no caminho quente. A conta antiga era
 * `lucroCru * 40% / limiteGas`, com `lucroCru` nas unidades CRUAS do ativo da
 * divida. Isso mistura unidades: o mesmo lucro de US$88 vira 35.200.000 se a
 * divida for USDC (6 casas) e 1,3e16 se for WETH (18 casas) — uma diferenca de
 * dez ordens de grandeza para o MESMO dinheiro.
 *
 * Na pratica o bot oferecia sempre o piso quando a divida era USDC, e uns 6,6
 * gwei quando era WETH. Ou seja: competia de verdade em algumas liquidacoes e
 * nao competia em outras, sem nenhuma razao economica — so pelo numero de
 * casas decimais do token.
 *
 * Aqui a conta passa por dolar, que e a unica unidade em que os dois lucros
 * sao comparaveis.
 */
export function gorjetaPorGas(entrada: {
    lucroUsd: Decimal;
    precoDoEthUsd: Decimal;
    /** O gas que a cacada USA — nao o teto que se manda. */
    limiteGas?: bigint;
    fracaoDoLucro?: number;
    pisoWei?: bigint;
    tetoWei?: bigint;
}): bigint {
    const limite = entrada.limiteGas ?? GAS_TIPICO_DE_UMA_CACADA;
    const piso = entrada.pisoWei ?? PISO_DA_GORJETA_WEI;
    const teto = entrada.tetoWei ?? TETO_DA_GORJETA_WEI;
    if (entrada.precoDoEthUsd.lessThanOrEqualTo(0) || limite <= 0n) return piso;

    const lucroEmEth = entrada.lucroUsd.dividedBy(entrada.precoDoEthUsd);
    const gorjetaWei = lucroEmEth
        .mul(entrada.fracaoDoLucro ?? FRACAO_DO_LUCRO)
        .mul(new Decimal(10).pow(18));
    if (!gorjetaWei.isFinite() || gorjetaWei.lessThanOrEqualTo(0)) return piso;

    let porGas: bigint;
    try {
        porGas = BigInt(gorjetaWei.dividedBy(limite.toString()).toFixed(0));
    } catch {
        return piso;
    }
    if (porGas < piso) return piso;
    if (porGas > teto) return teto;
    return porGas;
}

/**
 * O teto total por unidade de gas: o que o bloco cobra mais a gorjeta.
 *
 * O preco base sobe entre blocos, entao vai uma folga em cima dele. Pagar de
 * menos aqui faz a transacao ficar parada justamente quando a pressa importa.
 */
export function tetoPorGas(baseFeeWei: bigint, gorjetaWei: bigint, folga = 2n): bigint {
    return baseFeeWei * folga + gorjetaWei;
}

/** Le o `getBasefee()` do multicall. `null` quando nao veio — nunca um chute. */
export function lerBasefee(hex: string | null): bigint | null {
    if (!hex || hex === '0x') return null;
    try {
        const v = BigInt(hex);
        return v > 0n ? v : null;
    } catch {
        return null;
    }
}

/**
 * Quanto do lucro virar gorjeta, depois de perder seguidas vezes.
 *
 * Existe porque numa corrida onde todos chegam no mesmo bloco, quem ganha nao
 * e o mais rapido: e quem paga mais. A transacao com mais gorjeta entra
 * primeiro, e a segunda reverte porque a posicao ja nao esta liquidavel.
 *
 * Entao perder repetidamente nao pede codigo mais rapido — pede lance maior. E
 * ganhar de volta nao pede lance alto para sempre: quando comeca a acertar, o
 * bot desce de novo e guarda a diferenca.
 *
 * O teto e o que separa disputar de se entregar. Acima dele, ganhar a
 * liquidacao custa quase tudo que ela rende, e o certo e deixar passar.
 */
export const TETO_DA_FRACAO = 0.8;
export const PASSO_DA_FRACAO = 0.1;

export function fracaoAdaptativa(entrada: {
    base?: number;
    perdasSeguidas: number;
    teto?: number;
    passo?: number;
}): number {
    const base = entrada.base ?? FRACAO_DO_LUCRO;
    const teto = entrada.teto ?? TETO_DA_FRACAO;
    const passo = entrada.passo ?? PASSO_DA_FRACAO;
    if (entrada.perdasSeguidas <= 0) return base;
    return Math.min(teto, base + entrada.perdasSeguidas * passo);
}

/**
 * O que sobra para voce depois de pagar a gorjeta, em dolar.
 *
 * Serve para a decisao nao virar "quanto eu aguento pagar" e sim "quanto eu
 * ainda ganho se pagar". Ganhar 100% de um lucro de US$17 e melhor que ganhar
 * 0% de um lucro de US$88 — mas so ate o ponto em que sobra alguma coisa.
 */
export function sobraDepoisDaGorjeta(lucroUsd: Decimal, fracao: number): Decimal {
    return lucroUsd.mul(1 - fracao);
}

/**
 * Quanto gas uma liquidacao consome quando REVERTE.
 *
 * Eram 150.000, e estava errado por 4,7 vezes — no sentido perigoso.
 *
 * Existem duas reversoes, e a cara e a comum. A Aave recusando cedo (posicao
 * saudavel) custa ~150k. Mas o contrato tambem reverte com `LucroInsuficiente`
 * DEPOIS do emprestimo, da liquidacao e da venda — ou seja gastando a cacada
 * inteira, ~700k. E esse e o caminho COMUM, porque o bot manda
 * `lucroMinimo = 80% do lucro medido`: basta alguem mexer no pool no mesmo
 * bloco.
 *
 * Com 150k o freio de sobrevivencia dizia "aguento mais 6 derrotas" quando a
 * verdade era 1, e liberava um tiro que leva metade da carteira. Freio que
 * erra tem que errar para o lado seguro.
 */
export const GAS_DE_UMA_REVERSAO = GAS_TIPICO_DE_UMA_CACADA;

/**
 * O que UMA derrota custa, em wei.
 *
 * Gorjeta e cobrada mesmo perdendo: prioridade se paga pelo gas consumido,
 * tenha a transacao dado certo ou nao. Foi isso que quase passou batido — o
 * lance adaptativo sobe ate 80% do lucro, e com lucro de US$300 isso vira uma
 * derrota de US$18 numa carteira que tem US$14.
 */
export function custoDeUmaDerrota(
    gorjetaPorGasWei: bigint,
    baseFeeWei: bigint,
    gasDaReversao: bigint = GAS_DE_UMA_REVERSAO,
): bigint {
    return (gorjetaPorGasWei + baseFeeWei) * gasDaReversao;
}

/**
 * A maior gorjeta que cabe no saldo, sem apostar a carteira numa tacada.
 *
 * Existe porque o limite do lance nao pode ser so economico ("quanto do lucro
 * vale pagar"), tem que ser tambem de sobrevivencia ("quanto eu aguento
 * perder"). Um bot sem gas nao perde uma liquidacao: perde TODAS as seguintes,
 * e em silencio, porque parar de conseguir enviar nao levanta erro nenhum.
 */
export function gorjetaQueCabeNoSaldo(entrada: {
    gorjetaDesejadaWei: bigint;
    saldoWei: bigint;
    baseFeeWei: bigint;
    fracaoMaximaDoSaldo?: number;
    gasDaReversao?: bigint;
}): bigint {
    const fracao = entrada.fracaoMaximaDoSaldo ?? 0.25;
    const gas = entrada.gasDaReversao ?? GAS_DE_UMA_REVERSAO;
    if (entrada.saldoWei <= 0n) return 0n;
    const tetoDoRisco = (entrada.saldoWei * BigInt(Math.round(fracao * 10_000))) / 10_000n;
    const porGasQueCabe = tetoDoRisco / gas;
    const semOBase = porGasQueCabe > entrada.baseFeeWei ? porGasQueCabe - entrada.baseFeeWei : 0n;
    return entrada.gorjetaDesejadaWei < semOBase ? entrada.gorjetaDesejadaWei : semOBase;
}

/** Quantas derrotas seguidas o saldo aguenta neste lance. */
export function derrotasQueAguenta(saldoWei: bigint, custoDaDerrotaWei: bigint): number {
    if (custoDaDerrotaWei <= 0n) return Infinity;
    return Number(saldoWei / custoDaDerrotaWei);
}

/**
 * Quanto do saldo vale arriscar, dado o tamanho do premio.
 *
 * A regra anterior era uma fracao fixa: nunca mais de 25% do saldo por tiro,
 * fosse o premio de US$12 ou de US$2.103. Isso nao e cautela, e uma regra que
 * nao olha para o que esta em jogo — e ela fazia o bot recusar uma aposta de
 * 590 para 1 com a mesma cara com que recusava uma de 3 para 1.
 *
 * Aqui o risco sobe junto com o retorno. Arriscar US$3,55 para ganhar US$12 e
 * um negocio medio; arriscar US$7 para ganhar US$2.103 e obvio. O que NAO pode
 * acontecer e o bot ficar sem bala: por isso existe a reserva, que garante um
 * numero minimo de tiros seguintes mesmo depois de uma derrota.
 *
 * Entao sao dois limites, e o menor vence:
 *   - o quanto o premio justifica arriscar
 *   - o quanto ainda deixa `tirosDeReserva` tentativas pela frente
 */
export function fracaoDoSaldoQueValeArriscar(entrada: {
    lucroUsd: Decimal;
    saldoUsd: Decimal;
    /** Abaixo disto o premio nao justifica arriscar mais que o basico. */
    fracaoBase?: number;
    fracaoMaxima?: number;
}): number {
    const base = entrada.fracaoBase ?? 0.25;
    const maxima = entrada.fracaoMaxima ?? 0.6;
    if (entrada.saldoUsd.lessThanOrEqualTo(0)) return 0;
    // Quantas vezes o premio cabe no que se arriscaria. Premio pequeno perto
    // do saldo nao justifica exposicao; premio muito maior justifica.
    const vezes = entrada.lucroUsd.dividedBy(entrada.saldoUsd);
    if (vezes.lessThanOrEqualTo(1)) return base;
    if (vezes.greaterThanOrEqualTo(10)) return maxima;
    // Entre 1x e 10x o saldo, sobe suavemente da base ate o maximo.
    const t = vezes.minus(1).dividedBy(9).toNumber();
    return base + (maxima - base) * t;
}

/**
 * O que o NO exige adiantado para aceitar a transacao.
 *
 * Nao e o que ela vai custar: e `gasLimit × maxFeePerGas`, cobrado no ato e
 * devolvido depois. Ignorar isso foi o defeito mais caro desta revisao — com o
 * teto de 2M e uma gorjeta boa, o adiantado passava de tres vezes o saldo
 * inteiro, e toda caçada morria em `insufficient funds` com o log culpando a
 * rede. O bot pareceria sem alvo, tendo alvo e tendo gas.
 */
export function adiantadoExigido(limiteGas: bigint, maxFeeWei: bigint): bigint {
    return limiteGas * maxFeeWei;
}

/**
 * O maior `maxFeePerGas` que o saldo aceita adiantar, deixando uma folga.
 *
 * Devolve 0 quando nem o basico cabe — e 0 aqui significa "nao da para atirar",
 * nao "atire de graca".
 */
export function maxFeeQueOSaldoAdianta(
    saldoWei: bigint,
    limiteGas: bigint,
    folga = 0.9,
): bigint {
    if (saldoWei <= 0n || limiteGas <= 0n) return 0n;
    return ((saldoWei * BigInt(Math.round(folga * 10_000))) / 10_000n) / limiteGas;
}

/**
 * Quanto o saldo AMORDACOU o lance, e de quanto saldo precisaria para soltar.
 *
 * Existe por um silencio. O caminho do tiro corta o lance quando o gas
 * adiantado nao cabe — `if (maxFee > adiantavel) maxFee = adiantavel` — e isso
 * esta certo, e salvou a cacada de morrer em `insufficient funds`. Mas o corte
 * nao dizia nada.
 *
 * Medido com o saldo real de 2026-09-27 (0,003341 ETH, US$ 8,99): num premio de
 * US$ 1.986 o bot quer dar 50 gwei e consegue 2,49. Corte de 95%. E o log
 * imprimiria um tiro de aparencia normal, com 2,49 gwei, e depois uma reversao
 * — e nada ligaria as duas coisas. Ela veria "reverteu" e pensaria que o bot
 * falhou, quando na verdade ele foi coberto por nao ter como cobrir.
 *
 * Perder a corrida por falta de gas e um resultado legitimo. Perder sem que o
 * log diga que foi por isso e o defeito que este projeto persegue desde o
 * primeiro dia: ausencia com cara de resposta.
 */
export interface LanceAmordacado {
    /** Fracao do lance desejado que o saldo cortou, de 0 a 1. */
    cortado: number;
    /** O saldo que deixaria dar o lance inteiro, em wei. */
    saldoQuePrecisaria: bigint;
    /** True quando o corte passou do limiar e merece log. */
    amordacado: boolean;
}

export function lanceAmordacado(entrada: {
    desejadaWei: bigint;
    conseguidaWei: bigint;
    limiteGas: bigint;
    baseFeeWei: bigint;
    folga?: number;
    /** Abaixo disto o corte e ruido de arredondamento e nao merece alarme. */
    limiar?: number;
}): LanceAmordacado {
    const folga = entrada.folga ?? 0.9;
    const limiar = entrada.limiar ?? 0.2;
    // Divisao para CIMA, e nao e detalhe: `maxFeeQueOSaldoAdianta` trunca duas
    // vezes, entao um saldo arredondado para baixo devolve um teto um wei
    // abaixo do necessario — e a resposta "coloque este tanto" nao soltaria o
    // lance. Um numero que erra por um wei para o lado errado e pior que
    // nenhum, porque ela poe o dinheiro e continua amordaçada.
    const folgaEmMilesimos = BigInt(Math.round(folga * 10_000));
    const exigido = adiantadoExigido(entrada.limiteGas, tetoPorGas(entrada.baseFeeWei, entrada.desejadaWei));
    const precisaria = entrada.limiteGas <= 0n || folgaEmMilesimos <= 0n
        ? 0n
        : (exigido * 10_000n + folgaEmMilesimos - 1n) / folgaEmMilesimos;
    if (entrada.desejadaWei <= 0n || entrada.conseguidaWei >= entrada.desejadaWei) {
        return { cortado: 0, saldoQuePrecisaria: precisaria, amordacado: false };
    }
    const cortado = 1 - Number(entrada.conseguidaWei) / Number(entrada.desejadaWei);
    // A comparacao com o limiar e feita em INTEIROS. Em ponto flutuante
    // `1 - 80/100` da 0,19999999999999996, que e menor que 0,2 — e um corte de
    // exatamente 20% nao alarmaria. Fronteira decidida por erro de arredondamento
    // e o tipo de coisa que passa em producao meses sem ninguem ver.
    const faltou = entrada.desejadaWei - entrada.conseguidaWei;
    const limiarEmMilesimos = BigInt(Math.round(limiar * 1_000_000));
    const amordacado = faltou * 1_000_000n >= limiarEmMilesimos * entrada.desejadaWei;
    return { cortado, saldoQuePrecisaria: precisaria, amordacado };
}

/**
 * O TIRO DE PROVA: um tiro, de proposito no prejuizo, para saber se funciona.
 *
 * A decisao e dela, e e boa: "mesmo que a gente gaste todo o gas pra pouco
 * lucro, mas ai saberemos que funciona". Codigo que nunca rodou nao e codigo
 * que funciona, e ate agora o caminho inteiro do tiro nunca saiu de verdade —
 * `nonce: 4` ha dias, nenhuma transacao enviada. O ensaio em seco prova tudo
 * MENOS as duas coisas que so a rede responde: a Aave aceita a liquidacao, e o
 * contrato consegue vender a garantia e mandar o lucro para o cofre.
 *
 * O que este modo faz: derruba a exigencia de lucro (de "2x o custo" para
 * "qualquer lucro acima de zero"), o que abre a faixa de baixo — de US$ 0,45
 * para centavos. E ai o alvo mais barato do mundo serve, e a prova custa o gas
 * de um tiro minimo, uns US$ 0,25, em vez dos US$ 4,71 de um tiro grande.
 *
 * O que este modo NAO faz, de proposito: nao desliga a protecao contra baleia
 * amordaçada. A prova que ela quer e de uma migalha; gastar o gas todo numa
 * baleia que provavelmente perde a corrida nao prova nada e acaba com o
 * dinheiro da prova.
 *
 * A TRAVA, que e a parte que importa: um tiro significa UM. O container do
 * Railway reinicia varias vezes por dia e uma trava em memoria voltaria armada
 * a cada reinicio — tres reinicios e o gas acaba. Entao a trava mora na
 * blockchain: o nonce da carteira. Ele so sobe quando uma transacao sai, nunca
 * volta, e e lido no boot de graca. `ateNonce` e o nonce de hoje; assim que o
 * tiro de prova sair, o nonce passa dele e o modo se desarma sozinho, para
 * sempre, em qualquer container.
 */
export function tiroDeProvaArmado(entrada: {
    ligado: boolean;
    nonceAtual: number;
    /** O nonce de HOJE. O tiro de prova vale enquanto o nonce nao passar disto. */
    ateNonce: number;
}): { armado: boolean; porque: string } {
    if (!entrada.ligado) return { armado: false, porque: 'CACA_TIRO_DE_PROVA não está ligado' };
    if (!Number.isInteger(entrada.nonceAtual) || entrada.nonceAtual < 0) {
        return { armado: false, porque: `nonce inválido (${entrada.nonceAtual}) — não arrisco sem saber` };
    }
    if (!Number.isInteger(entrada.ateNonce) || entrada.ateNonce < 0) {
        return { armado: false, porque: 'CACA_TIRO_DE_PROVA_ATE_NONCE não foi definido — sem trava eu não armo' };
    }
    if (entrada.nonceAtual > entrada.ateNonce) {
        return {
            armado: false,
            porque: `já saiu tiro: nonce ${entrada.nonceAtual} passou de ${entrada.ateNonce}. A prova foi feita`,
        };
    }
    return {
        armado: true,
        porque: `ARMADO: nonce ${entrada.nonceAtual} ainda não passou de ${entrada.ateNonce}. ` +
            'Este tiro é para PROVAR, não para lucrar',
    };
}

/**
 * A REGRA DO TIRO, num lugar so.
 *
 * Existe por uma mentira no log. O ensaio em seco imprimia "Se alguem cair, o
 * tiro sai" depois de conferir os freios com um lucro de exemplo de US$ 88 — e
 * ele conferia so tres deles, porque tinha sua PROPRIA copia da conta do lance.
 * Quando entrou o freio que protege a caca de migalhas, o ensaio nao soube:
 * passou a dizer que o tiro sai num premio de US$ 88 que o caminho de verdade
 * RECUSA.
 *
 * Duas copias da mesma regra e o defeito que esta sessao inteira perseguiu, em
 * seis lugares diferentes. Aqui ele estava no pior lugar possivel: no unico
 * teste que existe para dizer se o bot atira.
 *
 * Entao a regra passa a morar aqui, e os dois — o ensaio e o caminho quente —
 * chamam a mesma funcao. A ordem dos freios e a do caminho quente, de proposito,
 * inclusive onde ela e levemente conservadora: o piso de lucro e avaliado com a
 * gorjeta ANTES do corte do adiantado, entao o custo considerado e o maior.
 */
export interface DecisaoDoTiro {
    atira: boolean;
    porque: string;
    /** A gorjeta final, depois de todos os cortes. */
    prioridadeWei: bigint;
    maxFeeWei: bigint;
    /** O que a gorjeta queria ser antes do saldo cortar. */
    desejadaWei: bigint;
    amordaca: LanceAmordacado;
    /** Fracao do saldo que este premio justifica arriscar. */
    risco: number;
    fracaoDoLucro: number;
    custoUsd: Decimal | null;
    custoSePerderWei: bigint;
    aguentaDerrotas: number;
    /** True quando este tiro so passou porque o modo prova baixou a exigencia. */
    soPassouPorSerProva: boolean;
    adiantadoWei: bigint;
    adiantavelWei: bigint;
}

export function decidirTiro(e: {
    lucroUsd: Decimal | null;
    precoDoEthUsd: Decimal | null;
    saldoWei: bigint;
    baseFeeWei: bigint;
    limiteGas?: bigint;
    perdasSeguidas?: number;
    fracaoBaseDoLucro?: number;
    fracaoBaseDoSaldo?: number;
    fracaoMaximaDoSaldo?: number;
    margemMinima?: number;
    tetoDaMordida?: number;
    atirarAmordacado?: boolean;
    /**
     * Modo prova: aceita qualquer lucro acima de zero em vez de exigir 2x o
     * custo. NAO desliga a protecao contra baleia amordaçada.
     */
    tiroDeProva?: boolean;
}): DecisaoDoTiro {
    const limiteGas = e.limiteGas ?? LIMITE_DE_GAS;
    const fracaoDoLucro = fracaoAdaptativa({
        base: e.fracaoBaseDoLucro ?? FRACAO_DO_LUCRO,
        perdasSeguidas: e.perdasSeguidas ?? 0,
    });
    const desejadaWei = gorjetaPorGas({
        lucroUsd: e.lucroUsd ?? new Decimal(0),
        precoDoEthUsd: e.precoDoEthUsd ?? new Decimal(0),
        limiteGas: GAS_TIPICO_DE_UMA_CACADA,
        fracaoDoLucro,
    });
    const saldoUsd = e.precoDoEthUsd === null
        ? null
        : new Decimal(e.saldoWei.toString()).dividedBy(1e18).mul(e.precoDoEthUsd);
    // Sem cotacao o risco NAO vira zero: zero cairia em "sem gas para atirar" e
    // o bot recusaria culpando o gas, tendo gas.
    const fracaoBaseDoSaldo = e.fracaoBaseDoSaldo ?? 0.25;
    const risco = saldoUsd === null || e.lucroUsd === null
        ? fracaoBaseDoSaldo
        : fracaoDoSaldoQueValeArriscar({
            lucroUsd: e.lucroUsd,
            saldoUsd,
            fracaoBase: fracaoBaseDoSaldo,
            fracaoMaxima: e.fracaoMaximaDoSaldo ?? 0.6,
        });
    let prioridadeWei = gorjetaQueCabeNoSaldo({
        gorjetaDesejadaWei: desejadaWei,
        saldoWei: e.saldoWei,
        baseFeeWei: e.baseFeeWei,
        fracaoMaximaDoSaldo: risco,
    });

    const custoUsd = custoDoTiroUsd(prioridadeWei, e.baseFeeWei, e.precoDoEthUsd);
    // No modo prova a margem cai para zero: qualquer lucro acima de zero passa.
    // Nao e descuido, e o preco da informacao — e ela escolheu pagar.
    const veredicto = valeATentativa(e.lucroUsd, custoUsd, e.tiroDeProva ? 0 : (e.margemMinima ?? 2));

    let maxFeeWei = tetoPorGas(e.baseFeeWei, prioridadeWei);
    const adiantavelWei = maxFeeQueOSaldoAdianta(e.saldoWei, limiteGas);
    if (maxFeeWei > adiantavelWei) {
        maxFeeWei = adiantavelWei;
        if (prioridadeWei > maxFeeWei - e.baseFeeWei) {
            prioridadeWei = maxFeeWei > e.baseFeeWei ? maxFeeWei - e.baseFeeWei : 0n;
        }
    }
    const amordaca = lanceAmordacado({
        desejadaWei,
        conseguidaWei: prioridadeWei,
        limiteGas,
        baseFeeWei: e.baseFeeWei,
    });
    const custoSePerderWei = custoDeUmaDerrota(prioridadeWei, e.baseFeeWei);
    const aguentaDerrotas = derrotasQueAguenta(e.saldoWei, custoSePerderWei);
    const mata = mataACacaDeMigalhas({
        amordacado: amordaca.amordacado,
        custoDaDerrotaWei: custoSePerderWei,
        saldoWei: e.saldoWei,
        tetoDaMordida: e.tetoDaMordida,
        atirarAmordacado: e.atirarAmordacado,
    });

    // Se o tiro passa NA PROVA mas nao passaria na regra normal, a pessoa tem
    // de ver isso escrito: senao o primeiro acerto vira "ele funciona e da
    // lucro" quando foi "ele funciona e deu prejuizo de proposito".
    const passariaNormal = valeATentativa(e.lucroUsd, custoUsd, e.margemMinima ?? 2).vale;
    const comum = {
        prioridadeWei, maxFeeWei, desejadaWei, amordaca, risco, fracaoDoLucro,
        custoUsd, custoSePerderWei, aguentaDerrotas,
        soPassouPorSerProva: (e.tiroDeProva ?? false) && veredicto.vale && !passariaNormal,
        adiantadoWei: adiantadoExigido(limiteGas, maxFeeWei),
        adiantavelWei,
    };
    // A ordem e a do caminho quente. O primeiro freio que barra e o que explica.
    if (!veredicto.vale) return { ...comum, atira: false, porque: veredicto.porque };
    if (adiantavelWei <= e.baseFeeWei) {
        return { ...comum, atira: false, porque: 'o gás adiantado não cabe no saldo' };
    }
    if (prioridadeWei === 0n || aguentaDerrotas < 1) {
        return {
            ...comum,
            atira: false,
            porque: e.saldoWei === 0n
                ? 'sem gás nenhum'
                : `não aguento nem uma derrota (ela custa ${new Decimal(custoSePerderWei.toString()).dividedBy(1e18).toFixed(6)} ETH)`,
        };
    }
    if (mata.pula) return { ...comum, atira: false, porque: mata.porque };
    return { ...comum, atira: true, porque: veredicto.porque };
}

/**
 * A FAIXA de premio pela qual este saldo atira: de quanto ate quanto.
 *
 * Eu escrevi isto primeiro como "o maior premio que atira", com busca binaria a
 * partir de um centavo, e o proprio teste derrubou: devolveu `null` para um
 * saldo que atira bem. O erro era de raciocinio, nao de codigo — a decisao NAO
 * e monotona no premio. Ela e falsa, depois verdadeira, depois falsa outra vez:
 *
 *   - premio pequeno demais nao paga o proprio gas (piso de lucro)
 *   - no meio, atira
 *   - premio grande demais amordaça o lance e uma derrota mata a caca
 *
 * Ou seja e um INTERVALO, e chamar de "teto" escondia metade da verdade. Com o
 * saldo de 2026-09-27 a faixa e de uns US$ 0,46 a uns US$ 11,70 — e a ponta de
 * baixo importa tanto quanto a de cima, porque e ela que diz que as migalhas
 * miudas tambem nao servem.
 *
 * A varredura para achar o ancora e geometrica porque a faixa pode ser estreita
 * e estar em qualquer escala; as duas buscas binarias depois disso sao exatas
 * ate a precisao pedida.
 */
export interface FaixaDeTiro {
    /**
     * Abaixo disto o premio nao paga o proprio gas. `null` quando NAO HA piso —
     * o que acontece no modo prova, onde qualquer lucro acima de zero passa.
     *
     * Era um numero sempre, e no modo prova ele devolvia 0,0001: o chao da
     * propria busca, nao uma medicao. O log imprimiu "US$ 0.00 a US$ 45.68.
     * Abaixo nao paga o gas" — um piso inventado pelo algoritmo, com uma frase
     * que o contradiz. `null` diz a verdade: nao existe piso.
     */
    de: Decimal | null;
    /** Acima disto uma derrota comeria mais gas do que a caca aguenta. */
    ate: Decimal;
    /**
     * Ate onde o lance sai INTEIRO. Entre este e `ate` o bot atira amordaçado:
     * ainda vale, mas com desvantagem no leilao.
     *
     * Existe porque eu mesma confundi os dois e informei o numero errado: disse
     * que o bot parava de atirar em US$ 11,69 quando ele para de atirar em
     * US$ 66,80 e para de atirar COM FORCA em US$ 11,69. Sao perguntas
     * diferentes e a resposta de uma nao serve para a outra.
     */
    inteiroAte: Decimal | null;
}

export function faixaQueAtira(
    e: Omit<Parameters<typeof decidirTiro>[0], 'lucroUsd'>,
    tetoDaBusca = new Decimal(1_000_000),
    passos = 60,
): FaixaDeTiro | null {
    const atira = (usd: Decimal) => decidirTiro({ ...e, lucroUsd: usd }).atira;

    // 1) Achar QUALQUER premio que atire, subindo em escala geometrica.
    let ancora: Decimal | null = null;
    for (let x = new Decimal('0.01'); x.lessThanOrEqualTo(tetoDaBusca); x = x.mul('1.2')) {
        if (atira(x)) { ancora = x; break; }
    }
    if (ancora === null) return null;

    // 2) Ponta de baixo: o menor premio que ainda atira, ou `null` se nao ha.
    const PROBE = new Decimal('0.000001');
    let de: Decimal | null = null;
    if (!atira(PROBE)) {
        let fora = PROBE;
        let dentro = ancora;
        for (let i = 0; i < passos; i++) {
            const meio = fora.plus(dentro).dividedBy(2);
            if (atira(meio)) dentro = meio; else fora = meio;
        }
        de = dentro;
    }

    // 3) Ponta de cima: o maior premio que ainda atira.
    let ate = tetoDaBusca;
    if (!atira(tetoDaBusca)) {
        let dentro = ancora;
        let fora = tetoDaBusca;
        for (let i = 0; i < passos; i++) {
            const meio = dentro.plus(fora).dividedBy(2);
            if (atira(meio)) dentro = meio; else fora = meio;
        }
        ate = dentro;
    }

    // Ate onde o lance sai INTEIRO. Monotono no premio: a gorjeta desejada
    // cresce com o premio e o teto do saldo para de crescer, entao uma vez
    // amordaçado, amordaçado para sempre.
    const inteiro = (usd: Decimal) => {
        const d = decidirTiro({ ...e, lucroUsd: usd });
        return d.atira && !d.amordaca.amordacado;
    };
    const chao = de ?? PROBE;
    let inteiroAte: Decimal | null = null;
    if (inteiro(chao)) {
        if (inteiro(ate)) {
            inteiroAte = ate;
        } else {
            let dentro = chao;
            let fora = ate;
            for (let i = 0; i < passos; i++) {
                const meio = dentro.plus(fora).dividedBy(2);
                if (inteiro(meio)) dentro = meio; else fora = meio;
            }
            inteiroAte = dentro;
        }
    }
    return { de, ate, inteiroAte };
}

/**
 * Este tiro amordacado mataria a caca de migalhas?
 *
 * Existe porque a dona do bot decidiu — e repetiu — que a estrategia e ficar
 * nas migalhas, e o codigo nao sabia disso. Ele atirava em qualquer premio que
 * passasse o piso de lucro, inclusive nos que o saldo amordaca a 5% do lance
 * pretendido. E ai esta a assimetria que importa:
 *
 *   - Na faixa das migalhas (ate US$ 11,69 com o saldo de 2026-09-27) o lance
 *     sai INTEIRO. O bot compete de igual para igual.
 *   - Num premio grande o lance sai a 2,49 gwei quando queria 50. A chance de
 *     ganhar e pequena, e UMA derrota custa US$ 4,71 — metade do gas.
 *
 * Ou seja: perseguir o premio grande com a mao amarrada arrisca a estrategia
 * que FUNCIONA em troca de uma que provavelmente nao ganha. Depois de uma
 * derrota dessas nao ha mais gas para as migalhas.
 *
 * Isto NAO e prudencia generica — o bot continua atirando com lance inteiro em
 * tudo que couber, e continua aceitando derrotas na faixa onde elas cabem. E
 * uma regra especifica: nao troco a caca que funciona por uma loteria em que
 * estou lancando 5% do que deveria.
 *
 * `atirarAmordacado` solta a trava inteira, e e assim que se muda de plano
 * quando houver gas para o lance grande. A decisao fica no ambiente, nao
 * escondida numa constante.
 */
export function mataACacaDeMigalhas(entrada: {
    amordacado: boolean;
    custoDaDerrotaWei: bigint;
    saldoWei: bigint;
    /** Fracao do saldo que uma derrota pode comer. Acima disso, a caca morre. */
    tetoDaMordida?: number;
    atirarAmordacado?: boolean;
}): { pula: boolean; porque: string } {
    if (entrada.atirarAmordacado) {
        return { pula: false, porque: 'trava solta: CACA_ATIRAR_AMORDACADO está ligado' };
    }
    if (!entrada.amordacado) {
        return { pula: false, porque: 'lance inteiro — esta é a faixa onde o saldo compete' };
    }
    if (entrada.saldoWei <= 0n) {
        return { pula: true, porque: 'sem saldo nenhum' };
    }
    const teto = entrada.tetoDaMordida ?? 0.5;
    // Comparacao em inteiros: `mordida > teto` em ponto flutuante decide
    // fronteira por arredondamento, e este arquivo ja levou esse defeito uma vez.
    const tetoEmMilionesimos = BigInt(Math.round(teto * 1_000_000));
    const mordeDemais = entrada.custoDaDerrotaWei * 1_000_000n > tetoEmMilionesimos * entrada.saldoWei;
    if (!mordeDemais) {
        return { pula: false, porque: 'amordaçado, mas uma derrota aqui não mata a caça' };
    }
    const pct = (Number(entrada.custoDaDerrotaWei) / Number(entrada.saldoWei) * 100).toFixed(0);
    return {
        pula: true,
        porque: `lance amordaçado E uma derrota comeria ${pct}% do gás (teto ${(teto * 100).toFixed(0)}%). ` +
            'Perder isto acaba com a caça de migalhas, que é a estratégia escolhida',
    };
}

/**
 * O que ESTE tiro custa se der certo, em dolar.
 *
 * Diferente de `custoDeUmaDerrota`: aqui a cacada roda inteira, entao o gas
 * consumido e o da caçada, nao o da recusa.
 */
export function custoDoTiroUsd(
    prioridadeWei: bigint,
    baseFeeWei: bigint,
    precoDoEthUsd: Decimal | null,
    gasUsado: bigint = GAS_TIPICO_DE_UMA_CACADA,
): Decimal | null {
    // Sem preco do ETH nao da para dizer quanto custa, e ZERO nao e a
    // resposta: zero desarmava o piso inteiro, e o bot atirava num lucro de
    // cinco centavos escrevendo "ACERTOU" enquanto a carteira encolhia.
    if (precoDoEthUsd === null || precoDoEthUsd.lessThanOrEqualTo(0)) return null;
    const wei = (prioridadeWei + baseFeeWei) * gasUsado;
    return new Decimal(wei.toString()).dividedBy(1e18).mul(precoDoEthUsd);
}

/**
 * Se vale a pena atirar.
 *
 * O bot nao tinha piso nenhum: a unica condicao era `lucro > 0`. Num lucro de
 * US$1 ele atiraria, pagaria mais que isso de gas e gorjeta, e o log diria
 * "ACERTOU" enquanto a carteira encolhia. Acerto que perde dinheiro e pior que
 * derrota, porque ninguem vai atras.
 *
 * A margem existe porque o lucro medido e estimativa: o preco pode andar entre
 * a medicao e a execucao, e sair no zero a zero nao paga o risco.
 */
export function valeATentativa(
    lucroUsd: Decimal | null,
    custoUsd: Decimal | null,
    margem = 2,
): { vale: boolean; porque: string } {
    if (custoUsd === null) {
        return { vale: false, porque: 'sem cotação do ETH: não dá para saber quanto o tiro custa' };
    }
    if (lucroUsd === null) {
        // Sem cotacao nao da para comparar. Atirar as cegas num alvo que pode
        // ser de US$1 e gastar para descobrir.
        return { vale: false, porque: 'sem cotação do lucro: não dá para saber se paga o gás' };
    }
    const precisa = custoUsd.mul(margem);
    if (lucroUsd.lessThanOrEqualTo(precisa)) {
        return {
            vale: false,
            porque: `lucro de US$ ${lucroUsd.toFixed(2)} não cobre ${margem}x o custo do tiro (US$ ${custoUsd.toFixed(2)})`,
        };
    }
    return { vale: true, porque: `lucro de US$ ${lucroUsd.toFixed(2)} contra custo de US$ ${custoUsd.toFixed(2)}` };
}
