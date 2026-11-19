// Ties OAuth sign-in + Sync together and persists the signed-in account.
// Stored: email, uid, refreshToken, sessionToken, kSync (hex), kid.
import * as oauth from "./oauth.js";
import * as fxa from "./fxa.js";
import { SyncClient, getSyncToken } from "./sync.js";
import { bytesToHex, hexToBytes } from "./crypto.js";
import { unregister as unregisterDevice, clearDevice } from "./device.js";

const STORAGE_KEY = "account";

export async function loadAccount() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] || null;
}

async function saveAccount(acct) {
  await chrome.storage.local.set({ [STORAGE_KEY]: acct });
}

export async function clearAccount() {
  const acct = await loadAccount();
  await unregisterDevice(acct);   // before the session token is destroyed
  await chrome.storage.local.remove(STORAGE_KEY);
  cachedClient = null;
  cachedAccess = null;
  if (acct?.refreshToken) {
    try { await oauth.destroyRefreshToken(acct.refreshToken); } catch (e) { console.warn(e); }
  }
  if (acct?.sessionToken) {
    try { await fxa.destroySession(acct.sessionToken); } catch (e) { console.warn(e); }
  }
}

/** Called with the result of oauth.completeFlow(). */
export async function completeLogin(result) {
  // New session: any device record belongs to the old session, so register afresh.
  await clearDevice();
  let profile = {};
  try { profile = await oauth.getProfile(result.accessToken); } catch (e) { console.warn("profile", e); }
  const acct = {
    email: profile.email || "(unknown email)",
    uid: profile.uid,
    refreshToken: result.refreshToken,
    sessionToken: result.sessionToken || null,
    kSync: bytesToHex(result.kSync),
    kid: result.kid,
    scope: result.scope,
    signedInAt: Date.now(),
  };
  await saveAccount(acct);
  cachedAccess = { accessToken: result.accessToken, expiresAt: result.accessTokenExpiresAt };
  return acct;
}

let cachedAccess = null;
let cachedClient = null;

async function accessToken(acct) {
  if (cachedAccess && cachedAccess.expiresAt - Date.now() > 60_000) return cachedAccess.accessToken;
  cachedAccess = await oauth.refreshAccessToken(acct.refreshToken);
  return cachedAccess.accessToken;
}

/** Drop cached tokens (e.g. after a 401 from storage). */
export function resetSyncClient() {
  cachedClient = null;
  cachedAccess = null;
}

export async function getSyncClient(acct) {
  if (cachedClient && cachedClient.token.expiresAt - Date.now() > 60_000) return cachedClient;
  const token = await getSyncToken(await accessToken(acct), acct.kid);
  cachedClient = new SyncClient(token, hexToBytes(acct.kSync));
  return cachedClient;
}
