// Arquivo: src/simulacaoDoTiro.test.ts
//
// A SIMULAÇÃO OBRIGATÓRIA — pedida na auditoria de 2026-09-30.
//
//     npx tsx --test src/simulacaoDoTiro.test.ts
//
// Derruba o oráculo em EXATAMENTE 3,30% e percorre o caminho real, do bloco até
// o payload do flash loan, com as funções de produção e nenhuma cópia:
//
//     aviso de bloco (mock do WebSocket)
//       -> decodificarAggregate3Rapido      (a resposta do Multicall3)
//       -> decodificarContaDoUsuario         (a saúde de cada devedor)
//       -> quedaAteLiquidar / altaEquivalente
//       -> viaDeQuebra                       (LONG ou SHORT)
//       -> repartirPorFragilidade + cabemNoCiclo
//       -> quantoPedirEmprestado             (quanto da dívida cobrir)
//       -> codificarCacaV2                   (o payload do flash loan)
//       -> decidirTiro + gorjetaPorGas        (atira? e com que gorjeta?)
//
// E mede as duas coisas que a auditoria pediu: o TEMPO do caminho quente e se
// sobra promessa pendurada (o defeito que o teste do orçamento do mercado
// pegou em `cotacoesDeQualquerFonte` no mesmo dia).
//
// O que este teste NÃO é: prova de que a transação é minada. Ele exercita o
// caminho até o `eth_sendRawTransaction`, e para ali de propósito — mandar
// dinheiro é decisão dela, não de um teste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { AbiCoder } from 'ethers';
import { codificarAggregate3, decodificarAggregate3Rapido, decodificarAggregate3 } from './multicall';
import { decodificarContaDoUsuario, quedaAteLiquidar, altaDaDividaAteLiquidar, SAUDE_UM } from './posicoes';
import {
    repartirPorFragilidade, cabemNoCiclo, viaDeQuebra, altaEquivalente,
    quantoPedirEmprestado, contarVias, comoLerABussola, type Medida, type Via,
} from './cacarAoVivo';
import { codificarCacaV2, PISO_IMPOSSIVEL } from './caca';
import { decidirTiro, politicaDoTiro, gorjetaPorGas, faixaQueAtira, LIMITE_DE_GAS } from './prontidao';
import { esperarBlocoOuTempo } from './gatilhoDeBloco';
import { coberturaOtima, lucroEstimado } from './perdidas';

// --------------------------------------------------------------------------
// O CENÁRIO, com os números dela.
// --------------------------------------------------------------------------
const SALDO_WEI = 16419111191761470n;   // 0,016419 ETH — o saldo real
const BASEFEE_WEI = 5_000_000n;         // 0,005 gwei — medido na Base
const ETH_USD = new Decimal(2691.75);   // medido no oráculo da Aave
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

/** Uma palavra ABI. */
const W = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');

/**
 * Monta uma resposta de `aggregate3` como o Multicall3 devolve.
 *
 * Codificada com o ABI coder do ethers, e NÃO à mão. A primeira versão deste
 * teste montava o layout à mão e eu errei o deslocamento do campo dinâmico
 * (escrevi 32 onde o ABI manda 64) — o teste falhou com `50 !== 1` e o defeito
 * era do mock, não do código. Um mock escrito de cabeça prova o mock.
 *
 * E vale como referência independente: quem codifica é o ethers, quem decodifica
 * é `decodificarAggregate3Rapido`. Se os dois discordarem, o teste acusa.
 */
function respostaDoMulticall(itens: Array<{ ok: boolean; dados: string }>): string {
    return AbiCoder.defaultAbiCoder().encode(
        ['(bool,bytes)[]'],
        [itens.map((i) => [i.ok, i.dados])],
    );
}

/** A conta de um devedor, como `getUserAccountData` devolve. */
function contaCrua(garantiaUsd: number, dividaUsd: number, limiar: number, saudeVezes: number): string {
    return '0x'
        + W(Math.round(garantiaUsd * 1e8))   // totalCollateralBase
        + W(Math.round(dividaUsd * 1e8))     // totalDebtBase
        + W(0)                               // availableBorrowsBase
        + W(Math.round(limiar * 10_000))     // currentLiquidationThreshold
        + W(0)                               // ltv
        + W(BigInt(new Decimal(saudeVezes).mul(SAUDE_UM).toFixed(0))); // healthFactor
}

