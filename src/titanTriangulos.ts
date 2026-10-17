/**
 * Discovery-only: detecta ciclos 3-hop na rede Base para futura cotacao
 * no executor. NAO gera tx, nao supoe taxa, nao chama o quoter de 2 hops.
 * Os tres pools sao diferentes e o caminho precisa fechar em WETH.
 */
import type {PoolMisto,Venue} from './rotasMistas';

export interface TrianguloTitan{
    id:string;
    tokens:readonly [string,string,string,string];
    pools:readonly [string,string,string];
    venues:readonly [Venue,Venue,Venue];
    /** Sem cotacao atomica este estado NUNCA pode autorizar envio. */
    prova:'descoberto-sem-cotacao';
}
type Aresta={destino:string;pool:string;venue:Venue};
export function explorarTriangulos(
    pools:readonly PoolMisto[],base:string,teto=1000,
):TrianguloTitan[]{
    const raiz=base.toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(raiz))return [];
    const limite=Number.isInteger(teto)&&teto>=1?Math.min(2000,teto):1000;
    const grafo=new Map<string,Aresta[]>();
    const add=(a:string,b:string,p:PoolMisto)=>{
        const arr=grafo.get(a)??[];
        arr.push({destino:b,pool:p.endereco.toLowerCase(),venue:p.venue});
        grafo.set(a,arr);
    };
    for(const p of pools){
        const a=p.token0.toLowerCase(),b=p.token1.toLowerCase(),addr=p.endereco.toLowerCase();
        if(!/^0x[0-9a-f]{40}$/.test(a)||!/^0x[0-9a-f]{40}$/.test(b)
            ||!/^0x[0-9a-f]{40}$/.test(addr)||a===b
            ||(p.venue!=='v3' && p.venue!=='aerodrome'))continue;
        add(a,b,p);add(b,a,p);
    }
    const out:TrianguloTitan[]=[],seen=new Set<string>();
    for(const first of grafo.get(raiz)??[]){
        if(first.destino===raiz)continue;
        for(const second of grafo.get(first.destino)??[]){
            if(second.destino===raiz||second.destino===first.destino
                ||second.pool===first.pool)continue;
            for(const third of grafo.get(second.destino)??[]){
                if(third.destino!==raiz||third.pool===first.pool
                    ||third.pool===second.pool)continue;
                const id=[first.pool,second.pool,third.pool].join('>');
                if(seen.has(id))continue;
                seen.add(id);
                out.push({
                    id,
                    tokens:[raiz,first.destino,second.destino,raiz],
                    pools:[first.pool,second.pool,third.pool],
                    venues:[first.venue,second.venue,third.venue],
                    prova:'descoberto-sem-cotacao'
                });
                if(out.length>=limite)return out;
            }
        }
    }
    return out;
}
