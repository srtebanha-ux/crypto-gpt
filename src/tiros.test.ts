import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    lerRecibo, placarVazio, contarTiro, comoEstaIndo, placarParaCache, placarDoCache,
    oQueACorrenteDiz,
} from './tiros';

const D = (n: number) => new Decimal(n);

test('só status 1 é acerto', () => {
    assert.equal(lerRecibo({ status: 1 }), 'acertou');
    assert.equal(lerRecibo({ status: 0 }), 'reverteu');
});

test('recibo ausente NÃO é acerto, e tem nome próprio', () => {
    // Transação que não foi minerada no tempo esperado. Tratar isso como
    // acerto faria o bot contar lucro que não existe; tratar como silêncio
    // esconderia que ela ficou parada.
    assert.equal(lerRecibo(null), 'sumiu');
    assert.equal(lerRecibo(undefined), 'sumiu');
    assert.equal(lerRecibo({}), 'reverteu');
});

test('o lucro só entra quando o tiro acertou', () => {
    let p = placarVazio();
    p = contarTiro(p, 'reverteu', D(91));
    p = contarTiro(p, 'sumiu', D(91));
    assert.equal(p.lucroEstimadoUsd.toNumber(), 0, 'tiro que não acertou não pode somar lucro');
    p = contarTiro(p, 'acertou', D(91));
    assert.equal(p.lucroEstimadoUsd.toNumber(), 91);
});

test('acerto sem cotação conta como acerto, mas não inventa valor', () => {
    const p = contarTiro(placarVazio(), 'acertou', null);
    assert.equal(p.acertou, 1);
    assert.equal(p.lucroEstimadoUsd.toNumber(), 0);
});

test('só reversões dizem "corrida perdida", não "falta de alvo"', () => {
    // A diferença decide o conserto: perder por pouco pede velocidade,
    // não achar alvo pede cobertura.
    let p = placarVazio();
    for (let i = 0; i < 3; i++) p = contarTiro(p, 'reverteu', D(91));
    const frase = comoEstaIndo(p);
    assert.ok(frase.includes('outro chegou antes'), frase);
    assert.ok(frase.includes('3 de 3'), frase);
});

test('sem tiro nenhum não acusa nada — mas diz "que eu lembre"', () => {
    // "ainda" afirma sobre o passado INTEIRO com a memória do boot de agora.
    // O placar vive num cache que pode não ter montado, então a frase só pode
    // falar do que ela lembra.
    assert.equal(comoEstaIndo(placarVazio()), 'Nenhum tiro que eu lembre.');
});

test('o NONCE contradiz o placar quando a memória se perdeu', () => {
    // MEDIDO em 2026-10-06: o nonce da conta_bot estava em 6 — duas transações
    // tinham saído — e o log imprimia "Nenhum tiro ainda". O placar morava em
    // memória e o container reinicia várias vezes por dia. Meia hora de
    // investigação para descobrir que a ausência era de MEMÓRIA, não de tiro.
    const frase = comoEstaIndo(placarVazio(), 6);
    assert.ok(frase.includes('Nenhum tiro que eu lembre'), frase);
    assert.ok(frase.includes('6 transações'), frase);
    assert.ok(frase.includes('6 saíram sem eu lembrar'), frase);
    assert.ok(frase.includes('basescan'), frase);
});

test('o nonce em acordo com o placar não acrescenta ruído', () => {
    let p = placarVazio();
    p = contarTiro(p, 'reverteu', null);
    p = contarTiro(p, 'reverteu', null);
    // Dois tiros contados, duas transações na corrente: nada a dizer.
    assert.equal(oQueACorrenteDiz(p, 2), null);
    // E nonce MENOR que o placar também não acusa: acontece entre o envio e o
    // `sync`, e inventar "você contou demais" sobre isso seria falso.
    assert.equal(oQueACorrenteDiz(p, 1), null);
});

test('nonce desconhecido não vira afirmação', () => {
    // `nonceConhecido()` devolve -1 quando não sabe, e "não sei" não pode
    // virar "zero transações saíram".
    assert.equal(oQueACorrenteDiz(placarVazio(), -1), null);
    assert.equal(oQueACorrenteDiz(placarVazio(), null), null);
    assert.equal(oQueACorrenteDiz(placarVazio(), undefined), null);
    assert.equal(oQueACorrenteDiz(placarVazio(), Number.NaN), null);
});

