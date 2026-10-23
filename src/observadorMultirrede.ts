/**
 * TITAN - Aave V3 cross-chain WATCH ONLY.
 *
 * No wallet, signer, flash loan or transaction RPC is ever constructed here.
 * Every chain uses its own official Aave V3 Pool and verifies eth_chainId.
 * Borrow events discover borrowers; eth_call checks CURRENT health factor.
 * Historical coverage is partial until the scan checkpoint catches up, and a
 * failed RPC never advances the checkpoint or reports "zero liquidations".
 *
 * Sources: github.com/aave-dao/aave-address-book (2026-10-18).
 */
import { Contract, Interface, JsonRpcProvider, formatUnits, type Log } from 'ethers';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type NomeRede = 'arbitrum'|'avalanche'|'polygon'|'optimism';
export interface RedeAave {
    id: number; nome: NomeRede; pool: string; rpcPadrao: string; envRpc: string;
}
const poolL2='0x794a61358D6845594F94dc1DB02A252b5b4814aD';
export const REDES_AAVE_V3: Readonly<Record<NomeRede, RedeAave>> = Object.freeze({
    arbitrum:{id:42161,nome:'arbitrum',pool:poolL2,
        rpcPadrao:'https://arb1.arbitrum.io/rpc',envRpc:'CACA_OBSERVADOR_RPC_ARBITRUM'},
    avalanche:{id:43114,nome:'avalanche',pool:poolL2,
        rpcPadrao:'https://api.avax.network/ext/bc/C/rpc',envRpc:'CACA_OBSERVADOR_RPC_AVALANCHE'},
    polygon:{id:137,nome:'polygon',pool:poolL2,
        rpcPadrao:'https://polygon-bor-rpc.publicnode.com',envRpc:'CACA_OBSERVADOR_RPC_POLYGON'},
    optimism:{id:10,nome:'optimism',pool:poolL2,
        rpcPadrao:'https://mainnet.optimism.io',envRpc:'CACA_OBSERVADOR_RPC_OPTIMISM'},
});
export const ifaceAave=new Interface([
    'event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)',
    'event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)',
    'function getUserAccountData(address user) view returns(uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)',
]);
export interface ProgressoRede {
    proximoBloco:number;
    observados:string[];
    proximoIndice:number;
}
export interface EstadoLeitura {versao:1;redes:Partial<Record<NomeRede,ProgressoRede>>}
const ENDERECO=/^0x[a-fA-F0-9]{40}$/;
export function alvosDeBorrow(logs:readonly Log[]):string[]{
    const out=new Set<string>();
    for(const log of logs){
        try {
            const e=ifaceAave.parseLog({topics:[...log.topics],data:log.data});
            if(e?.name==='Borrow'){
                const a=String(e.args.onBehalfOf).toLowerCase();
                if(ENDERECO.test(a))out.add(a);
            }
        }catch{ /* events from unsupported pools are not borrowers */ }
    }
    return [...out];
}
export function faixasHistoricas(de:number,ate:number,maximo=250):Array<[number,number]>{
    if(!Number.isSafeInteger(de)||!Number.isSafeInteger(ate)||!Number.isSafeInteger(maximo)
      ||maximo<1||de<0||ate<de)return [];
    const r:Array<[number,number]>=[];
    for(let x=de;x<=ate;x+=maximo)r.push([x,Math.min(ate,x+maximo-1)]);
    return r;
}
export function redesSolicitadas(s?:string):NomeRede[]{
    const all:NomeRede[]=['arbitrum','avalanche','polygon','optimism'];
    if(s===undefined||s.trim()==='')return all;
    return [...new Set(s.split(',').map(x=>x.trim().toLowerCase()))]
        .filter((v):v is NomeRede=>all.includes(v as NomeRede));
}
const LIMITAR=(x:string|undefined,padrao:number,min:number,max:number)=>{
    const n=Number(x);
    return x!==undefined&&Number.isFinite(n)?Math.min(max,Math.max(min,Math.floor(n))):padrao;
};
const estadoNovo=():EstadoLeitura=>({versao:1,redes:{}});
export async function carregarEstado(caminho:string):Promise<EstadoLeitura>{
    try{
        const dado:unknown=JSON.parse(await readFile(caminho,'utf8'));
        if(!dado||typeof dado!=='object'||!('versao' in dado)||dado.versao!==1
          ||!('redes' in dado)||!dado.redes||typeof dado.redes!=='object')
            return estadoNovo();
        const redes:EstadoLeitura['redes']={};
        for(const nome of redesSolicitadas()){
            const r=(dado.redes as Record<string,unknown>)[nome];
            if(!r||typeof r!=='object')continue;
            const v=r as Record<string,unknown>;
            if(typeof v.proximoBloco!=='number'||!Number.isSafeInteger(v.proximoBloco)
              ||v.proximoBloco<0||!Array.isArray(v.observados))continue;
            redes[nome]={proximoBloco:v.proximoBloco,proximoIndice:Math.max(0,Number(v.proximoIndice)||0),
              observados:[...new Set(v.observados.filter((a):a is string=>typeof a==='string'&&ENDERECO.test(a)).map(a=>a.toLowerCase()))].slice(-10000)};
        }
        return {versao:1,redes};
    }catch{return estadoNovo()}
}
export async function salvarEstado(caminho:string,estado:EstadoLeitura):Promise<void>{
    await mkdir(dirname(caminho),{recursive:true});
    const tmp=caminho+'.tmp';
    await writeFile(tmp,JSON.stringify(estado),'utf8');
    await rename(tmp,caminho);
}
export async function verificarRede(provider:JsonRpcProvider,rede:RedeAave):Promise<number>{
    const [network,block,code]=await Promise.all([
        provider.getNetwork(),provider.getBlockNumber(),provider.getCode(rede.pool),
    ]);
    if(network.chainId!==BigInt(rede.id))throw new Error(
        'RPC retornou chainId '+network.chainId+', esperado '+rede.id);
    if(code==='0x')throw new Error('Aave V3 Pool nao implantado neste RPC');
    return block;
}
/**
 * Avalanche's public RPC intermittently rejects >6 log queries in one burst.
 * It supports two eth_getLogs per slice (Borrow and LiquidationCall).
 * Limit this chain alone to three 50-block slices each cycle, while the fast
 * Arbitrum feed retains enough throughput to catch up with incoming blocks.
 */
