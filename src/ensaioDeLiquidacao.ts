// Arquivo: src/ensaioDeLiquidacao.ts
//
// Perguntar à Aave, sem enviar nada: "você entendeu o que eu pedi?"
//
// *** MODO LEITURA. NENHUMA TRANSAÇÃO É ENVIADA. NENHUM GÁS É GASTO. ***
//
// O que este programa procura NÃO é uma liquidação que dê certo. Nenhuma vai
// dar: ele roda contra posições saudáveis de propósito. O que ele procura é a
// Aave RECUSAR com um código dela — porque recusar com código prova que ela
// leu o pedido, e ler o pedido é a única coisa que precisa estar certa antes
// de existir dinheiro na jogada.
//
// A distinção que isso resolve vale o programa inteiro: no dia da liquidação
// de verdade, um erro meu de formatação e um azar de corrida produzem o MESMO
// log — "a transação reverteu". Sem este ensaio, seria impossível saber qual
// dos dois foi. Com ele, o formato já está provado e sobra só o azar.
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import {
    REDES,
    RPCS_PARA_TENTAR,
    SELETOR_GET_RESERVES_LIST,
    decodificarListaDeEnderecos,
    faixasDeBlocos,
} from './liquidacoes';
import { TOPIC_BORROW, devedoresDosEventos, SELETOR_CONTA_DO_USUARIO, decodificarContaDoUsuario } from './posicoes';
import { CHAMADAS_POR_MULTICALL, MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';
import { COBRIR_O_MAXIMO, codificarLiquidacao, lerRespostaDaAave } from './liquidar';

const log = createLogger('ensaio');

const REDE_ESCOLHIDA = (process.env.ENSAIO_REDE ?? 'base').toLowerCase();
const REDE = REDES[REDE_ESCOLHIDA] ?? REDES.base;
const POOL = (process.env.ENSAIO_POOL ?? REDE.pool).toLowerCase();
const BLOCOS = Number(process.env.ENSAIO_BLOCOS ?? '200000');
const PEDACO = Number(process.env.ENSAIO_PEDACO ?? '2000');
const PAUSA_MS = Number(process.env.ENSAIO_PAUSA_MS ?? '700');
const TIMEOUT_MS = Number(process.env.ENSAIO_TIMEOUT_MS ?? '20000');
/** Quantos devedores ensaiar. Poucos bastam: o que se testa é o FORMATO. */
const QUANTOS = Number(process.env.ENSAIO_QUANTOS ?? '5');

let rpcEmUso = process.env.ENSAIO_RPC_URL ?? REDE.rpc;
let rpcId = 0;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Diferente do resto do projeto, aqui a REVERSÃO é o resultado desejado, então
 * a mensagem de erro não pode ser engolida nem resumida — ela É a medição.
 */
async function chamarCru(
    metodo: string,
    params: unknown[],
): Promise<{ ok: true; resultado: string } | { ok: false; mensagem: string }> {
    const res = await fetch(rpcEmUso, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: metodo, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = (await res.json()) as {
        result?: string;
        error?: { message: string; data?: string };
    };
    if (corpo.error) {
        // Alguns provedores põem a razão em `data`, outros em `message`.
        const d = corpo.error.data;
        return { ok: false, mensagem: `${corpo.error.message}${d ? ` | ${d}` : ''}` };
    }
    return { ok: true, resultado: corpo.result ?? '0x' };
}

async function chamar<T = string>(metodo: string, params: unknown[]): Promise<T> {
    const r = await chamarCru(metodo, params);
    if (!r.ok) throw new Error(r.mensagem);
    return r.resultado as unknown as T;
}

async function principal(): Promise<void> {
    log.info('*** MODO LEITURA — nenhuma transação é enviada, nenhum gás é gasto. ***');
    log.info('Ensaio de liquidação.', {
        rede: REDE.nome,
        pool: POOL,
        oQueProcura:
            'a Aave RECUSAR com código dela. Recusa com código = ela leu o pedido. ' +
            'É isso que precisa estar provado antes de haver dinheiro na jogada.',
    });

    for (const rpc of [rpcEmUso, ...(RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [])]) {
        try {
            await chamar('eth_blockNumber', []);
            rpcEmUso = rpc;
            break;
        } catch {
            /* tenta o próximo */
        }
    }

    const ativos = decodificarListaDeEnderecos(
        await chamar('eth_call', [{ to: POOL, data: SELETOR_GET_RESERVES_LIST }, 'latest']),
    );
    if (ativos.length === 0) {
        log.error('O pool não devolveu ativos. Sem ativos não há par para ensaiar.', { pool: POOL });
        return;
    }
    log.info('Ativos do pool.', { quantos: ativos.length });

    // Devedores recentes — não precisa de muitos nem de janela longa: o que se
    // ensaia é o formato da chamada, não a qualidade da oportunidade.
    const topo = Number.parseInt(await chamar('eth_blockNumber', []), 16);
    const faixas = faixasDeBlocos(Math.max(0, topo - BLOCOS), topo, PEDACO);
    const vistos = new Set<string>();
    for (const [de, ate] of faixas) {
        try {
            const logs = await chamar<Array<{ topics: string[] }>>('eth_getLogs', [
                {
                    address: POOL,
                    fromBlock: `0x${de.toString(16)}`,
                    toBlock: `0x${ate.toString(16)}`,
                    topics: [TOPIC_BORROW],
                },
            ]);
            for (const d of devedoresDosEventos(logs)) vistos.add(d);
        } catch {
            /* pedaço perdido não invalida o ensaio */
        }
        if (vistos.size >= QUANTOS * 20) break;
        await dormir(PAUSA_MS);
    }
    log.info('Devedores recentes encontrados.', { quantos: vistos.size });

    // Só interessam os que REALMENTE devem: contra quem não deve nada, a Aave
    // recusaria por falta de dívida e o ensaio não testaria o que interessa.
    const comDivida: string[] = [];
    for (const pedaco of partirEmPedacos([...vistos], CHAMADAS_POR_MULTICALL)) {
        const bruto = await chamar('eth_call', [
            {
                to: MULTICALL3,
                data: codificarAggregate3(
                    pedaco.map((d) => ({
                        alvo: POOL,
                        dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
                    })),
                ),
            },
            'latest',
        ]);
        const respostas = decodificarAggregate3(bruto);
        pedaco.forEach((d, i) => {
            const r = respostas[i];
            if (!r || !r.ok) return;
            try {
                if (decodificarContaDoUsuario(r.dados).dividaBase.greaterThan(0)) comDivida.push(d);
            } catch {
                /* ilegível */
            }
        });
        if (comDivida.length >= QUANTOS) break;
        await dormir(PAUSA_MS);
    }

    const alvos = comDivida.slice(0, QUANTOS);
    if (alvos.length === 0) {
        log.error('Nenhum devedor com dívida aberta na amostra. Sem alvo não há ensaio.', {});
        return;
    }

    let entenderam = 0;
    let naoDeuParaTestar = 0;
    const linhas: string[] = [];
    for (const devedor of alvos) {
        // O par é qualquer um plausível de propósito. Se o devedor não tiver
        // exatamente esse par, a Aave recusa por OUTRO código — e recusar por
        // outro código prova igualmente que ela leu.
        const dados = codificarLiquidacao({
            garantia: ativos[0],
            divida: ativos[1] ?? ativos[0],
            devedor,
            quantoCobrir: COBRIR_O_MAXIMO,
            receberAToken: false,
        });
        const r = await chamarCru('eth_call', [{ to: POOL, data: dados }, 'latest']);
        if (r.ok) {
            linhas.push(`${devedor.slice(0, 10)}: NÃO reverteu (inesperado numa posição saudável)`);
        } else {
            const leitura = lerRespostaDaAave(r.mensagem);
            if (leitura.entendeu) entenderam += 1;
            else if (leitura.naoDeuParaTestar) naoDeuParaTestar += 1;
            linhas.push(`${devedor.slice(0, 10)}: ${leitura.codigo ?? '?'} — ${leitura.texto}`);
        }
        await dormir(PAUSA_MS);
    }

    // O que decide o veredicto é quantas foram REPROVADAS por formato — não
    // quantas foram testadas. Uma que o provedor recusou não é evidência
    // contra a chamada, é ausência de evidência, e misturar as duas fazia um
    // ensaio aprovado aparecer como PARCIAL.
    const testadas = alvos.length - naoDeuParaTestar;
    const reprovadas = testadas - entenderam;
    log.info('RESULTADO DO ENSAIO.', {
        ensaiados: alvos.length,
        aAaveEntendeu: `${entenderam} de ${testadas} que deram para testar`,
        naoDeramParaTestar: naoDeuParaTestar > 0 ? `${naoDeuParaTestar} (limite do provedor)` : 'nenhuma',
        veredicto:
            testadas === 0
                ? 'INCONCLUSIVO: o provedor recusou todas. Nenhuma chegou à Aave; tente de novo mais devagar.'
                : reprovadas === 0
                  ? 'APROVADO: a Aave leu todas as que chegaram nela e recusou por motivo dela. O formato está certo — no dia de valer, se falhar, será corrida perdida e não erro meu.'
                  : `REPROVADO: ${reprovadas} de ${testadas} não foram reconhecidas. O formato está errado, e é bom ter descoberto agora.`,
        detalhe: linhas.join(' | '),
    });

    log.info('Terminado. O processo fica ocioso para não reiniciar em laço.', {
        paraDesligar: 'apague ATIVAR_ENSAIODELIQUIDACAO',
    });
    setInterval(() => {}, 1 << 30);
}

if (require.main === module && exigirAtivacao('ensaioDeLiquidacao')) {
    principal().catch((err) => {
        log.error('Ensaio parou.', { erro: err instanceof Error ? err.message : String(err) });
        setInterval(() => {}, 1 << 30);
    });
}
