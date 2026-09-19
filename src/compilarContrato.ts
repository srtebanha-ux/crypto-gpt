// Arquivo: src/compilarContrato.ts
//
// UM lugar só para as opções do compilador — e o motivo não é arrumação.
//
// O teste do ciclo falhou com "invalid opcode" ao subir os dublês. A causa:
// o solc 0.8.26 mira em Cancun por padrão e emite instruções que a EVM local
// (Shanghai) não conhece. Consertar era uma linha.
//
// Mas o conserto fácil abria um buraco pior: eu ajustaria a opção NO TESTE, e
// o deploy continuaria compilando com o padrão. Aí o bytecode testado e o
// bytecode publicado seriam DIFERENTES — e todo este arquivo de testes estaria
// aprovando um contrato que não é o que vai para a rede.
//
// É a mesma família de defeito que este projeto já pegou no motor ao vivo
// contra o backtest: dois caminhos lendo configurações separadas, concordando
// enquanto ninguém olha. Por isso as opções moram aqui, e quem compilar
// compila daqui — teste e deploy pela mesma porta.
//
// Shanghai e não Cancun de propósito: a Base aceita as duas, a EVM de teste só
// aceita Shanghai, e entre "testar o que se publica" e "usar instruções mais
// novas" a primeira vale mais. Nenhuma instrução de Cancun faz falta aqui.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERSAO_DA_EVM = 'shanghai';

export interface ContratoCompilado {
    abi: Array<{ type: string; name?: string; stateMutability?: string }>;
    evm: { bytecode: { object: string } };
}

export interface ResultadoDaCompilacao {
    contratos: Record<string, ContratoCompilado>;
    avisos: string[];
}

/**
 * Compila arquivos de `contracts/` e devolve tudo o que saiu.
 *
 * Erro de compilação vira exceção com a mensagem inteira: uma compilação que
 * falha e devolve objeto vazio faria o teste seguinte reclamar de "contrato
 * não encontrado", que é a pergunta errada.
 */
export function compilarContratos(arquivos: string[]): ResultadoDaCompilacao {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const solc = require('solc');
    const dir = join(__dirname, '..', 'contracts');
    const sources: Record<string, { content: string }> = {};
    for (const a of arquivos) sources[a] = { content: readFileSync(join(dir, a), 'utf8') };

    const saida = JSON.parse(
        solc.compile(
            JSON.stringify({
                language: 'Solidity',
                sources,
                settings: {
                    optimizer: { enabled: true, runs: 200 },
                    evmVersion: VERSAO_DA_EVM,
                    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
                },
            }),
        ),
    ) as {
        errors?: Array<{ severity: string; formattedMessage: string }>;
        contracts: Record<string, Record<string, ContratoCompilado>>;
    };

    const erros = (saida.errors ?? []).filter((e) => e.severity === 'error');
    if (erros.length > 0) throw new Error(erros.map((e) => e.formattedMessage).join('\n'));

    const contratos: Record<string, ContratoCompilado> = {};
    for (const a of arquivos) Object.assign(contratos, saida.contracts[a] ?? {});
    return {
        contratos,
        avisos: (saida.errors ?? []).filter((e) => e.severity === 'warning').map((e) => e.formattedMessage),
    };
}
