/**
 * O TESTE DE REGRESSAO QUE ELA PEDIU: simulacao recusada NAO vira envio.
 *
 * Ela leu no ensaio em seco `numDeUS$88Atiraria=SIM` ao lado de uma simulacao
 * revertida e de uma posicao inliquidavel pela reversao `0xb629b0e4`, e
 * perguntou a pergunta certa: *"Verifique se isso representa apenas uma
 * avaliacao hipotetica de lance ou se existe algum caminho de envio que ignora
 * a rejeicao da simulacao."*
 *
 * A resposta, seguida no codigo e CONFERIDA rodando (2026-10-14):
 *
 * 1. `numDeUS$88Atiraria` e HIPOTETICO. Ele chama `decidirTiro` com
 *    `lucroUsd: 88` FABRICADO, para responder "que gorjeta um premio de US$ 88
 *    levaria?". Ele nao le simulacao nenhuma e nao alimenta envio nenhum. O
 *    alvo do ensaio pode estar inliquidavel e a resposta continua SIM, porque
 *    a pergunta nao e sobre aquele alvo.
 *
 * 2. O caminho de envio exige medicao. Uma simulacao REVERTIDA so produz
 *    `lucroCru: 0n` quando DUAS coisas valem juntas: o devedor esta no conjunto
 *    `vaoCruzar` (escolhido para o tiro especulativo) E `naoCruzouAinda`
 *    identifica POSITIVAMENTE o seletor `0x930bb771`
 *    (`HealthFactorNotBelowThreshold`). Qualquer outra reversao cai no ramo
 *    `[ANTES DO CRUZAMENTO] NAO mando`.
 *
 * Entao a reversao `0xb629b0e4` nao pode autorizar gasto. Estes testes travam
 * isso pelas duas pontas: a funcao e a ESTRUTURA do caminho quente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { naoCruzouAinda, SELETOR_SAUDE_ACIMA_DO_LIMIAR } from './liquidar';

/** A reversao observada na matriz de resíduo. O NOME dela não está confirmado. */
const REVERSAO_DO_RESIDUO = '0xb629b0e4';

test('a reversão 0xb629b0e4 NUNCA autoriza tiro especulativo', () => {
    // MEDIDO rodando a funcao real em 2026-10-14. Sem identificacao POSITIVA
    // nao se manda dinheiro: uma reversao opaca nao se distingue de contrato
    // quebrado, e este arquivo ja custou o capitulo do `naoCruzouAinda`
    // invertido — que aceitava TUDO que continha a palavra "revert".
    assert.equal(naoCruzouAinda('execution reverted', REVERSAO_DO_RESIDUO), false);
    assert.equal(naoCruzouAinda(undefined, REVERSAO_DO_RESIDUO), false);
    assert.equal(naoCruzouAinda('', REVERSAO_DO_RESIDUO), false);
    // E a unica que autoriza continua autorizando, senao o conserto desligaria
    // a estrategia em vez de protege-la.
    assert.equal(naoCruzouAinda('execution reverted', SELETOR_SAUDE_ACIMA_DO_LIMIAR), true);
});

test('reversão OPACA — sem dados — não autoriza: ausência não é identificação', () => {
    // O defeito historico era exatamente este: a funcao terminava em
    // `/revert/i.test(mensagem)` e `undefined` AUTORIZAVA. Ausencia autorizando
    // gasto e a forma mais cara de "ausencia com cara de resposta".
    assert.equal(naoCruzouAinda('execution reverted', undefined), false);
    assert.equal(naoCruzouAinda('execution reverted', '0x'), false);
    assert.equal(naoCruzouAinda('revertido sem mensagem', undefined), false);
    // Seletor desconhecido tambem nao: identificar OUTRA coisa nao e identificar
    // esta.
    assert.equal(naoCruzouAinda('execution reverted', '0xdeadbeef'), false);
});

test('o caminho quente exige medição E identificação positiva, nas duas pontas', () => {
    // LÊ O CÓDIGO. A pergunta dela é estrutural — *"existe algum caminho de
    // envio que ignora a rejeição da simulação?"* — e um teste de valor não
    // responde sobre a existência de um caminho.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');

    // Existe UM lugar que ALIMENTA A DECISÃO com lucro zero fabricado.
    //
    // Conta o `medicoes.push`, e não a literal `lucroCru: 0n`: a literal
    // aparece também nos comentários que explicam por que ela é perigosa, e
    // contar comentário é contar prosa. O que decide tiro é o que entra em
    // `medicoes` — foi daí que saiu o número.
    const empurram = [...fonte.matchAll(/medicoes\.push\(\{\s*contrato,\s*lucroCru:\s*0n/g)];
    assert.equal(
        empurram.length, 1,
        'mais de um lugar empurra lucro zero fabricado para a decisão: a regra em dois lugares '
        + 'é a mesma regra, e aqui ela manda dinheiro',
    );

    // E esse lugar está guardado pelos DOIS portões, na mesma condição.
    const i = empurram[0]!.index!;
    const guarda = fonte.slice(Math.max(0, i - 2200), i);
    assert.ok(
        guarda.includes('naoCruzouAinda(leitura.erro, leitura.dadosCrus)'),
        'o fabrico de lucro zero não está guardado por identificação positiva do seletor',
    );
    assert.ok(
        guarda.includes('vaoCruzar.has('),
        'o fabrico de lucro zero não exige que o alvo tenha sido escolhido para o tiro '
        + 'especulativo: aceitar qualquer reversão é atirar no escuro',
    );
    // Os DADOS CRUS têm de chegar lá. A identidade nunca esteve na prosa:
    // medido na Base, o RPC diz só "execution reverted" e manda o seletor nos
    // dados — e `lerRespostaDaCaca` já descartou esse campo uma vez.
    assert.ok(
        fonte.includes('leitura.dadosCrus'),
        'os dados crus da reversão não viajam até a decisão',
    );
});

test('o número hipotético de US$ 88 não alimenta envio nenhum', () => {
    // A resposta à pergunta dela, travada: `d88` é uma avaliação de LANCE sobre
    // um lucro FABRICADO, e seu resultado só vai para strings de log. Se algum
    // dia ele passar a alimentar montagem ou envio, este teste reprova.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const usos = [...fonte.matchAll(/\bd88\b/g)].map((m) => {
        const linha = fonte.slice(fonte.lastIndexOf('\n', m.index!) + 1,
            fonte.indexOf('\n', m.index!));
        return linha.trim();
    });
    assert.ok(usos.length > 0, 'o ensaio hipotético tem de existir');
    for (const u of usos) {
        assert.ok(
            !/sendTransaction|getNextNonce|codificarCacaV1|codificarCacaV2/.test(u),
            `o número hipotético de US$ 88 chegou a um caminho de envio: ${u}`,
        );
    }
    // E o lucro dele é LITERAL, não medido: é isso que o torna hipotético.
    assert.ok(
        fonte.includes('lucroUsd: new Decimal(88)'),
        'o ensaio de US$ 88 deixou de usar um lucro fabricado — então ele não é mais hipotético, '
        + 'e esta docstring precisa ser refeita antes de o teste ser relaxado',
    );
});
