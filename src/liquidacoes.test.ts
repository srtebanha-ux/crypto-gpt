import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    aglomeracao,
    bonusDeLiquidacao,
    chamadaDeConfiguracao,
    janelaDeOportunidade,
    REDES,
    REDES_BARATAS,
    classificarToken,
    decodificarListaDeEnderecos,
    decodificarTexto,
    RPCS_PARA_TENTAR,
    TAMANHOS_PARA_SONDAR,
    escolherMelhorRpc,
    minutosEstimados,
    lucroBruto,
    contarPorTopico,
    decodificarLiquidacao,
    ehLimiteDeFaixa,
    gorjetaWei,
    lerDisputa,
    lerDisputaPorPiso,
    lerPosicao,
    multiploDaBase,
    enderecoDoTopico,
    faixasDeBlocos,
    repartirOBolo,
    resumirHistorico,
    valorEmDolares,
    type LogCru,
    type Token,
} from './liquidacoes';

/** Uma palavra de 32 bytes, como o ABI codifica. */
function palavra(v: bigint | string): string {
    if (typeof v === 'string') return v.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    return v.toString(16).padStart(64, '0');
}

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ROBO = '0x1111111111111111111111111111111111111111';

function logDe(params: {
    dividaCrua: bigint;
    ativoDaDivida?: string;
    liquidante?: string;
    bloco?: number;
}): LogCru {
    return {
        address: '0xpool',
        topics: [
            '0xtopic0',
            `0x${palavra(WETH)}`,
            `0x${palavra(params.ativoDaDivida ?? USDC)}`,
            `0x${palavra('0xdead000000000000000000000000000000000001')}`,
        ],
        data:
            '0x' +
            palavra(params.dividaCrua) +
            palavra(1000000000000000000n) +
            palavra(params.liquidante ?? ROBO) +
            palavra(0n),
        blockNumber: `0x${(params.bloco ?? 100).toString(16)}`,
        transactionHash: '0xabc',
    };
}

test('endereço sai dos 20 bytes finais da palavra de 32', () => {
    assert.equal(enderecoDoTopico(`0x${palavra(USDC)}`), USDC);
});

test('decodifica uma LiquidationCall inteira', () => {
    // 250.000 USDC, que tem 6 casas.
    const l = decodificarLiquidacao(logDe({ dividaCrua: 250_000_000_000n, bloco: 4660 }));
    assert.equal(l.ativoDaDivida, USDC);
    assert.equal(l.ativoDaGarantia, WETH);
    assert.equal(l.liquidante, ROBO);
    assert.equal(l.bloco, 4660);
    assert.equal(l.dividaCrua.toString(), '250000000000');
});

test('log sem os 4 tópicos é erro, não silêncio', () => {
    const quebrado = { ...logDe({ dividaCrua: 1n }), topics: ['0xtopic0'] };
    assert.throws(() => decodificarLiquidacao(quebrado), /4 tópicos/);
});

test('dívida em stablecoin vira dólar pelas casas decimais certas', () => {
    const l = decodificarLiquidacao(logDe({ dividaCrua: 250_000_000_000n }));
    assert.equal(valorEmDolares(l)?.toString(), '250000');
});

test('dívida em token que eu não sei cotar devolve null, não um chute', () => {
    // O ponto inteiro deste teste: WETH tem preço, mas não é 1 dólar. Inventar
    // uma cotação para caber no histograma seria pior que não contar.
    const l = decodificarLiquidacao(logDe({ dividaCrua: 10n ** 18n, ativoDaDivida: WETH }));
    assert.equal(valorEmDolares(l), null);
});

test('token fora da tabela também devolve null', () => {
    const l = decodificarLiquidacao({
        ...logDe({ dividaCrua: 1n }),
        topics: [
            '0xtopic0',
            `0x${palavra(WETH)}`,
            `0x${palavra('0x9999999999999999999999999999999999999999')}`,
            `0x${palavra('0xdead000000000000000000000000000000000001')}`,
        ],
    });
    assert.equal(valorEmDolares(l), null);
});

test('o histograma conta cada liquidação em TODAS as faixas que ela alcança', () => {
    // Uma de 120 mil conta em 1k, 10k, 50k e 100k — a pergunta "quantas acima
    // de X" precisa disso. Contar só na faixa mais alta responderia outra coisa.
    const ls = [
        decodificarLiquidacao(logDe({ dividaCrua: 120_000_000_000n })),
        decodificarLiquidacao(logDe({ dividaCrua: 2_000_000_000n })),
    ];
    const r = resumirHistorico(ls);
    assert.equal(r.porFaixa[1_000], 2);
    assert.equal(r.porFaixa[10_000], 1);
    assert.equal(r.porFaixa[100_000], 1);
    assert.equal(r.porFaixa[500_000], 0);
    assert.equal(r.maior?.toString(), '120000');
});

