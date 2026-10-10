// Arquivo: src/liquidar.ts
//
// Falar com a Aave na língua dela — e conferir que ela entendeu.
//
// Até aqui tudo que este projeto fez com a Aave foi LER. Ler é fácil: se eu
// decodificar errado, o número sai esquisito e alguém percebe. Mandar é outra
// coisa — uma chamada mal montada não devolve "você errou", devolve uma
// reversão genérica que se parece com "a oportunidade não existia".
//
// Então antes de escrever contrato nenhum, vale uma pergunta que custa zero:
// SE eu montasse a liquidação agora, a Aave entenderia o que eu pedi?
//
// Dá para perguntar sem enviar nada. `eth_call` executa a transação no
// servidor, devolve o resultado e não grava coisa nenhuma — nem gás se paga.
// E a resposta é específica:
//
//   reverte com '45'  -> ela ENTENDEU, e disse que a posição está saudável.
//                        É a resposta certa para uma posição que não caiu.
//   reverte com outra -> ela entendeu e recusou por outro motivo, que o
//                        dicionário abaixo traduz.
//   erro de formato   -> eu montei errado, e é ISSO que eu quero descobrir
//                        antes de haver dinheiro envolvido.
//
// Passar por esse teste não garante lucro. Garante que, no dia em que uma
// posição abrir, o pedido vai estar escrito na língua certa — e não vai
// falhar por um motivo bobo que dava para ter descoberto hoje, de graça.
import { AbiCoder, id } from 'ethers';
import { classificarRecusa } from './cobertura';

/** `liquidationCall(address,address,address,uint256,bool)` — conferido com keccak. */
export const SELETOR_LIQUIDATION_CALL = '0x00a718a9';

/** O Protocol Data Provider da Aave, para saber o que cada devedor deve e deu em garantia. */
export const SELETOR_USER_RESERVE_DATA = '0x28dd2d01';

const coder = AbiCoder.defaultAbiCoder();

export interface PedidoDeLiquidacao {
    /** O token que se LEVA como prêmio. */
    garantia: string;
    /** O token da dívida que se PAGA. */
    divida: string;
    /** Quem quebrou. */
    devedor: string;
    /** Quanto da dívida cobrir, em unidades cruas do token. */
    quantoCobrir: bigint;
    /**
     * Receber o token direto (false) ou o comprovante da Aave (true).
     *
     * Sempre false para nós. `true` devolve aToken, que é um recibo que rende
     * juros e precisa de um resgate depois — mais um passo, mais um gás, e
     * mais uma coisa para dar errado dentro de uma transação que já é apertada.
     */
    receberAToken: boolean;
}

export function codificarLiquidacao(p: PedidoDeLiquidacao): string {
    return (
        SELETOR_LIQUIDATION_CALL +
        coder
            .encode(
                ['address', 'address', 'address', 'uint256', 'bool'],
                [p.garantia, p.divida, p.devedor, p.quantoCobrir, p.receberAToken],
            )
            .slice(2)
    );
}

/**
 * Cobrir a dívida INTEIRA, sem precisar saber quanto é.
 *
 * A Aave aceita o maior uint256 como "o quanto der", e ela mesma corta no
 * limite permitido. Isso evita uma corrida contra o próprio relógio: entre eu
 * ler o saldo devedor e a transação executar, os juros já mudaram o número, e
 * pedir um valor exato que ficou velho é uma forma de falhar sem motivo.
 */
export const COBRIR_O_MAXIMO = (1n << 256n) - 1n;

/**
 * Os códigos de erro da Aave V3 — ela reverte com um NÚMERO em texto.
 *
 * Sem este dicionário, o log diria `execution reverted: 45` e isso não é
 * mensagem, é enigma. Com ele, o programa diz o que a Aave quis dizer.
 *
 * Só os que importam para liquidação. O resto aparece com o número cru, e isso
 * é melhor que uma tradução inventada.
 */
export const ERROS_DA_AAVE: Record<string, string> = {
    '45': 'A posição está SAUDÁVEL — não dá para liquidar. (É a resposta esperada para quem ainda não caiu.)',
    '46': 'A garantia deste usuário não está habilitada como garantia.',
    '47': 'Este usuário não tem dívida neste token.',
    '43': 'Este ativo não está habilitado como garantia.',
    '26': 'Valor a cobrir é zero.',
    '48': 'Não dá para cobrir essa fatia da dívida neste estado.',
    '92': 'A liquidação deixaria uma sobra pequena demais de dívida.',
};

