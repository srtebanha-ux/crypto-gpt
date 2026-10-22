/**
 * Selecao econômica e diversificacao de cotacoes para o TITAN.
 *
 * Nenhum destes dados autoriza um broadcast: so o eth_call integral do
 * contrato real, revalidado imediatamente pelo executor, pode faze-lo.
 * Cache evita que um unico spread ilusorio roube toda a fila de simulacao.
 */
export interface SinalParaExplorar {
    rota:string;
    lucroBrutoEstimado:bigint|null;
    lucroLiquidoEstimado:bigint|null;
    melhorTamanho:bigint|null;
    motivo:string;
}
export interface RotaParaExplorar {
    chave:string;
    pernas:readonly unknown[];
}
export type ResultadoAtomico = 'executavel'|'inviavel'|'desconhecido';

export function limiteAtomicoSeguro(valor:string|undefined):number{
    if(valor===undefined)return 2;
    if(!/^[1-4]$/.test(valor))return 2;
    return Number(valor);
}

export class ExploradorDeRotasTitan{
    private readonly resultados=new Map<string,{ultima:number;resultado:ResultadoAtomico}>();
    constructor(private readonly recusaMs=90_000,private readonly desconhecidoMs=25_000){}

    registrar(chave:string,resultado:ResultadoAtomico,agora=Date.now()):void{
        this.resultados.set(chave.toLowerCase(),{ultima:agora,resultado});
        if(this.resultados.size>1200){
            const antigas=[...this.resultados.entries()].sort((a,b)=>a[1].ultima-b[1].ultima);
            for(const [k] of antigas.slice(0,this.resultados.size-800))
                this.resultados.delete(k);
        }
    }

    selecionar<S extends SinalParaExplorar,R extends RotaParaExplorar>(
        sinais:readonly S[],rotas:readonly R[],limite=2,agora=Date.now(),
        permitirMedirCusto=false,
    ):Array<{sinal:S;rota:R}>{
        const acesso=new Map(rotas.map(x=>[x.chave.toLowerCase(),x]));
        const vistas=new Set<string>();
        const validos:Array<{sinal:S;rota:R}>=[];
        for(const sinal of sinais){
            const key=sinal.rota.toLowerCase();
            const rota=acesso.get(key);
            if(!rota||vistas.has(key)||rota.pernas.length<2||rota.pernas.length>4)continue;
            if(sinal.melhorTamanho===null||sinal.melhorTamanho<=0n
                ||sinal.lucroBrutoEstimado===null||sinal.lucroBrutoEstimado<=0n
                ||(!permitirMedirCusto && (sinal.lucroLiquidoEstimado===null
                    ||sinal.lucroLiquidoEstimado<=0n))
                ||sinal.motivo.startsWith('ESTADO_'))continue;
            const anterior=this.resultados.get(key);
            if(anterior){
                const espera=anterior.resultado==='inviavel' ? this.recusaMs
                    : anterior.resultado==='desconhecido' ? this.desconhecidoMs
                    : 0;
                if(agora-anterior.ultima<espera)continue;
            }
            vistas.add(key);validos.push({sinal,rota});
        }
        validos.sort((a,b)=>{
            // Only an EVM eth_call may establish actual net profit. Quotes
            // missing a cost estimate can be probed read-only, NEVER sent.
            // First prefer a positive known net, then gross for unknown costs.
            const luA=a.sinal.lucroLiquidoEstimado;
            const luB=b.sinal.lucroLiquidoEstimado;
            const posA=luA!==null&&luA>0n, posB=luB!==null&&luB>0n;
            if(posA!==posB)return posA?-1:1;
            if(posA&&posB&&luA!==luB)return luB!>luA! ? 1 : -1;
            if(permitirMedirCusto && !posA){
                const ga=a.sinal.lucroBrutoEstimado!;
                const gb=b.sinal.lucroBrutoEstimado!;
                if(ga!==gb)return gb>ga?1:-1;
            }
            // Mesma rentabilidade -> caminho mais curto paga menos gas/risco.
            if(a.rota.pernas.length!==b.rota.pernas.length)
                return a.rota.pernas.length-b.rota.pernas.length;
            return a.sinal.rota.localeCompare(b.sinal.rota);
        });
        return validos.slice(0,Math.min(4,Math.max(1,limite)));
    }
}