test('conta liquidantes distintos — a linha que diz se o lugar está tomado', () => {
    const ls = [
        decodificarLiquidacao(logDe({ dividaCrua: 5_000_000_000n, liquidante: ROBO })),
        decodificarLiquidacao(logDe({ dividaCrua: 5_000_000_000n, liquidante: ROBO })),
        decodificarLiquidacao(logDe({ dividaCrua: 5_000_000_000n, liquidante: '0x2222222222222222222222222222222222222222' })),
    ];
    const r = resumirHistorico(ls);
    assert.equal(r.liquidantesDistintos, 2);
    assert.equal(r.maioresLiquidantes[0].endereco, ROBO);
    assert.equal(r.maioresLiquidantes[0].quantas, 2);
});

test('as sem cotação são contadas à parte, não somem', () => {
    const ls = [
        decodificarLiquidacao(logDe({ dividaCrua: 5_000_000_000n })),
        decodificarLiquidacao(logDe({ dividaCrua: 10n ** 18n, ativoDaDivida: WETH })),
    ];
    const r = resumirHistorico(ls);
    assert.equal(r.total, 2);
    assert.equal(r.semCotacao, 1);
    assert.equal(r.porFaixa[1_000], 1);
});

test('faixas de blocos cobrem o intervalo inteiro sem buraco nem sobreposição', () => {
    const f = faixasDeBlocos(100, 250, 50);
    assert.deepEqual(f, [
        [100, 149],
        [150, 199],
        [200, 249],
        [250, 250],
    ]);
});

test('faixa que cabe inteira num pedaço só', () => {
    assert.deepEqual(faixasDeBlocos(10, 20, 100), [[10, 20]]);
});

test('intervalo invertido devolve nada em vez de girar para sempre', () => {
    assert.deepEqual(faixasDeBlocos(200, 100, 10), []);
});

test('o modo descoberta ordena os eventos do mais frequente para o menos', () => {
    // É esta função que substitui o palpite do keccak: sem poder calcular a
    // assinatura nem alcançar a rede, a primeira rodada mede qual evento o
    // contrato realmente emite.
    const logs = [
        { ...logDe({ dividaCrua: 1n }), topics: ['0xAAA'] },
        { ...logDe({ dividaCrua: 1n }), topics: ['0xbbb'] },
        { ...logDe({ dividaCrua: 1n }), topics: ['0xaaa'] },
    ] as LogCru[];
    const c = contarPorTopico(logs);
    assert.equal(c[0].topico, '0xaaa');
    assert.equal(c[0].quantos, 2);
    assert.equal(c[1].quantos, 1);
});

// ----------------------------------------------------------------------
// Reconhecer a recusa por faixa grande demais
// ----------------------------------------------------------------------
test('reconhece a recusa da Alchemy no plano grátis', () => {
    // A frase EXATA que voltou em 18/09, nos 101 pedaços que falharam.
    assert.equal(
        ehLimiteDeFaixa(
            'RPC HTTP 400: Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.',
        ),
        true,
    );
});

test('reconhece as outras formas de dizer a mesma coisa', () => {
    // Cada provedor recusa com a própria frase. Reconhecer a recusa e partir a
    // faixa ao meio serve para todos, inclusive os que ainda não existem.
    for (const m of [
        'query returned more than 10000 results',
        'eth_getLogs block range is too large',
        'too many results, please narrow the range',
        'limit exceeded',
        'query timeout exceeded',
    ]) {
        assert.equal(ehLimiteDeFaixa(m), true, m);
    }
});

test('erro que NÃO é de faixa não vira partição infinita', () => {
    // Importa porque partir ao meio um erro de rede giraria para sempre,
    // dobrando as chamadas a cada rodada até o provedor banir.
    assert.equal(ehLimiteDeFaixa('connection reset by peer'), false);
    assert.equal(ehLimiteDeFaixa('RPC HTTP 401: invalid api key'), false);
    assert.equal(ehLimiteDeFaixa('unauthorized'), false);
});

test('as maiores saem uma a uma, com quem levou cada', () => {
    // O ranking por contagem não separa "cata migalha" de "leva as grandes", e
    // são conclusões opostas. Aqui o ROBO tem 3 capturas contra 1 do OUTRO —
    // ganha no ranking por contagem — e mesmo assim a maior de todas foi do
    // OUTRO. Era essa distinção que faltava.
    const ROBO = '0x1111111111111111111111111111111111111111';
    const OUTRO = '0x2222222222222222222222222222222222222222';
    const ls = [
        decodificarLiquidacao(logDe({ dividaCrua: 1_000_000_000n, liquidante: ROBO })),
        decodificarLiquidacao(logDe({ dividaCrua: 2_000_000_000n, liquidante: ROBO })),
        decodificarLiquidacao(logDe({ dividaCrua: 3_000_000_000n, liquidante: ROBO })),
        decodificarLiquidacao(logDe({ dividaCrua: 900_000_000_000n, liquidante: OUTRO })),
    ];
    const r = resumirHistorico(ls);
    assert.equal(r.maioresLiquidantes[0].endereco, ROBO);
    assert.equal(r.maioresLiquidacoes[0].liquidante, OUTRO);
    assert.equal(r.maioresLiquidacoes[0].usd.toString(), '900000');
    assert.equal(r.maioresLiquidacoes.length, 4);
});

