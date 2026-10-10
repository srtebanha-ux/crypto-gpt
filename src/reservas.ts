// Arquivo: src/reservas.ts
//
// Qual moeda o devedor deve, e qual ele deu em garantia.
//
// O vigia sabe dizer "este deve US$1,8 milhão". O contrato não consegue fazer
// nada com isso: `liquidationCall` exige os dois ENDEREÇOS exatos — o token da
// dívida que será paga e o token da garantia que será levada. Sem eles, não há
// caçada.
//
// COMO SE DESCOBRE, E POR QUE NÃO ESTÁ ESCRITO AQUI:
// A Aave guarda, para cada moeda do pool, os endereços de dois tokens espelho:
// um que representa o depósito (aToken) e outro que representa a dívida. O
// saldo do devedor NESSES espelhos é o que diz o que ele tem e o que ele deve.
//
// Os espelhos vêm de `getReserveData`, numa resposta com uma dúzia de campos.
// Eu SEI em qual posição eles costumam ficar — e é exatamente por isso que não
// vou escrever a posição. A mesma certeza me fez escrever a tabela de moedas
// de memória hoje, e a rodada da Ethereum morreu por causa disso.
//
// Em vez de afirmar, o programa PERGUNTA: pega os campos que parecem endereço,
// chama `UNDERLYING_ASSET_ADDRESS()` em cada um, e fica com os que responderem
// apontando de volta para a moeda certa. Um espelho da Aave responde; qualquer
// outro campo não responde ou responde outra coisa. A posição deixa de ser
// suposição e vira achado.
import { Decimal } from 'decimal.js';

/** `getReserveData(address)` no Pool. Conferido com keccak. */
export const SELETOR_GET_RESERVE_DATA = '0x35ea6a75';
/** `UNDERLYING_ASSET_ADDRESS()` — a pergunta que identifica um espelho. */
export const SELETOR_UNDERLYING = '0xb16a19de';
/** `balanceOf(address)` nos espelhos. */
export const SELETOR_BALANCE_OF = '0x70a08231';

/**
 * Os campos de `getReserveData` que TÊM CARA de endereço.
 *
 * Um campo de 32 bytes é endereço quando os 12 primeiros bytes são zero e os
 * 20 seguintes não são todos zero. Não é prova — um número pequeno passa no
 * teste — e não precisa ser: quem confirma é a pergunta seguinte.
 */
export function camposQueParecemEndereco(dataHex: string): Array<{ posicao: number; endereco: string }> {
    const limpo = dataHex.replace(/^0x/, '');
    const fora: Array<{ posicao: number; endereco: string }> = [];
    for (let i = 0; i * 64 < limpo.length; i += 1) {
        const p = limpo.slice(i * 64, (i + 1) * 64);
        if (p.length < 64) break;
        if (p.slice(0, 24) !== '0'.repeat(24)) continue;
        const end = p.slice(24);
        if (end === '0'.repeat(40)) continue;
        fora.push({ posicao: i, endereco: `0x${end}` });
    }
    return fora;
}

/** Um endereço ABI-codificado, para comparar com o que o espelho respondeu. */
export function enderecoDaResposta(dataHex: string): string | null {
    const limpo = dataHex.replace(/^0x/, '');
    if (limpo.length < 64) return null;
    const p = limpo.slice(0, 64);
    if (p.slice(0, 24) !== '0'.repeat(24)) return null;
    return `0x${p.slice(24)}`.toLowerCase();
}

export interface EspelhosDaMoeda {
    /** A moeda de verdade. */
    ativo: string;
    /** Espelho do depósito — o saldo aqui é GARANTIA. */
    deposito: string;
    /** Espelho da dívida — o saldo aqui é DÍVIDA. */
    divida: string;
}

