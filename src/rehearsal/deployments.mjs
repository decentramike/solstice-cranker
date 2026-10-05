/**
 * Contract addresses for rehearsal mode, read from filecoin-project/solstice's deployments.json.
 *
 * Not from config/networks.json and not from a repository variable: the upstream file is the
 * record of what was deployed, and a copy kept here is one more place for an address to go stale.
 *
 * Read at the same upstream commit the ABI was built from (abi/selectors.json), not at main: the
 * addresses and the ABI then always describe the same deployment, and an upstream edit reaches
 * the cranker only through a reviewed change here (moving REF in devnet/prepare-contracts.mjs and
 * rebuilding abi/). SOLSTICE_DEPLOYMENTS points somewhere else -- another ref's raw URL, or a
 * local file (the tests use one for their mock contracts).
 */
import { readFileSync } from 'node:fs';
import { getAddress, isAddress } from 'ethers';

import selectors from '../../abi/selectors.json' with { type: 'json' };
import { ZERO_ADDRESS } from '../config.mjs';

const PINNED_REF = selectors.generatedFrom?.ref;
if (!/^[0-9a-f]{40}$/.test(PINNED_REF ?? '')) {
  throw new Error('abi/selectors.json does not record the upstream commit it was built from');
}

export const DEFAULT_DEPLOYMENTS =
  `https://raw.githubusercontent.com/filecoin-project/solstice/${PINNED_REF}/deployments.json`;

export class DeploymentsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeploymentsError';
  }
}

async function fetchText(url, { attempts = 3, timeoutMs = 10_000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new DeploymentsError(`could not fetch ${url}: ${lastErr?.message ?? lastErr}`);
}

/**
 * @returns {Promise<{sra: string, swa: string, source: string}>}
 */
export async function loadDeployments(source = DEFAULT_DEPLOYMENTS, chainId) {
  const isUrl = /^https?:\/\//i.test(source);
  let text;
  if (isUrl) {
    text = await fetchText(source);
  } else {
    try {
      text = readFileSync(source, 'utf8');
    } catch (err) {
      throw new DeploymentsError(`cannot read deployments file ${source}: ${err.code ?? err.message}`);
    }
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new DeploymentsError(`${source} is not valid JSON: ${err.message}`);
  }
  const entry = doc?.[String(chainId)];
  if (!entry) throw new DeploymentsError(`${source} has no entry for chain ${chainId}`);

  const out = { source };
  for (const key of ['sra', 'swa']) {
    const v = entry[key];
    if (!isAddress(v ?? '')) throw new DeploymentsError(`${source}: chain ${chainId} ${key} is not an address: ${v}`);
    const addr = getAddress(v);
    if (addr === ZERO_ADDRESS) throw new DeploymentsError(`${source}: chain ${chainId} ${key} is the zero address -- not deployed`);
    out[key] = addr;
  }
  return out;
}
