import {ProviderMorphoRpc} from './morphoProvider';
import {planejarRotasMorphoV3,combinarSondasMorpho} from './titanMorphoRotas';
import {comExecutorMegazord,carteiraMegazord,transmitirMegazord,contextoExecutorMegazord} from './megazordExecutor';
/**
 * TITAN Morpho V3: onchain candidate -> complete eth_call -> gas L1/L2 ->
 * enforced profit floor -> one signed tx (when expressly armed).
 *
 * No artificial loan principal: Morpho delivers seized collateral before
 * callback; the onchain contract swaps it and repays in the SAME transaction.
 * A paid revert still burns gas, which is why this path never broadcasts a
 * mere health estimate or quoter value.
 */
import fs from 'node:fs';
import {sondarMorphoEmLotes} from './titanMorphoSondas';
import path from 'node:path';
import {Interface,JsonRpcProvider,Wallet,getAddress,keccak256,ZeroAddress} from 'ethers';
import type {MercadoDaApi} from './morphoApi';
import {codificarIdToMarketParams,codificarMarket,codificarPosition,
  lerIdToMarketParams,lerMarket,lerPosition,apiConfereComACorrente} from './morphoApi';
import {examinarSaudeMorpho} from './titanMorphoRadar';
import {politicaMorphoV3,candidatoElegivelV3,custoConservadorMorphoV3,
  pisoEconomicoMorphoV3} from './titanMorphoV3Gate';
import {ORACULO_DE_GAS_L1,codificarTetoDeL1} from './custoDaBase';
import {FABRICA_V3_BASE,MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {COFRE_ESPERADO} from './caca';
import {motivoDoRevertMorpho,resumoRevertsMorpho} from './titanMorphoRevert';
import {tamanhosDeLiquidacaoMorpho,pontuacaoLiquidaMorpho} from './titanMorphoTamanhos';

const WETH='0x4200000000000000000000000000000000000006';
const ROUTER='0x2626664c2603336E57B271c5C0b26F421741e481';
const QUOTER='0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const executorAbi=new Interface([
  'function versaoRotas() view returns(uint256)',
  'function intermediarioPermitido(address) view returns(bool)',
  'function liquidarRota((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mercado,address devedor,uint256 seizedAssets,uint256 repaidShares,bytes rota,uint256 pisoLucroDivida,uint256 prazo) returns(uint256 lucro)',

  'function dono() view returns(address)',
  'function cofre() view returns(address)',
  'function morpho() view returns(address)',
  'function fabricaV3() view returns(address)',
  'function routerV3() view returns(address)',
  'function liquidar((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) mercado,address devedor,uint256 seizedAssets,uint256 repaidShares,uint24 taxa,uint256 pisoLucroDivida,uint256 prazo) returns(uint256 lucro)',
  'event MorphoLiquidadoV3(bytes32 indexed marketId,address indexed usuario,address indexed garantia,uint256 quantiaRepaid,uint256 lucroNaDivida)',
]);
const factoryAbi=new Interface(['function getPool(address,address,uint24) view returns(address)']);
const quoteAbi=new Interface([
  'function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
]);
const oracleAbi=new Interface(['function price() view returns(uint256)']);
type Entrada={mercado:MercadoDaApi;usuario:string;rpcUrl:string;signal?:AbortSignal};
type Resposta={status:'descartada'|'inviavel'|'aprovada-simulada'|'enviada'|'confirmada'|'revertida'|'desconhecida';motivo:string;hash?:string};
const cooldown=new Map<string,number>();
const elapsed=(key:string)=>{const t=cooldown.get(key)??0;return t>Date.now();};
const mark=(key:string,ms:number)=>cooldown.set(key,Date.now()+ms);