export function faixasSegurasPorRede(rede:NomeRede,faixasSolicitadas:number):number{
    if(!Number.isSafeInteger(faixasSolicitadas)||faixasSolicitadas<1)
        throw new Error('faixasSolicitadas invalido');
    return rede==='avalanche'?Math.min(3,faixasSolicitadas):faixasSolicitadas;
}

/**
 * Arbitrum produces blocks faster than the default 50-block scan budget.
 * Dedicated Arbitrum public RPC can try wider slices; any provider rejection
 * triggers a safe size reduction with the cursor left intact.
 */
export function tamanhoSeguroPorRede(rede:NomeRede,solicitado:number):number{
    if(!Number.isSafeInteger(solicitado)||solicitado<1)
        throw new Error('tamanhoSolicitado invalido');
    if(rede==='arbitrum')return Math.max(200,solicitado);
    // On Avalanche the gateway enforces an aggregate max of 100 blocks
    // per HTTP batch. Read Borrow and LiquidationCall SEQUENTIALLY.
    if(rede==='avalanche')return 100;
    return solicitado;
}

/**
 * Historical RPC gateways can reject a filter's block interval even when
 * eth_chainId and the contract are fine (observed on Polygon mainnet).
 * The caller must retry the SAME cursor with a smaller interval.
 */
export function faixaAposErroRpc(atual:number,erro:string):number{
    if(!Number.isSafeInteger(atual)||atual<1)throw new Error('faixa invalida');
    if(!/invalid block range|block.range|too.large|exceed|max.blocks|limit.*blocks|response.size/i.test(erro))
        return atual;
    return Math.max(1,Math.floor(atual/2));
}
/** Slowly restore throughput, without bouncing straight back after one success. */
export function faixaAposSucessos(atual:number,original:number,sucessos:number):number{
    if(!Number.isSafeInteger(atual)||atual<1||!Number.isSafeInteger(original)||original<1)
        throw new Error('faixa invalida');
    if(sucessos<20||atual>=original)return atual;
    return Math.min(original,Math.max(atual+1,atual*2));
}

