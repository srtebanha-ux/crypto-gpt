// Arquivo: src/vigiaDePosicoes.ts
//
// A ambulância estacionada na esquina.
//
// A medição de 18/09 na Base decidiu o desenho deste arquivo, e vale registrar
// porque sem ela eu teria construído a coisa errada:
//
//     A JANELA — típica de 541 blocos (~1082s), e ZERO pares entre 1 e 30
//     blocos. Catorze de quinze levaram mais de 31 blocos.
//
// Dezoito minutos. Se a porta fechasse em dois segundos, este programa teria
// de ser um foguete: conexão privilegiada, transação pré-assinada, disputa de
// milissegundos — coisa que não se faz do Brasil com US$45. Como ela fica
// aberta minutos, o que ganha não é reflexo, é NÃO TER DEIXADO PASSAR.
//
// Daí o formato de duas velocidades:
//
//   RONDA  — varre todos os devedores, devagar, e descobre quem está perto.
//   VIGIA  — fica em cima só dos que estão perto, rápido.
//
// Varrer milhares de endereços leva minutos, e isso seria fatal numa corrida.
// Aqui não é: a ronda demora menos que a janela que ela precisa cobrir. É a
// única razão pela qual este plano funciona, e se a janela medir diferente em
// outra rede, este desenho precisa ser refeito para ela.
//
// ESSA AFIRMAÇÃO JÁ FOI FALSA UMA VEZ, e vale deixar registrado. Eu a escrevi
// antes de saber quantos devedores existiam. A primeira lista real trouxe
// 8.244, o que dava 62 minutos de ronda contra 18 de janela — o vigia passaria
// três janelas inteiras varrendo e veria cada liquidação como fato consumado.
// O conserto foi pedir em lote (`chamarLote`), que derruba a ronda para uns 90
// segundos. A frase só voltou a ser verdade depois disso.
//
// Fica a lição para a próxima rede: medir a janela NÃO basta. Tem de medir
// também quanto tempo a ronda leva naquela rede, e comparar as duas.
//
// *** NÃO ENVIA TRANSAÇÃO NENHUMA. *** Este processo só lê e mede. Ele existe
// para responder, sem arriscar um centavo: o vigia vê a liquidação chegando
// antes de ela acontecer? E com quanta antecedência?
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import {
    REDES,
    RPCS_PARA_TENTAR,
    TAMANHOS_PARA_SONDAR,
    escolherMelhorRpc,
    faixasDeBlocos,
    type Sonda,
} from './liquidacoes';
import {
    FAIXAS_DE_RISCO,
    SELETOR_CONTA_DO_USUARIO,
    TOPIC_BORROW,
    decodificarContaDoUsuario,
    devedoresDosEventos,
    quedaAteLiquidar,
    resumirPosicoes,
    type Posicao,
} from './posicoes';

const log = createLogger('vigia');

const REDE_ESCOLHIDA = (process.env.VIGIA_REDE ?? 'base').toLowerCase();
const REDE = REDES[REDE_ESCOLHIDA] ?? REDES.base;
const POOL = (process.env.VIGIA_POOL ?? REDE.pool).toLowerCase();

/**
 * Quanto passado varrer para montar a lista de devedores.
 *
 * Não são os 180 dias da medição histórica. Quem pegou empréstimo há seis
 * meses e já pagou não interessa; quem pegou nos últimos trinta dias é a lista
 * viva. Mais curto também significa arrancar em minutos em vez de meia hora,
 * e o vigia só começa a servir depois que a lista existe.
 */
const BLOCOS_DEVEDORES = Number(process.env.VIGIA_BLOCOS_DEVEDORES ?? '1296000');
const PEDACO = Number(process.env.VIGIA_PEDACO ?? '2000');
const PAUSA_MS = Number(process.env.VIGIA_PAUSA_MS ?? '150');
const TIMEOUT_MS = Number(process.env.VIGIA_TIMEOUT_MS ?? '20000');

/** Abaixo desta queda-para-liquidar, o devedor entra na lista de vigia rápida. */
const LIMIAR_VIGIA = Number(process.env.VIGIA_LIMIAR ?? '10');
/** Segundos entre duas passadas na lista curta. */
const SEG_VIGIA = Number(process.env.VIGIA_SEG ?? '20');
/** Minutos entre duas rondas completas. */
const MIN_RONDA = Number(process.env.VIGIA_MIN_RONDA ?? '30');

let rpcEmUso = process.env.VIGIA_RPC_URL ?? REDE.rpc;
let rpcId = 0;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chamarEm<T>(rpc: string, metodo: string, params: unknown[]): Promise<T> {
    const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: metodo, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`RPC: ${body.error.message}`);
    if (body.result === undefined) throw new Error('RPC devolveu resposta sem resultado');
    return body.result;
}

