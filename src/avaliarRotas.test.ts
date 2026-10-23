/**
 * O CACADOR usando a classificacao causal — as regras, nao os numeros.
 *
 * O critério dela desta rodada: *"O caçador contínuo deve usar a nova
 * classificação causal, avaliar rotas de 2–4 swaps e só considerar
 * economicamente validada uma execução integral bem-sucedida em fork."*
 *
 * Estes testes afirmam as tres pontas: a exclusao vem de prova e no menor
 * escopo, a taxa entra na conta, e `validadasEconomicamente` nao pode subir
 * neste caminho.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { avaliarRotas, FUNIL, comoLerOFunil } from './cacarArbitragem';
import { Exclusoes, escopoDoVeredicto, type SondaDeToken } from './causaDaFalha';

const WETH = '0x4200000000000000000000000000000000000006';
const MOEDA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Dois pools do MESMO par em fabricas DIFERENTES: o ciclo mais simples. */
const pools = (r0a: bigint, r1a: bigint, r0b: bigint, r1b: bigint) => [
    {
        endereco: '0x1111111111111111111111111111111111111111',
        token0: WETH, token1: MOEDA, reserva0: r0a, reserva1: r1a,
        fabrica: '0xfab1', lidoEm: Date.now(),
    },
    {
        endereco: '0x2222222222222222222222222222222222222222',
        token0: WETH, token1: MOEDA, reserva0: r0b, reserva1: r1b,
        fabrica: '0xfab2', lidoEm: Date.now(),
    },
] as never;

const P1 = '0x1111111111111111111111111111111111111111';
const P2 = '0x2222222222222222222222222222222222222222';

const sonda = (token: string, enviado: bigint, recebido: bigint): SondaDeToken => ({
    token, rodou: true, enviado, recebido, reverteu: false, porque: 'medido',
});
const recusa = (token: string): SondaDeToken => ({
    token, rodou: true, enviado: 100n, recebido: null, reverteu: true, porque: 'reverteu',
});

// Um desequilibrio grande entre os dois pools cria sobra de verdade.
const DESEQUILIBRADOS = pools(
    10n ** 21n, 10n ** 21n,
    10n ** 21n, (10n ** 21n * 13n) / 10n,
);

test('avalia rotas e devolve estimativa — sem exclusão nenhuma', () => {
    const r = avaliarRotas(DESEQUILIBRADOS, 1n, new Exclusoes(), { maxHops: 2 });
    assert.ok(r.rotas > 0, 'não achou rota num par presente em duas fábricas');
    assert.ok(r.estimadas.length > 0, 'não estimou positiva uma rota com desequilíbrio de 30%');
    assert.equal(r.excluidasComCausa, 0);
});

test('transferência RECUSADA barra a rota; taxa medida NÃO barra', () => {
    const barra = new Exclusoes();
    // Recusa de transferencia e escopo GLOBAL (nao depende do remetente), e
    // por isso UM registro basta aqui.
    barra.registrar(escopoDoVeredicto(recusa(MOEDA), P1));
    const comBarra = avaliarRotas(DESEQUILIBRADOS, 1n, barra, { maxHops: 2 });
    assert.equal(comBarra.estimadas.length, 0, 'executou rota por token que recusa transferência');
    assert.ok(comBarra.excluidasComCausa > 0);

    // A MESMA moeda, agora com taxa MEDIDA em vez de recusa: a rota NAO e
    // barrada — ela e avaliada com o valor efetivo. Era o pedido dela.
    const taxa = new Exclusoes();
    // Nos DOIS pools: a taxa e medida POR PAR, e qual direcao da rota vence
    // depende do desequilibrio. Registrar so um pool deixaria o teste passar
    // sem exercitar nada — foi o que a primeira versao fez.
    for (const pool of [P1, P2]) {
        taxa.registrar(escopoDoVeredicto(sonda(MOEDA, 1000n, 990n), pool));
    }
    const comTaxa = avaliarRotas(DESEQUILIBRADOS, 1n, taxa, { maxHops: 2 });
    assert.equal(comTaxa.excluidasComCausa, 0,
        'descartou a rota por EXISTIR taxa, em vez de avaliá-la com a taxa');
});

