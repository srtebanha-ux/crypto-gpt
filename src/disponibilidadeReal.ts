/**
 * DISPONIBILIDADE REAL: por PROVEDOR, por METODO, com IDADE.
 *
 * A evidencia que criou este arquivo, do log do Railway em 2026-10-14:
 *
 *     16:49:52  base-rpc.publicnode.com aceitou eth_getLogs de 10.000 blocos
 *     mesma hora "secundariasAdiadas":{"historico":1}  -> depois 2
 *     sempre     "descoberta ADIADA"
 *
 * O censo estava pausado por `oQuePausar({algumEsgotado})`, e o provedor
 * esgotado era a Alchemy — que nao servia trafego nenhum. Quem servia era o
 * PublicNode, e ele acabara de demonstrar 10k blocos por chamada. **O
 * esgotamento de um provedor bloqueava trabalho que outro provedor
 * comprovadamente fazia.** E a mesma subordinacao do incidente do canal HTTP,
 * num eixo diferente.
 *
 * E ela pos a condicao que impede o conserto de virar o defeito oposto: *"nao
 * transforme a recuperacao parcial do eth_getLogs em autorizacao para consumir
 * RPC indiscriminadamente"*. As tres frases dela, que sao as tres regras deste
 * arquivo:
 *
 *     um 429 da Alchemy NAO bloqueia o PublicNode      -> a chave e por PROVEDOR
 *     um eth_call que passou NAO prova eth_getLogs      -> a chave e por METODO
 *     um eth_getLogs que passou NAO prova continuidade  -> a prova VENCE com o tempo
 *
 * A terceira e a que nao existia em lugar nenhum deste projeto: disponibilidade
 * era um booleano sem data. Aqui ela tem idade, e idade vencida volta para
 * DESCONHECIDO — que autoriza sondagem pequena, nunca varredura.
 */

/**
 * OS QUATRO ESTADOS. Eles nao sao graus da mesma coisa: pedem acoes
 * diferentes, e colapsar dois quaisquer deles e um defeito ja medido aqui.
 *
 *     disponivel    uma resposta BOA, recente, DESTE metodo neste provedor
 *     indisponivel  recusa que esperar nao resolve (cota esgotada, metodo
 *                   ausente). Repetir gasta o que sobrou
 *     desconhecido  nunca perguntei, ou a prova venceu. NAO e disponivel e
 *                   NAO e indisponivel: autoriza SONDAGEM, nunca varredura
 *     emRecuo       recusa passageira (429, tempo). Volta sozinho, e ate
 *                   voltar nao se insiste
 */
export type EstadoDoMetodo = 'disponivel' | 'indisponivel' | 'desconhecido' | 'emRecuo';

/**
 * A IDADE EM QUE UMA PROVA VENCE.
 *
 * ESCOLHA, nao medicao, e esta escrito assim de proposito. O que esta medido e
 * que a condicao muda em minutos: o log de 2026-10-14 mostra a Alchemy indo de
 * servindo a esgotada entre dois boots, e o teto do `eth_getLogs` do
 * `mainnet.base.org` caiu 2000 -> 500 -> 312 em cinco dias. Cinco minutos e
 * curto o bastante para nao autorizar varredura sobre prova velha, e longo o
 * bastante para nao sondar a cada ciclo.
 */
export const PROVA_VENCE_EM_MS = 5 * 60_000;

/** O recuo cresce a cada recusa seguida, e tem teto. ESCOLHA declarada. */
export const RECUO_BASE_MS = 2_000;
export const RECUO_TETO_MS = 60_000;

/**
 * O TETO DE UMA SONDAGEM, em blocos.
 *
 * Com o estado DESCONHECIDO nao se varre: sonda-se. Este numero e pequeno de
 * proposito — ele existe para descobrir se o metodo responde, e nao para
 * coletar. Quem coleta precisa de `disponivel` com prova fresca.
 */
export const BLOCOS_DE_UMA_SONDAGEM = 100;

