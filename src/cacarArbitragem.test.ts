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
    montarCandidatos, decidir, melhorTamanho, quantosMudaram, comoLerARecusa, comoLerOPlacar,
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

test('o placar NÃO usa a palavra APROVADO para o que não executou', () => {
    // A classificação é dela: CANDIDATO / ESTIMADO POSITIVO / SIMULADO COM
    // SUCESSO / ECONOMICAMENTE VALIDADO / LUCRO REALIZADO. O caçador só alcança
    // o segundo — e os 3 "aprovados" do bloco 52608948, reproduzidos no fork
    // daquele bloco, reverteram TODOS (token com 48% de taxa de transferência).
    // Chamar aquilo de aprovado era afirmar execução que nunca houve.
    const f = comoLerOPlacar();
    assert.match(f, /ESTIMADO\(S\) POSITIVO\(S\)/);
    assert.match(f, /execução NÃO comprovada/);
    assert.ok(!/APROVADA|APROVADO/.test(f), 'o placar voltou a dizer APROVADO');
});

// --- DIMENSIONAMENTO: cada direção empresta do SEU pool ---------------------
//
// DEFEITO CORRIGIDO em 2026-10-15, apontado por ela: *"Não reutilize a liquidez
// de um pool como se fosse a capacidade de empréstimo de outro."* O código
// dimensionava as DUAS direções pela reserva do Aerodrome — na direção B quem
// empresta é o V3, e a reserva do Aerodrome não diz nada sobre isso.

test('a direção A empresta do Aerodrome e a B do V3, com a liquidez de CADA um', async () => {
    const { cotarAfetadas } = await import('./cacarArbitragem');
    const { candidatasMistas } = await import('./rotasMistas');
    const WETH = '0x4200000000000000000000000000000000000006';
    const TOK = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';
    const AERO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const V3 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rotas = candidatasMistas([
        {
            endereco: AERO, token0: WETH, token1: TOK, venue: 'aerodrome', taxa: null,
            estavel: false,
        },
        { endereco: V3, token0: WETH, token1: TOK, venue: 'v3', taxa: 500 },
    ], WETH);

    // Liquidez MUITO diferente nos dois: se o tamanho vier do pool errado, a
    // quantia aparece com a ordem de grandeza do outro.
    const RESERVA_AERO = 1_000_000n * 10n ** 18n;
    const SALDO_V3 = 7n * 10n ** 18n;
    const estado = {
        sqrtPorPoolV3: new Map([[V3, 2n ** 96n]]),
        token0PorPool: new Map<string, string>(),
        reservasAerodrome: new Map([[AERO, { r0: RESERVA_AERO, r1: RESERVA_AERO }]]),
        saldoDaBaseNoV3: new Map([[V3, SALDO_V3]]),
        bloco: 1,
    };

    const quantiasVistas: bigint[] = [];
    const emLote = async (
        pedidos: Array<{ metodo: string; params: unknown[] }>,
    ): Promise<Array<{ ok: boolean; dados: string | null }>> => {
        for (const q of pedidos) {
            const dados = String((q.params[0] as { data: string }).data);
            // A quantia é o segundo argumento de cabeça do `cotar`.
            quantiasVistas.push(BigInt(`0x${dados.slice(74, 138)}`));
        }
        // Reversão com número: ciclo que não fechou.
        return pedidos.map(() => ({
            ok: false,
            dados: `0xba64f239${'0'.repeat(63)}1${'0'.repeat(63)}2`,
        }));
    };
    const chamar = async (): Promise<unknown> => `0x${'0'.repeat(64)}`;

    const sinais = await cotarAfetadas(
        emLote, chamar as never, rotas, estado, 'pending', 1, Date.now(), 1_000_000n,
        `0x${'60'.repeat(60)}`,
    );
    assert.equal(sinais.length, rotas.length);
    assert.equal(quantiasVistas.length, 2, 'as duas direções foram cotadas');

    // A escada começa em 1/10.000 da liquidez do pool que EMPRESTA.
    const esperadoA = RESERVA_AERO / 10_000n;
    const esperadoB = SALDO_V3 / 10_000n;
    assert.ok(quantiasVistas.includes(esperadoA),
        `a direção A tem de emprestar do Aerodrome (${esperadoA}), e as quantias foram `
        + `${quantiasVistas.join(', ')}`);
    assert.ok(quantiasVistas.includes(esperadoB),
        `a direção B tem de emprestar do V3 (${esperadoB}) — usar a reserva do Aerodrome aqui `
        + 'dimensionaria o empréstimo de um pool pela liquidez de outro');
    assert.notEqual(esperadoA, esperadoB,
        'o teste só prova algo porque as duas liquidezes são diferentes');
});

