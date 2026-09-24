import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REDES } from './liquidacoes';
import { CACADORES, POOLS, cacadorDaRede, AVISO_ENDERECO_REPETIDO_NA_ARBITRUM, AERODROME, AERODROME_POOL_E_ESTAVEL, AERODROME_POOL_NOME } from './contratos';

test('todo endereco guardado e um endereco valido de verdade', () => {
    // getAddress reprova checksum errado, que e como um caractere trocado numa
    // copia manual aparece. Endereco invalido aqui viraria dinheiro perdido no
    // dia da cacada, e nao erro no dia de escrever.
    for (const c of CACADORES) {
        for (const campo of ['endereco', 'cofre', 'dono'] as const) {
            assert.equal(getAddress(c[campo]), c[campo], `${c.endereco}.${campo} com checksum errado`);
        }
    }
});

test('o cofre e o MESMO nos dois contratos — e nao e a conta_bot', () => {
    // O cofre e imutavel. Se um dos deploys tivesse recebido a conta_bot no
    // lugar, o lucro iria parar exatamente onde a chave mora — que e a unica
    // coisa que este desenho existe para impedir.
    const cofres = new Set(CACADORES.map((c) => c.cofre));
    assert.equal(cofres.size, 1);
    for (const c of CACADORES) assert.notEqual(c.cofre.toLowerCase(), c.dono.toLowerCase());
});

test('o cacador escolhido para caçar sabe vender em Aerodrome', () => {
    const c = cacadorDaRede('base');
    assert.ok(c);
    assert.equal(c.vendeEm, 'v2+solidly');
    assert.equal(c.endereco, '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78');
});

test('o contrato mais velho continua acessivel — nao foi apagado', () => {
    const soV2 = CACADORES.find((c) => c.vendeEm === 'v2');
    assert.ok(soV2, 'o caçador antigo tem de continuar guardado como saida');
    assert.equal(soV2.endereco, '0xb71249b14bdAEC2669341ed331cF1849c72F12d4');
});

test('rede sem cacador devolve null, nao o da Base por engano', () => {
    assert.equal(cacadorDaRede('ethereum'), null);
});

test('o aviso da Arbitrum aponta para o endereco que de fato se repete', () => {
    assert.equal(AVISO_ENDERECO_REPETIDO_NA_ARBITRUM, cacadorDaRede('base')!.endereco);
});

test('o pool da Aerodrome e mesmo o mais fundo — e por muito', () => {
    const vezes = POOLS.aerodrome.profundidadeUsd.dividedBy(POOLS.uniswapV2.profundidadeUsd);
    assert.ok(vezes.greaterThan(6), `esperava mais de 6x, deu ${vezes.toFixed(1)}x`);
    assert.equal(POOLS.aerodrome.familia, 'solidly');
});

test('os enderecos da Aerodrome passam no checksum', () => {
    for (const [papel, e] of Object.entries(AERODROME)) {
        assert.equal(getAddress(e.endereco), e.endereco, `${papel} com checksum errado`);
    }
});

test('router e factory da Aerodrome sao contratos diferentes', () => {
    assert.notEqual(
        AERODROME.router.endereco.toLowerCase(),
        AERODROME.factory.endereco.toLowerCase(),
    );
});

test('cada endereco da Aerodrome carrega COMO foi provado', () => {
    // Endereco sem prova junto e endereco suposto. Este teste impede que
    // alguem acrescente um "de memoria" mais tarde.
    for (const [papel, e] of Object.entries(AERODROME)) {
        assert.ok(e.provadoPor.length > 20, `${papel} sem prova escrita`);
        assert.match(e.provadoEm, /^\d{4}-\d{2}-\d{2}$/, `${papel} sem data da prova`);
    }
});

test('o pool da Aerodrome e volatil, e o nome dele prova isso', () => {
    // "Volatile AMM - " e montado pelo contrato a partir da flag `stable`.
    // Se um dia o nome vier "Stable AMM - ", a constante aqui esta errada e o
    // cacador estaria mandando a curva errada na venda.
    assert.equal(AERODROME_POOL_E_ESTAVEL, false);
    assert.ok(AERODROME_POOL_NOME.startsWith('Volatile AMM'));
    assert.ok(AERODROME_POOL_NOME.includes(POOLS.aerodrome.par));
});

