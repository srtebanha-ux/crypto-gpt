/**
 * A REGRA DO RESIDUO DA AAVE, medida por bissecao em fork da Base.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Em 2026-10-10 eu publiquei "o teto de metade
 * continua certo" a partir de UM alvo em DOIS regimes. Ela recusou a
 * generalizacao: *"O experimento não validou metade como regra universal...
 * Complete a matriz com posições pequenas... e valores próximos dos limites de
 * resíduos."*
 *
 * A matriz ampliada (`forkTests/aFronteiraDoResiduo.js`, bloco ~52418700,
 * contrato publicado real, posicoes montadas por mim com UMA divida em USDC e
 * UMA garantia em WETH) mediu a fronteira por bissecao com `eth_call`:
 *
 *   divida  saude   maior cobertura aceita       resto de divida   metade passa?
 *   US$ 300  0,999  NENHUMA                            —           nao
 *   US$ 300  0,93   NENHUMA                            —           nao
 *   US$ 500  0,999  NENHUMA                            —           nao
 *   US$ 500  0,93   NENHUMA                            —           nao
 *   US$ 1000 0,999  NENHUMA                            —           nao
 *   US$ 1000 0,93   NENHUMA                            —           nao
 *   US$ 1500 0,999  499,84 USDC (33,3% da divida)   US$ 1000,16    nao
 *   US$ 1500 0,93   499,84 USDC (33,3% da divida)   US$ 1000,16    nao
 *   US$ 2100 0,999  100% da divida                  US$     0,00   SIM
 *   US$ 2100 0,93   1099,84 (52,4%)                 US$ 1000,16    SIM
 *   US$ 3000 0,999  100% da divida                  US$     0,00   SIM
 *   US$ 3000 0,93   1999,84 (66,7%)                 US$ 1000,16    SIM
 *   US$ 5000 0,999  100% da divida                  US$     0,00   SIM
 *   US$ 5000 0,93   3999,84 (80,0%)                 US$ 1000,16    SIM
 *
 * CINCO casos independentes deixaram EXATAMENTE US$ 1000,16 de resto. Nao e
 * coincidencia nem formula minha: e a fronteira, lida nos numeros.
 *
 * E ela corrige DUAS afirmacoes minhas, em direcoes opostas:
 *
 *   1. "nenhum ganho demonstrado" vale para saude ~0,997 — ali pedir mais que
 *      metade e clampado e so custa premio de flash loan.
 *
 *      Com saude 0,93 o ganho EXISTE, e agora esta em LUCRO LIQUIDO SIMULADO
 *      por tamanho — nao em "1,6x o premio", que era razao de divida coberta.
 *      Medido na grade de 2026-10-10 (`forkTests/aGradeDoTamanho.js`), alvo de
 *      US$ 5.000 com saude 0,927754, cada linha um ENVIO de verdade com o gas
 *      do proprio recibo descontado:
 *
 *        %divida   bruto USDC   gas US$   LIQUIDO USD   resto divida US$
 *          30%      1.570,75     1,4454     1.569,30        3.499,45
 *          50%      2.615,60     1,4454     2.614,15        2.499,61
 *          66%      3.450,16     1,4454     3.448,71        1.699,73
 *          75%      3.919,08     1,4454     3.917,63        1.249,80
 *          80%           —           —      RECUSADO               —
 *
 *      75% contra 50%: **US$ 3.917,63 contra US$ 2.614,15 LIQUIDOS = 1,50x**,
 *      com o MESMO gas (US$ 1,4454) nos dois. O 1,6x que eu publiquei era a
 *      razao de divida coberta, nao de lucro.
 *
 *      DECLARADO: o valor absoluto esta inflado pela divergencia entre o
 *      oraculo falso e o preco real do pool. A RAZAO sobrevive porque a
 *      divergencia incide igual nos dois tamanhos.
 *   2. "o teto de metade continua certo" e FALSO para divida entre ~US$ 1.000
 *      e ~US$ 2.000: ali metade DEIXA resto abaixo do piso e a Aave RECUSA —
 *      e existe uma cobertura menor que PASSA. O bot, pedindo sempre metade,
 *      nao consegue liquidar essas posicoes.
 *
 * O QUE ISTO NAO PROVA, declarado:
 *   - As posicoes sao de UMA divida e UMA garantia. Posicao multi-ativo pode
 *     se comportar diferente, e a regra da Aave olha tambem o resto de
 *     GARANTIA. Nao medido.
 *   - "divida <= US$ 1.000 e inliquidavel" vale para as posicoes TESTADAS. O
 *     censo acha 165 liquidacoes abaixo do piso de gas na Base real, entao ou
 *     elas sao multi-ativo, ou garantia esgotada, ou outra coisa que estas
 *     posicoes sinteticas nao reproduzem. Buraco declarado.
 *   - A causa nao foi lida no TRACE: o tracer de call do Hardhat nao esta
 *     disponivel neste ambiente ("only supports the default tracer"). O que ha
 *     e a FRONTEIRA medida e o seletor. Chamar isso de "a causa e o
 *     MIN_LEFTOVER da Aave" seria conclusao por seletor, que ela proibiu.
 */