/**
 * Os erros da Aave NOVA — que não fala por números, fala por assinatura.
 *
 * O primeiro ensaio contra a Base reprovou, e reprovou por um motivo que eu
 * não tinha previsto: a resposta não veio como `execution reverted: 45`, veio
 * como `execution reverted | 0x930bb771`. As versões recentes da Aave
 * trocaram os códigos em texto por erros personalizados, que viajam como os
 * quatro primeiros bytes do keccak do nome.
 *
 * `0x930bb771` é `HealthFactorNotBelowThreshold()` — exatamente o mesmo
 * significado do antigo 45. Ou seja: a Aave tinha entendido o pedido desde o
 * começo e recusado pelo motivo certo. Quem não entendeu a resposta fui eu.
 *
 * Os dois dicionários ficam, porque redes diferentes rodam versões diferentes
 * e a mesma recusa chega das duas formas conforme o lugar.
 *
 * As assinaturas são CALCULADAS a partir dos nomes, não copiadas à mão. Um
 * seletor digitado errado não falha: ele simplesmente nunca casa, e o erro
 * vira "desconhecido" para sempre — silencioso, do jeito que este projeto
 * vem aprendendo a não deixar passar.
 */
export const NOMES_DE_ERRO_DA_AAVE: Array<[string, string]> = [
    ['HealthFactorNotBelowThreshold()', 'A posição está SAUDÁVEL — não dá para liquidar. (É a resposta esperada para quem ainda não caiu.)'],
    ['CollateralCannotBeLiquidated()', 'Essa garantia não pode ser liquidada — o dono não a marcou como garantia, ou ela está desabilitada.'],
    ['SpecifiedCurrencyNotBorrowedByUser()', 'Este usuário não deve nada NESTE token — o par de dívida está errado.'],
    ['ReserveInactive()', 'Esta reserva está desativada no pool.'],
    ['ReservePaused()', 'Esta reserva está pausada.'],
    ['InvalidAmount()', 'Valor inválido para cobrir.'],
    ['MustNotLeaveDust()', 'A liquidação deixaria uma sobra pequena demais de dívida.'],
    ['PriceOracleSentinelCheckFailed()', 'O oráculo está em modo de proteção; liquidações estão barradas agora.'],
    ['LiquidationGracePeriodNotOver()', 'A reserva está em período de carência: liquidação ainda não liberada.'],
    ['CollateralBalanceIsZero()', 'O usuário não tem saldo desta garantia.'],
];

/** assinatura -> explicação, calculada a partir dos nomes acima. */
export const ERROS_PERSONALIZADOS: Record<string, { nome: string; texto: string }> = Object.fromEntries(
    NOMES_DE_ERRO_DA_AAVE.map(([nome, texto]) => [id(nome).slice(0, 10), { nome, texto }]),
);

export interface LeituraDaResposta {
    entendeu: boolean;
    codigo: string | null;
    texto: string;
    /**
     * A resposta nem chegou a ser da Aave — o provedor recusou antes.
     *
     * Separado de `entendeu: false` porque as duas conclusões são opostas e o
     * veredicto do ensaio estava misturando as duas: um "over rate limit"
     * aparecia como chamada reprovada e rebaixava o resultado inteiro de
     * APROVADO para PARCIAL. Culpar o meu formato por um limite do servidor é
     * a mesma família de erro que faz perder tempo consertando o que não está
     * quebrado.
     */
    naoDeuParaTestar: boolean;
}

/** Recusas do PROVEDOR, que não dizem nada sobre a chamada em si. */
export function ehLimiteDoProvedor(mensagem: string): boolean {
    // A LISTA DE PALAVRAS mora em `classificarRecusa`, num lugar so.
    //
    // Ela era aqui, com cinco `includes`, e `request limit reached` — a recusa
    // que apareceu em 28 de 28 janelas no log de 2026-10-10 — nao casava com
    // nenhum deles. A chamada subia como erro duro e a escada de espera, que
    // existe exatamente para isso, nunca era chamada. Duas listas de palavras
    // em dois lugares seria a REGRA 3 outra vez.
    return classificarRecusa(mensagem).absorveEsperando;
}