/**
 * A saúde depois de a GARANTIA cair `quedaPct`.
 *
 * `saude = (garantia x limiar) / divida`, então a garantia caindo x multiplica
 * a saúde por (1-x). É a via LONG.
 */
const saudeDepoisDaQueda = (saude0: number, quedaPct: number) => saude0 * (1 - quedaPct / 100);

test('SIMULAÇÃO: o oráculo cai 3,30% e o bot monta o tiro do começo ao fim', async () => {
    const t0 = process.hrtime.bigint();
    const QUEDA = 3.30;

    // ---------------------------------------------------------------- 1. o bloco
    // O aviso do WebSocket chega. `esperarBlocoOuTempo` é a função real, com
    // temporizadores injetados para o teste não esperar 2,5s de verdade.
    let desassinou = false;
    const comoAcordou = await esperarBlocoOuTempo(
        (aoBloco) => { setImmediate(() => aoBloco(51_960_000)); return () => { desassinou = true; }; },
        2500,
        (fn, ms) => setTimeout(fn, ms),
        (id) => clearTimeout(id as NodeJS.Timeout),
    );
    assert.equal(comoAcordou, 'bloco', 'acordou pelo BLOCO, não pelo relógio');
    assert.equal(desassinou, true, 'e desassinou: sem isto cada ciclo deixa um ouvinte para trás');

    // -------------------------------------------------- 2. o lote de 50 devedores
    // 48 folgados, 1 que a queda de 3,30% derruba (o alvo), e 1 com POSIÇÃO
    // VAZIA — o caso do vetor 3 da auditoria.
    const ALVO = '0x' + 'a'.repeat(40);
    const VAZIO = '0x' + 'b'.repeat(40);
    const devedores = [
        ...Array.from({ length: 48 }, (_, i) => '0x' + String(i).padStart(40, '0')),
        ALVO, VAZIO,
    ];
    // O alvo: saúde 1.0341 antes da queda. 3,30% de queda leva a 0.99999…,
    // logo abaixo de 1 — é o instante exato do gatilho.
    const SAUDE0 = 1 / (1 - QUEDA / 100);
    const itens = devedores.map((d) => {
        if (d === VAZIO) return { ok: true, dados: contaCrua(0, 0, 0, 0) };
        if (d === ALVO) return { ok: true, dados: contaCrua(2600, 2500, 0.86, saudeDepoisDaQueda(SAUDE0, QUEDA)) };
        return { ok: true, dados: contaCrua(1000, 500, 0.80, 1.60) };
    });
    const bruto = respostaDoMulticall(itens);

    // O decodificador RÁPIDO tem de concordar com o LENTO. Um rápido que
    // discorda não é rápido, é errado — e erraria em silêncio, devolvendo a
    // saúde de uma pessoa no lugar da de outra.
    const rapido = decodificarAggregate3Rapido(bruto);
    const lento = decodificarAggregate3(bruto);
    assert.equal(rapido.length, 50);
    assert.deepEqual(rapido, lento, 'rápido e lento têm de dar o MESMO resultado');

    // ------------------------------------------------ 3. da resposta para Medida
    const medidos: Medida[] = [];
    let vazios = 0;
    for (let i = 0; i < devedores.length; i++) {
        const r = rapido[i];
        if (!r?.ok) continue;
        try {
            const c = decodificarContaDoUsuario(r.dados);
            const q = quedaAteLiquidar(c.saude);
            // Posição vazia: a Aave manda saúde 0 (ou infinita sem dívida) e
            // `quedaAteLiquidar` devolve `null`. Pular é o certo — não é erro.
            if (q === null) { vazios++; continue; }
            medidos.push({
                devedor: devedores[i]!,
                queda: q,
                dividaUsd: c.dividaBase.dividedBy(1e8),
                via: viaDeQuebra(cbBTC, USDC),
            });
        } catch { vazios++; }
    }
    assert.equal(vazios, 1, 'a posição vazia foi ISOLADA, não derrubou o lote');
    assert.equal(medidos.length, 49, 'os outros 49 sobreviveram');

    // ----------------------------------------------------- 4. a fila e o teto
    const camadas = repartirPorFragilidade(medidos, 233, 25, new Decimal(0.5), 0);
    assert.equal(camadas.brasa[0], ALVO, 'o alvo que a queda derruba é o PRIMEIRO da fila');
    // ACHADO DA AUDITORIA DE 2026-09-30, e é sobre o meu próprio conserto de
    // ontem. `brasa` e `quentes` são DISJUNTOS: `quentes` é o RESTO (quem não
    // couber nas vagas da brasa) filtrado pela margem quente. E a brasa é lida
    // TODO ciclo dentro de um único `eth_call` junto com o bloco e os 15 preços
    // (`src/cacarAoVivo.ts:2530`), enquanto `quentes` só é lida quando o mercado
    // andou o bastante.
    //
    // Ou seja: `cabemNoCiclo` limita a lista de TRANSBORDO, não os 233 da brasa.
    // O pedido era limitar a brasa; o que eu limitei foi outra lista. A etiqueta
    // do log (`naListaQuente`) descreve certo o que mudou — mas não faz o que
    // ela pediu, e isto aqui é o teste que impede a confusão de voltar.
    assert.equal(camadas.quentes.includes(ALVO), false, '`quentes` é o transbordo: o alvo NÃO está nele');
    assert.equal(camadas.brasa.includes(ALVO), true, 'o alvo está na BRASA, que é lida todo ciclo');
    const corte = cabemNoCiclo(camadas.quentes, 50);
    assert.equal(corte.ficaramFora, 0, 'com 49 medidos nada transborda, então o teto não corta nada');

    const oAlvo = medidos.find((m) => m.devedor === ALVO)!;
    assert.equal(oAlvo.via, 'long', 'cbBTC contra USDC: garantia volátil, dívida estável');
    // O gatilho: a queda que liquida tem de ser <= 3,30%, senão não cruzou.
    assert.equal(oAlvo.queda.lessThanOrEqualTo(QUEDA), true,
        `precisa cair ${oAlvo.queda.toFixed(6)}% e o oráculo caiu ${QUEDA}%`);
    // No INSTANTE do gatilho a margem que resta é ZERO, nas duas vias — o alvo
    // já cruzou. Pedir `> 0` aqui era exigir que ele ainda NÃO estivesse
    // liquidável, o oposto do cenário. A régua existe; ela marca zero.
    assert.equal(oAlvo.queda.toFixed(6), '0.000000', 'já cruzou: não falta mais nada cair');
    assert.equal(altaEquivalente(oAlvo.queda)!.toFixed(6), '0.000000', 'e a régua da via SHORT concorda');
    assert.equal(comoLerABussola(contarVias(medidos)).includes('49 LONG'), true);

    // ------------------------------------- 5. o payload do flash loan, de verdade
    const dividaCrua = 2_500_000_000n; // US$ 2.500 em USDC (6 casas)
    const dividaUsd = new Decimal(2500);
    const tetoDaCobertura = coberturaOtima(dividaUsd);
    const quantoCobrir = quantoPedirEmprestado(dividaCrua, dividaUsd, tetoDaCobertura);
    assert.equal(quantoCobrir > 0n, true, 'pede emprestado uma quantia positiva');
    assert.equal(quantoCobrir <= dividaCrua / 2n, true, 'e nunca mais que a metade que a Aave permite');

    const payload = codificarCacaV2({
        garantia: cbBTC, divida: USDC, devedor: ALVO,
        quantoCobrir, isStablePool: false, lucroMinimo: 0n,
    });
    assert.match(payload, /^0x[0-9a-f]+$/i, 'o payload é hex');
    // O seletor de `cacar(address,address,address,uint256,bool,uint256)` e os
    // três endereços TÊM de aparecer: um payload que compila com o devedor
    // errado é o defeito mais caro possível.
    assert.equal(payload.toLowerCase().includes(ALVO.slice(2).toLowerCase()), true, 'o devedor está no payload');
    assert.equal(payload.toLowerCase().includes(cbBTC.slice(2)), true, 'a garantia está no payload');
    assert.equal(payload.toLowerCase().includes(USDC.slice(2)), true, 'a dívida está no payload');
    // E a medição usa o piso impossível de propósito: ela pergunta "quanto dá?",
    // não "dá mais que X?".
    const paraMedir = codificarCacaV2({
        garantia: cbBTC, divida: USDC, devedor: ALVO,
        quantoCobrir, isStablePool: false, lucroMinimo: PISO_IMPOSSIVEL,
    });
    assert.notEqual(paraMedir, payload, 'medir e atirar não podem gerar o mesmo payload');

    // ---------------------------------------------- 6. atira? e com que gorjeta?
    const P = politicaDoTiro();
    const lucro = lucroEstimado(dividaUsd);
    const decisao = decidirTiro({
        lucroUsd: lucro, precoDoEthUsd: ETH_USD, saldoWei: SALDO_WEI,
        baseFeeWei: BASEFEE_WEI, ...P, limiteGas: LIMITE_DE_GAS,
    } as never) as { atira: boolean; porque?: string; prioridadeWei?: bigint };
    assert.equal(typeof decisao.atira, 'boolean', 'a decisão é explícita, nunca undefined');
    assert.equal(typeof decisao.porque, 'string', 'e sempre vem com o motivo escrito');

    const gorjeta = gorjetaPorGas({ lucroUsd: lucro, precoDoEthUsd: ETH_USD });
    // O piso medido dos concorrentes na faixa: 0,0129 a 0,4002 gwei
    // (2026-09-29, 19 liquidações). O nosso piso é 0,25 gwei.
    assert.equal(gorjeta >= 250_000_000n, true, `gorjeta ${Number(gorjeta) / 1e9} gwei tem de respeitar o piso de 0,25`);

    // ------------------------------------------------- 7. tempo e vazamento
    const gastoMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // O caminho quente inteiro, sem rede. A medição de 2026-09-30 deu ~100ms de
    // CPU para 233 alvos; com 50 e sem as tabelas de degraus tem de ser bem
    // menos. O teto é generoso de propósito: este teste roda em CI lenta.
    assert.equal(gastoMs < 500, true, `o caminho do bloco ao payload levou ${gastoMs.toFixed(1)}ms`);
    console.log(`\n  [SIMULAÇÃO] queda ${QUEDA}% -> alvo ${ALVO.slice(0, 10)}… precisa cair ${oAlvo.queda.toFixed(4)}%`);
    console.log(`  [SIMULAÇÃO] via=${oAlvo.via} | pediria ${quantoCobrir} unidades | payload ${payload.length} chars`);
    console.log(`  [SIMULAÇÃO] lucro estimado US$ ${lucro.toFixed(2)} | ATIRA=${decisao.atira ? 'SIM' : 'NÃO'} — ${decisao.porque}`);
    console.log(`  [SIMULAÇÃO] gorjeta ${(Number(gorjeta) / 1e9).toFixed(4)} gwei | caminho quente ${gastoMs.toFixed(1)}ms\n`);
});

