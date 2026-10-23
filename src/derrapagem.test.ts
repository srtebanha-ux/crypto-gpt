import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { derrapagemDaEntrada } from './derrapagem';

test('comprar mais caro que o sinal é derrapagem CONTRA', () => {
    const d = derrapagemDaEntrada({
        precoDoSinal: new Decimal('100'),
        entrada: new Decimal('100.1'),
        direcao: 'alta',
    });
    assert.equal(d?.toFixed(4), '0.1000');
});

test('vender mais barato que o sinal é derrapagem CONTRA', () => {
    // O mesmo prejuízo do caso acima, com o preço andando para o outro lado.
    const d = derrapagemDaEntrada({
        precoDoSinal: new Decimal('100'),
        entrada: new Decimal('99.9'),
        direcao: 'baixa',
    });
    assert.equal(d?.toFixed(4), '0.1000');
});

test('vender mais caro que o sinal é derrapagem A FAVOR', () => {
    const d = derrapagemDaEntrada({
        precoDoSinal: new Decimal('100'),
        entrada: new Decimal('100.1'),
        direcao: 'baixa',
    });
    assert.equal(d?.toFixed(4), '-0.1000');
});

test('os dois lados são simétricos no mesmo deslocamento', () => {
    const alta = derrapagemDaEntrada({
        precoDoSinal: new Decimal('100'),
        entrada: new Decimal('100.5'),
        direcao: 'alta',
    });
    const baixa = derrapagemDaEntrada({
        precoDoSinal: new Decimal('100'),
        entrada: new Decimal('99.5'),
        direcao: 'baixa',
    });
    assert.equal(alta?.toString(), baixa?.toString());
});

test('a entrada PONSUSDT real de 17/09 dá -0,2919%', () => {
    // A primeira entrada em que o log trouxe os dois preços por extenso, e a
    // mesma em que o campo saiu "—". Fica aqui como âncora: se algum dia a
    // conta mudar, este número tem de continuar saindo.
    const d = derrapagemDaEntrada({
        precoDoSinal: new Decimal('0.651'),
        entrada: new Decimal('0.6528999999999999'),
        direcao: 'baixa',
    });
    assert.equal(d?.toFixed(4), '-0.2919');
});

test('sem preço do sinal não há conta', () => {
    assert.equal(
        derrapagemDaEntrada({
            precoDoSinal: new Decimal('0'),
            entrada: new Decimal('100'),
            direcao: 'alta',
        }),
        null,
    );
});

test('preço médio ausente na resposta da ordem NÃO impede a conta', () => {
    // O defeito que este módulo existe para matar: a Binance devolve
    // avgPrice 0 numa ordem a mercado, e o guarda antigo exigia esse campo
    // para calcular algo que não depende dele. Resultado: derrapagem "—" em
    // toda entrada, sempre, sem nenhum erro na tela.
    //
    // A assinatura aqui nem aceita preço médio. Essa é a correção.
    const d = derrapagemDaEntrada({
        precoDoSinal: new Decimal('0.651'),
        entrada: new Decimal('0.6529'),
        direcao: 'baixa',
    });
    assert.notEqual(d, null);
});
