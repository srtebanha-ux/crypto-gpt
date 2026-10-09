// ENDERECO PUBLICO, ACESSO DE LEITURA e ASSINADOR sao TRES COISAS.
//
// INCIDENTE de 2026-10-09: com `CACA_ENVIAR=0` o log dela imprimiu
// `[EM SECO] envio: "nao ha carteira (CACA_CHAVE_PRIVADA ausente ou
// invalida)"`. A causa NAO era a configuracao dela: o bloco que cria a
// carteira nascia inteiro dentro de `if (ENVIAR)`, entao desligar o envio
// apagava o ENDERECO e o ACESSO DE LEITURA junto com o ASSINADOR — e sem
// endereco nao ha saldo, nonce nem montagem para conferir.
//
// O QUE ESTE ARQUIVO PROVA, e o que NAO prova, declarado:
//
//   os casos (1) a (4) leem o CODIGO de `cacarAoVivo.ts`. O defeito era
//   ESTRUTURAL — um bloco no lugar errado, um campo ausente num gate — e
//   nenhum teste de VALOR o pega: foi assim que ele passou por 1.467 testes.
//   E a mesma razao do teste que le os gravadores do cache.
//
//   o caso (5) roda as FUNCOES DE VERDADE da decisao, as mesmas que o laco
//   quente chama, com dado essencial ausente.
//
//   o que NAO esta provado aqui: `cacarAoVivo.ts` e um script que sobe o bot
//   ao ser importado, entao nao ha como invocar o laco quente dentro de um
//   teste. A prova de que o caminho montado roda de ponta a ponta sem gastar
//   e o `[OBSERVANDO]` no log DELA — producao, nao teste. Isso esta marcado
//   como "observado" ou "nao observado" no relato, nunca como testado.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Decimal from 'decimal.js';
import { atirarNaEscritaIminente, pisoEfetivoDaAposta } from './adiantar';
import { oQueFazerComOEnvio, podeAssinar, type EntradaDoDegrau } from './degrauFinal';

const fonte = () => readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');

