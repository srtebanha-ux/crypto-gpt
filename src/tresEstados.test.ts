/**
 * OS TRES ESTADOS, e as quatro frases dela que eles existem para honrar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classificar } from './causaDaFalha';

test('só execução integral com líquido positivo é EXECUTAVEL_EM_SIMULACAO', () => {
    const c = classificar({ executouComLucro: { liquidoWei: 500n } });
    assert.equal(c.estado, 'EXECUTAVEL_EM_SIMULACAO');
    assert.equal(c.liquidoWei, 500n);
});

test('executou e não pagou: DESCARTADA, e a prova é a execução', () => {
    const c = classificar({ executouComLucro: { liquidoWei: -5n } });
    assert.equal(c.estado, 'DESCARTADA');
    assert.match(c.porque, /COMPROVADA pela própria execução/);
    // Zero tambem nao paga, e tambem e comprovado.
    assert.equal(classificar({ executouComLucro: { liquidoWei: 0n } }).estado, 'DESCARTADA');
});

test('`gasDesconhecido` NÃO significa prejuízo: é NAO_VALIDADA', () => {
    const c = classificar({
        limitacaoDoAvaliador: { porque: 'o lucro sobraria em token sem preço e não sei o gás' },
        inviavelComprovada: { porque: 'não paga o gás' },
    });
    // A limitacao vence a "inviabilidade": sem saber o custo, aquela conclusao
    // nao se tem. E a ordem e o conteudo do teste.
    assert.equal(c.estado, 'NAO_VALIDADA');
    assert.match(c.porque, /limitação do AVALIADOR/);
    assert.equal(c.liquidoWei, null);
});

test('inviabilidade COMPROVADA sem limitação é DESCARTADA', () => {
    const c = classificar({ inviavelComprovada: { porque: 'a sobra é negativa em todo tamanho' } });
    assert.equal(c.estado, 'DESCARTADA');
    assert.equal(c.liquidoWei, null);
});

test('sem evidência nenhuma: NAO_VALIDADA, nunca DESCARTADA', () => {
    const c = classificar({});
    assert.equal(c.estado, 'NAO_VALIDADA');
    assert.match(c.porque, /nenhuma evidência/);
    // E o default importa: tratar ausencia como descarte foi o que fez o TITAN
    // publicar "0 oportunidades" por um mes.
    assert.notEqual(c.estado, 'DESCARTADA');
});

test('o líquido só existe no estado executável', () => {
    for (const e of [
        classificar({}),
        classificar({ limitacaoDoAvaliador: { porque: 'x' } }),
        classificar({ inviavelComprovada: { porque: 'y' } }),
    ]) {
        assert.equal(e.liquidoWei, null, `${e.estado} publicou líquido sem execução`);
    }
});
