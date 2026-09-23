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
import { codificarUserReserveData, decodificarUserReserveData, COBRIR_O_MAXIMO, ehLimiteDoProvedor } from './liquidar';
import { enderecoDaResposta, escolherParPorValor, type SaldoNaMoeda } from './reservas';
import { codificarCaca, lerRespostaDaCaca, PISO_IMPOSSIVEL, lucroEmDolar } from './caca';
import { cacadorDaRede } from './contratos';

const log = createLogger('caca');

const SELETOR_DECIMALS = '0x313ce567';
const SELETOR_SYMBOL = id('symbol()').slice(0, 10);

// `getUserReserveData` NAO mora no Pool — mora no Protocol Data Provider, que
// e outro contrato. O codigo perguntava ao Pool, toda chamada falhava, o
// multicall devolvia nulo, `escolherPar` devolvia null, a lista de alvos
// ficava vazia e o laço nao tinha o que percorrer. Resultado: duas RONDA
// COMPLETA seguidas e nenhum ensaio, sem uma linha de erro. O programa
// funcionava perfeitamente sem nunca fazer o trabalho.
//
// O endereco do data provider nao vai escrito de memoria: sai do proprio Pool,
// que ja esta conferido. Pool.ADDRESSES_PROVIDER() da o provedor, e
// provedor.getPoolDataProvider() da o endereco certo. Dois saltos, os dois
// respondidos pela rede.
const SELETOR_ADDRESSES_PROVIDER = '0x0542975c';
const SELETOR_GET_POOL_DATA_PROVIDER = '0xe860accb';

// O oraculo da propria Aave, pelo mesmo caminho: provedor.getPriceOracle().
// Ele existe porque escolher o par exige comparar VALOR, e valor precisa de
// preco. `getAssetPrice` devolve em moeda base — dolar com 8 casas.
const SELETOR_GET_PRICE_ORACLE = '0xfca513a8';
const SELETOR_GET_ASSET_PRICE = '0xb3596f07';

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
// 1.296.000 blocos = 30 dias na Base, a MESMA janela do vigia. O padrão era
// 200.000 — 4,6 dias — e a diferença não aparecia em lugar nenhum: o vigia
// achava 8.237 devedores e o caçador acharia uns 1.271, cego para os outros
// 7.000. Sem erro, sem aviso, sem linha no log. Quem pegou emprestado há vinte
// dias e cair hoje seria invisível justamente para o programa que existe para
// pegá-lo.
//
// Um caçador que enxerga menos que o vigia é pior que inútil: ele dá a
// impressão de que a borda está sendo coberta.
const BLOCOS = Number(process.env.CACA_BLOCOS ?? '1296000');
const PEDACO = Number(process.env.CACA_PEDACO ?? '2000');
// 2s = um bloco da Base. So da para olhar tao rapido porque a passada rapida
// le PRECO (1 chamada), nao as 126 posicoes (1 multicall cada vez). Olhar a
// cada 20s era piscar a cada 10 blocos, e quem ganha a liquidacao pega no
// bloco em que ela abre: chegavamos tarde em 90% das vezes.
const SEG = Number(process.env.CACA_SEG ?? '2');
// 37 e não 30 de propósito: o vigia recolhe de 30 em 30 minutos, e dois
// processos varrendo 648 faixas de blocos ao mesmo tempo, no único RPC que a
// Base responde, é como o caçador morreu da primeira vez. Um número que não
// divide o outro faz as duas varreduras se afastarem sozinhas.
const MIN_COLETA = Number(process.env.CACA_MIN_COLETA ?? '37');
// Duas velocidades, pelo mesmo motivo do vigia — e desta vez a conta é de
// tráfego. Varrer os 8.200 devedores a cada 20 segundos são 33 multicalls, 99
// pedidos por minuto: seis vezes o ritmo do vigia, no único RPC que a Base
// responde, com o vigia rodando ao lado. Por isso ele morria de cara.
//
// A ronda completa acha quem está perto; a passada rápida olha SÓ esses. A
// lista curta é de ~120 endereços, um multicall só.
const MIN_RONDA = Number(process.env.CACA_MIN_RONDA ?? '2');
/** Quem entra na lista curta: a menos de tantos % de cair. */
const LIMIAR = Number(process.env.CACA_LIMIAR ?? '10');
const TIMEOUT_MS = Number(process.env.CACA_TIMEOUT_MS ?? '20000');
const PAUSA_MS = Number(process.env.CACA_PAUSA_MS ?? '600');
/** Quantos saudáveis ensaiar por rodada, para provar o formato sem alvo real. */
const ENSAIAR = Number(process.env.CACA_ENSAIAR ?? '3');

