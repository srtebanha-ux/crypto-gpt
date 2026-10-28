/** One-process, one-wallet dispatcher. No network activity on import. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Wallet,Transaction,keccak256,computeAddress,JsonRpcProvider,id,
 type TransactionRequest,type TransactionResponse} from 'ethers';
import {ORACULO_DE_GAS_L1,codificarTetoDeL1} from './custoDaBase';
import {COFRE_ESPERADO} from './caca';
import {consultarEthUsdBase} from './megazordEthUsd';
import {normalizarChaveMegazord,resolverChaveMegazord,
 normalizarCredenciaisMegazord} from './megazordCredenciais';

type Log={address:string;topics:readonly string[];data:string};
type Receipt={status:number|null;blockNumber:number;logs?:readonly Log[]};
export interface RedeMegazord {
 getNetwork():Promise<{chainId:bigint}>;
 getBlock(tag:string):Promise<{number:number;timestamp:number}|null>;
 getTransactionCount(address:string,tag:string):Promise<number>;
 getTransactionReceipt(hash:string):Promise<Receipt|null>;
 call(tx:TransactionRequest):Promise<string>;
 broadcastTransaction(raw:string):Promise<TransactionResponse>;
}
type Pending={hash:string;nonce:number;strategy:string;day:string;reservedWei:string;to?:string};
type Journal={version:1;address:string;pending:Pending|null;
 days:Record<string,{reservedWei:string;creditedWei?:string;attempts:number}>;
 receipts:Array<Pending&{status:number;block:number}>};
export type PoliticaMegazord={journal:string;maxDailyWei:bigint;maxPerTxWei:bigint;
 maxDailyTx:number;contracts:readonly string[];canaryUntilMs?:number};

/** Conservatively value USDC earnings in WETH wei using two independently
 * verified 30-minute onchain ETH/USDC TWAPs. Never assume USD peg.
 * A price disagreement greater than 1%, invalid oracle or wrong token denies credit.
 */
export function usdcEmWethWeiConservador(amount:bigint,twaps:readonly [string,string]):bigint{
 if(amount<=0n)return 0n;
 const parsed=twaps.map(q=>{
   if(!/^[0-9]{3,6}\.[0-9]{12}$/.test(q))throw Error('ETH/USDC: TWAP invalido');
   const [whole,frac]=q.split('.');
   const n=BigInt(whole!)*1000000000000n+BigInt(frac!);
   if(n<500000000000000n||n>100000000000000000n)
     throw Error('ETH/USDC: cotacao fora da faixa');
   return n;
 });
 const high=parsed[0]!>parsed[1]!?parsed[0]!:parsed[1]!;
 const low=parsed[0]!<parsed[1]!?parsed[0]!:parsed[1]!;
 if(high*100n>low*101n)throw Error('ETH/USDC: oraculos divergem');
 // 6 decimal USDC; price in USDC/WETH with 12 decimal fixed point.
 // Choose the HIGHEST ETH price (smallest WETH equivalent) and
 // haircut 5% to absorb intra-block volatility/route friction.
 return amount*1000000000000000000000000n*95n/(high*100n);
}
/** Both independent receipts must report the SAME canonical ERC20 transfer
 * from the exact called executor to the immutable treasury. An EVM success
 * by itself never establishes distributable profits.
 */
