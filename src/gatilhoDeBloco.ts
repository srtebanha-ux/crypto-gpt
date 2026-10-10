// Arquivo: src/gatilhoDeBloco.ts
//
// Ser AVISADO do bloco novo, em vez de ficar perguntando.
//
// Perguntar a cada 200ms tem dois custos. O obvio e Unidades de Computacao. O
// que importa e o atraso: um bloco que nasce logo depois da pergunta so e visto
// na pergunta seguinte, e nessa corrida 200ms e a diferenca entre chegar no
// bloco N+1 e no N+2.
//
// Uma assinatura `newHeads` avisa no instante em que o bloco e produzido. O
// atraso vira o da rede, e nao o do relogio.
//
// Isto e acelerador, nao motor: se o WebSocket cair, o bot volta a perguntar e
// continua cacando. Por isso nada aqui lanca para cima.

/**
 * O endereco WebSocket do mesmo provedor.
 *
 * `null` quando nao da para derivar — e `null` e uma resposta, nao uma falha:
 * o bot segue perguntando. Chutar um endereco aqui faria o bot tentar conectar
 * num lugar que nao existe e reclamar para sempre.
 */
import { sanitizar } from './capacidade';

export function wsDoHttp(url: string): string | null {
    const limpo = url.trim();
    if (limpo.startsWith('wss://') || limpo.startsWith('ws://')) return limpo;
    if (limpo.startsWith('https://')) return `wss://${limpo.slice('https://'.length)}`;
    if (limpo.startsWith('http://')) return `ws://${limpo.slice('http://'.length)}`;
    return null;
}

/**
 * De onde o endereco de WebSocket DEVE vir — e a derivacao nao e resposta.
 *
 * Ela mandou: *"Não derive um endpoint WebSocket do HTTP por suposição.
 * Confirme endpoint, caminho, autenticação e suporte ao serviço."*
 *
 * E o log de 2026-10-10 mostra por que: o bot estava no SEGUNDARIO
 * (`mainnet.base.org`), `wsDoHttp` derivou `wss://mainnet.base.org`, e aquele
 * endpoint publico **nao oferece WebSocket** — medido aqui em 2026-10-10, o
 * proxy devolve 405 e a biblioteca diz *"Received network error or non-101
 * status code."*. Ou seja: a reconexao a cada 30s era contra um servico que nao
 * existe naquele host, e o log culpava a rede.
 *
 * Entao a derivacao deixa de ser automatica:
 *
 *   `CACA_WS_URL` definida  -> e ela, declarada pela dona, com caminho e
 *                              credencial que ela escolheu
 *   `CACA_WS_DERIVAR=1`     -> deriva do HTTP, e a frase DIZ que e suposicao
 *   nenhuma das duas        -> NAO conecta, e diz que nao conecta
 *
 * Nao conectar nao cega o bot: ele volta a perguntar por HTTP, que e o que ele
 * ja estava fazendo com a conexao caida — menos as tentativas inuteis.
 */
export function enderecoDeBlocos(
    rpcHttp: string,
    env: { CACA_WS_URL?: string; CACA_WS_DERIVAR?: string } = process.env,
): { url: string | null; origem: 'declarada' | 'derivada' | 'ausente'; porque: string } {
    const declarada = env.CACA_WS_URL?.trim();
    if (declarada !== undefined && declarada !== '') {
        if (!declarada.startsWith('wss://') && !declarada.startsWith('ws://')) {
            return {
                url: null, origem: 'ausente',
                porque: 'CACA_WS_URL está definida e NÃO começa com wss:// nem ws:// — '
                    + 'configuração INVÁLIDA, e isto não é bloqueio nem falha de rede. '
                    + 'Não tento conectar; sigo perguntando por HTTP',
            };
        }
        return {
            url: declarada, origem: 'declarada',
            porque: 'endereço DECLARADO em CACA_WS_URL: caminho e credencial são os que você pôs',
        };
    }
    if (env.CACA_WS_DERIVAR === '1') {
        const d = wsDoHttp(rpcHttp);
        return d === null
            ? { url: null, origem: 'ausente', porque: `não sei derivar WebSocket de "${rpcHttp}"` }
            : {
                url: d, origem: 'derivada',
                porque: 'DERIVADO do endereço HTTP por CACA_WS_DERIVAR=1 — é SUPOSIÇÃO: o provedor '
                    + 'pode não oferecer WebSocket neste host, e foi exatamente isso que aconteceu '
                    + 'com mainnet.base.org em 2026-10-10',
            };
    }
    return {
        url: null, origem: 'ausente',
        porque: 'nenhum endereço de WebSocket configurado (CACA_WS_URL vazia e CACA_WS_DERIVAR != 1). '
            + 'NÃO tento conectar — derivar do HTTP seria supor que o provedor oferece o serviço. '
            + 'Sigo perguntando por HTTP, que é o que o bot já fazia com a conexão caída',
    };
}

