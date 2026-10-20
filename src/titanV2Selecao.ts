/**
 * The Base fork on 2026-10-14 reproduced ~48% transfer tax on this
 * token. Its optimistic pool-reserve arithmetic repeatedly looked
 * profitable, but FlashArb reverted (UniswapV2 K / Insufficient Balance).
 * Keep the token in radar telemetry, but never dedicate scarce atomic
 * probes or paid gas to it unless separately requalified on a new fork.
 */
export const V2_TOKENS_COM_REPROVACAO_NO_FORK = Object.freeze([
    '0x7787548c57031023c031304f274beda304da734f',
]);
/** Lock de pool V2 observado em prova integral; nao equivale a oportunidade. */
export function reprovacaoDePoolTravadoV2(motivo:string):boolean {
    return /UniswapV2:\s*LOCKED\b/i.test(motivo);
}

export function selecionarProximaProvaV2<T extends {
    candidato:{T:string;emprestimo:{endereco:string};venda:{endereco:string}}
}>(
    oportunidades: readonly T[],tentadas:ReadonlyMap<string,number>,
    agora=Date.now(),intervaloMs=240_000,
    bloqueadasAte:ReadonlyMap<string,number>=new Map(),
):{oportunidade:T|null;ignoradoPorTaxa:number;esgotadas:number;bloqueadasPorLock:number}{
    const reprovados=new Set(V2_TOKENS_COM_REPROVACAO_NO_FORK);
    let ignoradoPorTaxa=0,esgotadas=0,bloqueadasPorLock=0;
    for(const oportunidade of oportunidades){
        const token=oportunidade.candidato.T.toLowerCase();
        if(reprovados.has(token)){ignoradoPorTaxa++;continue}
        const key=oportunidade.candidato.emprestimo.endereco.toLowerCase()
            +'>'+oportunidade.candidato.venda.endereco.toLowerCase();
        if(agora<(bloqueadasAte.get(key)??0)){
            bloqueadasPorLock++;continue;
        }
        if(agora-(tentadas.get(key)??0)<intervaloMs){esgotadas++;continue}
        return {oportunidade,ignoradoPorTaxa,esgotadas,bloqueadasPorLock};
    }
    return{ oportunidade:null,ignoradoPorTaxa,esgotadas,bloqueadasPorLock};
}