function same(a:string,b:string):boolean{
  return getAddress(a)===getAddress(b);
}
async function readAddress(p:JsonRpcProvider,contract:string,method:string):Promise<string>{
  const data=executorAbi.encodeFunctionData(method);
  return getAddress(executorAbi.decodeFunctionResult(method,await p.call({to:contract,data}))[0] as string);
}
/** Full-path QuoterV2 valuation. Missing conversion is unknown cost, never zero. */
const topologiasWeth=new WeakMap<JsonRpcProvider,Map<string,Promise<Awaited<ReturnType<typeof planejarRotasMorphoV3>>>>>();
export async function loanValueInWeth(p:JsonRpcProvider,token:string,amount:bigint):Promise<bigint|null>{
  if(amount<=0n)return null;
  if(same(token,WETH))return amount;
  let topologias=topologiasWeth.get(p);
  if(!topologias){topologias=new Map();topologiasWeth.set(p,topologias);}
  const chave=token.toLowerCase();
  if(!topologias.has(chave))topologias.set(chave,planejarRotasMorphoV3(token,WETH,true,async(a,b,f)=>{
    const r=await p.call({to:FABRICA_V3_BASE,data:factoryAbi.encodeFunctionData('getPool',[a,b,f])});
    const pool=factoryAbi.decodeFunctionResult('getPool',r)[0] as string;
    return !same(pool,ZeroAddress)&&await p.getCode(pool)!=='0x';
  },async()=>true));
  const rotas=await topologias.get(chave)!;
  // Quote the entire path in one EVM context, not multiplication of spot prices.
  const valores:bigint[]=[];
  for(const rota of rotas){
    try{
      const r=await p.call({to:QUOTER,data:quoteAbi.encodeFunctionData('quoteExactInput',[rota.path,amount])});
      const v=quoteAbi.decodeFunctionResult('quoteExactInput',r)[0] as bigint;
      if(v>0n)valores.push(v);
    }catch{/* Unknown quote never means zero gas or a valid route. */}
  }
  // Best executable whole-path quote; the 80% enforceable floor is valued again.
  if(valores.length)return valores.reduce((a,b)=>a>b?a:b);
  return null;
}
async function validateExecutor(p:JsonRpcProvider,addr:string,owner:string):Promise<void>{
  if(await p.getCode(addr)==='0x')throw Error('executor Morpho V3 sem bytecode na Base');
  for(const [method,expected] of [
    ['dono',owner],['cofre',COFRE_ESPERADO],
    ['morpho',MORPHO_FLASH_BASE],['routerV3',ROUTER],['fabricaV3',FABRICA_V3_BASE],
  ]){
    if(!same(await readAddress(p,addr,method),expected))
      throw Error('executor Morpho V3 diverge no imutavel '+method);
  }
}
function journalPath(env:NodeJS.ProcessEnv):string{
  const j=env.CACA_MORPHO_V3_JOURNAL??'/app/data/titanMorphoV3Tx.json';
  if(!j.startsWith('/app/data/')||j.includes('..'))throw Error('journal V3 fora do volume persistente');
  return j;
}
async function reserveJournal(
  p:JsonRpcProvider,file:string,hash:string,nonce:number,
):Promise<void>{
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)){
    let old:{hash?:string;nonce?:number};
    try{old=JSON.parse(fs.readFileSync(file,'utf8')) as typeof old;}
    catch{throw Error('journal Morpho V3 ilegivel; bloquear ate reconciliar');}
    if(!old.hash||!/^0x[0-9a-fA-F]{64}$/.test(old.hash))
      throw Error('journal anterior sem hash reconciliavel');
    const rec=await p.getTransactionReceipt(old.hash);
    if(!rec)throw Error('transacao anterior ainda sem recibo; nao duplicar');
    // We only permit the next tx after a conclusive onchain receipt.
    const previousNonce=await p.getTransactionCount(rec.from,'latest');
    if(old.nonce===undefined||previousNonce<=old.nonce)
      throw Error('nonce anterior ainda nao reconciliado');
    fs.unlinkSync(file);
  }
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify({hash,nonce,em:new Date().toISOString(),status:'reservado'}));fs.fsyncSync(fd);}
  finally {fs.closeSync(fd);}
}
/**
 * Called for a crossed or nearby risk candidate (bounded read-only accrual probes), from the scanner worker.
 * It re-reads EVERYTHING onchain, so stale API/shares cannot authorize a tx.
 * Throws are converted into read-only diagnostic; no paid attempt without proof.
 */
