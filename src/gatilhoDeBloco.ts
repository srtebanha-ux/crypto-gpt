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
export class OuvinteDeBlocos {
    private ws: WebSocket | null = null;
    private ouvintes = new Set<(n: number) => void>();
    private fechado = false;
    private esperaMs = 1000;
    /** O ultimo bloco anunciado. Serve para o log provar que chega aviso. */
    public ultimoBloco = 0;
    public vivo = false;

    constructor(private readonly url: string, private readonly aoAviso?: (texto: string) => void) {}

    public abrir(): void {
        if (this.fechado) return;
        try {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            ws.addEventListener('open', () => {
                this.vivo = true;
                this.esperaMs = 1000;
                try { ws.send(pedidoDeAssinatura()); } catch { /* a reconexao resolve */ }
            });
            ws.addEventListener('message', (ev: MessageEvent) => {
                const bloco = blocoDaMensagem(typeof ev.data === 'string' ? ev.data : String(ev.data));
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
        try { this.ws?.close(); } catch { /* ja estava fechado */ }
    }
}
