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
import { avaliar, pisoParaOContrato, resumirAvaliacoes, type ItemAvaliado } from './decisao';
import {
    CHAMADAS_POR_MULTICALL,
    MULTICALL3,
    codificarAggregate3,
    decodificarAggregate3,
    partirEmPedacos,
} from './multicall';
import {
    FAIXAS_DE_RISCO,
    SELETOR_CONTA_DO_USUARIO,
    TOPIC_BORROW,
    decodificarContaDoUsuario,
    devedoresDosEventos,
    QUEDAS_DA_CASCATA,
    calcularCascata,
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
/**
 * Minutos entre duas RONDAS — olhar todos os devedores conhecidos.
 *
 * Eram 30, porque a ronda estava grudada na coleta de devedores, que leva
 * cinco minutos de `eth_getLogs`. Com o Multicall3 a ronda em si leva doze
 * SEGUNDOS, e manter as duas juntas deixava um ponto cego de meia hora: quem
 * estava a 15% (fora da zona vigiada) e despencava em vinte minutos aparecia
 * como "de surpresa" — e não era surpresa nenhuma, era o vigia olhando para
 * o outro lado.
 *
 * Separadas, o ponto cego cai de trinta minutos para dois.
 */
const MIN_RONDA = Number(process.env.VIGIA_MIN_RONDA ?? '2');

/** Minutos entre duas COLETAS de devedores novos — essa sim é cara. */
const MIN_COLETA = Number(process.env.VIGIA_MIN_COLETA ?? '30');

/**
 * Preço da moeda que paga o gás, informado à mão.
 *
 * Sem ele, o vigia mede o gás em wei e não consegue dizer se uma caçada vale a
 * pena — porque valer a pena é uma comparação entre dólares de lucro e dólares
 * de gás. Com ele, a decisão sai em número.
 *
 * Continua vindo de fora, como o preço do ETH da varredura histórica: inventar
 * cotação foi erro meu antes e não vai virar hábito.
 */
const PRECO_NATIVO_USD = process.env.VIGIA_PRECO_NATIVO
    ? new Decimal(process.env.VIGIA_PRECO_NATIVO)
    : null;

/**
 * Ágio suposto quando o vigia ainda não sabe qual é a garantia.
 *
 * Os medidos na Base foram 5%, 7,5% e 8,5%. Usar o MENOR faz a estimativa
 * errar para baixo — e errar para baixo aqui é a direção segura: uma caçada
 * aprovada com o ágio mínimo continua valendo quando o real é maior.
 */
const AGIO_SUPOSTO = new Decimal('0.05');

/**
 * Fração da dívida que a Aave deixa cobrir de uma vez.
 *
 * Metade é o caso comum; ela libera o total quando a posição está muito
 * quebrada. Supor metade subestima o prêmio, de novo na direção segura.
 */
const FATIA_COBRIVEL = new Decimal('0.5');

/** Gás estimado de uma caçada inteira, até a medição real existir. */
const GAS_ESTIMADO = new Decimal(process.env.VIGIA_GAS_ESTIMADO ?? '700000');

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

/** O Multicall3 existe nesta rede? Conferido no arranque, não presumido. */
let temMulticall = false;

/**
 * 429 quer dizer "devagar", não "não dá".
 *
 * Importa mais aqui que na varredura histórica: a ronda faz muitas chamadas
 * seguidas, e desistir no primeiro 429 deixaria buracos na lista — buracos do
 * tipo que não aparece como erro, só como ausência.
 */
async function comPaciencia<T>(metodo: string, params: unknown[]): Promise<T> {
    let espera = 600;
    for (let tentativa = 0; ; tentativa += 1) {
        try {
            return await chamar<T>(metodo, params);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (tentativa >= 5 || !msg.includes('429')) throw err;
            await dormir(espera);
            espera *= 2;
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
async function confirmarMulticall(): Promise<void> {
    try {
        const codigo = await chamar<string>('eth_getCode', [MULTICALL3, 'latest']);
        temMulticall = !!codigo && codigo !== '0x';
    } catch {
        temMulticall = false;
    }
    log.info('Multicall3.', {
        endereco: MULTICALL3,
        existe: temMulticall,
        efeito: temMulticall
            ? 'a ronda vai em pedaços de 500 leituras por chamada'
            : 'NÃO existe nesta rede; a ronda vai uma por vez e leva muito mais',
    });
}

/**
 * Uma passada por uma lista de endereços, perguntando a saúde de cada um.
 *
 * A correspondência entre resposta e devedor é por POSIÇÃO. Se ela
 * embaralhasse, o vigia atribuiria a saúde de um devedor a outro — e isso não
 * apareceria como erro, apareceria como uma lista de borda errada, que é muito
 * pior. O teste `a ordem da resposta é a ordem do pedido` existe por isso.
 */
async function olhar(devedores: string[]): Promise<Posicao[]> {
    const fora: Posicao[] = [];
    const dados = (d: string) => SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0');

    const guardar = (devedor: string, bruto: string | null) => {
        if (bruto === null || bruto === '0x') return;
        try {
            const conta = decodificarContaDoUsuario(bruto);
            fora.push({ devedor, conta, quedaPct: quedaAteLiquidar(conta.saude) });
        } catch {
            // resposta ilegível: some da conta, e o aviso de perdas embaixo pega.
        }
    };

    if (temMulticall) {
        for (const pedaco of partirEmPedacos(devedores, CHAMADAS_POR_MULTICALL)) {
            try {
                const bruto = await comPaciencia<string>('eth_call', [
                    {
                        to: MULTICALL3,
                        data: codificarAggregate3(pedaco.map((d) => ({ alvo: POOL, dados: dados(d) }))),
                    },
                    'latest',
                ]);
                const respostas = decodificarAggregate3(bruto);
                for (let i = 0; i < pedaco.length; i += 1) {
                    const r = respostas[i];
                    guardar(pedaco[i], r && r.ok ? r.dados : null);
                }
            } catch (err) {
                log.warn('Um pedaço do Multicall falhou; esses endereços não foram olhados.', {
                    quantos: pedaco.length,
                    erro: err instanceof Error ? err.message : String(err),
                });
            }
            await dormir(PAUSA_MS);
        }
    } else {
        for (const d of devedores) {
            try {
                guardar(d, await comPaciencia<string>('eth_call', [{ to: POOL, data: dados(d) }, 'latest']));
            } catch {
                // idem
            }
            await dormir(PAUSA_MS);
        }
    }

    // QUALQUER perda é dita, e não só acima de um limiar.
    //
    // O limiar era 10%, e a realidade ficou em 9%: 742 de 8.242 endereços sem
    // olhar, a cada ronda, com o vigia calado. Passar raspando de um alarme é
    // pior que estourá-lo — o número fica errado e nada no log indica.
    const perdidos = devedores.length - fora.length;
    if (perdidos > 0) {
        const fracao = perdidos / Math.max(devedores.length, 1);
        const dizer = fracao > 0.02 ? log.warn.bind(log) : log.info.bind(log);
        dizer('Endereços sem resposta nesta passada.', {
            semResposta: `${perdidos} de ${devedores.length} (${(fracao * 100).toFixed(1)}%)`,
            consequencia:
                fracao > 0.02
                    ? 'esses NÃO foram olhados; a lista da borda pode estar incompleta'
                    : 'perda pequena; a borda continua confiável',
        });
    }
    return fora;
}

/**
 * Desde quando cada devedor está PERTO da borda — e não desde quando existe.
 *
 * A primeira versão guardava o instante em que o vigia viu o endereço pela
 * primeira vez, qualquer que fosse a saúde dele. Isso daria, numa noite
 * inteira, `avisoPrevio: 7 horas` para alguém que passou a madrugada a 80% de
 * folga e despencou nos últimos dois minutos. O número seria verdadeiro e
 * responderia a pergunta errada.
 *
 * A pergunta é: DEU TEMPO DE AGIR? E isso começa a contar quando a posição
 * entra na zona vigiada, não quando ela aparece no mundo.
 */
const desdeQuandoNaZona = new Map<string, number>();

/** Quantas o vigia viu chegando, e quantas apareceram do nada. */
const placar = { previstas: 0, deSurpresa: 0 };

function anunciarQuedas(posicoes: Posicao[]): void {
    for (const p of posicoes) {
        if (p.quedaPct === null) continue;
        const chave = p.devedor;

        if (p.quedaPct.greaterThan(0)) {
            if (p.quedaPct.lessThanOrEqualTo(LIMIAR_VIGIA)) {
                if (!desdeQuandoNaZona.has(chave)) desdeQuandoNaZona.set(chave, Date.now());
            } else {
                // Saiu da zona (o preço subiu, ou pagou dívida). Se voltar, o
                // relógio recomeça — porque a folga anterior não vale como
                // aviso para a queda seguinte.
                desdeQuandoNaZona.delete(chave);
            }
            continue;
        }

        const desde = desdeQuandoNaZona.get(chave);
        desdeQuandoNaZona.delete(chave);
        if (desde === undefined) placar.deSurpresa += 1;
        else placar.previstas += 1;

        log.info('*** LIQUIDÁVEL AGORA ***', {
            devedor: chave,
            dividaUsd: `$${p.conta.dividaBase.dividedBy(1e8).toFixed(0)}`,
            avisoPrevio:
                desde === undefined
                    ? `NENHUM — nunca passou pela zona de ${LIMIAR_VIGIA}%; o vigia não viu chegando`
                    : `${((Date.now() - desde) / 60000).toFixed(1)} minutos dentro da zona de ${LIMIAR_VIGIA}%`,
            placarAteAgora: `${placar.previstas} previstas / ${placar.deSurpresa} de surpresa`,
            observacao: 'MODO LEITURA: nada foi enviado.',
        });
    }
}

function relatar(titulo: string, posicoes: Posicao[], falar = true): Posicao[] {
    const r = resumirPosicoes(posicoes, LIMIAR_VIGIA);
    if (falar) log.info(titulo, {
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

/**
 * Quanto valeria cada posição da borda, se abrisse AGORA.
 *
 * O vigia até aqui dizia quem está perto. Isto diz quanto isso vale — e é
 * outra pergunta: uma posição a 0,04% de liquidar com US$1 de dívida não
 * interessa, e uma a 9% com US$1,8 milhão interessa muito.
 *
 * Nada é enviado. O que se mede aqui é se a decisão TERIA sido disparar, e
 * com que número — para que a taxa de acerto deixe de ser chute antes de
 * existir dinheiro em jogo.
 */
async function quantoValeriaAborda(naMira: Posicao[]): Promise<void> {
    if (naMira.length === 0) return;

    let precoDoGasWei: Decimal;
    try {
        precoDoGasWei = new Decimal(Number.parseInt(await chamar<string>('eth_gasPrice', []), 16));
    } catch (err) {
        log.warn('Não deu para ler o preço do gás; sem ele não dá para decidir.', {
            erro: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    const gwei = precoDoGasWei.dividedBy('1e9');
    if (PRECO_NATIVO_USD === null) {
        log.info('PREÇO DO GÁS agora.', {
            gwei: gwei.toFixed(4),
            custoDeUmaCacada: `${GAS_ESTIMADO.mul(precoDoGasWei).dividedBy('1e18').toFixed(8)} ${REDE.moedaNativa}`,
            paraVerEmDolar: `defina VIGIA_PRECO_NATIVO com o preço do ${REDE.moedaNativa}`,
        });
        return;
    }

    // Todas, e não as dez primeiras: `avaliar()` é aritmética pura, sem uma
    // chamada de rede dentro do laço, então amostrar não economizava nada e
    // custava a posição mais valiosa da borda. Quem escolhe o que MOSTRAR é
    // `resumirAvaliacoes`, depois de tudo estar medido.
    const avaliadas: ItemAvaliado[] = naMira.map((p) => {
        const dividaUsd = p.conta.dividaBase.dividedBy(1e8);
        const v = avaliar({
            dividaCobertaUsd: dividaUsd.mul(FATIA_COBRIVEL),
            bonus: AGIO_SUPOSTO,
            premioFlashLoan: new Decimal('0.0005'),
            // Sem saber em qual pool a garantia seria vendida, suponho a perda
            // de um pool fundo. Num pool raso isso subestima o custo, e é por
            // isso que a decisão de valer não basta: o contrato reconfere.
            perdaNaTroca: new Decimal('0.003'),
            gasEstimado: GAS_ESTIMADO,
            precoDoGasWei,
            precoNativoUsd: PRECO_NATIVO_USD,
        });
        return { chave: p.devedor.slice(0, 10), queda: p.quedaPct?.toNumber() ?? null, dividaUsd, veredicto: v };
    });

    const r = resumirAvaliacoes(avaliadas);

    log.info('QUANTO VALERIA — se a borda abrisse agora.', {
        gasAgora: `${gwei.toFixed(4)} gwei`,
        custoDeUmaTentativa: `$${GAS_ESTIMADO.mul(precoDoGasWei).dividedBy('1e18').mul(PRECO_NATIVO_USD).toFixed(2)}`,
        valeriamAPena: `${r.quantasValem} de ${r.quantasAvaliadas}`,
        somaSeGanhasseTodas: `$${r.somaLiquidaUsd.toFixed(2)}`,
        // Dívida zero numa posição que está na mira por estar perto de
        // liquidar é contradição: ou a leitura da moeda falhou, ou a posição
        // se fechou entre uma medida e outra. Contar em vez de esconder.
        dividaIlegivel:
            r.semDivida > 0 ? `${r.semDivida} na mira com dívida $0 — leitura a conferir` : 'nenhuma',
        observacao: 'MODO LEITURA: nada é enviado. Isto mede a DECISÃO, não a execução.',
        detalhe:
            r.linhas.length > 0
                ? `as ${r.linhas.length} que mais pagam, de ${r.quantasValem}: ${r.linhas.join(' | ')}`
                : 'nenhuma valeria o gás agora',
    });
}

/**
 * Uma ronda completa: olhar todo mundo, dizer quem está na borda, o que a
 * cascata abre e quanto valeria se abrisse agora.
 *
 * Isto virou função porque a PRIMEIRA ronda — a que roda antes do laço —
 * fazia só a primeira parte. Cascata e QUANTO VALERIA só existiam dentro do
 * laço, então todo reinício começava com o relatório pela metade.
 *
 * O custo disso não era teórico: cada push reimplanta o Railway e reinicia o
 * vigia, e o relatório completo só aparecia MIN_RONDA minutos depois. Ou
 * seja, justo quando se está olhando o log para saber se a mudança funcionou,
 * o log não conta a parte que mudou.
 */
async function rondaCompleta(devedores: string[]): Promise<Posicao[]> {
    const todas = await olhar(devedores);
    const naMira = relatar('RONDA COMPLETA.', todas, true);
    const c = calcularCascata(todas);
    log.info('CASCATA — o que abre se o mercado cair.', {
        porQueda: QUEDAS_DA_CASCATA.map(
            (q) => `${q}%: $${c.porQueda[q].toFixed(0)} (${c.quantasPorQueda[q]})`,
        ).join(' | '),
        leitura: c.leitura,
    });
    await quantoValeriaAborda(naMira);
    return naMira;
}

async function principal(): Promise<void> {
    log.info('*** MODO LEITURA — nenhuma transação é enviada por este processo. ***');
    log.info('Vigia de posições.', {
        rede: REDE.nome,
        pool: POOL,
        limiarDeVigia: `${LIMIAR_VIGIA}% de queda`,
        rondaCompleta: `a cada ${MIN_RONDA} min`,
        coletaDeDevedores: `a cada ${MIN_COLETA} min`,
        passadaRapida: `a cada ${SEG_VIGIA}s`,
        porQueDuasVelocidades:
            'a janela medida na Base foi de ~18 minutos; a ronda cabe dentro dela, então completo vence rápido',
    });

    if (!(await sondar())) return;
    await confirmarMulticall();

    let devedores = await juntarDevedores();
    if (devedores.length === 0) {
        log.error('Nenhum devedor encontrado. Sem lista não há vigia.', { pool: POOL });
        return;
    }

    let naMira = await rondaCompleta(devedores);
    let ultimaRonda = Date.now();
    let ultimaColeta = Date.now();

    let ultimoResumo = Date.now();
    let assinaturaAnterior = '';

    for (;;) {
        try {
            // Coleta (cara, 5 min) e ronda (barata, 12 s) andam em ritmos
            // diferentes de propósito. Juntas, a barata herdava o intervalo da
            // cara e o vigia ficava meia hora sem olhar a maioria.
            if (Date.now() - ultimaColeta > MIN_COLETA * 60_000) {
                devedores = await juntarDevedores();
                ultimaColeta = Date.now();
            }

            if (Date.now() - ultimaRonda > MIN_RONDA * 60_000) {
                naMira = await rondaCompleta(devedores);
                ultimaRonda = Date.now();
                continue;
            }

            if (naMira.length > 0) {
                const atual = await olhar(naMira.map((p) => p.devedor));
                // Falar de 20 em 20 segundos a noite inteira são mais de mil
                // linhas iguais, e aí a UMA que importa se perde no meio. Só
                // fala quando a lista muda de verdade.
                const assinatura = atual
                    .filter((p) => p.quedaPct !== null)
                    .map((p) => `${p.devedor}:${p.quedaPct!.toFixed(1)}`)
                    .sort()
                    .join(',');
                naMira = relatar('VIGIA — mudou algo na borda.', atual, assinatura !== assinaturaAnterior);
                assinaturaAnterior = assinatura;
            }

            // Sinal de vida de hora em hora, para de manhã dar para saber que
            // ele passou a noite acordado — e não que morreu às duas.
            if (Date.now() - ultimoResumo > 60 * 60_000) {
                log.info('DE PLANTÃO — uma hora se passou.', {
                    naBorda: naMira.length,
                    devedoresNaLista: devedores.length,
                    placar: `${placar.previstas} previstas / ${placar.deSurpresa} de surpresa`,
                    proximaRonda: `${Math.max(0, MIN_RONDA - (Date.now() - ultimaRonda) / 60_000).toFixed(0)} min`,
                });
                ultimoResumo = Date.now();
            }
        } catch (err) {
            // Uma falha de rede às três da manhã não pode custar a noite
            // inteira. Antes, qualquer erro aqui derrubava `principal` e o
            // processo ficava ocioso até alguém olhar — exatamente o que não
            // acontece de madrugada.
            log.warn('Tropeço no laço; seguindo.', {
                erro: err instanceof Error ? err.message : String(err),
            });
        }
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