/**
 * O que a Aave respondeu, em português.
 *
 * `entendeu: true` quer dizer que a chamada chegou formatada corretamente e a
 * Aave a recusou por um motivo DELA — que é exatamente o que se quer ver num
 * ensaio contra posição saudável. `entendeu: false` é problema meu, no
 * formato, e é o que este ensaio existe para pegar.
 */
export function lerRespostaDaAave(mensagem: string): LeituraDaResposta {
    const m = mensagem.trim();

    // Aave nova: erro personalizado, 4 bytes de keccak do nome.
    const personalizado = m.match(/0x[0-9a-fA-F]{8}\b/);
    if (personalizado) {
        const sel = personalizado[0].toLowerCase();
        const conhecido = ERROS_PERSONALIZADOS[sel];
        if (conhecido) {
            return { entendeu: true, naoDeuParaTestar: false, codigo: conhecido.nome, texto: conhecido.texto };
        }
        return {
            entendeu: true,
            naoDeuParaTestar: false,
            codigo: sel,
            texto: `A Aave recusou com o erro ${sel}, que eu ainda não traduzi — mas responder com erro DELA já prova que ela leu o pedido.`,
        };
    }

    // Aave antiga: o número como texto.
    const achado = m.match(/(?:reverted:?\s*['"]?|^)(\d{1,3})['"]?\s*$/);
    if (achado) {
        const codigo = achado[1];
        const conhecido = ERROS_DA_AAVE[codigo];
        return {
            entendeu: true,
            naoDeuParaTestar: false,
            codigo,
            texto: conhecido ?? `A Aave recusou com o código ${codigo}, que eu ainda não traduzi.`,
        };
    }

    if (ehLimiteDoProvedor(m)) {
        return {
            entendeu: false,
            naoDeuParaTestar: true,
            codigo: null,
            texto: `NÃO DEU PARA TESTAR: o provedor recusou ("${m.slice(0, 60)}"). Não diz nada sobre o formato da chamada.`,
        };
    }
    return {
        entendeu: false,
        naoDeuParaTestar: false,
        codigo: null,
        texto: `A Aave NÃO respondeu com erro dela: "${m.slice(0, 120)}". Isso é problema de FORMATO meu.`,
    };
}

/**
 * A recusa foi "esta posicao AINDA NAO CRUZOU", e nao "minha configuracao quebrou"?
 *
 * Esta pergunta existe para o tiro ANTES do cruzamento. Ali a medicao TEM de
 * reverter — a Aave recusa uma posicao saudavel, e e isso que se espera. Mas
 * aceitar qualquer reversao como "e a esperada" manda dinheiro de verdade em cima
 * de contrato mal configurado ou de falha de rede. A primeira versao daquela
 * ramificacao fazia exatamente isso, contra o que o proprio comentario dela dizia.
 *
 * O repositorio ja tinha a medicao: `HealthFactorNotBelowThreshold()` viaja como
 * `0x930bb771` na Aave nova e como o codigo `45` na antiga — conferido contra a
 * Base, e esta escrito acima neste arquivo. Nao ha por que inventar de novo.
 *
 * A PRIMEIRA VERSAO DESTA FUNCAO FAZIA EXATAMENTE O QUE ESTE COMENTARIO DIZIA
 * PARA NAO FAZER, e foi medido em 2026-09-28. Ela terminava em
 * `/revert/i.test(mensagem)` — decidia pela PROSA. E toda prosa que
 * `lerRespostaDaCaca` constroi para um desfecho `revertido` contem a palavra
 * "revert": `r.mensagem` do RPC e "execution reverted", o padrao e a literal
 * `'revertido'`, e ate o caso sem motivo vira `'revertido sem mensagem'`.
 * Resultado: o portao que autoriza mandar dinheiro de verdade devolvia `true`
 * para toda reversao nao identificada — inclusive uma do NOSSO contrato —, e
 * devolvia `true` ate para mensagem vazia. Ele tambem devolvia `false` para a
 * string `'HealthFactorNotBelowThreshold()'`, que e a unica resposta certa.
 *
 * A identidade do erro nunca esteve na prosa: esta no SELETOR. Medido com
 * `eth_call` no contrato V1 da Base, no alvo `0xc4d36f95`:
 *
 *     message : "execution reverted"     <- sem identidade nenhuma
 *     data    : 0x930bb771               <- HealthFactorNotBelowThreshold()
 *
 * Entao decide-se pelos DADOS, e a prosa e so o ultimo recurso. Sem
 * identificacao POSITIVA nao se manda dinheiro: uma reversao opaca pode ser a
 * Aave recusando posicao saudavel ou pode ser o nosso contrato quebrado, e as
 * duas sao indistinguiveis de fora. Na duvida, nao atira.
 */
export const SELETOR_SAUDE_ACIMA_DO_LIMIAR = '0x930bb771';

export function naoCruzouAinda(mensagem: string | undefined, dados?: string): boolean {
    const d = (dados ?? '').trim().toLowerCase();
    // 1. Os DADOS mandam, porque sao a identidade.
    if (d !== '' && d !== '0x') {
        if (d.startsWith(SELETOR_SAUDE_ACIMA_DO_LIMIAR)) return true;
        // `Error(string)` carrega o dialeto antigo, onde a mesma recusa e '45'.
        if (!d.startsWith('0x08c379a0')) return false;
        // Cai na prosa abaixo, que e onde o texto do `Error(string)` chega.
    }
    const m = (mensagem ?? '').trim();
    // Falha de provedor nao e recusa da Aave: e a rede, e mandar aqui seria
    // atirar sem ter medido nada.
    if (m === '' || ehLimiteDoProvedor(m)) return false;
    const lida = lerRespostaDaAave(m);
    if (lida.naoDeuParaTestar) return false;
    // So identificacao POSITIVA autoriza. Qualquer outro erro identificado da
    // Aave e motivo diferente — garantia errada, reserva pausada, par trocado —
    // e uma reversao opaca nao se distingue de configuracao quebrada.
    return lida.codigo === 'HealthFactorNotBelowThreshold()' || lida.codigo === '45';
}

/** Os dados de uma reserva para um usuário — o que ele deve e o que deu. */
export function codificarUserReserveData(ativo: string, usuario: string): string {
    return (
        SELETOR_USER_RESERVE_DATA +
        coder.encode(['address', 'address'], [ativo, usuario]).slice(2)
    );
}

export interface ReservaDoUsuario {
    /** Saldo do aToken: o quanto ele tem DEPOSITADO deste ativo. */
    garantiaCrua: bigint;
    /** Dívida a juros variáveis neste ativo. */
    dividaCrua: bigint;
    /** Ele marcou este ativo como garantia? Sem isso, não serve de prêmio. */
    usadaComoGarantia: boolean;
}

export function decodificarUserReserveData(dataHex: string): ReservaDoUsuario {
    const limpo = dataHex.replace(/^0x/, '');
    if (limpo.length < 64 * 9) throw new Error('getUserReserveData devolveu menos de 9 palavras');
    const palavra = (i: number) => BigInt(`0x${limpo.slice(i * 64, (i + 1) * 64)}`);
    return {
        garantiaCrua: palavra(0),
        dividaCrua: palavra(2),
        usadaComoGarantia: palavra(8) !== 0n,
    };
}

/**
 * Qual par usar: a maior dívida e a maior garantia.
 *
 * Um devedor pode ter três dívidas e quatro garantias. A Aave liquida UM par
 * por vez, e a escolha muda o lucro: garantia pequena demais limita o quanto
 * se leva, e dívida pequena demais limita o quanto se cobre.
 *
 * Pegar as duas maiores não é o ótimo — o ótimo depende do bônus de cada
 * garantia, que varia. Mas é a escolha certa para o primeiro ensaio, e ela
 * fica registrada aqui como decisão consciente, não como acaso.
 */
export function escolherPar(
    reservas: Array<{ ativo: string; dados: ReservaDoUsuario }>,
): { garantia: string; divida: string } | null {
    let melhorGarantia: { ativo: string; valor: bigint } | null = null;
    let melhorDivida: { ativo: string; valor: bigint } | null = null;

    for (const r of reservas) {
        if (r.dados.usadaComoGarantia && r.dados.garantiaCrua > 0n) {
            if (melhorGarantia === null || r.dados.garantiaCrua > melhorGarantia.valor) {
                melhorGarantia = { ativo: r.ativo, valor: r.dados.garantiaCrua };
            }
        }
        if (r.dados.dividaCrua > 0n) {
            if (melhorDivida === null || r.dados.dividaCrua > melhorDivida.valor) {
                melhorDivida = { ativo: r.ativo, valor: r.dados.dividaCrua };
            }
        }
    }

    if (melhorGarantia === null || melhorDivida === null) return null;
    return { garantia: melhorGarantia.ativo, divida: melhorDivida.ativo };
}
