// Arquivo: src/taxaPorPar.ts
//
// Taxa POR PAR, e não uma taxa só para o motor inteiro.
//
// POR QUE ISTO EXISTE, E POR QUE MUDA O VEREDICTO DE UM PROJETO INTEIRO
//
// A arbitragem triangular foi medida aqui e declarada morta: 232 mil
// avaliações, melhor desalinhamento de 0,124% contra um custo de 0,225%. Esse
// custo saía de uma conta simples — três pernas, mesma taxa, (1−f)³.
//
// A conta estava certa para um mundo em que todas as pernas custam igual. Elas
// não custam. Na Binance, os pares FDUSD entraram numa promoção de liquidez
// com taxa ZERO, e um ciclo como
//
//     USDT → BTC → FDUSD → USDT
//
// paga taxa em UMA perna só. O custo desce de 0,225% para 0,075% — e a mesma
// oportunidade de 0,124% que era descartada por um fator de 1,8 passa a caber
// com folga de 1,65x.
//
// Um número global não consegue expressar isso. Com ele, o motor calcula
// 0,225% para todo triângulo e descarta o ciclo viável junto com os inviáveis,
// sem nunca reclamar — a rejeição é indistinguível da rejeição correta.
//
// A REGRA DE OURO AQUI É O PADRÃO PESSIMISTA: par desconhecido paga a taxa
// cheia. Errar para o lado da taxa alta custa uma oportunidade não aproveitada;
// errar para o lado da taxa zero manda dinheiro real perseguir um lucro que
// não existe, e o erro só aparece no extrato.
import { Decimal } from 'decimal.js';

export interface TabelaDeTaxas {
    /** Taxa cobrada quando o par não está na lista de isentos. */
    padrao: Decimal;
    /** Pares com taxa zero, em MAIÚSCULAS e sem separador (ex.: BTCFDUSD). */
    isentos: Set<string>;
}

/**
 * Monta a tabela a partir de uma lista de pares isentos.
 *
 * A normalização (maiúsculas, sem espaços) é feita aqui e não no chamador
 * porque um par escrito "btcfdusd" numa variável de ambiente passaria batido
 * como não-isento, e o motor descartaria silenciosamente o ciclo que a
 * variável existia para habilitar.
 */
export function montarTabelaDeTaxas(params: { padrao: Decimal; isentos: string[] }): TabelaDeTaxas {
    return {
        padrao: params.padrao,
        isentos: new Set(
            params.isentos
                .map((p) => p.trim().toUpperCase())
                .filter((p) => p.length > 0),
        ),
    };
}

/** A taxa de UM par. Desconhecido paga a cheia — nunca o contrário. */
export function taxaDoPar(symbol: string, tabela: TabelaDeTaxas): Decimal {
    return tabela.isentos.has(symbol.trim().toUpperCase()) ? new Decimal(0) : tabela.padrao;
}

/**
 * Quanto SOBRA de 1 unidade depois de pagar as taxas das três pernas.
 *
 * Multiplicativo, não somado: cada perna incide sobre o que sobrou da
 * anterior. Com taxas pequenas a diferença é ínfima, mas somar seria errado
 * por construção — e a margem inteira deste ciclo cabe dentro de "ínfimo".
 */
export function retencaoDoTriangulo(pernas: [string, string, string], tabela: TabelaDeTaxas): Decimal {
    return pernas.reduce(
        (acc, perna) => acc.mul(new Decimal(1).minus(taxaDoPar(perna, tabela))),
        new Decimal(1),
    );
}

/** O custo do ciclo como fração (0.00075 = 0,075%). É 1 menos a retenção. */
export function custoDoTriangulo(pernas: [string, string, string], tabela: TabelaDeTaxas): Decimal {
    return new Decimal(1).minus(retencaoDoTriangulo(pernas, tabela));
}

/**
 * O multiplicador bruto mínimo para o ciclo dar o lucro alvo.
 *
 *     bruto_necessário = (1 + alvo) / retenção
 *
 * Com retenção 1 (todas as pernas isentas) o necessário é só o alvo — o custo
 * some da conta inteiramente.
 */
export function brutoNecessario(params: {
    pernas: [string, string, string];
    tabela: TabelaDeTaxas;
    lucroAlvo: Decimal;
}): Decimal {
    const retencao = retencaoDoTriangulo(params.pernas, params.tabela);
    if (retencao.lessThanOrEqualTo(0)) {
        throw new Error(`Retenção inválida para ${params.pernas.join('/')}: taxas somam 100% ou mais.`);
    }
    return new Decimal(1).plus(params.lucroAlvo).dividedBy(retencao);
}

/**
 * Quantas pernas do ciclo são isentas — só para o log dizer POR QUE um
 * triângulo ficou barato, em vez de o número aparecer sem explicação.
 */
export function pernasIsentas(pernas: [string, string, string], tabela: TabelaDeTaxas): string[] {
    return pernas.filter((p) => tabela.isentos.has(p.trim().toUpperCase()));
}
