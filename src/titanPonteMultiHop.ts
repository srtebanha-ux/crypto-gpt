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

const ENDERECO = /^0x[0-9a-fA-F]{40}$/;
export const MORPHO_FLASH_BASE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
export const ABI_MULTI = new Interface([
    'function liquidar(address usuario,address garantia,address divida,uint256 cobrir,uint256 lucroMinimo,(address pool,address tokenEntra,uint8 tipo,uint24 fee)[] rota) returns (uint256 lucro)',
    'function dono() view returns (address)',
    'function cofre() view returns (address)',
    'function aave() view returns (address)',
    'function morpho() view returns (address)',
    'function fabricaV3() view returns (address)',
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
            || !['v3', 'aerodrome'].includes(String(a.protocolo))
            || a.permitida !== true
            || (a.protocolo === 'v3' && (!Number.isSafeInteger(a.taxa)
                || Number(a.taxa) <= 0 || Number(a.taxa) > 10000))
            || (a.protocolo === 'aerodrome' && a.taxa !== null && a.taxa !== 0)) {
            throw new Error('pool nao validada: enderecos, protocolo, taxa ou permissao');
        }
        return a as unknown as PoolLiquidacao;
    });
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