test('liquidação sem cotação não entra na lista das maiores', () => {
    const WETH2 = '0x4200000000000000000000000000000000000006';
    const ls = [
        decodificarLiquidacao(logDe({ dividaCrua: 10n ** 20n, ativoDaDivida: WETH2 })),
        decodificarLiquidacao(logDe({ dividaCrua: 5_000_000_000n })),
    ];
    const r = resumirHistorico(ls);
    assert.equal(r.maioresLiquidacoes.length, 1);
    assert.equal(r.maioresLiquidacoes[0].usd.toString(), '5000');
});

// ----------------------------------------------------------------------
// Corrida ou leilão — a pergunta que decide se dá para competir
// ----------------------------------------------------------------------
test('pagar a taxa mínima é CORRIDA, e dar lance não adianta', () => {
    const m = multiploDaBase({ efetivoWei: new Decimal('1000'), baseWei: new Decimal('1000') });
    assert.equal(m?.toString(), '1');
    assert.match(lerDisputa(m), /CORRIDA/);
});

test('pagar cem vezes a base é LEILÃO, e aí dá para competir com dinheiro', () => {
    const m = multiploDaBase({ efetivoWei: new Decimal('100000'), baseWei: new Decimal('1000') });
    assert.equal(m?.toString(), '100');
    assert.match(lerDisputa(m), /LEILÃO/);
});

test('a razão dispensa a cotação do ETH', () => {
    // O ponto do desenho: responder "corrida ou leilão" sem precisar de um
    // preço que eu não tenho. Dobrar os dois lados não muda a resposta.
    const a = multiploDaBase({ efetivoWei: new Decimal('4000'), baseWei: new Decimal('1000') });
    const b = multiploDaBase({ efetivoWei: new Decimal('8000'), baseWei: new Decimal('2000') });
    assert.equal(a?.toString(), b?.toString());
});

test('taxa base zero devolve null em vez de dividir por zero', () => {
    assert.equal(multiploDaBase({ efetivoWei: new Decimal('1'), baseWei: new Decimal('0') }), null);
    assert.equal(lerDisputa(null), 'sem dado suficiente');
});

test('a gorjeta é só o que passou da base, nunca negativa', () => {
    assert.equal(
        gorjetaWei({
            efetivoWei: new Decimal('3000'),
            baseWei: new Decimal('1000'),
            gasUsado: new Decimal('500000'),
        }).toString(),
        '1000000000',
    );
    // Efetivo abaixo da base não existe em cadeia sã, mas se vier não vira
    // gorjeta negativa somando de volta ao "lucro" do vencedor.
    assert.equal(
        gorjetaWei({
            efetivoWei: new Decimal('500'),
            baseWei: new Decimal('1000'),
            gasUsado: new Decimal('100'),
        }).toString(),
        '0',
    );
});

// ---------------------------------------------------------------------------
// Cotação do ETH: opcional, e rotulada de aproximada quando usada.
// ---------------------------------------------------------------------------

test('dívida em WETH vira dólar SÓ quando alguém informa o preço do ETH', () => {
    const l = decodificarLiquidacao(logDe({ dividaCrua: 2n * 10n ** 18n, ativoDaDivida: WETH }));
    assert.equal(valorEmDolares(l), null, 'sem preço continua sendo null');
    assert.equal(valorEmDolares(l, undefined, new Decimal(3000))?.toString(), '6000');
});

test('preço do ETH zero ou negativo é ignorado — não vira dívida de zero dólar', () => {
    // Uma dívida de 2 ETH avaliada em $0 entraria no relatório como uma
    // liquidação minúscula, e o histograma diria que não há nada grande.
    const l = decodificarLiquidacao(logDe({ dividaCrua: 2n * 10n ** 18n, ativoDaDivida: WETH }));
    assert.equal(valorEmDolares(l, undefined, new Decimal(0)), null);
    assert.equal(valorEmDolares(l, undefined, new Decimal(-1)), null);
});

test('o preço do ETH não contamina as stablecoins', () => {
    const l = decodificarLiquidacao(logDe({ dividaCrua: 250_000_000_000n }));
    assert.equal(valorEmDolares(l, undefined, new Decimal(3000))?.toString(), '250000');
});