async function avaliarELiquidarMorphoV3Interno(
  e:Entrada, env:NodeJS.ProcessEnv=process.env,
):Promise<Resposta>{
  const key=e.mercado.id.toLowerCase()+':'+e.usuario.toLowerCase();
  if(elapsed(key))return{status:'descartada',motivo:'cooldown de posicao ja analisada'};
  mark(key,10_000);
  const policy=politicaMorphoV3(env);
  if(!e.mercado.confirmadoNaCorrente)return{status:'descartada',motivo:'mercado sem identidade onchain confirmada'};
  const contrato=env.CACA_MORPHO_V3_CONTRATO;
  // Production CACA has a private key, but historically no public address env.
  // Derive the public address LOCALLY from the existing key; never log the key.
  const chave=env.CACA_CHAVE_PRIVADA;
  const dono=env.CACA_ENDERECO_PUBLICO??(chave?new Wallet(chave).address:undefined);
  if(!contrato||!dono)
    return{status:'descartada',motivo:'executor V3, carteira ou identificacao publica indisponivel'};
  const p=new ProviderMorphoRpc(e.rpcUrl,e.signal);
  let hash:string|undefined;
  try{
    const addr=getAddress(contrato),owner=getAddress(dono);
    const user=getAddress(e.usuario);
    if(BigInt(await p.send('eth_chainId',[]))!==8453n)throw Error('RPC nao e Base 8453');
    await validateExecutor(p,addr,owner);
    const block=await p.getBlock('latest');
    if(!block?.baseFeePerGas||block.baseFeePerGas<=0n)throw Error('baseFee nao mensuravel');
    const tag=block.number;
    const baseFee=block.baseFeePerGas;
    const raw=await p.call({to:MORPHO_FLASH_BASE,data:codificarIdToMarketParams(e.mercado.id),blockTag:tag});
    const params=lerIdToMarketParams(raw);
    if(!apiConfereComACorrente(e.mercado,params).confere||!params)
      return{status:'descartada',motivo:'API divergiu da Base neste mercado'};
    const [posRaw,marketRaw,oracleRaw]=await Promise.all([
      p.call({to:MORPHO_FLASH_BASE,data:codificarPosition(e.mercado.id,user),blockTag:tag}),
      p.call({to:MORPHO_FLASH_BASE,data:codificarMarket(e.mercado.id),blockTag:tag}),
      p.call({to:params.oracle,data:oracleAbi.encodeFunctionData('price'),blockTag:tag}),
    ]);
    const pos=lerPosition(posRaw),market=lerMarket(marketRaw);
    if(!pos||!market)return{status:'descartada',motivo:'posicao/mercado indecodificavel'};
    const price=oracleAbi.decodeFunctionResult('price',oracleRaw)[0] as bigint;
    const risk=examinarSaudeMorpho({borrowShares:pos.borrowShares,collateral:pos.collateral,
      totalBorrowAssets:market.totalBorrowAssets,totalBorrowShares:market.totalBorrowShares,
      precoOracle:price,lltvWad:BigInt(params.lltv.mul('1e18').toFixed(0))});
    if(!candidatoElegivelV3(risk.situacao,true))
      return{status:'descartada',motivo:'posicao nao liquidavel segundo snapshot onchain: '+risk.situacao};
    if(pos.borrowShares<=0n)return{status:'descartada',motivo:'shares de divida zero'};
    const marketTuple=[params.loanToken,params.collateralToken,params.oracle,
      params.irm,BigInt(params.lltv.mul('1e18').toFixed(0))] as const;
    const suportaMultihop=await p.call({to:addr,data:executorAbi.encodeFunctionData('versaoRotas')})
      .then(r=>BigInt(r)===2n).catch(()=>false);
    const permitido=async(token:string)=>{
      const r=await p.call({to:addr,data:executorAbi.encodeFunctionData('intermediarioPermitido',[token])});
      return executorAbi.decodeFunctionResult('intermediarioPermitido',r)[0]===true;
    };
    const rotas=await planejarRotasMorphoV3(params.collateralToken,params.loanToken,suportaMultihop,
      async(a,b,f)=>{
        const r=await p.call({to:FABRICA_V3_BASE,data:factoryAbi.encodeFunctionData('getPool',[a,b,f])});
        const pool=factoryAbi.decodeFunctionResult('getPool',r)[0] as string;
        return !same(pool,ZeroAddress)&&await p.getCode(pool)!=='0x';
      },permitido);
    type Rota=typeof rotas[number];
    const montar=(shares:bigint,rota:Rota,piso:bigint,prazo:bigint)=>{
      const metodo=rota.taxas.length>1?'liquidarRota':'liquidar';
      return{metodo,data:executorAbi.encodeFunctionData(metodo,[marketTuple,user,0n,shares,
        metodo==='liquidarRota'?rota.path:(rota.taxas[0]??100),piso,prazo])};
    };
    if(rotas.length===0)return{status:'inviavel',motivo:suportaMultihop
      ?'sem rota direta ou multihop comprovada garantia -> divida'
      :'rota_nao_suportada: sem pool direta; executor implantado sem suporte multihop'};
    type Sonda={data:string;profit:bigint;shares:bigint;rota:Rota;estimated:bigint;score:bigint};
    let best:Sonda|null=null;
    const falhas=new Map<string,number>();
    const amounts=tamanhosDeLiquidacaoMorpho({
      borrowShares:pos.borrowShares,collateral:pos.collateral,
      estimatedDebtAssets:risk.dividaCrua??0n,oraclePrice:price,
      lltvWad:BigInt(params.lltv.mul('1e18').toFixed(0)),
    });
    if(amounts.length===0)return{status:'inviavel',
      motivo:'garantia insuficiente para qualquer parcela segura de divida'};
    const combinacoes=combinarSondasMorpho(rotas,amounts,risk.situacao==='proxima');
    const sondas=await sondarMorphoEmLotes(combinacoes,async({shares,rota}):Promise<Sonda|null>=>{
        const {data,metodo}=montar(shares,rota,1n,BigInt(block.timestamp+90));
        try{
          const ret=await p.call({to:addr,from:owner,data,blockTag:tag});
          const profit=executorAbi.decodeFunctionResult(metodo,ret)[0] as bigint;
          if(profit<=1n)return null;
          const gross=await loanValueInWeth(p,params.loanToken,profit);
          if(gross===null||gross<=0n)return null;
          const estimated=await p.estimateGas({to:addr,from:owner,data});
          // Rank by conservative WETH NET, not the gross surplus.
          const score=pontuacaoLiquidaMorpho(gross,estimated,
            baseFee,policy.tipWei,policy.maxGas);
          if(score===null||score<=0n)return null;
          return {data,profit,shares,rota,estimated,score};
        }catch(err){
          const reason=motivoDoRevertMorpho(err);
          falhas.set(reason,(falhas.get(reason)??0)+1);
          // A reversao de eth_call nao autoriza transacao paga.
          return null;
        }
    });
    // Deterministic selection after every read-only probe has settled. The
    // existing single-signer director and final proof still govern the shot.
    for(const sonda of sondas){
      if(sonda.status!=='fulfilled'||!sonda.value)continue;
      const candidate=sonda.value;
      if(!best||candidate.score>best.score)best=candidate;
    }
    if(!best){mark(key,60_000);
      return{status:'inviavel',motivo:'nenhuma rota passou no liquidar() integral do executor (eth_call): '+resumoRevertsMorpho(falhas)};}
    const len=Math.ceil((best.data.length-2)/2);
    const l1=BigInt(await p.call({to:ORACULO_DE_GAS_L1,data:codificarTetoDeL1(len)}));
    const pricedBlock=await p.getBlock('latest');
    if(!pricedBlock?.baseFeePerGas||pricedBlock.baseFeePerGas<=0n)
      throw Error('baseFee faltou antes da avaliacao economica');
    const feePlan=custoConservadorMorphoV3(best.estimated,pricedBlock.baseFeePerGas,
      policy.tipWei,l1,policy);
    const minimumToken=(best.profit*80n)/100n;
    const floorEth=await loanValueInWeth(p,params.loanToken,minimumToken);
    const economic=pisoEconomicoMorphoV3(best.profit,floorEth??0n,feePlan.custo,policy);
    if(!economic.aprovado){mark(key,30_000);
      return{status:'inviavel',motivo:'piso de lucro nao cobre gas L1+L2 com margem em WETH'};}
    const finalData=montar(best.shares,best.rota,economic.pisoToken,BigInt(pricedBlock.timestamp+90)).data;
    // The enforceable floor itself must also pass, not just floor=1.
    await p.call({to:addr,from:owner,data:finalData});
    // A long multifee search can span many two-second Base blocks. The final
    // proof is against LATEST, so its freshness is measured from pricedBlock,
    // not from the older pinned discovery snapshot.
    const nowBlock=await p.getBlockNumber();
    if(nowBlock>pricedBlock.number+policy.maxAgeBlocks)
      return{status:'descartada',motivo:'bloco mudou depois do preflight final'};
    if(!policy.armed)return{status:'aprovada-simulada',
      motivo:'callback V3+lucro e gas verificados; falta autorizacao exclusiva de envio'};
    if(!chave)throw Error('chave do CACA indisponivel');
    const wallet=carteiraMegazord(chave,p);
    if(!same(wallet.address,owner))throw Error('signer difere de owner');
    const latest=await p.getTransactionCount(owner,'latest');
    const pending=await p.getTransactionCount(owner,'pending');
    if(latest!==pending)throw Error('nonce pendente de outra transacao; tiro abortado');
    if(await p.getBalance(owner)<feePlan.custo)throw Error('saldo insuficiente para pior gas');
    // Revalidate exact transaction and current nonce before signing.
    const blk2=await p.getBlock('latest');
    if(!blk2||blk2.number!==nowBlock||blk2.number>pricedBlock.number+policy.maxAgeBlocks
      ||!blk2.baseFeePerGas||blk2.baseFeePerGas>pricedBlock.baseFeePerGas)
      throw Error('bloco trocou antes do tiro');
    await p.call({to:addr,from:owner,data:finalData});
    if(await p.getTransactionCount(owner,'pending')!==pending)
      throw Error('nonce mudou na revalidacao');
    const tx={chainId:8453,type:2 as const,nonce:pending,to:addr,data:finalData,
      gasLimit:feePlan.gasLimit,maxFeePerGas:feePlan.maxFee,
      maxPriorityFeePerGas:policy.tipWei,value:0n};
    const signed=await wallet.signTransaction(tx);
    hash=keccak256(signed);
    await reserveJournal(p,journalPath(env),hash,pending);
    const sent=await transmitirMegazord(p,signed);
    if(!sameHash(sent.hash,hash))throw Error('broadcast retornou hash divergente');
    const receipt=await sent.wait(1,60_000);
    if(!receipt)return{status:'enviada',hash,motivo:'sem recibo: journal deve reconciliar; nao reenviar'};
    if(receipt.status!==1)return{status:'revertida',hash,motivo:'tx revertida; gasto real de gas'};
    const ev=receipt.logs.map(l=>{try{return executorAbi.parseLog(l);}catch{return null;}})
      .find(l=>l?.name==='MorphoLiquidadoV3');
    return{status:'confirmada',hash,motivo:ev
      ? 'recibo status=1 e evento MorphoLiquidadoV3: lucro em loan token '+String(ev.args[4])
      : 'recibo status=1 sem evento de lucro: conferir antes de afirmar ganho'};
  }catch(err){
    return{status:hash?'desconhecida':'inviavel',hash,
      motivo:hash?'tx reservada possivelmente transmitida: reconciliar hash, nao reenviar'
        : (err instanceof Error?err.message.slice(0,200):'erro desconhecido de preflight')};
  }finally{p.destroy();}
}
function sameHash(a:string,b:string){return a.toLowerCase()===b.toLowerCase();}

export async function avaliarELiquidarMorphoV3(...args:Parameters<typeof avaliarELiquidarMorphoV3Interno>):ReturnType<typeof avaliarELiquidarMorphoV3Interno>{
 return comExecutorMegazord('liquidacao-morpho-v3',()=>avaliarELiquidarMorphoV3Interno(...args));
}
