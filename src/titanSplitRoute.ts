/**
 * TITAN / split routing para liquidacoes GRANDES.
 * Avalia quotas de DUAS DEX no mesmo snapshot; nao inventa slippage ou
 * converte ETH em USDC implicitamente. "gasExtraNaSaida" precisa vir
 * de um oraculo/quote medido na unidade do token DE SAIDA.
 *
 * Este modulo SOMENTE decide, nao executa transacoes.
 */
export interface SplitTitan {
    partePrimeira: bigint;
    parteSegunda: bigint;
    saidaBruta: bigint;
    saidaAposGasExtra: bigint;
    percentualPrimeira: number;
}
export function escolherSplitTitan(
    montante:bigint,
    quoteA:(input:bigint)=>bigint|null,
    quoteB:(input:bigint)=>bigint|null,
    gasExtraNaSaida:bigint|null,
    passos=20,
):SplitTitan|null {
    if(montante<=0n||!Number.isSafeInteger(passos)||passos<2||passos>100)
        throw new Error('quantia ou resolucao invalida');
    // Sem conversao onchain de gas em token de divida, nao ha decisao.
    if(gasExtraNaSaida===null||gasExtraNaSaida<0n) return null;
    let melhor:SplitTitan|null=null;
    for(let i=0;i<=passos;i++){
        const partePrimeira=montante*BigInt(i)/BigInt(passos);
        const parteSegunda=montante-partePrimeira;
        const a=partePrimeira===0n?0n:quoteA(partePrimeira);
        const b=parteSegunda===0n?0n:quoteB(parteSegunda);
        if(a===null||b===null||a<0n||b<0n) continue;
        const saidaBruta=a+b;
        const custo=(partePrimeira>0n&&parteSegunda>0n)?gasExtraNaSaida:0n;
        const resultado=saidaBruta-custo;
        if(!melhor||resultado>melhor.saidaAposGasExtra){
            melhor={partePrimeira,parteSegunda,saidaBruta,
                saidaAposGasExtra:resultado,percentualPrimeira:100*i/passos};
        }
    }
    return melhor;
}
