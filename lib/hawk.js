// Minimal Hawk (https://github.com/mozilla/hawk) client header generation.
import { utf8, sha256, hmacSha256, bytesToB64, randomBytes, bytesToHex } from "./crypto.js";

// Seconds to add to the local clock (set when a server reports skew).
let clockOffsetSec = 0;
export const setClockOffset = (s) => { clockOffsetSec = s; };
export const now = () => Math.floor(Date.now() / 1000) + clockOffsetSec;

export async function payloadHash(contentType, payload) {
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  const str = `hawk.1.payload\n${mime}\n${payload}\n`;
  return bytesToB64(await sha256(utf8(str)));
}

/**
 * @param {{id: string, key: Uint8Array}} creds
 * @param {string} method
 * @param {string} url
 * @param {{contentType?: string, payload?: string, ts?: number, nonce?: string, ext?: string}} opts
 */
export async function hawkHeader(creds, method, url, opts = {}) {
  const u = new URL(url);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const ts = opts.ts ?? now();
  const nonce = opts.nonce ?? bytesToHex(randomBytes(6));
  const hash = opts.payload !== undefined
    ? await payloadHash(opts.contentType, opts.payload)
    : undefined;
  const ext = opts.ext ?? "";
  const normalized =
    `hawk.1.header\n${ts}\n${nonce}\n${method.toUpperCase()}\n${u.pathname}${u.search}\n` +
    `${u.hostname.toLowerCase()}\n${port}\n${hash ?? ""}\n${ext}\n`;
  const mac = bytesToB64(await hmacSha256(creds.key, utf8(normalized)));
  let header = `Hawk id="${creds.id}", ts="${ts}", nonce="${nonce}"`;
  if (hash) header += `, hash="${hash}"`;
  if (ext) header += `, ext="${ext}"`;
  header += `, mac="${mac}"`;
  return header;
}