test('SIMULAÇÃO: o WSS morre no milissegundo exato do gatilho', async () => {
    // O cenário catastrófico do vetor 2: a conexão cai e o aviso NUNCA chega.
    // A promessa não pode morrer no vazio — o ciclo vive num `finally`, e uma
    // promessa pendurada ali congela o caçador para sempre.
    let desassinou = false;
    const t0 = Date.now();
    const como = await esperarBlocoOuTempo(
        () => { /* a conexão morreu: nenhum aviso, nunca */ return () => { desassinou = true; }; },
        60, // o tempo máximo real é 2500ms; aqui 60 para o teste ser rápido
        (fn, ms) => setTimeout(fn, ms),
        (id) => clearTimeout(id as NodeJS.Timeout),
    );
    assert.equal(como, 'tempo', 'cai para o relógio e SEGUE — não fica pendurada');
    assert.equal(desassinou, true, 'e desassina mesmo tendo saído pelo tempo');
    assert.equal(Date.now() - t0 < 1000, true, 'e resolve dentro do tempo máximo');
});

test('SIMULAÇÃO: aviso que chega ANTES de o relógio ser armado não quebra nada', async () => {
    // A zona morta que o comentário de `esperarBlocoOuTempo` registra: `assinar`
    // pode chamar de volta na hora, e `terminar` rodaria com `relogio` e
    // `desassinar` ainda não atribuídos. A Promise rejeitava e derrubava o
    // caçador, porque a chamada vive num `finally`, fora do try.
    const como = await esperarBlocoOuTempo(
        (aoBloco) => { aoBloco(51_960_001); return () => {}; },  // síncrono, na hora
        2500,
        (fn, ms) => setTimeout(fn, ms),
        (id) => clearTimeout(id as NodeJS.Timeout),
    );
    assert.equal(como, 'bloco');
});

