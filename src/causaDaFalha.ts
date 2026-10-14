/**
 * A CAUSA DE UMA ROTA QUE FALHOU — cinco estados, e nenhum deles inventado.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Em 2026-10-14 o filtro condenou CINCO tokens a
 * partir de DUAS rotas que reverteram, e com isso excluiu 1.254 de 1.256
 * candidatos. A dona do bot recusou a conclusao, e com razao:
 *
 *   *"NÃO ACEITO ESSA CONCLUSÃO ENQUANTO A EXCLUSÃO NÃO FOR CAUSALMENTE
 *   COMPROVADA. Não condene todos os tokens de uma rota que reverteu."*
 *
 * Uma rota de quatro pernas tem tres tokens incomuns e tres pools. Se ela
 * reverte, o culpado e UM deles — condenar os seis e trocar deteccao por
 * poda, e "zero oportunidades" passa a significar "o meu filtro desistiu".
 *
 * OS CINCO ESTADOS, e eles pedem acoes DIFERENTES:
 *
 *   TOKEN_HOSTIL        o token, SOZINHO, se comporta mal. Evidencia
 *                       especifica: uma transferencia direta entrega menos do
 *                       que manda, ou reverte entre contas arbitrarias
 *   POOL_INCOMPATIVEL   o token passa no teste isolado e o POOL recusa — outra
 *                       matematica, outro callback, taxa diferente da lida
 *   ERRO_DO_EXECUTOR    token e pool passam isolados e a rota falha: o defeito
 *                       e NOSSO, e condenar o token esconderia o nosso bug
 *   ROTA_REVERTIDA      a rota reverteu e os componentes passam — a combinacao
 *                       nao fecha (preco mudou, tamanho, invariante no limite).
 *                       NAO condena nada: e sobre a rota, nao sobre as pecas
 *   CAUSA_DESCONHECIDA  nao consegui isolar. E o unico honesto quando a sonda
 *                       nao pode rodar — e nunca autoriza condenar um token
 *
 * A REGRA que o resto do codigo tem de respeitar: so `TOKEN_HOSTIL` e
 * `POOL_INCOMPATIVEL` excluem algo permanentemente, e os dois exigem evidencia
 * ISOLADA sobre a peca. Os outros tres excluem a ROTA e nada mais.
 */

export type Causa =
    | 'TOKEN_HOSTIL'
    | 'POOL_INCOMPATIVEL'
    | 'ERRO_DO_EXECUTOR'
    | 'ROTA_REVERTIDA'
    | 'CAUSA_DESCONHECIDA';

/** O que a sonda de UM token mediu, isoladamente. */
export interface SondaDeToken {
    token: string;
    /** A sonda conseguiu rodar. `false` nao acusa nada. */
    rodou: boolean;
    /** Quanto foi enviado numa transferencia direta. */
    enviado: bigint | null;
    /** Quanto chegou. Menor que `enviado` e taxa MEDIDA. */
    recebido: bigint | null;
    /** A transferencia reverteu. */
    reverteu: boolean;
    porque: string;
}

/** O que a sonda de UM pool mediu, com um token que passou no isolado. */
export interface SondaDePool {
    pool: string;
    rodou: boolean;
    /** Um swap de uma perna passou. */
    passou: boolean;
    porque: string;
}

export interface Evidencia {
    /** Por token, na ordem em que aparecem na rota. */
    tokens: SondaDeToken[];
    /** Por pool. */
    pools: SondaDePool[];
    /** A mensagem da reversao da rota inteira. */
    mensagemDaRota: string;
}

export interface Veredicto {
    causa: Causa;
    /** O que exatamente foi condenado. Vazio quando so a rota caiu. */
    culpados: string[];
    /** A frase que sustenta o veredicto, com os numeros medidos. */
    porque: string;
    /** O veredicto exclui a peca permanentemente, ou so esta rota? */
    excluiPermanentemente: boolean;
}

/** Quanto a transferencia retem, em por mil. `null` quando nao mediu. */
export function retidoPorMil(s: SondaDeToken): number | null {
    if (!s.rodou || s.enviado === null || s.recebido === null || s.enviado <= 0n) return null;
    if (s.recebido >= s.enviado) return 0;
    return Number(((s.enviado - s.recebido) * 1000n) / s.enviado);
}

/**
 * O VEREDICTO, a partir da evidencia isolada. Nunca a partir da rota sozinha.
 *
 * A ordem das perguntas e a ordem da forca da evidencia: primeiro o que foi
 * medido SOBRE A PECA, depois o que sobra.
 */