test('os enderecos cravados no .sol sao os MESMOS que estao provados aqui', () => {
    // O contrato nao pede mais os enderecos como argumento: eles estao dentro
    // do .sol. Isso tira quatro campos da mao de quem implanta — e quatro
    // chances de trocar a ordem ou cortar um endereco no meio — mas cria um
    // jeito novo de errar: os dois arquivos discordarem em silencio, com o
    // TypeScript medindo um pool e o contrato vendendo em outro.
    //
    // Este teste e a unica coisa entre esses dois arquivos e essa divergencia.
    const sol = readFileSync(join(__dirname, '..', 'contracts', 'CacadorV2.sol'), 'utf8');
    const constante = (nome: string): string => {
        const m = sol.match(new RegExp(`address private constant ${nome} = (0x[0-9a-fA-F]{40});`));
        assert.ok(m, `constante ${nome} nao encontrada em CacadorV2.sol`);
        return m![1];
    };
    assert.equal(constante('AERODROME_ROUTER'), AERODROME.router.endereco);
    assert.equal(constante('AERODROME_FACTORY'), AERODROME.factory.endereco);
    assert.equal(constante('COFRE'), CACADORES[0].cofre);
    assert.equal(constante('AAVE_POOL'), getAddress(REDES.base.pool));
});

test('o cofre cravado no .sol NAO e a carteira quente', () => {
    // O defeito do contrato 0xd87AeE…, que esta rodando agora: ele manda o
    // lucro para o dono. O dono e a conta_bot, cuja chave mora no Railway.
    // Um ganho la vira dinheiro dormindo onde a chave dorme.
    const sol = readFileSync(join(__dirname, '..', 'contracts', 'CacadorV2.sol'), 'utf8');
    const cofre = sol.match(/address private constant COFRE = (0x[0-9a-fA-F]{40});/)![1];
    for (const c of CACADORES) {
        assert.notEqual(cofre.toLowerCase(), c.dono.toLowerCase());
    }
});

test('o contrato que se implanta nao pede argumento nenhum', () => {
    // Se alguem reintroduzir argumentos, o passo a passo de implantacao muda e
    // a garantia acima (endereco que nao se digita nao se erra) morre junto.
    const sol = readFileSync(join(__dirname, '..', 'contracts', 'CacadorV2.sol'), 'utf8');
    assert.match(sol, /contract CacadorV2Base is CacadorV2 \{/);
    assert.match(sol, /constructor\(\) CacadorV2\(AAVE_POOL, AERODROME_ROUTER, AERODROME_FACTORY, COFRE\)/);
});

test('todo caçador registrado sabe de onde veio', () => {
    // Procedência vazia é o que este arquivo existe para impedir. Bloco ou
    // transação: pelo menos um dos dois, nunca nenhum.
    for (const c of CACADORES) {
        const temBloco = typeof c.blocoDoDeploy === 'number' && c.blocoDoDeploy > 0;
        const temTx = typeof c.txDoDeploy === 'string' && /^0x[0-9a-fA-F]{64}$/.test(c.txDoDeploy);
        assert.ok(temBloco || temTx, `${c.endereco} sem bloco nem transação de origem`);
    }
});

test('o caçador da Aerodrome está registrado e paga no cofre', () => {
    const novo = CACADORES.find((c) => c.vendeEm === 'aerodrome');
    assert.ok(novo, 'nenhum caçador registrado vende na Aerodrome');
    assert.equal(novo!.endereco, '0xb91c634fb23934ED178b5116fCbFbF195B127F32');
    assert.notEqual(novo!.cofre.toLowerCase(), novo!.dono.toLowerCase());
    // A prova tem que citar quem respondeu, não quem lembrou.
    assert.ok(novo!.conferidoPor.includes('cofre()'));
});