/**
 * O ping. `net_version` em vez de um frame de ping do protocolo porque o
 * `WebSocket` global do Node nao expoe `ping()` — e uma chamada JSON-RPC barata
 * serve ao mesmo proposito: obriga o provedor a responder, e a resposta e o que
 * realimenta o cao de guarda.
 */
export function pedidoDePing(id = 99): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method: 'net_version', params: [] });
}

/** O pedido de assinatura, no formato JSON-RPC. */
export function pedidoDeAssinatura(id = 1): string {
    return JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['newHeads'] });
}

/**
 * Le o numero do bloco de uma mensagem do WebSocket.
 *
 * Devolve `null` para tudo que nao for um aviso de bloco novo — inclusive a
 * confirmacao da propria assinatura, que chega primeiro e nao e um bloco.
 * Confundir as duas faria o bot "acordar" uma vez sem motivo.
 */
export function blocoDaMensagem(texto: string): number | null {
    try {
        const m = JSON.parse(texto) as {
            method?: string;
            params?: { result?: { number?: string } };
        };
        if (m.method !== 'eth_subscription') return null;
        const n = m.params?.result?.number;
        if (typeof n !== 'string') return null;
        const bloco = Number.parseInt(n, 16);
        return Number.isFinite(bloco) && bloco > 0 ? bloco : null;
    } catch {
        return null;
    }
}

/**
 * Uma espera que termina no bloco novo OU no tempo, o que vier primeiro.
 *
 * O tempo existe para o bot nunca ficar preso esperando um aviso que nao vem:
 * WebSocket que caiu em silencio e indistinguivel de rede parada, e ficar
 * pendurado seria pior que perguntar.
 */
export function esperarBlocoOuTempo(
    assinar: (aoBloco: (n: number) => void) => () => void,
    tempoMaximoMs: number,
    agendar: (fn: () => void, ms: number) => unknown,
    cancelar: (id: unknown) => void,
): Promise<'bloco' | 'tempo'> {
    return new Promise((resolve) => {
        let pronto = false;
        // `relogio` e `desassinar` sao declarados ANTES de `terminar` usar:
        // `assinar` pode chamar de volta na hora, e ai `terminar` rodaria com
        // as duas ainda na zona morta — a Promise rejeitava e derrubava o
        // caçador, porque a chamada vive num `finally`, fora do try.
        let relogio: unknown = null;
        let desassinar: (() => void) | null = null;
        const terminar = (como: 'bloco' | 'tempo') => {
            if (pronto) return;
            pronto = true;
            if (relogio !== null) cancelar(relogio);
            desassinar?.();
            resolve(como);
        };
        desassinar = assinar(() => terminar('bloco'));
        if (pronto) return;
        relogio = agendar(() => terminar('tempo'), tempoMaximoMs);
    });
}

/**
 * Ouve blocos novos por WebSocket, e se vira sozinho quando a conexao cai.
 *
 * Tudo aqui e defensivo de proposito: e acelerador, nao motor. Conexao que nao
 * abre, cai ou emudece nao pode derrubar a cacada — o bot volta a perguntar e
 * continua. Por isso nada lanca, e `vivo` existe para o log poder dizer em qual
 * dos dois modos ele esta, em vez de o silencio parecer sucesso.
 */
