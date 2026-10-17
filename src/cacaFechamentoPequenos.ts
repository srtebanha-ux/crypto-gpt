/**
 * Fechamento de posicoes pequenas da Aave V3.3.
 *
 * Aave admite close factor de 100% quando a divida no ativo OU o
 * colateral da reserva tem valor inferior a US$2.000. Liquidar 50%
 * da divida pode reverter por MustNotLeaveDust(), pois sobra <US$1.000.
 *
 * Esta estrategia e OPT-IN por enderecos de devedores especificos.
 * A cotacao para credito flash precisa cobrir juros ocorridos entre
 * leitura e execucao; usamos apenas 10 bps de folga.
 *
 * Nao decide liquidabilidade, lucro, gas ou broadcast. O fluxo
 * principal faz eth_call/estimateGas antes de poder enviar.
 */
import Decimal from 'decimal.js';

export const LIMIAR_FECHAMENTO_USD=new Decimal(2000);
export const FOLGA_JUROS_BPS=10n;

export function enderecosPrioritarios(valor:string|undefined):ReadonlySet<string>{
    const out=new Set<string>();
    for(const item of (valor??'').split(',')){
        const addr=item.trim().toLowerCase();
        if(/^0x[0-9a-f]{40}$/.test(addr))out.add(addr);
    }
    return out;
}
export function coberturaPrioritariaPequena(args:{
    endereco:string;
    dividaCrua:bigint;
    dividaUsd:Decimal|undefined;
    tamanhoBase:bigint;
    enderecos:ReadonlySet<string>;
}):bigint{
    if(!args.enderecos.has(args.endereco.toLowerCase()))return args.tamanhoBase;
    if(args.dividaCrua<=0n||args.tamanhoBase<=0n)return args.tamanhoBase;
    const usd=args.dividaUsd;
    if(!usd||!usd.isFinite()||usd.lessThanOrEqualTo(0)
        ||usd.greaterThanOrEqualTo(LIMIAR_FECHAMENTO_USD))return args.tamanhoBase;
    const folga=(args.dividaCrua*FOLGA_JUROS_BPS+9999n)/10000n;
    return args.dividaCrua+(folga>0n?folga:1n);
}
