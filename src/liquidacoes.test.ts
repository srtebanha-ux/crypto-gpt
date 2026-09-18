import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    contarPorTopico,
    decodificarLiquidacao,
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
