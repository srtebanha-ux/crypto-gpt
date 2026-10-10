// Arquivo: src/escadaDeRpc.ts
//
// REDUNDÂNCIA DE CEGUEIRA: quando um provedor morre, trocar de provedor.
//
// O bot JÁ tinha failover, e era pior que nenhum, porque dava a impressão de
// estar resolvido: a escolha do RPC acontecia UMA VEZ, no boot (o laço `for (const
// c of rpcs)` em `cacarAoVivo`). Depois disso `chamar()` insistia na MESMA url
// quatro vezes, dobrando a espera — 1s, 2s, 4s, 8s — e desistia. Se a Alchemy
// caísse às 3 da manhã, o bot passava a noite inteira falando com um nó morto,
// com a escada de failover escrita no arquivo e nunca alcançada.
//
// E é o pior momento possível para ficar cego: provedor sobrecarregado e crash de
// mercado são o MESMO evento. O minuto em que o RPC cai é o minuto em que as
// liquidações acontecem.
//
// A distinção que decide tudo aqui: nó MUDO não é a mesma coisa que nó que
// RESPONDEU "não". Timeout, DNS, 429, 503 são o provedor falhando — troca. Já
// `execution reverted` é resposta correta do nó sobre o nosso contrato, e trocar
// de provedor só repetiria o mesmo revert em outro lugar, gastando os
// milissegundos que decidem a liquidação. Confundir os dois transformaria a
// escada numa máquina de perder tempo em cima de uma resposta que já estava boa.

/**
 * A lista de provedores, em ordem de preferência, sem repetidos.
 *
 * Aceita os três nomes de propósito: `CACA_RPC_URL` é o que o Railway dela já
 * usa hoje e não pode quebrar; `RPC_URL_1..9` é o que ela pediu; `CACA_RPC_URLS`
 * separado por vírgula serve quando são muitos. Os padrões da rede entram no
 * fim — nunca na frente, porque o RPC público é 5x mais lento e tem teto de
 * 2.000 blocos no `eth_getLogs`.
 */
export function listaDeRpcs(
    env: Record<string, string | undefined>,
    padroes: string[],
): string[] {
    return escadaDeRpcs(env, padroes).degraus;
}

/**
 * URL QUEBRADA NÃO É DEGRAU, e o log dela de 2026-10-09 20:09 provou que isso
 * importa:
 *
 *     "degraus":["base-mainnet.g.alchemy.com","mainnet.base.orghttps",
 *                "mainnet.base.org","base-rpc.publicnode.com","base.llamarpc.com"]
 *
 * **`mainnet.base.orghttps` não existe.** São duas URLs coladas sem separador
 * numa variável de ambiente — e ela entrou na escada como DEGRAU 2. Quer dizer:
 * quando a Alchemy falhar duas vezes seguidas, o bot troca para um host que não
 * resolve, gasta as duas falhas de transporte DELE, e só então chega num
 * provedor que funciona. Redundância que parece existir e não existe — e o
 * minuto em que o RPC cai é o minuto em que as liquidações acontecem.
 *
 * Então a lista passa a RECUSAR o que não é URL de verdade, e a dizer o que
 * recusou. Silêncio aqui era a escada mentindo sobre o próprio tamanho.
 *
 * O teste de "é URL de verdade" é o `URL` do próprio Node (não uma regex
 * minha), mais três exigências que o caso dela mostra: protocolo http(s), host
 * com ponto, e nenhum `http` no meio do host — que é a assinatura de duas URLs
 * coladas.
 */
export function escadaDeRpcs(
    env: Record<string, string | undefined>,
    padroes: string[],
): { degraus: string[]; recusados: { url: string; porque: string }[] } {
    const degraus: string[] = [];
    const recusados: { url: string; porque: string }[] = [];
    const juntar = (u: string | undefined) => {
        const limpo = (u ?? '').trim();
        if (limpo === '') return;
        const mal = porQueNaoServe(limpo);
        if (mal !== null) {
            if (!recusados.some((r) => r.url === limpo)) recusados.push({ url: limpo, porque: mal });
            return;
        }
        // Repetido não é redundância: dois nomes apontando para o mesmo host
        // dariam uma escada de dois degraus que caem juntos.
        if (!degraus.includes(limpo)) degraus.push(limpo);
    };
    juntar(env.CACA_RPC_URL);
    for (let i = 1; i <= 9; i += 1) juntar(env[`RPC_URL_${i}`]);
    for (const u of (env.CACA_RPC_URLS ?? '').split(',')) juntar(u);
    for (const u of padroes) juntar(u);
    return { degraus, recusados };
}

/** `null` quando serve. A frase, quando não — e ela diz o que consertar. */
export function porQueNaoServe(url: string): string | null {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return 'não é uma URL que o Node consiga ler';
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return `protocolo "${u.protocol}" não serve para JSON-RPC: use https://`;
    }
    if (!u.hostname.includes('.')) return `o host "${u.hostname}" não tem ponto: não é um domínio`;
    // DUAS URLS COLADAS: o caso real dela. `https://a.orghttps://b.com` vira
    // host "a.orghttps" com o resto no caminho, e nenhum DNS resolve isso.
    if (/https?$/i.test(u.hostname)) {
        return `o host termina em "http(s)" — são DUAS URLs coladas sem separador. `
            + 'Separe por vírgula em CACA_RPC_URLS, ou use RPC_URL_1 e RPC_URL_2';
    }
    if (u.hostname.includes('..')) return `o host "${u.hostname}" tem ponto duplo`;
    return null;
}