interface FatoDeMetodo {
    ultimoSucessoEm: number | null;
    ultimaRecusaEm: number | null;
    /** A ultima recusa, SANITIZADA. */
    motivo: string | null;
    recusasSeguidas: number;
    /** Ate quando nao se insiste. `null` fora de recuo. */
    recuoAteEm: number | null;
    /** Recusa que esperar NAO resolve: cota esgotada, metodo ausente. */
    duradoura: boolean;
    /** O teto MEDIDO deste metodo neste provedor (blocos), quando medido. */
    limiteConhecido: number | null;
    limiteMedidoEm: number | null;
}

const fatoVazio = (): FatoDeMetodo => ({
    ultimoSucessoEm: null, ultimaRecusaEm: null, motivo: null, recusasSeguidas: 0,
    recuoAteEm: null, duradoura: false, limiteConhecido: null, limiteMedidoEm: null,
});

export interface Veredicto {
    estado: EstadoDoMetodo;
    /** Idade da ULTIMA PROVA BOA, em ms. `null` quando nunca houve uma. */
    idadeDaProvaMs: number | null;
    /** O teto medido de blocos por chamada, quando medido e ainda fresco. */
    limiteConhecido: number | null;
    /**
     * Pode mandar uma SONDAGEM pequena agora.
     *
     * Verdadeiro em `desconhecido` (e para que serve o estado) e em
     * `disponivel`. Falso em `emRecuo` e em `indisponivel`: nos dois, insistir
     * e pagar para descobrir o que ja se sabe.
     */
    podeSondar: boolean;
    /**
     * Pode varrer HISTORICO agora — e isto e mais estreito que `podeSondar` de
     * proposito. So `disponivel` com prova FRESCA autoriza.
     */
    podeVarrer: boolean;
    /** Quantos blocos pedir, no maximo, dado o estado. */
    tetoDeBlocos: number | null;
    porque: string;
}

export class DisponibilidadeReal {
    /** chave: `${provedor}|${metodo}`. */
    private readonly fatos = new Map<string, FatoDeMetodo>();

    constructor(private readonly agora: () => number = () => Date.now()) {}

    private fato(provedor: string, metodo: string): FatoDeMetodo {
        const k = `${provedor}|${metodo}`;
        const f = this.fatos.get(k) ?? fatoVazio();
        this.fatos.set(k, f);
        return f;
    }

    /**
     * Uma resposta BOA deste metodo neste provedor.
     *
     * `limiteDeBlocos` entra quando a resposta mediu o teto — e o que o
     * `[RPC] Teto de eth_getLogs ... MEDIDO agora` descobriu. Ele NAO e
     * generalizado para outro provedor nem para outro metodo.
     */
    sucesso(provedor: string, metodo: string, limiteDeBlocos?: number): void {
        const f = this.fato(provedor, metodo);
        f.ultimoSucessoEm = this.agora();
        f.recusasSeguidas = 0;
        f.recuoAteEm = null;
        f.duradoura = false;
        f.motivo = null;
        if (limiteDeBlocos !== undefined && limiteDeBlocos > 0) {
            f.limiteConhecido = limiteDeBlocos;
            f.limiteMedidoEm = this.agora();
        }
    }

    /**
     * Uma recusa deste metodo neste provedor.
     *
     * `duradoura` separa "esperar nao resolve" (cota mensal, metodo ausente) de
     * "volta sozinho" (429 de frequencia, tempo). As duas pedem acoes opostas, e
     * este projeto registra o custo de confundi-las: esperar numa cota esgotada
     * gasta o que sobrou dela.
     */
    recusa(provedor: string, metodo: string, motivo: string, duradoura: boolean): void {
        const f = this.fato(provedor, metodo);
        f.ultimaRecusaEm = this.agora();
        f.motivo = motivo.slice(0, 160);
        f.recusasSeguidas += 1;
        f.duradoura = duradoura;
        f.recuoAteEm = duradoura
            ? null
            : this.agora() + Math.min(
                RECUO_TETO_MS,
                RECUO_BASE_MS * 2 ** (f.recusasSeguidas - 1),
            );
    }

