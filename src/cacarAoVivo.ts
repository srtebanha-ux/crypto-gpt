// Arquivo: src/cacarAoVivo.ts
import { Decimal } from 'decimal.js';
import { Wallet, JsonRpcProvider, id } from 'ethers';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import { REDES, RPCS_PARA_TENTAR, SELETOR_GET_RESERVES_LIST, decodificarListaDeEnderecos, faixasDeBlocos } from './liquidacoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario, quedaAteLiquidar } from './posicoes';
import { CHAMADAS_POR_MULTICALL, MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { codificarUserReserveData, decodificarUserReserveData, COBRIR_O_MAXIMO, ehLimiteDoProvedor } from './liquidar';
import { enderecoDaResposta, escolherParPorValor, type SaldoNaMoeda } from './reservas';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL, isDevedorIgnorado } from './caca';
import { POOLS } from './contratos';

const log = createLogger('caca');

const SELETOR_DECIMALS = '0x313ce567';
const SELETOR_ADDRESSES_PROVIDER = '0x0542975c';
const SELETOR_GET_POOL_DATA_PROVIDER = '0xe860accb';
const SELETOR_GET_PRICE_ORACLE = '0xfca513a8';
const SELETOR_GET_ASSET_PRICE = '0xb3596f07'; 

const REDE_ESCOLHIDA = (process.env.CACA_REDE ?? 'base').toLowerCase();
const REDE = REDES[REDE_ESCOLHIDA] ?? REDES.base;
const ENVIAR = process.env.CACA_ENVIAR === '1';
const BLOCOS = Number(process.env.CACA_BLOCOS ?? '1296000');
const PEDACO = Number(process.env.CACA_PEDACO ?? '2000');
const SEG = Number(process.env.CACA_SEG ?? '2');
const MIN_COLETA = Number(process.env.CACA_MIN_COLETA ?? '37');
const MIN_RONDA = Number(process.env.CACA_MIN_RONDA ?? '2');
const LIMIAR = Number(process.env.CACA_LIMIAR ?? '10');
const TIMEOUT_MS = Number(process.env.CACA_TIMEOUT_MS ?? '20000');
const PAUSA_MS = Number(process.env.CACA_PAUSA_MS ?? '600');
const MAX_POR_ALVO = Number(process.env.CACA_MAX_POR_ALVO ?? '3');
const MAX_ENVIOS = Number(process.env.CACA_MAX_ENVIOS ?? '25');

// Configuração dos dois contratos em paralelo
const CONTRATOS_ATIVOS = [
    { nome: 'V1 (WETH)', endereco: '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78', tipo: 'V1' as const },
    { nome: 'V2 (Multi-Ativo)', endereco: process.env.CACA_CONTRATO ?? '0xd87AeEcCb5969BA28C49581736cD2c0b58B117A8', tipo: 'V2' as const }
];