test('(1) endereço público e leitura NASCEM fora do portão de envio', () => {
    const f = fonte();
    const leitor = f.indexOf('const leitor = new JsonRpcProvider(rpc);');
    const nonce = f.indexOf('nonceManager = new LocalNonceManager(');
    assert.ok(leitor > 0, 'o acesso de leitura tem de existir, separado do assinador');
    assert.ok(nonce > leitor, 'o contador de nonce nasce depois do leitor');

    // O trecho que cria leitor, endereco e nonce NAO pode estar dentro de um
    // bloco `if (ENVIAR) {`. Era exatamente ali que ele estava.
    const trecho = f.slice(leitor, nonce);
    assert.ok(!/if \(ENVIAR\) \{/.test(trecho),
        'nada da leitura pode nascer dentro de `if (ENVIAR) {` — foi esse o defeito');

    // E o nonce depende do ENDERECO, nao do assinador.
    assert.match(f.slice(nonce - 200, nonce), /donoCarteira !== null/,
        'o contador de nonce é guardado pelo endereço, não pela chave');
});

test('(2) o ASSINADOR só existe com autorização de envio', () => {
    const f = fonte();
    // Toda atribuicao de `carteira` que nao seja a declaracao nula tem de
    // acontecer sob `ENVIAR`.
    const atribuicoes = f.split('\n').filter((l) => /(^|[^.\w])carteira = /.test(l));
    assert.deepEqual(
        atribuicoes.map((l) => l.trim()),
        ['if (ENVIAR) carteira = assinador;'],
        `carteira só pode ser atribuída sob ENVIAR, achei: ${atribuicoes.join(' | ')}`,
    );
    // E ela nasce NULA, para o resto do caminho ter como existir sem ela.
    assert.match(f, /let carteira: Wallet \| null = null;/,
        'o assinador nasce nulo — a ausência dele é um estado legítimo');
});

test('(3) NENHUM caminho de LEITURA passa pelo assinador', () => {
    const f = fonte();
    // Ler saldo pelo provedor DA CARTEIRA acoplava leitura a chave: sem chave,
    // o saldo era "ainda nao li" para sempre. Quem le e o leitor.
    assert.ok(!/carteira!?\.provider/.test(f),
        'nenhum caminho pode ler pelo provedor da carteira — leitura é do leitor');
    assert.ok(!/carteira\.getAddress\(\)/.test(f),
        'o endereço vem de donoCarteira, não de uma chamada ao assinador');
    const quemLeSaldo = [...f.matchAll(/(\w+)!?\.getBalance\(/g)].map((m) => m[1]!);
    assert.deepEqual([...new Set(quemLeSaldo)], ['leitor'],
        `só o leitor lê saldo, achei: ${[...new Set(quemLeSaldo)].join(', ')}`);
});

test('(4) envio AUTORIZADO sem assinador: recusa explícita, sem desvio e sem gastar nonce', () => {
    const f = fonte();
    // No BOOT: envio autorizado e chave ausente/invalida e configuracao que so
    // uma reimplantacao conserta.
    assert.match(f, /if \(ENVIAR && carteira === null\) \{/,
        'o boot tem de recusar envio autorizado sem assinador');
    // E o COMPORTAMENTO dessa recusa esta no caso (7), nas 16 combinacoes.

    // No CAMINHO QUENTE: a recusa vem ANTES de reservar nonce e de transmitir.
    const idxRecusa = f.indexOf("if (oQueFazer.acao !== 'transmitir' || !carteira) {");
    const idxNonce = f.indexOf('await nonceManager.getNextNonce();');
    const idxEnvio = f.indexOf('carteira.sendTransaction(');
    assert.ok(idxRecusa > 0, 'a recusa tem de existir no caminho quente');
    assert.ok(idxRecusa < idxNonce && idxNonce < idxEnvio,
        'a recusa vem antes de reservar o nonce, e o nonce antes de transmitir');
    const corpo = f.slice(idxRecusa, idxNonce);
    assert.match(corpo, /continue;/, 'a recusa sai do laço — não há desvio para o envio');
    assert.ok(!/getNextNonce/.test(corpo),
        'recusar não pode adiantar o contador: adiantar sem mandar desarma provaAgora() para sempre');
});

test('(5) dado essencial ausente: a avaliação é indeterminada e NADA é autorizado', () => {
    // Sem preco do ETH nao ha custo por errada; sem custo nao ha piso; e um
    // piso ausente NAO pode virar zero — zero autoriza qualquer premio. Foi o
    // defeito que eu introduzi e consertei no mesmo dia.
    // `custoDeUmaErradaUsd` devolve ZERO quando nao ha preco do ETH ("nao
    // medi", nao "de graca"), e o piso tem de recusar isso em vez de virar
    // zero — zero autorizaria qualquer premio.
    const piso = pisoEfetivoDaAposta(null, new Decimal(0), 355);
    assert.equal(piso.isFinite(), false, 'custo por errada não medido => piso infinito, não zero');

    const r = atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.3899'),
        quedaDoAlvoPct: new Decimal('0.1838'),
        ligada: true,
        premioUsd: new Decimal('47.12'),
        premioMinimoUsd: piso,
    });
    assert.equal(r.atira, false, 'sem custo medido não se aposta, nem com prêmio bom');
    assert.match(r.porque, /custo de uma errada/i, `a recusa tem de DIZER o que faltou: ${r.porque}`);

    // E premio ausente nao libera: ausencia nao e autorizacao.
    assert.equal(atirarNaEscritaIminente({
        mercadoCaiuPct: new Decimal('0.3899'),
        quedaDoAlvoPct: new Decimal('0.1838'),
        ligada: true,
        premioUsd: null,
        premioMinimoUsd: new Decimal('38.13'),
    }).atira, false, 'sem prêmio conhecido não se aposta');
});

test('(6) o log do boot DIZ as três coisas separadas, e por que', () => {
    // Em 28/09 eu previ `inteiroDe US$ 49,27` e a producao deu US$ 34,63: a
    // causa era uma variavel do Railway dela que o log nao dizia. O conserto
    // foi o log DIZER com que botoes decidiu. Aqui e a mesma regra: sem esta
    // linha, nem eu nem ela temos como ver, do log, se falta ENDERECO ou falta
    // CHAVE — e os dois pedem consertos diferentes.
    const f = fonte();
    const idx = f.indexOf("log.info('[CONTA] O que existe, separado em três.'");
    assert.ok(idx > 0, 'o boot tem de publicar o que existe');
    const linha = f.slice(idx, idx + 1600);
    for (const campo of ['enderecoPublico', 'deOndeVeioOEndereco', 'acessoDeLeitura', 'assinador']) {
        assert.match(linha, new RegExp(campo), `a linha tem de dizer ${campo}`);
    }
    // E NUNCA o valor do segredo.
    assert.ok(!/CACA_CHAVE_PRIVADA\s*\}|\$\{chave\}|chave\b\s*,/.test(linha),
        'o valor da chave não entra no log — só o nome da variável e o defeito');
});