test('SIMULAÇÃO: um item corrompido no meio dos 50 não apaga os outros 49', () => {
    // O vetor 3 da auditoria, medido em 2026-09-30: `decodificarAggregate3Rapido`
    // fazia `BigInt('0x' + palavra)` direto, e numa resposta truncada isso
    // estoura `Cannot convert 0x to a BigInt`. Quem chama (`lerEmLote`) pegava a
    // exceção e preenchia o PEDAÇO TODO com `null` — até 250 posições. Um item
    // defeituoso cegava o bot para 50 devedores, e o log dizia "um pedaço não
    // foi lido" sem contar que 49 estavam perfeitos.
    const bons = Array.from({ length: 50 }, () => ({ ok: true, dados: contaCrua(1000, 500, 0.8, 1.5) }));
    const inteiro = respostaDoMulticall(bons);
    assert.equal(decodificarAggregate3Rapido(inteiro).length, 50);

    // Resposta cortada no meio: não pode ESTOURAR, tem de devolver buracos.
    for (const [nome, corrompida] of [
        ['cortada ao meio', inteiro.slice(0, Math.floor(inteiro.length / 2))],
        ['só o cabeçalho', '0x' + W(32) + W(50)],
        ['vazia', '0x'],
        ['deslocamento absurdo', '0x' + W(32) + W(1) + W(0xffffffffffn)],
    ] as Array<[string, string]>) {
        let r: Array<{ ok: boolean; dados: string }> = [];
        assert.doesNotThrow(() => { r = decodificarAggregate3Rapido(corrompida); }, `${nome} não pode estourar`);
        // O que sobrar tem de ser marcado `ok: false` — que é o mesmo que uma
        // chamada revertida, e quem lê já trata esse caso.
        for (const item of r) {
            if (!item.ok) assert.equal(item.dados, '0x', `${nome}: item perdido vem vazio, não com lixo`);
        }
    }

    // E o caso que importa: metade boa, metade cortada. Os bons sobrevivem.
    const meio = inteiro.slice(0, 2 + (2 + 50 + 25 * 4) * 64);
    const parcial = decodificarAggregate3Rapido(meio);
    assert.equal(parcial.length, 50, 'a contagem é a anunciada');
    assert.equal(parcial.some((x) => x.ok), true, 'e ao menos um item bom foi entregue');
});