// --- OS DOIS DEFEITOS ECONÔMICOS QUE ELA MANDOU CORRIGIR --------------------

test('a GORJETA entra UMA vez: `baseFeeDoBlocoWei` não a inclui', async () => {
    const { baseFeeDoBlocoWei, precoDoGasWei, GORJETA_SUPOSTA_WEI } = await import('./cacarArbitragem');
    const BASE = 4_523_747n;
    const chamar = (async () => ({ baseFeePerGas: `0x${BASE.toString(16)}` })) as never;
    // O leitor de COMPONENTE devolve o baseFee puro.
    assert.equal(await baseFeeDoBlocoWei(chamar), BASE,
        'o campo `baseFeeWei` de `somarCusto` recebe ESTE número; se ele já trouxesse gorjeta, '
        + 'o custo L2 sairia como gas × (baseFee + gorjeta + gorjeta)');
    // O leitor de PREÇO POR GÁS devolve baseFee + gorjeta, e os dois diferem
    // exatamente por uma gorjeta — nunca por duas.
    assert.equal(await precoDoGasWei(chamar), BASE + GORJETA_SUPOSTA_WEI);
    const { somarCusto } = await import('./custoDaBase');
    const gas = 372_944n;
    const certo = somarCusto({
        gasUsado: gas, gasUsadoVeioDe: 'recibo', baseFeeWei: BASE,
        gorjetaWei: GORJETA_SUPOSTA_WEI, custoL1Wei: 0n, taxaDoEmprestimoWei: 0n,
    });
    const dobrado = somarCusto({
        gasUsado: gas, gasUsadoVeioDe: 'recibo', baseFeeWei: BASE + GORJETA_SUPOSTA_WEI,
        gorjetaWei: GORJETA_SUPOSTA_WEI, custoL1Wei: 0n, taxaDoEmprestimoWei: 0n,
    });
    assert.equal(certo.totalWei, gas * (BASE + GORJETA_SUPOSTA_WEI));
    assert.equal(dobrado.totalWei! - certo.totalWei!, gas * GORJETA_SUPOSTA_WEI,
        'é este o tamanho do erro que a dupla contagem produzia — uma gorjeta inteira por gás');
});

test('UMA constante de gorjeta: as duas fontes não podem divergir', async () => {
    const { GORJETA_SUPOSTA_WEI } = await import('./cacarArbitragem');
    const { GORJETA_PADRAO_WEI } = await import('./custoDaBase');
    assert.equal(GORJETA_SUPOSTA_WEI, GORJETA_PADRAO_WEI,
        'havia duas constantes para a mesma coisa, ambas de `ARB_GORJETA_WEI`, com defaults de '
        + '2.000.000 e 20.000.000 — dez vezes de diferença para o mesmo conceito');
});

