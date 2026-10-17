// Testes do Morpho usam somente mocks. Sem fork, sem RPC externo,
// sem carteira real e sem transacoes na Base.
const base = require('./hardhat.config.cjs');
module.exports = {
    ...base,
    networks: {
        hardhat: { chainId: 8453, allowUnlimitedContractSize: true },
    },
};
