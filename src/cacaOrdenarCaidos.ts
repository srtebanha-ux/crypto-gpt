/**
 * Ordena SOMENTE posicoes que a leitura do Pool ja marcou como liquidaveis
 * (ou incluidas pela politica de tiro antecipado preexistente).
 *
 * Evita que uma posicao de US$3 bloqueie o nonce de outra com premio maior
 * quando ambas cruzam no mesmo bloco. Alvos fora da selecao mantem a ordem.
 *
 * Nao muda Health Factor, simulacao, slippage, limites de gas ou lucro minimo.
 * A estimativa de premio e apenas priorizacao, nao autoriza o envio.
 */
import Decimal from 'decimal.js';

export function ordenarCaidosPorPremio(args:{
    caidos:readonly string[];
    prioritarios:ReadonlySet<string>;
    premiosUsd:ReadonlyMap<string,Decimal>;
}):string[]{
    const pontuar=(devedor:string):Decimal|null=>{
        const addr=devedor.toLowerCase();
        if(!args.prioritarios.has(addr))return null;
        const premio=args.premiosUsd.get(addr);
        if(!premio||!premio.isFinite()||premio.lessThanOrEqualTo(0))return null;
        return premio;
    };
    const indexados=args.caidos.map((devedor,ordem)=>({devedor,ordem,premio:pontuar(devedor)}));
    indexados.sort((a,b)=>{
        if(a.premio===null&&b.premio!==null)return 1;
        if(a.premio!==null&&b.premio===null)return -1;
        if(a.premio!==null&&b.premio!==null){
            const comparacao=b.premio.comparedTo(a.premio);
            if(comparacao!==0)return comparacao;
        }
        return a.ordem-b.ordem;
    });
    return indexados.map(x=>x.devedor);
}