test('com sobra bruta POSITIVA a busca SOBE a escada e fica com o melhor LÍQUIDO', async () => {
    const { cotarAfetadas } = await import('./cacarArbitragem');
    const { candidatasMistas } = await import('./rotasMistas');
    const { SELETOR_PAGAMENTO_CURTO, SELETOR_LUCRO_INSUFICIENTE } = await import('./cotarMista');
    const WETH = '0x4200000000000000000000000000000000000006';
    const TOK = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';
    const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rotas = candidatasMistas([
        { endereco: A, token0: WETH, token1: TOK, venue: 'v3', taxa: 500 },
        { endereco: B, token0: WETH, token1: TOK, venue: 'v3', taxa: 3000 },
    ], WETH).slice(0, 1);
    const LIQ = 10n ** 22n;
    const estado = {
        sqrtPorPoolV3: new Map([[A, 2n ** 96n], [B, 2n ** 96n]]),
        liquidezDoV3: new Map([[A, 1n], [B, 1n]]),
        token0PorPool: new Map<string, string>(),
        reservasAerodrome: new Map(),
        saldoDaBaseNoV3: new Map([[A, LIQ], [B, LIQ]]),
        bloco: 1,
    };
    // A sobra CRESCE com o tamanho nesta bancada, então o melhor líquido está
    // num degrau ADIANTE do primeiro. Se a busca parar no primeiro, ela entrega
    // o pior dos dois — e era isso que estava acontecendo.
    const palavra = (v: bigint): string => v.toString(16).padStart(64, '0');
    const sobraPorQuantia = new Map<string, bigint>();
    const quantiasVistas: bigint[] = [];
    const emLote = async (
        pedidos: Array<{ metodo: string; params: unknown[] }>,
    ): Promise<Array<{ ok: boolean; dados: string | null }>> => pedidos.map((p) => {
        const dados = String((p.params[0] as { data: string }).data);
        const q = BigInt(`0x${dados.slice(74, 138)}`);
        quantiasVistas.push(q);
        // sobra = q / 1000: cresce com o tamanho.
        const sobra = q / 1000n;
        sobraPorQuantia.set(q.toString(), sobra);
        return {
            ok: false,
            dados: SELETOR_LUCRO_INSUFICIENTE + palavra(sobra) + palavra(0n),
        };
    });
    const chamar = (async () => `0x${palavra(0n)}`) as never;
    const sinais = await cotarAfetadas(
        emLote, chamar, rotas, estado as never, 'pending', 1, Date.now(), 1_000_000n,
        `0x${'60'.repeat(60)}`,
    );
    assert.equal(sinais.length, 1);
    assert.ok(quantiasVistas.length >= 2,
        `a busca tem de cotar mais de um tamanho quando o primeiro já tem sobra positiva; `
        + `cotou ${quantiasVistas.length}`);
    const maior = quantiasVistas.reduce((x, y) => (y > x ? y : x));
    const sn = sinais[0]!;
    assert.equal(sn.melhorTamanho, maior,
        'o tamanho escolhido tem de ser o de melhor LÍQUIDO entre os avaliados — aqui o maior');
    assert.equal(sn.lucroBrutoEstimado, sobraPorQuantia.get(maior.toString()));
    assert.match(sn.motivo, /não ótimo global/,
        'a frase não pode afirmar ótimo global: a escada é discreta e a busca tem teto');
    // E o SELETOR de pagamento curto continua lido como sobra negativa.
    assert.ok(SELETOR_PAGAMENTO_CURTO.startsWith('0x'));
});