test('a taxa medida REDUZ a sobra estimada, e pode reprovar pela conta', () => {
    const sem = avaliarRotas(DESEQUILIBRADOS, 1n, new Exclusoes(), { maxHops: 2 });
    const ex = new Exclusoes();
    // 300/1000 retidos: taxa grande o bastante para comer o desequilíbrio.
    for (const pool of [P1, P2]) {
        ex.registrar(escopoDoVeredicto(sonda(MOEDA, 1000n, 700n), pool));
    }
    const com = avaliarRotas(DESEQUILIBRADOS, 1n, ex, { maxHops: 2 });
    const melhorSem = sem.estimadas.reduce((a, b) => (b.sobra > a.sobra ? b : a)).sobra;
    if (com.estimadas.length === 0) {
        // Reprovada PELA CONTA, e contada como tal — não como "tem taxa".
        assert.ok(com.inviavelComTaxa > 0,
            'reprovou a rota taxada sem contá-la em `inviavelComTaxa`');
    } else {
        const melhorCom = com.estimadas.reduce((a, b) => (b.sobra > a.sobra ? b : a)).sobra;
        assert.ok(melhorCom < melhorSem, 'a taxa medida não mudou a sobra estimada');
    }
});

test('o gás reprova a rota que não o paga, e isso não é exclusão de peça', () => {
    const caro = avaliarRotas(DESEQUILIBRADOS, 10n ** 30n, new Exclusoes(), { maxHops: 2 });
    assert.equal(caro.estimadas.length, 0, 'aprovou rota que não paga o gás');
    assert.equal(caro.excluidasComCausa, 0, 'contou falta de lucro como exclusão de peça');
});

test('a frase do funil diz que o caminho ao vivo NÃO valida economicamente', () => {
    const f = comoLerOFunil('aoVivo');
    assert.match(f, /VALIDADAS ECONOMICAMENTE/);
    assert.match(f, /caçador ao vivo NÃO executa/);
    // E a de fork diz o criterio dela, inteiro.
    const g = comoLerOFunil('fork');
    assert.match(g, /execução integral em fork/);
    assert.match(g, /lucro líquido positivo depois de todos os custos/);
});

test('espaço de busca NÃO MEDIDO não é publicado como zero', () => {
    const antes = FUNIL.espacoDeBusca;
    FUNIL.espacoDeBusca = null;
    assert.match(comoLerOFunil('fork'), /espaço de busca NÃO MEDIDO/);
    FUNIL.espacoDeBusca = 0;
    assert.match(comoLerOFunil('fork'), /espaço de busca 0 par\(es\)/);
    FUNIL.espacoDeBusca = antes;
});

// LE O CODIGO, e nao um valor: `validadasEconomicamente` so pode ser
// incrementado onde ha execucao integral com lucro apurado. Um `+= 1` dele no
// caminho ao vivo transformaria estimativa em lucro, e nenhum teste de valor
// pegaria isso — e a mesma classe do campo que faltava num dos gravadores de
// cache, que custou sete tiros neste projeto.
test('nada no caçador ao vivo incrementa `validadasEconomicamente`', () => {
    const fonte = readFileSync(join(__dirname, 'cacarArbitragem.ts'), 'utf8');
    const linhas = fonte.split('\n')
        .filter((l) => l.includes('validadasEconomicamente'))
        .filter((l) => /\+=|\+\+|=\s*[0-9]/.test(l))
        // A declaracao do objeto (`validadasEconomicamente: 0,`) nao conta.
        .filter((l) => !/validadasEconomicamente:\s*0,/.test(l));
    assert.deepEqual(linhas, [],
        'alguém incrementa `validadasEconomicamente` no caçador ao vivo, que não executa nada: '
        + `${linhas.join(' | ')}`);
});
