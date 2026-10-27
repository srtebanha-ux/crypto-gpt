import {id} from 'ethers';
const WETH='0x4200000000000000000000000000000000000006';
const TRANSFER=id('Transfer(address,address,uint256)').toLowerCase();
export function lucroWethDoRecibo(
 executor:string,status:number|null,
 logs:readonly {address:string;topics:readonly string[];data:string}[],
 gasL2:bigint,l1:bigint|null,
):{brutoWei:bigint|null;liquidoWei:bigint|null}{
 if(gasL2<0n||l1!==null&&l1<0n||status!==0&&status!==1)return{brutoWei:null,liquidoWei:null};
 if(status===0)return{brutoWei:0n,liquidoWei:l1===null?null:-gasL2-l1};
 const who='0x'+executor.toLowerCase().slice(2).padStart(64,'0');
 let delta=0n,found=false;
 for(const l of logs){
  if(l.address.toLowerCase()!==WETH||l.topics[0]?.toLowerCase()!==TRANSFER)continue;
  const from=l.topics[1]?.toLowerCase(),to=l.topics[2]?.toLowerCase();
  if(from!==who&&to!==who)continue;
  if(l.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(l.data))return{brutoWei:null,liquidoWei:null};
  found=true;const n=BigInt(l.data);if(to===who)delta+=n;if(from===who)delta-=n;
 }
 if(!found)return{brutoWei:null,liquidoWei:null};
 return{brutoWei:delta,liquidoWei:l1===null?null:delta-gasL2-l1};
}
