/**
 * Prioridade de observacao (nao de execucao) para contas informadas pelo dono.
 *
 * Reutiliza as vagas existentes do multicall: evita perder um alvo porque
 * outras contas ultrapassaram seu ranking, e o inclui nos primeiros candidatos
 * do pre-armamento, que so ocorre quando a postura esta urgente.
 *
 * Nao altera elegibilidade Aave, oraculo, gas, contratos ou decisao de envio.
 */
import Decimal from 'decimal.js';

interface MedicaoDeRisco {
    devedor:string;
    queda:Decimal;
    dividaUsd:Decimal|null;
    via?:string;
}
export interface ResultadoDaPrioridade {
    brasa:string[];
    quentes:string[];
    incluidos:string[];
    movidos:string[];
    semMedicao:string[];
}
export function reservarAlvosNaBrasa(args:{
    brasa:readonly string[];
    quentes:readonly string[];
    medidos:readonly MedicaoDeRisco[];
    prioritarios:ReadonlySet<string>;
    vagas:number;
    pisoUsd:Decimal|null;
    limiteQuedaPct?:number;
}):ResultadoDaPrioridade {
    const cap=Math.max(0,Number.isFinite(args.vagas)?Math.floor(args.vagas):0);
    const atuais=[...args.brasa];
    const vista=new Map(args.medidos.map(m=>[m.devedor.toLowerCase(),m]));
    const novos:string[]=[],semMedicao:string[]=[];
    const corte=new Decimal(args.limiteQuedaPct??5);
    for(const raw of args.prioritarios){
        const d=raw.toLowerCase(),m=vista.get(d);
        if(!m||m.queda.isNegative()||!m.queda.isFinite()
            ||m.queda.greaterThan(corte)||m.via==='imune'
            ||m.dividaUsd===null||!m.dividaUsd.isFinite()
            ||m.dividaUsd.lessThanOrEqualTo(0)
            ||(args.pisoUsd!==null&&m.dividaUsd.lessThan(args.pisoUsd))){
            semMedicao.push(d);
            continue;
        }
        if(!novos.includes(d))novos.push(d);
    }
    // Prioritarios sempre ocupam as primeiras vagas (ate o limite real);
    // os demais mantem a ordem calculada pelo algoritmo original.
    const originais=[...atuais,...args.quentes];
    const brasa=[...new Set([...novos,...atuais].map(s=>s.toLowerCase()))].slice(0,cap);
    const presentes=new Set(brasa);
    const quentes=[...new Set(originais.map(s=>s.toLowerCase()))]
        .filter(d=>!presentes.has(d));
    const antes=new Set(atuais.map(s=>s.toLowerCase()));
    return {
        brasa,quentes,
        incluidos:novos.filter(d=>presentes.has(d)),
        movidos:novos.filter(d=>presentes.has(d)&&!antes.has(d)),
        semMedicao,
    };
}


/**
 * Acordar por aviso de novo bloco APENAS quando uma carteira escolhida
 * esta a menos de 0.75% de cruzar o HF=1.
 *
 * Fora da zona critica, o bot conserva o sono orientado a mercado e
 * o orcamento de RPC. Nunca antecipa o envio: apenas antecipa a leitura.
 */
export function acordarPorBlocoSeAlvoCritico(
    faltaPct:Decimal|null,
    limitePct=new Decimal('0.75'),
):boolean{
    return faltaPct!==null && faltaPct.isFinite()
        && faltaPct.greaterThanOrEqualTo(0)
        && faltaPct.lessThanOrEqualTo(limitePct);
}
