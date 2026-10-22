/**
 * Real FlashArb EVM preflight on Base with eth_call state override.
 * No contract deployment, no signing, no gas spending, no broadcast.
 * If the node lacks state override or estimateGas override, mark UNKNOWN.
 */
import fs from 'node:fs';
import {ocultarSegredos} from './logger';
import { Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { ORACULO_DE_GAS_L1, codificarTetoDeL1 } from './custoDaBase';
import { calcularPisoTitan } from './titanExecucao';
import { interpretarReversao } from './flashArbExecutor';

export type CandidatoV2Prova = {
    emprestimo:{endereco:string;lidoEm:number};
    venda:{endereco:string;lidoEm:number};
    T:string; U:string;quantia:bigint;
};
type RuntimeArtifact = {runtime:string;creation:string;
    ownerReferences:Array<{start:number;length:number}>};
type Artifact = RuntimeArtifact & {variantes?:RuntimeArtifact[]};
export type ProvaV2 = {
    estado:'executavel-em-override'|'inviavel'|'desconhecido';
    motivo:string; bloco:number|null; contratoVirtual?:string;
    gasEstimado?:string; custoMaximoWei?:string; pisoWei?:string;
    brutoMinimoWei?:string; erroContrato?:string;
};
export const ENDERECO_VIRTUAL_V2='0x00000000000000000000000000000000F1A5BEEF';
export const WETH_BASE='0x4200000000000000000000000000000000000006';
const abi=new Interface([
 'function executarArbitragem(address,address,address,uint256,uint256)',
 'function balanceOf(address) view returns (uint256)',
]);
const artifactPath='.tmp/artifacts/FlashArbProva.json';

export function codigoFlashArbComDono(a:Artifact,owner:string):string{
    const dono=getAddress(owner).slice(2).toLowerCase().padStart(64,'0');
    if(!/^0x[0-9a-fA-F]+$/.test(a.runtime)
        ||a.runtime.length<200||!Array.isArray(a.ownerReferences)
        ||a.ownerReferences.length<1)throw Error('artifact override invalido');
    let hex=a.runtime.slice(2);
    for(const ref of a.ownerReferences){
        if(!Number.isSafeInteger(ref.start)||ref.start<0||ref.length!==32
            ||(ref.start+32)*2>hex.length)throw Error('owner immutable invalido');
        hex=hex.slice(0,ref.start*2)+dono+hex.slice((ref.start+32)*2);
    }
    return '0x'+hex;
}
/**
 * Solc appends CBOR metadata after the generated executable code.
 * Source path alone can change this suffix while instructions remain identical.
 * Permit only the exact executable code of compiler-built, known FlashArb
 * variants, with immutable owner patched. Do NOT ignore executable bytes.
 */
function executarSemMetadataSolc(codigo:string):string|null{
 if(!/^0x(?:[0-9a-fA-F]{2})+$/.test(codigo))return null;
 const hex=codigo.slice(2).toLowerCase();
 if(hex.length<8)return null;
 const metadataBytes=parseInt(hex.slice(-4),16);
 if(metadataBytes<8||metadataBytes>1024||metadataBytes*2+4>=hex.length)
   return null;
 const inicio=hex.length-4-metadataBytes*2;
 const metadata=hex.slice(inicio,hex.length-4);
 if(!/^a[0-9a-f]/.test(metadata))return null;
 return hex.slice(0,inicio);
}
export function correspondeFlashArb(
 onchain:string,artefato:Artifact,owner:string,
):boolean{
 const observado=executarSemMetadataSolc(onchain);
 const variantes=[artefato,...(artefato.variantes??[])];
 return variantes.some((a)=>{
   const esperado=codigoFlashArbComDono(a,owner);
   if(onchain.toLowerCase()===esperado.toLowerCase())return true;
   const compilado=executarSemMetadataSolc(esperado);
   return observado!==null&&compilado!==null&&observado===compilado;
 });
}
export function pisoConservadorV2(
    gasEstimado:bigint,gasMax:bigint,baseFee:bigint,gorjeta:bigint,
    l1Upper:bigint,orcamento:bigint,env:NodeJS.ProcessEnv,
):{custo:bigint;piso:bigint;gasLimite:bigint}{
    if([gasEstimado,gasMax,baseFee,gorjeta,l1Upper,orcamento].some(x=>x<=0n))
        throw Error('dados de gas incompletos');
    const gasLimite=gasEstimado+gasEstimado/5n;
    if(gasLimite>gasMax)throw Error('gas estimado excede teto');
    const custo=gasLimite*(2n*baseFee+gorjeta)+2n*l1Upper;
    if(custo>orcamento)throw Error('custo total excede orcamento');
    return {custo,gasLimite,piso:calcularPisoTitan(custo,env).lucroBrutoMinimoWei};
}
function textoReversao(e:unknown):string{
    const x=e as {data?:unknown;error?:{data?:unknown};message?:string};
    const d=typeof x.data==='string'?x.data:
      typeof x.error?.data==='string'?x.error.data:undefined;
    if(d?.startsWith('0x')&&d.length>=10)return ocultarSegredos(interpretarReversao(d));
    return ocultarSegredos((x.message??'RPC sem motivo').slice(0,240));
}
function reverteuContrato(e:unknown):boolean{
    const s=textoReversao(e);
    return /execution reverted|revert|uniswapv2|pool|lucroinsuficiente|insufficient.input|transfer.failed/i.test(s)
      && !/rate.limit|429|timeout|http |gateway|unsupported|missing trie|invalid params/i.test(s);
}

export async function provarV2Atomico(
    c:CandidatoV2Prova,rpcUrl:string,env:NodeJS.ProcessEnv=process.env,
):Promise<ProvaV2>{
    const sem={bloco:null,estado:'desconhecido' as const};
    if(!env.TITAN_CHAVE_PRIVADA||!env.TITAN_ORCAMENTO_GAS_WEI)
        return {...sem,motivo:'sem identidade do executor ou orcamento'};
    if(c.U.toLowerCase()!==WETH_BASE.toLowerCase()||c.quantia<=0n)
        return {...sem,motivo:'lucro nao liquidado em WETH ou tamanho invalido'};
    if(Date.now()-Math.min(c.emprestimo.lidoEm,c.venda.lidoEm)>30_000)
        return {...sem,motivo:'reservas expiradas'};
    let provider:JsonRpcProvider|undefined;
    let bloco:number|null=null;
    try{
        const wallet=new Wallet(env.TITAN_CHAVE_PRIVADA);
        const poolA=getAddress(c.emprestimo.endereco);
        const poolB=getAddress(c.venda.endereco);
        const token=getAddress(c.T);
        const virtual=getAddress(ENDERECO_VIRTUAL_V2);
        if(poolA===poolB)return {...sem,motivo:'mesmo pool nos dois lados'};
        const artefato=JSON.parse(fs.readFileSync(artifactPath,'utf8')) as Artifact;
        const codigo=codigoFlashArbComDono(artefato,wallet.address);
        provider=new JsonRpcProvider(rpcUrl,8453,{staticNetwork:true});
        if(BigInt(await provider.send('eth_chainId',[]))!==8453n)
            throw Error('RPC nao e Base 8453');
        if(await provider.getCode(virtual)!=='0x')
            throw Error('endereco virtual ja tem bytecode na Base');
        const blocoAtual=await provider.getBlock('latest');
        if(!blocoAtual?.baseFeePerGas||blocoAtual.baseFeePerGas<=0n)
            throw Error('baseFee indisponivel');
        bloco=blocoAtual.number;
        const codigoSobrescrito={[virtual.toLowerCase()]:{code:codigo}};
        const saldoData=abi.encodeFunctionData('balanceOf',[virtual]);
        const saldoHex=await provider.call({to:c.U,data:saldoData});
        const saldo=BigInt(saldoHex);
        // A one-wei floor tests actual complete UniswapV2 callback including
        // taxed tokens; reserve-only calculations cannot detect transfer tax.
        const dados=abi.encodeFunctionData('executarArbitragem',
            [poolA,poolB,token,c.quantia,saldo+1n]);
        const tx={from:wallet.address,to:virtual,data:dados};
        let estimado:bigint;
        try{
            estimado=BigInt(await provider.send('eth_estimateGas',
                [tx,'latest',codigoSobrescrito]));
        }catch(e){
            // Learn whether this is a CONTRACT revert or an RPC unsupported
            // override. Either way do not spend gas on the chain.
            const causa=textoReversao(e);
            return {estado:reverteuContrato(e)?'inviavel':'desconhecido',
                motivo:'estimativa atomica falhou: '+causa,bloco,
                contratoVirtual:virtual,erroContrato:causa};
        }
        const l1Data=codificarTetoDeL1(Math.ceil((dados.length-2)/2)+160);
        const l1Upper=BigInt(await provider.call({
            to:ORACULO_DE_GAS_L1,data:l1Data,
        }));
        const gorjeta=BigInt(env.TITAN_GORJETA_WEI??'20000000');
        const limite=BigInt(env.TITAN_GAS_MAX??'650000');
        const orcamento=BigInt(env.TITAN_ORCAMENTO_GAS_WEI);
        let piso:{custo:bigint;piso:bigint;gasLimite:bigint};
        try{
            piso=pisoConservadorV2(estimado,limite,blocoAtual.baseFeePerGas,
                gorjeta,l1Upper,orcamento,env);
        }catch(e){
            return{estado:'inviavel',bloco,
                motivo:'custo nao passa politica: '+(e as Error).message,
                gasEstimado:estimado.toString()};
        }
        const transacao=abi.encodeFunctionData('executarArbitragem',
            [poolA,poolB,token,c.quantia,saldo+piso.piso]);
        try{
            const result=await provider.send('eth_call',[
                {from:wallet.address,to:virtual,data:transacao},'latest',
                codigoSobrescrito,
            ]);
            if(result!=='0x')throw Error('FlashArb deveria retornar 0x');
        }catch(e){
            const causa=textoReversao(e);
            return {estado:reverteuContrato(e)?'inviavel':'desconhecido',
                motivo:'eth_call atomico com piso reverteu: '+causa,bloco,
                gasEstimado:estimado.toString(),custoMaximoWei:piso.custo.toString(),
                pisoWei:piso.piso.toString(),erroContrato:causa};
        }
        if((await provider.getBlockNumber())-bloco>2)
            return {estado:'desconhecido',motivo:'estado mudou durante a prova',
                bloco,gasEstimado:estimado.toString()};
        return {estado:'executavel-em-override',bloco,
            motivo:'flash swap completa callback e paga GAS+L1+MARGEM no estado latest, sem broadcast',
            contratoVirtual:virtual,gasEstimado:estimado.toString(),
            custoMaximoWei:piso.custo.toString(),pisoWei:piso.piso.toString(),
            brutoMinimoWei:piso.piso.toString()};
    }catch(e){
        return{estado:'desconhecido',bloco,
            motivo:'prova V2 sem resultado conclusivo: '+textoReversao(e)};
    }finally{provider?.destroy()}
}
