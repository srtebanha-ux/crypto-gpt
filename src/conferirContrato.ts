// Arquivo: src/conferirContrato.ts
//
// Perguntar à Base o que foi realmente publicado — em vez de acreditar no print.
//
// *** MODO LEITURA. NENHUMA TRANSAÇÃO É ENVIADA. NENHUM GÁS É GASTO. ***
//
// O motivo deste arquivo existir é um campo só: `cofre`. Ele é `immutable` e
// não tem função para trocar, o que é a defesa contra a chave do Railway ser
// roubada — mas é também o motivo de um erro nele ser definitivo. Um endereço
// errado ali significa jogar o lucro fora para sempre, e o jeito de descobrir
// não pode ser "na primeira liquidação que der certo".
//
// Eu errei esse endereço três vezes numa noite só, respondendo de memória. A
// tela do Remix corta o endereço no meio, então o print NÃO prova nada: mostra
// o começo e esconde justamente o miolo. Só a rede sabe o que ficou gravado.
//
// Mais uma coisa que só a rede sabe: QUAL compilador produziu aquele bytecode.
// O Remix estava no 0.8.34 e os testes daqui rodam no 0.8.26 — então comparar
// bytecode com o meu daria diferente por um motivo inocente, e uma diferença
// esperada não prova nada. O que prova é o comportamento: pedir ao contrato
// publicado, sem enviar nada, que recuse duas chamadas que ele TEM que
// recusar. Se as duas guardas respondem com os erros certos, o programa que
// está na rede é este programa, tenha sido compilado por quem for.
import { AbiCoder, id } from 'ethers';
import { createLogger } from './logger';
import { exigirAtivacao } from './ativacao';
import { REDES, RPCS_PARA_TENTAR } from './liquidacoes';

const log = createLogger('conferir');
const coder = AbiCoder.defaultAbiCoder();

/** Selectors calculados do nome, nunca copiados: copiar é onde entra o erro. */
export const LEITURAS = ['dono()', 'pool()', 'cofre()'] as const;
export const SELETOR_DE: Record<string, string> = Object.fromEntries(
    LEITURAS.map((n) => [n, id(n).slice(0, 10)]),
);

export const ASSINATURA_CACAR = 'cacar(address,address,address,uint256,address,uint256)';
export const ASSINATURA_EXECUTE = 'executeOperation(address,uint256,uint256,address,bytes)';

export const NOMES_DE_ERRO_DO_CACADOR = [
    'NaoAutorizado()',
    'ChamadaInesperada()',
    'LucroInsuficiente(uint256,uint256)',
    'PoolSemLiquidez()',
    'CofreInvalido()',
];
export const ERROS_DO_CACADOR: Record<string, string> = Object.fromEntries(
    NOMES_DE_ERRO_DO_CACADOR.map((n) => [id(n).slice(0, 10), n]),
);

/** Um endereço qualquer que não é o dono nem a pool — serve de estranho. */
export const ESTRANHO = '0x0000000000000000000000000000000000000001';

/**
 * Lê a versão do compilador gravada no próprio bytecode.
 *
 * O solc anexa no fim do código um mapa CBOR com a impressão digital da
 * compilação. Dentro dele, a sequência `64 736f6c63 43 xx yy zz` é o texto
 * "solc" seguido de três bytes: maior, menor, correção. Ler isso da rede
 * responde "quem compilou o que está publicado" sem depender de lembrar qual
 * versão estava aberta no navegador na hora.
 *
 * Devolve `null` quando a marca não está lá — um contrato pode ser publicado
 * com os metadados removidos, e inventar uma versão nesse caso seria pior que
 * admitir que não dá para saber.
 */
export function lerVersaoDoCompilador(codigoHex: string): string | null {
    const hex = codigoHex.toLowerCase().replace(/^0x/, '');
    const marca = '64736f6c6343';
    const i = hex.lastIndexOf(marca);
    if (i < 0) return null;
    const bytes = hex.slice(i + marca.length, i + marca.length + 6);
    if (bytes.length < 6) return null;
    const [a, b, c] = [bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4, 6)];
    return `${parseInt(a, 16)}.${parseInt(b, 16)}.${parseInt(c, 16)}`;
}

