/**
 * O ULTIMO DEGRAU: o que fazer com um envio JA MONTADO.
 *
 * Esta funcao existe porque a decisao do ultimo degrau estava escrita INLINE
 * no laco quente, e um laco quente de 5.000 linhas nao e importavel num teste
 * — `cacarAoVivo.ts` sobe o bot ao ser importado. Entao a unica prova possivel
 * era ler o codigo, e ela pediu, com razao, prova de COMPORTAMENTO pelo
 * caminho COMPARTILHADO com producao. Agora producao chama esta funcao e o
 * teste chama ESTA MESMA funcao: nao ha copia, e a copia provaria a copia.
 *
 * Quatro estados, e tres sao recusa. So UM autoriza assinar e transmitir.
 */
export type DesfechoDoDegrau =
    /** Monta, registra e NAO transmite. A decisao inteira rodou. */
    | { acao: 'observar'; porque: string }
    /** Nao da para seguir, e a frase diz o que faltou. Nenhum nonce e gasto. */
    | { acao: 'recusar'; porque: string }
    /** O unico caminho que assina. */
    | { acao: 'transmitir'; porque: string };

export interface EntradaDoDegrau {
    /** `CACA_ENVIAR === '1'`. Autorizacao, nao capacidade. */
    envioAutorizado: boolean;
    /** Existe assinador carregado? So existe com autorizacao. */
    temAssinador: boolean;
    /** O contador de nonce subiu no boot? Sem ele o nonce furaria. */
    temContadorDeNonce: boolean;
    /** O endereco publico da conta_bot, de fonte explicita e validada. */
    enderecoPublico: string | null;
}

export function oQueFazerComOEnvio(e: EntradaDoDegrau): DesfechoDoDegrau {
    // 1. SEM ENDERECO nao ha origem: nao se le saldo, nao se le nonce, e um
    //    envio sem `from` conhecido nao e conferivel. Isto NAO e falta de
    //    chave — e o que o incidente de 2026-10-09 confundiu.
    if (e.enderecoPublico === null || e.enderecoPublico === '') {
        return {
            acao: 'recusar',
            porque: 'não sei o endereço da conta_bot (defina CACA_ENDERECO_PUBLICO ou CACA_CHAVE_PRIVADA): '
                + 'sem origem não há saldo nem nonce para conferir',
        };
    }
    // 2. SEM CONTADOR DE NONCE nao se transmite nem se observa com honestidade:
    //    o `nonceQueUsaria` do log seria inventado.
    if (!e.temContadorDeNonce) {
        return { acao: 'recusar', porque: 'o contador de nonce não subiu no boot — sem ele o nonce furaria' };
    }
    // 3. SEM AUTORIZACAO: observar. A decisao inteira rodou, a transacao esta
    //    montada, e a transmissao e o unico passo travado.
    if (!e.envioAutorizado) {
        return {
            acao: 'observar',
            porque: 'CACA_ENVIAR não é 1. A decisão inteira rodou; só a transmissão está bloqueada, '
                + 'no último degrau',
        };
    }
    // 4. AUTORIZADO E SEM ASSINADOR: recusa EXPLICITA. Nao e "observar", porque
    //    quem ligou o envio pediu envio, e silencio aqui seria o disjuntor mudo
    //    outra vez. E nao e desvio nenhum: nenhum nonce e reservado.
    if (!e.temAssinador) {
        return {
            acao: 'recusar',
            porque: 'envio AUTORIZADO e não há assinador (CACA_CHAVE_PRIVADA ausente ou inválida): '
                + 'não assino, não transmito e não reservo nonce',
        };
    }
    return { acao: 'transmitir', porque: 'envio autorizado e assinador carregado' };
}

/**
 * A INVARIANTE, escrita como funcao para o teste poder afirma-la sobre as 16
 * combinacoes em vez de sobre a que eu lembrar de escrever: assinar exige
 * autorizacao E assinador. Qualquer outra combinacao que devolva 'transmitir'
 * e um contorno do bloqueio de envio.
 */
export function podeAssinar(e: EntradaDoDegrau): boolean {
    return e.envioAutorizado && e.temAssinador;
}