let rpc = process.env.CACA_RPC_URL ?? REDE.rpc;
let rpcId = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// ATUALIZADO: Modo Turbo com concorrência para a varredura inicial
async function juntarDevedores(topo: number, blocoInicial?: number): Promise<string[]> {
    const vistos = new Set<string>();
    const inicio = blocoInicial !== undefined ? Math.max(0, blocoInicial) : Math.max(0, topo - BLOCOS + 1);
    const faixas = faixasDeBlocos(inicio, topo, PEDACO);
    let falhas = 0;

    // Dispara chamadas ao RPC em lotes paralelos (acelera a leitura em 5x)
    const CONCORRENCIA = 5; 

    if (faixas.length > 10) {
        const lotes = Math.ceil(faixas.length / CONCORRENCIA);
        const minutos = ((lotes * (PAUSA_MS + 700)) / 60_000).toFixed(1);
        log.info('Juntando histórico de devedores (Modo Turbo - Multithread).', {
            faixas: faixas.length,
            janela: `${BLOCOS} blocos = ${((BLOCOS * 2) / 86400).toFixed(1)} dias`,
            estimativa: `~${minutos} minutos`,
            velocidade: `${CONCORRENCIA} chamadas em paralelo`
        });
    }

    let lidas = 0;
    for (let i = 0; i < faixas.length; i += CONCORRENCIA) {
        const lote = faixas.slice(i, i + CONCORRENCIA);
        
        await Promise.all(lote.map(async ([a, b]) => {
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
        }));
        
        lidas += lote.length;
        if (faixas.length > 10 && (lidas % (CONCORRENCIA * 5) === 0 || lidas === faixas.length)) {
            log.info('Progresso da varredura acelerada.', {
                lidas: `${lidas} de ${faixas.length}`,
                devedoresAteAgora: vistos.size,
                falhas,
            });
        }
        
        // Pausa apenas 1 vez por lote para respeitar os limites gerais da rede
        if (i + CONCORRENCIA < faixas.length) {
            await dormir(PAUSA_MS);
        }
    }
    
    if (falhas > 0) {
        log.warn('Algumas faixas de blocos falharam.', { falharam: `${falhas} de ${faixas.length}` });
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
            } catch { }
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

async function principal(): Promise<'parar' | void> {
    const poolDeVendaV1 = (process.env.CACA_POOL ?? POOLS.aerodrome.endereco).toLowerCase();

    log.info(ENVIAR ? '*** MODO ENVIO (ALTA VELOCIDADE TOTAL) — GASTO DE GÁS REAL. ***' : '*** MODO MEDIÇÃO (ALTA VELOCIDADE TOTAL) — NENHUM GÁS GASTO. ***');
    log.info('Caçador duplo em execução com Atualizações Incrementais (Sem Pausas).', {
        rede: REDE.nome,
        contratoV1: CONTRATOS_ATIVOS[0].endereco,
        contratoV2: CONTRATOS_ATIVOS[1].endereco,
        modo: ENVIAR ? 'ENVIAR' : 'MEDIR',
    });

    let carteira: Wallet | null = null;
    let donoCarteira: string | null = null;
    if (ENVIAR) {
        const chave = process.env.CACA_CHAVE_PRIVADA;
        if (!chave) {
            log.error('Falta a chave privada.', {});
            return 'parar';
        }
        carteira = new Wallet(chave, new JsonRpcProvider(rpc));
        donoCarteira = carteira.address;
        log.info('Carteira carregada.', { endereco: donoCarteira });
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
    if (!topo) return;

    let dataProvider: string | null = null;
    let oraculo: string | null = null;
    try {
        const prov = enderecoDaResposta(
            await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_ADDRESSES_PROVIDER }, 'latest']),
        );
        if (prov) {
            dataProvider = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_POOL_DATA_PROVIDER }, 'latest']),
            );
            oraculo = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_PRICE_ORACLE }, 'latest']),
            );
        }
    } catch (e) {
        log.error('Falha ao descobrir contratos base.', { erro: (e as Error).message });
    }
    
    if (!dataProvider || !oraculo) return 'parar';

    const moedas = decodificarListaDeEnderecos(
        await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_GET_RESERVES_LIST }, 'latest']),
    );

    const casas = new Map<string, number>();
    const respDec = await lerEmLote(moedas.map((m) => ({ alvo: m, dados: SELETOR_DECIMALS })));
    moedas.forEach((m, i) => {
        if (respDec[i]) {
            try { casas.set(m.toLowerCase(), Number(BigInt(respDec[i]!))); } catch {}
        }
    });
    const precos = new Map<string, Decimal>();

    // Varredura Inicial Profunda (Só acontece 1 vez ao iniciar o bot)
    let devedores = await juntarDevedores(topo);
    devedores = devedores.filter(d => !isDevedorIgnorado(d));

    let ultimaColeta = Date.now();
    let ultimoTopoLido = topo; // Guarda onde parámos para ler só o que é novo depois
    const falhasPorAlvo = new Map<string, number>();
    let enviados = 0;

    log.info('Lista inicial pronta. Patrulhando todos os alvos sem pausas longas.', { devedores: devedores.length });

    let naMira: string[] = [];
    let menorQueda = new Decimal(100);
    let ultimaRonda = 0;

    for (;;) {
        try {
            // ATUALIZAÇÃO INCREMENTAL: Lê apenas blocos novos a cada 37 minutos
            if (Date.now() - ultimaColeta > MIN_COLETA * 60_000) {
                const novoTopo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
                if (novoTopo > ultimoTopoLido) {
                    log.info('Buscando devedores novos rapidamente...', { blocosNovos: novoTopo - ultimoTopoLido });
                    
                    const novos = await juntarDevedores(novoTopo, ultimoTopoLido + 1);
                    const setDevedores = new Set([...devedores, ...novos]);
                    
                    devedores = [...setDevedores].filter(d => !isDevedorIgnorado(d));
                    ultimoTopoLido = novoTopo;
                    log.info('Atualização incremental concluída.', { totalDevedoresNaLista: devedores.length });
                }
                ultimaColeta = Date.now();
            }

            const ehRonda = Date.now() - ultimaRonda > MIN_RONDA * 60_000;
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
                    } catch {}
                });
                
                if (maiorQueda.greaterThanOrEqualTo(menorQueda)) {
                    acordar = true;
                    moedas.forEach((m, i) => {
                        if (!agora[i]) return;
                        try { precos.set(m.toLowerCase(), new Decimal(BigInt(agora[i]!).toString())); } catch {}
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
            
            for (let i = 0; i < olharAgora.length; i += 1) {
                if (!contas[i]) continue;
                try {
                    const queda = quedaAteLiquidar(decodificarContaDoUsuario(contas[i]!).saude);
                    if (queda === null) continue;
                    
                    if (queda.isZero()) caidos.push(olharAgora[i]);
                    else {
                        if (queda.lessThan(menorVista)) menorVista = queda;
                        if (queda.lessThanOrEqualTo(LIMIAR)) perto.push(olharAgora[i]);
                    }
                } catch {}
            }

            if (menorVista.lessThan(100)) menorQueda = menorVista;

            if (ehRonda) {
                const respPreco = await lerEmLote(
                    moedas.map((m) => ({
                        alvo: oraculo,
                        dados: SELETOR_GET_ASSET_PRICE + m.replace(/^0x/, '').padStart(64, '0'),
                    })),
                );
                moedas.forEach((m, i) => {
                    if (!respPreco[i]) return;
                    try { precos.set(m.toLowerCase(), new Decimal(BigInt(respPreco[i]!).toString())); } catch {}
                });

                naMira = perto;
                ultimaRonda = Date.now();
            }

            if (caidos.length === 0) {
                await dormir(SEG * 1000);
                continue; 
            }

            const alvos = await montarAlvos(caidos, moedas, dataProvider, precos, casas);
            let nonceAtual = ENVIAR && carteira ? await carteira.getNonce() : 0;

            for (const alvo of alvos) {
                for (const contrato of CONTRATOS_ATIVOS) {
                    const dados = contrato.tipo === 'V1'
                        ? codificarCacaV1({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: COBRIR_O_MAXIMO,
                            poolDeVenda: poolDeVendaV1,
                            lucroMinimo: PISO_IMPOSSIVEL,
                          })
                        : codificarCacaV2({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: COBRIR_O_MAXIMO,
                            isStablePool: false,
                            lucroMinimo: PISO_IMPOSSIVEL,
                          });
                
                    const r = await chamarCruComPaciencia([{ from: donoCarteira ?? undefined, to: contrato.endereco, data: dados }, 'latest']);
                    const leitura = lerRespostaDaCaca({
                        ok: r.ok,
                        dados: r.dados ?? '0x',
                        mensagem: 'mensagem' in r ? r.mensagem : undefined
                    });

                    log.info(`ALVO CAÍDO (${contrato.nome}) — medição.`, {
                        devedor: alvo.devedor,
                        desfecho: leitura.desfecho,
                        lucroCru: leitura.lucroCru?.toString() ?? '-',
                        erro: leitura.erro ?? '-',
                    });

                    if (!ENVIAR || !carteira) continue;
                    if (leitura.desfecho !== 'mediu' || leitura.lucroCru === undefined || leitura.lucroCru === null || leitura.lucroCru === 0n) continue;

                    const lucroCruValido = leitura.lucroCru;
                    const chaveAlvo = `${alvo.devedor}-${contrato.tipo}`;
                    const jaFalhou = falhasPorAlvo.get(chaveAlvo) ?? 0;
                    if (jaFalhou >= MAX_POR_ALVO) continue;
                    if (enviados >= MAX_ENVIOS) continue;

                    const piso = (lucroCruValido * 80n) / 100n;
                    const envio = contrato.tipo === 'V1'
                        ? codificarCacaV1({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: COBRIR_O_MAXIMO,
                            poolDeVenda: poolDeVendaV1,
                            lucroMinimo: piso,
                          })
                        : codificarCacaV2({
                            garantia: alvo.garantia,
                            divida: alvo.divida,
                            devedor: alvo.devedor,
                            quantoCobrir: COBRIR_O_MAXIMO,
                            isStablePool: false,
                            lucroMinimo: piso,
                          });
                    
                    enviados += 1;
                    try {
                        const tx = await carteira.sendTransaction({ 
                            to: contrato.endereco, 
                            data: envio,
                            nonce: nonceAtual++
                        });
                        
                        falhasPorAlvo.set(chaveAlvo, jaFalhou + 1);
                        
                        log.info(`CAÇADA ENVIADA (${contrato.nome}) COMO FOGUETE!`, { 
                            devedor: alvo.devedor, 
                            hash: tx.hash 
                        });
                    } catch (e) {
                        falhasPorAlvo.set(chaveAlvo, jaFalhou + 1);
                        log.warn(`Falha ao disparar (${contrato.nome}).`, { erro: String(e) });
                    }
                }
            }
        } catch (err) {
            log.warn('A rodada tropeçou; sigo na próxima.', { erro: err instanceof Error ? err.message : String(err) });
        }
        await dormir(SEG * 1000);
    }
}

if (require.main === module && exigirAtivacao('cacarAoVivo')) {
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
