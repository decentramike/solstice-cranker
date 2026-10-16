/**
 * Native Filecoin messages: serialise, CID, sign.
 *
 * Claim is a method on f02, a built-in actor, so it is sent as a native message signed by a
 * secp256k1 (f1) key. ethers cannot produce one: an Ethereum transaction becomes a message to
 * the EVM, not to f02, and an f410 sender cannot sign a native message at all (FIP-0118
 * §2.4.5). So this module signs on its own, exactly as the standalone Claim tool did.
 *
 * The private key is a Uint8Array held by the caller. Nothing in this file logs, returns or
 * serialises it; `sign` returns only the signature.
 */
import { blake2b } from '@noble/hashes/blake2b';
import { secp256k1 } from '@noble/curves/secp256k1';

import { addressToString, b32encode, parseAddress, secpAddressBytes } from './address.mjs';
import { concat, encodeArray, encodeBigInt, encodeBytes, encodeUint, fromBase64, toBase64 } from './cbor.mjs';

/** Message -> its DAG-CBOR bytes. Addresses are strings; `prefix` is the network's. */
export function serializeMessage(m, prefix) {
  return encodeArray([
    encodeUint(m.Version ?? 0),
    encodeBytes(parseAddress(m.To, prefix)),
    encodeBytes(parseAddress(m.From, prefix)),
    encodeUint(m.Nonce),
    encodeBytes(encodeBigInt(m.Value)),
    encodeUint(m.GasLimit),
    encodeBytes(encodeBigInt(m.GasFeeCap)),
    encodeBytes(encodeBigInt(m.GasPremium)),
    encodeUint(m.Method),
    encodeBytes(fromBase64(m.Params)),
  ]);
}

/** CIDv1, dag-cbor, blake2b-256 -- the CID Lotus assigns a secp-signed message. */
export function messageCid(m, prefix) {
  const bytes = concat(Uint8Array.of(0x01, 0x71, 0xa0, 0xe4, 0x02, 0x20), blake2b(serializeMessage(m, prefix), { dkLen: 32 }));
  return { bytes, string: 'b' + b32encode(bytes) };
}

/**
 * CID of the SIGNED message: [message, type byte || signature] as DAG-CBOR. For a secp256k1
 * sender this, not the unsigned CID, is what MpoolPush returns and what explorers show.
 */
export function signedMessageCid(m, signature, prefix) {
  const sig = concat(Uint8Array.of(signature.Type), fromBase64(signature.Data));
  const bytes = concat(
    Uint8Array.of(0x01, 0x71, 0xa0, 0xe4, 0x02, 0x20),
    blake2b(encodeArray([serializeMessage(m, prefix), encodeBytes(sig)]), { dkLen: 32 })
  );
  return { bytes, string: 'b' + b32encode(bytes) };
}

/** Signature object for MpoolPush: Type 1 (secp256k1), 65 bytes r||s||v. */
export function signMessage(m, privateKey, prefix) {
  const digest = blake2b(messageCid(m, prefix).bytes, { dkLen: 32 });
  const sig = secp256k1.sign(digest, privateKey);
  return { Type: 1, Data: toBase64(concat(sig.toCompactRawBytes(), Uint8Array.of(sig.recovery))) };
}

/** True when `signature` over `m` recovers to `m.From`. Used by tests and the devnet fake node. */
export function verifySignedMessage(m, signature, prefix) {
  const raw = fromBase64(signature.Data);
  if (signature.Type !== 1 || raw.length !== 65) return false;
  const digest = blake2b(messageCid(m, prefix).bytes, { dkLen: 32 });
  const sig = secp256k1.Signature.fromCompact(raw.subarray(0, 64)).addRecoveryBit(raw[64]);
  const pub = sig.recoverPublicKey(digest).toRawBytes(false);
  return addressToString(secpAddressBytes(pub), prefix) === m.From;
}

/**
 * Parses a hex private key from the environment into bytes. Accepts an optional 0x and
 * surrounding whitespace (a key file written with a trailing newline is the common case).
 * Error messages never include any part of the value.
 */
export function parsePrivateKey(raw, name = 'CLAIM_PRIVATE_KEY') {
  const hex = String(raw ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} is not a 32-byte hex key`);
  const key = Uint8Array.from(Buffer.from(hex, 'hex'));
  if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error(`${name} is not a valid secp256k1 key`);
  return key;
}

/** The f1 address of a private key. */
export function addressOfKey(privateKey, prefix) {
  return addressToString(secpAddressBytes(secp256k1.getPublicKey(privateKey, false)), prefix);
}
