// Arquivo: src/flashArbExecutor.ts
//
// Execução REAL do flash swap: transforma um ciclo achado pelo
// dexArbitrageSniffer numa chamada ao contrato FlashArb.sol.
//
// A peça central aqui não é o envio — é o ENSAIO. Antes de gastar um centavo
// de gás, a mesma transação é executada contra o estado atual da rede por
// `eth_call`, que não custa nada e não altera nada. Se o ciclo for uma
// armadilha (token com taxa de transferência, trava de venda, reserva que
// mudou entre a leitura e o envio), o ensaio reverte e o motivo REAL vem
// junto, decodificado do erro do contrato.
//
// Isso importa mais do que parece neste projeto: a única oportunidade que o
// scanner encontrou na Base sobreviveu a nove varreduras seguidas com margem
// de 2,19%. Numa rede competitiva, margem que não é tomada em um ou dois
// blocos é margem que NÃO PODE ser tomada. O ensaio responde de graça qual das
// duas coisas ela é — e a resposta, quando é armadilha, vem como
// `LucroInsuficiente(sobra, minimo)` com a sobra real medida dentro da EVM.
//
// A segunda garantia é o próprio contrato: `lucroMinimo` é conferido ON-CHAIN,
// no fim do callback. Se não bater, tudo reverte e o estado volta ao que era.
// O pior caso de uma tentativa, portanto, é o gás — nunca o capital. É o que
// permite tentar sem apostar.
//
// Nada aqui envia transação sem FLASH_ARB_LIVE=true e
// FLASH_ARB_CONFIRM=I_UNDERSTAND_THE_RISK, no mesmo padrão dos outros motores.
import { Decimal } from 'decimal.js';
import { getAmountOut, type CycleEvaluation, type Hop } from './ammMath';
import { encodeAddress } from './evmAbi';
import type { Cycle } from './dexGraph';

/** Seletores calculados de keccak256(assinatura)[0:4]. Ver o teste que os reconfere. */
export const FLASH_ARB_SELECTORS = {
    executarArbitragem: '0xa7e42d50',
    sacar: '0xb319041e',
    balanceOf: '0x70a08231',
} as const;

/** Erros que o FlashArb.sol pode reverter, por seletor. */
export const ERROS_CONHECIDOS: Record<string, string> = {
    '0x9612b7e0': 'LucroInsuficiente',
    '0x00e2a5cd': 'ChamadaInesperada',
    '0xe7eb56ec': 'NaoAutorizado',
    '0x08c379a0': 'Error(string)', // revert("...") padrão do Solidity
    '0x4e487b71': 'Panic(uint256)', // assert/overflow/divisão por zero
};

export interface PlanoDeExecucao {
    poolEmprestimo: string;
    poolVenda: string;
    /** O token que sai emprestado e é vendido (o ALT do ciclo, não o base). */
    tokenEmprestado: string;
    /** Quantidade emprestada, em unidades CRUAS do token emprestado. */
    quantidade: bigint;
    /** Piso de lucro conferido on-chain, em unidades cruas do token base. */
    lucroMinimo: bigint;
}

export type Recusa = { motivo: string };

/**
 * Converte um valor humano em unidades cruas (wei do token) SEM passar por
 * aritmética de Decimal.
 *
 * O projeto roda com `Decimal.set({ precision: 20 })`, e um valor de 18
 * decimais em escala grande estoura isso: 100 WETH em wei tem 21 dígitos, e
 * multiplicar por 10^18 dentro do Decimal ARREDONDARIA silenciosamente — um
 * erro de quantidade que só apareceria como transação revertida sem motivo
 * óbvio. Trabalhar na string e fechar em BigInt não tem teto de precisão.
 *
 * Trunca (nunca arredonda para cima): quantidade a MAIS do que se calculou é
 * quantidade que pode não existir na reserva.
 */