/**
 * O resto de divida, em dolares, que a Aave exigiu nas medicoes.
 *
 * MEDIDO, nao escolhido: cinco casos independentes deixaram US$ 1000,16. O
 * valor exato pode ser `1000e8` na base da Aave mais o juro acumulado entre a
 * leitura e a liquidacao — e por isso o uso abaixo tem FOLGA.
 */
export const RESTO_EXIGIDO_USD = 1000.16;

/**
 * A folga sobre o resto exigido.
 *
 * Mirar o resto exato e mirar a borda: o juro corre entre a montagem e a
 * execucao, e um resto de US$ 1000,15 reverte. 2% de folga sobre US$ 1.000
 * sao US$ 20 — barato contra uma reversao que custa gas.
 */
export const FOLGA_DO_RESTO = 1.02;

export interface CoberturaPossivel {
    /** Quanto pedir, na unidade CRUA do ativo da divida. */
    cobrir: bigint;
    /** `true` se metade seria RECUSADA pela regra de resíduo. */
    metadeSeriaRecusada: boolean;
    /** `true` se nenhuma cobertura passa — a posicao e inliquidavel assim. */
    inliquidavel: boolean;
    /** A frase para o log, dizendo o que decidiu e por quê. */
    porque: string;
}

/**
 * A cobertura que a regra de resíduo deixa passar.
 *
 * NAO e usada para decidir o tiro ainda: ela entra no DIAGNOSTICO, porque a
 * evidencia e de fork com posicao sintetica e a decisao de mudar o tamanho em
 * producao e dela. Ver o bloco acima.
 *
 * `saudeAbaixoDeNoventaECinco` separa os dois regimes medidos, porque a
 * resposta e diferente em cada um — e supor um deles seria o erro que este
 * projeto registra cinco vezes na regra de concentracao.
 */