export function creditoGasComprovado(
 pending:Pending,r:Receipt,other:Receipt|null,twaps?:readonly [string,string],
):bigint{
 const cost=BigInt(pending.reservedWei);
 if(r.status!==1||other?.status!==1||r.blockNumber!==other.blockNumber
   ||!pending.to||!r.logs||!other.logs||cost<=0n)return 0n;
 const transfer=id('Transfer(address,address,uint256)').toLowerCase();
 const topic=(address:string)=>'0x'+address.toLowerCase().slice(2).padStart(64,'0');
 const total=(receipt:Receipt,token:string)=>{
   let sum=0n;
   for(const l of receipt.logs??[]){
     if(l.address.toLowerCase()!==token
       ||l.topics.length!==3||l.topics[0]?.toLowerCase()!==transfer
       ||l.topics[1]?.toLowerCase()!==topic(pending.to!)
       ||l.topics[2]?.toLowerCase()!==topic(COFRE_ESPERADO)
       ||!/^0x[0-9a-f]{64}$/i.test(l.data))continue;
     sum+=BigInt(l.data);
   }
   return sum;
 };
 const weth='0x4200000000000000000000000000000000000006';
 const usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
 const weth0=total(r,weth),weth1=total(other,weth);
 if(weth0>0n&&weth0===weth1&&weth0>=cost*2n)return cost;
 // Only canonical Base USDC has a proven WETH/USDC reference pool.
 // Other stablecoin contracts need their OWN independently validated oracle.
 if(!twaps)return 0n;
 const usdc0=total(r,usdc),usdc1=total(other,usdc);
 if(usdc0<=0n||usdc0!==usdc1)return 0n;
 try {
   return usdcEmWethWeiConservador(usdc0,twaps)>=cost*2n?cost:0n;
 }catch{return 0n;}
}