/** Uma palavra de 32 bytes vira endereço: os 20 últimos, em minúsculas. */
export function enderecoDaPalavra(hex: string): string | null {
    const limpo = hex.toLowerCase().replace(/^0x/, '');
    if (limpo.length !== 64) return null;
    if (!/^0{24}[0-9a-f]{40}$/.test(limpo)) return null;
    return '0x' + limpo.slice(24);
}

export interface Campo {
    nome: string;
    obtido: string | null;
    esperado: string | null;
    confere: boolean | null; // null = não deu para conferir (faltou o esperado)
    apelido?: string;
}

export function compararCampo(nome: string, obtido: string | null, esperado: string | null, apelido?: string): Campo {
    if (obtido === null) return { nome, obtido, esperado, confere: false, apelido };
    if (!esperado) return { nome, obtido, esperado: null, confere: null, apelido };
    return { nome, obtido, esperado, confere: obtido.toLowerCase() === esperado.toLowerCase(), apelido };
}

export interface Guarda {
    nome: string;
    esperava: string;
    respondeu: string | null;
    confere: boolean;
}

export interface Veredicto {
    aprovado: boolean;
    motivo: string;
}

/**
 * Junta tudo num veredicto — e a regra dura é sobre o `confere: null`.
 *
 * Campo que não deu para conferir NÃO pode virar aprovação. Esse é o defeito
 * que este projeto já pegou meia dúzia de vezes: um relatório completo, sem
 * nenhum erro visível, que na verdade não mediu nada. Aqui, se o esperado do
 * cofre não foi informado, o veredicto é INCONCLUSIVO — nunca APROVADO.
 */
export function decidir(campos: Campo[], guardas: Guarda[], temCodigo: boolean): Veredicto {
    if (!temCodigo) return { aprovado: false, motivo: 'não há código nesse endereço — nada foi publicado aqui' };
    const errados = campos.filter((c) => c.confere === false);
    if (errados.length > 0) {
        return { aprovado: false, motivo: `campo errado: ${errados.map((c) => c.nome).join(', ')}` };
    }
    const guardasQueFalharam = guardas.filter((g) => !g.confere);
    if (guardasQueFalharam.length > 0) {
        return {
            aprovado: false,
            motivo: `guarda não respondeu como devia: ${guardasQueFalharam.map((g) => g.nome).join(', ')}`,
        };
    }
    const semConferir = campos.filter((c) => c.confere === null);
    if (semConferir.length > 0) {
        return {
            aprovado: false,
            motivo: `INCONCLUSIVO — faltou dizer o esperado de: ${semConferir
                .map((c) => c.nome)
                .join(', ')}. Sem isso o programa leu o valor mas não conferiu nada.`,
        };
    }
    return { aprovado: true, motivo: 'os três campos gravados conferem e as duas guardas responderam' };
}

// ---------------------------------------------------------------- execução

const REDE_ESCOLHIDA = (process.env.CONFERIR_REDE ?? 'base').toLowerCase();
const REDE = REDES[REDE_ESCOLHIDA] ?? REDES.base;
const CONTRATO = (process.env.CONFERIR_CONTRATO ?? '').toLowerCase();
const TIMEOUT_MS = Number(process.env.CONFERIR_TIMEOUT_MS ?? '20000');
let rpcId = 0;

async function chamar(rpc: string, metodo: string, params: unknown[]): Promise<{ ok: boolean; valor: string }> {
    const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: metodo, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const corpo = (await res.json()) as {
        result?: string;
        error?: { message?: string; data?: string };
    };
    if (corpo.error) {
        // A reversão vem aqui, e o dado dela é o que interessa: em nó novo vem
        // em `data`, em nó antigo vem embutido na mensagem. Procurar nos dois.
        const dado = corpo.error.data ?? (corpo.error.message ?? '').match(/0x[0-9a-fA-F]{8,}/)?.[0] ?? '';
        return { ok: false, valor: dado };
    }
    return { ok: true, valor: corpo.result ?? '' };
}

