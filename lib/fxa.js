// Mozilla accounts (FxA) session-token API (Hawk-signed), plus the onepw key
// derivations. Password login (/account/login) is NOT used: Mozilla's CDN
// rejects it from non-Mozilla clients with an empty HTTP 406, so sign-in goes
// through the browser OAuth flow in oauth.js, which hands us a session token.
import {
  utf8, hexToBytes, bytesToHex, bytesToB64url, xor, pbkdf2, hkdf, hmacSha256,
  sha256, constantTimeEqual,
} from "./crypto.js";
import { hawkHeader, setClockOffset } from "./hawk.js";

export const AUTH_SERVER = "https://api.accounts.firefox.com/v1";
const NS = "identity.mozilla.com/picl/v1/";

export class FxaError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.errno = body?.errno;
    this.body = body;
  }
}

// ---------- onepw key derivation (kept for reference + tests) ----------

export const stretchV1 = (email, password) =>
  pbkdf2(utf8(password), utf8(`${NS}quickStretch:${email}`), 1000);

export function stretchV2(clientSalt, password) {
  const core = clientSalt.replace(`${NS}quickStretchV2:`, "");
  return pbkdf2(utf8(password), utf8(`${NS}quickStretchV2:${core}`), 650000);
}

export const deriveAuthPW = (stretched) => hkdf(stretched, utf8(NS + "authPW"), 32);
export const deriveUnwrapBKey = (stretched) => hkdf(stretched, utf8(NS + "unwrapBkey"), 32);

/** Derive Hawk credentials (+ any extra key material) from an FxA token. */
export async function deriveTokenCreds(tokenHex, name, length = 64) {
  const km = await hkdf(hexToBytes(tokenHex), utf8(NS + name), length);
  return { id: bytesToHex(km.slice(0, 32)), key: km.slice(32, 64), extra: km.slice(64) };
}

/** Decrypt the /account/keys bundle → { kA, wrapKB } */
export async function unbundleKeys(keyRequestKey, bundleHex) {
  const bundle = hexToBytes(bundleHex);
  const ciphertext = bundle.slice(0, 64);
  const mac = bundle.slice(64);
  const km = await hkdf(keyRequestKey, utf8(NS + "account/keys"), 96);
  const expected = await hmacSha256(km.slice(0, 32), ciphertext);
  if (!constantTimeEqual(expected, mac)) throw new Error("Bad HMAC on key bundle");
  const plain = xor(ciphertext, km.slice(32));
  return { kA: plain.slice(0, 32), wrapKB: plain.slice(32) };
}

/** Legacy "oldsync" key from kB: 64 bytes (32 enc + 32 hmac) and its key id. */
export async function deriveSyncKey(kB, keyRotationTimestamp) {
  const kSync = await hkdf(kB, utf8(NS + "oldsync"), 64);
  const clientState = (await sha256(kB)).slice(0, 16);
  return { kSync, kid: `${keyRotationTimestamp}-${bytesToB64url(clientState)}` };
}

// ---------- session-token API ----------

export const sessionCreds = (sessionToken) => deriveTokenCreds(sessionToken, "sessionToken", 64);

async function request(method, path, { body, sessionToken, bearer, retried } = {}) {
  const url = AUTH_SERVER + path;
  const headers = {};
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  if (bearer) {
    headers["Authorization"] = `Bearer ${bearer}`;
  } else if (sessionToken) {
    headers["Authorization"] = await hawkHeader(await sessionCreds(sessionToken), method, url, {
      contentType: payload !== undefined ? "application/json" : undefined,
      payload,
    });
  }
  const resp = await fetch(url, { method, headers, body: payload });
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 300) }; }
  if (!resp.ok) {
    // errno 111: local clock is off; server tells us its time.
    if (json.errno === 111 && json.serverTime && !retried) {
      setClockOffset(json.serverTime - Math.floor(Date.now() / 1000));
      return request(method, path, { body, sessionToken, bearer, retried: true });
    }
    throw new FxaError(resp.status, json);
  }
  return json;
}

export const getDevices = (sessionToken) =>
  request("GET", "/account/devices", { sessionToken });

export const destroySession = (sessionToken) =>
  request("POST", "/session/destroy", { body: {}, sessionToken });

/** Register (no id) or update (with id) the device bound to this session. */
export const upsertDevice = (sessionToken, device) =>
  request("POST", "/account/device", { body: device, sessionToken });

// Requires a *verified* session token or a refresh token; the session token we
// get via OAuth is rejected (HTTP 400), so pass the refresh token here. Note:
// destroying a device also revokes the credentials attached to it.
export const destroyDevice = (refreshToken, id) =>
  request("POST", "/account/device/destroy", { body: { id }, bearer: refreshToken });

export const invokeCommand = (sessionToken, { command, target, payload, ttl }) =>
  request("POST", "/account/devices/invoke_command", {
    body: ttl ? { command, target, payload, ttl } : { command, target, payload }, sessionToken,
  });

/** Pending commands for this session's device: {index, last, messages:[{index, data}]} */
export function getCommands(sessionToken, { index, limit } = {}) {
  const q = new URLSearchParams();
  if (index !== undefined) q.set("index", String(index));
  if (limit !== undefined) q.set("limit", String(limit));
  return request("GET", `/account/device/commands?${q}`, { sessionToken });
}

export const ERRNO_UNKNOWN_DEVICE = 123;

/**
 * Push a message to other devices, e.g. {version:1, command:"sync:collection_changed",
 * data:{collections:["clients"], reason:"firstsync"}}.  `to` is "all" or [deviceIds].
 */
export function notifyDevices({ sessionToken, refreshToken }, { to = "all", excluded, payload, TTL = 0 }) {
  const body = { to, payload, TTL };
  if (excluded?.length) body.excluded = excluded;
  return request("POST", "/account/devices/notify", { body, sessionToken }).catch((e) => {
    // Like device destroy, this may require a verified session; retry with the refresh token.
    if (refreshToken && (e.status === 400 || e.status === 401)) {
      return request("POST", "/account/devices/notify", { body, bearer: refreshToken });
    }
    throw e;
  });
}