export class ExecutorMegazord {
 private tail:Promise<unknown>=Promise.resolve();
 private context=new AsyncLocalStorage<{strategy:string;token:string}>();
 private currentToken:string|null=null;
 private sending:Promise<unknown>=Promise.resolve();
 private queued=0;
 private closed=false;
 private token=randomUUID();
 private lock:string;
 private signer:Wallet;
 private state:Journal;
 constructor(key:string,private primary:RedeMegazord,private secondary:RedeMegazord,
   private policy:PoliticaMegazord,private l1Upper:(raw:string)=>Promise<bigint>,
   private onchainUsdcTwaps?:()=>Promise<readonly [string,string]>){
   this.signer=new Wallet(normalizarChaveMegazord(key));
   if(policy.maxDailyWei<=0n||policy.maxPerTxWei<=0n||policy.maxPerTxWei>policy.maxDailyWei
     ||!Number.isSafeInteger(policy.maxDailyTx)||policy.maxDailyTx<1
     ||policy.contracts.length===0||policy.contracts.some(x=>!/^0x[0-9a-f]{40}$/i.test(x)))
     throw Error('politica Megazord invalida');
   this.lock=policy.journal+'.lock';
   // Missing parent directories can be created. Never use /tmp fallback
   // for an exclusive, real-money nonce journal.
   try{fs.mkdirSync(path.dirname(policy.journal),{recursive:true});}
   catch{throw Error('diario persistente indisponivel; envio bloqueado');}
   this.acquire();
   try{
     this.state=fs.existsSync(policy.journal)
       ?JSON.parse(fs.readFileSync(policy.journal,'utf8')) as Journal
       :{version:1,address:this.signer.address,pending:null,days:{},receipts:[]};
     this.validate();
   }catch(e){this.close();throw e;}
 }
 get address():string{return this.signer.address;}
 get inContext():boolean{return this.currentToken!==null
   &&this.context.getStore()?.token===this.currentToken&&!this.closed;}
 private acquire():void{
   try{
     const fd=fs.openSync(this.lock,'wx',0o600);
     try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,host:os.hostname(),token:this.token}));
       fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   }catch(e){
     // Never guess lock ownership across hosts or steal a live PID's lock.
     // Crash recovery first requires the operator to remove a verified stale
     // lock; persisted pending hashes are still reconciled before any send.
     throw Error('executor ja reservado ou lock precisa de recuperacao manual');
   }
 }
 private validate():void{
   const s=this.state;
   if(s.version!==1||s.address?.toLowerCase()!==this.address.toLowerCase()
     ||!s.days||!Array.isArray(s.receipts))throw Error('diario Megazord invalido');
   for(const d of Object.values(s.days))if(!/^\d+$/.test(d.reservedWei)
     ||(d.creditedWei!==undefined&&(!/^\d+$/.test(d.creditedWei)
         ||BigInt(d.creditedWei)>BigInt(d.reservedWei)))
     ||!Number.isSafeInteger(d.attempts)||d.attempts<0)throw Error('orcamento persistido invalido');
   if(s.pending&&(!/^0x[0-9a-f]{64}$/i.test(s.pending.hash)
     ||!Number.isSafeInteger(s.pending.nonce)||s.pending.nonce<0))throw Error('pendencia invalida');
 }
 private persist(next:Journal):void{
   const tmp=this.policy.journal+'.'+this.token+'.tmp';
   const fd=fs.openSync(tmp,'w',0o600);
   try{fs.writeFileSync(fd,JSON.stringify(next));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   fs.renameSync(tmp,this.policy.journal);
   const dir=fs.openSync(path.dirname(this.policy.journal),'r');
   try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
   this.state=next;
 }
 async reconcile():Promise<void>{
   const p=this.state.pending;
   if(p){
     const r=await this.primary.getTransactionReceipt(p.hash);
     if(!r||r.status===null)throw Error('resultado pendente: reconciliar '+p.hash);
     if(r.status!==0&&r.status!==1)throw Error('status de recibo invalido');
     const next=structuredClone(this.state);next.pending=null;
     const secondary=await this.secondary.getTransactionReceipt(p.hash).catch(()=>null);
     // No external read is needed for native WETH. USDC credit is optional:
     // oracle failure cannot turn a successful receipt into free gas.
     let credit=creditoGasComprovado(p,r,secondary);
     if(credit===0n&&this.onchainUsdcTwaps){
       const twaps=await this.onchainUsdcTwaps().catch(()=>null);
       if(twaps)credit=creditoGasComprovado(p,r,secondary,twaps);
     }
     if(credit>0n){
       const day=next.days[p.day];
       if(!day)throw Error('registro diario ausente para credito de gas');
       day.creditedWei=String(BigInt(day.creditedWei??'0')+credit);
     }
     next.receipts.push({...p,status:r.status,block:r.blockNumber});
     next.receipts=next.receipts.slice(-200);this.persist(next);
   }
   // Revert consome gas e pode ser sintoma de contrato/rota incorreta.
   // Nunca repetir tentativas em piloto automatico apos uma falha on-chain,
   // inclusive se o processo reiniciou e o recibo ja estava no diario.
   if(this.state.receipts.some(x=>x.status===0))
     throw Error('circuit breaker Megazord: recibo revertido; revisar diario e execucao antes de novos envios');
 }
 async run<T>(strategy:string,work:()=>Promise<T>):Promise<T>{
   if(this.closed)throw Error('executor fechado');
   if(this.inContext)return work();
   if(this.queued>=64)throw Error('fila Megazord cheia');
   this.queued++;
   const task=this.tail.then(async()=>{
     if(this.closed)throw Error('executor fechado');
     await this.reconcile();
     const token=randomUUID();this.currentToken=token;
     try{return await this.context.run({strategy,token},work);}
     finally{this.currentToken=null;}
   });
   this.tail=task.catch(()=>{});
   try{return await task;}finally{this.queued--;}
 }
 private conferirCanario():void{
   if(this.policy.canaryUntilMs===undefined)return;
   if(!Number.isFinite(this.policy.canaryUntilMs)||Date.now()>=this.policy.canaryUntilMs)
     throw Error('canario expirado');
   if(Object.values(this.state.days).some(d=>d.attempts>0))
     throw Error('canario ja consumiu sua unica tentativa persistente');
 }
 private async nonceLivre():Promise<number>{
   const inspect=async(p:RedeMegazord)=>{
     const [net,b,latest,pending]=await Promise.all([p.getNetwork(),p.getBlock('latest'),
       p.getTransactionCount(this.address,'latest'),p.getTransactionCount(this.address,'pending')]);
     if(net.chainId!==8453n||!b||Math.abs(Date.now()/1000-b.timestamp)>20
       ||latest!==pending)throw Error('rede, bloco ou nonce nao liberado');
     return {nonce:latest,block:b.number};
   };
   const [a,b]=await Promise.all([inspect(this.primary),inspect(this.secondary)]);
   if(a.nonce!==b.nonce||Math.abs(a.block-b.block)>3)throw Error('RPCs discordam sobre nonce/bloco');
   return a.nonce;
 }
 async sign(tx:TransactionRequest):Promise<string>{
   if(!this.inContext)throw Error('assinatura fora da fila Megazord');
   this.conferirCanario();
   return this.signer.signTransaction(tx);
 }
 async broadcast(raw:string):Promise<TransactionResponse>{
   if(!this.inContext)throw Error('envio fora da fila Megazord');
   const task=this.sending.then(()=>this.broadcastLocked(raw));
   this.sending=task.catch(()=>{});return task;
 }
 private async broadcastLocked(raw:string):Promise<TransactionResponse>{
   if(!this.inContext)throw Error('contexto de envio expirou');
   await this.reconcile();
   this.conferirCanario();
   const tx=Transaction.from(raw);
   if(tx.from?.toLowerCase()!==this.address.toLowerCase()||tx.chainId!==8453n
     ||tx.type!==2||tx.value!==0n||!tx.to||tx.data==='0x'
     ||!this.policy.contracts.some(a=>a.toLowerCase()===tx.to!.toLowerCase())
     ||tx.gasLimit<=0n||!tx.maxFeePerGas||tx.maxFeePerGas<=0n)
     throw Error('transacao fora da politica Megazord');
   if(tx.nonce!==await this.nonceLivre())throw Error('nonce envelheceu na fila');
   const request={from:this.address,to:tx.to,data:tx.data,value:0n,gasLimit:tx.gasLimit};
   await this.primary.call(request); // Full final calldata; contract enforces profit floor.
   const l1=await this.l1Upper(raw);
   if(l1<=0n)throw Error('custo L1 desconhecido');
   const cost=tx.gasLimit*tx.maxFeePerGas+2n*l1;
   const day=new Date().toISOString().slice(0,10);
   const used=this.state.days[day]??{reservedWei:'0',attempts:0};
   const uncovered=BigInt(used.reservedWei)-BigInt(used.creditedWei??'0');
   if(cost>this.policy.maxPerTxWei||uncovered+cost>this.policy.maxDailyWei
     ||used.attempts>=this.policy.maxDailyTx)throw Error('orcamento global Megazord excedido');
   if(tx.nonce!==await this.nonceLivre())throw Error('nonce mudou no pre-broadcast');
   this.conferirCanario(); // deadline may expire while RPC preflight runs
   const next=structuredClone(this.state),hash=keccak256(raw);
   next.pending={hash,nonce:tx.nonce,strategy:this.context.getStore()!.strategy,
     day,reservedWei:String(cost),to:tx.to};
   next.days[day]={reservedWei:String(BigInt(used.reservedWei)+cost),
     creditedWei:used.creditedWei??'0',attempts:used.attempts+1};
   this.persist(next); // Durable reservation BEFORE network side effect.
   const sent=await this.primary.broadcastTransaction(raw);
   if(sent.hash.toLowerCase()!==hash.toLowerCase())throw Error('hash RPC divergente');
   return sent;
 }
 wallet(key:string,provider?:JsonRpcProvider):Wallet{
   key=normalizarChaveMegazord(key);
   if(computeAddress(key).toLowerCase()!==this.address.toLowerCase())
     throw Error('Megazord exige a mesma carteira em todos os motores');
   const target=provider?this.signer.connect(provider):this.signer;
   return new Proxy(target,{
     get:(t,k)=>{
       if(k==='signTransaction')return (tx:TransactionRequest)=>this.sign(tx);
       if(k==='connect')return (p:JsonRpcProvider)=>this.wallet(key,p);
       if(k==='sendTransaction')return (tx:TransactionRequest)=>this.run('liquidacao-aave',async()=>{
         if(!provider)throw Error('provider ausente');
         const nonce=await this.nonceLivre();
         if(tx.nonce!==undefined&&Number(tx.nonce)!==nonce)throw Error('nonce Aave envelheceu');
         const prepared=await target.populateTransaction({...tx,nonce,chainId:8453,type:2});
         const raw=await this.sign(prepared),sent=await this.broadcast(raw);
         // The shared nonce stays reserved until receipt or UNKNOWN.
         await sent.wait(1,60_000);return sent;
       });
       const value=Reflect.get(t,k,t);return typeof value==='function'?value.bind(t):value;
     },
   });
 }
 close():void{
   if(this.closed)return;this.closed=true;
   // Never free the lifetime lock while asynchronous work can still run.
   if(this.queued>0)return;
   try{const lock=JSON.parse(fs.readFileSync(this.lock,'utf8'));
     if(lock.token===this.token)fs.unlinkSync(this.lock);}catch{/* retain uncertain ownership */}
 }
}

