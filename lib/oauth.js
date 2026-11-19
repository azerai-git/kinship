// Browser-based OAuth sign-in (authorization code + PKCE + scoped keys).
// The user signs in on Mozilla's own page; we never see the password. The Sync
// key comes back as `keys_jwe`, encrypted (ECDH-ES + A256GCM) to an ephemeral
// P-256 key we generate here.
import {
  utf8, fromUtf8, b64ToBytes, bytesToB64url, sha256, randomBytes, concat,
} from "./crypto.js";
import { OAUTH_CLIENT_ID, OAUTH_REDIRECT_MODE, oauthRedirectUri } from "./config.js";

const subtle = globalThis.crypto.subtle;

export const CONTENT_SERVER = "https://accounts.firefox.com";
export const AUTH_SERVER = "https://api.accounts.firefox.com/v1";
export const PROFILE_SERVER = "https://profile.accounts.firefox.com/v1";
// See config.js for why and how to change the client.
export const CLIENT_ID = OAUTH_CLIENT_ID;
export const redirectUri = oauthRedirectUri;
/** true: sign in via chrome.identity.launchWebAuthFlow; false: watch the sign-in tab's URL. */
export const USES_IDENTITY_API = OAUTH_REDIRECT_MODE === "chromiumapp";
export const SYNC_SCOPE = "https://identity.mozilla.com/apps/oldsync";
export const SESSION_SCOPE = "https://identity.mozilla.com/tokens/session";
export const SCOPES = ["profile", SYNC_SCOPE, SESSION_SCOPE];

export class OAuthError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.errno = body?.errno;
    this.body = body;
  }
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 300) }; }
  if (!resp.ok) throw new OAuthError(resp.status, json);
  return json;
}

// ---------- JWE (ECDH-ES + A256GCM) ----------

/** RFC 7518 §4.6.2 Concat KDF, single round (keyBits <= 256). */
export async function concatKdf(z, enc, apu, apv, keyBits) {
  const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const lp = (b) => concat(u32(b.length), b);
  const buf = concat(u32(1), z, lp(utf8(enc)), lp(apu), lp(apv), u32(keyBits));
  return (await sha256(buf)).slice(0, keyBits / 8);
}

export async function ecdhSharedSecret(privateKey, peerJwk) {
  const pub = await subtle.importKey(
    "jwk", { kty: "EC", crv: "P-256", x: peerJwk.x, y: peerJwk.y },
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
}

export async function decryptJwe(jwe, privateKey) {
  const [h, encKey, iv, ct, tag] = jwe.split(".");
  const header = JSON.parse(fromUtf8(b64ToBytes(h)));
  if (header.alg !== "ECDH-ES") throw new Error(`Unsupported JWE alg ${header.alg}`);
  if (header.enc !== "A256GCM") throw new Error(`Unsupported JWE enc ${header.enc}`);
  if (encKey) throw new Error("Unexpected JWE encrypted key");
  const z = await ecdhSharedSecret(privateKey, header.epk);
  const cek = await concatKdf(
    z, header.enc,
    header.apu ? b64ToBytes(header.apu) : new Uint8Array(0),
    header.apv ? b64ToBytes(header.apv) : new Uint8Array(0), 256);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(iv), additionalData: utf8(h), tagLength: 128 },
    key, concat(b64ToBytes(ct), b64ToBytes(tag)));
  return fromUtf8(new Uint8Array(plain));
}

// ---------- flow ----------

/** Create a pending flow: PKCE verifier, state, ephemeral ECDH key, auth URL. */
export async function beginFlow({ email } = {}) {
  const verifier = bytesToB64url(randomBytes(32));      // 43 chars
  const challenge = bytesToB64url(await sha256(utf8(verifier)));
  const state = bytesToB64url(randomBytes(16));
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const { kty, crv, x, y } = await subtle.exportKey("jwk", pair.publicKey);
  const keysJwk = bytesToB64url(utf8(JSON.stringify({ kty, crv, x, y })));

  const url = new URL(`${CONTENT_SERVER}/authorization`);
  const p = {
    action: "email",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: SCOPES.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    access_type: "offline",
    keys_jwk: keysJwk,
  };
  if (email) p.email = email;
  for (const [k, v] of Object.entries(p)) url.searchParams.set(k, v);
  return { url: url.toString(), verifier, state, privateKey: pair.privateKey };
}

/** Parse the redirect URL; returns {code} or throws on error / state mismatch. */
export function parseRedirect(flow, redirectUrl) {
  const u = new URL(redirectUrl);
  const q = u.searchParams;
  if (q.get("error")) throw new Error(`Sign-in failed: ${q.get("error")} ${q.get("error_description") || ""}`);
  if (q.get("state") !== flow.state) throw new Error("OAuth state mismatch");
  const code = q.get("code");
  if (!code) throw new Error("No authorization code in redirect");
  return code;
}

/** Exchange the code; decrypt the scoped keys. */
export async function completeFlow(flow, code) {
  const tok = await postJson(`${AUTH_SERVER}/oauth/token`, {
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    code_verifier: flow.verifier,
  });
  if (!tok.keys_jwe) throw new Error("Token response had no keys_jwe (Sync scope not granted?)");
  const keys = JSON.parse(await decryptJwe(tok.keys_jwe, flow.privateKey));
  const sync = keys[SYNC_SCOPE];
  if (!sync?.k || !sync?.kid) throw new Error("No Sync key in keys_jwe");
  const kSync = b64ToBytes(sync.k);
  if (kSync.length !== 64) throw new Error(`Unexpected Sync key length ${kSync.length}`);
  return {
    accessToken: tok.access_token,
    accessTokenExpiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    refreshToken: tok.refresh_token,
    sessionToken: tok.session_token,   // present because we asked for SESSION_SCOPE
    scope: tok.scope,
    kSync,
    kid: sync.kid,
  };
}

export async function refreshAccessToken(refreshToken, scope = SYNC_SCOPE) {
  const tok = await postJson(`${AUTH_SERVER}/oauth/token`, {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope,
  });
  return { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 };
}

export async function getProfile(accessToken) {
  const resp = await fetch(`${PROFILE_SERVER}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new OAuthError(resp.status, await resp.json().catch(() => ({})));
  return resp.json();
}

export async function destroyRefreshToken(refreshToken) {
  return postJson(`${AUTH_SERVER}/oauth/destroy`, {
    client_id: CLIENT_ID, token: refreshToken, token_type_hint: "refresh_token",
  });
}