test('resumirHistorico repassa o preço e tira as liquidações de "sem cotação"', () => {
    const ls = [
        decodificarLiquidacao(logDe({ dividaCrua: 30n * 10n ** 18n, ativoDaDivida: WETH })),
        decodificarLiquidacao(logDe({ dividaCrua: 1_000_000_000n })),
    ];
    assert.equal(resumirHistorico(ls).semCotacao, 1);

    const comPreco = resumirHistorico(ls, undefined, new Decimal(3000));
    assert.equal(comPreco.semCotacao, 0);
    assert.equal(comPreco.maior?.toString(), '90000', '30 ETH a 3.000 = 90.000');
    assert.equal(comPreco.porFaixa[50_000], 1, 'a que estava escondida era GRANDE');
});

// ---------------------------------------------------------------------------
// Corrida ou leilão: a contagem, porque a mediana errou na primeira medição.
// ---------------------------------------------------------------------------

/** Os oito maiores prêmios da Base em 180 dias, medidos em 18/09. */
const BASE_REAL = [1.3, 1.9, 1.9, 2.2, 4.2, 16.8, 69.6, 2651.3].map((n) => new Decimal(n));

test('os números reais da Base: a mediana diz MISTO e a contagem diz CORRIDA', () => {
    // Este teste existe para travar a correção. A mediana de 4,2x caiu na faixa
    // "MISTO" de lerDisputa, mas metade dos vencedores levou prêmios de seis
    // dígitos pagando menos de 2,5x. Isso é ausência de disputa, não disputa
    // moderada — um único outlier de 2.651x puxou a mediana.
    const ordenados = [...BASE_REAL].sort((a, b) => a.comparedTo(b));
    const mediano = ordenados[Math.floor(ordenados.length / 2)];
    assert.match(lerDisputa(mediano), /MISTO/, 'a leitura antiga, preservada como registro do erro');
    assert.match(lerDisputaPorPiso(BASE_REAL), /CORRIDA/);
    assert.match(lerDisputaPorPiso(BASE_REAL), /4 de 8/);
});

test('um outlier gigante não vira leilão sozinho', () => {
    const quase = [1.1, 1.2, 1.2, 1.3, 1.4, 9000].map((n) => new Decimal(n));
    assert.match(lerDisputaPorPiso(quase), /CORRIDA/);
});

test('leilão de verdade: quase ninguém escapa de pagar caro', () => {
    const leilao = [40, 55, 70, 90, 120, 1.2].map((n) => new Decimal(n));
    assert.match(lerDisputaPorPiso(leilao), /LEILÃO/);
});

test('amostra pequena demais não dá veredicto', () => {
    assert.equal(lerDisputaPorPiso([new Decimal(1), new Decimal(2)]), 'sem dado suficiente');
    assert.equal(lerDisputaPorPiso([]), 'sem dado suficiente');
});

// ---------------------------------------------------------------------------
// Onde no bloco: a medida que o gás não alcança numa rede FCFS.
// ---------------------------------------------------------------------------

test('a posição no bloco não depende do tamanho do bloco', () => {
    // 2 de 200 e 1 de 100 são a mesma coisa: a fração é o que importa.
    const a = lerPosicao([2 / 200, 2 / 200, 2 / 200, 2 / 200].map((n) => new Decimal(n)));
    const b = lerPosicao([1 / 100, 1 / 100, 1 / 100, 1 / 100].map((n) => new Decimal(n)));
    assert.equal(a, b);
});

test('poucos dados não viram leitura de posição', () => {
    assert.equal(lerPosicao([new Decimal(0.1)]), 'sem dado suficiente');
});

// ---------------------------------------------------------------------------
// Onde está o dinheiro: somar, não contar.
// ---------------------------------------------------------------------------

/** n liquidações do mesmo tamanho, em USDC. */
function varias(quantas: number, dolares: number) {
    const cru = BigInt(Math.round(dolares * 1e6));
    return Array.from({ length: quantas }, () => decodificarLiquidacao(logDe({ dividaCrua: cru })));
}

test('a soma e a mediana aparecem no resumo', () => {
    const r = resumirHistorico([...varias(4, 100), ...varias(1, 600)]);
    assert.equal(r.somaCotada.toString(), '1000');
    assert.equal(r.medianaCotada?.toString(), '100', 'a típica é 100, não a média de 200');
});

test('a contagem diz volume e a soma diz o contrário — o buraco que isso fecha', () => {
    // 90 migalhas de $100 e 1 grande de $200.000. Por contagem, 99% das
    // liquidações são migalhas. Por dinheiro, elas são 4,3% do bolo — e é o
    // dinheiro que decide qual bot construir.
    const r = resumirHistorico([...varias(90, 100), ...varias(1, 200_000)]);
    const bolo = repartirOBolo(r);
    assert.equal(r.porFaixa[50_000], 1);
    assert.match(bolo.leitura, /PLANTÃO/);
    assert.equal(bolo.fracaoNasGrandes!.mul(100).toFixed(1), '95.7');
});

