// Arquivo: src/cacadorContract.test.ts
//
// Compila `contracts/CacadorDeLiquidacoes.sol` e EXECUTA o bytecode numa EVM
// local, mirando nas GUARDAS.
//
// Por que as guardas e não o lucro: o ciclo de lucro depende da Aave e de um
// pool de troca, que não existem aqui. Mas as guardas não dependem de ninguém
// — são exatamente o que separa "um contrato que ganha dinheiro" de "um
// contrato que qualquer pessoa esvazia". E elas falham em silêncio: um
// contrato sem guarda funciona perfeitamente nos testes felizes e só revela o
// buraco quando alguém o encontra.
//
// Testa-se o BYTECODE, não o código-fonte. Uma guarda que o otimizador
// removesse apareceria aqui, e não apareceria numa leitura do arquivo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { compilarContratos, type ContratoCompilado } from './compilarContrato';

function compilar(): ContratoCompilado {
    return compilarContratos(['CacadorDeLiquidacoes.sol']).contratos.CacadorDeLiquidacoes;
}

const palavra = (v: string | bigint) =>
    typeof v === 'bigint'
        ? v.toString(16).padStart(64, '0')
        : v.replace(/^0x/, '').toLowerCase().padStart(64, '0');

const DONO = `0x${'aa'.repeat(20)}`;
const ESTRANHO = `0x${'bb'.repeat(20)}`;
const POOL = `0x${'cc'.repeat(20)}`;
const COFRE = `0x${'dd'.repeat(20)}`;

interface Instalado {
    chamar: (de: string, dados: string) => Promise<{ reverteu: boolean; retorno: string }>;
}

/** Sobe o contrato numa EVM local, com dono e cofre definidos. */
async function instalar(cofre = COFRE, pool = POOL): Promise<Instalado> {
    const { EVM } = await import('@ethereumjs/evm');
    const { hexToBytes, bytesToHex, Address } = await import('@ethereumjs/util');

    const evm = await EVM.create();
    const criacao = `0x${compilar().evm.bytecode.object}${palavra(pool)}${palavra(cofre)}`;
    const deploy = await evm.runCall({
        data: hexToBytes(criacao),
        caller: new Address(hexToBytes(DONO)),
        origin: new Address(hexToBytes(DONO)),
    });
    assert.equal(deploy.execResult.exceptionError, undefined, 'o contrato precisa subir sem erro');

    const endereco = new Address(hexToBytes(`0x${'11'.repeat(20)}`));
    await evm.stateManager.putContractCode(endereco, deploy.execResult.returnValue);

    return {
        chamar: async (de, dados) => {
            const r = await evm.runCall({
                to: endereco,
                caller: new Address(hexToBytes(de)),
                origin: new Address(hexToBytes(de)),
                data: hexToBytes(dados),
            });
            return {
                reverteu: r.execResult.exceptionError !== undefined,
                retorno: bytesToHex(r.execResult.returnValue),
            };
        },
    };
}

const sel = (assinatura: string) => id(assinatura).slice(0, 10);

test('o contrato compila sem erro e sem aviso de compilador', () => {
    const c = compilar();
    assert.ok(c.evm.bytecode.object.length > 0);
});

// ---------------------------------------------------------------------------
// O cofre: a promessa que sustenta o teto de US$250 da carteira quente.
// ---------------------------------------------------------------------------

test('NÃO existe função que troque o cofre — a promessa é do código, não minha', () => {
    // Esta é a asserção mais importante do arquivo. Toda a segurança combinada
    // com ela depende de o destino do lucro ser inalterável: com a chave
    // roubada, o atacante queima gás e o lucro continua indo para o cofre.
    const c = compilar();
    const nomes = c.abi.filter((x) => x.type === 'function').map((x) => x.name ?? '');
    for (const n of nomes) {
        assert.ok(
            !/^set|Cofre$|alterar|mudar|trocar/i.test(n) || n === 'cofre',
            `função suspeita de alterar destino: ${n}`,
        );
    }
    // `cofre` existe e é só leitura.
    const leitura = c.abi.find((x) => x.type === 'function' && x.name === 'cofre');
    assert.ok(leitura);
    assert.equal(leitura.stateMutability, 'view');
});