/**
 * O provedor falhou, ou o provedor respondeu?
 *
 * Só o primeiro caso justifica trocar de degrau. A lista de sinais é de
 * transporte — tempo, conexão, código HTTP, limite de taxa — e nenhum deles
 * descreve o conteúdo de uma resposta.
 */
export function ehFalhaDeTransporte(mensagem: string): boolean {
    const m = mensagem.toLowerCase();
    // Uma reversão é RESPOSTA. Sai na frente para nenhum padrão abaixo a pegar
    // por acidente (uma mensagem de revert pode conter quase qualquer palavra).
    if (m.includes('revert')) return false;
    return /timeout|timed out|abort|socket|econnreset|econnrefused|enotfound|eai_again|network|fetch failed|terminated|502|503|504|429|too many requests|rate limit|capacity|exceeded|unavailable|internal error|bad gateway/
        .test(m);
}

export interface DegrauDaEscada {
    url: string;
    /** Quantas falhas de transporte seguidas, usado para decidir a troca. */
    falhasSeguidas: number;
    /** Quando este degrau foi marcado como caído. 0 = nunca. */
    caiuEm: number;
}

/**
 * Qual provedor usar agora, e quando trocar.
 *
 * O estado é mínimo de propósito: índice atual, falhas seguidas e o instante da
 * queda. Nada de média móvel nem de pontuação — isso é um bot que tem 2.000ms
 * por bloco, e a decisão tem de ser uma comparação de inteiros.
 */
export class EscadaDeRpc {
    private readonly degraus: DegrauDaEscada[];
    private atual = 0;
    private readonly falhasParaTrocar: number;
    private readonly voltarAoPrimarioMs: number;
    private readonly agora: () => number;
    /** Quantas vezes trocou de provedor, para o log do ciclo poder dizer. */
    public trocas = 0;

    constructor(
        urls: string[],
        opcoes: { falhasParaTrocar?: number; voltarAoPrimarioMs?: number; agora?: () => number } = {},
    ) {
        if (urls.length === 0) throw new Error('escada de RPC sem nenhuma url');
        this.degraus = urls.map((url) => ({ url, falhasSeguidas: 0, caiuEm: 0 }));
        // DUAS falhas, e não uma: um timeout solitário é soluço de rede, e
        // trocar nele faria o bot pular de provedor a cada soluço, perdendo a
        // conexão aberta (keep-alive) justamente quando a pressa é maior. Duas
        // seguidas no mesmo degrau já são o provedor, não a sorte.
        this.falhasParaTrocar = Math.max(1, opcoes.falhasParaTrocar ?? 2);
        this.voltarAoPrimarioMs = opcoes.voltarAoPrimarioMs ?? 300_000;
        this.agora = opcoes.agora ?? Date.now;
    }

    public url(): string { return this.degraus[this.atual]!.url; }
    public indice(): number { return this.atual; }
    public quantos(): number { return this.degraus.length; }
    public ehOPrimario(): boolean { return this.atual === 0; }

    /** Deu certo: zera a conta deste degrau. Sucesso apaga histórico de falha. */
    public deuCerto(): void {
        this.degraus[this.atual]!.falhasSeguidas = 0;
        this.degraus[this.atual]!.caiuEm = 0;
    }

    /**
     * Falhou o transporte. Devolve a url a usar na próxima tentativa, e se trocou.
     *
     * Quando todos os degraus caíram, VOLTA para o primário em vez de desistir:
     * "todos fora" é quase sempre a rede local ou o proxy, e nesse caso insistir
     * no melhor provedor é melhor que insistir no pior. Desistir não é opção —
     * quem chama trata o erro, e o bot tem de continuar vivo para a próxima volta.
     */
    public falhou(): { url: string; trocou: boolean; de: string; para: string } {
        const antes = this.degraus[this.atual]!;
        antes.falhasSeguidas += 1;
        if (antes.falhasSeguidas < this.falhasParaTrocar) {
            return { url: antes.url, trocou: false, de: antes.url, para: antes.url };
        }
        antes.caiuEm = this.agora();
        const proximo = (this.atual + 1) % this.degraus.length;
        this.atual = proximo;
        this.degraus[proximo]!.falhasSeguidas = 0;
        this.trocas += 1;
        return { url: this.degraus[proximo]!.url, trocou: true, de: antes.url, para: this.degraus[proximo]!.url };
    }

    /**
     * Hora de tentar o primário de novo?
     *
     * Sem isto um soluço de 30 segundos na Alchemy às 3h da manhã deixaria o bot
     * no RPC público pelo resto do mês — 5x mais lento e com teto de 2.000
     * blocos, degradado em silêncio porque "está funcionando". A volta é
     * conferida por tempo e barata: uma chamada que, se falhar, só recoloca o bot
     * onde ele já estava.
     */
    public deveVoltarAoPrimario(): boolean {
        if (this.atual === 0) return false;
        const caiuEm = this.degraus[0]!.caiuEm;
        if (caiuEm === 0) return true;
        return this.agora() - caiuEm >= this.voltarAoPrimarioMs;
    }

    public voltarAoPrimario(): void {
        this.atual = 0;
        this.degraus[0]!.falhasSeguidas = 0;
        this.degraus[0]!.caiuEm = 0;
    }
}