test('quando o bolo está mesmo espalhado, ser o louco que pega todas é certo', () => {
    const r = resumirHistorico(varias(500, 2_000));
    const bolo = repartirOBolo(r);
    assert.equal(r.porFaixa[50_000], 0);
    assert.match(bolo.leitura, /volume É o negócio/);
});

test('somaAcimaDe é acumulada para cima, igual a porFaixa', () => {
    const r = resumirHistorico([...varias(1, 60_000), ...varias(1, 120_000)]);
    assert.equal(r.somaAcimaDe[50_000].toString(), '180000');
    assert.equal(r.somaAcimaDe[100_000].toString(), '120000');
    assert.equal(r.somaAcimaDe[500_000].toString(), '0');
});

test('sem nada cotado não há veredicto sobre o bolo', () => {
    const r = resumirHistorico([]);
    assert.equal(repartirOBolo(r).fracaoNasGrandes, null);
    assert.equal(r.medianaCotada, null);
});

test('liquidação sem cotação não entra na soma nem na mediana', () => {
    const semPreco = decodificarLiquidacao(logDe({ dividaCrua: 10n ** 22n, ativoDaDivida: WETH }));
    const r = resumirHistorico([...varias(2, 100), semPreco]);
    assert.equal(r.somaCotada.toString(), '200');
    assert.equal(r.semCotacao, 1);
});

// ---------------------------------------------------------------------------
// Posição no bloco: contar o fundo, não medir o meio.
// ---------------------------------------------------------------------------

/** As oito maiores da Base em 180 dias, medidas em 18/09: fração do bloco. */
const POSICOES_REAIS = [0.001, 0.007, 0.126, 0.167, 0.167, 0.861, 0.895, 0.929].map(
    (n) => new Decimal(n),
);

test('os números reais da Base: a mediana some com as três do fundo', () => {
    // A mediana é 0,167 e a leitura antiga era "INTERMEDIÁRIA". Não há nenhum
    // vencedor intermediário nessa lista: há cinco na frente e três no fundo.
    assert.match(lerPosicao(POSICOES_REAIS), /TEM ESPAÇO/);
    assert.match(lerPosicao(POSICOES_REAIS), /3 de 8/);
});

test('sem ninguém no fundo, a porta está fechada', () => {
    const sofrente = [0.001, 0.004, 0.01, 0.02, 0.03].map((n) => new Decimal(n));
    assert.match(lerPosicao(sofrente), /NINGUÉM GANHOU DO FUNDO/);
});

test('uma só no fundo já conta — é prova de existência, não maioria', () => {
    const uma = [0.01, 0.02, 0.03, 0.04, 0.88].map((n) => new Decimal(n));
    assert.match(lerPosicao(uma), /TEM ESPAÇO/);
    assert.match(lerPosicao(uma), /1 de 5/);
});

// ---------------------------------------------------------------------------
// Sozinha ou no monte.
// ---------------------------------------------------------------------------

test('grande cercada de outras = pânico, os robôs saturaram', () => {
    const todas = [1000, 1001, 1002, 1003, 1004].map((b) =>
        decodificarLiquidacao(logDe({ dividaCrua: 100_000_000n, bloco: b })),
    );
    const a = aglomeracao(todas, [{ usd: new Decimal(200_000), bloco: 1002 }]);
    assert.equal(a.emMonte, 1);
    assert.match(a.leitura, /PÂNICO/);
    assert.match(a.detalhe[0], /4 outras/, 'a própria não se conta');
});

test('grande isolada = ninguém estava olhando', () => {
    const todas = [1000, 9000, 9001].map((b) =>
        decodificarLiquidacao(logDe({ dividaCrua: 100_000_000n, bloco: b })),
    );
    const a = aglomeracao(todas, [{ usd: new Decimal(200_000), bloco: 1000 }]);
    assert.equal(a.sozinhas, 1);
    assert.match(a.leitura, /DESPERCEBIDAS/);
    assert.match(a.detalhe[0], /0 outras/);
});

test('a janela é em blocos e conta dos dois lados', () => {
    const todas = [970, 1000, 1030, 1031].map((b) =>
        decodificarLiquidacao(logDe({ dividaCrua: 100_000_000n, bloco: b })),
    );
    const a = aglomeracao(todas, [{ usd: new Decimal(1), bloco: 1000 }], 30);
    assert.match(a.detalhe[0], /2 outras/, '970 e 1030 entram; 1031 fica de fora');
});

// ---------------------------------------------------------------------------
// O bônus: lido do contrato, não chutado.
// ---------------------------------------------------------------------------

/** Monta um bitmap de configuração da Aave com o bônus no lugar certo. */
function configComBonus(centesimos: bigint): string {
    const bitmap = (centesimos << 32n) | 8000n | (8500n << 16n);
    return `0x${bitmap.toString(16).padStart(64, '0')}`;
}

