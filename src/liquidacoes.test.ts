import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    contarPorTopico,
    decodificarLiquidacao,
    ehLimiteDeFaixa,
    gorjetaWei,
    lerDisputa,
    multiploDaBase,
    enderecoDoTopico,
    faixasDeBlocos,
    resumirHistorico,
    valorEmDolares,
    type LogCru,
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
