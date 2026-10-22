/** Bounded read-only probes. Signing/broadcast remains outside this helper. */
export async function sondarMorphoEmLotes<T,R>(
 itens:readonly T[],sondar:(item:T)=>Promise<R>,
):Promise<PromiseSettledResult<R>[]>{
 const resultados:PromiseSettledResult<R>[]=[];
 // At most four independent probes; do not flood the public RPC with all
 // size/fee combinations. Await failed AND successful probes before returning.
 for(let i=0;i<itens.length;i+=4){
   resultados.push(...await Promise.allSettled(
     itens.slice(i,i+4).map(item=>Promise.resolve().then(()=>sondar(item))),
   ));
 }
 return resultados;
}
