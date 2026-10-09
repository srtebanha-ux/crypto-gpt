// Arquivo: src/caca.ts
import { Interface, id } from 'ethers';

// Interface do Contrato V1 (usa o endereço da pool de venda diretamente)
const cacadorV1Interface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)'
]);

// Interface do Contrato V2 (usa o booleano de pool estável/volátil)
const cacadorV2Interface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, bool isStablePool, uint256 minProfit)'
]);

/** keccak('LucroInsuficiente(uint256,uint256)') nos 4 primeiros bytes. */
export const SELETOR_LUCRO_INSUFICIENTE = id('LucroInsuficiente(uint256,uint256)').slice(0, 10);

export const PISO_IMPOSSIVEL = 99999999999999999999999999999999999999999999n;
export const COBRIR_O_MAXIMO = PISO_IMPOSSIVEL;

/**
 * O PISO DE LUCRO EXIGIDO NO CONTRATO, em centesimos de por cento da divida
 * coberta — a ultima linha de defesa, a que nao depende de nenhuma conta minha.
 *
 * POR QUE ELE EXISTE, e e um defeito MEDIDO nas 39 transacoes de 07-08/10:
 * **todas sairam com `minProfit = 0`.** O `input` de cada uma foi decodificado
 * com a interface deste arquivo e o sexto argumento era zero nas 39.
 *
 * A causa: `piso = lucroCru * 80 / 100`, e no tiro ESPECULATIVO a medicao por
 * `eth_call` reverte por construcao (a Aave recusa posicao sadia), entao
 * `lucroCru` e `0n` e o piso tambem. Ou seja: no unico caminho que manda
 * dinheiro as cegas, o portao de "resultado minimo verificavel no contrato"
 * estava DESLIGADO. Se alguma daquelas 39 tivesse cruzado, o contrato teria
 * aceitado executar com lucro zero — pagando gas, vendendo garantia e
 * devolvendo o emprestimo para ficar com nada.
 *
 * 150 centesimos (1,5%) nao e numero escolhido no ar. O bonus REALIZADO medido
 * no alvo real da Aave de 2026-10-07 (`0x6b950f30`, US$ 49,33 sobre US$ 1.081,95
 * cobertos) foi **4,56%**, e `CUSTO_DA_VENDA` medido no pool da Aerodrome e
 * 0,59% — sobra ~3,9%. 1,5% fica MUITO abaixo do que um acerto legitimo
 * entrega (nao barra o ganho) e MUITO acima de zero (barra a execucao que nao
 * paga nada). A unidade fecha sozinha: `lucro` no contrato e
 * `emCaixa - aDevolver` no ativo da DIVIDA, e `debtToCover` e no mesmo ativo.
 */
export const PISO_NO_CONTRATO_BPS = 150n;

/**
 * O piso que vai NO ENVIO. `null` em `lucroMedidoCru` quer dizer "a medicao
 * nao produziu numero" — que e o caso do tiro especulativo — e ai o piso sai da
 * divida coberta, nunca de zero.
 *
 * Com medicao: 80% dela, como sempre foi. Mas nunca MENOS que o piso da
 * cobertura: uma medicao de centavos num alvo grande nao autoriza executar de
 * graca.
 */
export function pisoNoContrato(quantoCobrir: bigint, lucroMedidoCru: bigint | null): bigint {
    const daCobertura = quantoCobrir > 0n ? (quantoCobrir * PISO_NO_CONTRATO_BPS) / 10_000n : 0n;
    if (lucroMedidoCru === null || lucroMedidoCru <= 0n) return daCobertura;
    const daMedicao = (lucroMedidoCru * 80n) / 100n;
    return daMedicao > daCobertura ? daMedicao : daCobertura;
}

export function codificarCacaV1(alvo: {
    garantia: string;
    divida: string;
    devedor: string;
    quantoCobrir: bigint;
    poolDeVenda: string;
    lucroMinimo: bigint;
}): string {
    return cacadorV1Interface.encodeFunctionData('cacar', [
        alvo.garantia,
        alvo.divida,
        alvo.devedor,
        alvo.quantoCobrir,
        alvo.poolDeVenda,
        alvo.lucroMinimo,
    ]);
}

export function codificarCacaV2(alvo: {
    garantia: string;
    divida: string;
    devedor: string;
    quantoCobrir: bigint;
    isStablePool: boolean;
    lucroMinimo: bigint;
}): string {
    return cacadorV2Interface.encodeFunctionData('cacar', [
        alvo.garantia,
        alvo.divida,
        alvo.devedor,
        alvo.quantoCobrir,
        alvo.isStablePool,
        alvo.lucroMinimo,
    ]);
}

