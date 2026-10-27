/**
 * O CUSTO DE UMA OPERACAO NA BASE, com os componentes separados.
 *
 * A dona do bot corrigiu: *"O custo da Base não é somente baseFee."* Esta
 * certo, e o erro tinha consequencia: a decisao da ENTREGA 2 usava
 * `baseFee + gorjeta` e ignorava o dado L1 inteiro.
 *
 * E a regra que decide o desenho e dela: *"Se algum componente não for
 * conhecido, não classifique a oportunidade como lucrativa."* Entao cada
 * componente e `bigint` OU `null`, e UM `null` em qualquer um torna o total
 * `null` — nao zero. Somar zero por um componente desconhecido e exatamente a
 * ausencia com cara de resposta que este projeto persegue.
 *
 * O QUE JA ESTAVA MEDIDO NESTE PROJETO e nao se remede aqui (CLAUDE.md,
 * 2026-10-10): o predeploy `0x420…000F` responde `getL1Fee(bytes)` alimentado
 * com a transacao SERIALIZADA — nao com o calldata, e essa distincao custou uma
 * correcao: 196 bytes de calldata davam 1.754 de gas L1 contra 2.370 da
 * serializada, 1,35x. Para o tiro da Aave o L1 ficou abaixo de 0,11% do total.
 * Isso NAO autoriza ignora-lo aqui: 0,11% de um premio de centavos decide.
 */
import Decimal from 'decimal.js';
import { id, Transaction } from 'ethers';

/** O oraculo de gas da OP Stack. Predeploy: o endereco e parte da rede. */
export const ORACULO_DE_GAS_L1 = '0x420000000000000000000000000000000000000F';

/**
 * A GORJETA, em wei por unidade de gas.
 *
 * ESCOLHA declarada. Este projeto mediu, em 15 blocos da Base com cobertura
 * 100%, que as seis primeiras posicoes de um bloco pagam p50 0,0150 gwei e p90
 * 0,1366 gwei. 0,02 gwei fica acima do p50 do campo e abaixo do p90 — e a
 * arbitragem nao precisa do topo da fatia para existir, so precisa entrar.
 *
 * `ARB_GORJETA_WEI` manda quando definida.
 */
export const GORJETA_PADRAO_WEI = BigInt(process.env.ARB_GORJETA_WEI ?? 20_000_000);

/**
 * A MARGEM DE SEGURANCA sobre o lucro bruto, em por mil.
 *
 * Existe porque entre a decisao e a inclusao o estado muda: outra transacao no
 * mesmo bloco move a reserva e a sobra encolhe. Medido neste projeto na
 * ENTREGA 1: a razao realizado/esperado deu 1.000000 num fork estatico — e
 * fork estatico nao tem concorrencia. A margem e o preco de nao saber isso.
 *
 * 50/1000 = 5%. ESCOLHA, nao medicao, e marcada como tal.
 */
export const MARGEM_DE_SEGURANCA_POR_MIL = BigInt(process.env.ARB_MARGEM_POR_MIL ?? 50);

export interface ComponentesDoCusto {
    /** Gas consumido. MEDIDO quando vem de recibo; estimado antes disso. */
    gasUsado: bigint | null;
    /** De onde veio o `gasUsado`: recibo da execucao ou estimativa. */
    gasUsadoVeioDe: 'recibo' | 'estimativa' | 'desconhecido';
    /** baseFee por gas do bloco. */
    baseFeeWei: bigint | null;
    /** Gorjeta por gas que esta operacao supoe pagar. */
    gorjetaWei: bigint | null;
    /** O custo do dado L1, em wei, para ESTA transacao serializada. */
    custoL1Wei: bigint | null;
    /**
     * Taxa do emprestimo, em wei do token do ciclo.
     *
     * ZERO e resposta aqui, nao ausencia: o flash swap V2 nao cobra taxa
     * separada — a taxa do pool ja esta embutida nas pernas. Aave V3 cobraria
     * 0,05%, e por isso o campo existe em vez de a conta supor zero.
     */
    taxaDoEmprestimoWei: bigint | null;
}

export interface CustoTotal {
    /** `null` quando QUALQUER componente e desconhecido. */
    totalWei: bigint | null;
    /** O que falta para o total ser conhecido. Vazio quando esta completo. */
    faltam: string[];
    /** A conta, para quem le poder discordar dela. */
    comoLer: string;
}