test('o placar atravessa o disco inteiro, com o lucro em texto', () => {
    // JSON.stringify de um Decimal grava os internos da biblioteca
    // ({"s":1,"e":1,"d":[91,4]}), que `new Decimal` não lê de volta: o lucro
    // voltaria zero em silêncio.
    let p = placarVazio();
    p = contarTiro(p, 'acertou', D(91.4));
    p = contarTiro(p, 'reverteu', null);
    p = contarTiro(p, 'sumiu', null);
    const naVolta = placarDoCache(JSON.parse(JSON.stringify(placarParaCache(p))));
    assert.equal(naVolta.disparados, 3);
    assert.equal(naVolta.acertou, 1);
    assert.equal(naVolta.reverteu, 1);
    assert.equal(naVolta.sumiu, 1);
    assert.equal(naVolta.lucroEstimadoUsd.toFixed(2), '91.40');
});

test('cache velho ou torto volta como placar vazio, nunca como lixo', () => {
    // Um cache gravado antes deste campo não tem nada aqui, e um adulterado
    // pode ter qualquer coisa. Perder a contagem é barato; contar errado não.
    for (const torto of [undefined, null, 42, 'nada', [], { acertou: 'dois' }]) {
        const p = placarDoCache(torto);
        assert.equal(p.disparados, 0, `${JSON.stringify(torto)} não pode virar tiro`);
        assert.equal(p.lucroEstimadoUsd.toNumber(), 0);
    }
});

test('o denominador nunca fica menor que a soma das partes', () => {
    // Um arquivo editado à mão (ou cortado) pode ter `disparados` menor que a
    // soma dos desfechos. Aceitar isso faria a taxa de acerto passar de 100%.
    const p = placarDoCache({
        disparados: 1, acertou: 2, reverteu: 3, sumiu: 1, lucroEstimadoUsd: '10',
    });
    assert.equal(p.disparados, 6);
    assert.ok(comoEstaIndo(p).includes('2 de 6'), comoEstaIndo(p));
});

test('lucro negativo ou não-numérico no disco não contamina o placar', () => {
    assert.equal(placarDoCache({ acertou: 1, lucroEstimadoUsd: '-500' }).lucroEstimadoUsd.toNumber(), 0);
    assert.equal(placarDoCache({ acertou: 1, lucroEstimadoUsd: 'abacaxi' }).lucroEstimadoUsd.toNumber(), 0);
    assert.equal(placarDoCache({ acertou: 1, lucroEstimadoUsd: 91.4 }).lucroEstimadoUsd.toNumber(), 0);
});

test('com acerto, o placar mostra taxa e dinheiro', () => {
    let p = placarVazio();
    p = contarTiro(p, 'acertou', D(91.4));
    p = contarTiro(p, 'reverteu', D(50));
    const frase = comoEstaIndo(p);
    assert.ok(frase.includes('1 de 2'));
    assert.ok(frase.includes('50%'));
    assert.ok(frase.includes('91.40'));
});

test('o total é sempre a soma dos desfechos', () => {
    // O bug que este teste guarda: `disparados` não era incrementado, então o
    // placar dizia "nenhum tiro ainda" depois de atirar três vezes.
    let p = placarVazio();
    p = contarTiro(p, 'acertou', D(10));
    p = contarTiro(p, 'reverteu', null);
    p = contarTiro(p, 'sumiu', null);
    assert.equal(p.disparados, 3);
    assert.equal(p.acertou + p.reverteu + p.sumiu, p.disparados);
});

test('o placar diz ESTIMADO, não "no cofre"', () => {
    // O número vem da medição por eth_call do bloco anterior, e o contrato só
    // garante 80% dela (lucroMinimo). Chamar isso de "no cofre" apresentava
    // estimativa como caixa, com até 20% de sobra para cima.
    let p = placarVazio();
    p = contarTiro(p, 'acertou', D(88));
    const frase = comoEstaIndo(p);
    assert.ok(frase.includes('estimados'), frase);
    assert.ok(frase.includes('confira o cofre'), frase);
    assert.ok(!frase.includes('no cofre.'), 'não pode afirmar que o dinheiro está lá');
});

