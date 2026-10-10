import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import {
    LEITURAS,
    SELETOR_DE,
    ERROS_DO_CACADOR,
    NOMES_DE_ERRO_DO_CACADOR,
    lerVersaoDoCompilador,
    enderecoDaPalavra,
    compararCampo,
    decidir,
    type Campo,
    type Guarda,
} from './conferirContrato';

/** Cauda de metadados como o solc escreve: "solc" seguido de três bytes. */
function comMarcaDeCompilador(maior: number, menor: number, correcao: number): string {
    const b = (n: number) => n.toString(16).padStart(2, '0');
    return '0x6080604052' + '64736f6c6343' + b(maior) + b(menor) + b(correcao) + '0033';
}

test('lê do bytecode qual compilador produziu o contrato', () => {
    assert.equal(lerVersaoDoCompilador(comMarcaDeCompilador(0, 8, 34)), '0.8.34');
    assert.equal(lerVersaoDoCompilador(comMarcaDeCompilador(0, 8, 26)), '0.8.26');
});

test('admite não saber a versão em vez de inventar uma', () => {
    assert.equal(lerVersaoDoCompilador('0x6080604052348015600f57600080fd5b00'), null);
    assert.equal(lerVersaoDoCompilador('0x'), null);
    // Marca presente mas truncada: também é não saber.
    assert.equal(lerVersaoDoCompilador('0x64736f6c6343' + '0008'), null);
});

test('decodifica endereço de uma palavra de 32 bytes', () => {
    const palavra = '0x' + '0'.repeat(24) + '3d310384d674532f5d41cf2d43b03001f3515ae8';
    assert.equal(enderecoDaPalavra(palavra), '0x3d310384d674532f5d41cf2d43b03001f3515ae8');
});

test('recusa palavra com lixo nos bytes altos — não é endereço', () => {
    // Se os 12 primeiros bytes não são zero, a resposta não é um endereço, e
    // cortar os 20 últimos assim mesmo devolveria um endereço plausível e
    // falso. Preferir null: um campo que não leu tem que reprovar, não passar.
    const sujo = '0x' + '1'.repeat(24) + '3d310384d674532f5d41cf2d43b03001f3515ae8';
    assert.equal(enderecoDaPalavra(sujo), null);
    assert.equal(enderecoDaPalavra('0xabcd'), null);
});

test('comparação de endereço ignora maiúsculas mas não o valor', () => {
    const a = '0x3dffa934170bdd491724747be2c4f56e3f1512a7';
    const b = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
    assert.equal(compararCampo('cofre()', a, b).confere, true);
    // O endereço da conta_bot no lugar do cofre: o erro exato que quase houve.
    assert.equal(compararCampo('cofre()', '0x3d310384d674532f5d41cf2d43b03001f3515ae8', b).confere, false);
});

test('sem o esperado, o campo fica "não conferido" — nunca "confere"', () => {
    assert.equal(compararCampo('cofre()', '0xabc', null).confere, null);
});

function campoOk(nome: string): Campo {
    return { nome, obtido: '0xa', esperado: '0xa', confere: true };
}
function guardaOk(nome: string): Guarda {
    return { nome, esperava: 'NaoAutorizado()', respondeu: 'NaoAutorizado()', confere: true };
}

test('aprova quando os campos conferem e as guardas respondem', () => {
    const v = decidir([campoOk('dono()'), campoOk('pool()'), campoOk('cofre()')], [guardaOk('a'), guardaOk('b')], true);
    assert.equal(v.aprovado, true);
});

test('campo não conferido reprova como INCONCLUSIVO, não passa batido', () => {
    // O defeito que este projeto já pegou várias vezes: relatório completo,
    // sem erro nenhum à vista, que na verdade não mediu a única coisa que
    // importava. Aqui o cofre sem esperado tem que derrubar o veredicto.
    const v = decidir(
        [campoOk('dono()'), campoOk('pool()'), { nome: 'cofre()', obtido: '0xa', esperado: null, confere: null }],
        [guardaOk('a')],
        true,
    );
    assert.equal(v.aprovado, false);
    assert.match(v.motivo, /INCONCLUSIVO/);
    assert.match(v.motivo, /cofre\(\)/);
});

