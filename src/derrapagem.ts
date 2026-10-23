// Derrapagem: a distância entre o preço que o sinal viu e o preço que a
// corretora entregou.
//
// É o número que um teste pago existe para comprar. Com vantagem medida na
// casa de meio ponto percentual, meio ponto de derrapagem é a diferença entre
// uma estratégia e um jeito caro de doar dinheiro.
//
// Duas coisas diferentes moram aqui juntas, e vale saber disso ao ler a média:
//
//   1. derrapagem de execução — a ordem a mercado varre o livro e preenche
//      pior que o topo. Sempre contra, nunca a favor.
//   2. defasagem do sinal — a coleta é por REST a cada 10 segundos, então o
//      preço que o sinal viu pode ter 10 segundos de idade. Essa parte é
//      sorteada: às vezes a favor, às vezes contra.
//
// Numa amostra pequena a segunda domina e o sinal do resultado não quer dizer
// nada. O que interessa não é a média de três entradas: é a média de muitas, e
// principalmente o espalhamento delas.
import { Decimal } from 'decimal.js';

export type Direcao = 'alta' | 'baixa';

/**
 * Quanto a entrada real ficou PIOR que o preço do sinal, em pontos percentuais.
 *
 * Positivo = contra nós. Comprar mais caro e vender mais barato são o mesmo
 * prejuízo, por isso o sinal inverte conforme o lado.
 *
 * Devolve null quando falta preço — e SÓ quando falta preço. O guarda anterior
 * exigia também que a ordem trouxesse preço médio preenchido, um dado que a
 * conta nem usa e que a Binance devolve como 0 na resposta de uma ordem a
 * mercado. O efeito foi que a derrapagem nunca era calculada, em nenhuma
 * entrada, e o log dizia "—" com os dois números necessários impressos ao lado.
 */
export function derrapagemDaEntrada(params: {
    precoDoSinal: Decimal;
    entrada: Decimal;
    direcao: Direcao;
}): Decimal | null {
    if (params.precoDoSinal.lessThanOrEqualTo(0)) return null;
    if (params.entrada.lessThanOrEqualTo(0)) return null;
    const bruta = params.entrada.minus(params.precoDoSinal).dividedBy(params.precoDoSinal);
    const contra = params.direcao === 'alta' ? bruta : bruta.negated();
    return contra.mul(100);
}