/**
 * Quanto silencio delata conexao morta.
 *
 * A Base produz um bloco a cada 2 segundos. Quinze segundos sem aviso nao e
 * mercado calmo — bloco nasce mesmo sem ninguem negociar. E ambiguidade zero,
 * que e o unico jeito de um relogio poder decidir sozinho.
 */
export const SILENCIO_QUE_MATA_MS = 15_000;

/** O teto do recuo quando a falha pode ter sido a rede piscando. */
export const TETO_TRANSITORIO_MS = 30_000;

/**
 * O teto do recuo quando a falha e PERSISTENTE.
 *
 * Dez minutos, nao trinta segundos. Um provedor que recusa a conexao — cota,
 * credencial, politica — vai recusar a proxima tambem, e cada tentativa custa
 * credito para receber a mesma porta fechada. O log dela mostrava a mesma linha
 * a cada 30s indefinidamente.
 */
export const TETO_PERSISTENTE_MS = 10 * 60_000;

export interface FalhaDeWs {
    /** 'recusada' = nunca abriu; 'caiu' = abriu e caiu depois. */
    status: 'recusada' | 'caiu';
    /** O codigo de fechamento do WebSocket. `null` quando o evento nao traz. */
    codigo: number | null;
    /** A razao/mensagem, SANITIZADA — a URL do provedor carrega a chave. */
    mensagem: string | null;
    /**
     * `true` quando repetir logo NAO deve ajudar.
     *
     * Decidido pelo CODIGO, nao pela prosa: 1008 (policy violation), 1011
     * (internal error do servidor), 4001-4999 (faixa de aplicacao, que e onde
     * provedor poe "nao autorizado" e "cota"), e 1002/1003 (erro de protocolo:
     * se o nosso frame esta errado, ele vai estar errado na proxima tambem).
     */
    persistente: boolean;
}

/** Os codigos de fechamento que nao melhoram repetindo logo. */
export const CODIGOS_PERSISTENTES = [1002, 1003, 1008, 1011] as const;

/**
 * Le o evento de `close`/`error` e devolve a causa.
 *
 * Tudo e opcional porque o evento VARIA: `error` muitas vezes nao traz codigo
 * nenhum, e o `close` de um proxy pode vir sem razao. Campo ausente sai `null`
 * — nunca zero, que seria um codigo de fechamento valido inventado.
 */
export function lerFalhaDeWs(ev: unknown, abriuAntes: boolean): FalhaDeWs {
    const e = (typeof ev === 'object' && ev !== null ? ev as Record<string, unknown> : {});
    const codigo = typeof e.code === 'number' && Number.isFinite(e.code) ? e.code : null;
    const cru = typeof e.reason === 'string' && e.reason !== ''
        ? e.reason
        : typeof e.message === 'string' && e.message !== '' ? e.message : null;
    const persistente = codigo !== null
        && (CODIGOS_PERSISTENTES.includes(codigo as 1008) || (codigo >= 4000 && codigo <= 4999));
    return {
        status: abriuAntes ? 'caiu' : 'recusada',
        codigo,
        mensagem: cru === null ? null : sanitizar(cru),
        // Uma conexao que NUNCA abriu e, por si, mais suspeita que uma que
        // caiu — mas sem codigo nao da para afirmar bloqueio, e tratar
        // ausencia como bloqueio deixaria o bot sem aviso de bloco por 10 min
        // por causa de um soluco. Entao: so o codigo decide.
        persistente,
    };
}

/** A frase do aviso. Diz o que se sabe e o que NAO se sabe. */
export function comoLerAFalhaDeWs(f: FalhaDeWs): string {
    const partes = [
        f.status === 'recusada'
            ? 'conexão de blocos RECUSADA (nunca abriu)'
            : 'conexão de blocos CAIU (estava aberta)',
        f.codigo === null ? 'código de fechamento: NÃO informado pelo evento' : `código ${f.codigo}`,
        f.mensagem === null ? 'sem mensagem' : `"${f.mensagem}"`,
        f.persistente
            ? `tratando como PERSISTENTE pelo código: recuo até ${TETO_PERSISTENTE_MS / 60_000} min, `
              + 'porque repetir contra uma porta fechada gasta crédito sem mudar nada'
            : `tratando como transitória: recuo até ${TETO_TRANSITORIO_MS / 1000}s`,
        'enquanto isso, volto a perguntar por HTTP',
    ];
    return partes.join(' | ');
}