/**
 * Soma os componentes. UM desconhecido torna o total desconhecido.
 *
 * E ESTE o portao que ela pediu: sem total conhecido, nada pode ser
 * classificado como lucrativo.
 */
export function somarCusto(c: ComponentesDoCusto): CustoTotal {
    const faltam: string[] = [];
    if (c.gasUsado === null) faltam.push('gasUsado');
    if (c.gasUsadoVeioDe === 'desconhecido') faltam.push('origem do gasUsado');
    if (c.baseFeeWei === null) faltam.push('baseFee L2');
    if (c.gorjetaWei === null) faltam.push('gorjeta');
    if (c.custoL1Wei === null) faltam.push('custo de dados L1');
    if (c.taxaDoEmprestimoWei === null) faltam.push('taxa do empréstimo');
    // COMPONENTE NEGATIVO NAO ENCOLHE O CUSTO.
    //
    // O portao olhava so `=== null`. Um `baseFeeWei` negativo passava e a
    // multiplicacao ENCOLHIA o total — subestimar custo e o lado perigoso de
    // errar, e foi uma subtracao de gorjeta (hoje removida) que podia produzir
    // esse negativo. Nenhum destes numeros tem significado negativo: gas
    // consumido, preco por gas, taxa. Negativo e defeito de quem chamou, nao
    // medicao, e vira DESCONHECIDO em vez de desconto.
    const negativos = ([
        ['gasUsado', c.gasUsado],
        ['baseFee L2', c.baseFeeWei],
        ['gorjeta', c.gorjetaWei],
        ['custo de dados L1', c.custoL1Wei],
        ['taxa do empréstimo', c.taxaDoEmprestimoWei],
    ] as Array<[string, bigint | null]>).filter(([, v]) => v !== null && v < 0n);
    for (const [nome] of negativos) faltam.push(`${nome} NEGATIVO (não é custo)`);
    if (faltam.length > 0) {
        return {
            totalWei: null,
            faltam,
            comoLer: `custo DESCONHECIDO: falta ${faltam.join(', ')}. Sem total conhecido nada é `
                + 'classificado como lucrativo',
        };
    }
    const l2 = c.gasUsado! * (c.baseFeeWei! + c.gorjetaWei!);
    const total = l2 + c.custoL1Wei! + c.taxaDoEmprestimoWei!;
    const pct = (v: bigint): string => (total > 0n
        ? `${new Decimal(v.toString()).div(new Decimal(total.toString())).mul(100).toFixed(2)}%`
        : '—');
    return {
        totalWei: total,
        faltam: [],
        comoLer: `L2 ${l2} (${c.gasUsado} gas × ${c.baseFeeWei}+${c.gorjetaWei}, ${pct(l2)}) + `
            + `L1 ${c.custoL1Wei} (${pct(c.custoL1Wei!)}) + empréstimo ${c.taxaDoEmprestimoWei}`
            + ` = ${total} wei | gasUsado de ${c.gasUsadoVeioDe}`,
    };
}

/**
 * O piso de lucro BRUTO para a operacao valer, com a margem de seguranca.
 *
 * `null` quando o custo e desconhecido — e aí nao existe piso, existe recusa.
 */
export function pisoDeLucro(custo: CustoTotal): bigint | null {
    if (custo.totalWei === null) return null;
    return custo.totalWei + (custo.totalWei * MARGEM_DE_SEGURANCA_POR_MIL) / 1000n;
}

export type Veredicto = 'lucrativa' | 'deficitaria' | 'custoDesconhecido';

export interface JulgamentoEconomico {
    veredicto: Veredicto;
    /** Lucro bruto menos custo total. `null` quando o custo e desconhecido. */
    liquidoWei: bigint | null;
    pisoWei: bigint | null;
    porque: string;
}

/**
 * O julgamento final, e so ele pode dizer "lucrativa".
 *
 * `lucroBrutoWei` e a sobra da rota ANTES de custo, em wei do token do ciclo —
 * e o ciclo tem de terminar no token em que o custo esta medido (o nativo
 * embrulhado), senao comparar as duas grandezas e somar unidades diferentes.
 */
