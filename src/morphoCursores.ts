import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {DevedorDaApi} from './morphoApi';
type Registro={proximo:number;devedores:DevedorDaApi[]};
/** Durable discovered addresses + next offset per market. Failure never advances a page. */
export class CursoresMorpho {
 private registros=new Map<string,Registro>();
 private tentativas=new Map<string,number>();
 private sequencia=0;
 constructor(private readonly arquivo:string){}
 async carregar():Promise<void>{
  try{
   const raw=JSON.parse(await fs.readFile(this.arquivo,'utf8')) as {versao?:number;mercados?:Record<string,Registro>;tentativas?:Record<string,number>};
   if(raw.versao!==1||!raw.mercados)return;
   for(const [id,n] of Object.entries(raw.tentativas??{})){
    if(/^0x[0-9a-f]{64}$/i.test(id)&&Number.isSafeInteger(n)&&n>0){
     this.tentativas.set(id.toLowerCase(),n);this.sequencia=Math.max(this.sequencia,n);
    }
   }
   for(const [id,r] of Object.entries(raw.mercados)){
    if(!/^0x[0-9a-f]{64}$/i.test(id)||!Number.isSafeInteger(r.proximo)||r.proximo<0||!Array.isArray(r.devedores))continue;
    this.registros.set(id.toLowerCase(),{proximo:r.proximo,devedores:r.devedores.filter(d=>/^0x[0-9a-f]{40}$/i.test(d.endereco)).map(d=>({...d,
      borrowSharesDaApi:d.borrowSharesDaApi===null?null:BigInt(d.borrowSharesDaApi)}))});
   }
  }catch{/* Missing/corrupt cache means explicit rediscovery, never executable API data. */}
 }
 obter(id:string):Registro{return this.registros.get(id.toLowerCase())??{proximo:0,devedores:[]};}
 /** One durable queue from market validation to borrower collection. Ranking only
  * breaks ties: a large book cannot starve a smaller book across restarts. */
 selecionarMercados<T extends {id:string}>(mercados:readonly T[],ranking:readonly string[]|null,limite:number,riscoGlobal:readonly string[]=[]):T[]{
  if(!Number.isSafeInteger(limite)||limite<=0)return[];
  const ranks=new Map((ranking??[]).map((id,i)=>[id.toLowerCase(),i]));
  const unicos=[...new Map(mercados.map(m=>[m.id.toLowerCase(),m])).values()];
  const known=new Map(unicos.map(m=>[m.id.toLowerCase(),m]));
  const urgent:T[]=[];
  const urgentIds=new Set<string>();
  for(const raw of riscoGlobal){
    const id=raw.toLowerCase(),m=known.get(id);
    if(!m||urgentIds.has(id))continue;
    urgent.push(m);urgentIds.add(id);
    if(urgent.length>=Math.floor(limite/4))break;
  }
  // Reserve 25% of each round for markets with the largest indexed debt.
  // Previously the least-recent-attempted sort dominated every ranking entry,
  // revisiting large active debt only after thousands of other markets.
  // Keep 75% rotating fairly so small books can still become candidates.
  const quentes=unicos.filter(m=>ranks.has(m.id.toLowerCase()))
   .sort((a,b)=>ranks.get(a.id.toLowerCase())!-ranks.get(b.id.toLowerCase())!)
   .slice(0,Math.min(Math.floor(limite/4),unicos.length));
  const reservados=new Set(quentes.map(m=>m.id.toLowerCase()));
  const rotativos=unicos.filter(m=>!reservados.has(m.id.toLowerCase()));
  rotativos.sort((a,b)=>{
   const ai=a.id.toLowerCase(),bi=b.id.toLowerCase();
   return (this.tentativas.get(ai)??0)-(this.tentativas.get(bi)??0)
    ||(ranks.get(ai)??Number.MAX_SAFE_INTEGER)-(ranks.get(bi)??Number.MAX_SAFE_INTEGER)
    ||ai.localeCompare(bi);
  });
  return [...quentes,...rotativos].slice(0,limite);
 }
 /** An attempted read is NOT successful coverage. Failure rotates fairly but
  * never changes the pagination cursor or the discovered borrower addresses. */
 async marcarTentativa(id:string):Promise<void>{
  if(!/^0x[0-9a-f]{64}$/i.test(id))throw Error('market id invalido');
  this.tentativas.set(id.toLowerCase(),++this.sequencia);
  await this.persistir();
 }
 async guardar(id:string,proximo:number,novos:DevedorDaApi[]):Promise<void>{
  const anterior=this.obter(id);
  const mapa=new Map(anterior.devedores.map(d=>[d.endereco.toLowerCase(),d]));
  for(const d of novos)mapa.set(d.endereco.toLowerCase(),d);
  this.registros.set(id.toLowerCase(),{proximo,devedores:[...mapa.values()]});
  await this.persistir();
 }
 private async persistir():Promise<void>{
  await fs.mkdir(path.dirname(this.arquivo),{recursive:true});
  const tmp=this.arquivo+'.tmp';
  await fs.writeFile(tmp,JSON.stringify({versao:1,mercados:Object.fromEntries(this.registros),
    tentativas:Object.fromEntries(this.tentativas)},
    (_,v)=>typeof v==='bigint'?v.toString():v));
  await fs.rename(tmp,this.arquivo);
 }
}