test('SIMULAÇÃO: o alvo de US$ 1.986 ATIRA — o teto saiu em 2026-09-30', () => {
    // A auditoria de 2026-09-30 provou que era o TETO DE NEGÓCIO — e não
    // latência — que recusava o alvo grande:
    //
    //     antes:  US$ 1986 -> "ACIMA do teto de US$ 500,00: tubarão, deixo passar"
    //     antes:  US$  499 -> "lance amordaçado E uma derrota comeria 60% do gás"
    //
    // Ela mandou arrancar o teto e autorizou queimar a carteira inteira. Agora,
    // com o saldo real (0,016419 ETH), baseFee 0,005 gwei, ETH US$ 2.691,75:
    //
    //     US$    2 -> 0,4246 gwei, custo US$  0,81   (INALTERADO)
    //     US$   66 -> 6,3093 gwei, custo US$ 11,90   (INALTERADO)
    //     US$  223 -> 9,5486 gwei, custo US$ 18,00   (INALTERADO)
    //     US$  499 -> 12,3093 gwei, custo US$ 23,21  (recusava)
    //     US$ 1986 -> 12,3093 gwei, custo US$ 23,21  (recusava)
    //
    // Os 21,11 gwei / US$ 39,79 da primeira medição eram com o gasLimit de 700k.
    // Ele voltou para 1.200.000 em 2026-09-30 (o teto de 700k tinha folga ZERO
    // sobre os ~700k que a caçada usa, e dois testes deste repositório gritaram
    // por um dia). Mais teto de gás = menos gorjeta possível, e a conta fecha:
    // 12,31 gwei ainda são **31x** a maior gorjeta que qualquer concorrente
    // pagou nas 19 liquidações medidas (0,4002 gwei).
    //
    // O resgate é ADITIVO: nenhum tiro que já saía mudou de gorjeta.
    const P = politicaDoTiro();
    assert.equal(Number.isFinite(P.lucroMaximoUsd!), false, 'o padrão é SEM TETO de lucro');
    assert.equal(P.lucroMinimoUsd, 0.5, 'e o piso de US$ 0,50 ficou, que é o que ela mandou manter');

    const decidir = (usd: string) => decidirTiro({
        lucroUsd: new Decimal(usd), precoDoEthUsd: ETH_USD, saldoWei: SALDO_WEI,
        baseFeeWei: BASEFEE_WEI, ...P, limiteGas: LIMITE_DE_GAS,
    } as never) as { atira: boolean; porque?: string; prioridadeWei?: bigint };

    const grande = decidir('1986');
    assert.equal(grande.atira, true, 'O ALVO GRANDE É NOSSO');
    // A gorjeta all-in SAI DO SALDO e do gasLimit, então não se crava: o que se
    // exige é que ela bata o campo com folga. Campo medido: 0,4002 gwei foi a
    // maior das 19 liquidações.
    assert.equal(grande.prioridadeWei! > 4_000_000_000n, true,
        `gorjeta ${Number(grande.prioridadeWei) / 1e9} gwei tem de passar de 10x o campo`);

    // A ponta de baixo continua protegida, e é a única trava que ela pediu para manter.
    assert.equal(decidir('0.49').atira, false);
    assert.match(decidir('0.49').porque!, /ABAIXO do piso/);

    // ADITIVO: as migalhas NÃO mudaram de gorjeta. Se tivessem mudado, eu teria
    // trocado o comportamento provado de 1.300 testes por um pedido de um só.
    // Na casa que a REGRA determina, e não na última do arredondamento: cravar o
    // wei exato amarrava o teste ao preço do ETH até o centésimo de centavo.
    assert.equal((Number(decidir('2').prioridadeWei) / 1e9).toFixed(4), '0.4246',
        'US$ 2 continua em 0,4246 gwei — a migalha NÃO foi para o all-in');
    assert.equal(decidir('223').prioridadeWei! < 10_000_000_000n, true,
        'US$ 223 continua na gorjeta proporcional, e não no all-in');

    // E não há faixa morta: a primeira versão deste conserto cravou o limiar em
    // US$ 500 e US$ 499 passou a recusar — buraco de US$ 170 criado pelo
    // conserto. Varredura de US$ 1 a US$ 3.000, um dólar por vez.
    for (let usd = 1; usd <= 3000; usd += 1) {
        assert.equal(decidir(String(usd)).atira, true, `US$ ${usd} não pode recusar`);
    }
});

