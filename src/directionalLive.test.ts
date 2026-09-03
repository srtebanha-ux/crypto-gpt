// Arquivo: src/directionalLive.test.ts
//
// O motor direcional guarda posições abertas, capital e placar em memória.
// Num container que reinicia — e o Railway reinicia a cada deploy —, perder
// esse estado com DINHEIRO REAL significa posição aberta na corretora sem
// ninguém acompanhando o stop. Não é perda de estatística: é a única proteção
// contra perda ilimitada deixando de existir sem nenhum erro aparecer.
//
// Estes testes cobrem a gravação e a recuperação. Nada aqui toca a rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { loadState, saveState, type BookState } from './directionalLive';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

function dir(): string {
    return mkdtempSync(join(tmpdir(), 'dirlive-'));
}

const livroComPosicao: BookState = {
    capital: '19.123456789012345678',
    realizedPnl: '-0.876543210987654321',
    wins: 3,
    losses: 5,
    committed: '8.2',
    positions: [
        {
            symbol: 'BTCUSDT',
            entryPrice: '100000.12345678',
            quantity: '0.00008200',
            notional: '8.2001012',
            stopPrice: '99000.5',
            highestSinceEntry: '101000.75',
            openedAt: 1756900000000,
        },
    ],
};

test('estado sobrevive à ida e volta pelo disco sem perder precisão', () => {
    // Guardar como número em ponto flutuante arredondaria o preço de entrada, e
    // um stop calculado sobre entrada errada é risco diferente do que foi
    // aceito. Por isso tudo vai como string.
    const arquivo = join(dir(), 'estado.json');
    saveState(arquivo, { reversion: livroComPosicao });
    const lido = loadState(arquivo);

    assert.equal(lido.reversion.capital, livroComPosicao.capital);
    assert.equal(lido.reversion.positions[0].entryPrice, '100000.12345678');
    assert.equal(new Decimal(lido.reversion.capital).toString(), livroComPosicao.capital);
    assert.deepEqual(lido, { reversion: livroComPosicao });
});

test('grava os livros separados — um não sobrescreve o outro', () => {
    const arquivo = join(dir(), 'estado.json');
    saveState(arquivo, {
        reversion: livroComPosicao,
        breakout: { ...livroComPosicao, capital: '5', positions: [] },
    });
    const lido = loadState(arquivo);
    assert.equal(lido.reversion.positions.length, 1);
    assert.equal(lido.breakout.positions.length, 0);
    assert.equal(lido.breakout.capital, '5');
});

test('cria o diretório se ele não existir', () => {
    // No container o caminho padrão (./data) não existe no primeiro boot.
    // Falhar aí deixaria o motor rodando sem nunca gravar nada.
    const arquivo = join(dir(), 'sub', 'pasta', 'estado.json');
    saveState(arquivo, { reversion: livroComPosicao });
    assert.equal(loadState(arquivo).reversion.wins, 3);
});

test('arquivo ausente devolve estado vazio, não estoura', () => {
    // Primeiro boot é o caso normal, não excepcional.
    assert.deepEqual(loadState(join(dir(), 'nao-existe.json')), {});
});

test('arquivo corrompido devolve estado vazio em vez de derrubar o motor', () => {
    // Um JSON truncado não pode impedir o motor de subir. Ele sobe sem
    // posições, que é recuperável; não subir não é.
    const arquivo = join(dir(), 'estado.json');
    writeFileSync(arquivo, '{"reversion": {"capital": "10", "posi');
    assert.deepEqual(loadState(arquivo), {});
});

test('a gravação é atômica — não deixa arquivo temporário para trás', () => {
    // Escrever direto no destino deixaria um JSON truncado se o processo
    // morresse no meio, e o motor subiria depois sem as posições que acabara
    // de salvar: exatamente o cenário que a persistência existe para evitar.
    const pasta = dir();
    const arquivo = join(pasta, 'estado.json');
    saveState(arquivo, { reversion: livroComPosicao });
    const arquivos = readdirSync(pasta);
    assert.deepEqual(arquivos, ['estado.json'], `sobrou temporário: ${arquivos.join(',')}`);
});

test('sobrescrever mantém apenas o estado mais recente', () => {
    const arquivo = join(dir(), 'estado.json');
    saveState(arquivo, { reversion: livroComPosicao });
    saveState(arquivo, { reversion: { ...livroComPosicao, capital: '42', positions: [] } });
    const lido = loadState(arquivo);
    assert.equal(lido.reversion.capital, '42');
    assert.equal(lido.reversion.positions.length, 0);
});