/**
 * De quanto em quanto tempo bater o ping.
 *
 * 7,5 s, metade do silencio — o padrao que a QuickNode documenta para WSS
 * (`PING` a cada 7,5 s, `EXPECTED_PONG_BACK` de 15 s), e que ela pediu
 * explicitamente. Dois pings perdidos derrubam a conexao: um sozinho pode ser
 * soluco de rede, dois seguidos nao.
 *
 * A primeira versao batia a cada `silencioMs / 3` (5 s), o que dava tres
 * chances. Duas bastam e gastam menos: com 2 s por bloco da Base, 15 s de
 * silencio sao ~7 blocos perdidos, e esse ja e um prejuizo que nao vale
 * esticar.
 */
export const PING_A_CADA_MS = 7_500;

/**
 * O batimento que faltava, e o defeito que ele conserta.
 *
 * `close` e `error` so chegam quando a queda e LIMPA. Um socket meio-aberto —
 * timeout de idle da Railway, NAT que esquece a conexao, provedor que para de
 * empurrar sem fechar o TCP — nao dispara nenhum dos dois. O que acontecia:
 * `vivo` ficava `true` para sempre, `esperarBlocoOuTempo` esperava os 2.500ms
 * inteiros a cada ciclo porque o aviso nunca vinha, e o log continuava
 * imprimindo `avisoDeBloco: ligado (último 51954999)` com um numero congelado.
 *
 * Degradacao silenciosa que se parece com saude: exatamente a "ausencia com
 * cara de resposta" que este projeto persegue, no acelerador.
 *
 * O conserto tem as duas metades, e uma sozinha nao conserta nada:
 *
 *   1. um `ping` periodico, para dar ao provedor motivo de responder;
 *   2. um CAO DE GUARDA no ultimo aviso recebido — porque `ping` sem resposta
 *      tambem e silencioso, e e o silencio que precisa derrubar a conexao.
 *
 * `ultimoBloco` congelado e a prova, e o log passa a dizer HA QUANTO TEMPO foi
 * o ultimo aviso, em vez de so o numero.
 */
export class OuvinteDeBlocos {
    private ws: WebSocket | null = null;
    private ouvintes = new Set<(n: number) => void>();
    private fechado = false;
    private esperaMs = 1000;
    private batimento: ReturnType<typeof setInterval> | null = null;
    /** O ultimo bloco anunciado. Serve para o log provar que chega aviso. */
    public ultimoBloco = 0;
    /** `Date.now()` do ultimo aviso. `0` = nenhum ainda nesta conexao. */
    public ultimoAvisoEm = 0;
    /** Quantas vezes o cao de guarda derrubou a conexao. Vai para o log. */
    public quedasPorSilencio = 0;
    public vivo = false;
    /** A ultima falha, com codigo e mensagem SANITIZADA. `null` = nenhuma. */
    public ultimaFalha: FalhaDeWs | null = null;
    /** Se a conexao chegou a ABRIR antes de cair. Separa recusa de queda. */
    private vivoAntes = false;
    /** Quantas falhas PERSISTENTES seguidas. Decide o recuo longo. */
    public falhasPersistentes = 0;

    constructor(
        private readonly url: string,
        private readonly aoAviso?: (texto: string) => void,
        /** Injetaveis para o teste poder correr o relogio sem esperar 15s. */
        private readonly silencioMs = SILENCIO_QUE_MATA_MS,
        private readonly agora: () => number = () => Date.now(),
        private readonly pingMs = PING_A_CADA_MS,
    ) {}

    /** Ha quanto tempo nao chega aviso. `null` quando nenhum chegou ainda. */
    public msSemAviso(): number | null {
        return this.ultimoAvisoEm === 0 ? null : this.agora() - this.ultimoAvisoEm;
    }