export function paraUnidadesCruas(valor: Decimal, decimais: number): bigint {
    if (!valor.isFinite() || valor.lessThan(0)) {
        throw new Error(`Valor inválido para conversão em unidades cruas: ${valor.toString()}`);
    }
    if (!Number.isInteger(decimais) || decimais < 0 || decimais > 36) {
        throw new Error(`Casas decimais inválidas: ${decimais}`);
    }
    const texto = valor.toFixed(decimais, Decimal.ROUND_DOWN);
    const [inteira, fracao = ''] = texto.split('.');
    return BigInt(inteira + fracao.padEnd(decimais, '0'));
}

/** Uma palavra de 32 bytes com um uint256, sem prefixo. */
function palavraUint(valor: bigint): string {
    if (valor < 0n) throw new Error(`uint256 não aceita negativo: ${valor}`);
    const hex = valor.toString(16);
    if (hex.length > 64) throw new Error(`Valor excede uint256: ${valor}`);
    return hex.padStart(64, '0');
}

/** Calldata de `executarArbitragem(address,address,address,uint256,uint256)`. */
export function montarCalldata(plano: PlanoDeExecucao): string {
    return (
        FLASH_ARB_SELECTORS.executarArbitragem +
        encodeAddress(plano.poolEmprestimo) +
        encodeAddress(plano.poolVenda) +
        encodeAddress(plano.tokenEmprestado) +
        palavraUint(plano.quantidade) +
        palavraUint(plano.lucroMinimo)
    );
}

export interface EntradaDoPlano {
    cycle: Cycle;
    hops: Hop[];
    evaluation: CycleEvaluation;
    /** decimals() de cada token, minúsculo -> casas. */
    decimaisPorToken: Map<string, number>;
    /**
     * Fração do lucro estimado exigida on-chain (0.5 = metade). Abaixo de 1
     * porque a reserva muda entre a leitura e a execução: exigir o lucro
     * inteiro faria a transação reverter por qualquer movimento a favor de
     * outro participante, gastando gás à toa.
     */
    margemDeSeguranca: Decimal;
    /**
     * Saldo do token base JÁ parado no contrato, em unidades cruas.
     *
     * Entra no piso porque o contrato confere `balanceOf(address(this))`, não o
     * lucro desta operação. Com saldo anterior no contrato, um piso igual ao
     * lucro esperado passaria mesmo numa operação que PERDEU dinheiro — a
     * garantia on-chain viraria decoração. Somando o saldo, ela volta a medir
     * o que esta operação de fato produziu.
     */
    saldoAtualDoLucro: bigint;
}

/**
 * Traduz um ciclo do scanner num plano de chamada — ou recusa, dizendo por quê.
 *
 * O contrato executa APENAS o ciclo de dois pools (empresta, vende no outro,
 * devolve). Ciclo triangular não tem caminho por `executarArbitragem`, e
 * mandá-lo mesmo assim não daria erro de compilação: daria uma transação
 * revertida, ou pior, uma que executa outra coisa. Recusar explicitamente é a
 * diferença entre as duas.
 */
