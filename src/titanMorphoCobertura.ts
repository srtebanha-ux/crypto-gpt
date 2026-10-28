/**
 * Politica de cobertura do radar Morpho na Base (SOMENTE LEITURA).
 * Nada daqui pode autorizar carteira, nonce, transacao ou lucro.
 * Limites fechados evitam que uma variavel errada derrube o cacador.
 */
export type PoliticaCoberturaMorpho = Readonly<{
    intervaloMs:number;
    mercadosPorRodada:number;
    mercadosComDevedores:number;
    posicoesPorMercado:number;
    requisicoesHttp:number;
    prazoMs:number;
}>;

function numeroLimitado(
    raw:string|undefined,padrao:number,min:number,max:number,
):number{
    if(raw===undefined||raw.trim()==='')return padrao;
    const n=Number(raw);
    if(!Number.isSafeInteger(n))return padrao;
    return Math.max(min,Math.min(max,n));
}

export function politicaDeCoberturaMorpho(
    env:NodeJS.ProcessEnv=process.env,
):PoliticaCoberturaMorpho {
    // Amplia os mercados visitados na janela de 3 minutos (20 -> 32) sem
    // alterar os tetos de RPC/HTTP, o prazo, os limites de gas ou o envio.
    // A fila persistente prioriza 25% por divida e 75% por rodizio.
    const mercadosPorRodada=numeroLimitado(
        env.CACA_MORPHO_MERCADOS_POR_RODADA,36,12,72);
    return {
        intervaloMs:numeroLimitado(
            env.CACA_MORPHO_INTERVALO_MS,180_000,120_000,3_600_000),
        mercadosPorRodada,
        mercadosComDevedores:Math.min(mercadosPorRodada,numeroLimitado(
            env.CACA_MORPHO_MERCADOS_COM_DEVEDORES,32,1,36)),
        posicoesPorMercado:numeroLimitado(
            env.CACA_MORPHO_POSICOES_POR_MERCADO,36,1,60),
        requisicoesHttp:numeroLimitado(
            env.CACA_MORPHO_HTTP_POR_RODADA,95,50,150),
        prazoMs:numeroLimitado(
            env.CACA_MORPHO_PRAZO_MS,75_000,45_000,100_000),
    };
}

/** Uma rodada muda junto com a frequencia do scanner, inclusive apos restart. */
export function indiceDeRodadaMorpho(agoraMs:number,intervaloMs:number):number{
    if(!Number.isSafeInteger(agoraMs)||agoraMs<0
       ||!Number.isSafeInteger(intervaloMs)||intervaloMs<=0)
        throw Error('indice Morpho requer tempo e intervalo validos');
    return Math.floor(agoraMs/intervaloMs);
}
