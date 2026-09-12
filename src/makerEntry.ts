// Arquivo: src/makerEntry.ts
//
// Entrada como MAKER: pagar a taxa de quem espera na fila em vez da taxa de
// quem atravessa o spread.
//
// POR QUE ISTO É A MAIOR ALAVANCA DESTE SISTEMA
//
// A medição de 15 minutos nas três famílias mostrou a perda por operação
// batendo com o custo de uma ida e volta (breakout 0,94x a taxa, momentum
// 1,05x). Quando o resultado empata com o pedágio, cortar o pedágio é
// literalmente a diferença entre expectativa negativa e positiva — e nenhum
// ajuste de parâmetro de entrada chega perto disso em tamanho.
//
// O CUSTO ESCONDIDO QUE ISTO PRECISA EVITAR: SELEÇÃO ADVERSA
//
// Ordem parada na fila não executa por acaso: ela executa quando alguém
// atravessa o spread para vender PARA ela. Isso acontece muito mais quando o
// preço está caindo. Ou seja, uma ordem de compra passiva preenche de
// preferência nas vezes em que o mercado vem contra — e deixa de preencher
// exatamente nas vezes em que o preço dispara, que são as operações que pagam
// a estratégia inteira.
//
// Economizar 0,03% de taxa e perder os melhores negócios é um péssimo negócio.
// Por isso o desenho aqui NÃO é "espera até preencher":
//
//   1. Preço no TOPO do book (a melhor oferta), não abaixo dele. Quanto mais
//      longe do preço corrente, maior a economia esperada e maior a seleção
//      adversa. No topo, a espera é curta e o viés é mínimo.
//   2. Prazo CURTO. Se não preencheu, o mercado andou — e continuar esperando
//      é apostar que ele volta.
//   3. Vencido o prazo, ATRAVESSA a mercado. Pagar a taxa cheia é melhor que
//      perder a operação: o movimento que a estratégia buscava vale múltiplos
//      da diferença entre as duas taxas.
//
// Nada disto vale para a SAÍDA. Stop atingido é sair agora, ao preço que
// houver — esperar na fila enquanto a posição afunda troca uma economia de
// centavos por uma perda sem teto. É a mesma assimetria já documentada no
// motor de arbitragem: entrada pode falhar limpo, saída não pode falhar.
import { Decimal } from 'decimal.js';

/** Estados de ordem da Binance que interessam ao fluxo de entrada. */
export type StatusDaOrdem = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

export type AcaoDeEntrada =
    | { acao: 'aguardar' }
    | { acao: 'assumir-preenchida' }
    | { acao: 'assumir-parcial' }
    | { acao: 'cancelar-e-atravessar'; motivo: string }
    | { acao: 'desistir'; motivo: string };

/**
 * O que fazer com a ordem passiva, dado o status e o tempo decorrido.
 *
 * Isolado como função pura porque é a decisão que pode estar errada — e um
 * erro aqui não estoura: produz posição fantasma (o motor acha que comprou e
 * não comprou) ou posição órfã (comprou e o motor não sabe). Os dois já
 * aconteceram neste projeto por outros caminhos, e os dois custam dinheiro
 * real sem gerar nenhum erro no log.
 */