    /**
     * Uma batida do cao de guarda. Publica para o teste chamar direto.
     *
     * Devolve `true` quando derrubou a conexao. O relogio comeca a contar da
     * ABERTURA, nao do primeiro bloco: um socket que abre e nunca fala e
     * exatamente o caso que o `close` nao pega.
     */
    public baterUmaVez(): boolean {
        if (this.fechado || !this.vivo) return false;
        try { this.ws?.send(pedidoDePing()); } catch { /* o silencio decide, nao o envio */ }
        const parado = this.msSemAviso();
        if (parado === null || parado < this.silencioMs) return false;
        this.quedasPorSilencio += 1;
        this.aoAviso?.(`sem aviso de bloco há ${(parado / 1000).toFixed(1)}s — derrubando e reconectando`);
        this.vivo = false;
        const morto = this.ws;
        this.ws = null;
        try { morto?.close(); } catch { /* ja estava morto */ }
        this.pararBatimento();
        this.reconectar();
        return true;
    }

    private comecarBatimento(): void {
        this.pararBatimento();
        // 7,5 s: o padrao da QuickNode. Duas batidas perdidas derrubam.
        const t = setInterval(() => { this.baterUmaVez(); }, this.pingMs);
        t.unref?.();
        this.batimento = t;
    }

    private pararBatimento(): void {
        if (this.batimento !== null) { clearInterval(this.batimento); this.batimento = null; }
    }

    public abrir(): void {
        if (this.fechado) return;
        try {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            ws.addEventListener('open', () => {
                this.vivo = true;
                this.vivoAntes = true;
                this.esperaMs = 1000;
                this.falhasPersistentes = 0;
                // O relogio do cao de guarda comeca AQUI, e nao no primeiro
                // bloco: um socket que abre e nunca fala e justamente o caso
                // que `close` nao pega. Sem isto `msSemAviso()` seria `null`
                // para sempre e o cao nunca latiria.
                this.ultimoAvisoEm = this.agora();
                try { ws.send(pedidoDeAssinatura()); } catch { /* a reconexao resolve */ }
                this.comecarBatimento();
            });
            ws.addEventListener('message', (ev: MessageEvent) => {
                const bloco = blocoDaMensagem(typeof ev.data === 'string' ? ev.data : String(ev.data));
                // QUALQUER mensagem prova que a conexao esta viva, inclusive o
                // pong e a confirmacao da assinatura. Marcar so no bloco novo
                // faria o cao derrubar uma conexao saudavel num vale de blocos.
                this.ultimoAvisoEm = this.agora();
                if (bloco === null || bloco <= this.ultimoBloco) return;
                this.ultimoBloco = bloco;
                for (const f of [...this.ouvintes]) {
                    try { f(bloco); } catch { /* um ouvinte ruim nao cala os outros */ }
                }
            });
            // 'close' e 'error' chegam os DOIS na mesma falha. Sem esta
            // trava, uma queda gerava dois avisos e tres sockets, e a
            // contagem dobrava a cada rodada — o backoff virava enfeite.
            let jaCaiu = false;
            const cair = (ev?: unknown) => {
                if (jaCaiu || this.ws !== ws) return;
                jaCaiu = true;
                this.vivo = false;
                this.pararBatimento();
                // A CAUSA, e nao so o fato. Ela mandou: *"Capture separadamente
                // a causa da falha do WebSocket: status de conexão, código de
                // fechamento e mensagem sanitizada."*
                //
                // A versao anterior recebia o evento e o DESCARTAVA: a frase era
                // uma literal, e o `code` do `close` — a unica coisa que
                // distingue "a rede piscou" de "este provedor nao vai me
                // aceitar" — ia para o lixo. Sem ele, reconectar a cada 30s
                // contra um 1008 de cota era um laco infinito contra uma porta
                // fechada.
                this.ultimaFalha = lerFalhaDeWs(ev, this.vivoAntes);
                this.aoAviso?.(comoLerAFalhaDeWs(this.ultimaFalha));
                this.reconectar();
            };
            ws.addEventListener('close', cair);
            ws.addEventListener('error', cair);
        } catch {
            this.vivo = false;
            this.reconectar();
        }
    }

