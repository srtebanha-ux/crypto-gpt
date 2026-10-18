/**
 * Ponte opt-in TITAN (liquidacao Aave -> flash loan Morpho -> ate 4 swaps).
 * O planejador recebe cotacoes reais de eth_call no MESMO bloco da Base.
 * Importar este arquivo NAO cria carteira nem transmite transacoes.
 */
import { Interface, JsonRpcProvider, getAddress } from 'ethers';
import { Decimal } from 'decimal.js';
import { planejarLiquidacaoTitan, type SimulacaoLiquidacao } from './titanPlanejadorLiquidacao';
import type { PoolLiquidacao, RotaLiquidacao } from './titanRotasLiquidacao';
import { pisoNoContrato } from './caca';
import { codificarTetoDeL1, ORACULO_DE_GAS_L1 } from './custoDaBase';

const ENDERECO = /^0x[0-9a-fA-F]{40}$/;
/**
 * Pools Uniswap V3 constatadas on-chain pela propria verificacao do CACA
 * na Base, em 2026-10-16. Sao CANDIDATAS, nao garantia de cotacao:
 * o contrato ainda exige fabrica V3 correspondente e lucro minimo positivo.
 * O alvo, a divida, os precos e o saldo continuam vindo do CACA em tempo real.
 */
export const FABRICA_V3_BASE = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDBC_BASE = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
export const CBBTC_BASE = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
export const POOLS_CBBTC_V3_BASE: readonly PoolLiquidacao[] = Object.freeze([
    // Verified on-chain via canonical Uniswap V3 Base factory getPool on 2026-10-17.
    {endereco:'0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef',
        token0:USDC_BASE,token1:CBBTC_BASE,protocolo:'v3',taxa:500,permitida:true},
    {endereco:'0xeC558e484cC9f2210714E345298fdc53B253c27D',
        token0:USDC_BASE,token1:CBBTC_BASE,protocolo:'v3',taxa:3000,permitida:true},
    {endereco:'0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1',
        token0:WETH_BASE,token1:CBBTC_BASE,protocolo:'v3',taxa:500,permitida:true},
]);
export const FABRICA_SLIPSTREAM_BASE = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';
export const POOL_SLIPSTREAM_EURC_USDC: PoolLiquidacao = Object.freeze({
    endereco:'0xE846373C1a92B167b4E9cd5d8E4d6B1Db9E90EC7',
    token0:'0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42',
    token1:USDC_BASE,
    protocolo:'slipstream',taxa:50,permitida:true,
});
export const POOLS_V3_BASE_CACA: readonly PoolLiquidacao[] = Object.freeze([
    {endereco:'0xd0b53D9277642d899DF5C87A3966A349A798F224',
        token0:WETH_BASE,token1:USDC_BASE,protocolo:'v3',taxa:500,permitida:true},
    {endereco:'0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18',
        token0:WETH_BASE,token1:USDBC_BASE,protocolo:'v3',taxa:500,permitida:true},
    {endereco:'0x06959273E9A65433De71F5A452D529544E07dDD0',
        token0:USDBC_BASE,token1:USDC_BASE,protocolo:'v3',taxa:100,permitida:true},
]);
/**
 * Reusa o proprio calculo de gas L1 da Base ja existente no CACA.
 * O calldata do contrato novo possui ate 4 saltos: 740 bytes maximos.
 * Nao aceita ausencia/resposta zero como custo gratuito; usa 2x o teto.
 */
export async function tetoL1PeloCaca(rpc:JsonRpcProvider):Promise<bigint>{
    const retorno=await rpc.call({
        to:ORACULO_DE_GAS_L1,
        data:codificarTetoDeL1(740),
    });
    const teto=BigInt(retorno);
    if(teto<=0n)throw new Error('oraculo L1 do CACA nao retornou custo valido');
    return teto*2n;
}
/** O CACA pode operar sem copiar novamente para Railway seu banco de pools. */
export function poolsDoCaca(
    valor?: string, incluirSlipstream = process.env.CACA_MULTIHOP_SLIPSTREAM==='1',
    incluirCbBtc = process.env.CACA_MULTIHOP_CBBTC==='1',
): PoolLiquidacao[] {
    const extras = valor?.trim() ? poolsDaConfiguracao(valor) : [];
    const unicos = new Map<string,PoolLiquidacao>();
    const candidatos = [
        ...POOLS_V3_BASE_CACA,
        ...(incluirCbBtc?POOLS_CBBTC_V3_BASE:[]),
        ...(incluirSlipstream?[POOL_SLIPSTREAM_EURC_USDC]:[]),
        ...extras,
    ];
    for (const pool of candidatos)
        unicos.set(pool.endereco.toLowerCase(),pool);
    return [...unicos.values()];
}