export function decidirEntradaPassiva(params: {
    status: StatusDaOrdem;
    /** Quantidade já preenchida. */
    preenchido: Decimal;
    msDecorridos: number;
    msDeEspera: number;
    /** Atravessar a mercado quando o prazo vencer sem preencher. */
    atravessarNoVencimento: boolean;
}): AcaoDeEntrada {
    // FILLED e PARTIALLY_FILLED vêm ANTES do prazo de propósito: uma ordem que
    // preencheu preencheu, e o relógio não desfaz isso. Checar o prazo
    // primeiro faria o motor cancelar uma ordem já executada e seguir como se
    // não tivesse posição — que é exatamente a receita de posição órfã.
    if (params.status === 'FILLED') return { acao: 'assumir-preenchida' };

    if (params.status === 'REJECTED') {
        // LIMIT_MAKER é recusada quando executaria na hora. Não é erro: é o
        // book tendo andado a favor entre a decisão e o envio. Atravessar é a
        // resposta certa — a oportunidade continua lá.
        return {
            acao: 'cancelar-e-atravessar',
            motivo: 'a ordem passiva executaria imediatamente (o preço já andou a favor).',
        };
    }
    if (params.status === 'EXPIRED' || params.status === 'CANCELED') {
        if (params.preenchido.greaterThan(0)) return { acao: 'assumir-parcial' };
        return params.atravessarNoVencimento
            ? { acao: 'cancelar-e-atravessar', motivo: 'a ordem passiva saiu do book sem preencher.' }
            : { acao: 'desistir', motivo: 'a ordem passiva saiu do book sem preencher.' };
    }

    const venceu = params.msDecorridos >= params.msDeEspera;
    if (!venceu) return { acao: 'aguardar' };

    // Vencido com preenchimento parcial: fica com o que veio. Cancelar o resto
    // e recomeçar pagaria taxa duas vezes pela mesma operação.
    if (params.preenchido.greaterThan(0)) return { acao: 'assumir-parcial' };

    return params.atravessarNoVencimento
        ? {
              acao: 'cancelar-e-atravessar',
              motivo: `não preencheu em ${params.msDecorridos}ms; atravessar custa taxa cheia e perder a operação custa mais.`,
          }
        : { acao: 'desistir', motivo: `não preencheu em ${params.msDecorridos}ms.` };
}

/**
 * O preço da ordem passiva de COMPRA.
 *
 * A melhor oferta de compra (`melhorCompra`) é onde a ordem entra na fila sem
 * atravessar o spread. Subir um tique acima dela ganharia prioridade, mas
 * arrisca cruzar com a melhor venda e a corretora recusaria a LIMIT_MAKER —
 * por isso o teto: nunca encostar em `melhorVenda`.
 *
 * `recuoEmTiques` permite entrar mais fundo na fila. Cada tique de recuo
 * aumenta a economia e a SELEÇÃO ADVERSA junto: mais longe do preço, a ordem
 * só preenche quando o mercado vem com força contra. O padrão é zero por isso.
 */
export function precoDaCompraPassiva(params: {
    melhorCompra: Decimal;
    melhorVenda: Decimal;
    tickSize: Decimal;
    recuoEmTiques?: number;
}): Decimal | null {
    const { melhorCompra, melhorVenda, tickSize } = params;
    if (melhorCompra.lessThanOrEqualTo(0) || melhorVenda.lessThanOrEqualTo(0)) return null;
    if (melhorVenda.lessThanOrEqualTo(melhorCompra)) return null; // book cruzado ou vazio: não dá para ser passivo
    if (tickSize.lessThanOrEqualTo(0)) return null;

    const recuo = Math.max(0, Math.trunc(params.recuoEmTiques ?? 0));
    const preco = melhorCompra.minus(tickSize.mul(recuo));
    if (preco.lessThanOrEqualTo(0)) return null;
    // Alinha ao tique: preço fora da grade é recusado pela corretora.
    const alinhado = preco.dividedToIntegerBy(tickSize).mul(tickSize);
    return alinhado.greaterThan(0) && alinhado.lessThan(melhorVenda) ? alinhado : null;
}

/**
 * Quanto a taxa cai ao entrar como maker, em fração do capital por operação.
 *
 * Serve para o log dizer o tamanho do prêmio em vez de só afirmar que existe.
 * Só a ENTRADA vira maker: a saída continua atravessando, porque stop atingido
 * é sair agora.
 */
export function economiaPorOperacao(params: {
    taxaTaker: Decimal;
    taxaMaker: Decimal;
    alavancagem: Decimal;
}): Decimal {
    const diferenca = params.taxaTaker.minus(params.taxaMaker);
    if (diferenca.lessThanOrEqualTo(0)) return new Decimal(0);
    return diferenca.mul(params.alavancagem);
}
