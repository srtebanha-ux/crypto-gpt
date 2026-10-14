/**
 * A MEMORIA DA DESCOBERTA: o resultado sobrevive ao deploy.
 *
 * POR QUE ISTO EXISTE, e e um defeito meu de ontem: ela abriu um trecho de log
 * que comecava 15,7 minutos depois do boot e perguntou se a API tinha
 * executado. Eu nao pude responder — nem ela — porque o resultado da descoberta
 * saia em UMA linha, no boot, e nada o re-imprimia. Varri o codigo procurando
 * qualquer rastro que durasse: `secundariasAdiadas.morpho` era contador morto
 * (nada o incrementava) e o inventario nao via os `eth_call` dela, porque ela
 * usa `fetch` cru.
 *
 * Nas palavras dela: *"Depois do deploy, quero conseguir abrir QUALQUER trecho
 * recente do log e descobrir imediatamente: A Morpho executou? Quantos mercados
 * encontrou? Quantos foram validados? Os dados estão atualizados? Qual recurso
 * está bloqueando a próxima etapa?"*
 *
 * E a regra dura, que decide o desenho: *"Uma falha posterior não pode apagar o
 * último resultado válido."* Entao ha DOIS registros, nao um:
 *
 *     ultimaTentativa   sempre sobrescrita. Pode ser falha
 *     ultimoSucesso     SO sobrescrita por um sucesso. Nunca por falha
 *
 * Colapsar os dois seria perder o ultimo bom resultado no primeiro 429 — e aí
 * uma falha de rede apagaria a unica coisa que respondia a pergunta dela.
 *
 * Os TRES estados que o relatorio distingue, porque pedem acoes diferentes:
 *
 *     NUNCA EXECUTADO    nao ha registro. NAO e "nao ha mercados"
 *     RESULTADO ATUAL    ha sucesso, e ele e recente
 *     RESULTADO ANTIGO   ha sucesso, e ele e velho. Serve para saber o que
 *                        existia, NAO para decidir transacao
 */
import { randomBytes } from 'crypto';

/**
 * A VERSAO DO FORMATO. Registro de versao anterior NAO e lixo: ele e lido no
 * que der e o que faltar fica `null`, porque `null` diz "nao registrei" e zero
 * diz "medi zero" — e este projeto perdeu os sete tiros de 07/10 por essa
 * diferenca.
 */
export const VERSAO_DA_MEMORIA = 1;

/** Quando um resultado deixa de ser ATUAL. ESCOLHA, declarada. */
export const RESULTADO_ENVELHECE_EM_MS = 30 * 60_000;

export interface RegistroDaDescoberta {
    /** Epoch ms. */
    em: number;
    /** O desfecho, nas palavras de `comoLerODesfecho`. */
    desfecho: string;
    /** A requisicao HTTP SAIU. */
    tentou: boolean;
    /** Os status HTTP REAIS, na ordem. Lista vazia = o transporte lancou antes. */
    statusHttp: number[];
    /**
     * Quantos ELEMENTOS a API mandou, antes de eu decodificar.
     *
     * Separado de `mercadosEnumerados` porque em 2026-10-14 os dois eram o
     * mesmo numero e um erro de contrato ficou indistinguivel de lista vazia:
     * HTTP 200, zero mercados, e nada no log dizendo se a API mandou algo.
     * `null` quando o registro e de antes deste campo existir — e `null` diz
     * "nao registrei", nao "a API mandou zero".
     */
    mercadosRecebidos: number | null;
    mercadosEnumerados: number;
    mercadosQuePagam: number;
    mercadosConfirmados: number;
    devedoresEncontrados: number;
    devedoresValidados: number;
    /** `null` quando a API nao informou. Nunca zero por ausencia. */
    blocoIndexado: number | null;
    /** A paginacao terminou. `false` = PISO, nao total. */
    coberturaCompleta: boolean;
    /** A falha, SANITIZADA, ou `null`. */
    falha: string | null;
    requisicoesHttp: number;
    chamadasRpc: number;
    /**
     * A lista veio do CACHE, nao da API.
     *
     * ACHADO pelo cenario 6 dela, e era defeito de verdade: com a API fora do
     * ar a descoberta cai no cache, e a lista vinha cheia. `juntar` lia isso
     * como SUCESSO e renovava `ultimoSucesso` — entao a idade do resultado se
     * renovaria a cada volta com a API morta, e a pergunta *"os dados estão
     * atualizados?"* passaria a ser respondida com mentira.
     *
     * Seguir com o cache e o comportamento certo (ela pediu). Chamar isso de
     * sucesso novo nao e.
     */
    veioDoCache: boolean;
    /**
     * O RECURSO QUE BLOQUEIA a proxima etapa, em uma frase, ou `null`.
     *
     * Ela pediu esta pergunta por nome. Sem este campo ela sai do log e volta
     * para mim, que e exatamente o atrito que este arquivo existe para remover.
     */
    oQueBloqueia: string | null;
}