export interface ResultadoMonitoramento {
    rede:NomeRede;bloco:number;proximoBloco:number;
    devedoresNoCache:number;avaliados:number;
    proximos:Array<{devedor:string;hf:string;dividaBase:string;liquidavel:boolean}>;
    liquidacoesObservadas:number;faixasLidas:number;coberturaCompleta:boolean;
}
export async function monitorarRede(
    rede:RedeAave,provider:JsonRpcProvider,estado:ProgressoRede,
    opcoes:{porCiclo:number;faixasPorCiclo:number;range:number;lookback:number},
):Promise<ResultadoMonitoramento>{
    const bloco=await verificarRede(provider,rede);
    if(estado.proximoBloco===0)estado.proximoBloco=Math.max(0,bloco-opcoes.lookback+1);
    const inicio=estado.proximoBloco;
    const limiteFinal=Math.min(bloco,inicio+opcoes.range*opcoes.faixasPorCiclo-1);
    const faixas=faixasHistoricas(inicio,limiteFinal,opcoes.range);
    const emprestimo=ifaceAave.getEvent('Borrow')!.topicHash;
    const liquidacao=ifaceAave.getEvent('LiquidationCall')!.topicHash;
    let eventosLiquidados=0;
    // Advance cursor ONLY after both log calls returned successfully.
    for(const [de,ate] of faixas){
        const emprestimosFiltro={address:rede.pool,fromBlock:de,toBlock:ate,topics:[emprestimo]};
        const liquidacaoFiltro={address:rede.pool,fromBlock:de,toBlock:ate,topics:[liquidacao]};
        // Avalanche rejects a BATCH whose sum of ranges >100 even when
        // each individual filter is valid. Keep calls sequential there.
        const [novos,liquidados]=rede.nome==='avalanche'
            ? [await provider.getLogs(emprestimosFiltro),await provider.getLogs(liquidacaoFiltro)]
            : await Promise.all([
                provider.getLogs(emprestimosFiltro),provider.getLogs(liquidacaoFiltro),
            ]);
        eventosLiquidados+=liquidados.length;
        const existentes=new Set(estado.observados);
        for(const a of alvosDeBorrow(novos))if(!existentes.has(a)){
            estado.observados.push(a);existentes.add(a);
        }
        if(estado.observados.length>10000){
            const corte=estado.observados.length-10000;
            estado.observados.splice(0,corte);
            estado.proximoIndice=Math.max(0,estado.proximoIndice-corte);
        }
        estado.proximoBloco=ate+1;
    }
    const alvoContagem=Math.min(opcoes.porCiclo,estado.observados.length);
    const pool=new Contract(rede.pool,ifaceAave,provider);
    const proximos:ResultadoMonitoramento['proximos']=[];
    let avaliados=0;
    for(let i=0;i<alvoContagem;i++){
        const idx=(estado.proximoIndice+i)%estado.observados.length;
        const devedor=estado.observados[idx]!;
        try{
            const data=await pool.getUserAccountData(devedor);
            const divida:bigint=data.totalDebtBase;
            const hf:bigint=data.healthFactor;
            avaliados++;
            if(divida>0n&&hf<=106n*10n**16n)
                proximos.push({
                    devedor,hf:formatUnits(hf,18),
                    dividaBase:divida.toString(),liquidavel:hf<10n**18n,
                });
        }catch{ /* unread accounts are not classified as healthy */ }
    }
    if(estado.observados.length>0)estado.proximoIndice=
        (estado.proximoIndice+alvoContagem)%estado.observados.length;
    proximos.sort((a,b)=>Number(a.hf)-Number(b.hf));
    return {rede:rede.nome,bloco,proximoBloco:estado.proximoBloco,
        devedoresNoCache:estado.observados.length,avaliados,proximos,
        liquidacoesObservadas:eventosLiquidados,faixasLidas:faixas.length,
        coberturaCompleta:estado.proximoBloco>bloco};
}
export async function iniciarObservadorMultirrede():Promise<void>{
    if(process.env.ATIVAR_OBSERVADOR_MULTIRREDE!=='1')
        throw new Error('observador desligado: ATIVAR_OBSERVADOR_MULTIRREDE=1 para ativar leitura');
    const nomes=redesSolicitadas(process.env.CACA_OBSERVADOR_REDES);
    if(nomes.length===0)throw new Error('nenhuma rede valida selecionada');
    const arquivo=process.env.CACA_OBSERVADOR_ESTADO??'/app/data/observadorMultirrede.json';
    const estado=await carregarEstado(arquivo);
    const options={
        porCiclo:LIMITAR(process.env.CACA_OBSERVADOR_CONTAS_CICLO,10,1,100),
        faixasPorCiclo:LIMITAR(process.env.CACA_OBSERVADOR_FAIXAS_CICLO,4,1,20),
        range:LIMITAR(process.env.CACA_OBSERVADOR_BLOCOS_FAIXA,150,1,500),
        lookback:LIMITAR(process.env.CACA_OBSERVADOR_LOOKBACK,5000,1,1_000_000),
    };
    const intervalo=LIMITAR(process.env.CACA_OBSERVADOR_INTERVALO_MS,120000,30000,3600000);
    const tamanhosPorRede=new Map<NomeRede,number>();
    const tamanhosOriginais=new Map<NomeRede,number>();
    const ciclosEstaveis=new Map<NomeRede,number>();
    for(const nome of nomes){
        const inicial=tamanhoSeguroPorRede(nome,options.range);
        tamanhosPorRede.set(nome,inicial);
        tamanhosOriginais.set(nome,inicial);
        ciclosEstaveis.set(nome,0);
    }
    const providers=new Map<NomeRede,JsonRpcProvider>();
    for(const nome of nomes){
        const rede=REDES_AAVE_V3[nome];
        const url=process.env[rede.envRpc]??rede.rpcPadrao;
        if(!/^https:\/\//i.test(url))throw new Error('RPC precisa usar HTTPS: '+nome);
        // NEVER use staticNetwork: it would fabricate the expected chainId.
        // The first getNetwork() must read the actual remote eth_chainId.
        providers.set(nome,new JsonRpcProvider(url));
    }
    console.info('[MULTIRREDE] leitura ativada, envio de transacoes IMPOSSIVEL neste processo',
        JSON.stringify({redes:nomes,intervalo,options}));
    while(true){
        for(const nome of nomes){
            const rede=REDES_AAVE_V3[nome]!;
            const progresso=estado.redes[nome]??{proximoBloco:0,observados:[],proximoIndice:0};
            estado.redes[nome]=progresso;
            try{
                const seguro={...options,
                    range:tamanhosPorRede.get(nome)??options.range,
                    faixasPorCiclo:faixasSegurasPorRede(nome,options.faixasPorCiclo)};
                const resultado=await monitorarRede(rede,providers.get(nome)!,progresso,seguro);
                const estaveis=(ciclosEstaveis.get(nome)??0)+1;
                const anterior=tamanhosPorRede.get(nome)??options.range;
                const recuperado=faixaAposSucessos(
                    anterior,tamanhosOriginais.get(nome)??options.range,estaveis);
                if(recuperado!==anterior){
                    tamanhosPorRede.set(nome,recuperado);
                    ciclosEstaveis.set(nome,0);
                    console.info('[MULTIRREDE/RANGE_RECUPERADO]',JSON.stringify({
                        rede:nome,anterior,novo:recuperado,cursor:progresso.proximoBloco,
                    }));
                }else ciclosEstaveis.set(nome,estaveis);
                await salvarEstado(arquivo,estado);
                console.info('[MULTIRREDE/CICLO]',JSON.stringify(resultado));
            }catch(e){
                // Reduce only the failing chain; preserve its exact next block.
                // Polygon's "invalid block range params" must not loop forever.
                const erro=e instanceof Error?e.message:String(e);
                const atual=tamanhosPorRede.get(nome)??options.range;
                const reduzido=faixaAposErroRpc(atual,erro);
                ciclosEstaveis.set(nome,0);
                if(reduzido!==atual){
                    tamanhosPorRede.set(nome,reduzido);
                    console.warn('[MULTIRREDE/RANGE_RECUO]',JSON.stringify({
                        rede:nome,anterior:atual,novo:reduzido,cursor:progresso.proximoBloco,
                    }));
                }
                // Both failed historical reads and RPC timeouts retain cursor.
                await salvarEstado(arquivo,estado);
                console.warn('[MULTIRREDE/SEM_COBERTURA]',JSON.stringify({
                    rede:nome,motivo:e instanceof Error?e.message.split(' (request=')[0].slice(0,160):'desconhecido',
                    cursorRetido:progresso.proximoBloco,naoConcluirAusenciaDeOportunidades:true,
                }));
            }
        }
        await new Promise<void>(resolve=>setTimeout(resolve,intervalo));
    }
}
if(require.main===module){
    iniciarObservadorMultirrede().catch(e=>{console.error('[MULTIRREDE/FATAL]',String(e));process.exitCode=1});
}
