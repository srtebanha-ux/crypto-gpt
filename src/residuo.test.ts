// A regra de resíduo: os CASOS MEDIDOS em fork, um a um.
//
// Cada caso aqui é uma linha da bisseção de 2026-10-10. Se alguma sessão
// futura "otimizar" o tamanho, estes casos dizem o que a Aave respondeu de
// verdade — e o teste reprova quem contrariar a medição.
import test from 'node:test';
import assert from 'node:assert';
import { coberturaQuePassa, comoLerOTamanho, RESTO_EXIGIDO_USD, FOLGA_DO_RESTO } from './residuo';

/** Dívida em USDC cru (6 casas) a partir do dólar. */
const cru = (usd: number) => BigInt(Math.round(usd * 1e6));

test('dívida abaixo do resto exigido: INLIQUIDÁVEL nos dois regimes (medido)', () => {
    // US$ 300, US$ 500 e US$ 1000: a bisseção devolveu NENHUMA cobertura
    // aceita, com saúde 0,999 E com 0,93.
    for (const usd of [300, 500, 1000]) {
        for (const abaixo of [false, true]) {
            const r = coberturaQuePassa({ dividaCrua: cru(usd), dividaUsd: usd, saudeAbaixoDeNoventaECinco: abaixo });
            assert.equal(r.inliquidavel, true, `US$ ${usd} saúde<0,95=${abaixo} deveria ser inliquidável`);
            assert.match(comoLerOTamanho(cru(usd) / 2n, r), /INLIQUIDÁVEL/);
        }
    }
});

test('US$ 1500: metade é RECUSADA, e existe cobertura menor que passa (medido)', () => {
    const r = coberturaQuePassa({ dividaCrua: cru(1500), dividaUsd: 1500, saudeAbaixoDeNoventaECinco: false });
    assert.equal(r.metadeSeriaRecusada, true);
    assert.equal(r.inliquidavel, false);
    // A bisseção mediu 499,84 USDC aceitos. Com a folga de 2% a conta dá menos
    // que isso, e MENOS é o lado seguro: pedir menos deixa resto maior.
    assert.ok(r.cobrir < cru(1500) / 2n, 'a cobertura que passa é MENOR que metade');
    assert.ok(r.cobrir <= cru(499.84), `pediu ${r.cobrir}, acima do que a Aave aceitou`);
    assert.ok(r.cobrir > 0n);
});

test('US$ 2100, 3000 e 5000 com saúde ~0,999: metade passa, e é o que se pede', () => {
    for (const usd of [2100, 3000, 5000]) {
        const r = coberturaQuePassa({ dividaCrua: cru(usd), dividaUsd: usd, saudeAbaixoDeNoventaECinco: false });
        assert.equal(r.metadeSeriaRecusada, false);
        assert.equal(r.cobrir, cru(usd) / 2n, `US$ ${usd}: deveria pedir metade`);
        assert.match(comoLerOTamanho(cru(usd) / 2n, r), /metade, e ela passa/);
    }
});

test('saúde abaixo de 0,95: a cobertura aceita PASSA de metade — o ganho medido', () => {
    // Medido: US$ 5.000 com saúde 0,93 aceitou 3.999,84 = 80% da dívida.
    const r = coberturaQuePassa({ dividaCrua: cru(5000), dividaUsd: 5000, saudeAbaixoDeNoventaECinco: true });
    assert.ok(r.cobrir > cru(5000) / 2n, 'com saúde baixa a cobertura passa de metade');
    const razao = Number(r.cobrir) / Number(cru(5000) / 2n);
    assert.ok(razao > 1.5 && razao <= 1.61, `ganho medido foi ~1,6x, deu ${razao.toFixed(2)}x`);
    assert.match(r.porque, /é aí que há ganho/);
    // E o ganho que importa é o LÍQUIDO, medido por envio na grade de 10/10:
    // 75% rendeu US$ 3.917,63 contra US$ 2.614,15 da metade, com o MESMO gás.
    // Razão de LUCRO = 1,50x — e não o 1,6x de dívida coberta que eu publiquei.
    const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, 'residuo.ts'), 'utf8');
    assert.match(fonte, /LIQUIDO USD/, 'a tabela de lucro líquido fica no arquivo');
    assert.match(fonte, /1,50x/, 'e a razão é de LUCRO, não de dívida coberta');
    // O "1,6x" só pode aparecer sendo RETRATADO, nunca como afirmação.
    // (A primeira versão deste assert proibia a string inteira e reprovou a
    // própria retratação — a regra certa é sobre o CONTEXTO, não a palavra.)
    for (const linha of fonte.split('\n').filter((x: string) => x.includes('1,6x'))) {
        assert.match(linha, /nao em|era a/,
            `"1,6x" aparece sem retratação: ${linha.trim()}`);
    }
    // E o resto que sobra respeita o exigido COM folga.
    const resto = 5000 - Number(r.cobrir) / 1e6;
    assert.ok(resto >= RESTO_EXIGIDO_USD, `resto ${resto} abaixo do exigido`);
});

test('US$ 3000 com saúde 0,93: 66,7% foi aceito, e a conta não passa disso', () => {
    const r = coberturaQuePassa({ dividaCrua: cru(3000), dividaUsd: 3000, saudeAbaixoDeNoventaECinco: true });
    assert.ok(r.cobrir <= cru(1999.84), `pediu ${r.cobrir}, acima dos 1999,84 que a Aave aceitou`);
    assert.ok(r.cobrir > cru(3000) / 2n, 'e ainda assim mais que metade');
});

test('a FOLGA existe e empurra para o lado seguro', () => {
    assert.ok(FOLGA_DO_RESTO > 1, 'mirar o resto exato é mirar a borda: o juro corre');
    const r = coberturaQuePassa({ dividaCrua: cru(5000), dividaUsd: 5000, saudeAbaixoDeNoventaECinco: true });
    const resto = 5000 - Number(r.cobrir) / 1e6;
    assert.ok(resto > RESTO_EXIGIDO_USD, 'o resto deixado é MAIOR que o exigido, não igual');
});

test('sem a dívida em dólares: metade, e a frase DIZ que não sabe', () => {
    const r = coberturaQuePassa({ dividaCrua: cru(5000), dividaUsd: null, saudeAbaixoDeNoventaECinco: true });
    assert.equal(r.cobrir, cru(5000) / 2n, 'ausência não muda o comportamento de hoje');
    assert.equal(r.inliquidavel, false, 'e ausência NÃO é "inliquidável"');
    assert.match(r.porque, /não sei onde cai o resíduo/);
});

test('o resto exigido é MEDIDO, e o comentário diz de onde veio', () => {
    // Cinco casos independentes da bisseção deixaram US$ 1000,16.
    assert.ok(Math.abs(RESTO_EXIGIDO_USD - 1000.16) < 0.01);
    const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, 'residuo.ts'), 'utf8');
    assert.match(fonte, /CINCO casos independentes/, 'a origem do número fica no arquivo');
    assert.match(fonte, /O QUE ISTO NAO PROVA/, 'e os buracos também');
    assert.match(fonte, /nao foi lida no TRACE/, 'e o limite do método');
});
