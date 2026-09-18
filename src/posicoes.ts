// Arquivo: src/posicoes.ts
//
// O vigia de posições — a ambulância estacionada na esquina.
//
// A pergunta dela foi: "talvez a gente não precise ser o mais rápido, e sim o
// melhor programado?". Este arquivo é a resposta virando código.
//
// Reagir a uma liquidação é chegar depois de todo mundo que também reagiu. Mas
// posição não vira liquidável por surpresa: ela chega perto, fica perto, e um
// dia o preço cruza a linha. Quem tem a lista de quem está perto não reage —
// já estava lá.
//
// E a conta é muito mais simples do que eu esperava. A Aave publica o "fator
// de saúde" de cada devedor:
//
//     saúde = (garantia × limiar) / dívida
//
// Se a garantia cair x%, a saúde cai x% junto. Então a queda que falta para
// liquidar sai só da saúde, sem precisar saber preço de moeda nenhuma:
//
//     queda = 1 − 1/saúde
//
// Saúde 1,05 quer dizer que a garantia pode cair 4,76% e acabou. Uma chamada
// por devedor e a lista inteira se ordena sozinha.
import { Decimal } from 'decimal.js';

/** `getUserAccountData(address)` no Pool da Aave. Conferido com keccak. */
export const SELETOR_CONTA_DO_USUARIO = '0xbf92857c';

/** `Borrow(...)` — é daqui que sai a lista de quem deve. */
export const TOPIC_BORROW = '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0';

/** A Aave devolve a saúde com 18 casas. 1e18 é exatamente o limite. */
export const SAUDE_UM = new Decimal('1e18');

export interface ContaDoUsuario {
    /** Em "moeda base" da Aave — dólares com 8 casas. */
    garantiaBase: Decimal;
    dividaBase: Decimal;
    limiarLiquidacao: Decimal;
    /** Com 18 casas. Abaixo de 1e18 já dá para liquidar. */
    saude: Decimal;
}

function palavra(hex: string, i: number): Decimal {
    const p = hex.slice(i * 64, (i + 1) * 64);
    if (p.length < 64) throw new Error(`resposta curta demais na palavra ${i}`);
    return new Decimal(BigInt(`0x${p}`).toString());
}

export function decodificarContaDoUsuario(dataHex: string): ContaDoUsuario {
    const limpo = dataHex.replace(/^0x/, '');
    if (limpo.length < 64 * 6) throw new Error('getUserAccountData devolveu menos de 6 palavras');
    return {
        garantiaBase: palavra(limpo, 0),
        dividaBase: palavra(limpo, 1),
        limiarLiquidacao: palavra(limpo, 3),
        saude: palavra(limpo, 5),
    };
}

/**
 * Quanto a garantia ainda pode cair antes de liquidar, em porcentagem.
 *
 * Devolve 0 para quem já está liquidável e null para quem não tem dívida — a
 * Aave devolve saúde "infinita" (2^256−1) nesse caso, e tratar esse número
 * como saúde altíssima encheria a lista de gente que não deve nada.
 */
export function quedaAteLiquidar(saude: Decimal): Decimal | null {
    if (saude.lessThanOrEqualTo(0)) return null;
    // Sem dívida a Aave manda o maior uint256 possível. Qualquer coisa acima de
    // mil já é "não deve praticamente nada" e não interessa para o vigia.
    const emVezes = saude.dividedBy(SAUDE_UM);
    if (emVezes.greaterThan(1000)) return null;
    if (emVezes.lessThanOrEqualTo(1)) return new Decimal(0);
    return new Decimal(1).minus(new Decimal(1).dividedBy(emVezes)).mul(100);
}

/** As faixas de vigilância, da mais urgente para a mais folgada. */
export const FAIXAS_DE_RISCO = [
    { ate: 0, nome: 'JÁ LIQUIDÁVEL' },
    { ate: 1, nome: 'a menos de 1%' },
    { ate: 3, nome: 'a menos de 3%' },
    { ate: 5, nome: 'a menos de 5%' },
    { ate: 10, nome: 'a menos de 10%' },
    { ate: 25, nome: 'a menos de 25%' },
];

