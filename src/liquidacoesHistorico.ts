// Arquivo: src/liquidacoesHistorico.ts
//
// Lê o histórico de liquidações já acontecidas e responde, sem gastar um
// centavo, se vale construir um caçador de liquidações.
//
// NÃO envia transação, não assina nada, não precisa de chave privada. Só
// `eth_getLogs` contra um RPC de leitura.
//
// Três perguntas, nesta ordem de importância:
//
//   1. Existem liquidações GRANDES? Se nenhuma passa de US$50 mil, a ideia
//      morre aqui, hoje, de graça.
//   2. QUANTOS endereços diferentes capturaram? Trezentas divididas por três
//      robôs é lugar tomado; trezentas por duzentos endereços é lugar que
//      sobra. Esta linha vale mais que o total.
//   3. De que tamanho? O bônus é fração da dívida alheia, então o tamanho da
//      dívida é o tamanho do prêmio.
//
// MODO DESCOBERTA: a assinatura do evento em liquidacoes.ts é um palpite —
// quem escreveu não alcançava a rede nem tinha keccak à mão. Sem
// LIQUIDACOES_TOPIC0 definido, este programa busca TODOS os eventos do
// contrato e mostra quais existem, com contagem. A primeira rodada real vira
// a verificação que não deu para fazer antes; o tópico certo aparece no log
// em vez de o programa devolver zero em silêncio.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import {
    TOPIC_LIQUIDATION_CALL,
    contarPorTopico,
    ehLimiteDeFaixa,
    REDES,
    gorjetaWei,
    lerDisputaPorPiso,
    lerPosicao,
    multiploDaBase,
    decodificarLiquidacao,
    faixasDeBlocos,
    resumirHistorico,
    type Liquidacao,
    type LogCru,
} from './liquidacoes';

const log = createLogger('liquidacoes');

/**
 * Rede escolhida por NOME, com endereço, contrato e tempo de bloco juntos.
 *
 * Antes eram três variáveis que tinham de concordar entre si, e errar uma
 * produzia número de aparência certa: com o tempo de bloco da Base aplicado
 * ao Ethereum, o relatório anunciou "~30 dias" para 180 e dividiu todo
 * "por dia" por seis. Um nome só não tem como discordar de si mesmo.
 *
 * As variáveis individuais continuam valendo e têm prioridade, para ajustar
 * um campo sem abandonar o resto do preset.
 */
const REDE = REDES[(process.env.LIQUIDACOES_REDE ?? 'base').toLowerCase()] ?? REDES.base;
const RPC = process.env.LIQUIDACOES_RPC_URL ?? REDE.rpc;
/** Aave V3 Pool na Base. Variável porque eu não pude conferir o endereço. */
const POOL = (process.env.LIQUIDACOES_POOL ?? REDE.pool).toLowerCase();
/** Vazio = modo descoberta. Ver o comentário no topo. */
const TOPIC0 = process.env.LIQUIDACOES_TOPIC0 ?? '';
const BLOCOS = Number(process.env.LIQUIDACOES_BLOCOS ?? String(REDE.blocos180d));
const PEDACO = Number(process.env.LIQUIDACOES_PEDACO ?? '2000');
const PAUSA_MS = Number(process.env.LIQUIDACOES_PAUSA_MS ?? '120');
const TIMEOUT_MS = Number(process.env.LIQUIDACOES_TIMEOUT_MS ?? '20000');
/**
 * Segundos por bloco, para converter janela de blocos em DIAS.
 *
 * Estava fixo em 2 (o da Base) e por isso o relatório anunciou "~30,0 dias"
 * para 1.296.000 blocos do Ethereum, que são 180. Um número de aparência certa
 * dividindo todos os "por dia" por seis.
 */
const SEG_POR_BLOCO = Number(process.env.LIQUIDACOES_SEG_POR_BLOCO ?? String(REDE.segPorBloco));