export function coberturaQuePassa(e: {
    dividaCrua: bigint;
    dividaUsd: number | null;
    saudeAbaixoDeNoventaECinco: boolean;
    restoExigidoUsd?: number;
}): CoberturaPossivel {
    const metade = e.dividaCrua / 2n;
    const resto = (e.restoExigidoUsd ?? RESTO_EXIGIDO_USD) * FOLGA_DO_RESTO;
    if (e.dividaUsd === null || !Number.isFinite(e.dividaUsd) || e.dividaUsd <= 0) {
        // Sem a divida em dolares nao ha como saber onde cai o resto. Metade,
        // que e o comportamento de hoje, e a frase DIZ que nao se sabe.
        return {
            cobrir: metade,
            metadeSeriaRecusada: false,
            inliquidavel: false,
            porque: 'sem a dívida em dólares eu não sei onde cai o resíduo: pedi metade, '
                + 'que é o comportamento de sempre',
        };
    }
    const porDolar = Number(e.dividaCrua) / e.dividaUsd;
    // 1. A divida INTEIRA e permitida? So com saude abaixo de 0,95 — e nas
    //    medicoes, com divida acima de ~US$ 2.000, 100% passou com saude 0,999
    //    tambem. Entao a pergunta certa nao e a saude: e se SOBRA resto.
    //    Cobrir 100% deixa resto ZERO, que a regra aceita.
    if (!e.saudeAbaixoDeNoventaECinco) {
        // Saude entre 0,95 e 1: a Aave CLAMPA em metade (medido: pedir 100% e
        // aceito e cortado, custando premio de flash loan sobre o excedente).
        // Entao a cobertura util e a metade — SE ela deixar resto suficiente.
        const restoDaMetade = e.dividaUsd / 2;
        if (restoDaMetade >= resto) {
            return {
                cobrir: metade, metadeSeriaRecusada: false, inliquidavel: false,
                porque: `metade deixa US$ ${restoDaMetade.toFixed(2)} de resto, acima do exigido `
                    + `US$ ${resto.toFixed(2)}: metade passa`,
            };
        }
        // Metade deixa resto pequeno. A cobertura que passa e a que deixa
        // exatamente o resto exigido — e ela e MENOR que metade.
        const cabe = e.dividaUsd - resto;
        if (cabe <= 0) {
            return {
                cobrir: metade, metadeSeriaRecusada: true, inliquidavel: true,
                porque: `dívida US$ ${e.dividaUsd.toFixed(2)} é menor que o resto exigido `
                    + `US$ ${resto.toFixed(2)}: NENHUMA cobertura parcial passa, e com saúde acima `
                    + 'de 0,95 a Aave clampa em metade. Medido: inliquidável assim',
            };
        }
        const v = BigInt(Math.floor(cabe * porDolar));
        return {
            cobrir: v > 0n && v < metade ? v : metade,
            metadeSeriaRecusada: true,
            inliquidavel: false,
            porque: `metade seria RECUSADA (deixaria US$ ${restoDaMetade.toFixed(2)}, abaixo do `
                + `exigido US$ ${resto.toFixed(2)}): a cobertura que passa é US$ ${cabe.toFixed(2)}`,
        };
    }
    // 2. Saude abaixo de 0,95: o fator de fechamento sobe, e a cobertura aceita
    //    vai ate "divida menos o resto exigido" — medido em 80% da divida num
    //    alvo de US$ 5.000. E aqui que ha GANHO sobre metade.
    const cabe = e.dividaUsd - resto;
    if (cabe <= 0) {
        return {
            cobrir: e.dividaCrua, metadeSeriaRecusada: true, inliquidavel: true,
            porque: `dívida US$ ${e.dividaUsd.toFixed(2)} abaixo do resto exigido: nas medições `
                + 'nenhuma cobertura passou nesta faixa, nos dois regimes de saúde',
        };
    }
    const v = BigInt(Math.floor(cabe * porDolar));
    const ganho = Number(v) / Number(metade);
    return {
        cobrir: v > metade ? v : metade,
        metadeSeriaRecusada: e.dividaUsd / 2 < resto,
        inliquidavel: false,
        porque: v > metade
            ? `saúde abaixo de 0,95: a cobertura aceita vai até US$ ${cabe.toFixed(2)} `
              + `(${ganho.toFixed(2)}x a metade) — e é aí que há ganho sobre pedir metade`
            : `saúde abaixo de 0,95, mas a cobertura que deixa resto suficiente não passa de metade`,
    };
}

/** A frase do diagnóstico: o que o bot pede HOJE contra o que passaria. */
export function comoLerOTamanho(hoje: bigint, possivel: CoberturaPossivel): string {
    if (possivel.inliquidavel) {
        return `INLIQUIDÁVEL pela regra de resíduo: ${possivel.porque}. `
            + 'O bot pediria metade e a Aave recusaria com MustNotLeaveDust()';
    }
    if (hoje === possivel.cobrir) return `metade, e ela passa: ${possivel.porque}`;
    const razao = Number(possivel.cobrir) / Number(hoje);
    return `o bot pede ${hoje} e a cobertura que a regra de resíduo deixa passar é `
        + `${possivel.cobrir} (${razao.toFixed(2)}x) — ${possivel.porque}. `
        + 'MEDIDO em fork com posição sintética; o tamanho em produção NÃO foi alterado';
}
