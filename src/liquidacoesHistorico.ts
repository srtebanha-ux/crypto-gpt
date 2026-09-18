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
    decodificarLiquidacao,
    faixasDeBlocos,
    resumirHistorico,
    type Liquidacao,
    type LogCru,
} from './liquidacoes';

const log = createLogger('liquidacoes');

const RPC = process.env.LIQUIDACOES_RPC_URL ?? 'https://mainnet.base.org';
/** Aave V3 Pool na Base. Variável porque eu não pude conferir o endereço. */
const POOL = (process.env.LIQUIDACOES_POOL ?? '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5').toLowerCase();
/** Vazio = modo descoberta. Ver o comentário no topo. */
const TOPIC0 = process.env.LIQUIDACOES_TOPIC0 ?? '';
const BLOCOS = Number(process.env.LIQUIDACOES_BLOCOS ?? '200000');
const PEDACO = Number(process.env.LIQUIDACOES_PEDACO ?? '2000');
const PAUSA_MS = Number(process.env.LIQUIDACOES_PAUSA_MS ?? '120');
const TIMEOUT_MS = Number(process.env.LIQUIDACOES_TIMEOUT_MS ?? '20000');

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

    const r = resumirHistorico(liquidacoes);
    const dias = (BLOCOS * 2) / 86400; // Base fecha bloco a cada ~2s.

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

    const grandes = r.porFaixa[50_000] ?? 0;
    log.info('VEREDICTO PRELIMINAR.', {
        acimaDe50k: grandes,
        porDia: (grandes / Math.max(dias, 1)).toFixed(2),
        leitura:
            grandes === 0
                ? 'NENHUMA liquidação grande no período. A ideia morre aqui, e custou zero.'
                : r.liquidantesDistintos <= 5
                  ? 'Existem liquidações grandes, mas pouquíssimos endereços pegam todas: lugar tomado.'
                  : 'Existem liquidações grandes E muitos endereços diferentes capturam. Vale investigar o próximo passo.',
        proximoPasso:
            'medir quantos BLOCOS cada posição ficou liquidável antes de alguém pegar — é isso que diz se dá tempo de chegar.',
    });
}

// Ponto de entrada: fica desligado até ATIVAR_LIQUIDACOESHISTORICO=1.
if (require.main === module && exigirAtivacao('liquidacoesHistorico')) {
    principal().catch((err) => {
        log.error('Varredura falhou.', { erro: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
