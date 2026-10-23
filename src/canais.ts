/**
 * OS CANAIS, e por que eles nao podem compartilhar uma politica.
 *
 * MEDIDO no log do Railway de 2026-10-14, no commit `be6c4fd`:
 *
 *     1. Alchemy respondeu 429 por capacidade mensal esgotada
 *     2. a escada migrou para mainnet.base.org
 *     3. `[MORPHO] NAO vou varrer os mercados agora, e o motivo e orcamento`
 *     4. a rotina do Morpho foi adiada
 *     5. NENHUMA execucao de `[MORPHO/API]`
 *     6. os `eth_call` continuaram funcionando pelos provedores alternativos
 *
 * A dona do bot leu isso e disse a frase que da nome a este arquivo: *"voce
 * criou uma alternativa ao eth_getLogs, mas manteve essa alternativa
 * subordinada ao bloqueio do caminho antigo"*. Ela esta certa, e a causa e
 * estrutural, nao de estrategia: os dois caminhos do Morpho moravam numa
 * cadeia `if / else if`, entao o ramo do caminho ANTIGO — que casa quando a
 * capacidade de RPC acaba — impedia que o ramo do caminho NOVO fosse ao menos
 * AVALIADO.
 *
 * E o defeito de fundo e mais fundo que a cadeia: o tipo `Tarefa` de
 * `capacidade.ts` mistura coisas que tem disponibilidades DIFERENTES. `morpho`
 * era uma tarefa so, quando na verdade sao dois canais que nao se parecem:
 * uma consulta HTTP a `api.morpho.org`, que nao gasta CU de RPC nenhum, e uma
 * varredura de `eth_getLogs`, que gasta o mais caro de todos.
 *
 * Entao a disponibilidade passa a ser decidida por CANAL, num lugar so, e a
 * regra que importa esta escrita como teste: **a falha de um provedor de RPC
 * nao pode bloquear uma consulta HTTP independente.**
 *
 * O que este arquivo NAO faz, de proposito: ele nao mede orcamento nem conta
 * requisicao. Quem limita consumo e `OrcamentoDaTarefa` e `ControleDeCapacidade`
 * em `capacidade.ts`, que ja existem e ja sao testados. Juntar as duas coisas
 * aqui seria sincronizar na mao uma conta que ja tem dono — a REGRA 3 deste
 * projeto, que ja me pegou sete vezes.
 */

/**
 * Os CANAIS, separados por DISPONIBILIDADE e nao por assunto.
 *
 * Dois canais sao canais diferentes quando a mesma falha deixa um de pe e
 * derruba o outro. E o caso de todos estes:
 *
 *     apiHttp       `api.morpho.org`. HTTP publico. NAO consome RPC, nao tem
 *                   cota de CU, e nao sabe o que e `eth_getLogs`
 *     rpcLeitura    `eth_call` / `eth_getCode` / `eth_blockNumber`. Observado
 *                   no log dela funcionando pelos alternativos com a Alchemy
 *                   esgotada
 *     rpcEventos    `eth_getLogs`. O mais caro, e o unico que esta recusado
 *                   nos quatro degraus
 *     monitoramento o laco quente. Nunca pausa: e o unico que precisa estar
 *                   vivo no instante do alvo
 *     validacao     os `eth_call` que confirmam candidato. Mesmo transporte
 *                   que `rpcLeitura`, mas prioridade menor que o monitoramento
 */
export type Canal = 'apiHttp' | 'rpcLeitura' | 'rpcEventos' | 'monitoramento' | 'validacao';

export const CANAIS: readonly Canal[] = [
    'apiHttp', 'rpcLeitura', 'rpcEventos', 'monitoramento', 'validacao',
];

/** O que se sabe da infraestrutura agora. Fatos observados, nao suposicao. */
export interface EstadoDaInfra {
    /** Provedores com capacidade CONFIRMADA esgotada (`ControleDeCapacidade`). */
    provedoresEsgotados: readonly string[];
    /** Estou num provedor de reserva, e nao no primario. */
    noFallback: boolean;
    /**
     * `eth_getLogs` recusado em TODOS os degraus que foram tentados.
     *
     * Separado de `provedoresEsgotados` porque a disponibilidade e POR METODO:
     * este arquivo ja registra que `eth_getBalance` passar nao diz nada sobre
     * `eth_getLogs`. Ausente e DESCONHECIDO, nao "disponivel".
     */
    eventosRecusados?: boolean;
}

export interface Disponibilidade {
    /** Pode rodar AGORA. */
    pode: boolean;
    /**
     * Pode rodar, mas com menos folga do que o normal — o chamador deve
     * apertar o proprio teto. `pode: true` com `degradado: true` NAO e
     * autorizacao para gastar o mesmo que no primario.
     */
    degradado: boolean;
    porque: string;
}

/**
 * A disponibilidade de UM canal, dado o que se observou da infraestrutura.
 *
 * A linha que este arquivo existe para garantir e a primeira: **`apiHttp` nao
 * le nenhum campo de RPC.** Nao e esquecimento — e a correcao. Um teste varre
 * todas as combinacoes de estado de RPC e exige `pode: true` em todas, porque
 * foi exatamente a ausencia dessa garantia que fez a descoberta nao executar
 * no Railway.
 */
