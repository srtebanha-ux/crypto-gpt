// Config SO para o teste em fork (.tmp/fork). Nao entra no build do projeto.
//
// O download de compilador esta bloqueado neste ambiente
// (binaries.soliditylang.org -> ENOTFOUND), e o repositorio ja tem o solc
// 0.8.26 em wasm no node_modules. Entao a tarefa de obter o compilador e
// sobrescrita para apontar para ele: compilar com o solc do projeto e mais
// fiel ao que o deploy usaria do que baixar outro.
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => ({
    compilerPath: require.resolve('solc/soljson.js'),
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: require('solc/package.json').version,
}));

module.exports = {
    solidity: { version: '0.8.26', settings: { optimizer: { enabled: true, runs: 200 } } },
    paths: { sources: './contracts', tests: './forkTests', cache: './.tmp/hhcache', artifacts: './.tmp/artifacts' },
    networks: {
        hardhat: {
            forking: { url: 'https://mainnet.base.org' },
            chainId: 8453,
            // O Hardhat nao conhece a historia de hardforks da Base e recusa
            // qualquer chamada em bloco "historico" (o do proprio fork, inclusive).
            // Base esta em Cancun desde muito antes do bloco 52 milhoes.
            chains: { 8453: { hardforkHistory: { cancun: 0 } } },
        },
    },
};
