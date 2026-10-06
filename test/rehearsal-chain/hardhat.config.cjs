/**
 * A throwaway local chain for rehearsal-mode tests. It reports calibnet's chain id (314159) unless
 * REHEARSAL_TEST_CHAIN_ID says otherwise, because rehearsal mode refuses every other chain -- and
 * the tests also need a chain it must refuse. Nothing here talks to calibnet.
 */
module.exports = {
  solidity: {
    version: '0.8.36',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' },
  },
  paths: { sources: './contracts', artifacts: './artifacts', cache: './cache' },
  networks: {
    hardhat: {
      chainId: Number(process.env.REHEARSAL_TEST_CHAIN_ID || 314159),
      mining: { auto: true, interval: 0 },
      // Mine a reverting transaction and return its hash, as Lotus does (exit code 33 on chain),
      // instead of answering the send with an error.
      throwOnTransactionFailures: false,
      // The public Hardhat test mnemonic's accounts. They hold nothing anywhere real.
      accounts: { count: 4, accountsBalance: '10000000000000000000000' },
    },
  },
};
