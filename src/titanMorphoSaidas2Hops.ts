import {Interface,JsonRpcProvider,ZeroAddress,getAddress} from 'ethers';
const FACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const WETH='0x4200000000000000000000000000000000000006';
const USDC='0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913';
const factory=new Interface(['function getPool(address,address,bool) view returns(address)']);
export type AeroExit=Readonly<{middle:string|null;stable1:boolean;stable2:boolean;pools:string[]}>;
export async function encontrarSaidasAero(
 p:Pick<JsonRpcProvider,'call'|'getCode'>, collateral:string,loan:string,
):Promise<AeroExit[]>{
 const exits:AeroExit[]=[];
 const mids=[null,WETH,USDC].filter(m=>m===null||
   (m.toLowerCase()!==collateral.toLowerCase()&&m.toLowerCase()!==loan.toLowerCase()));
 const cache=new Map<string,string|null>();
 async function pool(a:string,b:string,stable:boolean):Promise<string|null>{
   const k=[a.toLowerCase(),b.toLowerCase()].sort().join('|')+'|'+stable;
   if(cache.has(k))return cache.get(k)!;
   try{
     const data=await p.call({to:FACTORY,data:factory.encodeFunctionData('getPool',[a,b,stable])});
     const addr=getAddress(factory.decodeFunctionResult('getPool',data)[0] as string);
     const found=addr!==ZeroAddress&&await p.getCode(addr)!=='0x'?addr:null;
     cache.set(k,found);return found;
   }catch{cache.set(k,null);return null;}
 }
 if(collateral.toLowerCase()===loan.toLowerCase())
   return [{middle:null,stable1:false,stable2:false,pools:[]}];
 for(const mid of mids){
   if(mid===null){
     for(const stable of [true,false]){
       const one=await pool(collateral,loan,stable);
       if(one)exits.push({middle:null,stable1:stable,stable2:false,pools:[one]});
     }
   }else{
     for(const first of [true,false]){
       const p1=await pool(collateral,mid,first);
       if(!p1)continue;
       for(const second of [true,false]){
         const p2=await pool(mid,loan,second);
         if(p2)exits.push({middle:mid,stable1:first,stable2:second,pools:[p1,p2]});
       }
     }
   }
 }
 return exits;
}
