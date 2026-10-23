/** Pinned read snapshot with transport failover. Never change protocol identity. */
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
export type PedidoMorphoRpc=(url:string,metodo:string,params:unknown[])=>Promise<unknown>;
export async function abrirSnapshotMorpho(
 urls:readonly string[],candidatos:readonly string[],pedir:PedidoMorphoRpc,
 superficie:(codigo:string)=>boolean,
):Promise<{url:string;morpho:string;bloco:string;chamar:(data:string,alvo?:string)=>Promise<string|null>}|null>{
 // Executors are bound to this canonical Base deployment. Other candidates may
 // be investigated elsewhere, but cannot silently become execution targets.
 const canonico=MORPHO_FLASH_BASE.toLowerCase();
 const enderecos=[...new Set([...candidatos,MORPHO_FLASH_BASE].map(x=>x.trim().toLowerCase()))];
 for(const url of urls){
   try{
     if(BigInt(String(await pedir(url,'eth_chainId',[])))!==8453n)continue;
     for(const morpho of enderecos){
       if(morpho!==canonico)continue;
       const codigo=await pedir(url,'eth_getCode',[morpho,'latest']);
       if(typeof codigo!=='string'||!superficie(codigo))continue;
       const head=await pedir(url,'eth_getBlockByNumber',['latest',false]) as {number?:string;hash?:string}|null;
       if(!head||!/^0x[0-9a-f]+$/i.test(head.number??'')||!/^0x[0-9a-f]{64}$/i.test(head.hash??''))continue;
       const bloco=head.number!,hash=head.hash!;
       const verificados=new Set<string>([url]);
       return{url,morpho,bloco,chamar:async(data,alvo=morpho)=>{
         for(const alternativa of [url,...urls.filter(x=>x!==url)]){
           try{
             // Verify chain and SAME block hash even for fallback providers.
             if(!verificados.has(alternativa)){
               if(BigInt(String(await pedir(alternativa,'eth_chainId',[])))!==8453n)continue;
               const b=await pedir(alternativa,'eth_getBlockByNumber',[bloco,false]) as {hash?:string}|null;
               if(b?.hash?.toLowerCase()!==hash.toLowerCase())continue;
               verificados.add(alternativa);
             }
             const ret=await pedir(alternativa,'eth_call',[{to:alvo,data},bloco]);
             if(typeof ret==='string'&&/^0x[0-9a-f]*$/i.test(ret))return ret;
           }catch{/* Unavailable or RPC error: never manufacture a successful call. */}
         }
         return null;
       }};
     }
   }catch{/* Try next configured provider; no unconfirmed identity is accepted. */}
 }
 return null;
}