export function planejarExecucao(entrada: EntradaDoPlano): PlanoDeExecucao | Recusa {
    const { cycle, hops, evaluation } = entrada;
    if (cycle.pools.length !== 2) {
        return {
            motivo:
                `O contrato FlashArb executa só ciclo de 2 pools; este tem ${cycle.pools.length}. ` +
                'Ciclo triangular precisa de outro contrato.',
        };
    }
    if (!evaluation.profitable || evaluation.netProfit.lessThanOrEqualTo(0)) {
        return { motivo: 'Ciclo sem lucro líquido positivo na estimativa — não há o que executar.' };
    }

    // path = [base, alt, base]. O contrato empresta o ALT do primeiro pool,
    // vende no segundo e devolve o BASE — então o lucro sobra em BASE.
    const tokenBase = cycle.path[0];
    const tokenAlt = cycle.path[1];
    if (!tokenBase || !tokenAlt) return { motivo: 'Ciclo sem caminho de tokens utilizável.' };

    const decimaisAlt = entrada.decimaisPorToken.get(tokenAlt.toLowerCase());
    const decimaisBase = entrada.decimaisPorToken.get(tokenBase.toLowerCase());
    if (decimaisAlt === undefined || decimaisBase === undefined) {
        return { motivo: `Sem decimals() conhecido para ${decimaisAlt === undefined ? tokenAlt : tokenBase}.` };
    }

    // `evaluation.amountIn` é o BASE que entra no primeiro pool. O contrato
    // recebe a quantidade do ALT EMPRESTADO — que é a saída desse primeiro
    // salto, não a entrada. Passar amountIn aqui dimensionaria a operação na
    // unidade errada, e em tokens de preço muito diferente isso não seria um
    // erro pequeno: seria ordens de grandeza.
    const quantidadeAlt = getAmountOut(evaluation.amountIn, hops[0]);
    const quantidade = paraUnidadesCruas(quantidadeAlt, decimaisAlt);
    if (quantidade <= 0n) return { motivo: 'Quantidade emprestada arredondou para zero nas unidades do token.' };

    const lucroExigido = evaluation.netProfit.mul(entrada.margemDeSeguranca);
    const lucroMinimo = entrada.saldoAtualDoLucro + paraUnidadesCruas(lucroExigido, decimaisBase);

    return {
        poolEmprestimo: cycle.pools[0].address,
        poolVenda: cycle.pools[1].address,
        tokenEmprestado: tokenAlt,
        quantidade,
        lucroMinimo,
    };
}

/**
 * Lê o retorno de erro de um `eth_call` revertido e diz o que aconteceu.
 *
 * `LucroInsuficiente(sobra, minimo)` é o diagnóstico mais valioso do sistema:
 * `sobra` é quanto o ciclo REALMENTE produziu dentro da EVM, medido no estado
 * atual da rede. Sobra zero ou perto de zero num ciclo que o scanner estimou
 * lucrativo é a assinatura de token que não se deixa vender — a armadilha,
 * confirmada de graça e sem enviar transação.
 */
export function interpretarReversao(dataHex: string | undefined): string {
    if (!dataHex || dataHex === '0x') {
        return 'Reverteu sem dado de erro (pool ou token rejeitou a operação sem motivo declarado).';
    }
    const data = dataHex.startsWith('0x') ? dataHex.slice(2) : dataHex;
    const seletor = '0x' + data.slice(0, 8).toLowerCase();
    const nome = ERROS_CONHECIDOS[seletor];

    if (seletor === '0x9612b7e0') {
        const sobra = BigInt('0x' + (data.slice(8, 72) || '0'));
        const minimo = BigInt('0x' + (data.slice(72, 136) || '0'));
        const veredito =
            sobra === 0n
                ? 'A sobra foi ZERO: o ciclo não devolveu nada. É a assinatura de token que não se deixa vender (taxa de transferência ou trava). Não insista neste par.'
                : `A sobra real (${sobra}) ficou abaixo do piso (${minimo}). O ciclo existe mas rende menos do que a estimativa — ou alguém chegou antes.`;
        return `LucroInsuficiente(sobra=${sobra}, minimo=${minimo}). ${veredito}`;
    }
    if (seletor === '0x08c379a0') {
        // Error(string): offset, tamanho, bytes. Só os ASCII imprimíveis.
        const tamanho = Number(BigInt('0x' + (data.slice(72, 136) || '0')));
        const bytes = data.slice(136, 136 + tamanho * 2);
        let texto = '';
        for (let i = 0; i + 1 < bytes.length; i += 2) texto += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
        return `Error("${texto}") — mensagem vinda do pool ou do token, não do FlashArb.`;
    }
    if (nome) return `${nome} — erro do próprio FlashArb.`;
    return `Reverteu com erro desconhecido (seletor ${seletor}). Provavelmente vem do token ou do pool, não do FlashArb.`;
}