export const MORPHO_FLASH_BASE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
export const ABI_MULTI = new Interface([
    'function liquidar(address usuario,address garantia,address divida,uint256 cobrir,uint256 lucroMinimo,(address pool,address tokenEntra,uint8 tipo,uint24 fee)[] rota) returns (uint256 lucro)',
    'function dono() view returns (address)',
    'function cofre() view returns (address)',
    'function aave() view returns (address)',
    'function morpho() view returns (address)',
    'function fabricaV3() view returns (address)',
    'function slipstreamFactory() view returns (address)',
    'event LiquidouComRota(address indexed usuario,address indexed origem,address indexed destino,uint256 quantia,uint256 lucro)',
]);
export interface EntradaPonte {
    usuario: string;
    garantia: string;
    divida: string;
    dividaCrua: bigint;
    dividaUsd: Decimal;
    creditoMaximo: bigint;
    ethUsd: Decimal;
    dono: string;
    contrato: string;
    cofre: string;
    aave: string;
    fabricaV3: string;
    pools: PoolLiquidacao[];
    maxFeePerGas: bigint;
    reservaL1Wei: bigint;
    gasMax: bigint;
    maxCotacoes?: number;
}
export interface OfertaMulti {
    contrato: string;
    lucroCru: bigint;
    liquidoCru: bigint;
    cobrir: bigint;
    piso: bigint;
    gasEstimado: bigint;
    bloco: number;
    envio: string;
    rota: RotaLiquidacao;
}
export function poolsDaConfiguracao(valor: string | undefined): PoolLiquidacao[] {
    if (!valor) throw new Error('CACA_MULTIHOP_POOLS_JSON ausente');
    const raw: unknown = JSON.parse(valor);
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
        throw new Error('lista de pools invalida (1 a 100)');
    }
    return raw.map((p: unknown) => {
        if (!p || typeof p !== 'object') throw new Error('pool invalida');
        const a = p as Record<string, unknown>;
        if (typeof a.endereco !== 'string' || !ENDERECO.test(a.endereco)
            || typeof a.token0 !== 'string' || !ENDERECO.test(a.token0)
            || typeof a.token1 !== 'string' || !ENDERECO.test(a.token1)
            || !['v3', 'aerodrome', 'slipstream'].includes(String(a.protocolo))
            || a.permitida !== true
            || (a.protocolo === 'v3' && (!Number.isSafeInteger(a.taxa)
                || Number(a.taxa) <= 0 || Number(a.taxa) > 10000))
            || (a.protocolo === 'aerodrome' && a.taxa !== null && a.taxa !== 0)
            || (a.protocolo === 'slipstream' && (
                a.taxa !== 50
                || String(a.endereco).toLowerCase() !== POOL_SLIPSTREAM_EURC_USDC.endereco.toLowerCase()
                || ![String(a.token0).toLowerCase(),String(a.token1).toLowerCase()].includes(
                    POOL_SLIPSTREAM_EURC_USDC.token0.toLowerCase())
                || ![String(a.token0).toLowerCase(),String(a.token1).toLowerCase()].includes(
                    POOL_SLIPSTREAM_EURC_USDC.token1.toLowerCase())
            ))) {
            throw new Error('pool nao validada: enderecos, protocolo, taxa ou permissao');
        }
        return a as unknown as PoolLiquidacao;
    });
}
/**
 * Aave residue guard measured on Base fork (synthetic positions).
 * For debt below ~2040 USD, covering exactly 50% can leave
 * less than the accepted residual. Conservative cap only: no fabricated
 * profit or assumption that a real multi-collateral position will accept it.
 */
export function creditoMaximoComResiduoCbBtc(
    dividaCrua:bigint,dividaUsd:Decimal,limiteAtual:bigint,
):bigint{
    if(dividaCrua<=0n||limiteAtual<=0n||!dividaUsd.isFinite()||dividaUsd.lte(0))
        return 0n;
    const restoSeguro=new Decimal('1020.1632'); // 1000.16 * 1.02
    const maxParcialUsd=dividaUsd.minus(restoSeguro);
    if(maxParcialUsd.lte(0))return 0n;
    const maxParcial=BigInt(new Decimal(dividaCrua.toString())
        .mul(maxParcialUsd).div(dividaUsd).floor().toFixed(0));
    return maxParcial<limiteAtual?maxParcial:limiteAtual;
}