export function disponibilidadeDoCanal(canal: Canal, e: EstadoDaInfra): Disponibilidade {
    const esgotado = e.provedoresEsgotados.length > 0;

    switch (canal) {
        case 'apiHttp':
            // NAO LE `e`. De proposito, e e esta a correcao do incidente.
            return {
                pode: true,
                degradado: false,
                porque: 'é HTTP para api.morpho.org: não consome CU de RPC, não usa eth_getLogs e '
                    + 'não depende de nenhum provedor da escada. Quem limita este canal é o '
                    + 'orçamento dele (requisições, timeout, cancelamento), nunca o estado do RPC',
            };

        case 'monitoramento':
            return {
                pode: true,
                degradado: esgotado || e.noFallback,
                porque: esgotado || e.noFallback
                    ? 'é o único que precisa estar vivo no instante do alvo: não pausa, mas é o '
                        + 'que fica com o que sobrar de cota'
                    : 'primário saudável',
            };

        case 'rpcEventos':
            // `eth_getLogs` e o unico caminho que de fato esta fechado. Aqui
            // pausar e certo — e e por isso que ele tem de ser um canal
            // SEPARADO, para pausar sozinho.
            if (e.eventosRecusados === true) {
                return {
                    pode: false,
                    degradado: false,
                    porque: 'eth_getLogs foi recusado em todos os degraus tentados. Não é "não há '
                        + 'eventos": é "não consigo lê-los". Quem responde esta pergunta agora é '
                        + 'o canal apiHttp',
                };
            }
            if (esgotado || e.noFallback) {
                return {
                    pode: false,
                    degradado: false,
                    porque: esgotado
                        ? 'é o método mais caro e há provedor com capacidade esgotada: o que sobra '
                            + 'de cota fica com o monitoramento'
                        : 'estou no provedor de reserva, e eth_getLogs sobrecarrega o fallback',
                };
            }
            return { pode: true, degradado: false, porque: 'primário saudável' };

        case 'rpcLeitura':
        case 'validacao':
            // OBSERVADO no log dela: com a Alchemy esgotada, os `eth_call`
            // continuaram respondendo pelos alternativos. Entao este canal
            // DEGRADA — nao para. Parar aqui seria desligar a validacao da
            // corrente, que e justamente o que autoriza um candidato.
            return {
                pode: true,
                degradado: esgotado || e.noFallback,
                porque: esgotado || e.noFallback
                    ? 'eth_call continua respondendo pelos provedores alternativos (observado no '
                        + 'log de 2026-10-14 com a Alchemy esgotada), então este canal DEGRADA em '
                        + 'vez de parar: aperte o próprio teto, mas não desligue a validação'
                    : 'primário saudável',
            };
    }
}

/**
 * A frase do log: quais canais estao de pe e quais nao, e por que.
 *
 * Existe porque o incidente foi INVISIVEL: a linha `[MORPHO]` falava de
 * orcamento e nao havia uma linha dizendo que o canal HTTP estava livre. Nao
 * dizer e indistinguivel de nao poder.
 */
export function comoLerOsCanais(e: EstadoDaInfra): string {
    const partes = CANAIS.map((c) => {
        const d = disponibilidadeDoCanal(c, e);
        const estado = !d.pode ? 'PAUSADO' : d.degradado ? 'degradado' : 'livre';
        return `${c}: ${estado}`;
    });
    return `${partes.join(' | ')}`
        + ` — e o apiHttp NÃO depende do estado do RPC: foi essa subordinação que impediu a`
        + ` descoberta de executar em 2026-10-14`;
}

/**
 * ORCAMENTO DE UMA CONSULTA HTTP: requisicoes, tempo e CANCELAMENTO.
 *
 * Ela pediu *"orcamento proprio, timeout, cancelamento, controle de
 * concorrencia e tratamento de falhas"* — e os quatro sao coisas diferentes,
 * entao moram em campos diferentes.
 *
 * O cancelamento e um `AbortSignal` de verdade e nao um booleano meu: o
 * transporte tem de PARAR, e nao so ser ignorado quando voltar. Um `fetch` que
 * continua pendurado depois de o orcamento acabar e exatamente o defeito que
 * este projeto mediu em `cotacoesDaBinance`, onde a perna que nunca respondia
 * ficava fora do teto e segurava a volta inteira.
 */
export class OrcamentoHttp {
    private requisicoes = 0;
    private readonly comecouEm: number;
    private readonly controle = new AbortController();
    private encerradoPor: string | null = null;

    constructor(
        readonly tetoDeRequisicoes: number,
        readonly tetoDeMs: number,
        private readonly agora: () => number = () => Date.now(),
    ) {
        this.comecouEm = this.agora();
        const timer=setTimeout(()=>this.encerrar(`teto de ${this.tetoDeMs}ms`),Math.max(0,tetoDeMs));
        timer.unref?.();
        this.controle.signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
    }