export function julgar(lucroBrutoWei: bigint, custo: CustoTotal): JulgamentoEconomico {
    const piso = pisoDeLucro(custo);
    if (piso === null || custo.totalWei === null) {
        return {
            veredicto: 'custoDesconhecido',
            liquidoWei: null,
            pisoWei: null,
            porque: custo.comoLer,
        };
    }
    const liquido = lucroBrutoWei - custo.totalWei;
    if (lucroBrutoWei < piso) {
        return {
            veredicto: 'deficitaria',
            liquidoWei: liquido,
            pisoWei: piso,
            porque: `bruto ${lucroBrutoWei} não alcança o piso ${piso} `
                + `(custo ${custo.totalWei} + ${MARGEM_DE_SEGURANCA_POR_MIL}/1000 de margem). `
                + `Líquido ${liquido}`,
        };
    }
    return {
        veredicto: 'lucrativa',
        liquidoWei: liquido,
        pisoWei: piso,
        porque: `bruto ${lucroBrutoWei} passa o piso ${piso}: líquido ${liquido} wei. `
            + custo.comoLer,
    };
}

/**
 * O calldata de `getL1Fee(bytes)` para uma transacao SERIALIZADA SEM ASSINATURA.
 *
 * GasPriceOracle recebe RLP nao assinado; no Fjord acrescenta 68 bytes para
 * estimar a assinatura. Passar a transacao assinada contabiliza essa parcela
 * duas vezes. A estimativa deve usar o envelope real, nao apenas calldata.
 * Fonte: optimism/packages/contracts-bedrock/src/L2/GasPriceOracle.sol.
 */
export function codificarGetL1Fee(txSerializada: string): string {
    const tx = Transaction.from(txSerializada);
    if (tx.isSigned() || tx.unsignedSerialized.toLowerCase() !== txSerializada.toLowerCase()) {
        throw new Error('getL1Fee exige transacao RLP canonica sem assinatura.');
    }
    const sem0x = tx.unsignedSerialized.slice(2);
    const bytes = sem0x.length / 2;
    const corpo = sem0x + '0'.repeat((32 - (bytes % 32)) % 32 * 2);
    // O SELETOR E DERIVADO, nao lembrado. Eu o escrevi de cabeca na primeira
    // versao e acertei — e acertar de cabeca nao e metodo: e o defeito do
    // `0x80d1e0f4…` que a REGRA 0 registra, esperando a vez de errar.
    // Conferido na corrente: 0x49948e0e, e `getL1Fee` de uma transacao de 242
    // bytes devolveu 1.337.035.464 wei.
    return id('getL1Fee(bytes)').slice(0, 10)
        + '0000000000000000000000000000000000000000000000000000000000000020'
        + bytes.toString(16).padStart(64, '0')
        + corpo;
}

/**
 * O TETO do custo L1, pelo `getL1FeeUpperBound` do PROPRIO oraculo.
 *
 * DEFEITO QUE ISTO CONSERTA, apontado por ela: os testes alimentavam
 * `getL1Fee(bytes)` com `'02'.repeat(N)` — BYTES FICTICIOS — e publicavam o
 * resultado como custo exato. O custo L1 depende do CONTEUDO (byte zero e byte
 * nao-zero tem pesos diferentes), entao um numero tirado de bytes inventados
 * nao e medicao de nada.
 *
 * `getL1FeeUpperBound(uint256)` recebe o TAMANHO da transacao nao assinada e
 * devolve um TETO — e teto declarado e honesto, ao contrario de uma exatidao
 * fabricada. Conferido na corrente em 2026-10-10: para 310 bytes devolveu
 * US$ 0,00000444.
 *
 * `bytesDoCalldata` e o tamanho REAL do calldata que vai na transacao. O resto
 * e o envelope (nonce, gas, to, value, assinatura, RLP), e 160 bytes cobre
 * folgado uma transacao tipo 2 — a direcao do erro e para CIMA, que e o lado
 * seguro de um teto.
 */
export const ENVELOPE_DE_TRANSACAO_BYTES = 160;

export function codificarTetoDeL1(bytesDoCalldata: number): string {
    const tamanho = BigInt(bytesDoCalldata + ENVELOPE_DE_TRANSACAO_BYTES);
    return id('getL1FeeUpperBound(uint256)').slice(0, 10)
        + tamanho.toString(16).padStart(64, '0');
}
