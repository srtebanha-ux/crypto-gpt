/**
 * O custo completo da Base. A regra que decide tudo: UM componente desconhecido
 * torna o total desconhecido — nunca zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import {
    somarCusto, julgar, pisoDeLucro, codificarGetL1Fee, ORACULO_DE_GAS_L1,
    MARGEM_DE_SEGURANCA_POR_MIL, GORJETA_PADRAO_WEI, type ComponentesDoCusto,
} from './custoDaBase';

const cheio = (): ComponentesDoCusto => ({
    gasUsado: 300_000n,
    gasUsadoVeioDe: 'recibo',
    baseFeeWei: 5_000_000n,
    gorjetaWei: 20_000_000n,
    custoL1Wei: 1_337_035_464n,
    taxaDoEmprestimoWei: 0n,
});

test('o total soma L2, L1 e a taxa do empréstimo', () => {
    const c = somarCusto(cheio());
    assert.equal(c.totalWei, 300_000n * 25_000_000n + 1_337_035_464n);
    assert.deepEqual(c.faltam, []);
    assert.match(c.comoLer, /L2 /);
    assert.match(c.comoLer, /L1 1337035464/);
    assert.match(c.comoLer, /gasUsado de recibo/);
});

test('componente NEGATIVO não encolhe o custo: vira DESCONHECIDO', () => {
    // O portão olhava só `=== null`. Com `baseFeeWei` negativo a multiplicação
    // ENCOLHIA o total, e subestimar custo é o lado perigoso de errar — era uma
    // subtração de gorjeta (hoje removida do caçador) que podia produzir esse
    // negativo. O auditor apontou que o portão continuava ausente.
    const base = somarCusto(cheio());
    assert.ok(base.totalWei !== null && base.totalWei > 0n, 'a bancada tem de somar');
    for (const campo of ['gasUsado', 'baseFeeWei', 'gorjetaWei', 'custoL1Wei',
        'taxaDoEmprestimoWei'] as const) {
        const c = somarCusto({ ...cheio(), [campo]: -1n });
        assert.equal(c.totalWei, null, `${campo} negativo produziu total`);
        assert.match(c.faltam.join(' '), /NEGATIVO/, `${campo} negativo passou calado`);
        // E nada pode ser classificado como lucrativo por um custo encolhido.
        assert.equal(julgar(10n ** 18n, c).veredicto, 'custoDesconhecido');
        assert.equal(pisoDeLucro(c), null);
    }
    // ZERO continua sendo RESPOSTA, não ausência: a taxa do flash swap V2 é
    // zero de verdade, e tratá-la como negativa seria barrar o caso normal.
    const comZero = somarCusto({ ...cheio(), taxaDoEmprestimoWei: 0n });
    assert.ok(comZero.totalWei !== null, 'zero é resposta, não falta');
});

test('UM componente desconhecido torna o total DESCONHECIDO, nunca zero', () => {
    // A regra dela: *"Se algum componente não for conhecido, não classifique a
    // oportunidade como lucrativa."* Somar zero por um componente ausente é a
    // ausência com cara de resposta que este projeto persegue.
    for (const campo of ['gasUsado', 'baseFeeWei', 'gorjetaWei', 'custoL1Wei',
        'taxaDoEmprestimoWei'] as const) {
        const c = somarCusto({ ...cheio(), [campo]: null });
        assert.equal(c.totalWei, null, `${campo} ausente produziu total`);
        assert.ok(c.faltam.length > 0);
        assert.match(c.comoLer, /custo DESCONHECIDO/);
        // E NADA pode ser lucrativo com custo desconhecido.
        assert.equal(julgar(10n ** 18n, c).veredicto, 'custoDesconhecido');
        assert.equal(julgar(10n ** 18n, c).liquidoWei, null, 'líquido desconhecido virou número');
        assert.equal(pisoDeLucro(c), null);
    }
    // A ORIGEM do gasUsado também: um número sem origem não é medição.
    const semOrigem = somarCusto({ ...cheio(), gasUsadoVeioDe: 'desconhecido' });
    assert.equal(semOrigem.totalWei, null);
    assert.match(semOrigem.comoLer, /origem do gasUsado/);
});

test('taxa de empréstimo ZERO é resposta, não ausência', () => {
    // O flash swap V2 não cobra taxa separada: ela já está nas pernas. Aave V3
    // cobraria 0,05%, e por isso o campo existe em vez de a conta supor zero.
    const c = somarCusto({ ...cheio(), taxaDoEmprestimoWei: 0n });
    assert.notEqual(c.totalWei, null, 'zero foi tratado como ausente');
    const comTaxa = somarCusto({ ...cheio(), taxaDoEmprestimoWei: 500n });
    assert.equal(comTaxa.totalWei! - c.totalWei!, 500n);
});

test('o piso inclui a MARGEM DE SEGURANÇA, e bruto abaixo dele é deficitário', () => {
    const c = somarCusto(cheio());
    const piso = pisoDeLucro(c)!;
    assert.equal(piso, c.totalWei! + (c.totalWei! * MARGEM_DE_SEGURANCA_POR_MIL) / 1000n);
    assert.ok(piso > c.totalWei!, 'a margem não entrou no piso');

    // Bruto que cobre o custo mas NÃO a margem: deficitária, e o líquido sai
    // positivo — os dois números juntos, para quem lê poder discordar.
    const quaseLa = c.totalWei! + 1n;
    const j = julgar(quaseLa, c);
    assert.equal(j.veredicto, 'deficitaria');
    assert.equal(j.liquidoWei, 1n);
    assert.match(j.porque, /não alcança o piso/);

    // Acima do piso: lucrativa.
    const bom = julgar(piso + 1n, c);
    assert.equal(bom.veredicto, 'lucrativa');
    assert.equal(bom.liquidoWei, piso + 1n - c.totalWei!);
});

test('o calldata de getL1Fee é DERIVADO por keccak, não lembrado', () => {
    // Eu escrevi `0x49948e0e` de cabeça na primeira versão e acertei — e
    // acertar de cabeça não é método. Conferido na corrente: uma transação de
    // 242 bytes devolveu 1.337.035.464 wei.
    const d = codificarGetL1Fee(`0x${'02'.repeat(242)}`);
    assert.equal(d.slice(0, 10), id('getL1Fee(bytes)').slice(0, 10));
    // offset 0x20, depois o tamanho, depois o corpo em múltiplos de 32.
    assert.equal(d.slice(10, 74), '0'.repeat(62) + '20');
    assert.equal(BigInt(`0x${d.slice(74, 138)}`), 242n);
    assert.equal(((d.length - 2) / 2 - 4 - 64) % 32, 0, 'o corpo não ficou alinhado em 32 bytes');
    // O predeploy do oráculo de gás da OP Stack: o endereço é parte da rede.
    assert.equal(ORACULO_DE_GAS_L1.toLowerCase(),
        '0x420000000000000000000000000000000000000f');
});

test('a gorjeta padrão é declarada e positiva', () => {
    assert.ok(GORJETA_PADRAO_WEI > 0n, 'gorjeta zero seria lance zero');
});