test('10500 nos bits 32-47 quer dizer bônus de 5%, não de 105%', () => {
    // O valor traz os 100% embutidos. Ler 10500 como "105% de lucro" infla o
    // resultado em vinte vezes — a mesma ordem de grandeza que eu já errei.
    assert.equal(bonusDeLiquidacao(configComBonus(10_500n))?.mul(100).toFixed(2), '5.00');
    assert.equal(bonusDeLiquidacao(configComBonus(11_000n))?.mul(100).toFixed(2), '10.00');
    assert.equal(bonusDeLiquidacao(configComBonus(10_750n))?.mul(100).toFixed(2), '7.50');
});

test('os outros campos da configuração não vazam para o bônus', () => {
    // LTV e limiar ficam nos bits 0-31 e são diferentes em cada linha; o bônus
    // tem de sair igual nas duas.
    const a = (10_500n << 32n) | 8000n | (8500n << 16n);
    const b = (10_500n << 32n) | 4500n | (5000n << 16n);
    assert.equal(
        bonusDeLiquidacao(`0x${a.toString(16).padStart(64, '0')}`)?.toString(),
        bonusDeLiquidacao(`0x${b.toString(16).padStart(64, '0')}`)?.toString(),
    );
});

test('bônus zero é "não sei", não é bônus de zero por cento', () => {
    // Ativo que não serve de garantia. Tratar como 0% faria o relatório dizer
    // que aquela liquidação não pagou nada, que é uma afirmação diferente.
    assert.equal(bonusDeLiquidacao(configComBonus(0n)), null);
    assert.equal(bonusDeLiquidacao('0x'), null);
    assert.equal(bonusDeLiquidacao('0xabcd'), null);
});

test('o lucro é o ágio, não a dívida', () => {
    const lucro = lucroBruto(new Decimal(255_485), new Decimal('0.05'));
    assert.equal(lucro.toFixed(0), '12774');
});

test('a chamada carrega o ativo em palavra de 32 bytes', () => {
    const c = chamadaDeConfiguracao('0x4200000000000000000000000000000000000006');
    assert.ok(c.startsWith('0xc44b11f7'));
    assert.equal(c.length, 10 + 64);
    assert.ok(c.endsWith('4200000000000000000000000000000000000006'));
});

// ---------------------------------------------------------------------------
// A janela: quanto tempo a porta fica aberta.
// ---------------------------------------------------------------------------

/** Uma liquidação do mesmo devedor, num bloco e transação escolhidos. */
function doDevedor(devedor: string, bloco: number, tx: string) {
    return {
        ...decodificarLiquidacao({
            ...logDe({ dividaCrua: 100_000_000n, bloco }),
            topics: [
                '0xtopic0',
                `0x${palavra(WETH)}`,
                `0x${palavra(USDC)}`,
                `0x${palavra(devedor)}`,
            ],
        }),
        transacao: tx,
    };
}

const DEV_A = '0xaaaa000000000000000000000000000000000001';
const DEV_B = '0xbbbb000000000000000000000000000000000002';

test('devedor que aparece uma vez só não vira par', () => {
    const j = janelaDeOportunidade([doDevedor(DEV_A, 100, '0x1')]);
    assert.equal(j.pares, 0);
    assert.match(j.leitura, /sem dado suficiente/);
});

test('pares do mesmo bloco dizem que a porta fecha na hora', () => {
    const ls = [
        doDevedor(DEV_A, 100, '0x1'),
        doDevedor(DEV_A, 100, '0x2'),
        doDevedor(DEV_B, 500, '0x3'),
        doDevedor(DEV_B, 500, '0x4'),
    ];
    const j = janelaDeOportunidade(ls);
    assert.equal(j.mesmoBloco, 2);
    assert.match(j.leitura, /PORTA FECHA NA HORA/);
});

test('janela folgada em blocos vira segundos e vira "dá tempo"', () => {
    const ls = [
        doDevedor(DEV_A, 100, '0x1'),
        doDevedor(DEV_A, 140, '0x2'),
        doDevedor(DEV_B, 500, '0x3'),
        doDevedor(DEV_B, 560, '0x4'),
    ];
    const j = janelaDeOportunidade(ls, 2);
    assert.equal(j.medianaBlocos, 60);
    assert.equal(j.medianaSegundos, 120);
    assert.match(j.leitura, /DÁ TEMPO/);
});

test('a mesma transação não conta como disputa', () => {
    // Um liquidante fechando duas posições do mesmo devedor de uma vez é uma
    // ação só. Contar isso como "mesmo bloco" inventaria uma corrida.
    const ls = [doDevedor(DEV_A, 100, '0xigual'), doDevedor(DEV_A, 100, '0xigual')];
    assert.equal(janelaDeOportunidade(ls).pares, 0);
});

