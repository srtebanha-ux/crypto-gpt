import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {DevedorDaApi} from './morphoApi';
type Registro={proximo:number;devedores:DevedorDaApi[]};
/** Durable discovered addresses + next offset per market. Failure never advances a page. */
export class CursoresMorpho {
 private registros=new Map<string,Registro>();
 constructor(private readonly arquivo:string){}
 async carregar():Promise<void>{
  try{
   const raw=JSON.parse(await fs.readFile(this.arquivo,'utf8')) as {versao?:number;mercados?:Record<string,Registro>};
   if(raw.versao!==1||!raw.mercados)return;
   for(const [id,r] of Object.entries(raw.mercados)){
    if(!/^0x[0-9a-f]{64}$/i.test(id)||!Number.isSafeInteger(r.proximo)||r.proximo<0||!Array.isArray(r.devedores))continue;
    this.registros.set(id.toLowerCase(),{proximo:r.proximo,devedores:r.devedores.filter(d=>/^0x[0-9a-f]{40}$/i.test(d.endereco)).map(d=>({...d,
      borrowSharesDaApi:d.borrowSharesDaApi===null?null:BigInt(d.borrowSharesDaApi)}))});
   }
  }catch{/* Missing/corrupt cache means explicit rediscovery, never executable API data. */}
 }
 obter(id:string):Registro{return this.registros.get(id.toLowerCase())??{proximo:0,devedores:[]};}
 async guardar(id:string,proximo:number,novos:DevedorDaApi[]):Promise<void>{
  const anterior=this.obter(id);
  const mapa=new Map(anterior.devedores.map(d=>[d.endereco.toLowerCase(),d]));
  for(const d of novos)mapa.set(d.endereco.toLowerCase(),d);
  this.registros.set(id.toLowerCase(),{proximo,devedores:[...mapa.values()]});
  await fs.mkdir(path.dirname(this.arquivo),{recursive:true});
  const tmp=this.arquivo+'.tmp';
  await fs.writeFile(tmp,JSON.stringify({versao:1,mercados:Object.fromEntries(this.registros)},
    (_,v)=>typeof v==='bigint'?v.toString():v));
  await fs.rename(tmp,this.arquivo);
 }
}
