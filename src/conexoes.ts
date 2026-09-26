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
import { Agent, fetch as fetchUndici } from 'undici';

/** Quantas conexoes simultaneas por servidor. */
export const CONEXOES_POR_SERVIDOR = Number(process.env.CACA_CONEXOES ?? '12');

let agente: Agent | null = null;

/**
 * Liga o pool de conexoes. Idempotente: chamar duas vezes nao cria dois pools.
 *
 * `keepAliveTimeout` alto de proposito: abrir conexao TLS custa uma viagem de
 * ida e volta, e a cada bloco sao dezenas de chamadas para o mesmo servidor.
 * Reaproveitar a conexao aberta e o que torna a segunda chamada barata.
 */
/**
 * O `fetch` DESTE undici, com o pool preso a ele.
 *
 * Nao da para instalar um undici e mandar o dispatcher para o `fetch` que vem
 * dentro do Node: sao dois modulos diferentes, com estados diferentes. Na
 * pratica o pool era aceito e a descompressao se perdia no meio — a resposta
 * chegava zipada e `res.json()` engasgava no byte 0x1f, que e a assinatura do
 * gzip. Um "conserto" que trocou fila por resposta ilegivel.
 *
 * Usar o fetch do mesmo pacote que criou o Agent resolve os dois de uma vez:
 * o pool vale, e a descompressao volta a ser feita por quem sabe.
 */
export function buscar(url: string, opcoes: Parameters<typeof fetchUndici>[1] = {}) {
    if (agente === null) {
        agente = new Agent({
            connections: CONEXOES_POR_SERVIDOR,
            keepAliveTimeout: 30_000,
            keepAliveMaxTimeout: 60_000,
        });
    }
    return fetchUndici(url, { ...opcoes, dispatcher: agente });
}

/** Quantas conexoes o pool abre. Existe so para o log dizer a verdade. */
export function abrirConexoes(): number {
    return CONEXOES_POR_SERVIDOR;
}