export function julgarFalha(e: Evidencia): Veredicto {
    const naoRodaram = e.tokens.filter((t) => !t.rodou);

    // 1. TOKEN HOSTIL: evidencia ESPECIFICA sobre o token.
    const hostis = e.tokens.filter((t) => t.rodou && (t.reverteu || retidoPorMil(t)! > 0));
    if (hostis.length > 0) {
        const detalhe = hostis.map((t) => {
            const r = retidoPorMil(t);
            return t.reverteu
                ? `${t.token} RECUSA transferência`
                : `${t.token} retém ${r}/1000 (enviado ${t.enviado}, recebido ${t.recebido})`;
        });
        return {
            causa: 'TOKEN_HOSTIL',
            culpados: hostis.map((t) => t.token),
            porque: `medido por transferência direta, token por token: ${detalhe.join('; ')}. `
                + 'Os outros tokens da rota NÃO são condenados: a evidência é específica',
            excluiPermanentemente: true,
        };
    }

    // 2. POOL INCOMPATIVEL: os tokens passaram e um pool recusou.
    const poolsRuins = e.pools.filter((p) => p.rodou && !p.passou);
    if (poolsRuins.length > 0) {
        return {
            causa: 'POOL_INCOMPATIVEL',
            culpados: poolsRuins.map((p) => p.pool),
            porque: `todos os tokens passaram na transferência isolada, e ${poolsRuins.length} `
                + `pool(s) recusou um swap de UMA perna: ${poolsRuins.map((p) => `${p.pool} (${p.porque})`).join('; ')}`,
            excluiPermanentemente: true,
        };
    }

    // 3. NAO DEU PARA ISOLAR: desconhecido, e nao condena nada.
    if (naoRodaram.length > 0 || e.pools.some((p) => !p.rodou)) {
        return {
            causa: 'CAUSA_DESCONHECIDA',
            culpados: [],
            porque: `a sonda não rodou em ${naoRodaram.length} token(s) e `
                + `${e.pools.filter((p) => !p.rodou).length} pool(s) — então eu NÃO SEI de quem é `
                + 'a falha. Nada é condenado: excluir sem prova é o defeito que este arquivo '
                + 'existe para impedir',
            excluiPermanentemente: false,
        };
    }

    // 4. TOKENS E POOLS PASSAM, e a rota cai. Duas leituras, e a mensagem da
    //    rota decide qual: invariante no limite e propriedade da COMBINACAO;
    //    saldo insuficiente e o nosso executor errando a conta.
    const m = e.mensagemDaRota.toLowerCase();
    const nossoErro = m.includes('insufficient account balance')
        || m.includes('subtraction overflow')
        || m.includes('hopsemsaida')
        || m.includes('rotainvalida');
    if (nossoErro) {
        return {
            causa: 'ERRO_DO_EXECUTOR',
            culpados: [],
            porque: 'tokens e pools passaram isolados, e a rota falhou com erro de CONTA do nosso '
                + `executor: "${e.mensagemDaRota.slice(0, 120)}". Condenar o token aqui esconderia `
                + 'o nosso defeito',
            excluiPermanentemente: false,
        };
    }
    // 5. ROTA_REVERTIDA exige IDENTIFICACAO POSITIVA da falha da combinacao.
    //
    // MEDIDO em 2026-10-14: uma rota com todas as pecas limpas reverteu com
    // "Transaction reverted without a reason string", e esta funcao publicava
    // "a COMBINAÇÃO não fecha". Isso e afirmar a causa a partir de uma reversao
    // OPACA — o defeito que este projeto persegue desde a primeira pagina, e o
    // mesmo do `naoCruzouAinda`, que autorizava gastar dinheiro por achar a
    // palavra "revert" na prosa. Reversao sem motivo legivel nao se distingue
    // de contrato quebrado, e `CAUSA_DESCONHECIDA` e a resposta honesta.
    //
    // A lista e de assinaturas em que o PROPRIO pool (ou o nosso piso) recusou
    // dizendo por que: ai a combinacao e que nao fecha, e isso esta identificado.
    const combinacaoIdentificada = m.includes('uniswapv2: k')
        || m.includes('invariant')
        || m.includes('insufficient_output')
        || m.includes('insufficient output')
        || m.includes('insufficient_liquidity')
        || m.includes('lucroinsuficiente')
        || m.includes('k)');
    if (!combinacaoIdentificada) {
        return {
            causa: 'CAUSA_DESCONHECIDA',
            culpados: [],
            porque: 'as peças passaram isoladas e a rota reverteu SEM motivo legível '
                + `("${e.mensagemDaRota.slice(0, 120)}"). Reversão opaca não identifica causa: `
                + 'não dá para distinguir "a combinação não fecha" de "o nosso executor quebrou". '
                + 'Nada é condenado, e esta rota fica para ser investigada por trace',
            excluiPermanentemente: false,
        };
    }
    return {
        causa: 'ROTA_REVERTIDA',
        culpados: [],
        porque: 'tokens e pools passaram isolados, e a recusa IDENTIFICA a combinação: a rota '
            + `não fecha neste bloco e neste tamanho ("${e.mensagemDaRota.slice(0, 120)}"). `
            + 'Exclui esta rota, e NADA mais — as peças seguem elegíveis em outras rotas',
        excluiPermanentemente: false,
    };
}

export function comoLerOVeredicto(v: Veredicto): string {
    return `${v.causa}${v.culpados.length > 0 ? ` [${v.culpados.join(', ')}]` : ''}: ${v.porque}`
        + (v.excluiPermanentemente
            ? ' >>> EXCLUI a peça de todas as rotas'
            : ' >>> exclui SÓ esta rota');
}
