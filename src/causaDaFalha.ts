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
    /**
     * QUEM reverteu, quando um trace disse.
     *
     * MEDIDO em 2026-10-14 (`forkTests/aRotaOpaca.js`): a unica rota opaca do
     * bloco 52612934 reverteu na profundidade 4, e o `CALL` que entrou nela
     * aponta para `0x4200…0006` — o WETH. Um token que ENTREGA EXATAMENTE o que
     * manda, como o WETH mediu, so reverte uma transferencia por saldo
     * insuficiente: entao quem pediu demais foi o NOSSO executor, e isso e
     * identificacao positiva, nao palpite.
     *
     * Ausente quando nao houve trace. Ausencia nao vira veredicto.
     */
    origemDoTrace?: {
        endereco: string;
        /** O endereco e um token da rota cuja sonda mediu retencao ZERO. */
        eTokenLimpo: boolean;
        /** O endereco e um pool da rota. */
        ePool: boolean;
    } | null;
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
    // 4a. O TRACE IDENTIFICOU A ORIGEM, e ela e um token LIMPO.
    //
    // Um token que entrega exatamente o que manda nao tem por que recusar uma
    // transferencia — a nao ser que o remetente nao tivesse o saldo. Entao o
    // trace apontando para um token limpo e a identificacao positiva de que o
    // NOSSO executor pediu mais do que tinha em maos, e nao uma reversao opaca.
    //
    // Conferido no bloco 52612934: a mesma rota com piso de lucro ZERO reverteu
    // igual — logo nao foi o piso, foi nao haver com que pagar o emprestimo.
    const o = e.origemDoTrace;
    if (o !== undefined && o !== null && o.eTokenLimpo && !o.ePool) {
        return {
            causa: 'ERRO_DO_EXECUTOR',
            culpados: [],
            porque: `o trace aponta a origem da reversão em ${o.endereco}, que é um token da `
                + 'rota cuja transferência MEDIU retenção zero. Um token limpo só recusa por '
                + 'saldo insuficiente: quem pediu mais do que tinha foi o nosso executor. '
                + 'Nenhuma peça é condenada — o defeito é a nossa conta',
            excluiPermanentemente: false,
        };
    }

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

/**
 * O ESCOPO DE UMA EXCLUSAO — o MENOR que a evidencia sustenta.
 *
 * Pedido dela por nome: *"Faça a exclusão no menor escopo comprovado: token,
 * direção, remetente, destinatário e pool, conforme a evidência disponível. Não
 * transforme uma taxa dependente do remetente em blacklist global."*
 *
 * E o pedido nasceu de uma medicao: `0x7787…734f` retem 479/1000 saindo de um
 * pool e 0/1000 saindo de outro — ele isenta enderecos. Uma blacklist global a
 * partir da primeira medicao apagaria rotas que funcionam; uma a partir da
 * segunda absolveria um token que cobra 48%.
 *
 * `null` em qualquer campo quer dizer "nao restringe por isto". Entao um escopo
 * com `remetente` preenchido e MENOR que um sem: ele so cobre o que foi visto.
 */
export interface EscopoDaExclusao {
    token: string;
    /** O pool de onde o token saiu na medicao. `null` = nao restringe. */
    remetente: string | null;
    /** Para onde foi. `null` = nao restringe. */
    destinatario: string | null;
    /** A fracao retida, MEDIDA. `null` quando a transferencia reverteu. */
    retidoPorMil: number | null;
    /** A transferencia reverteu entre contas arbitrarias. */
    reverteu: boolean;
    /** A frase que sustenta, com os numeros. */
    porque: string;
}

/**
 * O escopo que a sonda sustenta — e nada maior.
 *
 * Uma transferencia que REVERTE e a evidencia mais forte que existe aqui: um
 * token que nao transfere entre contas arbitrarias nao serve a flash swap
 * nenhum, entao o escopo nao precisa do remetente. Uma transferencia que
 * ENTREGA MENOS depende do par — e aí o remetente FICA no escopo.
 */