    /** O veredicto para ESTE provedor e ESTE metodo, agora. */
    veredicto(provedor: string, metodo: string): Veredicto {
        const f = this.fatos.get(`${provedor}|${metodo}`);
        const base = { limiteConhecido: null, idadeDaProvaMs: null };

        if (f === undefined) {
            return {
                ...base, estado: 'desconhecido',
                podeSondar: true, podeVarrer: false, tetoDeBlocos: BLOCOS_DE_UMA_SONDAGEM,
                porque: `nunca pedi ${metodo} a este provedor: DESCONHECIDO, e desconhecido não é `
                    + `disponível. Autoriza sondagem de ${BLOCOS_DE_UMA_SONDAGEM} bloco(s), não varredura`,
            };
        }

        const idade = f.ultimoSucessoEm === null ? null : this.agora() - f.ultimoSucessoEm;
        // O limite medido tambem vence: o teto do provedor mudou tres vezes em
        // cinco dias neste projeto, e um teto velho produz janela que falha
        // inteira — o defeito do `PEDACO_MINIMO = 2000` cravado.
        const limite = f.limiteMedidoEm !== null
            && this.agora() - f.limiteMedidoEm < PROVA_VENCE_EM_MS
            ? f.limiteConhecido
            : null;

        // 1. DURADOURA manda sobre tudo: esperar nao resolve e repetir gasta.
        if (f.duradoura) {
            return {
                estado: 'indisponivel', idadeDaProvaMs: idade, limiteConhecido: limite,
                podeSondar: false, podeVarrer: false, tetoDeBlocos: null,
                porque: `${metodo} recusado de forma que esperar não resolve: `
                    + `${f.motivo ?? 'sem motivo registrado'}. Repetir gasta o que sobrou`,
            };
        }

        // 2. EM RECUO: recusa passageira, e ate voltar nao se insiste.
        if (f.recuoAteEm !== null && this.agora() < f.recuoAteEm) {
            return {
                estado: 'emRecuo', idadeDaProvaMs: idade, limiteConhecido: limite,
                podeSondar: false, podeVarrer: false, tetoDeBlocos: null,
                porque: `${metodo} recusou ${f.recusasSeguidas}x seguidas e estou em recuo por `
                    + `${Math.ceil((f.recuoAteEm - this.agora()) / 1000)}s: `
                    + `${f.motivo ?? 'sem motivo registrado'}`,
            };
        }

        // 3. NUNCA PASSOU, mas o recuo acabou: volta a DESCONHECIDO, nao a
        //    disponivel. Recuo que expira nao e prova de nada.
        if (idade === null) {
            return {
                estado: 'desconhecido', idadeDaProvaMs: null, limiteConhecido: limite,
                podeSondar: true, podeVarrer: false, tetoDeBlocos: BLOCOS_DE_UMA_SONDAGEM,
                porque: `${metodo} nunca respondeu bem neste provedor (o recuo expirou, e isso não `
                    + `é prova): DESCONHECIDO, autoriza sondagem de ${BLOCOS_DE_UMA_SONDAGEM} bloco(s)`,
            };
        }

        // 4. A PROVA VENCE. Esta e a regra que nao existia: um eth_getLogs que
        //    passou as 16:49 nao prova disponibilidade as 17:30.
        if (idade >= PROVA_VENCE_EM_MS) {
            return {
                estado: 'desconhecido', idadeDaProvaMs: idade, limiteConhecido: limite,
                podeSondar: true, podeVarrer: false, tetoDeBlocos: BLOCOS_DE_UMA_SONDAGEM,
                porque: `${metodo} passou aqui, mas há ${Math.round(idade / 1000)}s — a prova `
                    + `venceu (teto ${Math.round(PROVA_VENCE_EM_MS / 1000)}s) e sucesso antigo não `
                    + 'prova disponibilidade contínua: DESCONHECIDO, autoriza sondagem',
            };
        }

        return {
            estado: 'disponivel', idadeDaProvaMs: idade, limiteConhecido: limite,
            podeSondar: true, podeVarrer: true,
            tetoDeBlocos: limite,
            porque: `${metodo} respondeu bem há ${Math.round(idade / 1000)}s neste provedor`
                + (limite === null
                    ? ', e o teto de blocos NÃO está medido (sondar antes de varrer)'
                    : `, com teto medido de ${limite.toLocaleString('pt-BR')} bloco(s)`),
        };
    }

