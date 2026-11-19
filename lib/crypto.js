// Low-level crypto helpers built on WebCrypto. No dependencies.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);

export function hexToBytes(hex) {
  hex = hex.replace(/\s+/g, "");
  if (hex.length % 2) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64ToBytes(b64) {
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export const bytesToB64url = (bytes) =>
  bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function concat(...arrays) {
  const len = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

export function xor(a, b) {
  if (a.length !== b.length) throw new Error("xor length mismatch");
  return a.map((x, i) => x ^ b[i]);
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export async function sha256(data) {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

export async function pbkdf2(password, salt, iterations, length = 32) {
  const key = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, length * 8);
  return new Uint8Array(bits);
}

export async function hkdf(ikm, info, length, salt = new Uint8Array(0)) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export async function hmacSha256(key, data) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function aesCbcDecrypt(key, iv, ciphertext) {
  const k = await subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, k, ciphertext));
}

export async function aesCbcEncrypt(key, iv, plaintext) {
  const k = await subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
  return new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, k, plaintext));
}