export function classificarRisco(quedaPct: Decimal | null): string | null {
    if (quedaPct === null) return null;
    const f = FAIXAS_DE_RISCO.find((x) => quedaPct.lessThanOrEqualTo(x.ate));
    return f ? f.nome : 'folgada';
}

export interface Posicao {
    devedor: string;
    conta: ContaDoUsuario;
    quedaPct: Decimal | null;
}

export interface ResumoDePosicoes {
    vigiados: number;
    semDivida: number;
    porFaixa: Record<string, number>;
    /** Dívida somada de quem está a menos de 5% de liquidar, em dólares. */
    dividaSobAmeaca: Decimal;
    /** Os mais perto da borda, do mais urgente para o menos. */
    naBorda: Array<{ devedor: string; quedaPct: Decimal; dividaUsd: Decimal }>;
    leitura: string;
}

/**
 * O relatório que diz se dá para prever em vez de reagir.
 *
 * `dividaSobAmeaca` é a linha que importa: é quanto dinheiro está a menos de
 * 5% de virar prêmio. Se esse número for grande e a lista curta, o vigia
 * consegue acompanhar cada um deles de perto — que é a diferença entre
 * esperar na esquina e correr atrás da ambulância.
 */
export function resumirPosicoes(posicoes: Posicao[], limiarAmeaca = 5): ResumoDePosicoes {
    const porFaixa: Record<string, number> = {};
    for (const f of FAIXAS_DE_RISCO) porFaixa[f.nome] = 0;
    porFaixa['folgada'] = 0;

    let semDivida = 0;
    let dividaSobAmeaca = new Decimal(0);
    const naBorda: Array<{ devedor: string; quedaPct: Decimal; dividaUsd: Decimal }> = [];

    for (const p of posicoes) {
        if (p.quedaPct === null) {
            semDivida += 1;
            continue;
        }
        const faixa = classificarRisco(p.quedaPct);
        if (faixa) porFaixa[faixa] += 1;
        // A moeda base da Aave tem 8 casas.
        const dividaUsd = p.conta.dividaBase.dividedBy(1e8);
        if (p.quedaPct.lessThanOrEqualTo(limiarAmeaca)) {
            dividaSobAmeaca = dividaSobAmeaca.plus(dividaUsd);
            naBorda.push({ devedor: p.devedor, quedaPct: p.quedaPct, dividaUsd });
        }
    }

    naBorda.sort((a, b) => a.quedaPct.comparedTo(b.quedaPct));
    const vigiados = posicoes.length - semDivida;

    let leitura: string;
    if (vigiados === 0) {
        leitura = 'sem dado suficiente: nenhum devedor com dívida aberta na amostra.';
    } else if (naBorda.length === 0) {
        leitura = `Ninguém a menos de ${limiarAmeaca}% de liquidar agora. Dia calmo — o vigia fica de plantão, que é o trabalho dele na maior parte do tempo.`;
    } else {
        leitura =
            `${naBorda.length} de ${vigiados} devedores estão a menos de ${limiarAmeaca}% de liquidar, ` +
            `somando $${dividaSobAmeaca.toFixed(0)} de dívida. Essa lista é curta o bastante para vigiar uma por uma — ` +
            `e é exatamente isso que separa prever de reagir.`;
    }

    return { vigiados, semDivida, porFaixa, dividaSobAmeaca, naBorda: naBorda.slice(0, 15), leitura };
}

/** Os devedores distintos que aparecem em eventos de empréstimo. */
export function devedoresDosEventos(logs: Array<{ topics: string[] }>): string[] {
    const vistos = new Set<string>();
    for (const l of logs) {
        // Borrow(reserve indexed, user, onBehalfOf indexed, ...) — quem deve é
        // o `onBehalfOf`, no terceiro tópico. Pegar `user` daria o operador de
        // quem pediu por conta de outro, que não é o dono da dívida.
        if (l.topics.length < 3) continue;
        const t = l.topics[2];
        if (typeof t !== 'string' || t.length < 42) continue;
        vistos.add(`0x${t.slice(-40)}`.toLowerCase());
    }
    return [...vistos];
}