export function validarPonte(e: EntradaPonte): void {
    for (const x of [e.usuario,e.garantia,e.divida,e.dono,e.contrato,e.cofre,e.aave,e.fabricaV3]) {
        if (!ENDERECO.test(x)) throw new Error('endereco invalido na ponte Multi-Hop');
    }
    if (e.dividaCrua <= 0n || e.creditoMaximo <= 0n
        || e.dividaUsd.lte(0) || !e.dividaUsd.isFinite()
        || e.ethUsd.lte(0) || !e.ethUsd.isFinite()
        || e.maxFeePerGas <= 0n || e.reservaL1Wei <= 0n || e.gasMax <= 0n
        || e.pools.length === 0) throw new Error('unidades, custos ou pools invalidos');
}
export function gasEmTokenDaDivida(
    gas: bigint, precoGasWei: bigint, reservaL1Wei: bigint,
    dividaCrua: bigint, dividaUsd: Decimal, ethUsd: Decimal,
): bigint {
    if ([gas,precoGasWei,reservaL1Wei,dividaCrua].some(x => x < 0n)
        || dividaUsd.lte(0) || ethUsd.lte(0)) throw new Error('custo de gas invalido');
    // Decimal: ETH/gas -> USD -> unidade crua da divida; arredonda para CIMA.
    return BigInt(new Decimal((gas * precoGasWei + reservaL1Wei).toString())
        .mul(ethUsd).mul(dividaCrua.toString())
        .div('1000000000000000000').div(dividaUsd)
        .ceil().toFixed(0));
}
export function codificarMulti(
    e: Pick<EntradaPonte,'usuario'|'garantia'|'divida'>,
    cobrir: bigint, piso: bigint, rota: RotaLiquidacao,
): string {
    if (cobrir <= 0n || piso <= 0n || rota.pernas.length < 1 || rota.pernas.length > 4) {
        throw new Error('quantia, piso ou rota invalidos');
    }
    return ABI_MULTI.encodeFunctionData('liquidar', [
        e.usuario,e.garantia,e.divida,cobrir,piso,
        rota.pernas.map(p=>[p.pool,p.tokenEntra,p.tipo,p.fee]),
    ]);
}
class CotacaoPendente {
    constructor(readonly rota: RotaLiquidacao, readonly cobrir: bigint, readonly chave: string) {}
}
function chave(rota: RotaLiquidacao, q: bigint): string {return rota.chave+':'+q.toString();}
/** Confere TODAS as imutaveis; configuracao JSON nunca substitui a validacao onchain. */
export async function conferirExecutorMulti(rpc: JsonRpcProvider, e: EntradaPonte): Promise<void> {
    const rede = await rpc.getNetwork();
    if (rede.chainId !== 8453n) throw new Error('RPC fora da Base 8453');
    if ((await rpc.getCode(e.contrato)) === '0x') throw new Error('Multi-Hop ainda nao implantado');
    const esperado: Record<string,string> = {
        dono:e.dono,cofre:e.cofre,aave:e.aave,
        morpho:MORPHO_FLASH_BASE,fabricaV3:e.fabricaV3,
    };
    if (e.pools.some(p=>p.protocolo==='slipstream')) {
        // Endereco implantado anteriormente nao tem esse getter; fail closed.
        const data=ABI_MULTI.encodeFunctionData('slipstreamFactory');
        const retorno=await rpc.call({to:e.contrato,data});
        const recebido=ABI_MULTI.decodeFunctionResult('slipstreamFactory',retorno)[0] as string;
        if(getAddress(recebido)!==getAddress(FABRICA_SLIPSTREAM_BASE))
            throw new Error('executor sem fabrica Slipstream canonica');
    }
    for (const [campo, endereco] of Object.entries(esperado)) {
        const retorno = await rpc.call({to:e.contrato,data:ABI_MULTI.encodeFunctionData(campo)});
        const recebido = ABI_MULTI.decodeFunctionResult(campo,retorno)[0] as string;
        if (getAddress(recebido)!==getAddress(endereco)) {
            throw new Error('executor Multi-Hop divergente em '+campo);
        }
    }
}
/**
 * Dirige o planejador SINCRONO com eth_call assincrona via cache/trampolim.
 * Quotes no mesmo bloco; nenhuma simulacao ausente se torna lucro.
 * Estimativa de gas e reserva L1 entram ANTES de otimizar tamanho/rota.
 */
