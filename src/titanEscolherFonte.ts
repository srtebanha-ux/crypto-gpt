/**
 * TITAN / comparador de fontes. Cada fonte precisa ter PROPRIA cotacao
 * atomica e gas total medido: trocar o credor nao conserva a mesma rota,
 * nem altera a taxa interna dos swaps.
 */
export type FonteTitan = 'flashswap-v3' | 'morpho-blue' | 'aave-v3' | 'balancer';
export interface CotacaoFonte {
    fonte: FonteTitan;
    principalWei: bigint;
    lucroBrutoSimuladoWei: bigint | null;
    gasTotalConservadorWei: bigint | null; // L2 + L1
    premioBps: bigint | null; // Morpho e V3 = 0; Aave/Balancer ler onchain
    capitalDisponivel: boolean;
}
export interface AvaliacaoFonte {
    fonte: FonteTitan;
    validada: boolean;
    motivo: string;
    taxaEmprestimoWei: bigint | null;
    custoTotalWei: bigint | null;
    lucroLiquidoWei: bigint | null;
    pisoLiquidoWei: bigint | null;
}
const TETO_BPS = 10_000n;
export function avaliarFonte(
    c: CotacaoFonte, margemSobreCustoBps = 500n,
): AvaliacaoFonte {
    const invalida = (motivo: string): AvaliacaoFonte => ({
        fonte:c.fonte,validada:false,motivo,
        taxaEmprestimoWei:null,custoTotalWei:null,lucroLiquidoWei:null,pisoLiquidoWei:null,
    });
    if(margemSobreCustoBps < 1n || margemSobreCustoBps > 10_000n)
        return invalida('margem de seguranca invalida');
    if(!c.capitalDisponivel || c.principalWei<=0n)
        return invalida('sem credito disponivel ou principal zero');
    if(c.lucroBrutoSimuladoWei===null || c.gasTotalConservadorWei===null
        || c.premioBps===null)
        return invalida('simulacao integral, gas L1/L2 ou premium faltando');
    if(c.gasTotalConservadorWei<=0n || c.lucroBrutoSimuladoWei<0n
        || c.premioBps<0n || c.premioBps>TETO_BPS)
        return invalida('valores onchain invalidos');
    if((c.fonte==='morpho-blue' || c.fonte==='flashswap-v3')
        && c.premioBps!==0n)
        return invalida('taxa de fonte sem emprestimo incompatível');
    const taxa=(c.principalWei*c.premioBps+TETO_BPS-1n)/TETO_BPS;
    const custo=c.gasTotalConservadorWei+taxa;
    const piso=(custo*margemSobreCustoBps+TETO_BPS-1n)/TETO_BPS;
    const liquido=c.lucroBrutoSimuladoWei-custo;
    return { fonte:c.fonte, validada:liquido>=piso,
        motivo:liquido>=piso?'superou gas, fee e margem':
            'lucro liquido insuficiente para margem',
        taxaEmprestimoWei:taxa,custoTotalWei:custo,
        lucroLiquidoWei:liquido,pisoLiquidoWei:piso };
}
export function melhorFonte(cotacoes: readonly CotacaoFonte[],margemBps=500n):
    AvaliacaoFonte|null {
    const validas=cotacoes.map(x=>avaliarFonte(x,margemBps))
        .filter(x=>x.validada && x.lucroLiquidoWei!==null);
    validas.sort((a,b)=> a.lucroLiquidoWei! > b.lucroLiquidoWei! ? -1
        : a.lucroLiquidoWei! < b.lucroLiquidoWei! ? 1 : a.fonte.localeCompare(b.fonte));
    return validas[0]??null;
}