test('(7) o ÚLTIMO DEGRAU, nas 16 combinações: só UMA assina', () => {
    // O TESTE CONTROLADO que ela pediu, e sem depender de aparecer alvo real:
    // a decisão do último degrau é uma função, produção chama ela, e aqui ela é
    // exercitada em TODAS as combinações em vez de na que eu lembrar de
    // escrever. Um interceptador que devolve 'INTERCEPTADO' não provava isto.
    const ENDERECO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
    const combos: EntradaDoDegrau[] = [];
    for (const envioAutorizado of [false, true]) {
        for (const temAssinador of [false, true]) {
            for (const temContadorDeNonce of [false, true]) {
                for (const enderecoPublico of [null, ENDERECO]) {
                    combos.push({ envioAutorizado, temAssinador, temContadorDeNonce, enderecoPublico });
                }
            }
        }
    }
    assert.equal(combos.length, 16);

    for (const c of combos) {
        const r = oQueFazerComOEnvio(c);
        // A INVARIANTE: transmitir exige autorização E assinador. Qualquer
        // outra combinação que transmita é contorno do bloqueio de envio.
        if (r.acao === 'transmitir') {
            assert.ok(podeAssinar(c), `transmitiu sem poder assinar: ${JSON.stringify(c)}`);
            assert.ok(c.temContadorDeNonce && c.enderecoPublico !== null);
        }
        // E toda recusa DIZ o que faltou — recusa muda foi o disjuntor mudo.
        assert.ok(r.porque.length > 20, `desfecho sem motivo legível: ${JSON.stringify(c)}`);
    }
    // Exatamente UMA das 16 assina.
    assert.equal(combos.filter((c) => oQueFazerComOEnvio(c).acao === 'transmitir').length, 1);
    // Com endereço, nonce e envio desligado: OBSERVA — com ou sem chave.
    for (const temAssinador of [false, true]) {
        assert.equal(oQueFazerComOEnvio({
            envioAutorizado: false, temAssinador, temContadorDeNonce: true, enderecoPublico: ENDERECO,
        }).acao, 'observar', 'observar não pode depender de ter chave');
    }
    // Envio LIGADO e sem assinador: recusa explícita, nomeando a variável.
    const semChave = oQueFazerComOEnvio({
        envioAutorizado: true, temAssinador: false, temContadorDeNonce: true, enderecoPublico: ENDERECO,
    });
    assert.equal(semChave.acao, 'recusar');
    assert.match(semChave.porque, /CACA_CHAVE_PRIVADA/);
    assert.match(semChave.porque, /não reservo nonce/);
    // Sem endereço: a recusa fala de ENDEREÇO, não de chave — foi essa troca
    // que fez o log culpar a configuração dela por um defeito do código.
    const semEndereco = oQueFazerComOEnvio({
        envioAutorizado: false, temAssinador: true, temContadorDeNonce: true, enderecoPublico: null,
    });
    assert.equal(semEndereco.acao, 'recusar');
    assert.match(semEndereco.porque, /CACA_ENDERECO_PUBLICO/);
});

test('(8) produção usa ESTA função, e `armados` não chega perto do envio', () => {
    const f = fonte();
    // (a) o degrau final de produção é a função, não uma cópia dela.
    assert.match(f, /from '\.\/degrauFinal'/, 'produção importa o degrau final');
    assert.match(f, /oQueFazerComOEnvio\(\{/, 'e o chama');
    assert.ok(!/if \(soObservando\)/.test(f),
        'a decisão inline não pode voltar — a cópia provaria a cópia');

    // (b) `armados` é LEITURA ADIANTADA, e não toca o caminho do envio.
    // `armar()` lê dívida e garantia dos 8 mais frágeis da brasa e guarda por
    // 5s; quem entra no caminho do tiro são os `caidos`, e esses passam pelos
    // mesmos portões. Se `alvosArmados` aparecer entre o portão e a
    // transmissão, a leitura adiantada virou atalho.
    const idxGuarda = f.indexOf("if (oQueFazer.acao === 'observar') {");
    const idxEnvio = f.indexOf('carteira.sendTransaction(');
    assert.ok(idxGuarda > 0 && idxGuarda < idxEnvio);
    assert.ok(!/alvosArmados/.test(f.slice(idxGuarda, idxEnvio)),
        'a leitura adiantada não pode aparecer no trecho que transmite');
});
