/**
 * O RESUMO DE UM CICLO, em uma linha curta e conferivel.
 *
 * POR QUE ESTE ARQUIVO EXISTE. O log de 2026-10-10 tinha dezenas de campos por
 * ciclo e nao respondia "esta funcionando?". Ela pediu exatamente onze coisas:
 * *"versão · estado do serviço · envio · cobertura · idade dos dados · falhas ·
 * RPC ativo · WebSocket · decisões · duração · amostras"*.
 *
 * A regra que faz este arquivo valer: **nenhum campo ausente vira valor**.
 * Cada um que falta sai como `?`, e o teste proibe o contrario. Foi `undefined`
 * virando `'0x'`, `null` virando zero e campo ausente virando "outro chegou
 * antes" que custaram a este projeto os capitulos todos.
 */

export interface EstadoDoCiclo {
    /** O commit que esta rodando, ou `null` quando o ambiente nao diz. */
    versao: string | null;
    /** 'caçando' | 'varrendo' | 'dormindo' — o que o laco esta fazendo. */
    servico: string;
    /** `true` so quando o envio esta AUTORIZADO. Nunca inferido. */
    envioAutorizado: boolean;
    /** Lidas e pedidas. `null` em pedidas quando nao houve leitura. */
    lidas: number | null;
    pedidas: number | null;
    /** A idade do dado mais velho usado na decisao, em ms. */
    idadeDoDadoMs: number | null;
    /** Posicoes que falharam nesta leitura. */
    falhas: number | null;
    /** O RPC em uso, so o host — nunca a URL, que pode trazer chave. */
    rpcAtivo: string | null;
    /** `true` conectado, `false` caido, `null` nao usado nesta configuracao. */
    webSocket: boolean | null;
    /** Quantas decisoes de tiro o ciclo tomou, e quantas disseram sim. */
    decisoes: number | null;
    decisoesQueAtirariam: number | null;
    /** A parede do ciclo, em ms. */
    duracaoMs: number | null;
    /** Quantas amostras de latencia o livro ja tem. */
    amostras: number | null;
}

/** O host de uma URL de RPC, sem caminho nem consulta — a chave mora neles. */
export function soOHost(url: string | null): string | null {
    if (url === null || url.trim() === '') return null;
    try { return new URL(url).host; } catch { return null; }
}

/**
 * A linha. Curta de proposito: ela e para ser lida de relance e conferida.
 *
 * `?` quer dizer "nao sei", e ele aparece no lugar do numero, nao em vez da
 * palavra — quem le ve qual das onze coisas esta faltando.
 */
export function resumoDoCiclo(e: EstadoDoCiclo): string {
    const n = (v: number | null, casas = 0) => (v === null ? '?' : v.toFixed(casas));
    const cobertura = e.pedidas === null
        ? '?'
        : `${n(e.lidas)}/${e.pedidas}${e.lidas !== null && e.lidas < e.pedidas ? ' INCOMPLETA' : ''}`;
    const idade = e.idadeDoDadoMs === null ? '?' : `${(e.idadeDoDadoMs / 1000).toFixed(1)}s`;
    const ws = e.webSocket === null ? 'não uso' : e.webSocket ? 'ligado' : 'CAÍDO';
    const dec = e.decisoes === null
        ? '?'
        : `${e.decisoes}${e.decisoesQueAtirariam === null ? '' : ` (${e.decisoesQueAtirariam} atirariam)`}`;
    return [
        `v ${e.versao ?? '?'}`,
        e.servico,
        `envio ${e.envioAutorizado ? 'AUTORIZADO' : 'desligado'}`,
        `cobertura ${cobertura}`,
        `dado ${idade}`,
        `falhas ${n(e.falhas)}`,
        `rpc ${e.rpcAtivo ?? '?'}`,
        `ws ${ws}`,
        `decisões ${dec}`,
        `ciclo ${n(e.duracaoMs)}ms`,
        `amostras ${n(e.amostras)}`,
    ].join(' · ');
}
