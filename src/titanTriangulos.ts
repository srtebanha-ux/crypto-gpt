/**
 * Discovery-only: detecta ciclos 3-hop na rede Base para futura cotacao
 * no executor. NAO gera tx, nao supoe taxa, nao chama o quoter de 2 hops.
 * Os tres pools sao diferentes e o caminho precisa fechar em WETH.
 */
import type {PoolMisto,Venue,PernaDescrita,LeiturasDoEstado,PernaMista} from './rotasMistas';
import {razaoDaPerna} from './rotasMistas';

export interface TrianguloTitan{
    id:string;
    tokens:readonly [string,string,string,string];
    pools:readonly [string,string,string];
    venues:readonly [Venue,Venue,Venue];
    pernas:readonly [PernaDescrita,PernaDescrita,PernaDescrita];
    /** Sem cotacao atomica este estado NUNCA pode autorizar envio. */
    prova:'descoberto-sem-cotacao';
}
type Aresta={destino:string;pool:string;venue:Venue;metadata:PoolMisto};
export function explorarTriangulos(
    pools:readonly PoolMisto[],base:string,teto=1000,
):TrianguloTitan[]{
    const raiz=base.toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(raiz))return [];
    const limite=Number.isInteger(teto)&&teto>=1?Math.min(2000,teto):1000;
    const grafo=new Map<string,Aresta[]>();
    const add=(a:string,b:string,p:PoolMisto)=>{
        const arr=grafo.get(a)??[];
        arr.push({destino:b,pool:p.endereco.toLowerCase(),venue:p.venue,metadata:p});
        grafo.set(a,arr);
    };
    for(const p of pools){
        const a=p.token0.toLowerCase(),b=p.token1.toLowerCase(),addr=p.endereco.toLowerCase();
        if(!/^0x[0-9a-f]{40}$/.test(a)||!/^0x[0-9a-f]{40}$/.test(b)
            ||!/^0x[0-9a-f]{40}$/.test(addr)||a===b
            ||(p.venue!=='v3' && p.venue!=='aerodrome'))continue;
        add(a,b,p);add(b,a,p);
    }
    const out:TrianguloTitan[]=[],seen=new Set<string>();
    for(const first of grafo.get(raiz)??[]){
        if(first.destino===raiz)continue;
        for(const second of grafo.get(first.destino)??[]){
            if(second.destino===raiz||second.destino===first.destino
                ||second.pool===first.pool)continue;
            for(const third of grafo.get(second.destino)??[]){
                if(third.destino!==raiz||third.pool===first.pool
                    ||third.pool===second.pool)continue;
                const id=[first.pool,second.pool,third.pool].join('>');
                if(seen.has(id))continue;
                seen.add(id);
                out.push({
                    id,
                    tokens:[raiz,first.destino,second.destino,raiz],
                    pools:[first.pool,second.pool,third.pool],
                    venues:[first.venue,second.venue,third.venue],
                    pernas:([first,second,third] as const).map((p,i)=>({
                        pool:p.pool,tokenEntra:i===0?raiz:i===1?first.destino:second.destino,
                        protocolo:p.venue,
                        fabrica:p.metadata.fabrica??null,
                        taxa:p.metadata.taxa,
                        estavel:p.metadata.estavel??null,
                        token0:p.metadata.token0.toLowerCase(),
                    })) as unknown as [PernaDescrita,PernaDescrita,PernaDescrita],
                    prova:'descoberto-sem-cotacao'
                });
                if(out.length>=limite)return out;
            }
        }
    }
    return out;
}


export type TrianguloAvaliado={
    estado:'sem-spread'|'vale-simular'|'dados-insuficientes';
    porque:string; tetoNumerador?:bigint; tetoDenominador?:bigint;
};
/** O teto para um ciclo de 3 swaps e o PRODUTO das razoes marginais.
 * Falta de dados nao permite descartar. Stable nao usa x*y=k e devolve null.
 */
export function avaliarTetoTriangulo(t:TrianguloTitan,L:LeiturasDoEstado):TrianguloAvaliado{
    const razoes=t.pernas.map(p=>razaoDaPerna(p,L));
    if(razoes.some(r=>r===null||r.den<=0n))
        return{estado:'dados-insuficientes',porque:'sem prova marginal para todas as tres pernas'};
    const r=razoes as Array<NonNullable<typeof razoes[number]>>;
    const num=r.reduce((acc,v)=>acc*v.num,1n);
    const den=r.reduce((acc,v)=>acc*v.den,1n);
    if(num<=den)return{estado:'sem-spread',
        porque:'produto das tres razoes marginais <= 1; nenhum tamanho lucrativo (sem fee extra)',
        tetoNumerador:num,tetoDenominador:den};
    return{estado:'vale-simular',porque:'limite marginal permite lucro, requer simulacao EVM completa',
        tetoNumerador:num,tetoDenominador:den};
}
export function capacidadePrimeiroPool(t:TrianguloTitan,L:LeiturasDoEstado):bigint|null{
    const p=t.pernas[0],key=p.pool.toLowerCase();
    if(p.tokenEntra.toLowerCase()!==t.tokens[0].toLowerCase())return null;
    if(p.protocolo==='v3')return L.saldoDaBaseNoV3?.get(key)??null;
    const r=L.reservasAerodrome.get(key)??null;
    if(r===null)return null;
    return p.token0.toLowerCase()===t.tokens[0].toLowerCase()?r.r0:r.r1;
}
/** Parte do saldo realmente lido do pool emprestador, nunca numero arbitrario de WETH. */
export function tamanhosTriangulo(capacidade:bigint|null):bigint[]{
    if(capacidade===null||capacidade<=0n)return [];
    const partes=[1000n,300n,100n]; // 0.1%, ~0.33%, 1% da capacidade observada
    return [...new Set(partes.map(n=>capacidade/n)
        .filter(v=>v>0n).map(v=>v.toString()))].map(v=>BigInt(v));
}
/**
 * Escalona ate 'limite' tamanhos REAIS observados, sem duplicatas.
 * A primeira sonda roda em round-robin para nao favorecer sempre o
 * mesmo percentual de liquidez. Nunca cria tx: apenas escolhe entradas
 * para simulacao. 1..3 sondas, sem aumentar o tamanho do flash emprestado.
 */
export function sondasTriangulo(
    tamanhos: readonly bigint[], rodada: number, limite = 3,
): bigint[] {
    if (!Number.isSafeInteger(rodada) || rodada < 0) return [];
    if (!Number.isSafeInteger(limite) || limite < 1) return [];
    const validos = [...new Set(tamanhos.filter(x => x > 0n).map(x => x.toString()))].map(BigInt);
    if (validos.length === 0) return [];
    const teto = Math.min(3, limite, validos.length);
    const inicio = rodada % validos.length;
    return Array.from({length: teto}, (_, i) => validos[(inicio + i) % validos.length]!);
}

export function rotaExecutavelTriangulo(t:TrianguloTitan,tamanho:bigint):PernaMista[]{
    if(tamanho<=0n||t.tokens[0].toLowerCase()!==t.tokens[3].toLowerCase()
        ||new Set(t.pools).size!==3)throw Error('triangulo invalido');
    return t.pernas.map((p,i)=>({
        pool:p.pool,tokenEntra:p.tokenEntra,
        tipo:p.protocolo==='v3'?0 as const:1 as const,
        pagamento:i===0&&p.protocolo==='aerodrome'?tamanho:0n,
    }));
}
