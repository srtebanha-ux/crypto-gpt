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
export function wsDoHttp(url: string): string | null {
    const limpo = url.trim();
    if (limpo.startsWith('wss://') || limpo.startsWith('ws://')) return limpo;
    if (limpo.startsWith('https://')) return `wss://${limpo.slice('https://'.length)}`;
    if (limpo.startsWith('http://')) return `ws://${limpo.slice('http://'.length)}`;
    return null;
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
                this.esperaMs = 1000;
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
            const cair = () => {
                if (jaCaiu || this.ws !== ws) return;
                jaCaiu = true;
                this.vivo = false;
                this.pararBatimento();
                this.aoAviso?.('conexão de blocos caiu; volto a perguntar enquanto reconecto');
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
        const espera = this.esperaMs;
        // Dobrar ate um teto: reconectar em laco apertado contra um provedor
        // fora do ar so gera mais falha.
        this.esperaMs = Math.min(this.esperaMs * 2, 30_000);
        setTimeout(() => this.abrir(), espera).unref?.();
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