let active:ExecutorMegazord|undefined;
export function executorMegazordInstalado():boolean{return active!==undefined;}
export function contextoExecutorMegazord():boolean{return active?.inContext??false;}
export function comExecutorMegazord<T>(strategy:string,work:()=>Promise<T>):Promise<T>{
 return active?active.run(strategy,work):work();
}
export function carteiraMegazord(key:string,provider?:JsonRpcProvider):Wallet{
 return active?active.wallet(key,provider):new Wallet(normalizarChaveMegazord(key),provider);
}
export function transmitirMegazord(rpc:JsonRpcProvider,raw:string):Promise<TransactionResponse>{
 return active?active.broadcast(raw):rpc.broadcastTransaction(raw);
}
/** Independent of network: validates the EXISTING wallet and persistent journal. */
export function conferirIdentidadeMegazord(env:NodeJS.ProcessEnv):{address:string;journal:string}{
 const key=resolverChaveMegazord(env);
 const journal=env.MEGAZORD_DIARIO;
 const expected=env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO;
 if(!key||!expected||!/^0x[0-9a-f]{40}$/i.test(expected))
   throw Error('carteira publica e credencial do Megazord obrigatorias');
 // Railway uses /app/data for the mounted durable volume. An ephemeral file
 // silently loses nonce reservations on redeploy, causing duplicate sends.
 if(!journal||!path.isAbsolute(journal)||!path.resolve(journal).startsWith('/app/data/')
   ||!journal.endsWith('.json')||path.basename(journal)==='.json')
   throw Error('diario Megazord deve estar no volume persistente /app/data/*.json');
 let address:string;
 try{address=computeAddress(key);}catch{throw Error('credencial Megazord invalida');}
 if(address.toLowerCase()!==expected.toLowerCase())
   throw Error('chave nao corresponde ao endereco PUBLICO autorizado da carteira existente');
 return {address,journal};
}
/** Railway terminates workers with SIGTERM, not a normal JS exit.
 * Releasing lock is synchronous and token-checked; when a transaction
 * callback is still running close() retains it for manual reconciliation.
 */
