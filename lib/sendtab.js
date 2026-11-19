// Firefox "Send Tab" (FxA device command https://identity.mozilla.com/cmd/open-uri).
//
// Each device publishes, in its availableCommands, its Send Tab public key +
// auth secret, encrypted with the account's Sync key (so only devices holding
// the Sync key can address it). Senders decrypt that, then encrypt the tab with
// Web Push aes128gcm to the receiver and enqueue it via invoke_command.
import {
  utf8, fromUtf8, b64ToBytes, bytesToB64, bytesToB64url, bytesToHex, hmacSha256,
  aesCbcEncrypt, randomBytes,
} from "./crypto.js";
import { decryptPayload, bundleFromKSync } from "./sync.js";
import * as webpush from "./webpush.js";

export const COMMAND_SENDTAB = "https://identity.mozilla.com/cmd/open-uri";
const subtle = globalThis.crypto.subtle;

/** Firefox's kidAsHex: hex of the fingerprint after the first "-". */
export function kidAsHex(kid) {
  const idx = kid.indexOf("-") + 1;
  if (idx <= 1) throw new Error(`Invalid kid: ${kid}`);
  return bytesToHex(b64ToBytes(kid.slice(idx)));
}

/** New Send Tab key material, serialisable for chrome.storage. */
export async function generateKeys() {
  const pair = await webpush.generateKeyPair();
  return {
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
    publicKey: bytesToB64url(await webpush.exportPublicRaw(pair.publicKey)),
    authSecret: bytesToB64url(randomBytes(16)),
  };
}

/** availableCommands[open-uri] value: JSON {kid, IV, hmac, ciphertext}. */
export async function encryptKeysForCommand(keys, kSync, kid) {
  const bundle = bundleFromKSync(kSync);
  const iv = randomBytes(16);
  const cleartext = JSON.stringify({ publicKey: keys.publicKey, authSecret: keys.authSecret });
  const ciphertext = bytesToB64(await aesCbcEncrypt(bundle.enc, iv, utf8(cleartext)));
  const hmac = bytesToHex(await hmacSha256(bundle.hmac, utf8(ciphertext)));
  return JSON.stringify({ kid: kidAsHex(kid), IV: bytesToB64(iv), hmac, ciphertext });
}

/** Decrypt another device's published Send Tab keys → {publicKey, authSecret}. */
export async function decryptKeysFromCommand(value, kSync, kid) {
  const parsed = JSON.parse(value);
  if (parsed.kid && parsed.kid !== kidAsHex(kid)) {
    throw new Error("Target device's Send Tab keys use a different Sync key (stale device?)");
  }
  return decryptPayload(bundleFromKSync(kSync), value);
}

/** Encrypt a tab for a target device's availableCommands entry. */
export async function encryptTab(targetCommandValue, kSync, kid, { title, url }) {
  const { publicKey, authSecret } = await decryptKeysFromCommand(targetCommandValue, kSync, kid);
  const data = {
    flowID: bytesToHex(randomBytes(16)),
    streamID: bytesToHex(randomBytes(16)),
    entries: [{ title: title || url, url }],
  };
  const msg = await webpush.encrypt(utf8(JSON.stringify(data)), b64ToBytes(publicKey), b64ToBytes(authSecret));
  return { encrypted: bytesToB64url(msg) };
}

/** Decrypt a received open-uri payload with our keys → {title, url, ...}. */
export async function decryptTab(keys, payload) {
  const priv = await subtle.importKey("jwk", keys.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const plain = await webpush.decrypt(b64ToBytes(payload.encrypted), priv, b64ToBytes(keys.publicKey), b64ToBytes(keys.authSecret));
  const data = JSON.parse(fromUtf8(plain));
  const entries = data.entries || [];
  const current = Number.isInteger(data.current) ? data.current : entries.length - 1;
  const entry = entries[current] || {};
  return { title: entry.title, url: entry.url, flowID: data.flowID, streamID: data.streamID };
}