    /**
     * A FRASE do log, curta, para UM provedor e UM metodo.
     *
     * Ela pediu `[BLOCO]` sem *"relatórios gigantes a cada ciclo"*, então aqui
     * cabe numa linha: estado, idade e teto.
     */
    comoLer(provedor: string, metodo: string): string {
        const v = this.veredicto(provedor, metodo);
        const idade = v.idadeDaProvaMs === null
            ? 'sem prova'
            : `prova de ${Math.round(v.idadeDaProvaMs / 1000)}s`;
        const teto = v.limiteConhecido === null ? 'teto ?' : `teto ${v.limiteConhecido}`;
        return `${metodo}@${provedor}: ${v.estado} (${idade}, ${teto})`;
    }
}

/**
 * A AUTORIZACAO DE UMA VARREDURA PESADA, que e onde a condicao dela mora.
 *
 * Ela foi explicita: *"Estados desconhecidos devem permitir sondagens pequenas
 * e controladas, nunca liberar automaticamente uma varredura histórica sem
 * limite"* e *"Se o PublicNode aceitar 10.000 blocos, isso comprova aquela
 * consulta, não que todas as consultas de 10.000 blocos sejam viáveis"*.
 *
 * Entao a autorizacao exige TRES coisas juntas, e nenhuma delas sozinha basta:
 *
 *     1. o veredicto do PROVEDOR ATIVO para ESTE metodo diz `podeVarrer`
 *     2. ha orcamento restante na tarefa (requisicoes E tempo)
 *     3. o teto de blocos sai do que foi MEDIDO, nao do que eu gostaria
 *
 * E o monitoramento NAO entra aqui: ele nunca e barrado por orcamento de tarefa
 * secundaria. Quem pergunta por ele esta perguntando a coisa errada.
 */
export function autorizarVarredura(e: {
    veredicto: Veredicto;
    /** Requisicoes que ainda cabem no orcamento da tarefa. */
    requisicoesRestantes: number;
    /** Tempo que ainda cabe, em ms. */
    msRestantes: number;
    /** Quantos blocos a tarefa QUERIA por chamada. */
    blocosDesejados: number;
}): { pode: boolean; blocosPorChamada: number | null; porque: string } {
    if (e.requisicoesRestantes <= 0) {
        return {
            pode: false, blocosPorChamada: null,
            porque: 'o orçamento de requisições da tarefa acabou: disponibilidade de RPC não '
                + 'devolve orçamento, e varrer aqui seria gastar o que o monitoramento precisa',
        };
    }
    if (e.msRestantes <= 0) {
        return {
            pode: false, blocosPorChamada: null,
            porque: 'o orçamento de tempo da tarefa acabou',
        };
    }
    if (!e.veredicto.podeVarrer) {
        // DESCONHECIDO nao libera varredura — libera sondagem, e e o chamador
        // que decide sondar. E a condicao que ela pos.
        return {
            pode: false,
            blocosPorChamada: e.veredicto.podeSondar ? BLOCOS_DE_UMA_SONDAGEM : null,
            porque: e.veredicto.podeSondar
                ? `${e.veredicto.estado}: NÃO autorizo varredura, só sondagem de `
                    + `${BLOCOS_DE_UMA_SONDAGEM} bloco(s) — ${e.veredicto.porque}`
                : `${e.veredicto.estado}: nem sondagem — ${e.veredicto.porque}`,
        };
    }
    // O TETO SAI DA MEDICAO. Sem teto medido, sonda-se: pedir 10.000 porque
    // 10.000 passou uma vez e generalizar uma consulta para todas.
    if (e.veredicto.limiteConhecido === null) {
        return {
            pode: false, blocosPorChamada: BLOCOS_DE_UMA_SONDAGEM,
            porque: 'disponível, mas o teto de blocos não está MEDIDO: sondo antes de varrer, '
                + 'porque uma consulta que passou não prova que todas as desse tamanho passam',
        };
    }
    const blocos = Math.min(e.blocosDesejados, e.veredicto.limiteConhecido);
    return {
        pode: true, blocosPorChamada: blocos,
        porque: `disponível com prova de ${Math.round((e.veredicto.idadeDaProvaMs ?? 0) / 1000)}s e `
            + `teto medido de ${e.veredicto.limiteConhecido}: varro em janelas de ${blocos}, com `
            + `${e.requisicoesRestantes} requisição(ões) e ${Math.round(e.msRestantes / 1000)}s de orçamento`,
    };
}
