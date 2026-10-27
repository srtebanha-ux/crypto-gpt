/** CPAMM -> calldata real -> simulação atômica. Nunca assina nem transmite. */
import {Interface, Transaction, keccak256} from 'ethers';
import {estimarTamanhoCicloCpamm, saidaCpamm, type PoolCpamm} from './titanTamanhoCpamm';
import {montarCalldata} from './flashArbExecutor';
import {ORACULO_DE_GAS_L1} from './custoDaBase';

export type RpcCpamm = (method:string, params:unknown[])=>Promise<unknown>;
export interface ConfigCpammAtomico {
    executor:string;
    executorCodeHash:string;
    /** Somente factories auditadas de pares V2 com taxa fixa 997/1000. */
    factories: {endereco:string; poolCodeHash:string; taxaNumerador:number; taxaDenominador:number}[];
    minimoLiquidoWei:bigint;
}
export interface OfertaCpammAtomica {
    etapa:'simulada'; bloco:string; dono:string; contrato:string; calldata:string;
    gasLimit:bigint; custoMaximoWei:bigint; lucroMinimoWei:bigint;
    entradaWei:bigint; emprestadoWei:bigint; simulacoes:number;
}
const abi = new Interface([
    'function factory() view returns(address)', 'function token0() view returns(address)',
    'function token1() view returns(address)',
    'function getReserves() view returns(uint112,uint112,uint32)',
    'function getPair(address,address) view returns(address)',
    'function owner() view returns(address)', 'function balanceOf(address) view returns(uint256)',
    'function getL1FeeUpperBound(uint256) view returns(uint256)',
]);
export const WETH_BASE_CPAMM='0x4200000000000000000000000000000000000006';
const address=(s:string)=>/^0x[0-9a-fA-F]{40}$/.test(s)&&!/^0x0{40}$/.test(s);
const hash=(s:string)=>/^0x[0-9a-fA-F]{64}$/.test(s);
const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function quantity(v:unknown):bigint {
    if(typeof v!=='string'||!/^0x[0-9a-fA-F]+$/.test(v))throw Error('Quantidade RPC inválida');
    return BigInt(v);
}
function codeHash(v:unknown):string {
    if(typeof v!=='string'||!/^0x(?:[0-9a-fA-F]{2})+$/.test(v))throw Error('Bytecode ausente');
    return keccak256(v);
}
export function validarConfigCpamm(c:ConfigCpammAtomico):void {
    if(!address(c.executor)||!hash(c.executorCodeHash)||c.minimoLiquidoWei<=0n
        ||!c.factories.length||c.factories.length>32
        ||c.factories.some(f=>!address(f.endereco)||!hash(f.poolCodeHash)
            ||f.taxaNumerador!==997||f.taxaDenominador!==1000)
        ||new Set(c.factories.map(f=>f.endereco.toLowerCase())).size!==c.factories.length)
        throw Error('Configuração CPAMM não verificada: executor/factory/hash/taxa/piso');
}

