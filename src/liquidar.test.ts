import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { lerRespostaDaCaca } from './caca';
import {
    COBRIR_O_MAXIMO,
    ERROS_DA_AAVE,
    ERROS_PERSONALIZADOS,
    NOMES_DE_ERRO_DA_AAVE,
    SELETOR_LIQUIDATION_CALL,
    codificarLiquidacao,
    ehLimiteDoProvedor,
    codificarUserReserveData,
    naoCruzouAinda,
    decodificarUserReserveData,
    escolherPar,
    lerRespostaDaAave,
    type ReservaDoUsuario,
} from './liquidar';

const coder = AbiCoder.defaultAbiCoder();
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEVEDOR = '0x67d0938f00000000000000000000000000000001';

test('o seletor bate com keccak da assinatura', () => {
    assert.equal(SELETOR_LIQUIDATION_CALL, '0x00a718a9');
});

test('os cinco argumentos vão na ordem e voltam iguais', () => {
    // Trocar garantia com dívida é o erro mais fácil de cometer aqui, e o mais
    // caro: a Aave aceitaria a chamada e liquidaria o par errado.
    const c = codificarLiquidacao({
        garantia: WETH,
        divida: USDC,
        devedor: DEVEDOR,
        quantoCobrir: 123456n,
        receberAToken: false,
    });
    assert.ok(c.startsWith(SELETOR_LIQUIDATION_CALL));

    const [g, d, u, q, a] = coder.decode(
        ['address', 'address', 'address', 'uint256', 'bool'],
        `0x${c.slice(10)}`,
    ) as unknown as [string, string, string, bigint, boolean];
    assert.equal(g.toLowerCase(), WETH, 'a GARANTIA é o primeiro argumento');
    assert.equal(d.toLowerCase(), USDC, 'a DÍVIDA é o segundo');
    assert.equal(u.toLowerCase(), DEVEDOR);
    assert.equal(q, 123456n);
    assert.equal(a, false);
});

test('COBRIR_O_MAXIMO é o maior uint256, e cabe na codificação', () => {
    assert.equal(COBRIR_O_MAXIMO, 2n ** 256n - 1n);
    const c = codificarLiquidacao({
        garantia: WETH,
        divida: USDC,
        devedor: DEVEDOR,
        quantoCobrir: COBRIR_O_MAXIMO,
        receberAToken: false,
    });
    const [, , , q] = coder.decode(
        ['address', 'address', 'address', 'uint256', 'bool'],
        `0x${c.slice(10)}`,
    ) as unknown as [string, string, string, bigint, boolean];
    assert.equal(q, COBRIR_O_MAXIMO);
});

// ---------------------------------------------------------------------------
// A resposta da Aave: entender é diferente de conseguir.
// ---------------------------------------------------------------------------

test('o código 45 é SUCESSO do ensaio, não fracasso', () => {
    // A Aave dizendo "essa posição está saudável" prova que ela LEU o pedido.
    // É a melhor resposta possível para um ensaio contra posição que não caiu.
    const r = lerRespostaDaAave('execution reverted: 45');
    assert.equal(r.entendeu, true);
    assert.equal(r.codigo, '45');
    assert.match(r.texto, /SAUDÁVEL/);
});

test('os vários embrulhos de provedor são todos reconhecidos', () => {
    for (const forma of ['execution reverted: 45', "reverted: '45'", '45', 'reverted 45']) {
        const r = lerRespostaDaAave(forma);
        assert.equal(r.entendeu, true, forma);
        assert.equal(r.codigo, '45', forma);
    }
});

test('código desconhecido é dito como desconhecido, não inventado', () => {
    const r = lerRespostaDaAave('execution reverted: 77');
    assert.equal(r.entendeu, true);
    assert.equal(r.codigo, '77');
    assert.match(r.texto, /ainda não traduzi/);
});

test('erro que NÃO é da Aave aponta o dedo para mim, não para a posição', () => {
    // Esta é a distinção que o ensaio inteiro existe para fazer.
    const r = lerRespostaDaAave('invalid opcode');
    assert.equal(r.entendeu, false);
    assert.equal(r.codigo, null);
    assert.match(r.texto, /FORMATO meu/);
});

test('o dicionário cobre os erros de liquidação que importam', () => {
    for (const c of ['45', '46', '47']) assert.ok(ERROS_DA_AAVE[c]);
});

// ---------------------------------------------------------------------------
// Escolher o par: garantia e dívida.
// ---------------------------------------------------------------------------

function reserva(p: Partial<ReservaDoUsuario>): ReservaDoUsuario {
    return { garantiaCrua: 0n, dividaCrua: 0n, usadaComoGarantia: false, ...p };
}

test('escolhe a maior garantia e a maior dívida', () => {
    const par = escolherPar([
        { ativo: WETH, dados: reserva({ garantiaCrua: 100n, usadaComoGarantia: true }) },
        { ativo: USDC, dados: reserva({ garantiaCrua: 999n, usadaComoGarantia: true, dividaCrua: 5n }) },
        { ativo: DEVEDOR, dados: reserva({ dividaCrua: 900n }) },
    ]);
    assert.deepEqual(par, { garantia: USDC, divida: DEVEDOR });
});