    /** O sinal que o transporte tem de respeitar. */
    get sinal(): AbortSignal { return this.controle.signal; }

    decorridoMs(): number { return this.agora() - this.comecouEm; }

    /**
     * Pede uma requisicao. Devolve `false` quando o orcamento acabou — e aí
     * TAMBEM cancela o sinal, para o que estiver em voo parar.
     */
    pedir(): boolean {
        if (this.encerradoPor !== null) return false;
        if (this.requisicoes >= this.tetoDeRequisicoes) {
            this.encerrar(`teto de ${this.tetoDeRequisicoes} requisições`);
            return false;
        }
        if (this.decorridoMs() >= this.tetoDeMs) {
            this.encerrar(`teto de ${this.tetoDeMs}ms`);
            return false;
        }
        this.requisicoes += 1;
        return true;
    }

    encerrar(motivo: string): void {
        if (this.encerradoPor !== null) return;
        this.encerradoPor = motivo;
        // Cancelar DE VERDADE. Ver a docstring da classe.
        try { this.controle.abort(); } catch { /* ambiente sem abort: segue */ }
    }

    get gastas(): number { return this.requisicoes; }
    get encerrado(): string | null { return this.encerradoPor; }

    comoLer(): string {
        return `${this.requisicoes} de ${this.tetoDeRequisicoes} requisições em `
            + `${this.decorridoMs()}ms de ${this.tetoDeMs}ms`
            + (this.encerradoPor === null ? '' : ` — ENCERRADO: ${this.encerradoPor}`);
    }
}

/**
 * O DESFECHO de uma descoberta, com as quatro situacoes SEPARADAS.
 *
 * Ela pediu: *"Diferencie 'a tarefa nao executou', 'a API falhou', 'a API
 * retornou vazio' e 'os mercados nao passaram na validacao'. Nenhuma dessas
 * situacoes pode ser silenciosa."*
 *
 * As quatro pedem acoes OPOSTAS, e e por isso que colapsa-las e defeito e nao
 * economia de linha:
 *
 *     naoExecutou         -> conserte o agendamento (foi o incidente de hoje)
 *     apiFalhou           -> olhe o status HTTP; talvez espere
 *     apiVaziaDeVerdade   -> a pergunta foi respondida: nao ha mercado na faixa
 *     validacaoRecusou    -> olhe os campos divergentes; e dado, nao falha
 *     rpcIndisponivel     -> guarde NAO CONFIRMADO e valide depois
 */
export type DesfechoDaDescoberta =
    | 'naoExecutou'
    | 'apiFalhou'
    | 'erroDeSchema'
    | 'apiVaziaDeVerdade'
    | 'foraDaFaixa'
    | 'validacaoRecusou'
    | 'rpcIndisponivel'
    | 'confirmou';

export function comoLerODesfecho(d: DesfechoDaDescoberta): string {
    switch (d) {
        case 'naoExecutou':
            return 'A TAREFA NÃO EXECUTOU. Nenhuma requisição HTTP foi iniciada. Isto não diz '
                + 'nada sobre a API nem sobre os mercados: é agendamento';
        case 'apiFalhou':
            return 'A API FALHOU: a requisição saiu e a resposta não serviu (status, corpo ou '
                + 'transporte). Isto NÃO é "não há mercados"';
        case 'erroDeSchema':
            // O DESFECHO QUE FALTAVA, e e ele que explica o log de 2026-10-14:
            // HTTP 200 e zero mercados. Sem este estado, "nao entendi a
            // resposta" e "nao ha mercado" produziam a mesma linha.
            return 'ERRO DE SCHEMA: a API respondeu HTTP 200 e eu NÃO soube ler o corpo. Isto NÃO '
                + 'é "a Base não tem mercados Morpho" e NÃO é falha de rede: é contrato de dados. '
                + 'O conserto é o parser, e a frase ao lado nomeia as chaves que chegaram';
        case 'apiVaziaDeVerdade':
            return 'A API RESPONDEU VAZIO: status 200, corpo no formato esperado e ZERO elementos '
                + 'na lista. Esta é uma RESPOSTA, não uma falha — e só pode ser dita depois de o '
                + 'formato ter sido reconhecido';
        case 'foraDaFaixa':
            return 'A API ENUMEROU e NENHUM mercado ficou na faixa de LLTV ≤ 77%: os mercados '
                + 'existem, e o filtro é que não selecionou nenhum. É escolha nossa, não ausência '
                + 'de dado';
        case 'validacaoRecusou':
            return 'A API ENUMEROU e a CORRENTE RECUSOU todos: os campos divergiram. É dado, não '
                + 'falha — e nenhum deles pode decidir transação';
        case 'rpcIndisponivel':
            return 'A API ENUMEROU e o RPC não pôde confirmar: os mercados ficam guardados como '
                + 'NÃO CONFIRMADOS e a validação roda na próxima volta. Não confirmado não é alvo';
        case 'confirmou':
            return 'A API enumerou e a CORRENTE confirmou: há mercado validado on-chain';
    }
}