export interface MemoriaDaDescoberta {
    versao: number;
    /** Sempre a ultima, sucesso ou falha. */
    ultimaTentativa: RegistroDaDescoberta | null;
    /** SO sucesso. Falha posterior nao apaga. */
    ultimoSucesso: RegistroDaDescoberta | null;
}

export const memoriaVazia = (): MemoriaDaDescoberta => ({
    versao: VERSAO_DA_MEMORIA, ultimaTentativa: null, ultimoSucesso: null,
});

const inteiro = (v: unknown): number => (
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
);

/** `null` quando ausente ou torto. NUNCA zero: zero e medicao. */
const inteiroOuNulo = (v: unknown): number | null => (
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
);

function lerRegistro(c: unknown): RegistroDaDescoberta | null {
    if (typeof c !== 'object' || c === null) return null;
    const r = c as Record<string, unknown>;
    const em = inteiroOuNulo(r.em);
    // SEM HORARIO NAO HA REGISTRO: um registro sem data nao responde "os dados
    // estao atualizados?", que e metade da pergunta dela.
    if (em === null || em === 0) return null;
    return {
        em,
        desfecho: typeof r.desfecho === 'string' ? r.desfecho.slice(0, 400) : 'desfecho não registrado',
        tentou: r.tentou === true,
        statusHttp: Array.isArray(r.statusHttp)
            ? r.statusHttp.filter((x): x is number => typeof x === 'number').slice(0, 30)
            : [],
        mercadosRecebidos: inteiroOuNulo(r.mercadosRecebidos),
        mercadosEnumerados: inteiro(r.mercadosEnumerados),
        mercadosQuePagam: inteiro(r.mercadosQuePagam),
        mercadosConfirmados: inteiro(r.mercadosConfirmados),
        devedoresEncontrados: inteiro(r.devedoresEncontrados),
        devedoresValidados: inteiro(r.devedoresValidados),
        // BLOCO ZERO NAO E BLOCO INDEXADO: e o genesis, e nenhuma API viva
        // responde isso. Aceita-lo faria `idadeDoIndice` publicar um atraso de
        // 52 milhoes de blocos como se fosse medicao — zero por ausencia
        // vestido de numero. Para as CONTAGENS, zero continua sendo medicao.
        blocoIndexado: ((v: unknown) => {
            const n = inteiroOuNulo(v);
            return n === null || n === 0 ? null : n;
        })(r.blocoIndexado),
        coberturaCompleta: r.coberturaCompleta === true,
        falha: typeof r.falha === 'string' ? r.falha.slice(0, 400) : null,
        requisicoesHttp: inteiro(r.requisicoesHttp),
        chamadasRpc: inteiro(r.chamadasRpc),
        veioDoCache: r.veioDoCache === true,
        oQueBloqueia: typeof r.oQueBloqueia === 'string' ? r.oQueBloqueia.slice(0, 400) : null,
    };
}

/**
 * Le a memoria do disco. Arquivo torto devolve memoria VAZIA, nunca lanca.
 *
 * Nao lancar e a regra: *"Cache corrompido sem derrubar o monitoramento."* Um
 * JSON cortado nao pode matar o laco de caca — este projeto ja viu um
 * `SyntaxError` nao reconhecido virar laco infinito na escada de RPC.
 */
export function lerMemoria(cru: unknown): MemoriaDaDescoberta {
    if (typeof cru !== 'object' || cru === null) return memoriaVazia();
    const c = cru as Record<string, unknown>;
    return {
        versao: inteiroOuNulo(c.versao) ?? VERSAO_DA_MEMORIA,
        ultimaTentativa: lerRegistro(c.ultimaTentativa),
        ultimoSucesso: lerRegistro(c.ultimoSucesso),
    };
}

/**
 * Junta o registro novo com o que estava no disco.
 *
 * A REGRA que decide tudo: `ultimoSucesso` so e trocado por SUCESSO. Uma falha
 * atualiza `ultimaTentativa` e deixa o bom resultado de pe.
 *
 * "Sucesso" aqui e a API ter ENTREGADO lista: `tentou` e ao menos um mercado
 * enumerado. Nao exige confirmacao na corrente — enumerar com o RPC mudo e um
 * resultado valido e tem de sobreviver, so nao autoriza decisao.
 */