/**
 * Separa qual espelho é o do depósito e qual é o da dívida.
 *
 * Os dois respondem a mesma coisa quando perguntados de quem são, então a
 * pergunta não distingue. O que distingue é a ORDEM: a Aave lista o espelho do
 * depósito antes dos de dívida, em todas as versões. Fico com o primeiro e o
 * último dos confirmados.
 *
 * E isso é uma suposição — a única que sobra depois da descoberta, e por isso
 * está escrita aqui em vez de embutida. `conferirEspelhos` existe para
 * derrubá-la: se os saldos não baterem com o que a Aave diz do usuário, a
 * suposição estava errada e o programa avisa em vez de operar às cegas.
 */
export function separarEspelhos(
    ativo: string,
    confirmados: Array<{ posicao: number; endereco: string }>,
): EspelhosDaMoeda | null {
    if (confirmados.length < 2) return null;
    const ordenados = [...confirmados].sort((a, b) => a.posicao - b.posicao);
    return {
        ativo,
        deposito: ordenados[0].endereco.toLowerCase(),
        divida: ordenados[ordenados.length - 1].endereco.toLowerCase(),
    };
}

export interface SaldoNaMoeda {
    ativo: string;
    garantiaCrua: Decimal;
    dividaCrua: Decimal;
}

/**
 * O par a liquidar: a maior dívida e a maior garantia, em VALOR.
 *
 * Comparar unidades cruas seria errado e o erro passaria despercebido: mil
 * unidades de USDC são mil dólares, e mil unidades de WETH são poeira — os
 * decimais são diferentes. Comparar sem converter escolheria quase sempre o
 * token de mais casas decimais, e o par escolhido pareceria plausível.
 */
export function escolherParPorValor(
    saldos: SaldoNaMoeda[],
    valorDe: (ativo: string, cru: Decimal) => Decimal | null,
): { garantia: string; divida: string; garantiaUsd: Decimal; dividaUsd: Decimal } | null {
    let g: { ativo: string; usd: Decimal } | null = null;
    let d: { ativo: string; usd: Decimal } | null = null;

    for (const s of saldos) {
        if (s.garantiaCrua.greaterThan(0)) {
            const usd = valorDe(s.ativo, s.garantiaCrua);
            if (usd !== null && (g === null || usd.greaterThan(g.usd))) g = { ativo: s.ativo, usd };
        }
        if (s.dividaCrua.greaterThan(0)) {
            const usd = valorDe(s.ativo, s.dividaCrua);
            if (usd !== null && (d === null || usd.greaterThan(d.usd))) d = { ativo: s.ativo, usd };
        }
    }

    if (g === null || d === null) return null;
    return { garantia: g.ativo, divida: d.ativo, garantiaUsd: g.usd, dividaUsd: d.usd };
}

/**
 * A descoberta bate com o que a Aave diz do usuário?
 *
 * `getUserAccountData` já informa a dívida total em dólares. Se a soma das
 * dívidas que eu encontrei nos espelhos não chega perto desse total, alguma
 * coisa na descoberta está errada — espelho trocado, posição mal separada,
 * moeda sem cotação. Sem esta conferência, um par errado sairia como um par
 * plausível e só falharia na hora de valer.
 */
export function conferirEspelhos(params: {
    dividaEncontradaUsd: Decimal;
    dividaSegundoAave: Decimal;
    tolerancia?: number;
}): { confere: boolean; leitura: string } {
    const tol = params.tolerancia ?? 0.25;
    if (params.dividaSegundoAave.lessThanOrEqualTo(0)) {
        return { confere: false, leitura: 'a Aave diz que este usuário não deve nada' };
    }
    const razao = params.dividaEncontradaUsd.dividedBy(params.dividaSegundoAave);
    const confere = razao.greaterThanOrEqualTo(1 - tol) && razao.lessThanOrEqualTo(1 + tol);
    return {
        confere,
        leitura: confere
            ? `confere: achei ${razao.mul(100).toFixed(0)}% da dívida que a Aave informa`
            : `NÃO CONFERE: achei ${razao.mul(100).toFixed(0)}% da dívida que a Aave informa — ` +
              'espelho trocado, ou moeda que eu não sei cotar. Não dá para liquidar às cegas.',
    };
}