export function escopoDoVeredicto(s: SondaDeToken, remetente: string | null): EscopoDaExclusao {
    const r = retidoPorMil(s);
    if (s.reverteu) {
        return {
            token: s.token.toLowerCase(),
            // SEM remetente de proposito: recusar transferencia nao e
            // propriedade do par, e um flash swap exige duas transferencias.
            remetente: null,
            destinatario: null,
            retidoPorMil: null,
            reverteu: true,
            porque: 'a transferência REVERTEU entre contas arbitrárias: nenhum remetente a '
                + 'torna executável, então a exclusão é do token em qualquer rota',
        };
    }
    return {
        token: s.token.toLowerCase(),
        // COM remetente: a taxa foi medida SAINDO DELE. Outro remetente pode
        // ser isento, e medido foi: 479/1000 de um pool, 0/1000 de outro.
        remetente: remetente === null ? null : remetente.toLowerCase(),
        destinatario: null,
        retidoPorMil: r,
        reverteu: false,
        porque: `retém ${r}/1000 SAINDO DE ${remetente ?? 'remetente não registrado'} `
            + '(enviado ' + String(s.enviado) + ', recebido ' + String(s.recebido) + '). '
            + 'A exclusão vale para este par; outro remetente pode ser isento, e isso foi MEDIDO',
    };
}

/** O que de fato CHEGA, descontada a retencao medida. */
export function recebidoEfetivo(bruto: bigint, retidoPorMil: number | null): bigint {
    if (retidoPorMil === null || retidoPorMil <= 0) return bruto;
    if (retidoPorMil >= 1000) return 0n;
    return (bruto * BigInt(1000 - retidoPorMil)) / 1000n;
}

/**
 * O REGISTRO das exclusoes, por escopo.
 *
 * Substitui a condenacao por associacao: aqui nada entra sem um
 * `EscopoDaExclusao`, que por construcao so existe a partir de uma sonda sobre
 * a PECA. E `cobre` responde a pergunta do caçador — *esta perna esta
 * excluida?* — olhando o par, nao so o token.
 */
export class Exclusoes {
    private readonly porToken = new Map<string, EscopoDaExclusao[]>();

    registrar(e: EscopoDaExclusao): void {
        const k = e.token.toLowerCase();
        const lista = this.porToken.get(k) ?? [];
        // Um escopo sem remetente ENGLOBA os com remetente do mesmo token:
        // guardar os dois faria a leitura dizer duas coisas sobre o mesmo fato.
        if (e.remetente === null) {
            this.porToken.set(k, [e]);
            return;
        }
        if (lista.some((x) => x.remetente === null)) return;
        if (lista.some((x) => x.remetente === e.remetente)) return;
        lista.push(e);
        this.porToken.set(k, lista);
    }

    /**
     * Esta transferencia esta coberta por uma exclusao PROVADA?
     *
     * `remetente` ausente so casa com escopo global: sem saber quem manda, um
     * escopo de par nao pode ser afirmado nem negado, e afirmar seria o defeito
     * que esta classe existe para impedir.
     */
    cobre(token: string, remetente?: string | null): EscopoDaExclusao | null {
        const lista = this.porToken.get(token.toLowerCase());
        if (lista === undefined) return null;
        const global = lista.find((x) => x.remetente === null);
        if (global !== undefined) return global;
        if (remetente === undefined || remetente === null) return null;
        return lista.find((x) => x.remetente === remetente.toLowerCase()) ?? null;
    }

    /** A retencao medida para este par, para a conta do valor efetivo. */
    retencaoDe(token: string, remetente?: string | null): number | null {
        const e = this.cobre(token, remetente);
        return e === null ? null : e.retidoPorMil;
    }

    get quantos(): number {
        return [...this.porToken.values()].reduce((a, l) => a + l.length, 0);
    }

    todos(): EscopoDaExclusao[] {
        return [...this.porToken.values()].flat();
    }

    comoLer(): string {
        if (this.porToken.size === 0) {
            return 'nenhuma exclusão — e isto NÃO é "não há peça ruim": é "nenhuma sonda '
                + 'comprovou uma ainda"';
        }
        const globais = this.todos().filter((e) => e.remetente === null).length;
        const pares = this.quantos - globais;
        return `${this.quantos} exclusão(ões) PROVADA(S) em ${this.porToken.size} token(s): `
            + `${globais} do token em qualquer rota (transferência recusada), `
            + `${pares} restrita(s) ao PAR medido (taxa depende do remetente)`;
    }
}

export function comoLerOVeredicto(v: Veredicto): string {
    return `${v.causa}${v.culpados.length > 0 ? ` [${v.culpados.join(', ')}]` : ''}: ${v.porque}`
        + (v.excluiPermanentemente
            ? ' >>> EXCLUI a peça de todas as rotas'
            : ' >>> exclui SÓ esta rota');
}

