/**
 * The DAG-CBOR the native side needs, and nothing more.
 *
 * Encoding covers what a Filecoin message and a Claim's params are made of: unsigned ints,
 * byte strings and arrays. Decoding is broader, because f02's state block carries nulls
 * (an `Option<ExplicitDistribution>` that is None), negative ints (a weight record's slope)
 * and possibly CID links (tag 42). Floats, maps and indefinite lengths never appear in the
 * structures read here, and an unexpected one throws rather than decoding to something
 * plausible.
 *
 * Ported from the standalone Claim tool (decentramike/solstice-claim, claim.mjs v3), whose
 * encoder produced the known-good params hex the tests pin.
 */

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

function head(major, n) {
  n = BigInt(n);
  if (n < 0n) throw new Error('CBOR head length must be non-negative');
  const m = major << 5;
  if (n < 24n) return Uint8Array.of(m | Number(n));
  if (n < 0x100n) return Uint8Array.of(m | 24, Number(n));
  if (n < 0x10000n) return Uint8Array.of(m | 25, Number(n >> 8n), Number(n & 0xffn));
  if (n < 0x100000000n) {
    const b = new Uint8Array(5);
    b[0] = m | 26;
    new DataView(b.buffer).setUint32(1, Number(n));
    return b;
  }
  if (n >= 1n << 64n) throw new Error('CBOR integer exceeds 64 bits');
  const b = new Uint8Array(9);
  b[0] = m | 27;
  new DataView(b.buffer).setBigUint64(1, n);
  return b;
}

export const encodeUint = (n) => head(0, n);
export const encodeBytes = (bytes) => concat(head(2, bytes.length), bytes);
export const encodeArray = (items) => concat(head(4, items.length), ...items);

/**
 * A TokenAmount on the wire: one sign byte then the big-endian magnitude, empty for zero.
 * Only non-negative amounts are ever encoded here (message value, fee cap, premium).
 */
export function encodeBigInt(v) {
  v = BigInt(v);
  if (v < 0n) throw new Error('negative TokenAmount');
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return concat(Uint8Array.of(0), Uint8Array.from(Buffer.from(hex, 'hex')));
}

/** The inverse of encodeBigInt, sign byte included (01 = negative). */
export function decodeBigInt(bytes) {
  if (!bytes || bytes.length === 0) return 0n;
  const magnitude = bytes.length > 1 ? BigInt('0x' + Buffer.from(bytes.subarray(1)).toString('hex')) : 0n;
  if (bytes[0] === 0) return magnitude;
  if (bytes[0] === 1) return -magnitude;
  throw new Error(`bad TokenAmount sign byte ${bytes[0]}`);
}

/** A CID link, as tag 42 decodes. Kept opaque: nothing here follows links. */
export class CidLink {
  constructor(bytes) {
    this.bytes = bytes;
  }
}

/**
 * Decodes one DAG-CBOR item. Throws on trailing bytes: a block that decodes with bytes left
 * over is not the structure we think it is.
 */
export function decode(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let i = 0;

  const need = (n) => {
    if (i + n > u.length) throw new Error('CBOR truncated');
  };

  const readLength = (info) => {
    if (info < 24) return BigInt(info);
    const len = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!len) throw new Error(`unsupported CBOR additional info ${info}`);
    need(len);
    let n = 0n;
    for (let k = 0; k < len; k++) n = (n << 8n) | BigInt(u[i++]);
    return n;
  };

  const item = () => {
    need(1);
    const ib = u[i++];
    const major = ib >> 5;
    const info = ib & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error(`unsupported CBOR simple/float value ${info}`);
    }
    const n = readLength(info);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1n - n;
      case 2: {
        need(Number(n));
        const s = u.slice(i, i + Number(n));
        i += Number(n);
        return s;
      }
      case 3: {
        need(Number(n));
        const s = Buffer.from(u.subarray(i, i + Number(n))).toString('utf8');
        i += Number(n);
        return s;
      }
      case 4: {
        const out = [];
        for (let k = 0n; k < n; k++) out.push(item());
        return out;
      }
      case 5: {
        const out = {};
        for (let k = 0n; k < n; k++) {
          const key = item();
          out[String(key)] = item();
        }
        return out;
      }
      case 6: {
        const inner = item();
        if (n === 42n && inner instanceof Uint8Array) return new CidLink(inner.subarray(1));
        throw new Error(`unsupported CBOR tag ${n}`);
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  };

  const value = item();
  if (i !== u.length) throw new Error(`CBOR has ${u.length - i} trailing byte(s)`);
  return value;
}

export const toHex = (bytes) => Buffer.from(bytes).toString('hex');
export const fromBase64 = (s) => new Uint8Array(Buffer.from(s ?? '', 'base64'));
export const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