test('pares muito distantes são descartados, não viram janelas gigantes', () => {
    // Dois episódios separados por semanas não são uma porta aberta por
    // semanas. Entrar com esse número inflaria a mediana e mentiria a favor.
    const ls = [doDevedor(DEV_A, 100, '0x1'), doDevedor(DEV_A, 900_000, '0x2')];
    assert.equal(janelaDeOportunidade(ls, 2, 1800).pares, 0);
});

test('o tempo de bloco da rede é respeitado', () => {
    const ls = [doDevedor(DEV_A, 100, '0x1'), doDevedor(DEV_A, 110, '0x2')];
    // Na Base cada bloco são 2s; na Ethereum, 12s. Mesma janela em blocos,
    // conclusões diferentes em segundos.
    assert.equal(janelaDeOportunidade(ls, 2).medianaSegundos, 20);
    assert.equal(janelaDeOportunidade(ls, 12).medianaSegundos, 120);
});

// ---------------------------------------------------------------------------
// Cada rede tem a sua tabela de moedas.
// ---------------------------------------------------------------------------

test('a tabela à mão virou reserva — quem manda é a descoberta no pool', () => {
    // Já não é obrigatória: as redes baratas nascem sem tabela de propósito,
    // porque escrever endereço de memória é o erro que se quer parar de
    // cometer. Mas quem TEM uma não pode tê-la vazia.
    for (const [nome, rede] of Object.entries(REDES)) {
        if (rede.tokens === undefined) continue;
        assert.ok(Object.keys(rede.tokens).length > 0, `${nome} com tabela vazia`);
    }
});

test('toda rede diz o que paga o gás nela', () => {
    // Nem toda rede cobra em ETH. Converter gás de Polygon pelo preço do ETH
    // daria um custo 1.000 vezes maior do que o real.
    for (const [nome, rede] of Object.entries(REDES)) {
        assert.ok(rede.moedaNativa.length > 0, `${nome} sem moeda nativa`);
    }
});

test('o USDC da Base não é o USDC da Ethereum', () => {
    // O bug que isso trava: rodar a Ethereum com a tabela da Base devolve
    // varredura completa, zero falhas e 100% sem cotação — com cara de
    // resposta, não de defeito.
    const achar = (t: Record<string, Token> | undefined) =>
        Object.keys(t ?? {}).find((k) => t![k].simbolo === 'USDC');
    const usdcBase = achar(REDES.base.tokens);
    const usdcEth = achar(REDES.ethereum.tokens);
    assert.ok(usdcBase && usdcEth);
    assert.notEqual(usdcBase, usdcEth);
});

test('os endereços das tabelas estão em minúsculas — a busca depende disso', () => {
    for (const [nome, rede] of Object.entries(REDES)) {
        for (const k of Object.keys(rede.tokens ?? {})) {
            assert.equal(k, k.toLowerCase(), `${nome}: ${k}`);
            assert.match(k, /^0x[0-9a-f]{40}$/, `${nome}: ${k}`);
        }
    }
});

test('a rede que TEM tabela sabe cotar um estável e o WETH dela', () => {
    for (const [nome, rede] of Object.entries(REDES)) {
        if (rede.tokens === undefined) continue;
        const vs = Object.values(rede.tokens);
        assert.ok(vs.some((t) => t.estavel), `${nome} sem estável`);
        assert.ok(vs.some((t) => t.emEth), `${nome} sem WETH`);
    }
});

test('a tabela errada faz a dívida virar null, não um número torto', () => {
    // O USDC da Ethereum lido com a tabela da Base: endereço desconhecido.
    const l = decodificarLiquidacao(
        logDe({ dividaCrua: 250_000_000_000n, ativoDaDivida: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }),
    );
    assert.equal(valorEmDolares(l, REDES.base.tokens), null);
    assert.equal(valorEmDolares(l, REDES.ethereum.tokens)?.toString(), '250000');
});

// ---------------------------------------------------------------------------
// Sondagem de RPC: descobrir em vez de chutar.
// ---------------------------------------------------------------------------

test('a mensagem do drpc é reconhecida como teto de faixa', () => {
    // 648 de 649 pedaços morreram com esta, e ehLimiteDeFaixa não a conhecia.
    assert.ok(ehLimiteDeFaixa('ranges over 10000 blocks are not supported on free plan'));
});

test('as mensagens que já eram reconhecidas continuam sendo', () => {
    assert.ok(ehLimiteDeFaixa('block range is too wide'));
    assert.ok(ehLimiteDeFaixa('query returned more than 10000 results'));
    assert.ok(ehLimiteDeFaixa('limit exceeded'));
    assert.equal(ehLimiteDeFaixa('execution reverted'), false);
    assert.equal(ehLimiteDeFaixa('connection reset'), false);
});

test('ganha o RPC que aguenta o maior pedaço', () => {
    const melhor = escolherMelhorRpc([
        { rpc: 'a', maiorFaixa: 10 },
        { rpc: 'b', maiorFaixa: 2000 },
        { rpc: 'c', maiorFaixa: 100 },
    ]);
    assert.equal(melhor?.rpc, 'b');
});

