/**
 * TITAN multi-hop: descoberta de 1 a 4 pools sem repetir token nem pool.
 * Saida compatível com CacadorAaveMultiHopMorpho.liquidar(..., Perna[]).
 * SEM auto-execucao: retorna caminhos, somente cotacao atomica onchain
 * permite classificar lucro e liberar operacao.
 */
export interface PoolLiquidacao {
    endereco: string;
    token0: string;
    token1: string;
    protocolo: 'v3'|'aerodrome'|'slipstream';
    taxa: number|null;
    permitida: boolean; // validada via factory/allowlist, não por suposição
}
export interface PernaLiquidacao {
    pool: string;
    tokenEntra: string;
    tipo: 0|1|2;
    fee: number;
}
export interface RotaLiquidacao {
    pernas: PernaLiquidacao[];
    caminho: string[];
    chave: string;
}
const END=/^0x[0-9a-fA-F]{40}$/;
export function gerarRotasLiquidacao(
    pools:readonly PoolLiquidacao[],colateral:string,divida:string,
    maxSaltos=4,maxRotas=300,
):RotaLiquidacao[]{
    if(!END.test(colateral)||!END.test(divida)||colateral.toLowerCase()===divida.toLowerCase())
        return [];
    if(!Number.isSafeInteger(maxSaltos)||maxSaltos<1||maxSaltos>4
        ||!Number.isSafeInteger(maxRotas)||maxRotas<1||maxRotas>3000)
        throw new Error('limite invalido para busca multi-hop');
    const adj=new Map<string,{pool:PoolLiquidacao;out:string}[]>();
    const push=(token:string,pool:PoolLiquidacao,out:string)=>{
        const l=adj.get(token)??[];l.push({pool,out});adj.set(token,l);
    };
    for(const p of pools){
        if(!p.permitida||!END.test(p.endereco)||!END.test(p.token0)||!END.test(p.token1)
            ||p.token0.toLowerCase()===p.token1.toLowerCase())continue;
        if(p.protocolo==='v3'&&(!Number.isSafeInteger(p.taxa)||p.taxa===null
            ||p.taxa<=0||p.taxa>10000))continue;
        if(p.protocolo==='aerodrome'&&p.taxa!==null&&p.taxa!==0)continue;
        if(p.protocolo==='slipstream' &&
           (p.taxa!==50
            || p.endereco.toLowerCase()!=='0xe846373c1a92b167b4e9cd5d8e4d6b1db9e90ec7'
            || ![p.token0.toLowerCase(),p.token1.toLowerCase()].includes('0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42')
            || ![p.token0.toLowerCase(),p.token1.toLowerCase()].includes('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')))continue;
        const a=p.token0.toLowerCase(),b=p.token1.toLowerCase();
        push(a,p,b);push(b,p,a);
    }
    const fim=divida.toLowerCase(),inicio=colateral.toLowerCase();
    const result:RotaLiquidacao[]=[];
    const visitados=new Set<string>([inicio]);
    const usados=new Set<string>();
    function dfs(atual:string,pernas:PernaLiquidacao[],caminho:string[]):void{
        if(result.length>=maxRotas)return;
        if(atual===fim){
            if(pernas.length>0)result.push({
                pernas:[...pernas],caminho:[...caminho],
                chave:pernas.map(p=>p.pool).join('>'),
            });
            return;
        }
        if(pernas.length>=maxSaltos)return;
        for(const {pool,out} of adj.get(atual)??[]){
            const poolid=pool.endereco.toLowerCase();
            if(visitados.has(out)||usados.has(poolid))continue;
            visitados.add(out);usados.add(poolid);
            pernas.push({pool:poolid,tokenEntra:atual,
                tipo:pool.protocolo==='v3'?0:pool.protocolo==='slipstream'?2:1,
                fee:pool.protocolo==='aerodrome'?0:pool.taxa!});
            caminho.push(out);
            dfs(out,pernas,caminho);
            caminho.pop();pernas.pop();usados.delete(poolid);visitados.delete(out);
            if(result.length>=maxRotas)break;
        }
    }
    dfs(inicio,[],[inicio]);
    result.sort((a,b)=>a.pernas.length-b.pernas.length||a.chave.localeCompare(b.chave));
    return result;
}
export interface CotacaoRota {
    rota:RotaLiquidacao;
    recebidoDivida:bigint;   // valor apos ultimo swap, MESMO snapshot
    principalMorpho:bigint;
    gasConvertidoEmDivida:bigint;
    lucroMinimoDivida:bigint;
}
export function selecionarMelhorRotaLiquidacao(cotacoes:readonly CotacaoRota[]):
    {rota:RotaLiquidacao;lucroLiquido:bigint}|null{
    let melhor:{rota:RotaLiquidacao;lucroLiquido:bigint}|null=null;
    for(const c of cotacoes){
        if(c.recebidoDivida<0n||c.principalMorpho<=0n||c.gasConvertidoEmDivida<0n
            ||c.lucroMinimoDivida<=0n)continue;
        const liquido=c.recebidoDivida-c.principalMorpho-c.gasConvertidoEmDivida;
        if(liquido<c.lucroMinimoDivida)continue;
        if(!melhor||liquido>melhor.lucroLiquido)
            melhor={rota:c.rota,lucroLiquido:liquido};
    }
    return melhor;
}
