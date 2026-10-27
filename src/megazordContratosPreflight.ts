/** Public identity audit, pinned to a block on two RPCs; never creates a signer. */
import {Interface,getAddress,keccak256} from 'ethers';
import {ProviderMorphoRpc} from './morphoProvider';
import {COFRE_ESPERADO} from './caca';
import {MORPHO_FLASH_BASE,FABRICA_V3_BASE} from './titanPonteMultiHop';
const abi=new Interface(['owner','dono','cofre','morpho','fabricaV3','routerV3',
 'aerodromeFactory','aerodromeRouter','factory','token0','token1'].map(n=>`function ${n}() view returns(address)`)
 .concat(['function versaoRotas() view returns(uint256)',
 'function getPair(address,address) view returns(address)']));
type Rpc=(method:string,params:unknown[])=>Promise<any>;
export async function auditarContratosMegazord(env:NodeJS.ProcessEnv,rpcs?:readonly [Rpc,Rpc]){
 const owner=getAddress(env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO??'');
 const specs=[
  {key:'CACA_MORPHO_V3_CONTRATO',hash:'CACA_MORPHO_V3_CODEHASH',checks:{dono:owner,cofre:COFRE_ESPERADO,
   morpho:MORPHO_FLASH_BASE,fabricaV3:FABRICA_V3_BASE,routerV3:'0x2626664c2603336E57B271c5C0b26F421741e481'}},
  {key:'CACA_MORPHO_AERO_CONTRATO',hash:'CACA_MORPHO_AERO_CODEHASH',checks:{dono:owner,cofre:COFRE_ESPERADO,
   morpho:MORPHO_FLASH_BASE,aerodromeFactory:'0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
   aerodromeRouter:'0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43'}},
  {key:'TITAN_V2_CONTRATO',hash:'FLASH_ARB_CODEHASH',checks:{owner}},
 ].filter(s=>env[s.key]);
 if(!specs.length)throw Error('nenhum executor configurado');
 for(const s of specs){getAddress(env[s.key]!);
  if(!/^0x[0-9a-f]{64}$/i.test(env[s.hash]??''))throw Error(s.hash+' auditado ausente');}
 const providers:ProviderMorphoRpc[]=[];
 try{
  if(!rpcs){
   if(!env.MEGAZORD_RPC_URL||!env.MEGAZORD_RPC_SECUNDARIO||env.MEGAZORD_RPC_URL===env.MEGAZORD_RPC_SECUNDARIO)
    throw Error('dois RPCs independentes obrigatorios');
   for(const u of [env.MEGAZORD_RPC_URL,env.MEGAZORD_RPC_SECUNDARIO])providers.push(new ProviderMorphoRpc(u));
   rpcs=providers.map(p=>(m:string,a:unknown[])=>p.send(m,a)) as [Rpc,Rpc];
  }
  const block=await rpcs[0]('eth_getBlockByNumber',['latest',false]);
  if(!block?.hash||!block.number)throw Error('bloco ausente');
  const reports=[];
  for(const rpc of rpcs){
   if(BigInt(await rpc('eth_chainId',[]))!==8453n)throw Error('RPC fora da Base');
   const other=await rpc('eth_getBlockByNumber',[block.number,false]);
   if(other?.hash!==block.hash)throw Error('RPCs divergem no hash do bloco');
   const read=async(address:string,method:string,args:unknown[]=[])=>abi.decodeFunctionResult(method,
    await rpc('eth_call',[{to:address,data:abi.encodeFunctionData(method,args)},block.number]))[0];
   const contracts=[];
   for(const spec of specs){
    const address=getAddress(env[spec.key]!);
    const code=await rpc('eth_getCode',[address,block.number]);
    if(code==='0x'||keccak256(code).toLowerCase()!==env[spec.hash]!.toLowerCase())throw Error(spec.key+': bytecode diverge');
    const invariants:Record<string,string>={};
    for(const [method,expected] of Object.entries(spec.checks)){
     if(!expected)continue;
     const actual=getAddress(await read(address,method));
     if(actual!==getAddress(expected))throw Error(spec.key+': '+method+' diverge');
     invariants[method]=actual;
    }
    if(spec.key!=='TITAN_V2_CONTRATO'&&await read(address,'versaoRotas')!==2n)
     throw Error(spec.key+': versao multihop ausente');
    contracts.push({variable:spec.key,address,codehash:keccak256(code),invariants});
   }
   const pools=[];
   if(env.TITAN_CPAMM_ATOMICO==='1'){
    const factories=JSON.parse(env.FLASH_ARB_CPAMM_FACTORIES??'[]') as Array<{endereco:string;poolCodeHash:string;taxaNumerador:number;taxaDenominador:number}>;
    const addresses=(env.TITAN_PREFLIGHT_POOLS??'').split(',').filter(Boolean);
    if(addresses.length!==2||new Set(addresses.map(a=>a.toLowerCase())).size!==2)throw Error('dois pools CPAMM reais obrigatorios');
    for(const address of addresses){
     getAddress(address);
     const factory=getAddress(await read(address,'factory'));
     const f=factories.find(x=>getAddress(x.endereco)===factory);
     if(!f||f.taxaNumerador!==997||f.taxaDenominador!==1000)throw Error('factory/taxa CPAMM nao auditada');
     const code=await rpc('eth_getCode',[address,block.number]);
     if(keccak256(code).toLowerCase()!==f.poolCodeHash.toLowerCase())throw Error('bytecode do pool diverge');
     const token0=await read(address,'token0'),token1=await read(address,'token1');
     if(getAddress(await read(factory,'getPair',[token0,token1]))!==getAddress(address))throw Error('pool nao pertence a factory');
     pools.push({address,factory,token0,token1,codehash:keccak256(code)});
    }
   }
   reports.push({contracts,pools});
  }
  if(JSON.stringify(reports[0])!==JSON.stringify(reports[1]))throw Error('identidades divergem entre RPCs');
  return {somenteLeitura:true,owner,block:block.number,blockHash:block.hash,...reports[0]};
 }finally{for(const p of providers)p.destroy();}
}
if(require.main===module)void auditarContratosMegazord(process.env).then(r=>console.log(JSON.stringify(r)))
 .catch(()=>{console.error('Auditoria publica incompleta: conferir enderecos, codehashes auditados e RPCs.');process.exitCode=1;});