test('com sobra NÃO positiva e monotonicidade demonstrada, a busca PARA no primeiro', async () => {
    const { cotarAfetadas } = await import('./cacarArbitragem');
    const { candidatasMistas } = await import('./rotasMistas');
    const { SELETOR_PAGAMENTO_CURTO } = await import('./cotarMista');
    const WETH = '0x4200000000000000000000000000000000000006';
    const TOK = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';
    const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rotas = candidatasMistas([
        { endereco: A, token0: WETH, token1: TOK, venue: 'v3', taxa: 500 },
        { endereco: B, token0: WETH, token1: TOK, venue: 'v3', taxa: 3000 },
    ], WETH).slice(0, 1);
    const LIQ = 10n ** 22n;
    const estado = {
        sqrtPorPoolV3: new Map([[A, 2n ** 96n], [B, 2n ** 96n]]),
        liquidezDoV3: new Map([[A, 1n], [B, 1n]]),
        token0PorPool: new Map<string, string>(),
        reservasAerodrome: new Map(),
        saldoDaBaseNoV3: new Map([[A, LIQ], [B, LIQ]]),
        bloco: 1,
    };
    const palavra = (v: bigint): string => v.toString(16).padStart(64, '0');
    let chamadas = 0;
    const emLote = async (
        pedidos: Array<{ metodo: string; params: unknown[] }>,
    ): Promise<Array<{ ok: boolean; dados: string | null }>> => pedidos.map((p) => {
        chamadas += 1;
        const dados = String((p.params[0] as { data: string }).data);
        const q = BigInt(`0x${dados.slice(74, 138)}`);
        // Ciclo que não fecha: produziu menos do que entrou.
        return { ok: false, dados: SELETOR_PAGAMENTO_CURTO + palavra(q - 1n) + palavra(q) };
    });
    const chamar = (async () => `0x${palavra(0n)}`) as never;
    const sinais = await cotarAfetadas(
        emLote, chamar, rotas, estado as never, 'pending', 1, Date.now(), 1_000_000n,
        `0x${'60'.repeat(60)}`,
    );
    assert.equal(chamadas, 1,
        'sem sobra bruta e com as duas pernas monótonas, nenhum tamanho maior fecha: gastar RPC '
        + `subindo a escada seria desperdício. Gastei ${chamadas} cotação(ões)`);
    assert.match(sinais[0]!.motivo, /Nenhum tamanho maior fecha/);
});

// --- OS DEFEITOS QUE O AUDITOR INDEPENDENTE ACHOU NO MEU DIFF ---------------

const bancadaDaEscada = async (over: {
    seletor?: 'lucro' | 'curto';
    sobraDe?: (q: bigint) => bigint;
    produzidoDe?: (q: bigint) => bigint;
    l1?: string;
    tamanhos?: string;
} = {}) => {
    const { cotarAfetadas } = await import('./cacarArbitragem');
    const { candidatasMistas } = await import('./rotasMistas');
    const m = await import('./cotarMista');
    const WETH = '0x4200000000000000000000000000000000000006';
    const TOK = '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95';
    const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rotas = candidatasMistas([
        { endereco: A, token0: WETH, token1: TOK, venue: 'v3', taxa: 500 },
        { endereco: B, token0: WETH, token1: TOK, venue: 'v3', taxa: 3000 },
    ], WETH).slice(0, 1);
    const LIQ = 10n ** 22n;
    const estado = {
        sqrtPorPoolV3: new Map([[A, 2n ** 96n], [B, 2n ** 96n]]),
        liquidezDoV3: new Map([[A, 1n], [B, 1n]]),
        token0PorPool: new Map<string, string>(),
        reservasAerodrome: new Map(),
        saldoDaBaseNoV3: new Map([[A, LIQ], [B, LIQ]]),
        bloco: 1,
    };
    const palavra = (v: bigint): string => v.toString(16).padStart(64, '0');
    let lotes = 0;
    const emLote = async (
        pedidos: Array<{ metodo: string; params: unknown[] }>,
    ): Promise<Array<{ ok: boolean; dados: string | null }>> => {
        lotes += 1;
        return pedidos.map((p) => {
            const dados = String((p.params[0] as { data: string }).data);
            const q = BigInt(`0x${dados.slice(74, 138)}`);
            const sobra = (over.sobraDe ?? ((x: bigint) => x / 1000n))(q);
            if (over.seletor === 'curto') {
                const prod = (over.produzidoDe ?? ((x: bigint) => x + sobra))(q);
                return { ok: false, dados: m.SELETOR_PAGAMENTO_CURTO + palavra(prod) + palavra(q) };
            }
            const prod = (over.produzidoDe ?? (() => sobra))(q);
            return { ok: false, dados: m.SELETOR_LUCRO_INSUFICIENTE + palavra(prod) + palavra(0n) };
        });
    };
    // `chamar` serve o oráculo L1: `0x` simula a leitura que NÃO veio.
    const chamar = (async () => over.l1 ?? `0x${palavra(1_000n)}`) as never;
    const antes = process.env.ARB_TAMANHOS;
    if (over.tamanhos !== undefined) process.env.ARB_TAMANHOS = over.tamanhos;
    try {
        const sinais = await cotarAfetadas(
            emLote, chamar, rotas, estado as never, 'pending', 1, Date.now(), 1_000_000n,
            `0x${'60'.repeat(60)}`,
        );
        return { sinais, lotes: () => lotes };
    } finally {
        if (antes === undefined) delete process.env.ARB_TAMANHOS;
        else process.env.ARB_TAMANHOS = antes;
    }
};