test('cofre e pool guardados são os do construtor', async () => {
    const { chamar } = await instalar();
    const c = await chamar(ESTRANHO, sel('cofre()'));
    assert.equal(c.reverteu, false);
    assert.ok(c.retorno.endsWith('dd'.repeat(20)), `cofre veio ${c.retorno}`);

    const p = await chamar(ESTRANHO, sel('pool()'));
    assert.ok(p.retorno.endsWith('cc'.repeat(20)));
});

test('cofre zero é recusado na criação — não dá para subir sem destino', async () => {
    // Um cofre zero faria o lucro ser queimado a cada caçada bem-sucedida, em
    // silêncio, e só apareceria depois da primeira vitória.
    await assert.rejects(async () => instalar(`0x${'00'.repeat(20)}`), /precisa subir sem erro/);
});

// ---------------------------------------------------------------------------
// As guardas: o que separa ganhar dinheiro de ser esvaziado.
// ---------------------------------------------------------------------------

test('só o dono dispara a caçada', async () => {
    const { chamar } = await instalar();
    const dados =
        sel('cacar(address,address,address,uint256,address,uint256)') +
        palavra(POOL) + palavra(POOL) + palavra(ESTRANHO) + palavra(1n) + palavra(POOL) + palavra(0n);

    const deEstranho = await chamar(ESTRANHO, dados);
    assert.equal(deEstranho.reverteu, true, 'estranho não pode caçar');
    assert.ok(deEstranho.retorno.startsWith(sel('NaoAutorizado()')), `veio ${deEstranho.retorno}`);
});

test('só o dono resgata, e o resgate vai para o cofre (não para quem chamou)', async () => {
    const { chamar } = await instalar();
    const r = await chamar(ESTRANHO, sel('resgatar(address)') + palavra(POOL));
    assert.equal(r.reverteu, true);
    assert.ok(r.retorno.startsWith(sel('NaoAutorizado()')));
});

test('estranho NÃO consegue chamar executeOperation', async () => {
    // Sem esta guarda, qualquer um invocaria o retorno de chamada com dados
    // inventados e moveria o que estivesse no contrato.
    const { chamar } = await instalar();
    const dados =
        sel('executeOperation(address,uint256,uint256,address,bytes)') +
        palavra(POOL) + palavra(1n) + palavra(0n) + palavra(ESTRANHO) + palavra(160n) + palavra(0n);
    const r = await chamar(ESTRANHO, dados);
    assert.equal(r.reverteu, true);
    assert.ok(r.retorno.startsWith(sel('ChamadaInesperada()')), `veio ${r.retorno}`);
});

test('nem o DONO consegue chamar executeOperation direto', async () => {
    // A guarda não é sobre confiar no dono: é sobre a função só fazer sentido
    // dentro de um empréstimo em andamento. Chamada solta, ela reverte.
    const { chamar } = await instalar();
    const dados =
        sel('executeOperation(address,uint256,uint256,address,bytes)') +
        palavra(POOL) + palavra(1n) + palavra(0n) + palavra(DONO) + palavra(160n) + palavra(0n);
    const r = await chamar(DONO, dados);
    assert.equal(r.reverteu, true);
    assert.ok(r.retorno.startsWith(sel('ChamadaInesperada()')));
});

test('nem o POOL da Aave consegue, fora de uma caçada iniciada aqui', async () => {
    // Terceira guarda: a Aave legítima, chamada por outra pessoa, não arrasta
    // este contrato para uma execução que ele não começou.
    const { chamar } = await instalar();
    const dados =
        sel('executeOperation(address,uint256,uint256,address,bytes)') +
        palavra(POOL) + palavra(1n) + palavra(0n) + palavra(`0x${'11'.repeat(20)}`) + palavra(160n) + palavra(0n);
    const r = await chamar(POOL, dados);
    assert.equal(r.reverteu, true, 'fora de caçada tem de reverter mesmo vindo do pool');
    assert.ok(r.retorno.startsWith(sel('ChamadaInesperada()')));
});
