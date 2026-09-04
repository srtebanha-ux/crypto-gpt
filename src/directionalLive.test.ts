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
import { decideReconcile, loadState, saveState, type BookState } from './directionalLive';

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

// --- Reconciliação com o saldo real da corretora -----------------------------
//
// O arquivo de estado protege contra reinício do processo. Não protege contra
// o arquivo se perder (container novo sem volume), contra alguém vender pela
// interface da Binance, nem contra ordem executada com o motor fora do ar.
// Nesses casos livro e realidade divergem — sem nenhum erro aparecer.

const d = (v: string) => new Decimal(v);
const MIN_NOTIONAL = d('5');

test('saldo real sem posição no livro é ÓRFÃ — o caso mais perigoso', () => {
    // Posição que o motor não conhece é posição sem stop. Se isto fosse tratado
    // como "nada a fazer", dinheiro real ficaria exposto com o log saudável.
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: false, valorDoSaldo: d('120'), minNotional: MIN_NOTIONAL, podeAdotar: false }),
        'alertar-orfa',
    );
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: false, valorDoSaldo: d('120'), minNotional: MIN_NOTIONAL, podeAdotar: true }),
        'adotar-orfa',
    );
});

test('posição no livro sem saldo real é FANTASMA — remover, não vigiar', () => {
    // Vendida na mão, ou fechada com o motor fora do ar. Mantê-la faria o motor
    // vigiar um stop que não protege nada e bloquear o caixa para sempre.
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: true, valorDoSaldo: d('0'), minNotional: MIN_NOTIONAL, podeAdotar: false }),
        'remover-fantasma',
    );
});

test('poeira de saldo NÃO é posição', () => {
    // Restos de arredondamento ficam na conta depois de qualquer venda. Sem o
    // piso do notional mínimo, cada um viraria uma posição fantasma nova a cada
    // ciclo — e a corretora nem aceitaria vendê-los.
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: false, valorDoSaldo: d('0.13'), minNotional: MIN_NOTIONAL, podeAdotar: true }),
        'nada',
    );
    // E com posição no livro, poeira significa que a posição real acabou.
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: true, valorDoSaldo: d('0.13'), minNotional: MIN_NOTIONAL, podeAdotar: false }),
        'remover-fantasma',
    );
});

test('livro e corretora de acordo não mexem em nada', () => {
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: true, valorDoSaldo: d('120'), minNotional: MIN_NOTIONAL, podeAdotar: true }),
        'nada',
    );
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: false, valorDoSaldo: d('0'), minNotional: MIN_NOTIONAL, podeAdotar: true }),
        'nada',
    );
});

test('exatamente no notional mínimo conta como posição', () => {
    // A fronteira decide entre "sem stop" e "vigiada". Na dúvida, vigiar.
    assert.equal(
        decideReconcile({ temPosicaoNoLivro: false, valorDoSaldo: d('5'), minNotional: MIN_NOTIONAL, podeAdotar: false }),
        'alertar-orfa',
    );
});

test('adotar exige permissão explícita — o padrão é alertar', () => {
    // Adotar distorce o placar: o preço pago é desconhecido e o resultado passa
    // a ser medido do zero. É a escolha certa para proteger a posição e a
    // errada para medir, então quem decide é quem opera.
    const semPermissao = decideReconcile({
        temPosicaoNoLivro: false,
        valorDoSaldo: d('50'),
        minNotional: MIN_NOTIONAL,
        podeAdotar: false,
    });
    assert.equal(semPermissao, 'alertar-orfa');
});