export function lerRespostaDaCaca(r: { ok: boolean; dados: string; mensagem?: string }): {
    desfecho: 'mediu' | 'revertido' | 'falhaDeRede';
    lucroCru?: bigint;
    erro?: string;
    /** Os bytes crus da reversao. E ai que mora a IDENTIDADE do erro. */
    dadosCrus?: string;
} {
    if (!r.ok) {
        if (r.dados && r.dados !== '0x') {
            // A reversao do piso NAO e uma falha: e a medicao.
            //
            // `cacar` reverte com `LucroInsuficiente(obtido, exigido)`, e esse
            // erro CARREGA o lucro que teria saido. Mandar piso impossivel de
            // proposito faz o contrato executar a caçada inteira contra a Aave
            // de verdade e o pool de verdade, e devolver quanto renderia — sem
            // gas, sem transacao, com numero da rede.
            //
            // Sem decodificar isto, toda medicao cai em "revertido" com uma
            // mensagem generica, e o unico jeito de saber quanto uma caçada
            // rende passa a ser enviar dinheiro de verdade.
            if (r.dados.startsWith(SELETOR_LUCRO_INSUFICIENTE) && r.dados.length >= 10 + 128) {
                try {
                    const obtido = BigInt('0x' + r.dados.slice(10, 74));
                    return { desfecho: 'mediu', lucroCru: obtido };
                } catch {}
            }
            try {
                if (r.dados.startsWith('0x08c379a0')) {
                    const decoded = '0x' + r.dados.substring(138);
                    const motivo = Buffer.from(decoded.replace(/^0x/, ''), 'hex').toString('utf8').replace(/\0/g, '').trim();
                    return { desfecho: 'revertido', erro: motivo || 'revertido sem mensagem', dadosCrus: r.dados };
                }
            } catch {}
            // Os DADOS vao junto, e nao so a prosa.
            //
            // A identidade do erro mora no seletor, nunca na mensagem. Medido
            // contra o contrato V1 na Base em 2026-09-28: o RPC devolve
            // `message: "execution reverted"`, sem motivo nenhum, e
            // `data: "0x930bb771"` — que e `HealthFactorNotBelowThreshold()`,
            // exatamente a recusa que o tiro antes do cruzamento precisa
            // reconhecer.
            //
            // Jogar `dados` fora aqui obrigava `naoCruzouAinda` a decidir pela
            // prosa, e toda prosa construida nesta funcao contem a palavra
            // "revert" — ate a literal 'revertido sem mensagem'. O portao que
            // autoriza mandar dinheiro de verdade virava sempre-verdadeiro.
            return { desfecho: 'revertido', erro: r.mensagem ?? 'revertido', dadosCrus: r.dados };
        }
        return { desfecho: 'falhaDeRede', erro: r.mensagem ?? 'erro de rede' };
    }

    try {
        if (r.dados === '0x' || r.dados.length < 130) {
            return { desfecho: 'mediu', lucroCru: 0n };
        }
        const valor = BigInt('0x' + r.dados.slice(2));
        return { desfecho: 'mediu', lucroCru: valor };
    } catch {
        return { desfecho: 'mediu', lucroCru: 0n };
    }
}

export function isDevedorIgnorado(devedor: string): boolean {
    const ignorados = new Set<string>([
        // Lista de devedores "zumbis" ou com posições poeira impossíveis de liquidar
        '0xf20e421cf0b314d61177466d3c9c0cb5e1342ecb',
    ]);
    return ignorados.has(devedor.toLowerCase());
}

// ---------------------------------------------------------------------------
// Conferir o cofre de um caçador ANTES de mandar ele caçar.
// ---------------------------------------------------------------------------

export const SELETOR_COFRE = id('cofre()').slice(0, 10);
export const SELETOR_DONO = id('dono()').slice(0, 10);

/**
 * Para onde o lucro TEM que ir.
 *
 * Imutável no contrato: não existe função para trocar. É o que faz uma chave
 * roubada do Railway poder queimar gás, mas nunca redirecionar dinheiro.
 */
export const COFRE_ESPERADO = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';

export type VeredictoDoCofre = 'aprovado' | 'reprovado' | 'inconclusivo';

export interface LaudoDoCofre {
    veredicto: VeredictoDoCofre;
    /** Em português, o que foi encontrado. Vai para o log e para o humano. */
    porque: string;
}

/**
 * Julga um caçador publicado pelo que ELE responde, não pelo que a gente acha.
 *
 * Existe porque conferir isso na mão, uma vez, numa tela, não é conferir: é
 * lembrar. O contrato 0xd87AeE… rodou dias mandando lucro para o dono — a
 * carteira quente cuja chave mora no Railway — e ninguém viu, porque ele nunca
 * ganhou nada. A checagem só vale se acontecer sozinha, todo boot.
 *
 * `null` nunca vira aprovação. Chamada que falhou, endereço sem código, e
 * resposta que não é endereço: tudo isso e INCONCLUSIVO, e inconclusivo não
 * caça com dinheiro real. Aprovar no escuro e o defeito que este projeto mais
 * encontrou.
 */
export function julgarCofre(
    lido: { cofre: string | null; dono: string | null },
    cofreEsperado: string = COFRE_ESPERADO,
): LaudoDoCofre {
    if (lido.cofre === null) {
        return { veredicto: 'inconclusivo', porque: 'não consegui ler cofre() — pode não ser um contrato, ou a rede falhou' };
    }
    const cofre = lido.cofre.toLowerCase();
    const esperado = cofreEsperado.toLowerCase();
    if (lido.dono !== null && cofre === lido.dono.toLowerCase()) {
        return { veredicto: 'reprovado', porque: `o cofre é o PRÓPRIO DONO (${lido.dono}) — o lucro cairia na carteira quente` };
    }
    if (cofre !== esperado) {
        return { veredicto: 'reprovado', porque: `cofre() devolveu ${lido.cofre}, e o esperado é ${cofreEsperado}` };
    }
    return { veredicto: 'aprovado', porque: `cofre() = ${cofreEsperado}` };
}

/** Só 'aprovado' pode gastar dinheiro. Inconclusivo NÃO é permissão. */
export function podeCacarComDinheiroReal(laudo: LaudoDoCofre): boolean {
    return laudo.veredicto === 'aprovado';
}