    private reconectar(): void {
        if (this.fechado) return;
        // TRANSITORIA contra PERSISTENTE, e os tetos sao diferentes.
        //
        // O log dela mostrava `[BLOCOS] conexão de blocos caiu` repetido a cada
        // 30 segundos, para sempre, com a MESMA causa. Trinta segundos e o teto
        // certo para a rede ter piscado, e o teto errado para um provedor que
        // recusa a conexao: ali cada tentativa gasta credito para receber a
        // mesma porta fechada.
        const persistente = this.ultimaFalha?.persistente === true;
        if (persistente) this.falhasPersistentes += 1;
        const teto = persistente ? TETO_PERSISTENTE_MS : TETO_TRANSITORIO_MS;
        const espera = Math.min(this.esperaMs, teto);
        this.esperaMs = Math.min(this.esperaMs * 2, teto);
        setTimeout(() => this.abrir(), espera).unref?.();
    }

    /** O que o log do ciclo publica sobre o aviso de bloco. */
    public diagnostico(): {
        ligado: boolean; ultimoBloco: number; msSemAviso: number | null;
        quedasPorSilencio: number; falhasPersistentes: number; ultimaFalha: string;
    } {
        return {
            ligado: this.vivo,
            ultimoBloco: this.ultimoBloco,
            msSemAviso: this.msSemAviso(),
            quedasPorSilencio: this.quedasPorSilencio,
            falhasPersistentes: this.falhasPersistentes,
            ultimaFalha: this.ultimaFalha === null
                ? 'nenhuma falha registrada nesta execução'
                : comoLerAFalhaDeWs(this.ultimaFalha),
        };
    }

    /** Registra um ouvinte e devolve como tirar ele. */
    public assinar(aoBloco: (n: number) => void): () => void {
        this.ouvintes.add(aoBloco);
        return () => { this.ouvintes.delete(aoBloco); };
    }

    public fechar(): void {
        this.fechado = true;
        this.vivo = false;
        this.pararBatimento();
        try { this.ws?.close(); } catch { /* ja estava fechado */ }
    }
}

/**
 * O RESULTADO DA NEGOCIACAO HTTP, que a biblioteca de WebSocket nao conta.
 *
 * Ela pediu: *"capture o resultado da negociação HTTP quando a biblioteca
 * permitir, com status e mensagem sanitizada."* A biblioteca nao permite: o
 * `WebSocket` do Node entrega `"Received network error or non-101 status code."`
 * e o `code` do evento vem vazio — foi isso que o log de producao mostrou.
 *
 * O handshake, porem, e um GET comum com cabecalhos de upgrade. Entao a
 * negociacao da para fazer a mao com `https.request`, que ENTREGA o status:
 *
 *   101  o servico existe e aceitou: o problema e outro
 *   200  responde HTTP e IGNORA o upgrade: nao oferece WebSocket neste caminho
 *   401/403  autenticacao ou politica: configuracao, nao rede
 *   404  caminho errado
 *   405  nao permite o metodo nesse caminho (o que este sandbox devolve)
 *   429  limitacao temporaria
 *   erro de socket  nao chegou a haver negociacao: transitoria
 *
 * Isto NAO abre conexao de verdade e NAO assina nada: e uma chamada, para o
 * log poder dizer QUAL dos cinco e, em vez de "erro de rede".
 */
export interface NegociacaoDeWs {
    /** O status HTTP da negociacao. `null` = nem chegou a haver resposta. */
    status: number | null;
    /** A classe do problema, decidida pelo STATUS e nao pela prosa. */
    classe: 'aceita' | 'servicoAusente' | 'autenticacao' | 'caminho' | 'limitacao'
        | 'persistente' | 'transitoria';
    /** A mensagem, SANITIZADA. */
    mensagem: string;
}