/**
 * OS TRES ESTADOS DE UMA OPORTUNIDADE — pedido dela por nome em 2026-10-15.
 *
 *   *"DESCARTADA: inviabilidade economicamente ou tecnicamente comprovada.
 *   NÃO VALIDADA: há informação insuficiente ou limitação do avaliador.
 *   EXECUTÁVEL EM SIMULAÇÃO: execução atômica bem-sucedida e resultado líquido
 *   positivo medido."*
 *
 * E as quatro frases que ela escreveu junto, porque cada uma e um erro que este
 * projeto cometeu:
 *
 *   `gasDesconhecido` nao significa prejuizo.
 *   Token pouco conhecido nao significa token hostil.
 *   Reversao opaca nao significa arbitragem impossivel.
 *   Erro do executor nao significa mercado invalido.
 *
 * As tres existem porque DESCARTADA e NAO_VALIDADA pedem acoes opostas:
 * descartar e fechar a hipotese, e nao validar e um buraco no AVALIADOR. Juntar
 * as duas num "recusado" transforma limitacao minha em ausencia de mercado — e
 * foi exatamente isso que fez o TITAN publicar "0 oportunidades" por um mes.
 */
export type EstadoDaOportunidade = 'DESCARTADA' | 'NAO_VALIDADA' | 'EXECUTAVEL_EM_SIMULACAO';

export interface Classificacao {
    estado: EstadoDaOportunidade;
    porque: string;
    /** Só `EXECUTAVEL_EM_SIMULACAO` tem líquido medido. */
    liquidoWei: bigint | null;
}

/**
 * Classifica a partir do que se SABE, e nunca a partir do que falta.
 *
 * `executouComLucro` so pode vir de execucao atomica integral com o liquido
 * apurado — nao de estimativa. Quem nao tem isso NAO e executavel, e a razao
 * decide entre descartada e nao validada.
 */
export function classificar(e: {
    /** A execução atômica integral rodou e o líquido foi apurado. */
    executouComLucro?: { liquidoWei: bigint } | null;
    /** Inviabilidade COMPROVADA: a conta fechada diz que não paga. */
    inviavelComprovada?: { porque: string } | null;
    /** O avaliador não soube: gás sem preço, cotação ausente, sonda que não rodou. */
    limitacaoDoAvaliador?: { porque: string } | null;
}): Classificacao {
    // 1. EXECUTOU com líquido positivo: é o único caminho para executável.
    const x = e.executouComLucro;
    if (x !== undefined && x !== null) {
        if (x.liquidoWei > 0n) {
            return {
                estado: 'EXECUTAVEL_EM_SIMULACAO',
                porque: `execução atômica integral bem-sucedida e líquido MEDIDO de `
                    + `${x.liquidoWei} wei depois de todos os custos`,
                liquidoWei: x.liquidoWei,
            };
        }
        // Executou e não pagou: inviabilidade comprovada pela execução, que é a
        // prova mais forte que existe aqui.
        return {
            estado: 'DESCARTADA',
            porque: `a execução integral rodou e o líquido foi ${x.liquidoWei} wei: `
                + 'inviabilidade COMPROVADA pela própria execução, não estimada',
            liquidoWei: x.liquidoWei,
        };
    }
    // 2. LIMITACAO DO AVALIADOR vem ANTES da inviabilidade, e a ordem importa:
    //    sem saber o custo, "não paga o gás" é uma conclusão que não se tem.
    //    `gasDesconhecido` NAO significa prejuízo — é a frase dela.
    const l = e.limitacaoDoAvaliador;
    if (l !== undefined && l !== null) {
        return {
            estado: 'NAO_VALIDADA',
            porque: `${l.porque}. Isto é limitação do AVALIADOR, não inviabilidade: nada aqui `
                + 'diz que a oportunidade não existe',
            liquidoWei: null,
        };
    }
    const i = e.inviavelComprovada;
    if (i !== undefined && i !== null) {
        return { estado: 'DESCARTADA', porque: i.porque, liquidoWei: null };
    }
    // 3. NADA SE SABE. Não é descartada.
    return {
        estado: 'NAO_VALIDADA',
        porque: 'nenhuma evidência foi apresentada: sem execução, sem inviabilidade comprovada '
            + 'e sem limitação declarada, o estado honesto é NÃO VALIDADA',
        liquidoWei: null,
    };
}
