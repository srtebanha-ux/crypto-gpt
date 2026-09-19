// Arquivo: src/cacarAoVivo.ts
//
// O executor: acha quem caiu, monta a caçada, e — só se mandarem — envia.
//
// *** POR PADRÃO NÃO ENVIA NADA. Só com CACA_ENVIAR=1. ***
//
// Dois modos, e o padrão é o que ensina.
//
// MEDIR (padrão): manda a caçada por `eth_call` com um piso impossível. O
// contrato executa tudo contra a Aave de verdade e o pool de verdade, e
// reverte no piso devolvendo, dentro do erro, QUANTO teria rendido. Nenhum gás,
// nenhuma transação, e um número que vem da rede em vez de suposição.
//
// ENVIAR: o mesmo, de verdade, com o piso calculado a partir do que a medição
// acabou de ver.
//
// A ordem não é cautela, é diagnóstico. Ao vivo, uma tentativa perdida reverte
// — e reverte igual se foi concorrente mais rápido, preço que mexeu, ou código
// errado. Consertar olhando um log desses é adivinhar. Pelo `eth_call` a
// resposta vem com nome, e aí "ir arrumando enquanto roda" funciona de fato.
//
// Vale hoje mesmo com ninguém liquidável: contra posição saudável a Aave
// recusa com código dela, e recusar com código prova que ela LEU o pedido.
// Isso valida o caminho inteiro — flash loan, guardas do contrato, formato da
// liquidação — antes de existir dinheiro na jogada.
import { Decimal } from 'decimal.js';
import { Wallet, JsonRpcProvider, id } from 'ethers';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import { REDES, RPCS_PARA_TENTAR, faixasDeBlocos, SELETOR_GET_RESERVES_LIST, decodificarListaDeEnderecos } from './liquidacoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from './posicoes';
import { CHAMADAS_POR_MULTICALL, MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { codificarUserReserveData, decodificarUserReserveData, escolherPar, COBRIR_O_MAXIMO } from './liquidar';
import { codificarCaca, lerRespostaDaCaca, PISO_IMPOSSIVEL, lucroEmDolar } from './caca';
import { cacadorDaRede, POOLS } from './contratos';

const log = createLogger('caca');

const SELETOR_DECIMALS = '0x313ce567';
const SELETOR_SYMBOL = id('symbol()').slice(0, 10);

/** O símbolo da moeda, quando dá para ler. Nunca inventado. */
function simboloDe(hex: string | null): string {
    if (!hex || hex === '0x') return 'unidades';
    try {
        const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
        const t = (b.length > 64 ? b.subarray(64) : b).toString('utf8').replace(/\0/g, '').trim();
        return t.length > 0 && t.length < 32 ? t : 'unidades';
    } catch {
        return 'unidades';
    }
}

const REDE_ESCOLHIDA = (process.env.CACA_REDE ?? 'base').toLowerCase();
const REDE = REDES[REDE_ESCOLHIDA] ?? REDES.base;
const ENVIAR = process.env.CACA_ENVIAR === '1';
const BLOCOS = Number(process.env.CACA_BLOCOS ?? '200000');
const PEDACO = Number(process.env.CACA_PEDACO ?? '2000');
const SEG = Number(process.env.CACA_SEG ?? '20');
const MIN_COLETA = Number(process.env.CACA_MIN_COLETA ?? '30');
const TIMEOUT_MS = Number(process.env.CACA_TIMEOUT_MS ?? '20000');
const PAUSA_MS = Number(process.env.CACA_PAUSA_MS ?? '600');
/** Quantos saudáveis ensaiar por rodada, para provar o formato sem alvo real. */
const ENSAIAR = Number(process.env.CACA_ENSAIAR ?? '3');

let rpc = process.env.CACA_RPC_URL ?? REDE.rpc;
let rpcId = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chamar<T>(metodo: string, params: unknown[]): Promise<T> {
    const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: metodo, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = (await res.json()) as { result?: T; error?: { message?: string } };
    if (corpo.error) throw new Error(corpo.error.message ?? 'erro sem mensagem');
    return corpo.result as T;
}

/** Como `chamar`, mas a reversão é o resultado desejado e não pode ser engolida. */
async function chamarCru(
    params: unknown[],
): Promise<{ ok: true; dados: string } | { ok: false; mensagem: string; dados?: string }> {
    const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = (await res.json()) as { result?: string; error?: { message?: string; data?: string } };
    if (corpo.error) {
        return { ok: false, mensagem: corpo.error.message ?? 'erro sem mensagem', dados: corpo.error.data };
    }
    return { ok: true, dados: corpo.result ?? '0x' };
}

async function lerEmLote(chamadas: Array<{ alvo: string; dados: string }>): Promise<Array<string | null>> {
    const fora: Array<string | null> = [];
    for (const pedaco of partirEmPedacos(chamadas, CHAMADAS_POR_MULTICALL)) {
        try {
            const bruto = await chamar<string>('eth_call', [
                { to: MULTICALL3, data: codificarAggregate3(pedaco) },
                'latest',
            ]);
            const rs = decodificarAggregate3(bruto);
            for (let i = 0; i < pedaco.length; i += 1) fora.push(rs[i]?.ok ? rs[i].dados : null);
        } catch {
            for (let i = 0; i < pedaco.length; i += 1) fora.push(null);
        }
        await dormir(PAUSA_MS);
    }
    return fora;
}

async function juntarDevedores(topo: number): Promise<string[]> {
    const vistos = new Set<string>();
    const faixas = faixasDeBlocos(topo - BLOCOS + 1, topo, PEDACO);
    let falhas = 0;
    for (const [a, b] of faixas) {
        try {
            const logs = await chamar<Array<{ topics: string[] }>>('eth_getLogs', [
                {
                    address: REDE.pool,
                    fromBlock: `0x${a.toString(16)}`,
                    toBlock: `0x${b.toString(16)}`,
                    topics: [TOPIC_BORROW],
                },
            ]);
            for (const d of devedoresDosEventos(logs)) vistos.add(d);
        } catch {
            falhas += 1;
        }
        await dormir(PAUSA_MS);
    }
    if (falhas > 0) {
        log.warn('Faixas não lidas — a lista está por baixo.', {
            falharam: `${falhas} de ${faixas.length}`,
            consequencia: 'devedores que só apareceram nessas faixas ficam de fora desta rodada',
        });
    }
    return [...vistos];
}

interface Alvo {
    devedor: string;
    quedaPct: Decimal | null;
    garantia: string;
    divida: string;
}

/** Descobre, para cada devedor, qual par de moedas usar. */
async function montarAlvos(devedores: string[], moedas: string[]): Promise<Alvo[]> {
    const chamadas = devedores.flatMap((d) =>
        moedas.map((m) => ({ alvo: REDE.pool, dados: codificarUserReserveData(m, d) })),
    );
    const rs = await lerEmLote(chamadas);
    const fora: Alvo[] = [];
    for (let i = 0; i < devedores.length; i += 1) {
        const reservas: Array<{ ativo: string; dados: ReturnType<typeof decodificarUserReserveData> }> = [];
        for (let j = 0; j < moedas.length; j += 1) {
            const bruto = rs[i * moedas.length + j];
            if (!bruto) continue;
            try {
                reservas.push({ ativo: moedas[j], dados: decodificarUserReserveData(bruto) });
            } catch {
                /* resposta ilegível: some da conta */
            }
        }
        const par = escolherPar(reservas);
        if (par) fora.push({ devedor: devedores[i], quedaPct: null, garantia: par.garantia, divida: par.divida });
    }
    return fora;
}

async function principal(): Promise<void> {
    const cacador = cacadorDaRede(REDE_ESCOLHIDA);
    if (!cacador) {
        log.error('Nenhum caçador publicado nesta rede.', { rede: REDE_ESCOLHIDA });
        return;
    }
    const poolDeVenda = (process.env.CACA_POOL ?? POOLS.aerodrome.endereco).toLowerCase();

    log.info(ENVIAR ? '*** MODO ENVIO — ESTE PROCESSO GASTA GÁS DE VERDADE. ***' : '*** MODO MEDIÇÃO — nada é enviado, nenhum gás é gasto. ***');
    log.info('Caçador ao vivo.', {
        rede: REDE.nome,
        contrato: cacador.endereco,
        cofre: cacador.cofre,
        poolDeVenda,
        vendeEm: cacador.vendeEm,
        modo: ENVIAR ? 'ENVIAR' : 'MEDIR',
        comoMede: 'piso impossível por eth_call: o contrato executa tudo e devolve o lucro dentro do erro',
    });

    let carteira: Wallet | null = null;
    if (ENVIAR) {
        const chave = process.env.CACA_CHAVE_PRIVADA;
        if (!chave) {
            log.error('CACA_ENVIAR=1 mas falta CACA_CHAVE_PRIVADA. Não envio nada sem ela.', {
                comoResolver: 'defina a chave da conta dona do contrato nas variáveis do Railway, nunca no código',
            });
            return;
        }
        carteira = new Wallet(chave, new JsonRpcProvider(rpc));
        if (carteira.address.toLowerCase() !== cacador.dono.toLowerCase()) {
            // O contrato tem `apenasDono`. Uma chave que não é a do dono só
            // produziria reversão — e reversão paga gás.
            log.error('A chave fornecida NÃO é a do dono do contrato. Nada seria aceito.', {
                chaveCorrespondeA: carteira.address,
                donoDoContrato: cacador.dono,
            });
            return;
        }
        log.info('Carteira carregada.', { endereco: carteira.address });
    }

    const rpcs = process.env.CACA_RPC_URL ? [process.env.CACA_RPC_URL] : (RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [REDE.rpc]);
    let topo = 0;
    for (const c of rpcs) {
        try {
            rpc = c;
            topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
            break;
        } catch { /* próximo */ }
    }
    if (!topo) {
        log.error('Nenhum RPC respondeu.', { tentados: rpcs });
        return;
    }

    const moedas = decodificarListaDeEnderecos(
        await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_GET_RESERVES_LIST }, 'latest']),
    );
    log.info('Moedas que a Aave aceita nesta rede.', { quantas: moedas.length });

    let devedores = await juntarDevedores(topo);
    let ultimaColeta = Date.now();
    log.info('Lista de devedores pronta.', { devedores: devedores.length });

    for (;;) {
        try {
            if (Date.now() - ultimaColeta > MIN_COLETA * 60_000) {
                topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
                devedores = await juntarDevedores(topo);
                ultimaColeta = Date.now();
            }

            // Quem está liquidável AGORA.
            const contas = await lerEmLote(
                devedores.map((d) => ({
                    alvo: REDE.pool,
                    dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
                })),
            );
            const caidos: string[] = [];
            const saudaveis: string[] = [];
            for (let i = 0; i < devedores.length; i += 1) {
                if (!contas[i]) continue;
                try {
                    const queda = quedaAteLiquidar(decodificarContaDoUsuario(contas[i]!).saude);
                    if (queda === null) continue;
                    if (queda.isZero()) caidos.push(devedores[i]);
                    else if (saudaveis.length < ENSAIAR) saudaveis.push(devedores[i]);
                } catch {
                    /* ilegível */
                }
            }

            // Os saudáveis viram ensaio: provam o formato sem existir alvo.
            const paraOlhar = caidos.length > 0 ? caidos : saudaveis;
            const ehEnsaio = caidos.length === 0;
            if (paraOlhar.length === 0) {
                await dormir(SEG * 1000);
                continue;
            }

            const alvos = await montarAlvos(paraOlhar, moedas);
            for (const alvo of alvos) {
                const dados = codificarCaca({
                    garantia: alvo.garantia,
                    divida: alvo.divida,
                    devedor: alvo.devedor,
                    quantoCobrir: COBRIR_O_MAXIMO,
                    poolDeVenda,
                    lucroMinimo: PISO_IMPOSSIVEL,
                });
                const r = await chamarCru([{ from: cacador.dono, to: cacador.endereco, data: dados }, 'latest']);
                const leitura = lerRespostaDaCaca(r);

                // O lucro vem em unidades cruas, e cru é ilegível: 1044000000
                // não diz nada, 1044 USDC diz tudo. As casas vêm da moeda, não
                // de supor 18 — supor erraria por um fator de um trilhão numa
                // dívida em USDC, que é a maioria delas.
                let emMoeda = '-';
                if (leitura.lucroCru !== null) {
                    const [dec, sim] = await Promise.all([
                        chamar<string>('eth_call', [{ to: alvo.divida, data: SELETOR_DECIMALS }, 'latest']).catch(() => null),
                        chamar<string>('eth_call', [{ to: alvo.divida, data: SELETOR_SYMBOL }, 'latest']).catch(() => null),
                    ]);
                    emMoeda =
                        dec === null
                            ? `${leitura.lucroCru} em unidades cruas (casas da moeda ilegíveis)`
                            : `${lucroEmDolar(leitura.lucroCru, Number(BigInt(dec)), new Decimal(1)).toFixed(2)} ${simboloDe(sim)}`;
                }

                log.info(ehEnsaio ? 'ENSAIO contra posição saudável.' : 'ALVO CAÍDO — medição da caçada.', {
                    devedor: alvo.devedor,
                    garantia: alvo.garantia,
                    divida: alvo.divida,
                    desfecho: leitura.desfecho,
                    lucro: emMoeda,
                    lucroCru: leitura.lucroCru?.toString() ?? '-',
                    erro: leitura.erro ?? '-',
                    leitura: leitura.leitura,
                    observacao: ENVIAR ? 'envio decidido a seguir' : 'MODO MEDIÇÃO: nada foi enviado',
                });

                if (!ENVIAR || !carteira || ehEnsaio) continue;
                if (leitura.desfecho !== 'mediu' || leitura.lucroCru === null || leitura.lucroCru === 0n) continue;

                // O piso real: 80% do que a medição acabou de ver. A folga
                // existe porque entre medir e executar o pool se move, e
                // exigir o exato faria reverter por centavos.
                const piso = (leitura.lucroCru * 80n) / 100n;
                const envio = codificarCaca({
                    garantia: alvo.garantia,
                    divida: alvo.divida,
                    devedor: alvo.devedor,
                    quantoCobrir: COBRIR_O_MAXIMO,
                    poolDeVenda,
                    lucroMinimo: piso,
                });
                const tx = await carteira.sendTransaction({ to: cacador.endereco, data: envio });
                log.info('CAÇADA ENVIADA.', { devedor: alvo.devedor, hash: tx.hash, piso: piso.toString() });
                const recibo = await tx.wait();
                log.info('CAÇADA CONCLUÍDA.', {
                    devedor: alvo.devedor,
                    hash: tx.hash,
                    status: recibo?.status === 1 ? 'SUCESSO' : 'REVERTIDA',
                    gasUsado: recibo?.gasUsed?.toString() ?? '-',
                    ondeVerLucro: cacador.cofre,
                });
            }
        } catch (err) {
            log.warn('A rodada tropeçou; sigo na próxima.', { erro: err instanceof Error ? err.message : String(err) });
        }
        await dormir(SEG * 1000);
    }
}

if (require.main === module && exigirAtivacao('cacarAoVivo')) {
    principal().catch((e) => log.error('O caçador parou.', { erro: (e as Error).message }));
}
