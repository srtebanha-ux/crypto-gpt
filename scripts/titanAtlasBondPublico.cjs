'use strict';
/** Public onchain Atlas bonded-balance inspection. NO private keys. */
const {Interface,formatEther}=require('ethers');
const atlas='0x583dcFef0D240DC80753F0F0B26513feE27D9B77';
const account=process.env.PUBLIC_SIGNER_ADDRESS;
if(!account||!/^0x[0-9a-fA-F]{40}$/.test(account))throw Error('Missing PUBLIC_SIGNER_ADDRESS');
const iface=new Interface(['function balanceOfBonded(address) view returns(uint256)']);
async function main(){
 const data=iface.encodeFunctionData('balanceOfBonded',[account]);
 const response=await fetch('https://base-rpc.publicnode.com',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:atlas,data},'latest']})
 });
 const body=await response.json();
 if(body.error||!body.result)throw Error(String(body.error?.message||'RPC no result'));
 const amount=iface.decodeFunctionResult('balanceOfBonded',body.result)[0];
 console.log('ATLAS_BONDED_PUBLIC',JSON.stringify({account,bondedWei:amount.toString(),bondedETH:formatEther(amount),
  note:'Read-only current Atlas bonded balance, not capital held in wallet'}));
}
main().catch(e=>{console.error('BOND_CHECK_UNAVAILABLE',e.message);process.exitCode=1});