test('garantia NÃO marcada como garantia não serve de prêmio', () => {
    // Está depositada, mas o dono desmarcou. A Aave recusaria com o código 46.
    const par = escolherPar([
        { ativo: WETH, dados: reserva({ garantiaCrua: 10_000n, usadaComoGarantia: false }) },
        { ativo: USDC, dados: reserva({ garantiaCrua: 5n, usadaComoGarantia: true, dividaCrua: 900n }) },
    ]);
    assert.equal(par?.garantia, USDC);
});

test('sem dívida ou sem garantia não há par, e isso é null e não um chute', () => {
    assert.equal(escolherPar([]), null);
    assert.equal(
        escolherPar([{ ativo: WETH, dados: reserva({ garantiaCrua: 10n, usadaComoGarantia: true }) }]),
        null,
        'tem garantia mas não deve nada',
    );
    assert.equal(
        escolherPar([{ ativo: WETH, dados: reserva({ dividaCrua: 10n }) }]),
        null,
        'deve mas não tem garantia',
    );
});

test('os dados da reserva saem das palavras certas', () => {
    const w = (v: bigint) => v.toString(16).padStart(64, '0');
    const bruto = `0x${w(111n)}${w(0n)}${w(222n)}${w(0n)}${w(0n)}${w(0n)}${w(0n)}${w(0n)}${w(1n)}`;
    const d = decodificarUserReserveData(bruto);
    assert.equal(d.garantiaCrua, 111n);
    assert.equal(d.dividaCrua, 222n);
    assert.equal(d.usadaComoGarantia, true);
});

test('resposta curta é erro, não zeros silenciosos', () => {
    assert.throws(() => decodificarUserReserveData('0xabcd'), /menos de 9 palavras/);
});

test('a consulta de reserva leva ativo e usuário, nessa ordem', () => {
    const c = codificarUserReserveData(WETH, DEVEDOR);
    const [a, u] = coder.decode(['address', 'address'], `0x${c.slice(10)}`) as unknown as [string, string];
    assert.equal(a.toLowerCase(), WETH);
    assert.equal(u.toLowerCase(), DEVEDOR);
});

// ---------------------------------------------------------------------------
// A Aave NOVA fala por assinatura, não por número. Achado no primeiro ensaio.
// ---------------------------------------------------------------------------

test('0x930bb771 é HealthFactorNotBelowThreshold — o 45 da Aave nova', () => {
    // Este seletor veio da Base de verdade, no ensaio de 19/09. O teste trava
    // a descoberta: se a lista de nomes mudar e este deixar de casar, quebra
    // aqui em vez de virar "erro desconhecido" silencioso lá na frente.
    assert.equal(id('HealthFactorNotBelowThreshold()').slice(0, 10), '0x930bb771');
    const r = lerRespostaDaAave('execution reverted | 0x930bb771');
    assert.equal(r.entendeu, true);
    assert.equal(r.codigo, 'HealthFactorNotBelowThreshold()');
    assert.match(r.texto, /SAUDÁVEL/);
});

test('as assinaturas são calculadas dos nomes, nunca copiadas à mão', () => {
    // Seletor digitado errado não falha alto: ele nunca casa, e o erro vira
    // "desconhecido" para sempre. Calcular elimina a classe inteira.
    for (const [nome] of NOMES_DE_ERRO_DA_AAVE) {
        const sel = id(nome).slice(0, 10);
        assert.equal(ERROS_PERSONALIZADOS[sel].nome, nome);
    }
    assert.equal(Object.keys(ERROS_PERSONALIZADOS).length, NOMES_DE_ERRO_DA_AAVE.length);
});

test('erro personalizado que eu não traduzi ainda conta como ENTENDIDO', () => {
    // Responder com erro dela já prova que leu o pedido, mesmo que eu não
    // saiba o nome. Tratar isso como reprovação esconderia um ensaio aprovado.
    const r = lerRespostaDaAave('execution reverted | 0xdeadbeef');
    assert.equal(r.entendeu, true);
    assert.equal(r.codigo, '0xdeadbeef');
    assert.match(r.texto, /já prova que ela leu/);
});

test('a língua antiga continua sendo entendida', () => {
    // Redes diferentes rodam versões diferentes da Aave.
    const r = lerRespostaDaAave('execution reverted: 45');
    assert.equal(r.entendeu, true);
    assert.equal(r.codigo, '45');
});

test('"over rate limit" NÃO é erro de formato, e a mensagem diz isso', () => {
    // Dois dos cinco ensaios caíram assim, e contá-los como reprovação
    // culparia o meu código por um limite do provedor.
    const r = lerRespostaDaAave('over rate limit');
    assert.equal(r.entendeu, false);
    assert.match(r.texto, /over rate limit/);
});