/** Resultado positivo prova o piso no snapshot, não lucro recebido ou inclusão futura. */
export async function prepararCpammAtomico(
    rpc:RpcCpamm,c:ConfigCpammAtomico,pools:readonly string[],base:string,maximo:bigint,
):Promise<OfertaCpammAtomica|null> {
    validarConfigCpamm(c);
    // Custos de rede denominados em ETH só são comparáveis diretamente a WETH.
    if(!equal(base,WETH_BASE_CPAMM)||pools.length!==2||!pools.every(address)
        ||equal(pools[0],pools[1])||maximo<=0n)return null;
    if(quantity(await rpc('eth_chainId',[]))!==8453n)throw Error('Rede não é Base');
    const bloco='0x'+quantity(await rpc('eth_blockNumber',[])).toString(16);
    const read=async(to:string,name:string,args:unknown[]=[])=>{
        const result=await rpc('eth_call',[{to,data:abi.encodeFunctionData(name,args)},bloco]);
        if(typeof result!=='string')throw Error('Retorno RPC ausente');
        return abi.decodeFunctionResult(name,result);
    };
    if(!equal(codeHash(await rpc('eth_getCode',[c.executor,bloco])),c.executorCodeHash))
        throw Error('Identidade do executor divergente');
    const dono=String((await read(c.executor,'owner'))[0]);
    if(!address(dono))throw Error('Owner inválido');
    const snapshots=await Promise.all(pools.map(async pool=>{
        const [factoryResult,t0Result,t1Result,reserves,code]=await Promise.all([
            read(pool,'factory'),read(pool,'token0'),read(pool,'token1'),read(pool,'getReserves'),
            rpc('eth_getCode',[pool,bloco]),
        ]);
        const factory=String(factoryResult[0]);
        const f=c.factories.find(v=>equal(v.endereco,factory));
        if(!f||!equal(codeHash(code),f.poolCodeHash))throw Error('Pool sem modelo CPAMM/taxa autenticados');
        const t0=String(t0Result[0]),t1=String(t1Result[0]);
        if(!address(t0)||!address(t1)||equal(t0,t1)||(!equal(t0,base)&&!equal(t1,base)))
            throw Error('Tokens incompatíveis');
        if(!equal(String((await read(factory,'getPair',[t0,t1]))[0]),pool))
            throw Error('Factory não reconhece o par');
        return {t0,t1,reserves};
    }));
    const alt=equal(snapshots[0].t0,base)?snapshots[0].t1:snapshots[0].t0;
    if(!equal(alt,equal(snapshots[1].t0,base)?snapshots[1].t1:snapshots[1].t0))return null;
    const orientadas:PoolCpamm[]=snapshots.map((p,i)=>{
        const entrada=i===0?base:alt;
        return {reservaEntrada:p.reserves[equal(p.t0,entrada)?0:1],
            reservaSaida:p.reserves[equal(p.t0,entrada)?1:0],taxaNumerador:997n,taxaDenominador:1000n};
    });
    // O executor legado não protege o saldo ALT por delta. Não deixar esse
    // saldo subsidiar um token taxado e criar um falso positivo de lucro.
    if((await read(alt,'balanceOf',[c.executor]))[0]!==0n)
        throw Error('Saldo prévio de colateral impede prova econômica no executor legado');
    const saldo=(await read(base,'balanceOf',[c.executor]))[0] as bigint;
    const [first,second]=orientadas;
    const teto=maximo<first.reservaEntrada/10n?maximo:first.reservaEntrada/10n;
    const seed=estimarTamanhoCicloCpamm(first,second,teto);
    if(!seed)return null;
    const price=quantity(await rpc('eth_gasPrice',[]));
    const nonceRaw=quantity(await rpc('eth_getTransactionCount',[dono,bloco]));
    if(price<=0n||nonceRaw>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Gas/nonce inválido');
    const nonce=Number(nonceRaw);
    let melhor:OfertaCpammAtomica|null=null;
    let simulacoes=0;
    const candidatos=new Set([seed.tamanhoSugerido*9n/10n,seed.tamanhoSugerido,
        seed.tamanhoSugerido*11n/10n]);
    for(const entrada of candidatos){
        if(entrada<=0n||entrada>teto)continue;
        const emprestado=saidaCpamm(first,entrada);
        if(emprestado<=0n||emprestado>=first.reservaSaida)continue;
        // FlashArb faz EXACT OUTPUT +1, não repay da entrada contínua.
        const repay=first.reservaEntrada*emprestado*1000n/((first.reservaSaida-emprestado)*997n)+1n;
        const bruto=saidaCpamm(second,emprestado)-repay;
        if(bruto<=c.minimoLiquidoWei)continue;
        const data=(piso:bigint)=>montarCalldata({poolEmprestimo:pools[0],poolVenda:pools[1],
            tokenEmprestado:alt,quantidade:emprestado,lucroMinimo:saldo+piso});
        try {
            const inicial=data(bruto);
            const gas=quantity(await rpc('eth_estimateGas',[{from:dono,to:c.executor,data:inicial},bloco]));
            if(gas<=0n)continue;
            const gasLimit=gas+gas/5n+1024n; // covers all 32 minProfit calldata bytes changing zero/nonzero
            const unsigned=Transaction.from({type:2,chainId:8453,nonce,to:c.executor,
                data:inicial,gasLimit,maxFeePerGas:price,maxPriorityFeePerGas:price}).unsignedSerialized;
            const l1=(await read(ORACULO_DE_GAS_L1,'getL1FeeUpperBound',[(unsigned.length-2)/2]))[0] as bigint;
            if(l1<=0n)continue; // no unknown component may become zero cost
            const custo=gasLimit*price+l1;
            if(bruto<custo+c.minimoLiquidoWei)continue;
            const liquido=(bruto-custo)/2n>c.minimoLiquidoWei?(bruto-custo)/2n:c.minimoLiquidoWei;
            const calldata=data(custo+liquido);
            simulacoes++;
            const result=await rpc('eth_call',[{from:dono,to:c.executor,data:calldata,
                gas:'0x'+gasLimit.toString(16),gasPrice:'0x'+price.toString(16)},bloco]);
            if(result!=='0x')continue;
            if(!melhor||liquido>melhor.lucroMinimoWei)melhor={etapa:'simulada',bloco,dono,
                contrato:c.executor,calldata,gasLimit,custoMaximoWei:custo,lucroMinimoWei:liquido,
                entradaWei:entrada,emprestadoWei:emprestado,simulacoes};
        }catch{ /* fail closed: taxed token, insufficient repayment, unknown L1 or revert */ }
    }
    if(!melhor)return null;
    if(quantity(await rpc('eth_blockNumber',[]))!==BigInt(bloco))return null;
    return {...melhor,simulacoes};
}
