// Isolated EVM: no fork, public RPC, credentials or real balances.
module.exports = {
  solidity: '0.8.26',
  paths: { tests: './forkTests' },
  networks: { hardhat: { chainId: 8453 } },
};
