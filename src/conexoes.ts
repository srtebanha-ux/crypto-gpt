// Arquivo: src/conexoes.ts
//
// Abrir mais de uma porta para o mesmo servidor.
//
// O `fetch` que vem no Node usa UMA conexao por servidor. Isso nao aparece em
// lugar nenhum: o codigo dispara cinco chamadas com `Promise.all`, o log diz
// "5 em paralelo", e as cinco entram em fila no mesmo cano. Paralelo no
// codigo, fila na rede.
//
// A medicao que denunciou: 8.384 leituras em 34 multicalls, em ondas de cinco,
// levaram 3.440ms. Se as ondas fossem mesmo simultaneas seriam ~560ms. A conta
// bateu com 34 chamadas EM FILA a ~101ms cada — o paralelismo nao existia.
//
// Um bloco da Base dura 2.000ms. Gastar 3.440ms para olhar quem caiu significa
// chegar sempre depois, e numa liquidacao quem chega depois nao leva nada.
import { Agent, setGlobalDispatcher } from 'undici';

/** Quantas conexoes simultaneas por servidor. */
export const CONEXOES_POR_SERVIDOR = Number(process.env.CACA_CONEXOES ?? '12');

let ligado = false;

/**
 * Liga o pool de conexoes. Idempotente: chamar duas vezes nao cria dois pools.
 *
 * `keepAliveTimeout` alto de proposito: abrir conexao TLS custa uma viagem de
 * ida e volta, e a cada bloco sao dezenas de chamadas para o mesmo servidor.
 * Reaproveitar a conexao aberta e o que torna a segunda chamada barata.
 */
export function abrirConexoes(): number {
    if (ligado) return CONEXOES_POR_SERVIDOR;
    setGlobalDispatcher(
        new Agent({
            connections: CONEXOES_POR_SERVIDOR,
            keepAliveTimeout: 30_000,
            keepAliveMaxTimeout: 60_000,
        }),
    );
    ligado = true;
    return CONEXOES_POR_SERVIDOR;
}
