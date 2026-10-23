/**
 * TITAN: une grafo multi-hop, tamanho de credito e lucro liquido.
 * Cada cotacao simula no MESMO snapshot a liquidacao + TODOS os swaps.
 * E um planejador deterministico sem assinatura, gas pago ou broadcast.
 * A execucao real exige contrato, fork e verificador adicionais.
 */
import {
    gerarRotasLiquidacao,type PoolLiquidacao,type RotaLiquidacao,
} from './titanRotasLiquidacao';
import {otimizarTamanhoTitan,variacoesDePrecisao} from './titanOtimizadorTamanho';
export interface SimulacaoLiquidacao {
    recebidoDividaWei: bigint;
    gasEmDividaWei: bigint;
    premioEmprestimoWei: bigint;
    bloco: number;
    completa: boolean;
}
export interface PlanoLiquidacaoTitan {
    rota: RotaLiquidacao;
    cobrirWei: bigint;
    liquidoWei: bigint;
    brutoWei: bigint;
    gasWei: bigint;
    bloco: number;
    chamadas: number;
}
export function planejarLiquidacaoTitan(
    pools:readonly PoolLiquidacao[],colateral:string,divida:string,
    maxCredito:bigint,granularidade:bigint,
    simular:(rota:RotaLiquidacao,cobrir:bigint)=>SimulacaoLiquidacao|null,
    limiteDeRotas=12,limiteDeCalls=24,margemBps=500n,
):PlanoLiquidacaoTitan|null {
    if(maxCredito<granularidade||granularidade<=0n
        ||limiteDeRotas<1||limiteDeRotas>100
        ||limiteDeCalls<8||limiteDeCalls>256
        ||margemBps<1n||margemBps>10_000n)return null;
    const rotas=gerarRotasLiquidacao(pools,colateral,divida,4,limiteDeRotas);
    let melhor:PlanoLiquidacaoTitan|null=null;
    let blocoDoSnapshot:number|null=null;
    let restantes=limiteDeCalls;
    for(const rota of rotas) {
        if(restantes<8)break;
        let cotacoes=0;
        const consultar=(cobrir:bigint):bigint|null=>{
            if(restantes<=0)return null;
            restantes--;cotacoes++;
            const x=simular(rota,cobrir);
            if(!x||!x.completa||x.gasEmDividaWei<0n
                ||x.premioEmprestimoWei<0n||x.recebidoDividaWei<0n
                ||!Number.isSafeInteger(x.bloco))return null;
            if(blocoDoSnapshot===null)blocoDoSnapshot=x.bloco;
            if(x.bloco!==blocoDoSnapshot)return null;
            const custo=x.gasEmDividaWei+x.premioEmprestimoWei;
            const bruto=x.recebidoDividaWei-cobrir;
            const minimo=(custo*margemBps+9_999n)/10_000n;
            const liquido=bruto-custo;
            return liquido>=minimo?liquido:null;
        };
        const tamanho=otimizarTamanhoTitan(maxCredito,granularidade,consultar,
            Math.min(restantes-3,10));
        if(tamanho===null)continue;
        // Revalidacao discreta local: resultados NAO comprovados jamais
        // sao fabricados. Testar +/- 1 unidade perto do tamanho vencedor.
        for(const v of variacoesDePrecisao(tamanho.quantia,maxCredito,granularidade)
            .filter(v=>v===tamanho.quantia-granularidade
                ||v===tamanho.quantia+granularidade)){
            if(restantes<=0)break;
            consultar(v);
        }
        // IMPORTANTE: repetir simulacao no mesmo bloco para fixar BRUTO e gas
        if(restantes<=0)continue;
        restantes--;cotacoes++;
        const q=simular(rota,tamanho.quantia);
        if(!q||!q.completa||q.bloco!==blocoDoSnapshot
            ||q.gasEmDividaWei<0n||q.premioEmprestimoWei<0n)continue;
        const bruto=q.recebidoDividaWei-tamanho.quantia;
        const gasto=q.gasEmDividaWei+q.premioEmprestimoWei;
        const liquido=bruto-gasto;
        if(liquido<(gasto*margemBps+9_999n)/10_000n)continue;
        if(!melhor||liquido>melhor.liquidoWei)
            melhor={rota,cobrirWei:tamanho.quantia,liquidoWei:liquido,
                brutoWei:bruto,gasWei:gasto,bloco:q.bloco,chamadas:cotacoes};
    }
    return melhor;
}