const chamar = <T>(metodo: string, params: unknown[]): Promise<T> =>
    chamarEm<T>(rpcEmUso, metodo, params);

/** Quantas chamadas cabem num pedido só. 0 desliga o lote. */
let TAMANHO_DO_LOTE = Number(process.env.VIGIA_LOTE ?? '50');

/**
 * Muitas chamadas num pedido HTTP só — e por que isso não é otimização.
 *
 * A primeira lista real trouxe 8.244 devedores. Uma chamada por endereço, com
 * a pausa que o provedor exige, dá 62 MINUTOS por ronda. A janela medida na
 * Base é de 18. Ou seja: o vigia passaria três janelas inteiras varrendo, e
 * qualquer posição que abrisse e fosse levada durante a varredura ele veria
 * só depois, como fato consumado.
 *
 * O comentário no alto deste arquivo afirma que a ronda cabe dentro da janela.
 * Eu escrevi isso antes de saber quantos devedores existiam, e a primeira
 * medição desmentiu. Em lote de 50 a ronda cai para uns 90 segundos, e aí a
 * afirmação passa a ser verdade — com doze vezes de folga em vez de nenhuma.
 *
 * Nem todo provedor aceita lote. Quando este recusar, o código volta para uma
 * por vez e AVISA, em vez de devolver lista vazia — porque lista vazia aqui se
 * lê como "ninguém está perto de liquidar", que é o oposto do que aconteceu.
 */