async function principal(): Promise<void> {
    if (!CONTRATO.startsWith('0x') || CONTRATO.length !== 42) {
        log.error('Falta dizer qual contrato conferir.', {
            comoResolver: 'CONFERIR_CONTRATO=0x... (o endereço que o explorador mostrou em "Contract Created at")',
        });
        return;
    }

    const rpcs = process.env.CONFERIR_RPC_URL ? [process.env.CONFERIR_RPC_URL] : (RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [REDE.rpc]);
    let rpc = rpcs[0];
    let codigo = '';
    const tropecos: string[] = [];
    for (const candidato of rpcs) {
        try {
            const r = await chamar(candidato, 'eth_getCode', [CONTRATO, 'latest']);
            if (r.ok) {
                rpc = candidato;
                codigo = r.valor;
                break;
            }
            tropecos.push(`${candidato}: ${r.valor || 'resposta vazia'}`);
        } catch (e) {
            tropecos.push(`${candidato}: ${(e as Error).message}`);
        }
    }
    if (!codigo) {
        log.error('Nenhum RPC respondeu — não deu para conferir nada.', { tropecos });
        return;
    }

    const temCodigo = codigo.length > 2;
    const bytes = Math.floor((codigo.length - 2) / 2);

    const campos: Campo[] = [];
    if (temCodigo) {
        const esperados: Record<string, { valor: string | null; apelido: string }> = {
            'dono()': { valor: process.env.CONFERIR_DONO ?? null, apelido: 'quem pode mandar caçar' },
            'pool()': { valor: process.env.CONFERIR_POOL ?? REDE.pool, apelido: 'a Aave desta rede' },
            'cofre()': { valor: process.env.CONFERIR_COFRE ?? null, apelido: 'para onde o lucro vai — SEM CONSERTO' },
        };
        for (const nome of LEITURAS) {
            const r = await chamar(rpc, 'eth_call', [{ to: CONTRATO, data: SELETOR_DE[nome] }, 'latest']);
            const lido = r.ok ? enderecoDaPalavra(r.valor) : null;
            campos.push(compararCampo(nome, lido, esperados[nome].valor, esperados[nome].apelido));
        }
    }

    const guardas: Guarda[] = [];
    if (temCodigo) {
        const zero = '0x0000000000000000000000000000000000000000';
        const provas: Array<{ nome: string; data: string; esperava: string }> = [
            {
                nome: 'cacar() vindo de um estranho',
                esperava: 'NaoAutorizado()',
                data:
                    id(ASSINATURA_CACAR).slice(0, 10) +
                    coder
                        .encode(
                            ['address', 'address', 'address', 'uint256', 'address', 'uint256'],
                            [zero, zero, zero, 0n, zero, 0n],
                        )
                        .slice(2),
            },
            {
                nome: 'executeOperation() vindo de um estranho',
                esperava: 'ChamadaInesperada()',
                data:
                    id(ASSINATURA_EXECUTE).slice(0, 10) +
                    coder
                        .encode(['address', 'uint256', 'uint256', 'address', 'bytes'], [zero, 0n, 0n, zero, '0x'])
                        .slice(2),
            },
        ];
        for (const p of provas) {
            const r = await chamar(rpc, 'eth_call', [{ from: ESTRANHO, to: CONTRATO, data: p.data }, 'latest']);
            const seletor = r.valor.slice(0, 10);
            const respondeu = ERROS_DO_CACADOR[seletor] ?? (r.ok ? 'NÃO RECUSOU (isso é grave)' : null);
            guardas.push({ nome: p.nome, esperava: p.esperava, respondeu, confere: respondeu === p.esperava });
        }
    }

    const v = decidir(campos, guardas, temCodigo);
    log.info(v.aprovado ? 'CONFERÊNCIA APROVADA.' : 'CONFERÊNCIA NÃO APROVADA.', {
        contrato: CONTRATO,
        rede: REDE_ESCOLHIDA,
        temCodigo: temCodigo ? `sim (${bytes} bytes)` : 'NÃO',
        compilador: lerVersaoDoCompilador(codigo) ?? 'não gravado no bytecode',
        campos: campos
            .map(
                (c) =>
                    `${c.nome} = ${c.obtido ?? 'não leu'} ${
                        c.confere === true ? 'CONFERE' : c.confere === false ? 'ERRADO' : 'não conferido'
                    } (${c.apelido})`,
            )
            .join(' | '),
        guardas: guardas.map((g) => `${g.nome}: esperava ${g.esperava}, veio ${g.respondeu ?? 'nada'}`).join(' | '),
        veredicto: v.motivo,
        observacao: 'MODO LEITURA: nada foi enviado, nenhum gás foi gasto.',
    });
}

