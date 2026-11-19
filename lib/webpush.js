// Web Push message encryption (RFC 8291) using the aes128gcm content coding
// (RFC 8188). Firefox's Send Tab encrypts tab payloads this way, to the
// receiving device's P-256 public key + 16-byte auth secret.
import { utf8, concat, hkdf, randomBytes } from "./crypto.js";

const subtle = globalThis.crypto.subtle;
const ALG = { name: "ECDH", namedCurve: "P-256" };

/** Raw uncompressed point (65 bytes) <-> WebCrypto keys. */
export async function importPublicRaw(raw) {
  return subtle.importKey("raw", raw, ALG, true, []);
}
export async function exportPublicRaw(key) {
  return new Uint8Array(await subtle.exportKey("raw", key));
}
export async function generateKeyPair() {
  return subtle.generateKey(ALG, true, ["deriveBits"]);
}

async function ecdh(privateKey, publicRaw) {
  const pub = await importPublicRaw(publicRaw);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
}

async function deriveKeyAndNonce(ecdhSecret, authSecret, uaPublic, asPublic, salt) {
  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(ecdhSecret, keyInfo, 32, authSecret);
  const cek = await hkdf(ikm, utf8("Content-Encoding: aes128gcm\0"), 16, salt);
  const nonce = await hkdf(ikm, utf8("Content-Encoding: nonce\0"), 12, salt);
  return { cek, nonce };
}

function recordNonce(base, seq) {
  const n = base.slice();
  for (let i = 0; i < 6; i++) n[11 - i] ^= (seq / 2 ** (8 * i)) & 0xff;
  return n;
}

/**
 * Encrypt `plaintext` to a receiver.
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} uaPublic receiver public key, raw 65 bytes
 * @param {Uint8Array} authSecret receiver auth secret, 16 bytes
 * @param {{senderKeys?: CryptoKeyPair, salt?: Uint8Array, rs?: number}} [opts] (fixed values for tests)
 */
export async function encrypt(plaintext, uaPublic, authSecret, opts = {}) {
  const sender = opts.senderKeys ?? await generateKeyPair();
  const asPublic = await exportPublicRaw(sender.publicKey);
  const salt = opts.salt ?? randomBytes(16);
  // One record: plaintext + 0x02 delimiter + 16-byte tag must fit in rs.
  const rs = Math.max(opts.rs ?? 4096, plaintext.length + 1 + 16);
  const secret = await ecdh(sender.privateKey, uaPublic);
  const { cek, nonce } = await deriveKeyAndNonce(secret, authSecret, uaPublic, asPublic, salt);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv: recordNonce(nonce, 0), tagLength: 128 }, key, concat(plaintext, new Uint8Array([2]))));
  const rsBytes = new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]);
  return concat(salt, rsBytes, new Uint8Array([asPublic.length]), asPublic, record);
}

/**
 * Decrypt an aes128gcm Web Push message addressed to us.
 * @param {Uint8Array} message
 * @param {CryptoKey} uaPrivate our private key
 * @param {Uint8Array} uaPublic our public key, raw 65 bytes
 * @param {Uint8Array} authSecret our auth secret
 */
export async function decrypt(message, uaPrivate, uaPublic, authSecret) {
  if (message.length < 21) throw new Error("Push message too short");
  const salt = message.slice(0, 16);
  const rs = ((message[16] << 24) | (message[17] << 16) | (message[18] << 8) | message[19]) >>> 0;
  const idlen = message[20];
  const asPublic = message.slice(21, 21 + idlen);
  const body = message.slice(21 + idlen);
  if (rs < 18) throw new Error("Invalid record size");
  if (asPublic.length !== 65) throw new Error("Expected sender public key in keyid");
  const secret = await ecdh(uaPrivate, asPublic);
  const { cek, nonce } = await deriveKeyAndNonce(secret, authSecret, uaPublic, asPublic, salt);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const out = [];
  for (let off = 0, seq = 0; off < body.length; off += rs, seq++) {
    const chunk = body.slice(off, off + rs);
    const plain = new Uint8Array(await subtle.decrypt(
      { name: "AES-GCM", iv: recordNonce(nonce, seq), tagLength: 128 }, key, chunk));
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;          // strip zero padding
    const last = off + rs >= body.length;
    if (end < 0 || plain[end] !== (last ? 2 : 1)) throw new Error("Bad padding delimiter");
    out.push(plain.slice(0, end));
  }
  return concat(...out);
}
