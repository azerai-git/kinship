// Firefox Sync 1.5: tokenserver + storage + record encryption/decryption.
import {
  utf8, fromUtf8, b64ToBytes, bytesToHex, bytesToB64, bytesToB64url, hmacSha256, aesCbcDecrypt,
  aesCbcEncrypt, constantTimeEqual, hexToBytes, randomBytes,
} from "./crypto.js";
import { hawkHeader } from "./hawk.js";

export const TOKEN_SERVER = "https://token.services.mozilla.com/1.0/sync/1.5";

export class SyncError extends Error {
  constructor(status, text, url) {
    super(`Sync HTTP ${status} for ${url}: ${text.slice(0, 300)}`);
    this.status = status;
  }
}

/** Exchange an OAuth access token for Sync storage credentials. */
export async function getSyncToken(accessToken, keyId) {
  const resp = await fetch(TOKEN_SERVER, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-KeyID": keyId },
  });
  const text = await resp.text();
  if (!resp.ok) throw new SyncError(resp.status, text, TOKEN_SERVER);
  const t = JSON.parse(text);
  // t = { id, key, uid, api_endpoint, duration, hashed_fxa_uid, ... }
  return { ...t, expiresAt: Date.now() + (t.duration ?? 3600) * 1000 };
}

/** A key bundle is { enc: Uint8Array(32), hmac: Uint8Array(32) } */
export const bundleFromKSync = (kSync) => ({ enc: kSync.slice(0, 32), hmac: kSync.slice(32, 64) });

export async function decryptPayload(bundle, payloadStr) {
  const p = JSON.parse(payloadStr);
  if (!p.ciphertext) return p; // unencrypted (e.g. meta/global)
  const mac = await hmacSha256(bundle.hmac, utf8(p.ciphertext));
  if (!constantTimeEqual(mac, hexToBytes(p.hmac))) {
    throw new Error("Record HMAC mismatch (wrong key?)");
  }
  const plain = await aesCbcDecrypt(bundle.enc, b64ToBytes(p.IV), b64ToBytes(p.ciphertext));
  return JSON.parse(fromUtf8(plain));
}

export class SyncClient {
  /** @param token result of getSyncToken; @param kSync 64-byte root sync key */
  constructor(token, kSync) {
    this.token = token;
    this.root = bundleFromKSync(kSync);
    this.collectionKeys = null;
  }

  async request(method, path, body) {
    const url = `${this.token.api_endpoint}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const auth = await hawkHeader({ id: this.token.id, key: utf8(this.token.key) }, method, url,
      payload === undefined ? {} : { contentType: "application/json", payload });
    const headers = { Authorization: auth, Accept: "application/json" };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const resp = await fetch(url, { method, headers, body: payload });
    const text = await resp.text();
    if (!resp.ok) throw new SyncError(resp.status, text, url);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { json, headers: resp.headers };
  }

  get(path) { return this.request("GET", path); }

  async info() {
    return (await this.get("/info/collections")).json;
  }

  async configuration() {
    try { return (await this.get("/info/configuration")).json || {}; } catch { return {}; }
  }

  /** meta/global is not encrypted: {syncID, storageVersion, engines:{name:{version,syncID}}, declined:[]} */
  async metaGlobal() {
    const { json: bso } = await this.get("/storage/meta/global");
    return JSON.parse(bso.payload);
  }

  async loadKeys() {
    const { json: bso } = await this.get("/storage/crypto/keys");
    const keys = await decryptPayload(this.root, bso.payload);
    const toBundle = ([e, h]) => ({ enc: b64ToBytes(e), hmac: b64ToBytes(h) });
    this.collectionKeys = {
      default: toBundle(keys.default),
      collections: Object.fromEntries(
        Object.entries(keys.collections || {}).map(([k, v]) => [k, toBundle(v)])),
    };
    return this.collectionKeys;
  }

  keyFor(collection) {
    return this.collectionKeys.collections[collection] || this.collectionKeys.default;
  }

  /**
   * Fetch + decrypt a collection (paginated). `newer` (seconds, server
   * timestamp) makes it incremental. Deleted records come back as
   * {id, deleted: true}.
   */
  async fetchCollection(collection, { limit = 1000, max = Infinity, sort = "newest", newer } = {}) {
    if (!this.collectionKeys) await this.loadKeys();
    const key = this.keyFor(collection);
    const records = [];
    let offset = null;
    do {
      const q = new URLSearchParams({ full: "1", limit: String(Math.min(limit, max - records.length)), sort });
      if (newer) q.set("newer", String(newer));
      if (offset) q.set("offset", offset);
      const { json, headers } = await this.get(`/storage/${collection}?${q}`);
      for (const bso of json) {
        try {
          records.push(await decryptPayload(key, bso.payload));
        } catch (e) {
          console.warn("Failed to decrypt", collection, bso.id, e);
        }
      }
      offset = headers.get("X-Weave-Next-Offset");
    } while (offset && records.length < max);
    return records;
  }

  async encryptRecord(collection, cleartext) {
    if (!this.collectionKeys) await this.loadKeys();
    return encryptPayload(this.keyFor(collection), cleartext);
  }

  /** Upload one record (replaces the server copy). */
  async putRecord(collection, cleartext, { ttl, sortindex } = {}) {
    const bso = { payload: await this.encryptRecord(collection, cleartext) };
    if (ttl) bso.ttl = ttl;
    if (sortindex !== undefined) bso.sortindex = sortindex;
    return this.request("PUT", `/storage/${collection}/${encodeURIComponent(cleartext.id)}`, bso);
  }

  /** Upload many records; chunks to the server's max_post_records. Returns {success:[], failed:{}} */
  async postRecords(collection, cleartexts, { ttl, sortindex, chunk } = {}) {
    if (!chunk) chunk = Math.min(100, (await this.configuration()).max_post_records || 100);
    const result = { success: [], failed: {} };
    for (let i = 0; i < cleartexts.length; i += chunk) {
      const bsos = [];
      for (const c of cleartexts.slice(i, i + chunk)) {
        const bso = { id: c.id, payload: await this.encryptRecord(collection, c) };
        if (ttl) bso.ttl = ttl;
        if (sortindex !== undefined) bso.sortindex = sortindex;
        bsos.push(bso);
      }
      const { json } = await this.request("POST", `/storage/${collection}`, bsos);
      result.success.push(...(json?.success || []));
      Object.assign(result.failed, json?.failed || {});
    }
    return result;
  }

  deleteRecord(collection, id) {
    return this.request("DELETE", `/storage/${collection}/${encodeURIComponent(id)}`);
  }
}

/** Encrypt a cleartext record like Firefox's CryptoWrapper → payload string. */
export async function encryptPayload(bundle, cleartext) {
  const iv = randomBytes(16);
  const ciphertext = bytesToB64(await aesCbcEncrypt(bundle.enc, iv, utf8(JSON.stringify(cleartext))));
  const hmac = bytesToHex(await hmacSha256(bundle.hmac, utf8(ciphertext)));
  return JSON.stringify({ ciphertext, IV: bytesToB64(iv), hmac });
}

/** 12-character Sync GUID (base64url of 9 random bytes), like Firefox's Utils.makeGUID. */
export function makeGuid() {
  return bytesToB64url(randomBytes(9));
}

export { bytesToHex };