export function instalarEncerramentoMegazord(
 executor:Pick<ExecutorMegazord,'close'>,
 processo:Pick<NodeJS.Process,'once'|'exit'>=process,
):void{
 let encerrado=false;
 const liberar=()=>{
  if(encerrado)return;
  encerrado=true;
  executor.close();
 };
 processo.once('exit',liberar);
 for(const sinal of ['SIGTERM','SIGINT'] as const){
  processo.once(sinal,()=>{
   liberar();
   processo.exit(0);
  });
 }
}

export function instalarExecutorMegazord(env:NodeJS.ProcessEnv):ExecutorMegazord{
 if(active)throw Error('executor Megazord ja instalado');
 if(env.MEGAZORD_CONFIRMAR!=='OPERAR_BASE_REAL'||env.MEGAZORD_EXCLUSIVO!=='1')
   throw Error('executor requer confirmacao e desligamento dos assinadores antigos');
 normalizarCredenciaisMegazord(env);
 conferirOrcamentoMegazord(env);
 const {journal:file}=conferirIdentidadeMegazord(env);
 const key=env.MEGAZORD_CHAVE_PRIVADA!;
 if(!env.MEGAZORD_RPC_URL||!env.MEGAZORD_RPC_SECUNDARIO
   ||env.MEGAZORD_RPC_URL===env.MEGAZORD_RPC_SECUNDARIO)throw Error('configuracao Megazord incompleta');
 if(env.TITAN_SNOWBALL_REINVESTIR==='1')throw Error('reinvestimento precisa de migracao separada');
 const p=new JsonRpcProvider(env.MEGAZORD_RPC_URL);
 const s=new JsonRpcProvider(env.MEGAZORD_RPC_SECUNDARIO);
 try{
   active=new ExecutorMegazord(key,p,s,{
     canaryUntilMs:env.MEGAZORD_CANARIO_ATE_UTC?Date.parse(env.MEGAZORD_CANARIO_ATE_UTC):undefined,
     journal:file,maxDailyWei:BigInt(env.MEGAZORD_GAS_MAX_DIA_WEI??'2000000000000000'),
     maxPerTxWei:BigInt(env.MEGAZORD_GAS_MAX_TX_WEI??'0'),
     maxDailyTx:Number(env.MEGAZORD_MAX_TX_DIA??'0'),
     contracts:(env.MEGAZORD_CONTRATOS??'').split(',').map(x=>x.trim()).filter(Boolean),
   },async raw=>BigInt(await p.call({to:ORACULO_DE_GAS_L1,
     data:codificarTetoDeL1((raw.length-2)/2)})),
     async():Promise<readonly [string,string]>=>{
       const [p0,p1]=await Promise.all([consultarEthUsdBase(p),consultarEthUsdBase(s)]);
       return [p0,p1] as const;
     });
 }catch(e){p.destroy();s.destroy();throw e;}
 const executor=active;
 instalarEncerramentoMegazord(executor);
 return executor;
}