test('nenhum servindo devolve null, e não o "menos ruim"', () => {
    assert.equal(
        escolherMelhorRpc([
            { rpc: 'a', maiorFaixa: 0, erro: 'sem histórico' },
            { rpc: 'b', maiorFaixa: 0, erro: 'sem histórico' },
        ]),
        null,
    );
    assert.equal(escolherMelhorRpc([]), null);
});

test('a estimativa de tempo separa vinte minutos de cinco horas', () => {
    // O ponto: 1.296.000 blocos de dez em dez são 129.600 pedidos. Esse número
    // precisa aparecer ANTES da espera, não depois.
    const dezEmDez = minutosEstimados(1_296_000, 10, 0.3);
    const doisMil = minutosEstimados(1_296_000, 2000, 0.3);
    assert.ok(dezEmDez > 600, `${dezEmDez} minutos`);
    assert.ok(doisMil < 5, `${doisMil} minutos`);
    assert.equal(minutosEstimados(1000, 0), Infinity);
});

test('toda rede tem RPC alternativo para sondar', () => {
    for (const nome of Object.keys(REDES)) {
        assert.ok((RPCS_PARA_TENTAR[nome] ?? []).length > 0, `${nome} sem alternativa`);
    }
});

test('os tamanhos de sondagem vão do menor ao maior', () => {
    // A sondagem para no primeiro que falha, então a ordem é o algoritmo.
    const ordenado = [...TAMANHOS_PARA_SONDAR].sort((a, b) => a - b);
    assert.deepEqual(TAMANHOS_PARA_SONDAR, ordenado);
});

// ---------------------------------------------------------------------------
// Descobrir as moedas no pool, em vez de escrever de memória.
// ---------------------------------------------------------------------------

/** Codifica um array de endereços como o ABI devolve. */
function abiEnderecos(lista: string[]): string {
    const cab = (32).toString(16).padStart(64, '0');
    const n = lista.length.toString(16).padStart(64, '0');
    return `0x${cab}${n}${lista.map((e) => e.replace(/^0x/, '').padStart(64, '0')).join('')}`;
}

test('a lista de reservas do pool é lida direito', () => {
    const lista = ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x6B175474E89094C44Da98b954EedeAC495271d0F'];
    const fora = decodificarListaDeEnderecos(abiEnderecos(lista));
    assert.deepEqual(fora, lista.map((e) => e.toLowerCase()));
});

test('lista vazia é lista vazia, e resposta curta não quebra', () => {
    assert.deepEqual(decodificarListaDeEnderecos(abiEnderecos([])), []);
    assert.deepEqual(decodificarListaDeEnderecos('0x'), []);
    assert.deepEqual(decodificarListaDeEnderecos('0xabcd'), []);
});

test('symbol() é lido tanto no formato string quanto no bytes32 antigo', () => {
    const comoString =
        '0x' +
        (32).toString(16).padStart(64, '0') +
        (4).toString(16).padStart(64, '0') +
        Buffer.from('USDC').toString('hex').padEnd(64, '0');
    assert.equal(decodificarTexto(comoString), 'USDC');
    // MKR e outros tokens antigos devolvem bytes32 cru, sem cabeçalho.
    assert.equal(decodificarTexto(`0x${Buffer.from('DAI').toString('hex').padEnd(64, '0')}`), 'DAI');
});

test('a classificação acerta estável, ETH e desconhecido', () => {
    assert.equal(classificarToken('USDC', 6).estavel, true);
    assert.equal(classificarToken('USDbC', 6).estavel, true);
    assert.equal(classificarToken('DAI', 18).estavel, true);
    assert.equal(classificarToken('GHO', 18).estavel, true);
    assert.equal(classificarToken('WETH', 18).emEth, true);
    assert.equal(classificarToken('WBTC', 8).estavel, false);
    assert.equal(classificarToken('WBTC', 8).emEth, undefined);
});

test('wstETH e weETH NÃO entram como ETH — valem mais que um ETH', () => {
    // Marcá-los como emEth subestimaria a dívida em uns 20%, e o histograma
    // diria que não há nada grande. "Sem cotação" é a resposta correta.
    assert.equal(classificarToken('wstETH', 18).emEth, undefined);
    assert.equal(classificarToken('weETH', 18).emEth, undefined);
    assert.equal(classificarToken('rsETH', 18).emEth, undefined);
});

test('as redes baratas nascem sem tabela, mas com RPC para sondar', () => {
    for (const nome of REDES_BARATAS) {
        assert.ok(REDES[nome], `${nome} não existe em REDES`);
        assert.ok((RPCS_PARA_TENTAR[nome] ?? []).length > 0, `${nome} sem RPC`);
    }
});