async function chamarLote<T>(
    pedidos: Array<{ metodo: string; params: unknown[] }>,
): Promise<Array<T | null>> {
    if (pedidos.length === 0) return [];
    const base = rpcId;
    const corpo = pedidos.map((p, i) => ({
        jsonrpc: '2.0',
        id: base + i + 1,
        method: p.metodo,
        params: p.params,
    }));
    rpcId += pedidos.length;

    const res = await fetch(rpcEmUso, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const body = (await res.json()) as unknown;
    // Provedor que não faz lote devolve um objeto de erro no lugar do array.
    if (!Array.isArray(body)) throw new Error('provedor não aceitou lote');

    const porId = new Map<number, { result?: T; error?: { message: string } }>();
    for (const r of body as Array<{ id: number; result?: T; error?: { message: string } }>) {
        porId.set(r.id, r);
    }
    return corpo.map((c) => {
        const r = porId.get(c.id);
        if (!r || r.error || r.result === undefined) return null;
        return r.result;
    });
}

/**
 * Como a varredura histórica: 429 quer dizer "devagar", não "não dá".
 *
 * Aqui importa mais que lá. A ronda faz uma chamada por devedor, milhares
 * delas, e desistir no primeiro 429 deixaria buracos na lista — buracos que
 * são exatamente do tipo que não aparece como erro, só como ausência.
 */
async function comPaciencia<T>(metodo: string, params: unknown[]): Promise<T> {
    let espera = 400;
    for (let tentativa = 0; ; tentativa += 1) {
        try {
            return await chamar<T>(metodo, params);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (tentativa >= 3 || !msg.includes('429')) throw err;
            await dormir(espera);
            espera *= 3;
        }
    }
}

async function sondar(): Promise<boolean> {
    const candidatos = [rpcEmUso, ...(RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [])].filter(
        (v, i, a) => a.indexOf(v) === i,
    );
    const topo = Number.parseInt(await chamarEm<string>(candidatos[0], 'eth_blockNumber', []), 16);
    const fundo = Math.max(1, topo - BLOCOS_DEVEDORES + 1000);
    const sondas: Sonda[] = [];

    for (const rpc of candidatos) {
        let maior = 0;
        let erro: string | undefined;
        for (const tam of TAMANHOS_PARA_SONDAR) {
            try {
                await chamarEm<unknown[]>(rpc, 'eth_getLogs', [
                    {
                        address: POOL,
                        fromBlock: `0x${fundo.toString(16)}`,
                        toBlock: `0x${(fundo + tam - 1).toString(16)}`,
                        topics: [TOPIC_BORROW],
                    },
                ]);
                maior = tam;
            } catch (err) {
                erro = err instanceof Error ? err.message : String(err);
                break;
            }
            await dormir(PAUSA_MS);
        }
        sondas.push({ rpc, maiorFaixa: maior, erro });
    }

    log.info('SONDAGEM DE RPC.', {
        resultado: sondas
            .map((s) => `${s.rpc}: ${s.maiorFaixa > 0 ? `até ${s.maiorFaixa}` : 'NÃO SERVE'}`)
            .join(' | '),
    });
    const melhor = escolherMelhorRpc(sondas);
    if (melhor === null) {
        log.error('Nenhum RPC serve. O vigia não vai medir nada; não vou fingir que sim.', {
            rede: REDE.nome,
            oQueFazer: 'defina VIGIA_RPC_URL com um provedor que sirva esta rede',
        });
        return false;
    }
    rpcEmUso = melhor.rpc;
    return true;
}

/** A lista de quem pegou emprestado na janela — a matéria-prima do vigia. */
async function juntarDevedores(): Promise<string[]> {
    const topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
    const inicio = Math.max(0, topo - BLOCOS_DEVEDORES);
    const faixas = faixasDeBlocos(inicio, topo, PEDACO);
    log.info('Juntando devedores.', {
        rede: REDE.nome,
        blocos: `${inicio} → ${topo}`,
        pedacos: faixas.length,
        estimativa: `~${((faixas.length * (PAUSA_MS / 1000 + 0.3)) / 60).toFixed(0)} minutos`,
    });

    const vistos = new Set<string>();
    let falhas = 0;
    let lidos = 0;
    for (const [de, ate] of faixas) {
        try {
            const logs = await comPaciencia<Array<{ topics: string[] }>>('eth_getLogs', [
                {
                    address: POOL,
                    fromBlock: `0x${de.toString(16)}`,
                    toBlock: `0x${ate.toString(16)}`,
                    topics: [TOPIC_BORROW],
                },
            ]);
            for (const d of devedoresDosEventos(logs)) vistos.add(d);
        } catch {
            falhas += 1;
        }
        lidos += 1;
        if (lidos % 200 === 0) {
            log.info('Progresso.', { lidos, de: faixas.length, devedores: vistos.size, falhas });
        }
        await dormir(PAUSA_MS);
    }

    // Buraco grande na coleta não é detalhe: são devedores que o vigia nunca
    // vai olhar, e a ausência deles não aparece em lugar nenhum depois.
    const furo = falhas / Math.max(faixas.length, 1);
    log.info('Lista de devedores pronta.', {
        devedores: vistos.size,
        pedacosComErro: `${falhas} de ${faixas.length}`,
        confianca:
            furo > 0.05
                ? `BAIXA: ${(furo * 100).toFixed(0)}% dos pedaços falharam, a lista está incompleta`
                : 'boa',
    });
    return [...vistos];
}

/** Uma passada por uma lista de endereços, perguntando a saúde de cada um. */
async function olhar(devedores: string[]): Promise<Posicao[]> {
    const fora: Posicao[] = [];
    const dados = (d: string) =>
        SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0');

    for (let i = 0; i < devedores.length; i += Math.max(TAMANHO_DO_LOTE, 1)) {
        const pedaco = devedores.slice(i, i + Math.max(TAMANHO_DO_LOTE, 1));
        let respostas: Array<string | null>;

        if (TAMANHO_DO_LOTE > 0) {
            try {
                respostas = await chamarLote<string>(
                    pedaco.map((d) => ({ metodo: 'eth_call', params: [{ to: POOL, data: dados(d) }, 'latest'] })),
                );
            } catch (err) {
                // Desligar o lote é decisão de uma vez só, não por pedaço: sem
                // isto o vigia tentaria e falharia em cada volta, e a ronda
                // ficaria mais lenta do que se nunca tivesse tentado.
                TAMANHO_DO_LOTE = 0;
                log.warn('Este provedor não faz lote; voltando para uma por vez.', {
                    erro: err instanceof Error ? err.message : String(err),
                    consequencia: `a ronda passa a levar uns ${((devedores.length * 0.45) / 60).toFixed(0)} minutos`,
                });
                respostas = [];
                for (const d of pedaco) {
                    try {
                        respostas.push(await comPaciencia<string>('eth_call', [{ to: POOL, data: dados(d) }, 'latest']));
                    } catch {
                        respostas.push(null);
                    }
                    await dormir(PAUSA_MS);
                }
            }
        } else {
            respostas = [];
            for (const d of pedaco) {
                try {
                    respostas.push(await comPaciencia<string>('eth_call', [{ to: POOL, data: dados(d) }, 'latest']));
                } catch {
                    respostas.push(null);
                }
                await dormir(PAUSA_MS);
            }
        }

        for (let j = 0; j < pedaco.length; j += 1) {
            const bruto = respostas[j];
            // Endereço que não respondeu some da conta — e por isso `vigiados`
            // no resumo é sempre quem REALMENTE foi olhado, nunca o tamanho da
            // lista. Sumir sem aparecer é a falha que este projeto já pegou
            // seis vezes.
            if (bruto === null) continue;
            try {
                const conta = decodificarContaDoUsuario(bruto);
                fora.push({ devedor: pedaco[j], conta, quedaPct: quedaAteLiquidar(conta.saude) });
            } catch {
                // resposta ilegível: mesmo tratamento.
            }
        }
        await dormir(PAUSA_MS);
    }

    const perdidos = devedores.length - fora.length;
    if (perdidos > devedores.length * 0.1) {
        log.warn('Muitos endereços sem resposta nesta passada.', {
            semResposta: `${perdidos} de ${devedores.length}`,
            consequencia: 'esses não foram olhados; a lista da borda pode estar incompleta',
        });
    }
    return fora;
}

/** Quem já estava na mira e virou liquidável — a previsão se confirmando. */
const primeiraVezVisto = new Map<string, number>();

function anunciarQuedas(posicoes: Posicao[]): void {
    for (const p of posicoes) {
        if (p.quedaPct === null) continue;
        const chave = p.devedor;
        if (p.quedaPct.greaterThan(0)) {
            if (!primeiraVezVisto.has(chave)) primeiraVezVisto.set(chave, Date.now());
            continue;
        }
        // Virou liquidável agora.
        const desde = primeiraVezVisto.get(chave);
        primeiraVezVisto.delete(chave);
        log.info('*** LIQUIDÁVEL AGORA ***', {
            devedor: chave,
            dividaUsd: `$${p.conta.dividaBase.dividedBy(1e8).toFixed(0)}`,
            avisoPrevio:
                desde === undefined
                    ? 'NENHUM — apareceu já liquidável, o vigia não viu chegando'
                    : `${((Date.now() - desde) / 60000).toFixed(1)} minutos de antecedência`,
            observacao: 'MODO LEITURA: nada foi enviado. Isto é a medição da previsão, não uma operação.',
        });
    }
}

function relatar(titulo: string, posicoes: Posicao[]): Posicao[] {
    const r = resumirPosicoes(posicoes, LIMIAR_VIGIA);
    log.info(titulo, {
        olhados: posicoes.length,
        comDivida: r.vigiados,
        semDivida: r.semDivida,
        porFaixa: FAIXAS_DE_RISCO.map((f) => `${f.nome}: ${r.porFaixa[f.nome]}`).join(' | '),
        dividaSobAmeaca: `$${r.dividaSobAmeaca.toFixed(0)}`,
        naBorda: r.naBorda
            .slice(0, 8)
            .map((x) => `${x.devedor.slice(0, 10)} a ${x.quedaPct.toFixed(2)}% ($${x.dividaUsd.toFixed(0)})`)
            .join(' | '),
        leitura: r.leitura,
    });
    anunciarQuedas(posicoes);
    return posicoes.filter((p) => p.quedaPct !== null && p.quedaPct.lessThanOrEqualTo(LIMIAR_VIGIA));
}

async function principal(): Promise<void> {
    log.info('*** MODO LEITURA — nenhuma transação é enviada por este processo. ***');
    log.info('Vigia de posições.', {
        rede: REDE.nome,
        pool: POOL,
        limiarDeVigia: `${LIMIAR_VIGIA}% de queda`,
        rondaCompleta: `a cada ${MIN_RONDA} min`,
        passadaRapida: `a cada ${SEG_VIGIA}s`,
        porQueDuasVelocidades:
            'a janela medida na Base foi de ~18 minutos; a ronda cabe dentro dela, então completo vence rápido',
    });

    if (!(await sondar())) return;

    let devedores = await juntarDevedores();
    if (devedores.length === 0) {
        log.error('Nenhum devedor encontrado. Sem lista não há vigia.', { pool: POOL });
        return;
    }

    let naMira = relatar('RONDA COMPLETA.', await olhar(devedores));
    let ultimaRonda = Date.now();

    for (;;) {
        if (Date.now() - ultimaRonda > MIN_RONDA * 60_000) {
            devedores = await juntarDevedores();
            naMira = relatar('RONDA COMPLETA.', await olhar(devedores));
            ultimaRonda = Date.now();
            continue;
        }
        if (naMira.length === 0) {
            log.info('Ninguém na mira. De plantão.', { proximaRonda: `${MIN_RONDA} min` });
            await dormir(SEG_VIGIA * 1000);
            continue;
        }
        const atual = await olhar(naMira.map((p) => p.devedor));
        naMira = relatar('VIGIA — só quem está perto da borda.', atual);
        await dormir(SEG_VIGIA * 1000);
    }
}

if (require.main === module && exigirAtivacao('vigiaDePosicoes')) {
    principal().catch((err) => {
        log.error('Vigia parou.', { erro: err instanceof Error ? err.message : String(err) });
        // Fica ocioso em vez de sair: processo que sai é reiniciado em laço
        // pelo Railway, e o laço enche o log justamente na hora de lê-lo.
        setInterval(() => {}, 1 << 30);
    });
}
