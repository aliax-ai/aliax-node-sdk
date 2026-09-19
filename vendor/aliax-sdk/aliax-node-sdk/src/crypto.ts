import { createHmac, timingSafeEqual } from "node:crypto";

const MAGIC = Buffer.from("ALIAXM1\0", "latin1");
const SALT = Buffer.from("aliax/v1", "utf8");

export function hkdf(key: Buffer, info: string): Buffer {
  const prk = createHmac("sha256", SALT).update(key).digest();
  return createHmac("sha256", prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
}

function rot(v: number, n: number): number { return ((v << n) | (v >>> (32 - n))) >>> 0; }
function qr(s: number[], a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rot(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rot(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rot(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rot(s[b] ^ s[c], 7);
}
function block(key: Buffer, counter: number, nonce: Buffer): Buffer {
  const constants = Buffer.from("expand 32-byte k");
  const s = [...Array.from({ length: 4 }, (_, i) => constants.readUInt32LE(i * 4)), ...Array.from({ length: 8 }, (_, i) => key.readUInt32LE(i * 4)), counter >>> 0, ...Array.from({ length: 3 }, (_, i) => nonce.readUInt32LE(i * 4))];
  const w = [...s];
  for (let i = 0; i < 10; i++) { qr(w,0,4,8,12); qr(w,1,5,9,13); qr(w,2,6,10,14); qr(w,3,7,11,15); qr(w,0,5,10,15); qr(w,1,6,11,12); qr(w,2,7,8,13); qr(w,3,4,9,14); }
  const out = Buffer.alloc(64); for (let i = 0; i < 16; i++) out.writeUInt32LE((w[i] + s[i]) >>> 0, i * 4); return out;
}
function chacha(key: Buffer, nonce: Buffer, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length); for (let off = 0, counter = 1; off < data.length; off += 64, counter++) { const stream = block(key, counter, nonce); for (let i = off; i < Math.min(off + 64, data.length); i++) out[i] = data[i] ^ stream[i - off]; } return out;
}

export function openMapper(container: Buffer, assetKey: Buffer): string {
  if (container.length < 60 || !container.subarray(0, 8).equals(MAGIC) || container[8] !== 1) throw new Error("invalid mapper container");
  const body = container.subarray(0, container.length - 32), tag = container.subarray(container.length - 32);
  const expected = createHmac("sha256", hkdf(assetKey, "mapper-mac")).update(body).digest();
  if (tag.length !== expected.length || !timingSafeEqual(tag, expected)) throw new Error("mapper container integrity check failed");
  const plain = chacha(hkdf(assetKey, "mapper-enc"), body.subarray(12, 24), body.subarray(28));
  if (plain.length !== body.readUInt32BE(24)) throw new Error("mapper container length mismatch");
  return plain.toString("utf8");
}