test('limite do provedor NÃO é reprovação — é ausência de teste', () => {
    // O ensaio voltou "PARCIAL: 4 de 5" porque um alvo caiu em "over rate
    // limit". A mensagem já dizia que não era erro de formato, mas o veredicto
    // contava como falha e rebaixava um ensaio aprovado.
    const r = lerRespostaDaAave('over rate limit');
    assert.equal(r.entendeu, false);
    assert.equal(r.naoDeuParaTestar, true);
    assert.match(r.texto, /NÃO DEU PARA TESTAR/);
});

test('as formas de recusa do provedor são reconhecidas', () => {
    for (const m of ['over rate limit', 'HTTP 429', 'Too Many Requests', 'query timeout', 'over capacity']) {
        assert.equal(ehLimiteDoProvedor(m), true, m);
    }
    assert.equal(ehLimiteDoProvedor('execution reverted'), false);
    assert.equal(ehLimiteDoProvedor('invalid opcode'), false);
});

test('erro de formato de verdade continua apontando para mim', () => {
    const r = lerRespostaDaAave('invalid opcode');
    assert.equal(r.entendeu, false);
    assert.equal(r.naoDeuParaTestar, false);
    assert.match(r.texto, /FORMATO meu/);
});

test('recusa reconhecida da Aave nunca é confundida com limite de provedor', () => {
    const r = lerRespostaDaAave('execution reverted | 0x930bb771');
    assert.equal(r.naoDeuParaTestar, false);
    assert.equal(r.entendeu, true);
});

// ---------------------------------------------------------------------------
// `naoCruzouAinda` — o portão que autoriza MANDAR DINHEIRO DE VERDADE antes do
// cruzamento. A primeira versão não tinha teste nenhum, e saiu invertida.
// ---------------------------------------------------------------------------

test('o caso real medido na Base: prosa vazia de sentido, identidade nos dados', () => {
    // eth_call no contrato V1, alvo 0xc4d36f95, 2026-09-28:
    //     message : "execution reverted"
    //     data    : 0x930bb771   = HealthFactorNotBelowThreshold()
    // A mensagem não identifica nada; o seletor identifica tudo.
    assert.equal(naoCruzouAinda('execution reverted', '0x930bb771'), true);
    assert.equal(id('HealthFactorNotBelowThreshold()').slice(0, 10), '0x930bb771');
});

test('reversão OPACA não autoriza tiro: sem dados, sem identificação, não atira', () => {
    // Esta é a inversão que existia. `/revert/i` dava true para tudo, e TODA
    // prosa que `lerRespostaDaCaca` monta para um `revertido` contém "revert":
    // "execution reverted" do RPC, o padrão 'revertido', e a literal
    // 'revertido sem mensagem'. O portão era sempre-verdadeiro.
    assert.equal(naoCruzouAinda('execution reverted'), false);
    assert.equal(naoCruzouAinda('revertido'), false);
    assert.equal(naoCruzouAinda('revertido sem mensagem'), false);
    assert.equal(naoCruzouAinda(''), false);
    assert.equal(naoCruzouAinda(undefined), false, 'ausência de erro não é medição');
});

test('erro do NOSSO contrato não é "ainda não cruzou" — é configuração quebrada', () => {
    // O perigo concreto: a caçada reverte porque o pool de venda está errado, o
    // par está trocado ou o swap é degenerado. A prosa continua sendo
    // "execution reverted", e a versão antiga mandava a transação assim mesmo.
    const outro = id('PoolDeVendaInvalido()').slice(0, 10);
    assert.notEqual(outro, '0x930bb771');
    assert.equal(naoCruzouAinda('execution reverted', outro), false);
});

test('o dialeto antigo da Aave, o código 45, continua valendo', () => {
    assert.equal(naoCruzouAinda('execution reverted: 45'), true);
    assert.equal(naoCruzouAinda('45'), true);
});

test('outro erro identificado da Aave não vira "espere"', () => {
    // 43 é COLLATERAL_CANNOT_BE_LIQUIDATED: motivo diferente, não é "ainda não".
    assert.equal(naoCruzouAinda('execution reverted: 43'), false);
});

test('falha de provedor nunca autoriza: não mediu nada', () => {
    assert.equal(naoCruzouAinda('429 Too Many Requests'), false);
    assert.equal(naoCruzouAinda('rate limit exceeded'), false);
});

test('lerRespostaDaCaca entrega os dados crus junto, e não só a prosa', () => {
    // Era aqui que a identidade se perdia: a função ficava com `r.mensagem` e
    // descartava `r.dados`, que é o único campo que diz QUAL erro foi.
    const r = lerRespostaDaCaca({ ok: false, dados: '0x930bb771', mensagem: 'execution reverted' });
    assert.equal(r.desfecho, 'revertido');
    assert.equal(r.dadosCrus, '0x930bb771');
    assert.equal(naoCruzouAinda(r.erro, r.dadosCrus), true, 'o par completo identifica');
});