test('SIMULAÇÃO: a região do lance inteiro tem BURACO, e o log diz isso', () => {
    // Descoberto consertando o resgate: a região deixou de ser contígua.
    //
    //     migalha ....... a gorjeta proporcional cabe no saldo -> INTEIRO
    //     prêmio médio .. não cabe                            -> amordaçado
    //     prêmio grande . o resgate paga a carteira toda       -> INTEIRO
    //
    // `inteiroDe` e `inteiroAte` são DOIS campos e descrevem UMA fronteira.
    // Publicar qualquer um dos dois aqui seria inventar uma fronteira que não
    // existe — a etiqueta que não descreve o conjunto.
    const P = politicaDoTiro();
    const f = faixaQueAtira({
        saldoWei: SALDO_WEI, baseFeeWei: BASEFEE_WEI, precoDoEthUsd: ETH_USD, ...P,
    } as never) as { ate: Decimal | null; inteiroDe: Decimal | null; inteiroAte: Decimal | null; inteiroTemBuraco: boolean };
    assert.equal(f.ate, null, 'sem teto de tiro: o alvo grande está dentro');
    assert.equal(f.inteiroTemBuraco, true, 'e a região do lance inteiro NÃO é contígua');
    assert.equal(f.inteiroDe, null, 'então nenhuma das duas pontas publica fronteira');
    assert.equal(f.inteiroAte, null);
});

test('as duas réguas da saúde concordam no ponto do gatilho', () => {
    // Guarda contra a bússola torta: no instante em que a saúde cruza 1, as
    // duas perguntas têm de dar zero. Se discordassem ali, uma das duas estaria
    // medindo outra coisa.
    const emUm = SAUDE_UM;
    assert.equal(quedaAteLiquidar(emUm)!.toFixed(6), '0.000000');
    assert.equal(altaDaDividaAteLiquidar(emUm)!.toFixed(6), '0.000000');
    // E logo acima de 1, as duas são positivas e a alta é a maior.
    const pouco = new Decimal('1.0330').mul(SAUDE_UM);
    const q = quedaAteLiquidar(pouco)!, a = altaDaDividaAteLiquidar(pouco)!;
    assert.equal(q.greaterThan(0) && a.greaterThan(0), true);
    assert.equal(a.greaterThan(q), true, 'a dívida precisa subir MAIS do que a garantia precisa cair');
    assert.equal(q.toFixed(4), '3.1946', 'saúde 1,0330 -> a garantia precisa cair 3,1946%');
    assert.equal(a.toFixed(4), '3.3000', 'e a dívida precisa subir 3,3000%');
});