if (require.main === module && exigirAtivacao('conferirContrato')) {
    principal().catch((e) => log.error('Conferência tropeçou.', { erro: (e as Error).message }));
}

// --------------------------------------------------------------------------
// Conferir o programa publicado a partir do bytecode de criação, sem rede.
//
// Isto existe porque a rede nem sempre está ao alcance: o RPC da Base está
// bloqueado de onde este código foi escrito, e mesmo assim dava para provar o
// que foi publicado — o explorador mostra o `Input Data` da transação de
// criação, e ali está o programa inteiro mais os argumentos do construtor.

/**
 * O seletor está no bytecode?
 *
 * A sutileza que derrubou a primeira versão desta conferência: o solc guarda
 * um seletor que começa com byte zero SEM esse zero. Em vez de
 * `PUSH32 00e2a5cd00…`, ele emite `PUSH31 e2a5cd00…`, porque o zero da frente
 * é implícito. Procurar os oito caracteres literais não acha nada, e a busca
 * responde "AUSENTE" com toda a confiança do mundo.
 *
 * Foi exatamente o que aconteceu: `ChamadaInesperada()` e `liquidationCall`
 * apareceram como faltando num contrato onde as duas estão. Um veredicto
 * REPROVADO, inteiro e errado, por causa de um byte que o compilador não
 * escreve.
 */
export function contemSeletor(bytecodeHex: string, seletor: string): boolean {
    const hex = bytecodeHex.toLowerCase().replace(/^0x/, '');
    const s = seletor.toLowerCase().replace(/^0x/, '');
    return hex.includes(s) || hex.includes(s.replace(/^(00)+/, ''));
}

/**
 * Lê os argumentos do construtor, que ficam colados no fim do bytecode de
 * criação — é assim que a EVM os entrega, e é por isso que dá para conferir
 * sem chamar nada.
 */
export function lerArgumentosDoFim(bytecodeHex: string, tipos: string[]): unknown[] {
    const hex = bytecodeHex.toLowerCase().replace(/^0x/, '');
    const quantos = tipos.length * 64;
    if (hex.length < quantos) throw new Error('bytecode curto demais para esses argumentos');
    return [...coder.decode(tipos, '0x' + hex.slice(-quantos))];
}

export interface ConferenciaDoPrograma {
    presentes: string[];
    ausentes: string[];
    completo: boolean;
}

/** Toda assinatura declarada na fonte tem que aparecer no que foi publicado. */
export function conferirPrograma(bytecodeHex: string, assinaturas: string[]): ConferenciaDoPrograma {
    const presentes: string[] = [];
    const ausentes: string[] = [];
    for (const s of assinaturas) {
        const cheio = id(s);
        // Evento é identificado pelo hash inteiro; função e erro, por 4 bytes.
        const alvo = /^[A-Z]/.test(s) && !s.includes('()') ? cheio : cheio.slice(0, 10);
        (contemSeletor(bytecodeHex, alvo) ? presentes : ausentes).push(s);
    }
    return { presentes, ausentes, completo: ausentes.length === 0 };
}
