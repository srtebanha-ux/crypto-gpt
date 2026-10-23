/**
 * TITAN: otimiza TAMANHO em unidades inteiras, sem float nem "50ms" inventados.
 * Funcao de cotacao deve representar uma execucao economica completa num
 * MESMO estado (inclusive premium, slippage, gas convertido no token de lucro).
 * Nenhum numero negativo ou resposta ausente e tratado como lucro.
 */
export type CotarTamanho = (quantia:bigint)=>bigint|null;
export interface TamanhoTitan {
    quantia:bigint;
    lucroLiquido:bigint;
    cotacoes:number;
}
export function otimizarTamanhoTitan(
    maximo:bigint,granularidade:bigint,cotar:CotarTamanho,
    maxCotacoes=32,
    sementesTeoricas:readonly bigint[]=[],
):TamanhoTitan|null {
    if(maximo<granularidade||granularidade<=0n
        ||!Number.isSafeInteger(maxCotacoes)||maxCotacoes<8||maxCotacoes>256)
        return null;
    const cache=new Map<bigint,bigint|null>();
    const avaliar=(v:bigint):bigint|null=>{
        const x=v/granularidade*granularidade;
        if(x<granularidade||x>maximo)return null;
        if(cache.has(x)) return cache.get(x)!;
        if(cache.size>=maxCotacoes)return null;
        const r=cotar(x);
        cache.set(x,r);
        return r;
    };
    // O pre-filtro matematico CPAMM pode propor tamanhos; a cotacao real
    // continua mandatoria e tem prioridade economica sobre a equacao.
    // Sem sementes, o algoritmo anterior permanece identico.
    for(const x of sementesTeoricas.slice(0,Math.floor(maxCotacoes/4))){
        if(cache.size>=maxCotacoes)break;
        avaliar(x);
    }
    // Grade inteira e refinamento AO REDOR de varios picos discretos.
    // Busca ternaria pressupoe unimodalidade, que ticks/fees NAO garantem.
    const n=BigInt(Math.floor(maxCotacoes/2));
    const candidatos:bigint[]=[];
    for(let i=1n;i<=n;i++){
        const x=(maximo*i/n)/granularidade*granularidade;
        if(x>0n)candidatos.push(x);
    }
    const pontos:{x:bigint; lucro:bigint}[]=[];
    for(const x of candidatos){
        const lucro=avaliar(x);
        if(lucro!==null)pontos.push({x, lucro});
    }
    pontos.sort((a,b)=>a.lucro>b.lucro?-1:a.lucro<b.lucro?1:0);
    const delta=maximo/n > granularidade?maximo/n:granularidade;
    // Reavaliar proximidades do melhor da grade com shifts entre ticks.
    for(const p of pontos.slice(0,3)){
        for(const shift of [-delta/2n,-granularidade,granularidade,delta/2n]){
            if(cache.size>=maxCotacoes)break;
            avaliar(p.x+shift);
        }
    }
    let melhor:TamanhoTitan|null=null;
    for(const [q,l] of cache){
        if(l===null||l<=0n)continue;
        if(!melhor||l>melhor.lucroLiquido)
            melhor={quantia:q,lucroLiquido:l,cotacoes:cache.size};
    }
    return melhor===null?null:{...melhor,cotacoes:cache.size};
}
export function variacoesDePrecisao(
    base:bigint,maximo:bigint,granularidade=1n,
):bigint[]{
    if(granularidade<=0n||maximo<=0n||base<=0n)return [];
    const set=new Set<bigint>();
    for(const shift of [-100n,-10n,-1n,0n,1n,10n,100n]){
        const v=(base+shift*granularidade)/granularidade*granularidade;
        if(v>0n&&v<=maximo)set.add(v);
    }
    return [...set].sort((a,b)=>a<b?-1:a>b?1:0);
}
