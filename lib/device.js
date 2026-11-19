// This browser as a device on the Mozilla account: registration with Send Tab
// keys, sending tabs to other devices, and polling for tabs sent to us.
// Device state lives under its own storage key ("device") so the background
// worker and the UI page don't overwrite each other's account writes.
import * as fxa from "./fxa.js";
import * as sendtab from "./sendtab.js";
import { hexToBytes } from "./crypto.js";
import { loadPushState } from "./push.js";

const KEY = "device";

export async function loadDevice() {
  return (await chrome.storage.local.get(KEY))[KEY] || null;
}
async function saveDevice(d) {
  await chrome.storage.local.set({ [KEY]: d });
}
export async function clearDevice() {
  await chrome.storage.local.remove(KEY);
}

export function defaultDeviceName() {
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(" ");
  const ua = navigator.userAgent;
  const browser = /Edge/i.test(brands) || /Edg\//.test(ua) ? "Edge"
    : /Brave/i.test(brands) ? "Brave"
    : /Opera|OPR\//i.test(brands + ua) ? "Opera"
    : /Vivaldi/i.test(ua) ? "Vivaldi" : "Chrome";
  const p = navigator.userAgentData?.platform || ua;
  const os = /Win/i.test(p) ? "Windows" : /Mac/i.test(p) ? "macOS" : /Android/i.test(p) ? "Android"
    : /CrOS|Chrome OS/i.test(p) ? "ChromeOS" : /Linux/i.test(p) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Make sure this browser is registered with current Send Tab keys.
 * Re-registers if the Sync key changed (kid) or the server forgot the device.
 */
/**
 * @param {object} acct
 * @param {{name?: string, push?: {endpoint, publicKey, authSecret} | null, force?: boolean}} [opts]
 *   push: current push subscription; the device is updated when it changes.
 */
export async function ensureDevice(acct, { name, push, force } = {}) {
  if (!acct?.sessionToken) throw new Error("No session token: sign out and sign in again to enable Send Tab.");
  let dev = await loadDevice();
  const same = dev && dev.uid === acct.uid && dev.kid === acct.kid;
  const pushChanged = push !== undefined && (push?.endpoint || null) !== (dev?.pushEndpoint || null);
  if (same && !name && !pushChanged && !force) return dev;

  const keys = same ? dev.keys : await sendtab.generateKeys();
  const body = {
    name: name || dev?.name || defaultDeviceName(),
    type: "desktop",
    availableCommands: {
      [sendtab.COMMAND_SENDTAB]: await sendtab.encryptKeysForCommand(keys, hexToBytes(acct.kSync), acct.kid),
    },
  };
  let sub = push;
  if (sub === undefined) {
    // Keep whatever push subscription we have (device record, else push state).
    const ps = await loadPushState();
    sub = dev?.push || (ps?.endpoint ? { endpoint: ps.endpoint, publicKey: ps.keys.publicKey, authSecret: ps.keys.authSecret } : null);
  }
  const clearingPush = !sub?.endpoint && !!dev?.pushEndpoint;
  if (sub?.endpoint) {
    body.pushCallback = sub.endpoint;
    body.pushPublicKey = sub.publicKey;
    body.pushAuthKey = sub.authSecret;
  } else if (clearingPush) {
    // Switching to polling: tell the server not to push to the old endpoint.
    body.pushCallback = "";
    body.pushPublicKey = "";
    body.pushAuthKey = "";
  }
  const upsert = async (b) => {
    try {
      return await fxa.upsertDevice(acct.sessionToken, dev?.id && dev.uid === acct.uid ? { id: dev.id, ...b } : b);
    } catch (e) {
      if (e.errno !== fxa.ERRNO_UNKNOWN_DEVICE) throw e;
      return fxa.upsertDevice(acct.sessionToken, b);   // server forgot us: register fresh
    }
  };
  let resp;
  try {
    resp = await upsert(body);
  } catch (e) {
    if (!clearingPush || e.status !== 400) throw e;
    // Server refused empty push fields: leave the stale endpoint (pushes to it just go nowhere).
    delete body.pushCallback; delete body.pushPublicKey; delete body.pushAuthKey;
    resp = await upsert(body);
  }
  dev = {
    id: resp.id, name: resp.name || body.name, uid: acct.uid, kid: acct.kid, keys,
    pushEndpoint: sub?.endpoint || null, push: sub?.endpoint ? sub : null,
    lastCommandIndex: dev?.id === resp.id ? dev.lastCommandIndex : undefined,
  };
  await saveDevice(dev);
  return dev;
}

export async function renameDevice(acct, name) {
  return ensureDevice(acct, { name });
}

/** Devices we can send to (have Send Tab, aren't us). */
export async function sendTargets(acct) {
  const devices = await fxa.getDevices(acct.sessionToken);
  return devices.filter((d) => !d.isCurrentDevice && d.availableCommands?.[sendtab.COMMAND_SENDTAB]);
}

export async function sendTab(acct, targetId, { title, url }, devices) {
  devices ||= await fxa.getDevices(acct.sessionToken);
  const target = devices.find((d) => d.id === targetId);
  if (!target) throw new Error("That device is no longer on your account.");
  const cmd = target.availableCommands?.[sendtab.COMMAND_SENDTAB];
  if (!cmd) throw new Error(`${target.name} can't receive tabs.`);
  const payload = await sendtab.encryptTab(cmd, hexToBytes(acct.kSync), acct.kid, { title, url });
  const r = await fxa.invokeCommand(acct.sessionToken, { command: sendtab.COMMAND_SENDTAB, target: target.id, payload });
  return { target: target.name, ...r };
}

/**
 * Fetch commands queued for this device since the last poll.
 * Returns [{title, url, sender}] for received tabs (sender = device name).
 */
export async function pollReceivedTabs(acct) {
  let dev = await ensureDevice(acct);
  const received = [];
  let names = null;
  for (let guard = 0; guard < 20; guard++) {
    const index = dev.lastCommandIndex === undefined ? 0 : dev.lastCommandIndex + 1;
    let resp;
    try {
      resp = await fxa.getCommands(acct.sessionToken, { index, limit: 50 });
    } catch (e) {
      if (e.errno === fxa.ERRNO_UNKNOWN_DEVICE) { await clearDevice(); dev = await ensureDevice(acct); continue; }
      throw e;
    }
    for (const { data } of resp.messages || []) {
      if (data?.command !== sendtab.COMMAND_SENDTAB) continue;
      try {
        const tab = await sendtab.decryptTab(dev.keys, data.payload);
        if (!/^(https?|ftp):/i.test(tab.url || "")) { console.warn("Ignoring tab with unsupported URL scheme"); continue; }
        if (!names) {
          try { names = new Map((await fxa.getDevices(acct.sessionToken)).map((d) => [d.id, d.name])); }
          catch { names = new Map(); }
        }
        received.push({ ...tab, sender: names.get(data.sender) || "another device" });
      } catch (e) {
        console.warn("Could not decrypt received tab", e);
      }
    }
    if (resp.messages?.length) {
      dev.lastCommandIndex = resp.index;
      await saveDevice(dev);
    }
    if (resp.last !== false || !resp.messages?.length) break;
  }
  return received;
}

/** Remove this device from the account (used on sign-out). */
export async function unregister(acct) {
  const dev = await loadDevice();
  await clearDevice();
  if (dev?.id && acct?.refreshToken) {
    try { await fxa.destroyDevice(acct.refreshToken, dev.id); } catch (e) { console.warn("device destroy failed", e); }
  }
}