/** Check spending policy before any optional paid contract deployment. */
export function conferirOrcamentoMegazord(env:NodeJS.ProcessEnv):void{
 const daily=env.MEGAZORD_GAS_MAX_DIA_WEI??'2000000000000000';
 const perTx=env.MEGAZORD_GAS_MAX_TX_WEI??'0';
 const count=Number(env.MEGAZORD_MAX_TX_DIA??'0');
 if(!/^\d+$/.test(daily)||!/^\d+$/.test(perTx)
   ||BigInt(perTx)<=0n||BigInt(daily)<=0n||BigInt(perTx)>BigInt(daily)
   ||!Number.isSafeInteger(count)||count<1||count>250)
   throw Error('orcamento Megazord invalido: confira tetos por transacao, por dia e quantidade');
 if(env.MEGAZORD_CANARIO_ATE_UTC!==undefined){
   const deadline=Date.parse(env.MEGAZORD_CANARIO_ATE_UTC);
   const causes:string[]=[];
   if(!Number.isFinite(deadline))causes.push('prazo_invalido');
   else if(deadline<=Date.now())causes.push('prazo_expirado');
   else if(deadline>Date.now()+3600000)causes.push('prazo_maior_que_1h');
   if(count!==1)causes.push('max_tx_dia_diferente_de_1');
   if(env.MEGAZORD_AUTO_DEPLOY==='1')causes.push('auto_deploy_ligado');
   if(env.MEGAZORD_GAS_MAX_DIA_WEI===undefined)causes.push('teto_diario_nao_explicito');
   if(causes.length)throw Error(
     'canario exige prazo futuro de ate 1h, uma tentativa, teto diario explicito e deploy desligado; causas='+causes.join(','));
 }
 if(env.TITAN_SNOWBALL_REINVESTIR==='1')
   throw Error('reinvestimento precisa de migracao separada');
}
