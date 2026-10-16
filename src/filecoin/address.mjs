/**
 * Filecoin addresses: string <-> bytes, for both networks.
 *
 * The network prefix is a parameter everywhere, never a constant. The Claim tool this came
 * from hard-coded `t` and rejected `f`; on Mainnet that is exactly backwards. A parse that
 * meets the other network's prefix throws, because an `f` address in a Calibnet run (or the
 * reverse) means the inputs were mixed up, and a mixed-up Claim is gas spent for nothing.
 *
 * Protocols handled: 0 (ID), 1 (secp256k1), 3 (BLS), and 4 in the EVM namespace 10 (f410).
 * A 0x Ethereum address is accepted on input and becomes its f410 form, which is how
 * deployments.json names payout wallets.
 */
import { blake2b } from '@noble/hashes/blake2b';

import { concat } from './cbor.mjs';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const PREFIX = { mainnet: 'f', calibnet: 't', devnet: 't' };

export function b32encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s.toLowerCase()) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error(`invalid base32 character "${c}"`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function leb128(n) {
  n = BigInt(n);
  if (n < 0n) throw new Error('negative actor ID');
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Uint8Array.from(out);
}

export function unleb128(bytes) {
  let n = 0n;
  let shift = 0n;
  for (const b of bytes) {
    n |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (!(b & 0x80)) return n;
  }
  throw new Error('unterminated LEB128');
}

const checksum = (bytes) => blake2b(bytes, { dkLen: 4 });

function assertPrefix(prefix) {
  if (prefix !== 'f' && prefix !== 't') throw new Error(`network prefix must be "f" or "t", got "${prefix}"`);
}

/** Address bytes -> string, for the given network prefix. */
export function addressToString(bytes, prefix) {
  assertPrefix(prefix);
  const protocol = bytes[0];
  if (protocol === 0) return `${prefix}0${unleb128(bytes.subarray(1))}`;
  if (protocol === 1 || protocol === 3) {
    return `${prefix}${protocol}${b32encode(concat(bytes.subarray(1), checksum(bytes)))}`;
  }
  if (protocol === 4 && bytes[1] === 10 && bytes.length === 22) {
    return `${prefix}410f${b32encode(concat(bytes.subarray(2), checksum(bytes)))}`;
  }
  throw new Error(`unsupported address bytes 0x${Buffer.from(bytes).toString('hex')}`);
}

/**
 * String -> address bytes. `prefix` is the network the caller is on; an address carrying the
 * other prefix throws. A 0x address is the f410 form of that Ethereum address.
 */
export function parseAddress(input, prefix) {
  assertPrefix(prefix);
  const a = String(input).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return concat(Uint8Array.of(4, 10), Uint8Array.from(Buffer.from(a.slice(2), 'hex')));
  if (a[0] !== 'f' && a[0] !== 't') throw new Error(`${a} is not a Filecoin address`);
  if (a[0] !== prefix) {
    const net = a[0] === 'f' ? 'Mainnet' : 'a testnet';
    throw new Error(`${a} is ${net} address, but this run is on the "${prefix}" network`);
  }
  if (a[1] === '0') {
    if (!/^\d+$/.test(a.slice(2))) throw new Error(`${a}: an ID address is digits after ${prefix}0`);
    return concat(Uint8Array.of(0), leb128(a.slice(2)));
  }
  let body;
  let raw;
  if (a[1] === '1' || a[1] === '3') {
    raw = b32decode(a.slice(2));
    body = concat(Uint8Array.of(Number(a[1])), raw.subarray(0, -4));
    const expected = a[1] === '1' ? 20 : 48;
    if (body.length - 1 !== expected) throw new Error(`${a}: wrong payload length for protocol ${a[1]}`);
  } else if (a.startsWith(`${prefix}410f`)) {
    raw = b32decode(a.slice(5));
    body = concat(Uint8Array.of(4, 10), raw.subarray(0, -4));
    if (body.length !== 22) throw new Error(`${a}: an f410 address carries 20 bytes`);
  } else {
    throw new Error(`unsupported address type: ${a}`);
  }
  if (Buffer.compare(Buffer.from(checksum(body)), Buffer.from(raw.subarray(-4))) !== 0) {
    throw new Error(`checksum mismatch in ${a}: check for a typo`);
  }
  // The last base32 character carries padding bits the checksum cannot see; a typo there
  // decodes to the same bytes. Insist on the canonical spelling so it cannot slip through.
  if (addressToString(body, prefix) !== a.toLowerCase()) {
    throw new Error(`checksum mismatch in ${a}: not the canonical spelling, check for a typo`);
  }
  return body;
}

/** The f1 address of a secp256k1 public key (uncompressed, 65 bytes). */
export function secpAddressBytes(uncompressedPublicKey) {
  return concat(Uint8Array.of(1), blake2b(uncompressedPublicKey, { dkLen: 20 }));
}

/** 0x Ethereum address -> f410 string. */
export const ethToF410 = (eth, prefix) => addressToString(parseAddress(eth, prefix), prefix);
