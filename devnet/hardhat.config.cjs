/**
 * Devnet compile + node config.
 *
 * Project root is devnet/, so `sources`, `artifacts` and `cache` resolve inside it and
 * never collide with the cranker itself. The cranker's production path (scripts/crank.mjs)
 * has no dependency on anything here.
 *
 * chainId 3141592 matches the local profile already present in the solstice repo's
 * deployments.json, so the quarter geometry below is theirs, not invented.
 */
module.exports = {
  solidity: {
    version: '0.8.36',
    settings: {
      optimizer: { enabled: true, runs: 2000 },
      viaIR: false,
      evmVersion: 'cancun',
      metadata: { bytecodeHash: 'none', appendCBOR: false },
    },
  },
  paths: {
    sources: './contracts',
    artifacts: './artifacts',
    cache: './cache',
  },
  networks: {
    hardhat: {
      chainId: 3141592,
      allowUnlimitedContractSize: false,
      mining: { auto: true, interval: 0 },
      // Mine a reverting transaction and return its hash, rather than answering the send with an
      // error. Hardhat's default does the latter, which is not how Filecoin behaves: Lotus accepts
      // the message and it lands on chain as a failed message (exit code 33). A devnet that throws
      // at send time would make scripts/crank-force.mjs report "nothing reached the chain" here
      // for a message that, on calibnet, would have landed.
      throwOnTransactionFailures: false,
      // Deterministic, publicly-documented Hardhat test accounts. These hold nothing
      // and exist only on this ephemeral local chain.
      accounts: { count: 10, accountsBalance: '10000000000000000000000' },
    },
  },
};
