/** Bounded paths through canonical factories, only allowed bridge assets. */
import {solidityPacked} from 'ethers';
export const PONTES_MORPHO=[
 '0x4200000000000000000000000000000000000006',
 '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
] as const;
export const TAXAS_MORPHO=[500,3000,100,10000] as const;
export type RotaMorphoV3={tokens:string[];taxas:number[];path:string};
export type RotaMorphoAero={from:string;to:string;stable:boolean;factory:string}[];
const igual=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function codificarCaminhoV3(tokens:readonly string[],taxas:readonly number[]):string{
 if(tokens.length!==taxas.length+1||taxas.length<1||taxas.length>2)throw Error('caminho V3 invalido');
 const tipos:string[]=['address'];const valores:Array<string|number>=[tokens[0]!];
 for(let i=0;i<taxas.length;i++){
  if(!TAXAS_MORPHO.includes(taxas[i] as typeof TAXAS_MORPHO[number]))throw Error('taxa V3 fora da allowlist');
  tipos.push('uint24','address');valores.push(taxas[i]!,tokens[i+1]!);
 }
 return solidityPacked(tipos,valores);
}
export async function planejarRotasMorphoV3(
 entrada:string,saida:string,multihop:boolean,
 pool:(a:string,b:string,taxa:number)=>Promise<boolean>,
 permitido:(token:string)=>Promise<boolean>,
):Promise<RotaMorphoV3[]>{
 if(igual(entrada,saida))return[{tokens:[entrada],taxas:[],path:'0x'}];
 const cache=new Map<string,Promise<boolean>>();
 const existe=(a:string,b:string,f:number)=>{
  const k=[a.toLowerCase(),b.toLowerCase()].sort().join(':')+':'+f;
  if(!cache.has(k))cache.set(k,pool(a,b,f));return cache.get(k)!;
 };
 const rotas:RotaMorphoV3[]=[];
 const adicionar=(tokens:string[],taxas:number[])=>rotas.push({tokens,taxas,path:codificarCaminhoV3(tokens,taxas)});
 for(const f of TAXAS_MORPHO)if(await existe(entrada,saida,f))adicionar([entrada,saida],[f]);
 if(multihop)for(const meio of PONTES_MORPHO){
  if(igual(meio,entrada)||igual(meio,saida)||!await permitido(meio))continue;
  for(const f of TAXAS_MORPHO){
   if(!await existe(entrada,meio,f))continue;
   for(const g of TAXAS_MORPHO)if(await existe(meio,saida,g))adicionar([entrada,meio,saida],[f,g]);
  }
 }
 return rotas;
}
export async function planejarRotasMorphoAero(
 entrada:string,saida:string,factory:string,multihop:boolean,
 pool:(a:string,b:string,stable:boolean)=>Promise<boolean>,
 permitido:(token:string)=>Promise<boolean>,
):Promise<RotaMorphoAero[]>{
 if(igual(entrada,saida))return[[]];
 const rotas:RotaMorphoAero[]=[];
 const cache=new Map<string,Promise<boolean>>();
 const existe=(a:string,b:string,s:boolean)=>{
  const k=[a.toLowerCase(),b.toLowerCase()].sort().join(':')+':'+s;
  if(!cache.has(k))cache.set(k,pool(a,b,s));return cache.get(k)!;
 };
 for(const stable of [false,true])if(await existe(entrada,saida,stable))
  rotas.push([{from:entrada,to:saida,stable,factory}]);
 if(multihop)for(const meio of PONTES_MORPHO){
  if(igual(meio,entrada)||igual(meio,saida)||!await permitido(meio))continue;
  for(const stable of [false,true]){
   if(!await existe(entrada,meio,stable))continue;
   for(const final of [false,true])if(await existe(meio,saida,final))
    rotas.push([{from:entrada,to:meio,stable,factory},{from:meio,to:saida,stable:final,factory}]);
  }
 }
 return rotas;
}
/** Round-robin routes before sizes: a missing direct pool cannot hide an indirect path. */
export function combinarSondasMorpho<R>(rotas:readonly R[],tamanhos:readonly bigint[],proxima:boolean):Array<{shares:bigint;rota:R}>{
 if(!tamanhos.length)return[];
 const sizes=proxima?[tamanhos[Math.max(0,tamanhos.length-3)]!]:[...tamanhos].reverse();
 const combinacoes=sizes.flatMap(shares=>rotas.map(rota=>({shares,rota})));
 return combinacoes.slice(0,proxima?4:80);
}
