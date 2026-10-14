/**
 * ENTREGA 2 — as regras do cacador continuo.
 *
 * O laco em si (`principal`) abre WebSocket e fala com a rede, entao nao e
 * importavel por teste: a prova dele e a execucao limitada
 * (`npm run arb:live`), e esta declarada como observacao, nao como teste.
 * O que se testa aqui sao as decisoes — e cada uma delas custou um defeito
 * real na ENTREGA 1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    montarCandidatos, decidir, melhorTamanho, quantosMudaram, comoLerARecusa,
    FABRICAS_COM_FLASH_SWAP, WETH_DA_BASE, GAS_DE_UMA_ARBITRAGEM, RESERVA_VENCE_EM_MS,
    type PoolDaFabrica,
} from './cacarArbitragem';
import { sobraDoFlashSwap, saidaCrua, entradaNecessariaCrua } from './ammMath';

const AGORA = 1_700_000_000_000;
const T = '0xaaaa000000000000000000000000000000000001';
const U = WETH_DA_BASE;

const pool = (
    endereco: string, fabrica: string, r0: bigint, r1: bigint,
    token0 = T, token1 = U,
): PoolDaFabrica => ({
    endereco, fabrica, token0, token1, reserva0: r0, reserva1: r1,
    lidoEm: AGORA, bloco: 52_600_000,
});

test('a aritmética crua espelha as duas linhas do contrato', () => {
    // `FlashArb._amountOut`: (amountIn*997*reserveOut)/(reserveIn*1000+amountIn*997)
    assert.equal(saidaCrua(1000n, 1_000_000n, 2_000_000n),
        (1000n * 997n * 2_000_000n) / (1_000_000n * 1000n + 1000n * 997n));
    // `FlashArb._amountIn`: (reserveIn*amountOut*1000)/((reserveOut-amountOut)*997)+1
    assert.equal(entradaNecessariaCrua(1000n, 1_000_000n, 2_000_000n),
        (1_000_000n * 1000n * 1000n) / ((2_000_000n - 1000n) * 997n) + 1n);
    // O `+1` ARREDONDA PARA CIMA, e é ele que faz o pagamento bastar. Sem o
    // arredondamento a avaliação aprova o que o pool recusa.
    const exato = (1_000_000n * 1000n * 1000n) / ((2_000_000n - 1000n) * 997n);
    assert.equal(entradaNecessariaCrua(1000n, 1_000_000n, 2_000_000n), exato + 1n);
    // Pool sem liquidez é `null`, NUNCA zero: zero diria "o swap rende nada".
    assert.equal(saidaCrua(1n, 0n, 1n), null);
    assert.equal(entradaNecessariaCrua(1n, 1n, 0n), null);
    // Pedir a reserva inteira não tem entrada finita.
    assert.equal(entradaNecessariaCrua(1_000n, 1n, 1_000n), null);
});

test('a sobra do flash swap sai no token DEVOLVIDO, e negativa é resposta', () => {
    // O defeito que custou uma reversão real em fork:
    // `LucroInsuficiente(232994792294, 109421743953172010)` — eu media o lucro
    // no token emprestado quando ele sobra no devolvido.
    const bom = sobraDoFlashSwap({
        quantia: 1_000n,
        vendaReservaT: 1_000_000n, vendaReservaU: 4_000_000n,
        emprestimoReservaU: 2_000_000n, emprestimoReservaT: 1_000_000n,
    });
    assert.ok(bom !== null);
    assert.equal(bom.sobra, bom.recebido - bom.devido);
    assert.ok(bom.sobra > 0n, 'preço melhor na venda tem de dar sobra');

    // Mesmos pools, preço IGUAL: a taxa dupla come tudo e a sobra é negativa.
    const ruim = sobraDoFlashSwap({
        quantia: 1_000n,
        vendaReservaT: 1_000_000n, vendaReservaU: 2_000_000n,
        emprestimoReservaU: 2_000_000n, emprestimoReservaT: 1_000_000n,
    });
    assert.ok(ruim !== null);
    assert.ok(ruim.sobra < 0n, 'sem diferença de preço, ida e volta PERDE — é a taxa');
});

test('o tamanho ótimo é buscado sobre a função que DECIDE', () => {
    const e = {
        vendaReservaT: 1_000_000_000n, vendaReservaU: 4_000_000_000n,
        emprestimoReservaU: 2_000_000_000n, emprestimoReservaT: 1_000_000_000n,
    };
    const m = melhorTamanho(e, e.emprestimoReservaT / 3n);
    assert.ok(m !== null);
    assert.ok(m.sobra > 0n);
    // É MÁXIMO: dobrar ou metade não melhora. Afirma a regra, não um literal —
    // o número muda com a reserva e um literal quebraria a cada remedição.
    for (const outra of [m.quantia / 2n, m.quantia * 2n, m.quantia + m.quantia / 10n]) {
        const r = sobraDoFlashSwap({ ...e, quantia: outra });
        if (r === null) continue;
        assert.ok(r.sobra <= m.sobra,
            `tamanho ${outra} rende ${r.sobra}, mais que o ótimo ${m.sobra}`);
    }
    assert.equal(melhorTamanho(e, 0n), null, 'teto zero não tem ótimo');
});

test('candidato exige DUAS fábricas: dentro de uma, o espaço é vazio', () => {
    // O ACHADO ESTRUTURAL da ENTREGA 1: uma fábrica V2 tem UM pool por par.
    // A primeira versão varreu 166 pools de UMA fábrica e achou "0
    // candidatos" — não era escassez econômica, era espaço de busca vazio.
    const a = FABRICAS_COM_FLASH_SWAP[0];
    const b = FABRICAS_COM_FLASH_SWAP[1];
    const mesmaFabrica = montarCandidatos([
        pool('0x01', a, 1_000_000n, 4_000_000n),
        pool('0x02', a, 1_000_000n, 2_000_000n),
    ]);
    assert.equal(mesmaFabrica.length, 0, 'montou candidato dentro da mesma fábrica');

    const cruzado = montarCandidatos([
        pool('0x01', a, 1_000_000n, 4_000_000n),
        pool('0x02', b, 1_000_000n, 2_000_000n),
    ]);
    assert.ok(cruzado.length > 0, 'não montou candidato entre fábricas diferentes');
    // E o mesmo pool nunca é as duas pernas: isso reverte com
    // `UniswapV2: LOCKED`, o guard de reentrância do pool — medido na ENTREGA 1.
    for (const c of cruzado) {
        assert.notEqual(c.emprestimo.endereco, c.venda.endereco);
        assert.notEqual(c.emprestimo.fabrica, c.venda.fabrica);
    }
    // Ordenado pela sobra: a melhor rota primeiro.
    for (let i = 1; i < cruzado.length; i += 1) {
        assert.ok(cruzado[i - 1]!.sobra >= cruzado[i]!.sobra);
    }
});

test('par em UM pool só não produz candidato', () => {
    assert.equal(montarCandidatos([pool('0x01', FABRICAS_COM_FLASH_SWAP[0], 1n, 2n)]).length, 0);
    assert.equal(montarCandidatos([]).length, 0);
});

test('a decisão RECUSA o que não paga o próprio gás, e diz o motivo', () => {
    // A exigência: *"Rejeição automática de operações sem margem suficiente."*
    // E o número vem da ENTREGA 1: sobra 0,000000233 WETH contra 0,00020332 ETH
    // de gás — executar aquilo era prejuízo, e a primeira versão PASSOU nele.
    const [c] = montarCandidatos([
        pool('0x01', FABRICAS_COM_FLASH_SWAP[0], 10n ** 18n, 4n * 10n ** 18n),
        pool('0x02', FABRICAS_COM_FLASH_SWAP[1], 10n ** 18n, 2n * 10n ** 18n),
    ]);
    assert.ok(c !== undefined && c.sobra > 0n);

    // Gás barato: aprova.
    const barato = decidir(c, 1n, AGORA);
    assert.equal(barato.aprovado, true);
    assert.equal(barato.motivo, null);
    assert.equal(barato.custoEmU, GAS_DE_UMA_ARBITRAGEM);
    assert.equal(barato.liquido, c.sobra - GAS_DE_UMA_ARBITRAGEM);

    // Gás caro: recusa, com motivo nomeado.
    const caro = decidir(c, c.sobra, AGORA);
    assert.equal(caro.aprovado, false);
    assert.equal(caro.motivo, 'naoPagaOGas');
    assert.ok(caro.liquido !== null && caro.liquido < 0n);
    assert.match(comoLerARecusa('naoPagaOGas'), /prejuízo/);
});

test('lucro em token sem conversão de gás NÃO é aprovável', () => {
    // Sem preço eu não sei converter o gás. Aprovar sem saber o custo é
    // fabricar o piso econômico — e o motivo sai dito, não escondido.
    const outro = '0xbbbb000000000000000000000000000000000002';
    const [c] = montarCandidatos([
        pool('0x01', FABRICAS_COM_FLASH_SWAP[0], 10n ** 18n, 4n * 10n ** 18n, T, outro),
        pool('0x02', FABRICAS_COM_FLASH_SWAP[1], 10n ** 18n, 2n * 10n ** 18n, T, outro),
    ].filter((x) => x.token1 === outro));
    assert.ok(c !== undefined);
    const d = decidir(c, 1n, AGORA);
    assert.equal(d.aprovado, false);
    assert.equal(d.motivo, 'gasDesconhecido');
    assert.equal(d.custoEmU, null, 'custo desconhecido é null, não zero');
    assert.equal(d.liquido, null);
    assert.match(comoLerARecusa('gasDesconhecido'), /NÃO sei converter o gás/);
});

test('reserva VENCIDA não decide: estado velho aprova o que a cadeia já mudou', () => {
    const [c] = montarCandidatos([
        pool('0x01', FABRICAS_COM_FLASH_SWAP[0], 10n ** 18n, 4n * 10n ** 18n),
        pool('0x02', FABRICAS_COM_FLASH_SWAP[1], 10n ** 18n, 2n * 10n ** 18n),
    ]);
    assert.ok(c !== undefined);
    // No limite ainda vale; passando dele, não.
    assert.equal(decidir(c, 1n, AGORA + RESERVA_VENCE_EM_MS).aprovado, true);
    const velha = decidir(c, 1n, AGORA + RESERVA_VENCE_EM_MS + 1);
    assert.equal(velha.aprovado, false);
    assert.equal(velha.motivo, 'reservaVelha');
});

test('sobra zero ou negativa recusa com `semSobra`, nunca com `naoPagaOGas`', () => {
    // Os dois motivos pedem leituras OPOSTAS: `semSobra` diz que não há ciclo
    // em tamanho nenhum; `naoPagaOGas` diz que há ciclo e ele é magro.
    const c = {
        emprestimo: pool('0x01', FABRICAS_COM_FLASH_SWAP[0], 1n, 1n),
        venda: pool('0x02', FABRICAS_COM_FLASH_SWAP[1], 1n, 1n),
        T, U, quantia: 1n, recebido: 1n, devido: 2n, sobra: -1n,
    };
    const d = decidir(c, 1n, AGORA);
    assert.equal(d.motivo, 'semSobra');
    assert.match(comoLerARecusa('semSobra'), /não há ciclo/);
    assert.equal(decidir({ ...c, sobra: 0n }, 1n, AGORA).motivo, 'semSobra');
});

test('conta quantas reservas MUDARAM, e primeira volta não é mudança', () => {
    const antes = new Map<string, PoolDaFabrica>();
    const agora = [
        pool('0x01', FABRICAS_COM_FLASH_SWAP[0], 10n, 20n),
        pool('0x02', FABRICAS_COM_FLASH_SWAP[1], 30n, 40n),
    ];
    // Sem memória, tudo conta como novo — e é o chamador que diz "primeira
    // volta" no log, em vez de o número mentir.
    assert.equal(quantosMudaram(antes, agora), 2);
    for (const p of agora) antes.set(p.endereco, p);
    assert.equal(quantosMudaram(antes, agora), 0, 'sem mudança tem de dar zero');
    assert.equal(quantosMudaram(antes, [{ ...agora[0]!, reserva1: 21n }, agora[1]!]), 1);
});

test('as quatro fábricas são as MEDIDAS, e o laço não inventa uma quinta', () => {
    // Pancake e BaseSwap têm `swap` e `getReserves` mas NÃO `uniswapV2Call`:
    // este contrato não as atende, e incluí-las produziria reversão paga.
    assert.equal(FABRICAS_COM_FLASH_SWAP.length, 4);
    for (const f of FABRICAS_COM_FLASH_SWAP) {
        assert.match(f, /^0x[0-9a-f]{40}$/, 'endereço fora do formato ou não minúsculo');
    }
    assert.equal(new Set(FABRICAS_COM_FLASH_SWAP).size, 4, 'fábrica repetida');
});
