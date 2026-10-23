require('ts-node/register');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {network} = require('hardhat');
const {BrowserProvider, Wallet, zeroPadValue, toBeHex} = require('ethers');
const {ExecutorMegazord} = require('../src/megazordExecutor');

describe('Megazord shared executor on isolated EVM', function () {
  this.timeout(20000);
  it('mines concurrent strategy requests and Aave wallet adapter with successive nonces', async () => {
    const key = '0x' + '11'.repeat(32); // Public fixture; local funds only.
    const target = '0x' + '22'.repeat(20);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-evm-'));
    const journal = path.join(dir, 'journal.json');
    const primary = new BrowserProvider(network.provider, undefined, {cacheTimeout: -1});
    const secondary = new BrowserProvider(network.provider, undefined, {cacheTimeout: -1});
    primary.pollingInterval = secondary.pollingInterval = 10;
    let executor;
    try {
      await network.provider.send('hardhat_setBalance', [new Wallet(key).address, toBeHex(10n ** 20n)]);
      // Runtime stores the first calldata word in storage slot zero.
      await network.provider.send('hardhat_setCode', [target, '0x60003560005500']);
      executor = new ExecutorMegazord(key, primary, secondary, {
        journal, maxDailyWei: 10n ** 18n, maxPerTxWei: 10n ** 17n,
        maxDailyTx: 5, contracts: [target],
      }, async () => 1n); // L1 oracle intentionally stubbed; this is not a Base fork.
      const receipts = [];
      const submit = (strategy, nonce, value) => executor.run(strategy, async () => {
        const raw = await executor.sign({
          chainId: 8453, type: 2, nonce, to: target,
          data: zeroPadValue(toBeHex(value), 32), gasLimit: 100000n,
          maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n,
        });
        const response = await executor.broadcast(raw);
        receipts.push(await response.wait());
      });
      await Promise.all([submit('arbitragem', 0, 41), submit('morpho', 1, 42)]);
      const wallet = executor.wallet(key, primary);
      const response = await wallet.sendTransaction({
        to: target, data: zeroPadValue(toBeHex(43), 32),
        gasLimit: 100000n, maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
      receipts.push(await response.wait());
      await executor.reconcile();
      assert.ok(receipts.every(r => r.status === 1));
      assert.equal(await primary.getTransactionCount(executor.address, 'latest'), 3);
      assert.equal(BigInt(await primary.getStorage(target, 0)), 43n);
      const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
      assert.equal(saved.pending, null);
      assert.deepEqual(saved.receipts.map(r => r.nonce), [0, 1, 2]);
      assert.deepEqual(saved.receipts.map(r => r.strategy), ['arbitragem', 'morpho', 'liquidacao-aave']);
      assert.equal(Object.values(saved.days)[0].attempts, 3);
    } finally {
      executor?.close();
      primary.destroy(); secondary.destroy();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