export function juntar(
    anterior: MemoriaDaDescoberta | null,
    novo: RegistroDaDescoberta,
): MemoriaDaDescoberta {
    const base = anterior ?? memoriaVazia();
    // SUCESSO e a API ter ENTREGADO a lista. Cache servindo nao e sucesso novo
    // — ver a docstring de `veioDoCache`. Nao exige confirmacao na corrente:
    // enumerar com o RPC mudo e resultado valido e tem de sobreviver, so nao
    // autoriza decisao.
    const ehSucesso = novo.tentou && novo.mercadosEnumerados > 0 && !novo.veioDoCache;
    return {
        versao: VERSAO_DA_MEMORIA,
        ultimaTentativa: novo,
        ultimoSucesso: ehSucesso ? novo : base.ultimoSucesso,
    };
}

export type Frescor = 'nuncaExecutado' | 'resultadoAtual' | 'resultadoAntigo';

export function frescor(
    m: MemoriaDaDescoberta | null,
    agora: number,
): { estado: Frescor; idadeMs: number | null } {
    const s = m?.ultimoSucesso ?? null;
    if (s === null) return { estado: 'nuncaExecutado', idadeMs: null };
    const idade = agora - s.em;
    return {
        estado: idade < RESULTADO_ENVELHECE_EM_MS ? 'resultadoAtual' : 'resultadoAntigo',
        idadeMs: idade,
    };
}

const quantoTempo = (ms: number): string => (
    ms < 90_000 ? `${Math.round(ms / 1000)}s`
        : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min`
            : `${(ms / 3_600_000).toFixed(1)}h`
);

/**
 * A LINHA CURTA do `[BLOCO]`: responde as cinco perguntas dela e cabe numa
 * linha. Ela pediu *"sem produzir relatórios gigantes a cada ciclo"*.
 */
export function resumoCurto(m: MemoriaDaDescoberta | null, agora: number): string {
    const f = frescor(m, agora);
    if (f.estado === 'nuncaExecutado') {
        const t = m?.ultimaTentativa ?? null;
        if (t === null) {
            return 'morpho NUNCA EXECUTADO (nenhum registro no disco — e isto não é "não há mercados")';
        }
        // TENTOU E NAO HOUVE SUCESSO NENHUM: as duas coisas na mesma frase,
        // porque "nunca deu certo" e "nunca tentou" pedem consertos opostos.
        return `morpho SEM SUCESSO ainda: última tentativa há ${quantoTempo(agora - t.em)}`
            + `${t.statusHttp.length > 0 ? `, HTTP ${t.statusHttp.join('/')}` : ', sem status HTTP'}`
            + `${t.falha === null ? '' : ` — ${t.falha.slice(0, 80)}`}`;
    }
    const s = m!.ultimoSucesso!;
    const rotulo = f.estado === 'resultadoAtual' ? 'ATUAL' : 'ANTIGO';
    const t = m!.ultimaTentativa;
    // A ultima tentativa aparece quando ela FALHOU depois do sucesso: senao o
    // log diria "ATUAL" sobre um caminho que esta quebrando agora.
    const depois = t !== null && t.em > s.em
        ? ` | tentativa posterior ${t.veioDoCache ? 'caiu no CACHE' : 'FALHOU'} há `
            + `${quantoTempo(agora - t.em)}`
        : '';
    const recebidos = s.mercadosRecebidos !== null && s.mercadosRecebidos !== s.mercadosEnumerados
        ? `${s.mercadosRecebidos} recebidos/`
        : '';
    return `morpho ${rotulo} (há ${quantoTempo(f.idadeMs!)}): ${recebidos}${s.mercadosEnumerados} enumerados, `
        + `${s.mercadosQuePagam} na faixa, ${s.mercadosConfirmados} CONFIRMADOS, `
        + `${s.devedoresValidados}/${s.devedoresEncontrados} devedores validados`
        + `${s.coberturaCompleta ? '' : ' [cobertura PARCIAL]'}`
        + `${s.oQueBloqueia === null ? '' : ` | bloqueia: ${s.oQueBloqueia.slice(0, 90)}`}`
        + depois;
}

/** Nome unico por gravacao: duas escritas nunca disputam o mesmo temporario. */
export function nomeTemporario(caminho: string): string {
    // O defeito que isto evita esta medido: em 07/10 dois tiros resolveram
    // juntos, o temporario era `${caminho}.tmp` para todas as gravacoes, e a
    // segunda nao achou o arquivo porque a primeira ja o renomeara. Pior que
    // perder uma gravacao: duas escritas podem se intercalar e o `rename`
    // publica um JSON cortado em cima do historico.
    return `${caminho}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
}