/**
 * Preço do ETH em dólares, informado à mão — e por que NÃO é buscado sozinho.
 *
 * Sem ele, 31% das liquidações da Base somem do relatório porque a dívida está
 * em WETH/cbETH, e o veredicto fica suspenso: a maior de todas pode estar
 * escondida aí. Com ele, elas voltam — mas com um preço de HOJE aplicado a
 * eventos de até seis meses atrás, o que é aproximado e está longe de exato.
 *
 * Deixar em branco continua sendo a opção correta quando o que se quer é um
 * número em que dá para confiar. Preencher é para responder "a maior está
 * escondida entre as não cotadas?" — e a resposta vem rotulada de aproximada.
 */
const PRECO_ETH = process.env.LIQUIDACOES_PRECO_ETH
    ? new Decimal(process.env.LIQUIDACOES_PRECO_ETH)
    : null;

let rpcId = 0;

async function chamar<T>(metodo: string, params: unknown[]): Promise<T> {
    const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: metodo, params }),
        // Sem isto uma conexão pendurada trava a varredura inteira em silêncio
        // — o mesmo defeito que já custou uma amostra no motor de scalping.
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`RPC: ${body.error.message}`);
    if (body.result === undefined) throw new Error('RPC devolveu resposta sem resultado');
    return body.result;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function principal(): Promise<void> {
    log.info('*** MODO LEITURA — nenhuma transação é enviada por este processo. ***');

    const topoHex = await chamar<string>('eth_blockNumber', []);
    const topo = Number.parseInt(topoHex, 16);
    const inicio = Math.max(0, topo - BLOCOS);
    const faixas = faixasDeBlocos(inicio, topo, PEDACO);

    log.info('Varredura de liquidações iniciada.', {
        rede: REDE.nome,
        rpc: RPC.replace(/\/v2\/.*$/, '/v2/***'),
        contrato: POOL,
        blocos: `${inicio} → ${topo} (${BLOCOS})`,
        pedacos: faixas.length,
        modo: TOPIC0 === '' ? 'DESCOBERTA (sem filtro de evento)' : `filtrando ${TOPIC0}`,
        palpiteDoTopico: TOPIC_LIQUIDATION_CALL,
    });

    const todos: LogCru[] = [];
    const liquidacoes: Liquidacao[] = [];
    let indecifraveis = 0;
    let pedacosComErro = 0;

    // Fila em vez de laço fixo: quando o provedor recusa a faixa por tamanho, o
    // pedaço é PARTIDO AO MEIO e os dois metades voltam para a fila. Isso
    // encontra sozinho o teto de qualquer provedor — o da Alchemy grátis é de
    // 10 blocos, outros aceitam milhares — em vez de exigir que alguém acerte
    // LIQUIDACOES_PEDACO na mão antes de saber qual é.
    const fila: Array<[number, number]> = [...faixas];
    let menorQueCoube = PEDACO;
    let partidas = 0;
    let lidos = 0;

    while (fila.length > 0) {
        const [de, ate] = fila.shift() as [number, number];
        const filtro: Record<string, unknown> = {
            address: POOL,
            fromBlock: `0x${de.toString(16)}`,
            toBlock: `0x${ate.toString(16)}`,
        };
        if (TOPIC0 !== '') filtro.topics = [TOPIC0];

        try {
            const logs = await chamar<LogCru[]>('eth_getLogs', [filtro]);
            todos.push(...logs);
            lidos += 1;
            menorQueCoube = Math.min(menorQueCoube, ate - de + 1);
            if (TOPIC0 !== '') {
                for (const l of logs) {
                    try {
                        liquidacoes.push(decodificarLiquidacao(l));
                    } catch {
                        indecifraveis += 1;
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (ehLimiteDeFaixa(msg) && ate > de) {
                const meio = Math.floor((de + ate) / 2);
                fila.unshift([meio + 1, ate]);
                fila.unshift([de, meio]);
                partidas += 1;
                if (partidas === 1) {
                    log.info('Faixa grande demais para este provedor; partindo ao meio.', {
                        primeiraRecusa: msg.slice(0, 160),
                    });
                }
                continue;
            }
            pedacosComErro += 1;
            log.warn('Pedaço falhou; seguindo.', { faixa: `${de}-${ate}`, erro: msg.slice(0, 160) });
        }

        if (lidos > 0 && lidos % 200 === 0) {
            log.info('Progresso.', {
                lidos,
                naFila: fila.length,
                eventos: todos.length,
                falhas: pedacosComErro,
                menorQueCoube,
            });
        }
        await dormir(PAUSA_MS);
    }

    log.info('Varredura terminada.', {
        pedacosLidos: lidos,
        partidasPorLimite: partidas,
        maiorFaixaAceita: menorQueCoube,
        falhas: pedacosComErro,
        eventos: todos.length,
    });

    if (TOPIC0 === '') {
        const porTopico = contarPorTopico(todos);
        log.info('DESCOBERTA: eventos que este contrato emite.', {
            eventosLidos: todos.length,
            pedacosComErro,
            tiposEncontrados: porTopico.length,
            // Se um destes for o palpite lá de cima, o palpite estava certo.
            ranking: porTopico.slice(0, 12).map((t) => `${t.topico} x${t.quantos}`).join(' | '),
            // Duas causas diferentes para o mesmo zero, e confundi-las já
            // mandou procurar defeito no lugar errado: se NENHUMA leitura deu
            // certo, o endereço não foi testado — só o provedor respondeu.
            oQueFazer:
                todos.length > 0
                    ? 'defina LIQUIDACOES_TOPIC0 com o tópico das liquidações e rode de novo'
                    : pedacosComErro > 0
                      ? 'NENHUMA leitura teve sucesso. O endereço NÃO foi testado — o problema está no provedor de RPC. Veja o erro acima.'
                      : 'Leituras funcionaram e o contrato não emitiu nada no período: endereço provavelmente errado. Confira LIQUIDACOES_POOL.',
            confereComOPalpite: TOPIC_LIQUIDATION_CALL,
        });
        return;
    }

    const r = resumirHistorico(liquidacoes, undefined, PRECO_ETH);
    const dias = (BLOCOS * SEG_POR_BLOCO) / 86400;

    log.info('HISTÓRICO DE LIQUIDAÇÕES.', {
        periodo: `~${dias.toFixed(1)} dias (${BLOCOS} blocos)`,
        total: r.total,
        semCotacao: r.semCotacao,
        indecifraveis,
        pedacosComErro,
        acimaDe: Object.entries(r.porFaixa)
            .map(([faixa, n]) => `$${Number(faixa).toLocaleString('en-US')}: ${n}`)
            .join(' | '),
        maior: r.maior ? `$${r.maior.toFixed(0)}` : '—',
        porDia: (r.total / Math.max(dias, 1)).toFixed(1),
        // A linha que decide. Ver o comentário em resumirHistorico.
        liquidantesDistintos: r.liquidantesDistintos,
        concentracao:
            r.total > 0
                ? `os 5 maiores pegaram ${(
                      (r.maioresLiquidantes.reduce((s, m) => s + m.quantas, 0) / r.total) * 100
                  ).toFixed(0)}%`
                : '—',
        maioresLiquidantes: r.maioresLiquidantes.map((m) => `${m.endereco} x${m.quantas}`).join(' | '),
    });

    // As maiores UMA A UMA, com quem levou cada uma. Ver o comentário em
    // ResumoDoHistorico: o ranking por contagem não separa "cata migalha" de
    // "leva tudo", e são conclusões opostas.
    const donos = new Set(r.maioresLiquidacoes.map((m) => m.liquidante));
    log.info('AS MAIORES, UMA A UMA — quem levou cada uma.', {
        quantasOlhadas: r.maioresLiquidacoes.length,
        enderecosDiferentes: donos.size,
        leitura:
            r.maioresLiquidacoes.length === 0
                ? 'nenhuma com valor conhecido'
                : donos.size === 1
                  ? 'UM endereço levou TODAS as maiores: o lugar está tomado nas grandes.'
                  : donos.size >= r.maioresLiquidacoes.length * 0.6
                    ? 'Bem espalhadas entre endereços diferentes: as grandes NÃO são de um dono só.'
                    : 'Espalhamento parcial — alguns endereços repetem nas grandes.',
        lista: r.maioresLiquidacoes
            .map((m) => `$${m.usd.toFixed(0)} -> ${m.liquidante.slice(0, 10)} (bloco ${m.bloco})`)
            .join(' | '),
    });

    const grandes = r.porFaixa[50_000] ?? 0;
    const tentados = lidos + pedacosComErro;
    const furo = tentados > 0 ? pedacosComErro / tentados : 1;
    const semPreco = r.total > 0 ? r.semCotacao / r.total : 0;

    // O veredicto se RECUSA a concluir quando a amostra não sustenta conclusão.
    //
    // Escrito depois de ele anunciar "a ideia morre aqui" duas vezes em vinte
    // minutos: uma com 645 de 649 pedaços falhando, outra com 25% das
    // liquidações em tokens sem cotação. Nos dois casos a frase estava
    // gramaticalmente perfeita e factualmente vazia — ele lia `grandes === 0`
    // sem olhar se tinha lido alguma coisa.
    //
    // Matar uma ideia é uma decisão cara; ela merece o mesmo cuidado que
    // aprovar uma.
    let leitura: string;
    if (furo > 0.05) {
        leitura =
            `VEREDICTO SUSPENSO: ${pedacosComErro} de ${tentados} pedaços falharam ` +
            `(${(furo * 100).toFixed(0)}%). Esta amostra não mede nada — conserte o RPC e rode de novo.`;
    } else if (semPreco > 0.2) {
        leitura =
            `VEREDICTO SUSPENSO: ${(semPreco * 100).toFixed(0)}% das liquidações são em tokens que eu não sei ` +
            `cotar, então o tamanho delas é invisível. A maior pode estar entre elas.`;
    } else if (dias < 14) {
        leitura =
            `VEREDICTO FRACO: ${dias.toFixed(1)} dias é janela curta demais para evento raro. ` +
            `Liquidação gorda acontece em dia de pânico; aumente LIQUIDACOES_BLOCOS antes de decidir.`;
    } else if (grandes === 0) {
        leitura = 'NENHUMA liquidação grande numa amostra limpa e longa. A ideia morre aqui, e custou zero.';
    } else if (r.liquidantesDistintos <= 5) {
        leitura = 'Existem liquidações grandes, mas pouquíssimos endereços pegam todas: lugar tomado.';
    } else {
        leitura = 'Existem liquidações grandes E muitos endereços diferentes capturam. Vale o próximo passo.';
    }

    // CORRIDA OU LEILÃO — a pergunta que decide se dá para competir.
    //
    // Cada vencedor pagou um preço por gás, e o bloco tinha uma taxa base
    // obrigatória. A razão entre os dois separa as duas formas de disputa, que
    // pedem estratégias opostas: em corrida quem chega primeiro leva e dar
    // lance não adianta; em leilão quem aceita lucro menor pode pagar mais e
    // ganhar. Ver `lerDisputaPorPiso` e `lerPosicao` em liquidacoes.ts.
    //
    // São ~2 chamadas por transação, num punhado de transações. Barato.
    const multiplos: Decimal[] = [];
    const posicoes: Decimal[] = [];
    const gorjetas: string[] = [];
    const ondeCairam: string[] = [];
    for (const m of r.maioresLiquidacoes.slice(0, 8)) {
        try {
            const rec = await chamar<{
                gasUsed: string;
                effectiveGasPrice: string;
                blockNumber: string;
                transactionIndex: string;
            }>('eth_getTransactionReceipt', [m.transacao]);
            const bloco = await chamar<{ baseFeePerGas?: string; transactions?: string[] }>(
                'eth_getBlockByNumber',
                [rec.blockNumber, false],
            );

            // A posição no bloco é medida ANTES do gás e independente dele: na
            // Base o preço do gás não compra prioridade, então ele pode ser
            // mudo por construção. A ordem de chegada não é.
            const totalNoBloco = bloco.transactions?.length ?? 0;
            if (totalNoBloco > 0 && rec.transactionIndex !== undefined) {
                const indice = Number.parseInt(rec.transactionIndex, 16);
                posicoes.push(new Decimal(indice).dividedBy(totalNoBloco));
                ondeCairam.push(`$${m.usd.toFixed(0)}: transação ${indice + 1} de ${totalNoBloco}`);
            }

            if (!bloco.baseFeePerGas) continue;
            const efetivoWei = new Decimal(Number.parseInt(rec.effectiveGasPrice, 16));
            const baseWei = new Decimal(Number.parseInt(bloco.baseFeePerGas, 16));
            const gasUsado = new Decimal(Number.parseInt(rec.gasUsed, 16));
            const mult = multiploDaBase({ efetivoWei, baseWei });
            if (mult === null) continue;
            multiplos.push(mult);
            gorjetas.push(
                `$${m.usd.toFixed(0)}: ${mult.toFixed(1)}x a base, gorjeta ${gorjetaWei({ efetivoWei, baseWei, gasUsado })
                    .dividedBy(1e18)
                    .toFixed(6)} ETH`,
            );
        } catch (err) {
            log.warn('Não deu para ler a taxa desta transação.', {
                transacao: m.transacao,
                erro: err instanceof Error ? err.message : String(err),
            });
        }
        await dormir(PAUSA_MS);
    }

    const ordenados = [...multiplos].sort((a, b) => a.comparedTo(b));
    const mediano = ordenados.length > 0 ? ordenados[Math.floor(ordenados.length / 2)] : null;
    log.info('CORRIDA OU LEILÃO — o que os vencedores pagaram.', {
        transacoesLidas: multiplos.length,
        // A mediana fica no relatório porque a primeira medição mostrou que ela
        // ENGANA, e apagá-la esconderia isso. A leitura vem de `lerDisputaPorPiso`.
        multiploMediano: mediano ? `${mediano.toFixed(1)}x a taxa base (a mediana engana — ver leitura)` : '—',
        leitura: lerDisputaPorPiso(multiplos),
        detalhe: gorjetas.join(' | '),
    });

    log.info('ONDE NO BLOCO — se dá para chegar lá.', {
        transacoesLidas: posicoes.length,
        leitura: lerPosicao(posicoes),
        detalhe: ondeCairam.join(' | '),
    });

    log.info('VEREDICTO PRELIMINAR.', {
        acimaDe50k: grandes,
        porDia: (grandes / Math.max(dias, 1)).toFixed(2),
        pedacosQueFalharam: `${pedacosComErro} de ${tentados}`,
        semCotacao: PRECO_ETH
            ? `${r.semCotacao} de ${r.total} (WETH/cbETH convertidos por APROXIMAÇÃO, a US$${PRECO_ETH.toFixed(0)}/ETH que você informou)`
            : `${r.semCotacao} de ${r.total}`,
        leitura,
        proximoPasso:
            'medir quantos BLOCOS cada posição ficou liquidável antes de alguém pegar — é isso que diz se dá tempo de chegar.',
    });
}

// Ponto de entrada: fica desligado até ATIVAR_LIQUIDACOESHISTORICO=1.
if (require.main === module && exigirAtivacao('liquidacoesHistorico')) {
    /**
     * Fica vivo e ocioso ao terminar — com sucesso OU com erro.
     *
     * Este programa roda uma vez e acaba, e sair tem dois efeitos ruins no
     * Railway, os dois vistos hoje:
     *
     *   1. Sair com erro vira LAÇO. Quando o RPC devolveu 525, o processo saiu,
     *      o Railway religou, falhou de novo — várias vezes por segundo,
     *      queimando recurso e enterrando a mensagem útil no meio do ruído.
     *   2. Sair com SUCESSO pinta o serviço de "CRASHED" na interface, porque
     *      o Railway espera que serviço fique de pé. Um relatório que deu certo
     *      parecia falha.
     *
     * O `ativacao.ts` já dizia isto num comentário escrito dias antes, e este
     * arquivo não seguiu. Manter vivo custa o contêiner que o Railway cobraria
     * de qualquer jeito, e o relatório continua legível no log.
     */
    const ficarQuieto = () => {
        log.info('Terminado. O processo fica ocioso para não reiniciar em laço.', {
            paraRodarDeNovo: 'reimplante o serviço, ou mude uma variável',
            paraDesligar: 'apague ATIVAR_LIQUIDACOESHISTORICO',
        });
        setInterval(() => {}, 1 << 30);
    };
    principal()
        .catch((err) => {
            log.error('Varredura falhou.', { erro: err instanceof Error ? err.message : String(err) });
        })
        .finally(ficarQuieto);
}
