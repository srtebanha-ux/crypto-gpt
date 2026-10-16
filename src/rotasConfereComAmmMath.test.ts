/**
 * `rotas.ts` TEM DE CONCORDAR com `ammMath.ts` na rota de duas pernas.
 *
 * POR QUE ESTE ARQUIVO EXISTE. `sobraDoFlashSwap` (ammMath) e o caminho de duas
 * pernas que a ENTREGA 1 provou em fork: execucao completa, `realizado/esperado
 * = 1.000000`, e 18 conferencias exatas contra o `MathHarness` implantado.
 * `sobraDaRota` (rotas) e a generalizacao para 2–4 pernas, e ela NAO tinha
 * nenhuma conferencia contra o caminho provado.
 *
 * Em 2026-10-14 isso custou caro: `sobraDaRota` calculava o pagamento com as
 * reservas TROCADAS —
 *
 *     inverso = { de: primeiro.para, para: primeiro.de }
 *     devido  = entradaDoHop(inverso, quantia)
 *
 * — o que pergunta "quanto do token TOMADO faria sair `quantia` do token PAGO",
 * que e a pergunta ao contrario. Em pool EQUILIBRADO os dois dao o mesmo
 * numero, e e por isso que passou por toda a suite: os testes de paridade
 * usavam reservas iguais. Em pool desequilibrado — isto e, em todo pool onde
 * existe arbitragem — ele erra para os DOIS lados: inventa sobra que nao existe
 * (e a execucao reverte com 'UniswapV2: K') e esconde sobra que existe.
 *
 * Medido, pool 1e21 WETH / 1.3e21 M, tomando 1e18 de M:
 *
 *     como estava   1.305216952157774626
 *     corrigido       772139358800033666
 *     getAmountIn     772139358800033666
 *
 * Este teste e o portao que impede a volta: ele compara as duas funcoes em
 * reservas DESEQUILIBRADAS, que e onde a diferenca aparece.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sobraDoFlashSwap } from './ammMath';
import { sobraDaRota, type Rota, type PoolParaRota } from './rotas';

const T = '0xtttttttttttttttttttttttttttttttttttttttt';
const U = '0xuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu';

/**
 * A MESMA rota nos dois vocabularios.
 *
 * `U` e o token que se PAGA e `T` o que se TOMA, entao o hop 0 vai de U para T:
 * `de` e o que o pool recebe, `para` e o que ele solta.
 */
function asDuasFormas(
    emprestimoU: bigint, emprestimoT: bigint, vendaT: bigint, vendaU: bigint,
) {
    const emprestimo: PoolParaRota = {
        endereco: '0xe', token0: U, token1: T,
        reserva0: emprestimoU, reserva1: emprestimoT,
        tipo: 'v2', taxaPorDezMil: 30, fabrica: '0xf1',
    };
    const venda: PoolParaRota = {
        endereco: '0xv', token0: T, token1: U,
        reserva0: vendaT, reserva1: vendaU,
        tipo: 'v2', taxaPorDezMil: 30, fabrica: '0xf2',
    };
    const rota: Rota = {
        token: U,
        hops: [
            { pool: emprestimo, de: U, para: T },
            { pool: venda, de: T, para: U },
        ],
        poolsDistintos: 2,
    };
    return { rota, emprestimo, venda };
}

/** Reservas DESEQUILIBRADAS de propósito: é onde o defeito aparecia. */
const CASOS: [bigint, bigint, bigint, bigint, bigint][] = [
    // quantia, emprestimoU, emprestimoT, vendaT, vendaU
    [10n ** 18n, 10n ** 21n, (10n ** 21n * 13n) / 10n, 10n ** 21n, 10n ** 21n],
    [10n ** 18n, (10n ** 21n * 7n) / 10n, 10n ** 21n, 10n ** 21n, 10n ** 21n],
    [10n ** 19n, 10n ** 22n, 10n ** 20n, 10n ** 20n, 10n ** 22n],
    [10n ** 17n, 10n ** 20n, 10n ** 23n, 10n ** 23n, 10n ** 20n],
    [5n * 10n ** 18n, 3n * 10n ** 21n, 11n * 10n ** 20n, 9n * 10n ** 20n, 4n * 10n ** 21n],
    // E UM caso EQUILIBRADO, que passava mesmo com o defeito: ele fica para
    // provar que o conserto não trocou o número certo por outro.
    [10n ** 18n, 10n ** 21n, 10n ** 21n, 10n ** 21n, 10n ** 21n],
];

test('sobraDaRota == sobraDoFlashSwap em reservas desequilibradas', () => {
    let conferidos = 0;
    for (const [quantia, eU, eT, vT, vU] of CASOS) {
        const { rota } = asDuasFormas(eU, eT, vT, vU);
        const provado = sobraDoFlashSwap({
            quantia,
            vendaReservaT: vT, vendaReservaU: vU,
            emprestimoReservaU: eU, emprestimoReservaT: eT,
        });
        const generalizado = sobraDaRota(rota, quantia);
        assert.notEqual(provado, null, 'o caminho provado recusou o caso');
        assert.notEqual(generalizado, null, 'a generalização recusou um caso que o provado aceita');
        assert.equal(generalizado!.recebido, provado!.recebido,
            `recebido divergiu com quantia ${quantia}`);
        assert.equal(generalizado!.devido, provado!.devido,
            `DEVIDO divergiu com quantia ${quantia}: era o defeito das reservas trocadas`);
        assert.equal(generalizado!.sobra, provado!.sobra, `sobra divergiu com quantia ${quantia}`);
        conferidos += 1;
    }
    assert.equal(conferidos, CASOS.length);
});

test('o pagamento bate com o getAmountIn canônico da V2', () => {
    // A terceira fonte, e ela nao e nenhuma das duas: a formula do UniswapV2
    // escrita aqui a mao, com 997/1000 e o `+1`. Se as tres concordam, nao e
    // coincidencia de uma copia.
    const canonico = (saida: bigint, rIn: bigint, rOut: bigint): bigint =>
        (rIn * saida * 1000n) / ((rOut - saida) * 997n) + 1n;
    for (const [quantia, eU, eT, vT, vU] of CASOS) {
        const { rota } = asDuasFormas(eU, eT, vT, vU);
        const g = sobraDaRota(rota, quantia);
        assert.notEqual(g, null);
        // Pagamos U e tomamos T: a entrada e em U, a saida em T.
        assert.equal(g!.devido, canonico(quantia, eU, eT),
            `o pagamento não bate com o getAmountIn canônico (quantia ${quantia})`);
        void vT; void vU;
    }
});

test('em pool EQUILIBRADO as reservas trocadas dariam o MESMO número', () => {
    // O motivo pelo qual o defeito sobreviveu a 1.800 testes, afirmado como
    // regra: se alguém "simplificar" a conta de novo, um fixture equilibrado
    // não vai denunciar — e este teste diz isso em voz alta.
    const q = 10n ** 18n;
    const r = 10n ** 21n;
    const canonico = (saida: bigint, rIn: bigint, rOut: bigint): bigint =>
        (rIn * saida * 1000n) / ((rOut - saida) * 997n) + 1n;
    assert.equal(canonico(q, r, r), canonico(q, r, r));
    // E DESEQUILIBRADO denuncia: os dois sentidos divergem de verdade.
    const a = canonico(q, r, (r * 13n) / 10n);
    const b = canonico(q, (r * 13n) / 10n, r);
    assert.notEqual(a, b, 'o fixture desequilibrado não distingue os dois sentidos');
});