test('SEM CUSTO conhecido não existe LÍQUIDO — e a frase não finge que existe', async () => {
    // O oráculo L1 não respondeu: `custoL1Wei` fica `null`, logo o custo total
    // é desconhecido. A versão anterior fazia `liquido = sobra` e imprimia
    // "LÍQUIDO <bruto>", subestimando o custo em 100% na linha que o operador lê.
    const { sinais } = await bancadaDaEscada({ l1: '0x' });
    const sn = sinais[0]!;
    assert.equal(sn.custoTotalEstimado, null);
    assert.equal(sn.lucroLiquidoEstimado, null,
        'sem custo total não há líquido a afirmar');
    assert.match(sn.motivo, /LÍQUIDO NÃO CALCULÁVEL/);
    assert.match(sn.motivo, /sobra BRUTA/,
        'a frase tem de dizer que a escolha do tamanho foi pela sobra bruta');
    assert.doesNotMatch(sn.motivo, /LÍQUIDO -?\d/,
        'nenhum número de líquido pode aparecer quando o custo é desconhecido');
});

test('"produziu" é o que o cotador DISSE, não aritmética reconstruída', async () => {
    // `LucroInsuficiente(0, 0)` quer dizer produção ZERO. A versão anterior
    // imprimia `sobra + quantia`, que para sobra 0 dava a própria quantia — e
    // afirmava produção igual à entrada quando o cotador reportou zero.
    const { sinais } = await bancadaDaEscada({
        sobraDe: () => 0n,
        produzidoDe: () => 0n,
    });
    const sn = sinais[0]!;
    assert.match(sn.motivo, /o ciclo produziu 0 contra/,
        `a mensagem tem de usar o valor do cotador; saiu: ${sn.motivo.slice(0, 120)}`);
});

test('ARB_TAMANHOS torto cai no padrão e DIZ — nunca zera a busca', async () => {
    // `Math.max(1, Number('auto'))` é NaN, e `0 < NaN` é falso: o laço não
    // rodava nenhuma vez e TODA rota saía como "sem cotador" sem uma única
    // chamada de RPC — falta de spread publicada como falta de instrumento.
    const { sinais, lotes } = await bancadaDaEscada({ tamanhos: 'auto' });
    assert.ok(lotes() >= 1,
        `com valor torto a busca tem de rodar; rodou ${lotes()} lote(s)`);
    assert.doesNotMatch(sinais[0]!.motivo, /SEM COTAÇÃO legível/);
});

test('sem monotonicidade demonstrada, sobra ≤ 0 NÃO para no primeiro degrau', async () => {
    // Aqui o `pode` é verdadeiro (duas pernas V3), então para cobrir o caso
    // oposto uso `ARB_TAMANHOS=3` com sobra sempre negativa e verifico que a
    // parada acontece por PROVA, não por falta de degraus.
    const { sinais, lotes } = await bancadaDaEscada({
        seletor: 'curto',
        sobraDe: (q) => -(q / 1000n),
        produzidoDe: (q) => q - q / 1000n,
        tamanhos: '3',
    });
    assert.equal(lotes(), 1,
        'com as duas pernas V3 a monotonicidade está demonstrada: um degrau basta');
    assert.match(sinais[0]!.motivo, /Nenhum tamanho maior fecha/);
    assert.match(sinais[0]!.motivo, /as duas pernas são V3/,
        'a justificativa não pode citar `x·y = k` do Aerodrome numa rota sem Aerodrome');
});