test('campo errado reprova antes de reclamar do que faltou conferir', () => {
    const v = decidir(
        [
            { nome: 'cofre()', obtido: '0xb', esperado: '0xa', confere: false },
            { nome: 'dono()', obtido: '0xa', esperado: null, confere: null },
        ],
        [guardaOk('a')],
        true,
    );
    assert.equal(v.aprovado, false);
    assert.match(v.motivo, /campo errado/);
});

test('guarda que não recusou reprova o contrato inteiro', () => {
    const v = decidir(
        [campoOk('dono()'), campoOk('pool()'), campoOk('cofre()')],
        [{ nome: 'cacar()', esperava: 'NaoAutorizado()', respondeu: 'NÃO RECUSOU (isso é grave)', confere: false }],
        true,
    );
    assert.equal(v.aprovado, false);
    assert.match(v.motivo, /guarda/);
});

test('endereço sem código reprova na hora', () => {
    const v = decidir([], [], false);
    assert.equal(v.aprovado, false);
    assert.match(v.motivo, /nada foi publicado/);
});

test('os seletores saem do nome da função, não de cópia', () => {
    for (const nome of LEITURAS) {
        assert.equal(SELETOR_DE[nome], id(nome).slice(0, 10));
        assert.equal(SELETOR_DE[nome].length, 10);
    }
    assert.equal(new Set(Object.values(SELETOR_DE)).size, LEITURAS.length);
});

test('cada erro do caçador tem um seletor próprio', () => {
    assert.equal(Object.keys(ERROS_DO_CACADOR).length, NOMES_DE_ERRO_DO_CACADOR.length);
    for (const nome of NOMES_DE_ERRO_DO_CACADOR) {
        assert.equal(ERROS_DO_CACADOR[id(nome).slice(0, 10)], nome);
    }
});

// ------------------------------------------------- conferência pelo bytecode

import { contemSeletor, lerArgumentosDoFim, conferirPrograma } from './conferirContrato';

/** A cauda real do deploy na Base, bloco 51497086: os dois endereços. */
const CAUDA_DO_DEPLOY =
    '000000000000000000000000a238dd80c259a72e81d7e4664a9801593f98d1c5' +
    '0000000000000000000000003dffa934170bdd491724747be2c4f56e3f1512a7';

test('lê os argumentos do construtor colados no fim do bytecode', () => {
    const [pool, cofre] = lerArgumentosDoFim('0x6080604052' + CAUDA_DO_DEPLOY, ['address', 'address']);
    assert.equal(pool, '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
    assert.equal(cofre, '0x3dffA934170bdD491724747Be2c4F56E3f1512A7');
});

test('acha seletor comum no bytecode', () => {
    assert.equal(contemSeletor('0x8063e7eb56ec1461078a57', '0xe7eb56ec'), true);
    assert.equal(contemSeletor('0x8063e7eb56ec1461078a57', '0xdeadbeef'), false);
});

test('acha seletor que começa com byte zero, que o solc guarda sem o zero', () => {
    // Trecho literal do contrato publicado: `PUSH31 e2a5cd00…` para o seletor
    // 0x00e2a5cd de ChamadaInesperada(). O zero da frente não está escrito.
    //
    // A primeira versão desta conferência procurava os oito caracteres e dizia
    // AUSENTE — um REPROVADO inteiro, confiante e errado, sobre um contrato
    // onde a função está. Este teste é o que impede a volta disso.
    const trecho = '0x6040517ee2a5cd00000000000000000000000000000000000000000000000000000000815260040160405180910390fd';
    assert.equal(contemSeletor(trecho, '0x00e2a5cd'), true);
    assert.equal(contemSeletor(trecho, '0x00a718a9'), false);
});

test('conferirPrograma separa o que está do que falta', () => {
    const comDono = '0x' + id('dono()').slice(2, 10) + 'ffff';
    const r = conferirPrograma(comDono, ['dono()', 'cofre()']);
    assert.deepEqual(r.presentes, ['dono()']);
    assert.deepEqual(r.ausentes, ['cofre()']);
    assert.equal(r.completo, false);
});