export async function prepararOfertaMulti(
    rpc: JsonRpcProvider, e: EntradaPonte,
): Promise<OfertaMulti | null> {
    validarPonte(e);
    await conferirExecutorMulti(rpc,e);
    const snapshot = await rpc.getBlockNumber();
    const cache = new Map<string,SimulacaoLiquidacao|null>();
    const gases = new Map<string,bigint>();
    const maxChamadas = Math.min(32, Math.max(8,e.maxCotacoes ?? 16));
    let plano: ReturnType<typeof planejarLiquidacaoTitan> = null;
    // O maximo de pedidos distintos e maxChamadas; um pedido NAO e repetido.
    for (let i=0;i<=maxChamadas;i++) {
        let pendente: CotacaoPendente | null = null;
        try {
            plano = planejarLiquidacaoTitan(e.pools,e.garantia,e.divida,
                e.creditoMaximo,e.creditoMaximo>=100n?e.creditoMaximo/100n:1n,
                (rota,q)=>{
                    const id=chave(rota,q);
                    if (!cache.has(id)) throw new CotacaoPendente(rota,q,id);
                    return cache.get(id)??null;
                },4,maxChamadas,500n);
            break;
        } catch (erro) {
            if (!(erro instanceof CotacaoPendente)) throw erro;
            pendente=erro;
        }
        if (!pendente || cache.size>=maxChamadas) return null;
        const {rota,cobrir,chave:id}=pendente;
        try {
            const data=codificarMulti(e,cobrir,1n,rota);
            const tx={from:e.dono,to:e.contrato,data,blockTag:snapshot};
            const retorno=await rpc.call(tx);
            const lucro=ABI_MULTI.decodeFunctionResult('liquidar',retorno)[0] as bigint;
            const gas=await rpc.estimateGas(tx);
            if (lucro<=0n || gas<=0n || gas+gas/5n>e.gasMax) {
                cache.set(id,null); continue;
            }
            const custo=gasEmTokenDaDivida(gas+gas/5n,e.maxFeePerGas,
                e.reservaL1Wei,e.dividaCrua,e.dividaUsd,e.ethUsd);
            gases.set(id,gas);
            cache.set(id,{recebidoDividaWei:cobrir+lucro,gasEmDividaWei:custo,
                premioEmprestimoWei:0n,bloco:snapshot,completa:true});
        } catch {
            cache.set(id,null);
        }
    }
    if (!plano) return null;
    const id=chave(plano.rota,plano.cobrirWei);
    const gas=gases.get(id);
    if (!gas || plano.brutoWei<=0n || plano.liquidoWei<=0n) return null;
    const minimoEconomico=plano.gasWei+((plano.gasWei+9n)/10n);
    const pisoBase=pisoNoContrato(plano.cobrirWei,plano.brutoWei);
    const piso=[1n,minimoEconomico,pisoBase].reduce((a,b)=>a>b?a:b);
    if (piso>plano.brutoWei) return null;
    const envio=codificarMulti(e,plano.cobrirWei,piso,plano.rota);
    // A chamada com piso definitivo prova que os bytes finais nao revertem.
    const atual=await rpc.getBlockNumber();
    if (atual-snapshot>3 || atual<snapshot) return null;
    const resp=await rpc.call({from:e.dono,to:e.contrato,data:envio,blockTag:atual});
    const confirmado=ABI_MULTI.decodeFunctionResult('liquidar',resp)[0] as bigint;
    if (confirmado<piso) return null;
    return {contrato:e.contrato,lucroCru:confirmado,liquidoCru:confirmado-plano.gasWei,
        cobrir:plano.cobrirWei,piso,gasEstimado:gas,bloco:atual,envio,rota:plano.rota};
}
/** Ultimo freio junto ao sendTransaction. Posicao que mudou nao autoriza tiro especulativo. */
export async function revalidarOfertaMulti(
    rpc:JsonRpcProvider, oferta:OfertaMulti, dono:string,
): Promise<boolean> {
    try {
        const bloco=await rpc.getBlockNumber();
        if (bloco-oferta.bloco>2 || bloco<oferta.bloco) return false;
        const saida=await rpc.call({from:dono,to:oferta.contrato,data:oferta.envio});
        const lucro=ABI_MULTI.decodeFunctionResult('liquidar',saida)[0] as bigint;
        return lucro>=oferta.piso;
    } catch { return false; }
}

/**
 * Comprovante economico: um status=1 sem evento do NOSSO executor nao
 * comprova lucro. A quantia e o alvo do evento devem bater com o envio.
 * O valor retornado e BRUTO no token da divida (ainda sem gas).
 */
export function lucroConfirmadoPorEventoMulti(
    logs: readonly { address:string;topics:readonly string[];data:string }[],
    contrato:string,usuario:string,quantia:bigint,
):bigint|null {
    for(const l of logs){
        if(l.address.toLowerCase()!==contrato.toLowerCase())continue;
        try{
            const p=ABI_MULTI.parseLog({topics:[...l.topics],data:l.data});
            if(!p || p.name!=='LiquidouComRota')continue;
            if((p.args.usuario as string).toLowerCase()!==usuario.toLowerCase())continue;
            if((p.args.quantia as bigint)!==quantia)continue;
            const lucro=p.args.lucro as bigint;
            return lucro>0n?lucro:null;
        }catch {continue;}
    }
    return null;
}