// Tetos de gasto. Sem eles, um alvo que fica caído e cuja caçada reverte faz o
// laço tentar a cada CACA_SEG segundos: 180 tentativas por hora a US$0,01 são
// US$1,80/hora, e os US$13,61 de gás somem em 7,6 horas. Dormindo oito, daria
// para gastar o saldo inteiro sem ganhar nada — e o log da manhã seria uma
// parede de reversões idênticas.
//
// Dois tetos porque são dois defeitos diferentes: um alvo teimoso (um erro que
// se repete contra a mesma posição) e um dia ruim inteiro (muitos alvos, todos
// falhando). O primeiro pede desistir DAQUELE; o segundo, parar de enviar.
const MAX_POR_ALVO = Number(process.env.CACA_MAX_POR_ALVO ?? '3');
const MAX_ENVIOS = Number(process.env.CACA_MAX_ENVIOS ?? '25');

let rpc = process.env.CACA_RPC_URL ?? REDE.rpc;
let rpcId = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma chamada, sem paciência. Quem quiser esperar usa `chamar`.
 */
async function umaChamada<T>(metodo: string, params: unknown[]): Promise<T> {
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

/**
 * A mesma chamada, esperando quando o provedor pede calma.
 *
 * Sem isto, o caçador morria no primeiro "over rate limit" — literalmente meio
 * segundo depois de carregar a carteira. O achador de pools já tinha levado
 * esse conserto duas horas antes; escrevi o arquivo novo sem ele.
 */
async function chamar<T>(metodo: string, params: unknown[], tentativas = 4): Promise<T> {
    let espera = 1000;
    for (let i = 0; ; i += 1) {
        try {
            return await umaChamada<T>(metodo, params);
        } catch (e) {
            const msg = (e as Error).message;
            if (i >= tentativas - 1 || !ehLimiteDoProvedor(msg)) throw e;
            log.warn('O provedor pediu calma; esperando.', { erro: msg, esperandoMs: espera });
            await dormir(espera);
            espera *= 2;
        }
    }
}

/**
 * Como `chamar`, mas a reversão é o resultado desejado e não pode ser engolida.
 *
 * Tem a mesma paciência, e a distinção e toda: uma reversão vem COM dados — o
 * seletor do erro — e e resposta final. Um limite de provedor vem sem dados e
 * nao e resposta nenhuma. Repetir a primeira apagaria a medicao; nao repetir a
 * segunda desiste de uma cacada por soluco de rede.
 *
 * Eu criei esta funcao separada de `chamar` e pus o backoff so la. O log
 * classificou certo — "isto NAO e veredicto sobre a cacada, e para tentar de
 * novo" — e entao nao tentou de novo. Diagnostico certo sem conserto.
 */
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

async function chamarCruComPaciencia(
    params: unknown[],
    tentativas = 4,
): Promise<{ ok: true; dados: string } | { ok: false; mensagem: string; dados?: string }> {
    let espera = 1000;
    for (let i = 0; ; i += 1) {
        const r = await chamarCru(params);
        // Reversão traz dados e é palavra final; limite de provedor não traz.
        if (r.ok || r.dados || i >= tentativas - 1 || !ehLimiteDoProvedor(r.mensagem)) return r;
        log.warn('O provedor pediu calma no meio da caçada; esperando.', { esperandoMs: espera });
        await dormir(espera);
        espera *= 2;
    }
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

    // Anunciar a demora ANTES dela. A varredura leva uns 14 minutos — 648
    // faixas com 600ms de pausa cada, o dobro do vigia, porque a pausa maior
    // existe para não atropelar ele no único RPC da Base. Eu disse "5 minutos"
    // de cabeça e ela ficou olhando um log parado achando que tinha travado.
    const minutos = ((faixas.length * (PAUSA_MS + 700)) / 60_000).toFixed(0);
    log.info('Juntando devedores — isto demora.', {
        faixas: faixas.length,
        janela: `${BLOCOS} blocos = ${((BLOCOS * 2) / 86400).toFixed(1)} dias`,
        estimativa: `~${minutos} minutos`,
        porQueDevagar: `pausa de ${PAUSA_MS}ms por faixa para não disputar o RPC com o vigia`,
    });

    let lidas = 0;
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
        // Um programa calado por catorze minutos é indistinguível de um
        // programa morto. Falar de 100 em 100 faixas custa seis linhas de log
        // e remove a dúvida inteira.
        lidas += 1;
        if (lidas % 100 === 0) {
            log.info('Progresso da varredura.', {
                lidas: `${lidas} de ${faixas.length}`,
                devedoresAteAgora: vistos.size,
                falhas,
            });
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
    garantiaUsd?: Decimal;
    dividaUsd?: Decimal;
}

/** Descobre, para cada devedor, qual par de moedas usar. */
/**
 * Descobre, para cada devedor, qual par de moedas usar — POR VALOR.
 *
 * A primeira versao usava `escolherPar`, que compara unidades cruas. O
 * proprio projeto ja tinha escrito, em reservas.ts, por que isso e errado:
 * "escolheria quase sempre o token de mais casas decimais, e o par escolhido
 * pareceria plausivel". E foi exatamente o que apareceu no log — tres ensaios
 * seguidos com garantia e divida no MESMO token, porque 1 WETH sao 10^18
 * unidades e 5.000 USDC sao 5x10^9: o WETH ganha por doze ordens de grandeza
 * valendo metade.
 *
 * Plausivel e o problema. Um par errado nao reverte de um jeito que se
 * reconheca: ele liquida a divida pequena em vez da grande, e o lucro sai
 * menor sem nada apontar o motivo.
 */
async function montarAlvos(
    devedores: string[],
    moedas: string[],
    dataProvider: string,
    precos: Map<string, Decimal>,
    casas: Map<string, number>,
): Promise<Alvo[]> {
    const chamadas = devedores.flatMap((d) =>
        moedas.map((m) => ({ alvo: dataProvider, dados: codificarUserReserveData(m, d) })),
    );
    const rs = await lerEmLote(chamadas);

    // Preco vem do oraculo em dolar com 8 casas; a quantia, em unidades da
    // moeda. Sem qualquer um dos dois, este ativo nao entra na comparacao —
    // entrar com valor chutado e como o par errado parece certo.
    const valorDe = (ativo: string, cru: Decimal): Decimal | null => {
        const preco = precos.get(ativo.toLowerCase());
        const dec = casas.get(ativo.toLowerCase());
        if (preco === undefined || dec === undefined) return null;
        return cru.dividedBy(new Decimal(10).pow(dec)).mul(preco).dividedBy(1e8);
    };

    const fora: Alvo[] = [];
    for (let i = 0; i < devedores.length; i += 1) {
        const saldos: SaldoNaMoeda[] = [];
        for (let j = 0; j < moedas.length; j += 1) {
            const bruto = rs[i * moedas.length + j];
            if (!bruto) continue;
            try {
                const d = decodificarUserReserveData(bruto);
                saldos.push({
                    ativo: moedas[j],
                    garantiaCrua: d.usadaComoGarantia ? new Decimal(d.garantiaCrua.toString()) : new Decimal(0),
                    dividaCrua: new Decimal(d.dividaCrua.toString()),
                });
            } catch {
                /* resposta ilegível: some da conta */
            }
        }
        const par = escolherParPorValor(saldos, valorDe);
        if (par) {
            fora.push({
                devedor: devedores[i],
                quedaPct: null,
                garantia: par.garantia,
                divida: par.divida,
                garantiaUsd: par.garantiaUsd,
                dividaUsd: par.dividaUsd,
            });
        }
    }
    return fora;
}

/**
 * Devolve 'parar' quando o problema é de configuração — chave errada, contrato
 * ausente. Reiniciar nesses casos só encheria o log com a mesma queixa a cada
 * meio minuto, e a diferença entre "tenta de novo" e "não adianta tentar" é a
 * mesma que este projeto vem perseguindo a noite toda.
 */
async function principal(): Promise<'parar' | void> {
    const cacador = cacadorDaRede(REDE_ESCOLHIDA);
    if (!cacador) {
        log.error('Nenhum caçador publicado nesta rede.', { rede: REDE_ESCOLHIDA });
        return 'parar';
    }
    // O contrato novo nao vende sozinho: ele repassa um payload que o bot
    // monta consultando um agregador. Enquanto esse agregador nao estiver
    // ligado, so da para cacar quando garantia e divida sao a MESMA moeda —
    // o unico caso que dispensa troca. Dizer isso alto e melhor que cacar
    // metade dos alvos em silencio.
    const API_SWAP = process.env.CACA_SWAP_API ?? '';

    log.info(ENVIAR ? '*** MODO ENVIO — ESTE PROCESSO GASTA GÁS DE VERDADE. ***' : '*** MODO MEDIÇÃO — nada é enviado, nenhum gás é gasto. ***');
    log.info('Caçador ao vivo.', {
        rede: REDE.nome,
        contrato: cacador.endereco,
        cofre: cacador.cofre,
        agregadorDeRota: API_SWAP || 'NAO CONFIGURADO — so caça par de mesma moeda',
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
            return 'parar';
        }
        carteira = new Wallet(chave, new JsonRpcProvider(rpc));
        if (carteira.address.toLowerCase() !== cacador.dono.toLowerCase()) {
            // O contrato tem `apenasDono`. Uma chave que não é a do dono só
            // produziria reversão — e reversão paga gás.
            log.error('A chave fornecida NÃO é a do dono do contrato. Nada seria aceito.', {
                chaveCorrespondeA: carteira.address,
                donoDoContrato: cacador.dono,
            });
            return 'parar';
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

    let dataProvider: string | null = null;
    try {
        const prov = enderecoDaResposta(
            await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_ADDRESSES_PROVIDER }, 'latest']),
        );
        if (prov) {
            dataProvider = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_POOL_DATA_PROVIDER }, 'latest']),
            );
        }
    } catch (e) {
        log.error('Não deu para descobrir o data provider.', { erro: (e as Error).message });
    }
    if (!dataProvider) {
        log.error('Sem o Protocol Data Provider não dá para saber QUAL moeda o devedor deve.', {
            comoSeriaDescoberto: 'Pool.ADDRESSES_PROVIDER() e depois provedor.getPoolDataProvider()',
            porQueNaoEscrevoDeMemoria: 'endereço errado aqui não reverte: faz o caçador não achar alvo nenhum, em silêncio',
        });
        return 'parar';
    }
    log.info('Protocol Data Provider descoberto pela rede.', { endereco: dataProvider });

    let oraculo: string | null = null;
    try {
        const prov = enderecoDaResposta(
            await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_ADDRESSES_PROVIDER }, 'latest']),
        );
        if (prov) {
            oraculo = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_PRICE_ORACLE }, 'latest']),
            );
        }
    } catch (e) {
        log.error('Não deu para descobrir o oráculo.', { erro: (e as Error).message });
    }
    if (!oraculo) {
        log.error('Sem o oráculo não dá para escolher o par por VALOR.', {
            porQueImporta: 'comparar unidades cruas escolhe o token de mais casas decimais, não o que vale mais',
        });
        return 'parar';
    }
    log.info('Oráculo de preços descoberto pela rede.', { endereco: oraculo });

    const moedas = decodificarListaDeEnderecos(
        await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_GET_RESERVES_LIST }, 'latest']),
    );
    log.info('Moedas que a Aave aceita nesta rede.', { quantas: moedas.length });

    // As casas de cada moeda, uma vez só: elas não mudam.
    const casas = new Map<string, number>();
    const respDec = await lerEmLote(moedas.map((m) => ({ alvo: m, dados: SELETOR_DECIMALS })));
    moedas.forEach((m, i) => {
        if (respDec[i]) {
            try {
                casas.set(m.toLowerCase(), Number(BigInt(respDec[i]!)));
            } catch {
                /* ilegível: fica de fora e o ativo não entra na comparação */
            }
        }
    });
    if (casas.size < moedas.length) {
        log.warn('Moedas sem casas legíveis ficam fora da escolha do par.', {
            lidas: casas.size,
            de: moedas.length,
            consequencia: 'se a maior dívida for numa delas, o par escolhido será o segundo melhor',
        });
    }
    const precos = new Map<string, Decimal>();

    let devedores = await juntarDevedores(topo);
    let ultimaColeta = Date.now();
    /** Quantas vezes cada alvo já falhou. Desistir dele é mais barato que insistir. */
    const falhasPorAlvo = new Map<string, number>();
    let enviados = 0;
    // A janela vai no log em DIAS, não em blocos. "200000 blocos" não denuncia
    // nada; "4,6 dias" ao lado de um vigia que olha 30 diria na hora.
    log.info('Lista de devedores pronta.', {
        devedores: devedores.length,
        janela: `${BLOCOS} blocos = ${((BLOCOS * 2) / 86400).toFixed(1)} dias`,
        recolheDeNovo: `a cada ${MIN_COLETA} min`,
        quemFicaDeFora: 'quem pegou emprestado antes dessa janela e não pegou mais desde então',
    });

    let naMira: string[] = [];
    /** A menor distância até liquidar na borda: o gatilho do preço. */
    let menorQueda = new Decimal(100);
    let ultimaRonda = 0;

    for (;;) {
        try {
            if (Date.now() - ultimaColeta > MIN_COLETA * 60_000) {
                topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
                devedores = await juntarDevedores(topo);
                ultimaColeta = Date.now();
            }

            // Ronda completa de vez em quando; borda a cada passada.
            const ehRonda = Date.now() - ultimaRonda > MIN_RONDA * 60_000;

            // Ler os precos e uma chamada; reler as posicoes sao muitas. Entao
            // a passada rapida pergunta ao PRECO, e so acorda as posicoes
            // quando o preco cai o bastante para alguem da borda ter cruzado.
            // A conta ja existia virada do outro lado: se a mais frageil esta a
            // X% de cair, uma queda de X% no preco abre ela.
            let acordar = ehRonda;
            if (!ehRonda && naMira.length > 0) {
                const agora = await lerEmLote(
                    moedas.map((m) => ({
                        alvo: oraculo,
                        dados: SELETOR_GET_ASSET_PRICE + m.replace(/^0x/, '').padStart(64, '0'),
                    })),
                );
                let maiorQueda = new Decimal(0);
                moedas.forEach((m, i) => {
                    const base = precos.get(m.toLowerCase());
                    if (!agora[i] || !base || base.lessThanOrEqualTo(0)) return;
                    try {
                        const q = base.minus(new Decimal(BigInt(agora[i]!).toString())).dividedBy(base).mul(100);
                        if (q.greaterThan(maiorQueda)) maiorQueda = q;
                    } catch {
                        /* ilegível */
                    }
                });
                if (maiorQueda.greaterThanOrEqualTo(menorQueda)) {
                    acordar = true;
                    // Re-armar no nivel novo. Sem isto o gatilho FICA preso:
                    // a comparacao e sempre contra o preco da ultima ronda, de
                    // 2 em 2 minutos, entao uma vez cruzado ele dispararia a
                    // cada bloco ate la — 60 releituras da borda, estourando o
                    // RPC justamente na hora em que o mercado se mexe.
                    moedas.forEach((m, i) => {
                        if (!agora[i]) return;
                        try {
                            precos.set(m.toLowerCase(), new Decimal(BigInt(agora[i]!).toString()));
                        } catch {
                            /* ilegível */
                        }
                    });
                    log.info('PREÇO CRUZOU — acordando a borda.', {
                        maiorQuedaPct: maiorQueda.toFixed(3),
                        maisFragilEstavaA: `${menorQueda.toFixed(3)}%`,
                        naMira: naMira.length,
                    });
                }
            }
            if (!acordar) {
                await dormir(SEG * 1000);
                continue;
            }

            const olharAgora = ehRonda ? devedores : naMira;
            if (olharAgora.length === 0) {
                await dormir(SEG * 1000);
                continue;
            }

            const contas = await lerEmLote(
                olharAgora.map((d) => ({
                    alvo: REDE.pool,
                    dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
                })),
            );
            const caidos: string[] = [];
            const perto: string[] = [];
            let menorVista = new Decimal(100);
            const saudaveis: string[] = [];
            for (let i = 0; i < olharAgora.length; i += 1) {
                if (!contas[i]) continue;
                try {
                    const queda = quedaAteLiquidar(decodificarContaDoUsuario(contas[i]!).saude);
                    if (queda === null) continue;
                    if (queda.isZero()) caidos.push(olharAgora[i]);
                    else {
                        if (queda.lessThan(menorVista)) menorVista = queda;
                        if (queda.lessThanOrEqualTo(LIMIAR)) perto.push(olharAgora[i]);
                        if (saudaveis.length < ENSAIAR) saudaveis.push(olharAgora[i]);
                    }
                } catch {
                    /* ilegível */
                }
            }

            // A distância da mais frágil vale para qualquer leitura, não só
            // para a ronda: foi lida agora, é o gatilho de agora.
            if (menorVista.lessThan(100)) menorQueda = menorVista;

            if (ehRonda) {
                // Preços a cada ronda: eles mudam, e é deles que sai a escolha
                // do par. Um multicall para as 15 moedas.
                const respPreco = await lerEmLote(
                    moedas.map((m) => ({
                        alvo: oraculo,
                        dados: SELETOR_GET_ASSET_PRICE + m.replace(/^0x/, '').padStart(64, '0'),
                    })),
                );
                moedas.forEach((m, i) => {
                    if (!respPreco[i]) return;
                    try {
                        precos.set(m.toLowerCase(), new Decimal(BigInt(respPreco[i]!).toString()));
                    } catch {
                        /* ilegível */
                    }
                });

                naMira = perto;
                ultimaRonda = Date.now();
                log.info('RONDA COMPLETA.', {
                    olhados: olharAgora.length,
                    naBorda: naMira.length,
                    jaLiquidaveis: caidos.length,
                    limiar: `${LIMIAR}% de queda`,
                    maisFragilA: `${menorVista.toFixed(3)}% de cair`,
                    proximasPassadas: `preço a cada ${SEG}s; a borda só quando o preço cruzar`,
                });
            }

            // Os saudáveis viram ensaio: provam o formato sem existir alvo.
            const paraOlhar = caidos.length > 0 ? caidos : saudaveis;
            const ehEnsaio = caidos.length === 0;
            if (paraOlhar.length === 0) {
                await dormir(SEG * 1000);
                continue;
            }

            const alvos = await montarAlvos(paraOlhar, moedas, dataProvider, precos, casas);

            // Silêncio é o defeito, não o sintoma. Se havia quem olhar e não
            // saiu alvo nenhum, isso TEM de aparecer: foi assim que duas rondas
            // inteiras passaram sem ensaiar nada e sem uma linha dizendo isso.
            if (alvos.length === 0) {
                log.warn('Nenhum par de moedas montado — não dá para caçar sem saber o que ele deve.', {
                    olhados: paraOlhar.length,
                    dataProvider,
                    suspeitas: 'getUserReserveData não respondeu, ou os devedores não têm garantia marcada',
                });
            }
            for (const alvo of alvos) {
                const precisaTrocar = alvo.garantia.toLowerCase() !== alvo.divida.toLowerCase();
                if (precisaTrocar && !API_SWAP) {
                    log.warn('Alvo pulado: precisa trocar de moeda e não há agregador de rota.', {
                        devedor: alvo.devedor,
                        garantia: alvo.garantia,
                        divida: alvo.divida,
                        comoResolver: 'defina CACA_SWAP_API com o agregador que monta o payload do roteador',
                    });
                    continue;
                }
                const dados = codificarCaca({
                    garantia: alvo.garantia,
                    divida: alvo.divida,
                    devedor: alvo.devedor,
                    quantoCobrir: COBRIR_O_MAXIMO,
                    dadosSwap: '0x',
                    lucroMinimo: PISO_IMPOSSIVEL,
                });
                const r = await chamarCruComPaciencia([{ from: cacador.dono, to: cacador.endereco, data: dados }, 'latest']);
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
                    garantia: `${alvo.garantia}${alvo.garantiaUsd ? ` ($${alvo.garantiaUsd.toFixed(0)})` : ''}`,
                    divida: `${alvo.divida}${alvo.dividaUsd ? ` ($${alvo.dividaUsd.toFixed(0)})` : ''}`,
                    desfecho: leitura.desfecho,
                    lucro: emMoeda,
                    lucroCru: leitura.lucroCru?.toString() ?? '-',
                    erro: leitura.erro ?? '-',
                    leitura: leitura.leitura,
                    observacao: ENVIAR ? 'envio decidido a seguir' : 'MODO MEDIÇÃO: nada foi enviado',
                });

                if (!ENVIAR || !carteira || ehEnsaio) continue;
                if (leitura.desfecho !== 'mediu' || leitura.lucroCru === null || leitura.lucroCru === 0n) continue;

                const jaFalhou = falhasPorAlvo.get(alvo.devedor) ?? 0;
                if (jaFalhou >= MAX_POR_ALVO) {
                    log.warn('Alvo desistido: já falhou o bastante.', {
                        devedor: alvo.devedor,
                        falhas: jaFalhou,
                        porQue: 'insistir contra o mesmo erro só queima gás; o defeito não está na sorte',
                    });
                    continue;
                }
                if (enviados >= MAX_ENVIOS) {
                    log.error('TETO DE ENVIOS ATINGIDO — parando de enviar nesta execução.', {
                        enviados,
                        teto: MAX_ENVIOS,
                        aindaMede: 'a medição continua; só o envio parou',
                        comoResolver: 'olhe os desfechos acima antes de subir CACA_MAX_ENVIOS',
                    });
                    continue;
                }

                // O piso real: 80% do que a medição acabou de ver. A folga
                // existe porque entre medir e executar o pool se move, e
                // exigir o exato faria reverter por centavos.
                const piso = (leitura.lucroCru * 80n) / 100n;
                const envio = codificarCaca({
                    garantia: alvo.garantia,
                    divida: alvo.divida,
                    devedor: alvo.devedor,
                    quantoCobrir: COBRIR_O_MAXIMO,
                    dadosSwap: '0x',
                    lucroMinimo: piso,
                });
                enviados += 1;
                let tx;
                try {
                    tx = await carteira.sendTransaction({ to: cacador.endereco, data: envio });
                } catch (e) {
                    // Um envio que nem sai — saldo insuficiente, estimativa de
                    // gás que reverteu, nonce recusado — também é falha DESTE
                    // alvo. Sem contar aqui, `MAX_POR_ALVO` só olhava recibos e
                    // o laço insistiria para sempre num envio que nunca parte.
                    falhasPorAlvo.set(alvo.devedor, jaFalhou + 1);
                    log.warn('O envio não saiu.', {
                        devedor: alvo.devedor,
                        erro: (e as Error).message.slice(0, 200),
                        falhasDesteAlvo: jaFalhou + 1,
                    });
                    continue;
                }

                log.info('CAÇADA ENVIADA.', {
                    devedor: alvo.devedor,
                    hash: tx.hash,
                    piso: piso.toString(),
                    envioNumero: `${enviados} de ${MAX_ENVIOS} permitidos`,
                });

                // Com prazo. `wait()` sem prazo espera para SEMPRE, e uma
                // transação que nunca mina congelaria o caçador em silêncio —
                // parado, sem erro, parecendo de plantão. Na Base um bloco sai
                // a cada 2 segundos; passou de dois minutos, não vai minar.
                let recibo;
                try {
                    recibo = await Promise.race([
                        tx.wait(),
                        new Promise((_, rej) =>
                            setTimeout(() => rej(new Error('a transação não minou em 2 minutos')), 120_000),
                        ),
                    ]) as Awaited<ReturnType<typeof tx.wait>>;
                } catch (e) {
                    falhasPorAlvo.set(alvo.devedor, jaFalhou + 1);
                    log.warn('Não deu para confirmar a transação; sigo caçando.', {
                        devedor: alvo.devedor,
                        hash: tx.hash,
                        erro: (e as Error).message,
                        ondeConferir: 'basescan, pelo hash acima — ela pode minar depois',
                    });
                    continue;
                }

                const deuCerto = recibo?.status === 1;
                if (!deuCerto) falhasPorAlvo.set(alvo.devedor, jaFalhou + 1);
                log.info('CAÇADA CONCLUÍDA.', {
                    devedor: alvo.devedor,
                    hash: tx.hash,
                    status: deuCerto ? 'SUCESSO' : 'REVERTIDA',
                    gasUsado: recibo?.gasUsed?.toString() ?? '-',
                    falhasDesteAlvo: deuCerto ? 0 : jaFalhou + 1,
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
    // Ele morreu meio segundo depois de carregar a carteira, num "over rate
    // limit" durante o preparo. Um processo que deve passar a noite acordado
    // não pode sair do ar por soluço de provedor — e deixar o Railway
    // reiniciar é pior: cada reinício refaz os cinco minutos de descoberta.
    //
    // Reinicia por tropeço, PARA por configuração errada.
    void (async () => {
        for (;;) {
            try {
                if ((await principal()) === 'parar') {
                    log.error('Configuração impede rodar. Não reinicio sozinho — corrija e reimplante.');
                    return;
                }
                log.warn('O laço terminou sem erro, o que não devia acontecer. Reiniciando.');
            } catch (e) {
                log.warn('O caçador tropeçou; reiniciando em 30s.', { erro: (e as Error).message });
            }
            await dormir(30_000);
        }
    })();
}