test('7 apostas revertidas NÃO dizem "outro chegou antes" — o caso real de 2026-10-08', () => {
    // MEDIDO: o log das 12:29 imprimiu "7 de 7 reverteram: outro chegou antes.
    // É corrida perdida por pouco" sobre os SETE tiros especulativos de 07/10.
    // Ninguém chegou antes: a posição nunca cruzou. Em 07/10 eu consertei
    // exatamente essa frase na linha [ERROU] e deixei a gêmea solta aqui.
    let p = placarVazio();
    for (let i = 0; i < 7; i++) p = contarTiro(p, 'reverteu', null, true);
    const frase = comoEstaIndo(p);
    assert.ok(!frase.includes('outro chegou antes'), frase);
    assert.ok(frase.includes('não cruzou'), frase);
    assert.ok(frase.includes('7 de 7'), frase);
    // E diz o que NÃO consertar: lance maior não evitaria nenhuma.
    assert.ok(frase.includes('lance maior'), frase);
});

test('mistura de aposta e corrida separa as duas, porque pedem conserto oposto', () => {
    let p = placarVazio();
    for (let i = 0; i < 3; i++) p = contarTiro(p, 'reverteu', null, true);
    for (let i = 0; i < 2; i++) p = contarTiro(p, 'reverteu', null, false);
    const frase = comoEstaIndo(p);
    assert.ok(frase.includes('3 eram aposta'), frase);
    assert.ok(frase.includes('2 em posição já liquidável'), frase);
    assert.ok(frase.includes('outro chegou antes'), frase);
});

test('os especulativos atravessam o disco, e cache velho não quebra', () => {
    let p = placarVazio();
    p = contarTiro(p, 'reverteu', null, true);
    p = contarTiro(p, 'reverteu', null, false);
    const volta = placarDoCache(JSON.parse(JSON.stringify(placarParaCache(p))));
    assert.equal(volta.especulativos, 1);
    assert.equal(volta.disparados, 2);
    // Cache gravado antes de 2026-10-08 não tem o campo: `null` — "não
    // registrei" —, e NÃO zero. Esta linha afirmava zero, e era ela que
    // deixava a frase errada passar: ver o teste "cache SEM o campo não
    // escolhe lado", que é o caso real de produção.
    assert.equal(placarDoCache({ disparados: 5, reverteu: 5 }).especulativos, null);
    // E um campo adulterado não pode afirmar mais apostas do que tiros.
    assert.equal(placarDoCache({ disparados: 2, reverteu: 2, especulativos: 99 }).especulativos, 2);
});

test('cache SEM o campo não escolhe lado — o defeito do log de 13:14', () => {
    // MEDIDO: com o conserto JÁ no ar, o log das 13:14 imprimiu a frase errada
    // outra vez. Os sete tiros foram contados antes de o campo existir,
    // voltaram do disco como `0 especulativos`, e `0 >= 7` é falso — então a
    // frase caiu no ramo "outro chegou antes" e afirmou com confiança
    // exatamente o que o conserto existia para impedir. Para sempre, porque
    // aquele cache nunca vai aprender o tipo deles.
    //
    // Campo ausente virando zero, e o zero publicado como fato positivo:
    // a assinatura deste projeto, cometida DENTRO do conserto dela.
    const velho = placarDoCache({ disparados: 7, reverteu: 7, lucroEstimadoUsd: '0' });
    assert.equal(velho.especulativos, null);
    const frase = comoEstaIndo(velho, 14);
    assert.ok(!frase.includes('outro chegou antes'), frase);
    assert.ok(frase.includes('NÃO REGISTREI'), frase);
    assert.ok(frase.includes('7 de 7'), frase);

    // Zero REGISTRADO continua sendo resposta: sete corridas perdidas de
    // verdade dizem "outro chegou antes", e é a frase certa para elas.
    const medidoZero = placarDoCache({ disparados: 7, reverteu: 7, especulativos: 0 });
    assert.equal(medidoZero.especulativos, 0);
    assert.ok(comoEstaIndo(medidoZero).includes('outro chegou antes'));

    // Campo torto é `null`, não um número inventado: não sei é melhor que sei errado.
    assert.equal(placarDoCache({ disparados: 2, reverteu: 2, especulativos: '1' }).especulativos, null);
    assert.equal(placarDoCache({ disparados: 2, reverteu: 2, especulativos: -3 }).especulativos, null);
    assert.equal(placarDoCache({ disparados: 2, reverteu: 2, especulativos: 1.5 }).especulativos, null);

    // E `null` não vai ao disco: a ausência no arquivo já diz "não registrei".
    assert.equal('especulativos' in placarParaCache(velho), false);

    // Um tiro novo em cima do cache antigo adota o zero e passa a registrar.
    const depois = contarTiro(velho, 'reverteu', null, true);
    assert.equal(depois.especulativos, 1);
    assert.ok(comoEstaIndo(depois).includes('1 eram aposta'), comoEstaIndo(depois));
});
