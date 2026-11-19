// Dev-only: exercises lib/device.js + lib/sendtab.js against the real servers.
// Registers a temporary device, checks it can read other devices' Send Tab
// keys, sends a tab to itself and receives it, then removes itself.
// Never sends anything to the user's real devices.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => {
  const s = String(url);
  if (/^https:\/\/([a-z0-9-]+\.)*(accounts\.firefox\.com|services\.mozilla\.com)\//.test(s)) {
    return realFetch(`/proxy?url=${encodeURIComponent(s)}`, opts);
  }
  return realFetch(url, opts);
};
const store = {};
globalThis.chrome = { storage: { local: {
  async get(k) { return k in store ? { [k]: store[k] } : {}; },
  async set(o) { Object.assign(store, structuredClone(o)); },
  async remove(k) { delete store[k]; },
} } };

const oauth = await import("../lib/oauth.js");
const fxa = await import("../lib/fxa.js");
const device = await import("../lib/device.js");
const sendtab = await import("../lib/sendtab.js");
const { bytesToHex, hexToBytes } = await import("../lib/crypto.js");

const logEl = document.getElementById("log");
const log = (m, c = "") => { const d = document.createElement("div"); d.className = c; d.textContent = m; logEl.append(d); console.log(m); };
const errText = (e) => `${e.name}: ${e.message}` + (e.status ? ` [HTTP ${e.status}]` : "") + (e.errno ? ` [errno ${e.errno}]` : "") +
  (e.body ? ` body=${JSON.stringify(e.body).slice(0, 300)}` : "");
async function step(name, fn) {
  try { const r = await fn(); log(`OK   ${name}`, "ok"); return r; }
  catch (e) { log(`FAIL ${name}: ${errText(e)}`, "err"); console.error(e); throw e; }
}

let flow = null, acct = null;
window.start = async () => { flow = await oauth.beginFlow(); log("flow started"); return flow.url; };

window.finish = async (redirectUrl) => {
  const code = oauth.parseRedirect(flow, redirectUrl);
  const r = await step("sign-in exchange", () => oauth.completeFlow(flow, code));
  const prof = await oauth.getProfile(r.accessToken).catch(() => ({}));
  acct = { uid: prof.uid, refreshToken: r.refreshToken, sessionToken: r.sessionToken, kSync: bytesToHex(r.kSync), kid: r.kid };
  return window.run();
};

window.run = async () => {
  const me = await step("register device", () => device.ensureDevice(acct, { name: "Send Tab test (harness)" }));
  log(`     device id ${me.id.slice(0, 6)}…, name "${me.name}"`);
  const devices = await step("list devices", () => fxa.getDevices(acct.sessionToken));
  const self = devices.find((d) => d.isCurrentDevice);
  log(`     current device present: ${!!self}; our open-uri published: ${!!self?.availableCommands?.[sendtab.COMMAND_SENDTAB]}`);

  // Interop: can we decrypt the Send Tab keys real Firefox devices published?
  for (const d of devices.filter((d) => !d.isCurrentDevice && d.availableCommands?.[sendtab.COMMAND_SENDTAB])) {
    await step(`decrypt Send Tab keys of a ${d.type} device`, async () => {
      const k = await sendtab.decryptKeysFromCommand(d.availableCommands[sendtab.COMMAND_SENDTAB], hexToBytes(acct.kSync), acct.kid);
      const pub = Uint8Array.from(atob(k.publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - k.publicKey.length % 4) % 4)), (c) => c.charCodeAt(0));
      if (pub.length !== 65 || pub[0] !== 4) throw new Error(`unexpected public key (${pub.length} bytes)`);
      // Also prove we could encrypt to it (does NOT send anything):
      await sendtab.encryptTab(d.availableCommands[sendtab.COMMAND_SENDTAB], hexToBytes(acct.kSync), acct.kid, { title: "x", url: "https://example.com/" });
    }).catch(() => {});
  }

  // Round trip through Mozilla's server: send to ourselves, then poll.
  const before = await step("initial poll (drain)", () => device.pollReceivedTabs(acct));
  log(`     drained ${before.length}`);
  const url = `https://example.com/?sendtab-test=${Date.now()}`;
  const sent = await step("invoke_command to self", () => device.sendTab(acct, me.id, { title: "Send Tab self-test", url }, devices));
  log(`     response: ${JSON.stringify(sent)}`);
  const got = await step("poll for received tab", () => device.pollReceivedTabs(acct));
  const match = got.find((t) => t.url === url);
  log(match ? `OK   received our tab back (title "${match.title}", sender "${match.sender}")` : `FAIL tab not received (got ${got.length})`, match ? "ok" : "err");
  const again = await step("poll again (index advanced)", () => device.pollReceivedTabs(acct));
  log(again.length === 0 ? "OK   no duplicate delivery" : `FAIL duplicate delivery (${again.length})`, again.length ? "err" : "ok");
  log("done.");
  return "done";
};

window.cleanup = async () => {
  await step("unregister device", () => device.unregister(acct)).catch(() => {});
  const devs = await fxa.getDevices(acct.sessionToken).catch(() => []);
  log(`     harness device still listed: ${devs.some((d) => d.name === "Send Tab test (harness)")}`);
  await step("destroy refresh token", () => oauth.destroyRefreshToken(acct.refreshToken)).catch(() => {});
  await step("destroy session", () => fxa.destroySession(acct.sessionToken)).catch(() => {});
  const rt = await oauth.refreshAccessToken(acct.refreshToken).then(() => "STILL VALID", (e) => `revoked (HTTP ${e.status})`);
  log(`     refresh token now: ${rt}`, rt === "STILL VALID" ? "err" : "ok");
  acct = null;
};

log("ready. call start()");
