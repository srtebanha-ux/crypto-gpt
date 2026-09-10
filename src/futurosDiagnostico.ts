// Arquivo: src/futurosDiagnostico.ts
//
// A Binance devolve os três bloqueios de Futuros de forma quase idêntica —
// um código numérico e uma frase curta em inglês. Cada um custa uma hora
// para descobrir na mão, e os três acontecem exatamente na mesma ordem para
// todo mundo que liga o Futures pela primeira vez:
//
//   1. A chave de API não tem permissão de Futuros (-2015). Acontece porque
//      a chave foi criada ANTES da conta de Futuros existir — nesse caso a
//      caixa `Enable Futures` fica indisponível e não há como marcá-la.
//   2. O questionário obrigatório não foi concluído. A conta existe, a chave
//      tem permissão, e a ordem é recusada mesmo assim.
//   3. A carteira de Futuros está zerada. O dinheiro está no Spot ou na
//      Margem — carteiras diferentes, saldos diferentes.
//
// Traduzir isso no boot não é conforto: é a diferença entre um diagnóstico
// de dez segundos e três horas de tentativa e erro com dinheiro exposto.

/** O que impede o motor de operar, se algo impede. */
export type BloqueioDeFuturos =
    | 'chave_sem_permissao'
    | 'questionario_pendente'
    | 'carteira_vazia'
    | 'ip_nao_autorizado'
    | 'assinatura_invalida'
    | 'relogio_dessincronizado'
    | 'geobloqueio'
    | 'desconhecido';

export interface DiagnosticoDeFuturos {
    bloqueio: BloqueioDeFuturos;
    /** O que fazer, em português, na ordem em que resolve. */
    comoResolver: string;
}

/**
 * Traduz o par (código, mensagem) da Binance no bloqueio real.
 *
 * Recebe os dois porque nenhum sozinho basta: -2015 cobre chave inválida,
 * IP não autorizado e permissão faltando ao mesmo tempo, e só a mensagem
 * separa os casos. E `httpStatus` entra porque 451 nem chega a ter código.
 */
export function diagnosticarFalhaDeFuturos(params: {
    httpStatus?: number;
    codigo?: number;
    mensagem?: string;
}): DiagnosticoDeFuturos {
    const msg = (params.mensagem ?? '').toLowerCase();

    if (params.httpStatus === 451) {
        return {
            bloqueio: 'geobloqueio',
            comoResolver:
                'A Binance recusou por região (HTTP 451). O servidor onde o bot roda está num país bloqueado. ' +
                'Configure FUTURES_REST_URL/FUTURES_WS_URL para um endpoint alcançável ou mova o serviço de região.',
        };
    }

    if (params.codigo === -2015) {
        // A mesma numeração cobre três causas distintas; a frase separa.
        if (msg.includes('ip')) {
            return {
                bloqueio: 'ip_nao_autorizado',
                comoResolver:
                    'A chave está restrita por IP e o IP do servidor não está na lista. ' +
                    'Binance > API Management > Edit restrictions > IP access restrictions.',
            };
        }
        return {
            bloqueio: 'chave_sem_permissao',
            comoResolver:
                'A chave de API não tem "Enable Futures". Se a caixa aparecer indisponível, é porque a chave ' +
                'foi criada ANTES da conta de Futuros ser aberta — não há como destravar essa chave, tem de ' +
                'criar uma nova. Binance > API Management > Edit restrictions > Enable Futures.',
        };
    }

    if (params.codigo === -2014) {
        return {
            bloqueio: 'assinatura_invalida',
            comoResolver: 'Formato da chave de API inválido. Verifique se a chave e o segredo não vieram com espaço ou quebra de linha.',
        };
    }

    if (params.codigo === -1022) {
        return {
            bloqueio: 'assinatura_invalida',
            comoResolver: 'Assinatura HMAC recusada. O segredo não corresponde à chave — confira se os dois vieram do MESMO par.',
        };
    }

    if (params.codigo === -1021) {
        return {
            bloqueio: 'relogio_dessincronizado',
            comoResolver:
                'O relógio do servidor está fora da janela da Binance. O provider sincroniza sozinho no boot; ' +
                'se persistir, aumente recvWindow.',
        };
    }

    // O questionário não tem código próprio: a Binance recusa a ordem com
    // mensagens que variam, e o que elas têm em comum é a palavra.
    if (msg.includes('quiz') || msg.includes('questionnaire') || msg.includes('not eligible') || params.codigo === -2020) {
        if (msg.includes('quiz') || msg.includes('questionnaire')) {
            return {
                bloqueio: 'questionario_pendente',
                comoResolver:
                    'O questionário obrigatório de Futuros não foi concluído. Abra binance.com/en/futures e ' +
                    'clique em "Finish Quiz to Get Started". Ativar a conta e poder operar são etapas separadas.',
            };
        }
    }

    if (params.codigo === -2019 || msg.includes('margin is insufficient')) {
        return {
            bloqueio: 'carteira_vazia',
            comoResolver:
                'Margem insuficiente na carteira de Futuros. O dinheiro provavelmente está no Spot ou na Margem: ' +
                'Carteiras > Transferir > para USDⓈ-M Futures. Lembre que posição aberta e dívida na Margem ' +
                'seguram o colateral e impedem a transferência.',
        };
    }

    return {
        bloqueio: 'desconhecido',
        comoResolver: `A Binance recusou com código ${params.codigo ?? '?'}: ${params.mensagem ?? 'sem mensagem'}.`,
    };
}

/** Estado dos pré-requisitos, medido no boot antes de qualquer ordem. */
export interface ProntidaoDeFuturos {
    pronto: boolean;
    /** Tudo o que falta, na ordem em que tem de ser resolvido. */
    pendencias: string[];
}

/**
 * O motor pode ligar?
 *
 * `saldoDisponivel` e `nocionalPretendido` entram juntos porque a pergunta
 * não é "tem dinheiro?", é "tem dinheiro para a posição que este motor foi
 * configurado para abrir?". Um saldo de US$ 8 não é pouco em abstrato — é
 * pouco para um nocional de US$ 750 a 30x, que precisa de US$ 25.
 */
export function avaliarProntidao(params: {
    permissaoDeFuturos: boolean;
    saldoDisponivel: number;
    margemNecessaria: number;
}): ProntidaoDeFuturos {
    const pendencias: string[] = [];

    if (!params.permissaoDeFuturos) {
        pendencias.push('A chave de API não tem permissão de Futuros (Enable Futures).');
    }
    if (params.saldoDisponivel <= 0) {
        pendencias.push('A carteira de Futuros está zerada — transfira USDT para USDⓈ-M Futures.');
    } else if (params.saldoDisponivel < params.margemNecessaria) {
        pendencias.push(
            `Saldo de ${params.saldoDisponivel.toFixed(2)} USDT não cobre a margem de ` +
                `${params.margemNecessaria.toFixed(2)} USDT que o nocional configurado exige. ` +
                `Reduza o nocional ou aumente o saldo.`,
        );
    }

    return { pronto: pendencias.length === 0, pendencias };
}