/** Traduz o status da negociacao na classe, e a classe decide o que fazer. */
export function classificarNegociacao(status: number | null, erro?: string): NegociacaoDeWs {
    if (status === null) {
        return {
            status: null, classe: 'transitoria',
            mensagem: sanitizar(erro ?? 'não houve resposta HTTP: a negociação não aconteceu'),
        };
    }
    const classe: NegociacaoDeWs['classe'] = status === 101 ? 'aceita'
        : status === 401 || status === 403 ? 'autenticacao'
            : status === 404 ? 'caminho'
                : status === 405 || status === 200 || status === 426 ? 'servicoAusente'
                    : status === 429 ? 'limitacao'
                        : status >= 500 ? 'transitoria' : 'persistente';
    const porClasse: Record<NegociacaoDeWs['classe'], string> = {
        aceita: 'o serviço existe e aceitou o upgrade (101): se a conexão ainda cai, a causa é outra',
        servicoAusente: 'o host responde HTTP e NÃO faz upgrade neste caminho: este provedor não '
            + 'oferece WebSocket aqui. Reconectar não resolve — é configuração de endpoint',
        autenticacao: 'autenticação ou política recusou: é CONFIGURAÇÃO, não rede. A credencial do '
            + 'WebSocket pode ser outra que a do HTTP',
        caminho: 'caminho não encontrado: o endpoint existe mas a rota do WebSocket é outra',
        limitacao: 'limitação temporária na própria negociação: esperar faz sentido aqui',
        persistente: 'recusa que não melhora repetindo logo',
        transitoria: 'falha de transporte ou erro do servidor: pode ter sido a rede',
    };
    return { status, classe, mensagem: sanitizar(erro ?? porClasse[classe]) };
}

/**
 * Faz a negociacao de upgrade e devolve o status. UMA chamada, sem reconectar.
 *
 * `https.request` deixa mandar `Connection: Upgrade`, e emite `upgrade` quando o
 * servidor responde 101 e `response` quando ele responde qualquer outra coisa —
 * que e exatamente a informacao que faltava.
 */
export async function negociarWs(
    urlWs: string,
    tempoMaximoMs = 8_000,
): Promise<NegociacaoDeWs> {
    const alvo = urlWs.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
    const { request } = await import(alvo.startsWith('https://') ? 'https' : 'http');
    return await new Promise<NegociacaoDeWs>((resolve) => {
        let pronto = false;
        const fim = (n: NegociacaoDeWs) => { if (!pronto) { pronto = true; resolve(n); } };
        try {
            const req = request(alvo, {
                method: 'GET',
                headers: {
                    Connection: 'Upgrade',
                    Upgrade: 'websocket',
                    // Chave de 16 bytes em base64, como o protocolo pede. O
                    // valor nao importa para nos: so o status da resposta.
                    'Sec-WebSocket-Key': Buffer.from('coleta-de-blocos').toString('base64'),
                    'Sec-WebSocket-Version': '13',
                },
                timeout: tempoMaximoMs,
            });
            req.on('upgrade', (res: { statusCode?: number }, socket: { destroy(): void }) => {
                socket.destroy();
                fim(classificarNegociacao(res.statusCode ?? 101));
            });
            req.on('response', (res: { statusCode?: number; statusMessage?: string; destroy(): void }) => {
                res.destroy();
                fim(classificarNegociacao(res.statusCode ?? null,
                    `HTTP ${res.statusCode ?? '?'} ${res.statusMessage ?? ''}`.trim()));
            });
            req.on('timeout', () => { req.destroy(); fim(classificarNegociacao(null, 'a negociação não respondeu no tempo')); });
            req.on('error', (e: Error) => fim(classificarNegociacao(null, e.message)));
            req.end();
        } catch (e) {
            fim(classificarNegociacao(null, e instanceof Error ? e.message : String(e)));
        }
    });
}

/** A frase do log da negociacao. */
export function comoLerANegociacao(n: NegociacaoDeWs, url: string): string {
    let host = '…';
    try { host = new URL(url.replace(/^wss?:\/\//, 'https://')).host; } catch { /* host fica … */ }
    return `negociação de WebSocket com ${host}: `
        + `${n.status === null ? 'SEM resposta HTTP' : `HTTP ${n.status}`} — ${n.classe}. ${n.mensagem}`;
}