// ---------------------------------------------------------------------------
// Camada de rede. Tudo acima é puro e testável sem RPC; daqui pra baixo fala
// com a cadeia.
// ---------------------------------------------------------------------------

interface RespostaRpc {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

async function chamarRpc(rpcUrl: string, method: string, params: unknown[]): Promise<RespostaRpc> {
    const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method} falhou: HTTP ${res.status}`);
    return (await res.json()) as RespostaRpc;
}

/**
 * O dado de revert vem em lugares diferentes conforme o provedor: alguns
 * põem em `error.data` como string, outros aninham em `error.data.data`.
 * Procurar num lugar só faria o motivo real virar "erro desconhecido"
 * justamente quando ele é a informação que se foi buscar.
 */
export function extrairDadoDeReversao(error: { message: string; data?: unknown } | undefined): string | undefined {
    if (!error) return undefined;
    const d = error.data;
    if (typeof d === 'string' && d.startsWith('0x')) return d;
    if (d && typeof d === 'object') {
        const aninhado = (d as { data?: unknown }).data;
        if (typeof aninhado === 'string' && aninhado.startsWith('0x')) return aninhado;
    }
    const naMensagem = /0x[0-9a-fA-F]{8,}/.exec(error.message ?? '');
    return naMensagem?.[0];
}

export type ResultadoDoEnsaio = { ok: true } | { ok: false; motivo: string };

/**
 * Executa a transação contra o estado ATUAL da rede sem enviá-la: `eth_call`
 * não gasta gás, não altera nada e devolve exatamente o que aconteceria.
 *
 * É o ensaio que separa "margem real" de "armadilha" de graça. Rodar isto
 * antes de cada envio é o que impede o motor de queimar gás repetidamente numa
 * oportunidade parada que nunca vai executar.
 */
export async function ensaiarExecucao(
    rpcUrl: string,
    contrato: string,
    dono: string,
    calldata: string,
): Promise<ResultadoDoEnsaio> {
    const resposta = await chamarRpc(rpcUrl, 'eth_call', [{ from: dono, to: contrato, data: calldata }, 'latest']);
    if (resposta.error) {
        return { ok: false, motivo: interpretarReversao(extrairDadoDeReversao(resposta.error)) };
    }
    return { ok: true };
}

/** `balanceOf(contrato)` de um token, em unidades cruas. */
export async function lerSaldoDoContrato(rpcUrl: string, token: string, contrato: string): Promise<bigint> {
    const data = FLASH_ARB_SELECTORS.balanceOf + encodeAddress(contrato);
    const resposta = await chamarRpc(rpcUrl, 'eth_call', [{ to: token, data }, 'latest']);
    if (resposta.error || typeof resposta.result !== 'string') return 0n;
    const hex = resposta.result;
    return hex === '0x' ? 0n : BigInt(hex);
}

/**
 * Envia a transação de verdade. Só é chamada depois de o ensaio passar.
 *
 * `ethers` entra por import dinâmico: a maior parte deste módulo é pura e roda
 * nos testes sem tocar em rede, e carregar a biblioteca inteira só para
 * planejar uma chamada ou interpretar um erro seria custo sem uso.
 */
export async function enviarExecucao(opcoes: {
    rpcUrl: string;
    chavePrivada: string;
    contrato: string;
    calldata: string;
    gasLimit?: bigint;
}): Promise<{ hash: string; sucesso: boolean; gasUsado: bigint }> {
    const { JsonRpcProvider, Wallet } = await import('ethers');
    const provider = new JsonRpcProvider(opcoes.rpcUrl);
    const carteira = new Wallet(opcoes.chavePrivada, provider);
    const tx = await carteira.sendTransaction({
        to: opcoes.contrato,
        data: opcoes.calldata,
        ...(opcoes.gasLimit ? { gasLimit: opcoes.gasLimit } : {}),
    });
    const recibo = await tx.wait();
    return { hash: tx.hash, sucesso: recibo?.status === 1, gasUsado: recibo?.gasUsed ?? 0n };
}
